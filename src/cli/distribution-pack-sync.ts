/**
 * The filesystem part of `distribution sync-pack` / `stage`: copy of Pack artifacts and of the
 * tagged-source build inputs (docs/design/harness/L6-function-design/pack-build-inputs.md §5).
 * `distribution.ts` only calls into this module.
 */
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type CleanDistributionPlan,
  cleanDistributionSourcePath,
  type PackAuthoringSmokeResult,
  runPackAuthoringSmoke,
  transformCleanDistributionArtifact,
} from "../setup/index.ts";
import { ensureDir } from "../shared/fs.ts";
import * as privacy from "./distribution-privacy.ts";

export function copyCleanDistributionArtifact(input: {
  sourceRoot: string;
  sourcePath: string;
  targetRoot: string;
  artifactPath: string;
}): void {
  if (
    input.sourcePath === ".ut-tdd/teams/example-review-team.yaml" &&
    input.artifactPath === "docs/templates/team/example-review-team.yaml"
  ) {
    const projection = privacy.readTrackedTeamBlob(input.sourceRoot);
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

/**
 * When `run`, prune (optional) then copy the artifacts and the build inputs into `repoDir`. The build inputs
 * are copied with their bytes unchanged under the same relative path (pack-build-inputs.md §5).
 */
export function applyPackSync(input: {
  run: boolean;
  repoRoot: string;
  repoDir: string;
  exportPlan: CleanDistributionPlan;
  sourcePaths: readonly string[];
  buildInputPaths: readonly string[];
  prunePaths: readonly string[];
}): {
  prunedPaths: string[];
  pruneError: string | null;
  copyError: string | null;
  authoringSmoke: PackAuthoringSmokeResult;
} {
  const prunedPaths: string[] = [];
  let pruneError: string | null = null;
  let copyError: string | null = null;
  let authoringSmoke: PackAuthoringSmokeResult = { ok: false, checked: [], errors: ["not-run"] };
  if (!input.run) return { prunedPaths, pruneError, copyError, authoringSmoke };
  try {
    for (const rel of input.prunePaths) {
      rmSync(join(input.repoDir, ...rel.split("/")), { force: true });
      prunedPaths.push(rel);
    }
  } catch (error) {
    pruneError = error instanceof Error ? error.message : String(error);
  }
  if (pruneError !== null) return { prunedPaths, pruneError, copyError, authoringSmoke };
  try {
    for (const rel of input.exportPlan.artifactPaths) {
      const sourcePath = cleanDistributionSourcePath(rel, input.sourcePaths);
      copyCleanDistributionArtifact({
        sourceRoot: input.repoRoot,
        sourcePath,
        targetRoot: input.repoDir,
        artifactPath: rel,
      });
    }
    for (const rel of input.buildInputPaths) {
      copyCleanDistributionArtifact({
        sourceRoot: input.repoRoot,
        sourcePath: rel,
        targetRoot: input.repoDir,
        artifactPath: rel,
      });
    }
  } catch (error) {
    copyError = error instanceof Error ? error.message : String(error);
  }
  if (copyError === null) authoringSmoke = runPackAuthoringSmoke(input.repoDir);
  return { prunedPaths, pruneError, copyError, authoringSmoke };
}
