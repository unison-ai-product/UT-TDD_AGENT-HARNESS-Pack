import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  projectTrackedTeamBlob,
  validateAuthoringArtifactSet,
} from "./authoring-template-inventory.ts";
import {
  buildCleanDistributionPlan,
  type CleanDistributionPlan,
  cleanDistributionArtifactPath,
  cleanDistributionSourcePath,
  transformCleanDistributionArtifact,
} from "./distribution.ts";

export type ReleaseEntryMode = "100644" | "100755" | "120000";

export interface ReleaseSourceEntry {
  readonly path: string;
  readonly mode: ReleaseEntryMode;
  readonly content: Uint8Array;
}

export interface MaterializedReleaseEntry {
  readonly path: string;
  readonly mode: ReleaseEntryMode;
  readonly content: Uint8Array;
}

export type ReleaseMaterializationResult =
  | {
      readonly ok: true;
      readonly entries: readonly MaterializedReleaseEntry[];
      readonly digest: string;
    }
  | {
      readonly ok: false;
      readonly error: "unavailable" | "invalid_distribution_plan" | "invalid_artifact";
    };

export interface ReleaseMaterializerDependencies {
  readonly buildPlan?: (paths: string[]) => CleanDistributionPlan;
  readonly artifactPath?: (path: string) => string;
  readonly sourcePath?: (artifactPath: string, sourcePaths: Iterable<string>) => string;
  readonly transform?: (artifactPath: string, content: string) => string;
}

const CONTROL_MANIFEST = "release/manifest.yaml";
const MODES = new Set<ReleaseEntryMode>(["100644", "100755", "120000"]);
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

function validPath(path: string): boolean {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  )
    return false;
  try {
    return decoder.decode(encoder.encode(path)) === path;
  } catch {
    return false;
  }
}

function validSymlink(destination: string, content: Uint8Array): boolean {
  let target: string;
  try {
    target = decoder.decode(content);
  } catch {
    return false;
  }
  if (
    target.length === 0 ||
    target.includes("\0") ||
    target.includes("\\") ||
    target.startsWith("/") ||
    target.startsWith("//") ||
    /^[A-Za-z]:/.test(target) ||
    target.startsWith("\\\\")
  )
    return false;
  const resolved = posix.normalize(posix.join(posix.dirname(destination), target));
  return resolved !== ".." && !resolved.startsWith("../") && !posix.isAbsolute(resolved);
}

function frame(entries: readonly MaterializedReleaseEntry[]): Uint8Array {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const path = Buffer.from(entry.path, "utf8");
    const mode = Buffer.from(entry.mode, "ascii");
    const pathLength = Buffer.alloc(4);
    const modeLength = Buffer.alloc(4);
    const contentLength = Buffer.alloc(8);
    pathLength.writeUInt32BE(path.length);
    modeLength.writeUInt32BE(mode.length);
    contentLength.writeBigUInt64BE(BigInt(entry.content.length));
    chunks.push(pathLength, path, modeLength, mode, contentLength, Buffer.from(entry.content));
  }
  return Buffer.concat(chunks);
}

/**
 * Materialized artifact setのcanonical digest。consumer側がmanifest/receiptの申告値を
 * 入力にせず、受領したpath/mode/contentから同じframeを再計算するためのport。
 */
export function digestMaterializedReleaseEntries(
  entries: readonly MaterializedReleaseEntry[],
): string {
  return `sha256:${createHash("sha256").update(frame(entries)).digest("hex")}`;
}

function immutableEntry(
  path: string,
  mode: ReleaseEntryMode,
  content: Uint8Array,
): MaterializedReleaseEntry {
  const snapshot = new Uint8Array(content);
  return Object.freeze({
    path,
    mode,
    get content(): Uint8Array {
      return new Uint8Array(snapshot);
    },
  });
}

export function materializeReleaseArtifacts(
  input: { readonly materializerVersion: unknown; readonly entries: readonly ReleaseSourceEntry[] },
  dependencies: ReleaseMaterializerDependencies = {},
): ReleaseMaterializationResult {
  if (input.materializerVersion !== "1") return { ok: false, error: "unavailable" };

  const buildPlan = dependencies.buildPlan ?? ((paths) => buildCleanDistributionPlan({ paths }));
  const artifactPath = dependencies.artifactPath ?? cleanDistributionArtifactPath;
  const sourcePath = dependencies.sourcePath ?? cleanDistributionSourcePath;
  const transform = dependencies.transform ?? transformCleanDistributionArtifact;
  const sourcePaths = input.entries.map((entry) => entry.path);
  const plan = buildPlan(sourcePaths);
  if (!plan.ok) return { ok: false, error: "invalid_distribution_plan" };
  const authoringSet = validateAuthoringArtifactSet(plan.artifactPaths);
  if (!authoringSet.ok) return { ok: false, error: "invalid_distribution_plan" };

  const excluded = new Set(plan.excludedPaths);
  const destinations = new Map<string, string>();
  for (const source of sourcePaths) {
    if (excluded.has(source)) continue;
    const destination = artifactPath(source);
    const previous = destinations.get(destination);
    if (previous !== undefined && previous !== source)
      return { ok: false, error: "invalid_distribution_plan" };
    destinations.set(destination, source);
  }

  const sources = new Map<string, ReleaseSourceEntry>();
  for (const entry of input.entries) {
    if (sources.has(entry.path)) return { ok: false, error: "invalid_distribution_plan" };
    sources.set(entry.path, entry);
  }

  const artifactPaths = plan.artifactPaths.filter((path) => path !== CONTROL_MANIFEST);
  if (artifactPaths.length === 0 || new Set(artifactPaths).size !== artifactPaths.length)
    return { ok: false, error: "invalid_distribution_plan" };

  const output: MaterializedReleaseEntry[] = [];
  for (const destination of artifactPaths) {
    if (!validPath(destination)) return { ok: false, error: "invalid_artifact" };
    const source = sources.get(sourcePath(destination, sourcePaths));
    if (!source) return { ok: false, error: "invalid_distribution_plan" };
    if (!MODES.has(source.mode)) return { ok: false, error: "invalid_artifact" };

    if (source.path === ".ut-tdd/teams/example-review-team.yaml") {
      const projection = projectTrackedTeamBlob({
        blobs: [{ path: source.path, mode: source.mode, bytes: source.content }],
      });
      if (!projection.ok) return { ok: false, error: "invalid_artifact" };
    }

    let content = new Uint8Array(source.content);
    if (source.mode === "120000" && !validSymlink(destination, content))
      return { ok: false, error: "invalid_artifact" };
    if (destination === "package.json") {
      try {
        content = encoder.encode(transform(destination, decoder.decode(content)));
      } catch {
        return { ok: false, error: "invalid_artifact" };
      }
    }
    output.push(immutableEntry(destination, source.mode, content));
  }

  output.sort((a, b) => Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")));
  const entries = Object.freeze(output);
  return Object.freeze({
    ok: true,
    entries,
    digest: digestMaterializedReleaseEntries(entries),
  });
}
