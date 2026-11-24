import { spawnSync } from "node:child_process";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Command } from "commander";
import { parse, stringify } from "yaml";
import {
  deriveArtifactInventoryDigest,
  deriveReleaseId,
  deriveReleaseRecordDigest,
  type PublicationReleaseIdentity,
  parsePublicationManifest,
  type ReleaseIdentity,
} from "../schema/release-manifest.ts";
import { digestConsumerRuntimeBytes } from "./consumer-node-runtime.ts";
import {
  derivePackPublicationAssets,
  type PackPublicationAssetResult,
  type SealedPublicationEntry,
} from "./pack-publication-assets.ts";
import {
  createLocalGitObjectReader,
  type LocalGitObjectReader,
  type ReleaseArtifactResolution,
  resolveReleaseArtifacts,
} from "./release-artifact-resolver.ts";
import { materializeReleaseArtifacts } from "./release-materializer.ts";

const MATERIALIZER_VERSION = "1";
const UNRESOLVED_HASH = "0".repeat(64);
const UNRESOLVED_DIGEST = `sha256:${UNRESOLVED_HASH}`;
const COMMIT = /^[a-f0-9]{40}$/;
const TAG = /^[A-Za-z0-9._/-]+$/;
const MANIFEST = "release/manifest.yaml";

type Failure = { readonly ok: false; readonly reason: string };
type TrackedEntry = { readonly path: string; readonly mode: string };
type ArtifactResult =
  | Pick<Extract<ReleaseArtifactResolution, { ok: true }>, "ok" | "entries" | "digest">
  | Extract<ReleaseArtifactResolution, { ok: false }>;
type AssetResult =
  | { readonly ok: true; readonly value: { readonly releaseAssetInventoryDigest: string } }
  | Extract<PackPublicationAssetResult, { ok: false }>;

export interface C2ManifestInput {
  readonly repository: string;
  readonly c1: string;
  readonly tag: string;
  readonly previousBytes: Uint8Array;
}

export interface C2ManifestDeps {
  readonly trackedEntries: readonly TrackedEntry[];
  readonly resolveArtifacts: (input: {
    readonly repository: string;
    readonly release: ReleaseIdentity;
  }) => ArtifactResult | Promise<ArtifactResult>;
  readonly deriveAssets: (input: {
    readonly release: PublicationReleaseIdentity;
    readonly entries: readonly SealedPublicationEntry[];
  }) => AssetResult;
}

export type C2ManifestResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly bytes: Buffer;
        readonly releaseId: string;
        readonly artifactCount: number;
      };
    }
  | Failure;

function failure(reason: string, detail?: string): Failure {
  return { ok: false, reason: detail ? `${reason}:${detail}` : reason };
}

function previousManifest(bytes: Uint8Array) {
  let raw: unknown;
  try {
    raw = parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return failure("c2_previous_invalid");
  }
  const parsed = parsePublicationManifest(raw);
  if (!parsed.ok) return failure("c2_previous_invalid", parsed.error);
  // Keep the input mapping so existing release records retain their key order.
  return {
    ok: true as const,
    raw: raw as {
      readonly schema_version: "v2";
      readonly releases: Readonly<Record<string, unknown>>;
      readonly channels: { readonly canary: string; readonly stable: string };
      readonly channelOrder: readonly string[];
    },
  };
}

function sealEntries(
  entries: Extract<ArtifactResult, { ok: true }>["entries"],
  tracked: readonly TrackedEntry[],
): SealedPublicationEntry[] | undefined {
  const modes = new Map(tracked.map(({ path, mode }) => [path, mode]));
  const sealed: SealedPublicationEntry[] = [];
  for (const { path, mode, content } of entries) {
    if ((mode !== "100644" && mode !== "100755") || modes.get(path) !== mode) return undefined;
    sealed.push({
      sourcePath: path,
      destinationPath: path,
      mode,
      size: content.length,
      contentDigest: digestConsumerRuntimeBytes(content),
      content,
    });
  }
  return sealed;
}

