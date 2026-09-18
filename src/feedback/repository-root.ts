import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function gitToplevel(candidate: string): string | null {
  try {
    const output = execFileSync("git", ["-C", candidate, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const value = String(output).trim();
    return value ? resolve(value) : null;
  } catch {
    return null;
  }
}

function hasGitMarker(candidate: string): boolean {
  let current = resolve(candidate);
  for (;;) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** Resolve review custody to Git's toplevel; retain non-Git fixture roots. */
export function resolveRepositoryRoot(candidate: string): string {
  const root = resolve(candidate);
  const toplevel = gitToplevel(root);
  if (toplevel) return toplevel;
  if (hasGitMarker(root)) throw new Error("review_repository_root_unresolvable");
  return root;
}
