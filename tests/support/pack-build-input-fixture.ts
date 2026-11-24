import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  cleanDistributionSourcePath,
  transformCleanDistributionArtifact,
} from "../../src/setup/distribution.ts";
import { selectPackBuildInputs } from "../../src/setup/pack-build-inputs.ts";

/**
 * Copies Pack artifact paths of `sourceRoot` into a fixture repository (the layout `sync-pack`
 * reads). `package.json` is transformed like the real Pack when `transformPackageJson` is set.
 */
export function copyPackFiles(
  sourceRoot: string,
  targetRoot: string,
  artifactPaths: readonly string[],
  sourcePaths: readonly string[],
  transformPackageJson = false,
): void {
  for (const rel of artifactPaths) {
    const from = join(sourceRoot, ...cleanDistributionSourcePath(rel, sourcePaths).split("/"));
    const to = join(targetRoot, ...rel.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    if (transformPackageJson && rel === "package.json")
      writeFileSync(to, transformCleanDistributionArtifact(rel, readFileSync(from, "utf8")));
    else cpSync(from, to, { recursive: true });
  }
}

/**
 * Copies the Pack build inputs (pack-build-inputs.md §3) of `sourceRoot` into a fixture repository
 * that stands in for a tagged source. The selection stays in `selectPackBuildInputs` (single
 * source); a fixture that lacks an input fails here, with the reason code.
 */
export function copyPackBuildInputs(
  sourceRoot: string,
  targetRoot: string,
  sourcePaths: readonly string[],
): void {
  const selection = selectPackBuildInputs(sourcePaths);
  if (!selection.ok) throw new Error(`fixture build inputs: ${JSON.stringify(selection.reasons)}`);
  for (const rel of selection.paths) {
    const to = join(targetRoot, ...rel.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(sourceRoot, ...rel.split("/")), to);
  }
}
