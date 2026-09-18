import { spawn } from "node:child_process";
import type { ReleaseIdentity } from "../schema/release-manifest.ts";
import type {
  MaterializedReleaseEntry,
  ReleaseEntryMode,
  ReleaseMaterializationResult,
  ReleaseSourceEntry,
} from "./release-materializer.ts";

const OBJECT_ID = /^[a-f0-9]{40}$/;
const ENTRY_MODES = new Set<ReleaseEntryMode>(["100644", "100755", "120000"]);
const utf8 = new TextDecoder("utf-8", { fatal: true });

export interface GitProcessRequest {
  readonly repository: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdin?: Uint8Array;
}

export interface GitProcessResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stdoutChunks?: readonly Uint8Array[];
}

export interface GitProcessRunner {
  run(request: GitProcessRequest): Promise<GitProcessResult>;
}

type ObjectReadResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: "unavailable" };
type TreeReadResult =
  | { readonly ok: true; readonly records: Uint8Array }
  | { readonly ok: false; readonly error: "unavailable" };
type BlobReadResult =
  | { readonly ok: true; readonly blobs: ReadonlyMap<string, Uint8Array> }
  | { readonly ok: false; readonly error: "unavailable" };

export interface LocalGitObjectReader {
  hasCommit(repository: string, revision: string): Promise<ObjectReadResult>;
  listTree(repository: string, revision: string): Promise<TreeReadResult>;
  readBlobs(repository: string, objectIds: readonly string[]): Promise<BlobReadResult>;
}

export interface ReleaseArtifactResolverDependencies {
  readonly git: LocalGitObjectReader;
  readonly materialize: (input: {
    readonly materializerVersion: unknown;
    readonly entries: readonly ReleaseSourceEntry[];
  }) => ReleaseMaterializationResult | Promise<ReleaseMaterializationResult>;
}

export type ReleaseArtifactResolution =
  | {
      readonly ok: true;
      readonly releaseId: string;
      readonly artifactSourceCommit: string;
      readonly artifactSetDigest: string;
      readonly entries: readonly MaterializedReleaseEntry[];
      readonly digest: string;
    }
  | {
      readonly ok: false;
      readonly error: "unavailable" | "invalid_distribution_plan" | "invalid_artifact";
    };

function gitEnvironment(): Record<string, string | undefined> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => {
      const name = key.toUpperCase();
      return (
        ![
          "GIT_DIR",
          "GIT_COMMON_DIR",
          "GIT_OBJECT_DIRECTORY",
          "GIT_ALTERNATE_OBJECT_DIRECTORIES",
          "GIT_WORK_TREE",
        ].includes(name) &&
        name !== "GIT_CONFIG" &&
        !name.startsWith("GIT_CONFIG_")
      );
    }),
  );
  return {
    ...inherited,
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
}

const processRunner: GitProcessRunner = {
  run(request) {
    return new Promise((resolve) => {
      const child = spawn("git", [...request.args], {
        cwd: request.repository,
        env: request.env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      });
      const chunks: Buffer[] = [];
      let settled = false;
      const finish = (result: GitProcessResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      child.stdout.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      child.on("error", () => finish({ exitCode: -1, stdout: new Uint8Array() }));
      child.on("close", (code) => {
        try {
          const batch = request.args[0] === "cat-file" && request.args[1] === "--batch";
          finish({
            exitCode: code ?? -1,
            stdout: batch ? new Uint8Array() : Buffer.concat(chunks),
            stdoutChunks: batch ? chunks : undefined,
          });
        } catch {
          finish({ exitCode: -1, stdout: new Uint8Array() });
        }
      });
      child.stdin.on("error", () => finish({ exitCode: -1, stdout: new Uint8Array() }));
      child.stdin.end(request.stdin);
    });
  },
};

function parseBatchChunks(
  chunks: readonly Uint8Array[],
  expected: readonly string[],
): ReadonlyMap<string, Uint8Array> | null {
  const maxHeaderBytes = 64;
  const blobs = new Map<string, Uint8Array>();
  let header = Buffer.alloc(0);
  let expectedIndex = 0;
  let phase: "header" | "payload" | "line-feed" = "header";
  let size = 0;
  let remaining = 0;
  let contentChunks: Buffer[] = [];
  try {
    for (const rawChunk of chunks) {
      const chunk = Buffer.from(rawChunk);
      let offset = 0;
      while (offset < chunk.length) {
        if (expectedIndex >= expected.length) return null;
        const expectedId = expected[expectedIndex];
        if (phase === "header") {
          const newline = chunk.indexOf(0x0a, offset);
          const fragment = chunk.subarray(offset, newline < 0 ? chunk.length : newline);
          if (header.length + fragment.length > maxHeaderBytes) return null;
          header = Buffer.concat([header, fragment]);
          offset = newline < 0 ? chunk.length : newline + 1;
          if (newline < 0) continue;
          const headerText = header.toString("ascii");
          header = Buffer.alloc(0);
          if (headerText === `${expectedId} missing`) return null;
          const match = headerText.match(/^([a-f0-9]{40}) blob (0|[1-9][0-9]*)$/);
          if (!match || match[1] !== expectedId) return null;
          size = Number(match[2]);
          if (!Number.isSafeInteger(size) || size < 0) return null;
          remaining = size;
          contentChunks = [];
          phase = "payload";
        }
        if (phase === "payload") {
          const take = Math.min(remaining, chunk.length - offset);
          if (take > 0) contentChunks.push(chunk.subarray(offset, offset + take));
          remaining -= take;
          offset += take;
          if (remaining > 0) continue;
          phase = "line-feed";
        }
        if (phase === "line-feed") {
          if (offset >= chunk.length) continue;
          if (chunk[offset] !== 0x0a) return null;
          offset += 1;
          blobs.set(expectedId, new Uint8Array(Buffer.concat(contentChunks, size)));
          expectedIndex += 1;
          phase = "header";
        }
      }
    }
  } catch {
    return null;
  }
  return expectedIndex === expected.length && phase === "header" && header.length === 0
    ? blobs
    : null;
}

export function createLocalGitObjectReader(
  runner: GitProcessRunner = processRunner,
): LocalGitObjectReader {
  const run = (repository: string, args: readonly string[], stdin?: Uint8Array) =>
    runner.run({ repository, args, env: gitEnvironment(), stdin });
  return {
    async hasCommit(repository, revision) {
      const result = await run(repository, ["cat-file", "-e", `${revision}^{commit}`]);
      return result.exitCode === 0 ? { ok: true } : { ok: false, error: "unavailable" };
    },
    async listTree(repository, revision) {
      const result = await run(repository, ["ls-tree", "-r", "-z", "--full-tree", revision]);
      return result.exitCode === 0
        ? { ok: true, records: result.stdout }
        : { ok: false, error: "unavailable" };
    },
    async readBlobs(repository, objectIds) {
      if (objectIds.length === 0) return { ok: true, blobs: new Map() };
      const result = await run(
        repository,
        ["cat-file", "--batch"],
        Buffer.from(`${objectIds.join("\n")}\n`, "ascii"),
      );
      if (result.exitCode !== 0) return { ok: false, error: "unavailable" };
      const blobs = parseBatchChunks(result.stdoutChunks ?? [result.stdout], objectIds);
      return blobs ? { ok: true, blobs } : { ok: false, error: "unavailable" };
    },
  };
}

interface ParsedTreeEntry {
  readonly path: string;
  readonly mode: ReleaseEntryMode;
  readonly objectId: string;
}

function validPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  );
}

