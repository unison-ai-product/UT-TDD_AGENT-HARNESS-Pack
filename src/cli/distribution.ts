import { execFileSync, type SpawnSyncReturns, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Command } from "commander";
import { parse as parseYaml } from "yaml";
import { buildReleasePublicationPlan } from "../github/ops-guard.ts";
import {
  analyzeSecretScan,
  loadSecretScanArtifactsForPaths,
  secretScanMessages,
} from "../lint/secret-scan.ts";
import { detectMode } from "../runtime/detect.ts";
import {
  buildNodeGeneration,
  REVIEWED_NODE_VERSION,
  REVIEWED_NPM_VERSION,
} from "../runtime/node-bootstrap.ts";
import { parsePublicationManifest, resolveReleaseChannel } from "../schema/release-manifest.ts";
import {
  buildCleanDistributionPlan,
  buildConsumerReadinessPlan,
  buildConsumerRuntimeRelease,
  buildPackSyncPlan,
  type ConsumerNodeRuntimeReadinessInput,
  type ConsumerRuntimeReleaseAdmissionInput,
  canonicalJson,
  cleanDistributionSourcePath,
  DEFAULT_PACK_REPO,
  gitAddPathspecCommands,
  type PackAuthoringSmokeResult,
  projectTrackedTeamBlob,
  releaseArtifactFileNames,
  runPackAuthoringSmoke,
  type TrackedGitBlob,
  transformCleanDistributionArtifact,
  validateConsumerRuntimeRelease,
} from "../setup/index.ts";
import { derivePackPublicationAssets } from "../setup/pack-publication-assets.ts";
import type { ReleaseAggregateFinalTree } from "../setup/release-aggregate-admission.ts";
import { admitReleaseAggregate } from "../setup/release-aggregate-admission.ts";
import {
  createLocalGitObjectReader,
  resolveReleaseArtifacts,
} from "../setup/release-artifact-resolver.ts";
import { attestReleaseChannel } from "../setup/release-channel-adapter.ts";
import { materializeReleaseArtifacts } from "../setup/release-materializer.ts";
import { ensureDir } from "../shared/fs.ts";

function gitHead(): string | null {
  // Distribution commands are intentionally valid in an unpacked clean artifact,
  // where no `.git` directory exists.  `execFileSync` writes rev-parse's fatal
  // diagnostic to the parent stderr before the exception can be caught (and Bun's
  // Linux subprocess implementation can retain the failed child status).  Probe
  // without inheriting stderr so command registration remains side-effect free.
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function resolveDistributionTag(explicitTag: string | undefined): string {
  return explicitTag ?? gitHead() ?? "unreleased";
}

function collectFilesystemCandidatePaths(repoRoot: string): string[] {
  const ignored = new Set([".git", "node_modules", "dist"]);
  const out: string[] = [];
  const walk = (dir: string, prefix = ""): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else {
        out.push(rel);
      }
    }
  };
  walk(repoRoot);
  return out.sort();
}

function removePackageScratchTree(path: string): void {
  if (!existsSync(path)) return;
  // buildNodeGeneration seals published generation directories to 0555. On
  // POSIX, recursive removal needs write permission on each parent directory;
  // restore owner permissions inside this disposable, producer-owned scratch
  // tree before removing it. lstatSync avoids following any symlink entries.
  const makeDirectoriesRemovable = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const child = join(directory, entry);
      if (lstatSync(child).isDirectory()) makeDirectoriesRemovable(child);
    }
    chmodSync(directory, 0o700);
  };
  makeDirectoriesRemovable(path);
  rmSync(path, { recursive: true, force: true });
}

/**
 * Build the source candidate set from the immutable HEAD tree whenever the
 * command runs inside Git.  A live filesystem walk is unsafe for source
 * publication: ignored/untracked files under an allowed prefix (for example
 * `scripts/` or `src/`) would otherwise become release inputs.  Unpacked Pack
 * trees have no Git metadata, so they retain the bounded filesystem fallback;
 * deny/allow fences still apply to that clean tree.
 */
