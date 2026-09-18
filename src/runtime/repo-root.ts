import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const PROJECT_MARKER = "ut-tdd.project.json";

export function resolveRuntimeRepoRoot(input?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  allowCwdFallback?: boolean;
}): string | null {
  const cwd = resolve(input?.cwd ?? process.cwd());
  const env = input?.env ?? process.env;
  const exists = input?.exists ?? existsSync;
  for (const candidate of [env.UT_TDD_PROJECT_DIR, env.CLAUDE_PROJECT_DIR]) {
    if (candidate && isAbsolute(candidate) && isRepoRoot(candidate, exists))
      return resolve(candidate);
  }
  let current = cwd;
  while (true) {
    if (isRepoRoot(current, exists)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function requireRuntimeRepoRoot(
  input?: Parameters<typeof resolveRuntimeRepoRoot>[0],
): string {
  const repoRoot = resolveRuntimeRepoRoot(input);
  if (!repoRoot && input?.allowCwdFallback) return resolve(input.cwd ?? process.cwd());
  if (!repoRoot)
    throw new Error("UT-TDD repository root could not be resolved; runtime state write blocked");
  return repoRoot;
}

function isRepoRoot(path: string, exists: (path: string) => boolean): boolean {
  return (
    exists(resolve(path, PROJECT_MARKER)) ||
    [".git", "package.json", "src/cli.ts", "AGENTS.md", "CLAUDE.md", ".claude/CLAUDE.md"].every(
      (marker) => exists(resolve(path, marker)),
    )
  );
}