function parseTree(records: Uint8Array): readonly ParsedTreeEntry[] | null {
  const bytes = Buffer.from(records);
  if (bytes.length === 0 || bytes.at(-1) !== 0) return null;
  const entries: ParsedTreeEntry[] = [];
  const paths = new Set<string>();
  let offset = 0;
  while (offset < bytes.length) {
    const end = bytes.indexOf(0, offset);
    if (end < 0 || end === offset) return null;
    const record = bytes.subarray(offset, end);
    offset = end + 1;
    const firstSpace = record.indexOf(0x20);
    const secondSpace = record.indexOf(0x20, firstSpace + 1);
    const tab = record.indexOf(0x09, secondSpace + 1);
    if (firstSpace <= 0 || secondSpace <= firstSpace || tab <= secondSpace) return null;
    const mode = record.subarray(0, firstSpace).toString("ascii") as ReleaseEntryMode;
    const type = record.subarray(firstSpace + 1, secondSpace).toString("ascii");
    const objectId = record.subarray(secondSpace + 1, tab).toString("ascii");
    let path: string;
    try {
      path = utf8.decode(record.subarray(tab + 1));
    } catch {
      return null;
    }
    if (!ENTRY_MODES.has(mode) || type !== "blob" || !OBJECT_ID.test(objectId) || !validPath(path))
      return null;
    if (paths.has(path)) return null;
    paths.add(path);
    entries.push({ path, mode, objectId });
  }
  return entries;
}

async function resolveReleaseArtifactsUnsafe(
  input: { readonly repository: string; readonly release: ReleaseIdentity },
  dependencies: ReleaseArtifactResolverDependencies,
): Promise<ReleaseArtifactResolution> {
  const revision = input.release.artifactSourceCommit;
  if (!OBJECT_ID.test(revision)) return { ok: false, error: "unavailable" };
  const commit = await dependencies.git.hasCommit(input.repository, revision);
  if (!commit.ok) return commit;
  const tree = await dependencies.git.listTree(input.repository, revision);
  if (!tree.ok) return tree;
  const parsed = parseTree(tree.records);
  if (!parsed) return { ok: false, error: "invalid_artifact" };
  const objectIds = [...new Set(parsed.map((entry) => entry.objectId))];
  const blobResult = await dependencies.git.readBlobs(input.repository, objectIds);
  if (!blobResult.ok) return blobResult;
  const entries: ReleaseSourceEntry[] = [];
  for (const entry of parsed) {
    const content = blobResult.blobs.get(entry.objectId);
    if (!content) return { ok: false, error: "unavailable" };
    entries.push({ path: entry.path, mode: entry.mode, content: new Uint8Array(content) });
  }
  const materialized = await dependencies.materialize({
    materializerVersion: input.release.materializerVersion,
    entries,
  });
  if (!materialized.ok) return materialized;
  return Object.freeze({
    ok: true,
    releaseId: input.release.releaseId,
    artifactSourceCommit: revision,
    artifactSetDigest: input.release.artifactSetDigest,
    entries: materialized.entries,
    digest: materialized.digest,
  });
}

export async function resolveReleaseArtifacts(
  input: { readonly repository: string; readonly release: ReleaseIdentity },
  dependencies: ReleaseArtifactResolverDependencies,
): Promise<ReleaseArtifactResolution> {
  try {
    return await resolveReleaseArtifactsUnsafe(input, dependencies);
  } catch {
    return { ok: false, error: "unavailable" };
  }
}
