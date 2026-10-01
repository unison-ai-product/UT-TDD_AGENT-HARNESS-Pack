import { existsSync } from "node:fs";
import { join } from "node:path";

const DESIGN_ROOT_CANDIDATES = ["docs/design/harness", "docs/design"] as const;
const TEST_DESIGN_ROOT_CANDIDATES = ["docs/test-design/harness", "docs/test-design"] as const;

export interface VModelRoots {
  designRoot: string;
  testDesignRoot: string;
}

function firstExistingRoot(repoRoot: string, candidates: readonly string[]): string {
  const existing = candidates.find((root) => existsSync(join(repoRoot, root)));
  if (existing) return existing;
  const fallback = candidates[candidates.length - 1];
  if (!fallback) throw new Error("V-model root candidates must not be empty");
  return fallback;
}

/**
 * Resolve the repository's V-model authoring roots.
 *
 * The harness layout wins when both layouts exist so the source repository keeps
 * its historical paths while clean consumers can author directly under docs/.
 */
export function resolveVModelRoots(repoRoot: string = process.cwd()): VModelRoots {
  return {
    designRoot: firstExistingRoot(repoRoot, DESIGN_ROOT_CANDIDATES),
    testDesignRoot: firstExistingRoot(repoRoot, TEST_DESIGN_ROOT_CANDIDATES),
  };
}

export function resolveDesignRoot(repoRoot: string = process.cwd()): string {
  return resolveVModelRoots(repoRoot).designRoot;
}

export function resolveTestDesignRoot(repoRoot: string = process.cwd()): string {
  return resolveVModelRoots(repoRoot).testDesignRoot;
}

function normalizedPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function mapRoot(path: string, canonicalRoot: string, resolvedRoot: string): string | null {
  if (path === canonicalRoot) return resolvedRoot;
  const prefix = `${canonicalRoot}/`;
  if (!path.startsWith(prefix)) return null;
  return `${resolvedRoot}/${path.slice(prefix.length)}`;
}

/** Map a catalog's canonical authoring path to the active consumer layout. */
export function resolveAuthoringSourcePath(repoRoot: string, authoringSourcePath: string): string {
  const path = normalizedPath(authoringSourcePath);
  const roots = resolveVModelRoots(repoRoot);
  return (
    mapRoot(path, "docs/design/harness", roots.designRoot) ??
    mapRoot(path, "docs/test-design/harness", roots.testDesignRoot) ??
    path
  );
}

export function resolveAuthoringSourceAbsolutePath(
  repoRoot: string,
  authoringSourcePath: string,
): string {
  return join(repoRoot, resolveAuthoringSourcePath(repoRoot, authoringSourcePath));
}

export function canonicalizeVModelPath(path: string): string {
  return normalizedPath(path).replace(/^docs\/(design|test-design)\/harness(?=\/|$)/, "docs/$1");
}