export async function buildC2ReleaseManifest(
  input: C2ManifestInput,
  deps: C2ManifestDeps,
): Promise<C2ManifestResult> {
  const previous = previousManifest(input.previousBytes);
  if (!previous.ok) return previous;
  const base = { materializerVersion: MATERIALIZER_VERSION, artifactSourceCommit: input.c1 };
  const resolved = await deps.resolveArtifacts({
    repository: input.repository,
    release: {
      ...base,
      releaseId: `rel-sha256:${UNRESOLVED_HASH}`,
      artifactSetDigest: UNRESOLVED_DIGEST,
    },
  });
  if (!resolved.ok) return failure("c2_artifact_resolution_failed", resolved.error);
  const entries = sealEntries(resolved.entries, deps.trackedEntries);
  if (!entries) return failure("c2_inventory_invalid");
  const releaseId = deriveReleaseId(MATERIALIZER_VERSION, input.c1, resolved.digest);
  if (Object.hasOwn(previous.raw.releases, releaseId))
    return failure("c2_release_already_registered");
  const artifacts = entries.map(({ content: _content, ...artifact }) => artifact);
  const release = {
    ...base,
    artifactSetDigest: resolved.digest,
    artifactInventoryDigest: UNRESOLVED_DIGEST,
    releaseAssetInventoryDigest: UNRESOLVED_DIGEST,
    artifacts,
  };
  // Asset derivation uses the ID and exact entries; digests finalized below are not its inputs.
  const assets = deps.deriveAssets({
    release: { ...release, releaseId, releaseRecordDigest: UNRESOLVED_DIGEST },
    entries,
  });
  if (!assets.ok) return failure("c2_assets_failed", assets.error);
  const record = {
    ...release,
    artifactInventoryDigest: deriveArtifactInventoryDigest(artifacts),
    releaseAssetInventoryDigest: assets.value.releaseAssetInventoryDigest,
  };
  const next = {
    ...previous.raw,
    releases: {
      ...previous.raw.releases,
      [releaseId]: { ...record, releaseRecordDigest: deriveReleaseRecordDigest(record) },
    },
    channels: { ...previous.raw.channels, canary: releaseId },
  };
  const yaml = stringify(next);
  const validated = parsePublicationManifest(parse(yaml));
  if (!validated.ok) return failure("c2_manifest_invalid", validated.error);
  return {
    ok: true,
    value: { bytes: Buffer.from(yaml, "utf8"), releaseId, artifactCount: artifacts.length },
  };
}

interface ManifestFileSystem<Handle> {
  mkdir(path: string): void;
  open(path: string, flags: "wx"): Handle;
  write(handle: Handle, bytes: Uint8Array): void;
  close(handle: Handle): void;
  unlink(path: string): void;
  rmdir(path: string): void;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function removeOwned(path: string, remove: (path: string) => void, residue: string[]): void {
  try {
    remove(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") residue.push(path);
  }
}

export function resolvePackRoot(path: string | undefined): string {
  return path ? (isAbsolute(path) ? path : join(process.cwd(), path)) : process.cwd();
}

function checkoutGit(repository: string, ...args: string[]): Buffer | undefined {
  const excluded =
    /^GIT_(?:DIR|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|INDEX_FILE|WORK_TREE|CONFIG(?:_.+)?)$/i;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !excluded.test(key)),
  );
  const result = spawnSync("git", ["--no-optional-locks", ...args], {
    cwd: repository,
    env: { ...env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" },
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout : undefined;
}

function realDirectory(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

const localFileSystem: ManifestFileSystem<number> = {
  mkdir(path) {
    try {
      mkdirSync(path);
    } catch (error) {
      if (errorCode(error) === "EEXIST" && !lstatSync(path).isDirectory())
        throw new Error("Manifest parent is not a directory", { cause: error });
      throw error;
    }
  },
  open: openSync,
  write: writeFileSync,
  close: closeSync,
  unlink: unlinkSync,
  rmdir: rmdirSync,
};

interface C2Options {
  readonly c1?: string;
  readonly previous?: string;
  readonly tag?: string;
  readonly packRoot?: string;
  readonly json?: boolean;
}

function trackedPaths(records: Uint8Array): TrackedEntry[] | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true })
      .decode(records)
      .split("\0")
      .filter(Boolean)
      .map((entry) => ({ mode: entry.slice(0, 6), path: entry.slice(entry.indexOf("\t") + 1) }));
  } catch {
    return undefined;
  }
}

async function readPreviousBlob(
  git: LocalGitObjectReader,
  repository: string,
  previous: string,
): Promise<Uint8Array | undefined> {
  if (checkoutGit(repository, "cat-file", "-t", previous)?.toString().trim() !== "commit")
    return undefined;
  const id = checkoutGit(repository, "rev-parse", "--verify", `${previous}:${MANIFEST}`)
    ?.toString()
    .trim();
  if (!id || !COMMIT.test(id)) return undefined;
  const blobs = await git.readBlobs(repository, [id]);
  return blobs.ok ? blobs.blobs.get(id) : undefined;
}