export function collectDistributionCandidatePaths(repoRoot: string): string[] {
  const workTree = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const tracked = spawnSync("git", ["ls-tree", "-r", "--name-only", "-z", "HEAD", "--"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (tracked.status === 0) {
    return tracked.stdout.split("\0").filter(Boolean).sort();
  }
  if (workTree.status === 0 && workTree.stdout.trim() === "true") {
    throw new Error("Git work tree has no readable HEAD tree");
  }
  if (existsSync(join(repoRoot, ".git"))) {
    throw new Error("Git metadata exists but the HEAD tree is unavailable");
  }
  return collectFilesystemCandidatePaths(repoRoot);
}

const PACK_SYNC_MANIFEST = ".ut-tdd-pack-sync-manifest.json";

function readConsumerRuntimeReadiness(repoRoot: string): ConsumerNodeRuntimeReadinessInput {
  const runtimeRoot = resolve(repoRoot, ".ut-tdd", "runtime");
  const pointerPath = join(runtimeRoot, "activation", "active.json");
  try {
    const pointer = JSON.parse(readFileSync(pointerPath, "utf8")) as {
      bundle_path?: unknown;
      bundle_digest?: unknown;
    };
    if (
      typeof pointer.bundle_path !== "string" ||
      resolve(pointer.bundle_path) !== pointer.bundle_path
    )
      return { status: "blocked", reason: "consumer_runtime_resolution_denied" };
    const rel = relative(runtimeRoot, pointer.bundle_path);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      return { status: "blocked", reason: "consumer_runtime_external_path" };
    const bundle = JSON.parse(
      readFileSync(join(pointer.bundle_path, "bundle-manifest.json"), "utf8"),
    ) as {
      identity?: unknown;
      bundle_digest?: unknown;
      bundle_path?: unknown;
      files?: unknown;
      history_sequence?: unknown;
      prior_bundle_digest?: unknown;
      prior_history_tip_digest?: unknown;
    };
    if (
      bundle.bundle_path !== pointer.bundle_path ||
      bundle.bundle_digest !== pointer.bundle_digest
    )
      return { status: "blocked", reason: "consumer_runtime_digest_mismatch" };
    return {
      status: "ready",
      identity: bundle.identity as ConsumerNodeRuntimeReadinessInput["identity"],
      bundle: bundle as ConsumerNodeRuntimeReadinessInput["bundle"],
    };
  } catch {
    return { status: "blocked", reason: "consumer_runtime_absent" };
  }
}

function copyCleanDistributionArtifact(input: {
  sourceRoot: string;
  sourcePath: string;
  targetRoot: string;
  artifactPath: string;
}): void {
  if (
    input.sourcePath === ".ut-tdd/teams/example-review-team.yaml" &&
    input.artifactPath === "docs/templates/team/example-review-team.yaml"
  ) {
    const projection = readTrackedTeamBlob(input.sourceRoot);
    if (!projection.ok) throw new Error(`authoring projection denied: ${projection.error}`);
    const to = join(input.targetRoot, ...input.artifactPath.split("/"));
    ensureDir(dirname(to), { recursive: true });
    writeFileSync(to, projection.bytes, { encoding: "utf8", mode: 0o644 });
    return;
  }
  const from = join(input.sourceRoot, ...input.sourcePath.split("/"));
  const to = join(input.targetRoot, ...input.artifactPath.split("/"));
  ensureDir(dirname(to), { recursive: true });
  if (input.artifactPath === "package.json") {
    writeFileSync(
      to,
      transformCleanDistributionArtifact(input.artifactPath, readFileSync(from, "utf8")),
      "utf8",
    );
    return;
  }
  cpSync(from, to, { recursive: true });
}

function readTrackedTeamBlob(repoRoot: string) {
  const tree = spawnSync(
    "git",
    ["ls-tree", "-r", "-z", "--full-tree", "HEAD", "--", ".ut-tdd/teams/example-review-team.yaml"],
    { cwd: repoRoot, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] },
  );
  const records = Buffer.from(tree.stdout ?? new Uint8Array())
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const blobs: TrackedGitBlob[] = [];
  for (const record of records) {
    const match = /^(\d{6}) blob ([a-f0-9]{40})\t(.+)$/.exec(record);
    if (!match) continue;
    const blob = spawnSync("git", ["cat-file", "blob", match[2]], {
      cwd: repoRoot,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (blob.status !== 0) continue;
    blobs.push({
      path: match[3],
      mode: match[1] === "100644" ? "100644" : match[1],
      objectId: match[2],
      bytes: new Uint8Array(blob.stdout ?? new Uint8Array()),
    });
  }
  return projectTrackedTeamBlob({ blobs });
}

function runDistributionSecretScan(input: {
  repoRoot: string;
  sourcePaths: readonly string[];
  artifactPaths: readonly string[];
}): ReturnType<typeof analyzeSecretScan> {
  const sourceArtifactPaths = input.artifactPaths.map((rel) =>
    cleanDistributionSourcePath(rel, input.sourcePaths),
  );
  const artifacts = loadSecretScanArtifactsForPaths(input.repoRoot, sourceArtifactPaths).filter(
    (artifact) => artifact.path !== ".ut-tdd/teams/example-review-team.yaml",
  );
  if (sourceArtifactPaths.includes(".ut-tdd/teams/example-review-team.yaml")) {
    const projection = readTrackedTeamBlob(input.repoRoot);
    if (!projection.ok)
      return {
        checked: artifacts.length,
        violations: [
          {
            path: ".ut-tdd/teams/example-review-team.yaml",
            line: 1,
            marker: `authoring-projection-${projection.error}`,
          },
        ],
        ok: false,
      };
    try {
      artifacts.push({
        path: ".ut-tdd/teams/example-review-team.yaml",
        text: new TextDecoder("utf-8", { fatal: true }).decode(projection.bytes),
      });
    } catch {
      return {
        checked: artifacts.length,
        violations: [
          {
            path: ".ut-tdd/teams/example-review-team.yaml",
            line: 1,
            marker: "authoring-projection-invalid-utf8",
          },
        ],
        ok: false,
      };
    }
  }
  return analyzeSecretScan(artifacts);
}

function hexDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function resolveTagRevision(repoRoot: string, tag: string): string {
  if (!/^[A-Za-z0-9._/-]+$/.test(tag) || tag.includes(".."))
    throw new Error("distribution package tag is invalid");
  const result = spawnSync(
    "git",
    ["-C", repoRoot, "rev-parse", "--verify", `refs/tags/${tag}^{commit}`],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const revision = result.status === 0 ? result.stdout.trim() : "";
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error(`tag source revision unavailable: ${tag}`);
  return revision;
}

export type ConsumerRuntimeReleaseProducerErrorCode =
  | "consumer_runtime_release_manifest_unavailable"
  | "consumer_runtime_release_manifest_invalid"
  | "consumer_runtime_release_channel_unavailable"
  | "consumer_runtime_release_artifact_source_not_first_parent_ancestor"
  | "consumer_runtime_release_diff_outside_release";

export class ConsumerRuntimeReleaseProducerError extends Error {
  readonly code: ConsumerRuntimeReleaseProducerErrorCode;

  constructor(code: ConsumerRuntimeReleaseProducerErrorCode, detail?: string) {
    super(`${code}${detail ? `:${detail}` : ""}`);
    this.name = "ConsumerRuntimeReleaseProducerError";
    this.code = code;
  }
}

function gitOutput(repoRoot: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`git command failed: ${args.join(" ")}`);
  return result.stdout;
}

export interface ConsumerRuntimeReleaseSourceBinding {
  readonly releaseRevision: string;
  readonly artifactSourceRevision: string;
  readonly channel: "canary" | "stable";
}

export function resolveConsumerRuntimeReleaseSourceBinding(
  repoRoot: string,
  tag: string,
): ConsumerRuntimeReleaseSourceBinding {
  const releaseRevision = resolveTagRevision(repoRoot, tag);
  let rawManifest: unknown;
  try {
    rawManifest = parseYaml(
      readGitBlob(repoRoot, releaseRevision, "release/manifest.yaml").toString("utf8"),
    );
  } catch {
    throw new ConsumerRuntimeReleaseProducerError("consumer_runtime_release_manifest_unavailable");
  }
  const parsedManifest = parsePublicationManifest(rawManifest);
  if (!parsedManifest.ok)
    throw new ConsumerRuntimeReleaseProducerError(
      "consumer_runtime_release_manifest_invalid",
      parsedManifest.error,
    );
  const channel = tag.includes("-canary.") ? "canary" : "stable";
  const selected = resolveReleaseChannel(parsedManifest.value, channel);
  if (!selected.ok || !("artifacts" in selected.release))
    throw new ConsumerRuntimeReleaseProducerError(
      "consumer_runtime_release_channel_unavailable",
      channel,
    );
  const artifactSourceRevision = selected.release.artifactSourceCommit;
  let firstParent: string;
  try {
    const parents = gitOutput(repoRoot, ["rev-list", "--parents", "-n", "1", releaseRevision])
      .trim()
      .split(/\s+/);
    firstParent = parents[1] ?? "";
    if (!/^[a-f0-9]{40}$/.test(firstParent)) throw new Error("first parent unavailable");
  } catch {
    throw new ConsumerRuntimeReleaseProducerError(
      "consumer_runtime_release_artifact_source_not_first_parent_ancestor",
    );
  }
  const firstParentAncestors = new Set(
    gitOutput(repoRoot, ["rev-list", "--first-parent", firstParent])
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (!firstParentAncestors.has(artifactSourceRevision))
    throw new ConsumerRuntimeReleaseProducerError(
      "consumer_runtime_release_artifact_source_not_first_parent_ancestor",
    );
  const changedPaths = gitOutput(repoRoot, [
    "diff",
    "--name-only",
    "-z",
    artifactSourceRevision,
    releaseRevision,
  ])
    .split("\0")
    .filter(Boolean);
  if (changedPaths.some((path) => !path.startsWith("release/")))
    throw new ConsumerRuntimeReleaseProducerError(
      "consumer_runtime_release_diff_outside_release",
      changedPaths.filter((path) => !path.startsWith("release/")).join(","),
    );
  return { releaseRevision, artifactSourceRevision, channel };
}

function createTaggedSourceSnapshot(repoRoot: string, revision: string, root: string): string {
  const sourceRoot = join(root, "source");
  const clone = spawnSync("git", ["clone", "--shared", "--no-checkout", repoRoot, sourceRoot], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (clone.status !== 0) throw new Error(`tag source clone failed: ${clone.stderr ?? ""}`);
  const checkout = spawnSync("git", ["checkout", "--detach", revision], {
    cwd: sourceRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (checkout.status !== 0)
    throw new Error(`tag source checkout failed: ${checkout.stderr ?? ""}`);
  return sourceRoot;
}

function installTaggedDependencies(sourceRoot: string): void {
  const npmArgs = ["ci", "--no-audit", "--no-fund"];
  const install =
    process.platform === "win32"
      ? spawnSync(
          join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"),
          ["/d", "/c", "npm", ...npmArgs],
          {
            cwd: sourceRoot,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          },
        )
      : spawnSync("npm", npmArgs, {
          cwd: sourceRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
  if (install.status !== 0)
    throw new Error(`tag source npm ci failed: ${install.stderr ?? install.stdout ?? ""}`);
}

function canonicalPathForContainment(path: string): string {
  const resolved = resolve(path);
  const missingSegments: string[] = [];
  let existing = resolved;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missingSegments.unshift(relative(parent, existing));
    existing = parent;
  }
  let canonical = existsSync(existing) ? realpathSync.native(existing) : resolved;
  for (const segment of missingSegments) canonical = join(canonical, segment);
  const normalized = canonical.replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathWithin(parent: string, child: string): boolean {
  const rel = relative(canonicalPathForContainment(parent), canonicalPathForContainment(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function assertProducerPathsOutsideHome(input: {
  readonly repoRoot: string;
  readonly receipt: {
    readonly node: { readonly path: string };
    readonly npm: { readonly cli_path: string };
  };
  readonly homeDirectory: string;
}): void {
  if (pathWithin(input.homeDirectory, input.repoRoot))
    throw new Error("consumer runtime producer workdir is user-home scoped");
  for (const toolPath of [input.receipt.node.path, input.receipt.npm.cli_path]) {
    if (pathWithin(input.homeDirectory, toolPath))
      throw new Error("consumer runtime toolchain is user-home scoped");
  }
}

function readGitBlob(repoRoot: string, revision: string, path: string): Buffer {
  try {
    return execFileSync("git", ["-C", repoRoot, "show", `${revision}:${path}`], {
      encoding: null,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw new Error(`consumer runtime source blob unavailable: ${path}`);
  }
}

async function buildConsumerRuntimeAdmissionInput(input: {
  readonly repoRoot: string;
  readonly tag: string;
  readonly releaseRevision: string;
  readonly sourceRevision: string;
}): Promise<{
  readonly value: ConsumerRuntimeReleaseAdmissionInput;
  readonly artifactDigest: string;
  readonly materializerVersion: string;
}> {
  const controlManifestBytes = readGitBlob(
    input.repoRoot,
    input.releaseRevision,
    "release/manifest.yaml",
  );
  let rawManifest: unknown;
  try {
    rawManifest = parseYaml(controlManifestBytes.toString("utf8"));
  } catch {
    throw new Error("consumer runtime release manifest yaml is invalid");
  }
  const parsedManifest = parsePublicationManifest(rawManifest);
  if (!parsedManifest.ok) throw new Error(`consumer runtime manifest ${parsedManifest.error}`);
  const channel = input.tag.includes("-canary.") ? "canary" : "stable";
  const selected = resolveReleaseChannel(parsedManifest.value, channel);
  if (!selected.ok) throw new Error(`consumer runtime release channel unavailable: ${channel}`);
  const release = parsedManifest.value.releases[parsedManifest.value.channels[channel]];
  if (!release || !("artifacts" in release))
    throw new Error(`consumer runtime release channel unavailable: ${channel}`);
  if (release.artifactSourceCommit !== input.sourceRevision)
    throw new Error("consumer runtime release source revision mismatch");
  const finalTree: ReleaseAggregateFinalTree = {
    manifestEntries: [{ path: "release/manifest.yaml", value: rawManifest }],
    sourcePaths: release.artifacts.map((artifact) => artifact.sourcePath),
    cleanPackAllowlist: [
      "release/manifest.yaml",
      ...release.artifacts.map((artifact) => artifact.destinationPath),
    ],
    channelMappings: release.artifacts.map((artifact) => ({
      channel,
      releaseId: release.releaseId,
      sourceRevision: release.artifactSourceCommit,
      sourcePath: artifact.sourcePath,
      destinationPath: artifact.destinationPath,
    })),
  };
  const resolverDependencies = {
    git: createLocalGitObjectReader(),
    materialize: materializeReleaseArtifacts,
  };
  const attestation = await attestReleaseChannel(
    { repository: input.repoRoot, manifest: parsedManifest.value, channel },
    {
      resolveArtifacts: (request) => resolveReleaseArtifacts(request, resolverDependencies),
    },
  );
  if (attestation.status !== "attested")
    throw new Error(`consumer runtime attestation ${attestation.status}`);
  const aggregate = await admitReleaseAggregate(
    { repository: DEFAULT_PACK_REPO, channel, finalTree },
    { attestChannel: async () => attestation },
  );
  if (!aggregate.ok) throw new Error(`consumer runtime aggregate ${aggregate.error}`);
  return {
    artifactDigest: aggregate.plan.actualDigest,
    materializerVersion: release.materializerVersion,
    value: {
      aggregate_input: {
        repository: DEFAULT_PACK_REPO,
        channel,
        final_tree: finalTree,
        attestation: {
          ...attestation,
          entries: attestation.entries.map((item) => ({
            path: item.path,
            mode: item.mode,
            content_base64: Buffer.from(item.content).toString("base64"),
          })),
        },
      },
      control_manifest_base64: controlManifestBytes.toString("base64"),
    },
  };
}

function resolveDistributionTarReleaseIdentity(input: {
  readonly repoRoot: string;
  readonly releaseRevision: string;
  readonly channel: "canary" | "stable";
  readonly sourceRevision: string;
}) {
  let rawManifest: unknown;
  try {
    rawManifest = parseYaml(
      readGitBlob(input.repoRoot, input.releaseRevision, "release/manifest.yaml").toString("utf8"),
    );
  } catch {
    throw new ConsumerRuntimeReleaseProducerError("consumer_runtime_release_manifest_unavailable");
  }
  const parsedManifest = parsePublicationManifest(rawManifest);
  if (!parsedManifest.ok)
    throw new ConsumerRuntimeReleaseProducerError(
      "consumer_runtime_release_manifest_invalid",
      parsedManifest.error,
    );
  const releaseId = parsedManifest.value.channels[input.channel];
  const selected = parsedManifest.value.releases[releaseId];
  if (!selected)
    throw new ConsumerRuntimeReleaseProducerError(
      "consumer_runtime_release_manifest_invalid",
      "distribution tar release unavailable",
    );
  if (selected.artifactSourceCommit !== input.sourceRevision)
    throw new ConsumerRuntimeReleaseProducerError(
      "consumer_runtime_release_manifest_invalid",
      "distribution tar source revision mismatch",
    );
  return selected;
}

export async function packageConsumerRuntimeRelease(input: {
  readonly repoRoot: string;
  readonly tag: string;
  readonly outDir: string;
  readonly homeDirectory?: string;
  readonly installDependencies?: (sourceRoot: string) => void;
  readonly buildGeneration?: typeof buildNodeGeneration;
  readonly moveStagedAssets?: (source: string, destination: string) => void;
}): Promise<{
  readonly ok: true;
  readonly tag: string;
  readonly sourceRevision: string;
  readonly artifacts: Record<string, string>;
  readonly assetDigests: Record<string, string>;
  readonly consumerAnchorDigest: string;
}> {
  const sourceBinding = resolveConsumerRuntimeReleaseSourceBinding(input.repoRoot, input.tag);
  const sourceRevision = sourceBinding.artifactSourceRevision;
  const homeDirectory = input.homeDirectory ?? homedir();
  if (pathWithin(homeDirectory, input.repoRoot))
    throw new Error("consumer runtime producer workdir is user-home scoped");
  if (existsSync(input.outDir) && readdirSync(input.outDir).length > 0)
    throw new Error("distribution package output directory is not empty");
  const scratch = mkdtempSync(
    join(dirname(resolve(input.repoRoot)), ".ut-tdd-consumer-runtime-package-"),
  );
  const assetsStage = join(scratch, "assets");
  const generationRoot = join(scratch, "generation");
  ensureDir(assetsStage, { recursive: true });
  try {
    const sourceRoot = createTaggedSourceSnapshot(input.repoRoot, sourceRevision, scratch);
    const sourcePaths = collectDistributionCandidatePaths(sourceRoot);
    const exportPlan = buildCleanDistributionPlan({ paths: sourcePaths, sourceTag: input.tag });
    const secretScan = runDistributionSecretScan({
      repoRoot: sourceRoot,
      sourcePaths,
      artifactPaths: exportPlan.artifactPaths,
    });
    if (!exportPlan.ok || !secretScan.ok)
      throw new Error(
        `distribution package source preflight failed: ${secretScanMessages(secretScan)[0] ?? "plan"}`,
      );
    const tarRelease = resolveDistributionTarReleaseIdentity({
      repoRoot: input.repoRoot,
      releaseRevision: sourceBinding.releaseRevision,
      channel: sourceBinding.channel,
      sourceRevision,
    });
    const tarResolution = await resolveReleaseArtifacts(
      { repository: input.repoRoot, release: tarRelease },
      {
        git: createLocalGitObjectReader(),
        materialize: materializeReleaseArtifacts,
      },
    );
    if (!tarResolution.ok)
      throw new Error(`distribution package tar materialization failed: ${tarResolution.error}`);
    const resolvedEntries = new Map(tarResolution.entries.map((entry) => [entry.path, entry]));
    const tarAsset = derivePackPublicationAssets({
      release: tarRelease,
      entries: tarRelease.artifacts.map((artifact) => {
        const entry = resolvedEntries.get(artifact.destinationPath);
        if (!entry)
          throw new Error(
            `distribution package tar materialization entry missing: ${artifact.destinationPath}`,
          );
        if (entry.mode !== "100644" && entry.mode !== "100755")
          throw new Error(`distribution package tar mode is unsupported: ${entry.path}`);
        return { ...artifact, mode: entry.mode, content: entry.content };
      }),
    });
    if (!tarAsset.ok)
      throw new Error(`distribution package tar materialization failed: ${tarAsset.error}`);
    const names = releaseArtifactFileNames(input.tag);
    const tarballPath = join(assetsStage, names.tarball);
    const tarballBytes = tarAsset.value.tarball.bytes;
    writeFileSync(tarballPath, tarballBytes);
    writeFileSync(
      join(assetsStage, names.checksum),
      `${hexDigest(tarballBytes)}  ${names.tarball}\n`,
      "utf8",
    );

    const packageJson = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8")) as {
      name?: unknown;
    };
    if (typeof packageJson.name !== "string")
      throw new Error("consumer runtime product_id is missing");
    (input.installDependencies ?? installTaggedDependencies)(sourceRoot);
    const generation = await (input.buildGeneration ?? buildNodeGeneration)({
      repoRoot: sourceRoot,
      outputRoot: generationRoot,
      candidateRevision: sourceRevision,
    });
    if (
      generation.receipt.node.version !== REVIEWED_NODE_VERSION ||
      generation.receipt.npm.version !== REVIEWED_NPM_VERSION
    )
      throw new Error("consumer runtime reviewed Node toolchain mismatch");
    assertProducerPathsOutsideHome({
      repoRoot: input.repoRoot,
      receipt: generation.receipt,
      homeDirectory,
    });
    const compiledEsm = readFileSync(generation.compiledCliPath);
    const receiptBytes = readFileSync(join(generation.generationPath, "receipt.json"));
    const admission = await buildConsumerRuntimeAdmissionInput({
      repoRoot: input.repoRoot,
      tag: input.tag,
      releaseRevision: sourceBinding.releaseRevision,
      sourceRevision,
    });
    const runtime = buildConsumerRuntimeRelease({
      tag: input.tag,
      sourceRevision,
      productId: packageJson.name,
      generation: generation.receipt,
      receiptBytes,
      artifactDigest: admission.artifactDigest,
      compiledEsmBytes: compiledEsm,
      admissionInput: admission.value,
      materializerVersion: admission.materializerVersion,
    });
    validateConsumerRuntimeRelease(runtime);
    const runtimeBytes = Buffer.from(`${canonicalJson(runtime)}\n`, "utf8");
    const consumerChecksumBytes = Buffer.from(
      `${hexDigest(compiledEsm)}  ${names.compiledEsm}\n${hexDigest(runtimeBytes)}  ${names.consumerRuntime}\n`,
      "utf8",
    );
    writeFileSync(join(assetsStage, names.compiledEsm), compiledEsm);
    writeFileSync(join(assetsStage, names.consumerRuntime), runtimeBytes);
    writeFileSync(join(assetsStage, names.consumerChecksum), consumerChecksumBytes);
    const outputParent = dirname(resolve(input.outDir));
    ensureDir(outputParent, { recursive: true });
    if (existsSync(input.outDir)) rmSync(input.outDir, { recursive: true, force: true });
    (input.moveStagedAssets ?? renameSync)(assetsStage, input.outDir);
    const outputFiles = [
      names.tarball,
      names.checksum,
      names.compiledEsm,
      names.consumerRuntime,
      names.consumerChecksum,
    ];
    const assetDigests = Object.fromEntries(
      outputFiles.map((name) => [
        name,
        `sha256:${hexDigest(readFileSync(join(input.outDir, name)))}`,
      ]),
    );
    return {
      ok: true,
      tag: input.tag,
      sourceRevision,
      artifacts: Object.fromEntries(outputFiles.map((name) => [name, join(input.outDir, name)])),
      assetDigests,
      consumerAnchorDigest: `sha256:${hexDigest(consumerChecksumBytes)}`,
    };
  } finally {
    removePackageScratchTree(scratch);
  }
}

/**
 * PLAN-L7-462 step 2: ut-tdd のグローバル CLI は .cmd shim 配布のため、node の
 * spawn では PATH 解決されない。win32 は ComSpec 経由で CLI shim を探す
 * (fail-soft は従来どおり)。単体テスト U-DIST-CLI-PROBE が「素の spawn に戻すと
 * ENOENT で status=null になる」ことを fail-close で固定する。
 */
export function utTddCliProbe(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): SpawnSyncReturns<string> {
  if (platform === "win32") {
    const cmdExe = env.ComSpec ?? join(env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
    return spawnSync(cmdExe, ["/d", "/c", "ut-tdd", "--help"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env,
    });
  }
  return spawnSync("ut-tdd", ["--help"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
}

export function registerDistributionCommands(program: Command): void {
  const distribution = program.command("distribution").description("clean distribution planning");

  distribution
    .command("authoring-smoke")
    .alias("smoke")
    .description("verify authoring templates from a Pack tree without source dependencies")
    .option("--root <dir>", "Pack tree root", ".")
    .option("--json", "JSON output")
    .action((opts: { root?: string; json?: boolean }) => {
      const root = opts.root
        ? isAbsolute(opts.root)
          ? opts.root
          : join(process.cwd(), opts.root)
        : process.cwd();
      const smoke = runPackAuthoringSmoke(root);
      const output = { ok: smoke.ok, root, smoke };
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
        process.exitCode = smoke.ok ? 0 : 1;
        return;
      }
      process.stdout.write(`distribution authoring-smoke: ${smoke.ok ? "ok" : "blocked"}\n`);
      process.stdout.write(`  checked: ${smoke.checked.length}\n`);
      for (const error of smoke.errors) process.stdout.write(`  ${error}\n`);
      process.exitCode = smoke.ok ? 0 : 1;
    });

  distribution
    .command("plan")
    .description("emit the clean export, preflight, rollback, and contract plan")
    .option("--tag <tag>", "source/release tag (default: current Git HEAD or unreleased)")
    .option("--clean-repo <name>", "clean distribution repository", DEFAULT_PACK_REPO)
    .option("--package-root <path>", "consumer package root; defaults to repo root")
    .option("--json", "JSON output")
    .action((opts: { tag?: string; cleanRepo?: string; packageRoot?: string; json?: boolean }) => {
      const repoRoot = process.cwd();
      const tag = resolveDistributionTag(opts.tag);
      const detection = detectMode();
      // PLAN-L7-522 §2.2 (S1-a): readiness の runtime 検査は Bun ではなく Node を見る。
      // 実行中の node 自身が観測値であり、外部 probe を spawn しない。
      const nodeVersion = process.versions.node;
      const hasGit = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
      const hasGh = spawnSync("gh", ["--version"], { stdio: "ignore" }).status === 0;
      const packageRoot = opts.packageRoot ? join(repoRoot, opts.packageRoot) : repoRoot;
      // engines.node は consumer package root の package.json が正本 (第二の pin を持たない)。
      const requiredNodeVersion = ((): string | null => {
        const manifestPath = join(packageRoot, "package.json");
        if (!existsSync(manifestPath)) return null;
        try {
          const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as {
            engines?: { node?: unknown };
          };
          const node = parsed.engines?.node;
          return typeof node === "string" && node.trim() !== "" ? node.trim() : null;
        } catch {
          return null;
        }
      })();
      const exportPlan = buildCleanDistributionPlan({
        paths: collectDistributionCandidatePaths(repoRoot),
        sourceTag: tag,
        cleanRepo: opts.cleanRepo,
      });
      const readiness = buildConsumerReadinessPlan({
        nodeVersion,
        requiredNodeVersion,
        hasGit,
        hasGh,
        hasClaude: detection.claude,
        hasCodex: detection.codex,
        repoRoot,
        packageRoot,
        tag,
        cleanRepo: opts.cleanRepo,
        consumerRuntime: readConsumerRuntimeReadiness(repoRoot),
      });
      const output = {
        ok: exportPlan.ok && readiness.ok,
        export: exportPlan,
        readiness,
        actualCutRequiresPoApproval: true,
      };
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
        return;
      }
      process.stdout.write(
        `distribution plan: ${output.ok ? "ok" : "blocked"} channel=${exportPlan.channel} tag=${exportPlan.sourceTag}\n`,
      );
      process.stdout.write(`  clean-repo: ${exportPlan.cleanRepo}\n`);
      process.stdout.write(`  artifact-paths: ${exportPlan.artifactPaths.length}\n`);
      process.stdout.write(`  excluded-paths: ${exportPlan.excludedPaths.length}\n`);
      process.stdout.write(
        `  readiness: ${readiness.ok ? "ok" : "blocked"} mode=${readiness.mode}\n`,
      );
      process.stdout.write("  actual-cut: requires PO approval\n");
      process.exitCode = output.ok ? 0 : 1;
    });

  distribution
    .command("sync-plan")
    .description("emit a non-destructive clean Pack repository sync plan")
    .option("--tag <tag>", "source/release tag (default: current Git HEAD or unreleased)")
    .option("--clean-repo <name>", "clean distribution repository", DEFAULT_PACK_REPO)
    .option("--branch <name>", "Pack repository target branch", "main")
    .option("--staging-dir <path>", "local Pack staging clone path")
    .option("--json", "JSON output")
    .action(
      (opts: {
        tag?: string;
        cleanRepo?: string;
        branch?: string;
        stagingDir?: string;
        json?: boolean;
      }) => {
        const repoRoot = process.cwd();
        const tag = resolveDistributionTag(opts.tag);
        const sourcePaths = collectDistributionCandidatePaths(repoRoot);
        const exportPlan = buildCleanDistributionPlan({
          paths: sourcePaths,
          sourceTag: tag,
          cleanRepo: opts.cleanRepo,
        });
        const stagingDir = opts.stagingDir
          ? isAbsolute(opts.stagingDir)
            ? opts.stagingDir
            : join(repoRoot, opts.stagingDir)
          : join(repoRoot, ".ut-tdd", "pack-sync", exportPlan.sourceTag);
        const sync = buildPackSyncPlan({
          exportPlan,
          sourcePaths,
          stagingDir,
          branch: opts.branch,
        });
        const output = {
          ok: sync.ok,
          export: exportPlan,
          sync,
          actualRemoteMutationRequiresPoApproval: true,
        };
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
          process.exitCode = sync.ok ? 0 : 1;
          return;
        }
        process.stdout.write(
          `distribution sync-plan: ${sync.ok ? "ok" : "blocked"} tag=${sync.sourceTag}\n`,
        );
        process.stdout.write(`  clean-repo: ${sync.cleanRepo}\n`);
        process.stdout.write(`  staging-dir: ${sync.stagingDir}\n`);
        process.stdout.write(`  copy-plan: ${sync.copyPlan.length} files\n`);
        process.stdout.write(
          "  remote mutation: requires PO approval; commands were not executed\n",
        );
        process.exitCode = sync.ok ? 0 : 1;
      },
    );

  distribution
    .command("sync-stage")
    .description(
      "materialize clean Pack artifacts into a local staging directory without publishing",
    )
    .option("--tag <tag>", "source/release tag (default: current Git HEAD or unreleased)")
    .option("--clean-repo <name>", "clean distribution repository", DEFAULT_PACK_REPO)
    .option("--branch <name>", "Pack repository target branch", "main")
    .option("--out <dir>", "local staging directory", ".ut-tdd/pack-stage")
    .option("--json", "JSON output")
    .action(
      (opts: {
        tag?: string;
        cleanRepo?: string;
        branch?: string;
        out?: string;
        json?: boolean;
      }) => {
        const repoRoot = process.cwd();
        const tag = resolveDistributionTag(opts.tag);
        const sourcePaths = collectDistributionCandidatePaths(repoRoot);
        const exportPlan = buildCleanDistributionPlan({
          paths: sourcePaths,
          sourceTag: tag,
          cleanRepo: opts.cleanRepo,
        });
        const secretScan = runDistributionSecretScan({
          repoRoot,
          sourcePaths,
          artifactPaths: exportPlan.artifactPaths,
        });
        const outDir = opts.out
          ? isAbsolute(opts.out)
            ? opts.out
            : join(repoRoot, opts.out)
          : join(repoRoot, ".ut-tdd", "pack-stage");
        const sync = buildPackSyncPlan({
          exportPlan,
          sourcePaths,
          stagingDir: outDir,
          branch: opts.branch,
        });
        ensureDir(outDir, { recursive: true });
        const plannedArtifacts = new Set(exportPlan.artifactPaths);
        const unmanagedExistingPaths = collectFilesystemCandidatePaths(outDir).filter(
          (path) =>
            !plannedArtifacts.has(path) && !path.startsWith(".git/") && path !== PACK_SYNC_MANIFEST,
        );
        let copyError: string | null = null;
        let authoringSmoke: PackAuthoringSmokeResult = {
          ok: false,
          checked: [],
          errors: ["not-run"],
        };
        if (exportPlan.ok && secretScan.ok) {
          try {
            for (const rel of exportPlan.artifactPaths) {
              const sourceRel = cleanDistributionSourcePath(rel, sourcePaths);
              copyCleanDistributionArtifact({
                sourceRoot: repoRoot,
                sourcePath: sourceRel,
                targetRoot: outDir,
                artifactPath: rel,
              });
            }
          } catch (error) {
            copyError = error instanceof Error ? error.message : String(error);
          }
          if (copyError === null) authoringSmoke = runPackAuthoringSmoke(outDir);
        }
        const manifest = join(outDir, PACK_SYNC_MANIFEST);
        const output = {
          ok:
            exportPlan.ok &&
            secretScan.ok &&
            copyError === null &&
            authoringSmoke.ok &&
            unmanagedExistingPaths.length === 0,
          export: exportPlan,
          secretScan: {
            ok: secretScan.ok,
            checked: secretScan.checked,
            violations: secretScan.violations,
          },
          authoringSmoke,
          sync,
          stage: {
            outDir,
            manifest,
            copiedArtifacts:
              copyError === null && exportPlan.ok && secretScan.ok
                ? exportPlan.artifactPaths.length
                : 0,
            unmanagedExistingPaths,
            copyError,
            destructiveRemoteMutation: false,
            actualRemoteMutationRequiresPoApproval: true,
          },
        };
        writeFileSync(manifest, `${JSON.stringify(output, null, 2)}\n`, "utf8");
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
          process.exitCode = output.ok ? 0 : 1;
          return;
        }
        process.stdout.write(
          `distribution sync-stage: ${output.ok ? "ok" : "blocked"} tag=${exportPlan.sourceTag}\n`,
        );
        process.stdout.write(`  out: ${outDir}\n`);
        process.stdout.write(`  copied-artifacts: ${output.stage.copiedArtifacts}\n`);
        if (!secretScan.ok) {
          process.stdout.write(`  ${secretScanMessages(secretScan)[0]}\n`);
        }
        process.stdout.write(`  unmanaged-existing: ${unmanagedExistingPaths.length}\n`);
        process.stdout.write(
          "  remote mutation: requires PO approval; no push/release was executed\n",
        );
        process.exitCode = output.ok ? 0 : 1;
      },
    );

  distribution
    .command("sync-pack")
    .description(
      "update a local Pack repository checkout with clean artifacts; never commits or pushes",
    )
    .option("--tag <tag>", "source/release tag (default: current Git HEAD or unreleased)")
    .option("--clean-repo <name>", "clean distribution repository", DEFAULT_PACK_REPO)
    .option("--branch <name>", "Pack repository target branch", "main")
    .requiredOption("--repo-dir <dir>", "local Pack repository checkout to update")
    .option("--prune-local", "remove local files in repo-dir that are not part of the clean Pack")
    .option("--json", "JSON output")
    .action(
      (opts: {
        tag?: string;
        cleanRepo?: string;
        branch?: string;
        repoDir: string;
        pruneLocal?: boolean;
        json?: boolean;
      }) => {
        const repoRoot = process.cwd();
        const tag = resolveDistributionTag(opts.tag);
        const repoDir = isAbsolute(opts.repoDir) ? opts.repoDir : join(repoRoot, opts.repoDir);
        const repoExists = existsSync(repoDir);
        const sourcePaths = collectDistributionCandidatePaths(repoRoot);
        const exportPlan = buildCleanDistributionPlan({
          paths: sourcePaths,
          sourceTag: tag,
          cleanRepo: opts.cleanRepo,
        });
        const secretScan = runDistributionSecretScan({
          repoRoot,
          sourcePaths,
          artifactPaths: exportPlan.artifactPaths,
        });
        const sync = buildPackSyncPlan({
          exportPlan,
          sourcePaths,
          stagingDir: repoDir,
          branch: opts.branch,
        });
        const plannedArtifacts = new Set(exportPlan.artifactPaths);
        const existingBefore = repoExists
          ? collectFilesystemCandidatePaths(repoDir).filter((path) => !plannedArtifacts.has(path))
          : [];
        const prunedPaths: string[] = [];
        let copyError: string | null = null;
        let pruneError: string | null = null;
        let authoringSmoke: PackAuthoringSmokeResult = {
          ok: false,
          checked: [],
          errors: ["not-run"],
        };

        if (repoExists && opts.pruneLocal && exportPlan.ok && secretScan.ok) {
          try {
            for (const rel of existingBefore) {
              rmSync(join(repoDir, ...rel.split("/")), { force: true });
              prunedPaths.push(rel);
            }
          } catch (error) {
            pruneError = error instanceof Error ? error.message : String(error);
          }
        }

        if (repoExists && exportPlan.ok && secretScan.ok && pruneError === null) {
          try {
            for (const rel of exportPlan.artifactPaths) {
              const sourceRel = cleanDistributionSourcePath(rel, sourcePaths);
              copyCleanDistributionArtifact({
                sourceRoot: repoRoot,
                sourcePath: sourceRel,
                targetRoot: repoDir,
                artifactPath: rel,
              });
            }
          } catch (error) {
            copyError = error instanceof Error ? error.message : String(error);
          }
          if (copyError === null) authoringSmoke = runPackAuthoringSmoke(repoDir);
        }

        const unmanagedExistingPaths =
          repoExists && pruneError === null
            ? collectFilesystemCandidatePaths(repoDir).filter((path) => !plannedArtifacts.has(path))
            : existingBefore;
        const manifestDir = join(repoRoot, ".ut-tdd", "pack-sync");
        ensureDir(manifestDir, { recursive: true });
        const manifest = join(
          manifestDir,
          `${exportPlan.sourceTag.replace(/[^A-Za-z0-9._-]+/g, "-")}.sync-pack.json`,
        );
        const output = {
          ok:
            repoExists &&
            exportPlan.ok &&
            secretScan.ok &&
            pruneError === null &&
            copyError === null &&
            authoringSmoke.ok &&
            unmanagedExistingPaths.length === 0,
          export: exportPlan,
          secretScan: {
            ok: secretScan.ok,
            checked: secretScan.checked,
            violations: secretScan.violations,
          },
          authoringSmoke,
          sync,
          pack: {
            repoDir,
            repoExists,
            manifest,
            copiedArtifacts:
              repoExists && exportPlan.ok && pruneError === null && copyError === null
                ? exportPlan.artifactPaths.length
                : 0,
            pruneLocal: Boolean(opts.pruneLocal),
            prunedPaths,
            unmanagedExistingPaths,
            pruneError,
            copyError,
            localGitMutationExecuted: false,
            destructiveRemoteMutation: false,
            actualRemoteMutationRequiresPoApproval: true,
            nextCommands: [
              `git -C ${repoDir} status --short`,
              ...gitAddPathspecCommands(repoDir, exportPlan.artifactPaths, existingBefore),
              `git -C ${repoDir} commit -m "chore: sync clean pack ${exportPlan.sourceTag}"`,
              `git -C ${repoDir} push origin ${opts.branch ?? "main"}`,
            ],
          },
        };
        writeFileSync(manifest, `${JSON.stringify(output, null, 2)}\n`, "utf8");
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
          process.exitCode = output.ok ? 0 : 1;
          return;
        }
        process.stdout.write(
          `distribution sync-pack: ${output.ok ? "ok" : "blocked"} tag=${exportPlan.sourceTag}\n`,
        );
        process.stdout.write(`  repo-dir: ${repoDir}\n`);
        process.stdout.write(`  copied-artifacts: ${output.pack.copiedArtifacts}\n`);
        if (!secretScan.ok) {
          process.stdout.write(`  ${secretScanMessages(secretScan)[0]}\n`);
        }
        process.stdout.write(`  unmanaged-existing: ${unmanagedExistingPaths.length}\n`);
        process.stdout.write(`  pruned-local: ${prunedPaths.length}\n`);
        process.stdout.write(
          "  git commit/push: requires explicit human approval; commands were not executed\n",
        );
        process.exitCode = output.ok ? 0 : 1;
      },
    );

  distribution
    .command("release-plan")
    .description(
      "emit non-destructive git tag and gh release commands for human-approved publishing",
    )
    .requiredOption("--tag <tag>", "release tag, e.g. v0.1.0")
    .option("--repo <name>", "GitHub repository for release publication", DEFAULT_PACK_REPO)
    .option("--json", "JSON output")
    .action((opts: { tag: string; repo?: string; json?: boolean }) => {
      const plan = buildReleasePublicationPlan({
        tag: opts.tag,
        repo: opts.repo ?? DEFAULT_PACK_REPO,
        dryRun: true,
      });
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
        process.exitCode = plan.ok ? 0 : 1;
        return;
      }
      process.stdout.write(
        `release plan: ${plan.ok ? "ok" : "blocked"} tag=${plan.tag} repo=${plan.repo}\n`,
      );
      for (const command of plan.commands) process.stdout.write(`  ${command}\n`);
      process.stdout.write("  publish: requires PO approval; commands were not executed\n");
      process.exitCode = plan.ok ? 0 : 1;
    });

  distribution
    .command("package")
    .description("create the exact Pack Release asset set without publishing")
    .requiredOption("--tag <tag>", "source/release tag")
    .option("--out <dir>", "output directory for local release artifacts", ".ut-tdd/release")
    .option("--json", "JSON output")
    .action(async (opts: { tag: string; out?: string; json?: boolean }) => {
      const repoRoot = process.cwd();
      const outDir = opts.out
        ? isAbsolute(opts.out)
          ? opts.out
          : join(repoRoot, opts.out)
        : join(repoRoot, ".ut-tdd", "release");
      try {
        const output = await packageConsumerRuntimeRelease({ repoRoot, tag: opts.tag, outDir });
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
          return;
        }
        process.stdout.write(`distribution package: ok tag=${output.tag}\n`);
        process.stdout.write(`  source-revision: ${output.sourceRevision}\n`);
        for (const [name, digest] of Object.entries(output.assetDigests))
          process.stdout.write(`  sha256: ${name} ${digest}\n`);
        process.stdout.write(`  consumer-anchor: ${output.consumerAnchorDigest}\n`);
      } catch (error) {
        const output = { ok: false, error: String(error) };
        if (opts.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
        else process.stdout.write(`distribution package: blocked ${output.error}\n`);
        process.exitCode = 1;
      }
    });
}
