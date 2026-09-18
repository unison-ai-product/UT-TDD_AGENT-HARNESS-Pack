import { type Dirent, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { LintResult } from "../plan/lint.ts";

export interface RuntimeStateLocationFinding {
  kind: "misplaced" | "scan-error";
  path: string;
}

const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules"]);

function repoRelative(repoRoot: string, path: string): string {
  const value = relative(repoRoot, path).replaceAll("\\", "/");
  return value || ".";
}

export function findRuntimeStateLocationFindings(repoRoot: string): RuntimeStateLocationFinding[] {
  const findings: RuntimeStateLocationFinding[] = [];
  const pending = [{ path: repoRoot, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    let entries: Dirent[];
    try {
      entries = readdirSync(current.path, { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
    } catch {
      findings.push({ kind: "scan-error", path: repoRelative(repoRoot, current.path) });
      continue;
    }
    for (const entry of entries) {
      const child = join(current.path, entry.name);
      if (entry.name === ".ut-tdd") {
        if (current.depth > 0) {
          findings.push({ kind: "misplaced", path: repoRelative(repoRoot, child) });
        }
        continue;
      }
      if (EXCLUDED_DIRECTORIES.has(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
        continue;
      }
      pending.push({ path: child, depth: current.depth + 1 });
    }
  }
  return findings.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind.localeCompare(b.kind),
  );
}

export function checkRuntimeStateLocation(repoRoot: string): LintResult {
  const findings = findRuntimeStateLocationFindings(repoRoot);
  if (findings.length === 0) {
    return { ok: true, messages: ["runtime-state-location - OK (nested .ut-tdd=0)"] };
  }
  return {
    ok: false,
    messages: findings.map(
      (finding) => `runtime-state-location - violation: ${finding.kind}:${finding.path}`,
    ),
  };
}