async function generateC2Manifest(options: C2Options) {
  const { c1, previous, tag } = options;
  if (
    !c1 ||
    !COMMIT.test(c1) ||
    !previous ||
    !COMMIT.test(previous) ||
    !tag ||
    !TAG.test(tag) ||
    tag.includes("..")
  )
    return failure("c2_option_invalid");
  if (!tag.includes("-canary.")) return failure("c2_tag_not_canary");
  const repository = realDirectory(resolvePackRoot(options.packRoot));
  if (!repository) return failure("c2_option_invalid");
  // An empty Git prefix identifies the checkout root regardless of Windows drive casing.
  const location = checkoutGit(repository, "rev-parse", "--is-inside-work-tree", "--show-prefix");
  if (location?.toString().trimEnd() !== "true") return failure("c2_option_invalid");
  if (checkoutGit(repository, "rev-parse", "HEAD")?.toString().trim() !== c1)
    return failure("c2_c1_not_head");
  const dirty = checkoutGit(repository, "status", "--porcelain=v1", "--untracked-files=all");
  if (!dirty || dirty.length) return failure("c2_worktree_dirty");

  const git = createLocalGitObjectReader();
  const tree = await git.listTree(repository, c1);
  const trackedEntries = tree.ok ? trackedPaths(tree.records) : undefined;
  if (!trackedEntries) return failure("c2_inventory_invalid");
  if (trackedEntries.some(({ path }) => path === MANIFEST || path.startsWith(`${MANIFEST}/`)))
    return failure("c2_manifest_present_in_c1");
  const previousBytes = await readPreviousBlob(git, repository, previous);
  if (!previousBytes) return failure("c2_previous_unavailable");
  const built = await buildC2ReleaseManifest(
    { repository, c1, tag, previousBytes },
    {
      trackedEntries,
      resolveArtifacts: (input) =>
        resolveReleaseArtifacts(input, { git, materialize: materializeReleaseArtifacts }),
      deriveAssets: derivePackPublicationAssets,
    },
  );
  if (!built.ok) return built;
  const { bytes, artifactCount, releaseId } = built.value;
  const written = writeC2Manifest(repository, bytes, localFileSystem);
  if (!written.ok) return written;
  return {
    ok: true as const,
    releaseId,
    c1,
    tag,
    channel: "canary" as const,
    artifactCount,
    manifestPath: written.manifestPath,
    manifestSha256: digestConsumerRuntimeBytes(bytes),
  };
}

export function registerC2ManifestCommand(distribution: Command): void {
  distribution
    .command("c2-manifest")
    .description("create the Pack C2 manifest from fixed C1 and previous commits")
    .option("--c1 <sha>", "Pack C1 commit")
    .option("--tag <tag>", "canary tag name")
    .option("--previous <sha>", "commit with the previous Pack manifest")
    .option("--pack-root <dir>", "Pack checkout, defaults to the current directory")
    .option("--json", "JSON output")
    .action(async (options: C2Options) => {
      const result = await generateC2Manifest(options);
      if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
      else if (result.ok)
        process.stdout.write(`Wrote ${result.manifestPath} (${result.releaseId})\n`);
      else process.stderr.write(`${result.reason}\n`);
      process.exitCode = result.ok ? 0 : 1;
    });
}

export function writeC2Manifest<Handle>(
  repository: string,
  bytes: Uint8Array,
  fs: ManifestFileSystem<Handle>,
): { readonly ok: true; readonly manifestPath: string } | Failure {
  const releaseDir = join(repository, "release");
  const manifestPath = join(releaseDir, "manifest.yaml");
  let ownsDirectory = false;
  let ownsFile = false;
  try {
    try {
      fs.mkdir(releaseDir);
      ownsDirectory = true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const handle = fs.open(manifestPath, "wx");
    ownsFile = true;
    try {
      fs.write(handle, bytes);
    } finally {
      fs.close(handle);
    }
    return { ok: true, manifestPath };
  } catch (error) {
    const residue: string[] = [];
    if (ownsFile) removeOwned(manifestPath, fs.unlink, residue);
    if (ownsDirectory) removeOwned(releaseDir, fs.rmdir, residue);
    if (residue.length) return failure("c2_write_failed", residue.join(", "));
    return failure(
      !ownsFile && errorCode(error) === "EEXIST" ? "c2_target_exists" : "c2_write_failed",
    );
  }
}
