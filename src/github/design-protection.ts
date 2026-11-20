import {
  type GitChange,
  type GitCommandPort,
  GitDiffAdapterError,
  parseNameStatusEntries,
  resolveCommit,
  splitNul,
  validateCommitRef,
} from "./git-diff.ts";

export const IMPLEMENTATION_PATH_PREFIXES = ["src/", "scripts/"] as const;
export const PROTECTED_PATH_PREFIXES = ["docs/design/", "docs/test-design/"] as const;

type Classification = "implementation" | "non-implementation";

interface DesignProtectionViolation {
  code:
    | "protected-modified"
    | "protected-deleted"
    | "protected-renamed"
    | "implementation-moved-out";
  path: string;
  from?: string;
}

export interface DesignProtectionResult {
  ok: boolean;
  classification: Classification | "unknown";
  implementationPaths: string[];
  violations: DesignProtectionViolation[];
  error?: { code: string; detail: string };
}

interface DesignProtectionPaths {
  implementation: readonly string[];
  protected: readonly string[];
}

export function readDesignProtectionChanges(
  git: GitCommandPort,
  baseRef: string,
  headRef: string,
): GitChange[] {
  validateCommitRef(baseRef);
  validateCommitRef(headRef);
  const baseCommit = resolveCommit(git, baseRef);
  const headCommit = resolveCommit(git, headRef);
  return parseNameStatusEntries(
    splitNul(git.run(["diff", "--name-status", "-z", "--find-renames", baseCommit, headCommit])),
  );
}

export function classifyPullRequestChanges(
  changes: readonly GitChange[],
  paths: DesignProtectionPaths = {
    implementation: IMPLEMENTATION_PATH_PREFIXES,
    protected: PROTECTED_PATH_PREFIXES,
  },
): Classification {
  return changes.some((change) =>
    pathsForChange(change).some((path) => hasPrefix(path, paths.implementation)),
  )
    ? "implementation"
    : "non-implementation";
}

export function checkDesignProtection(input: {
  baseRef: string;
  headRef: string;
  git: GitCommandPort;
  paths?: DesignProtectionPaths;
}): DesignProtectionResult {
  const paths = input.paths ?? {
    implementation: IMPLEMENTATION_PATH_PREFIXES,
    protected: PROTECTED_PATH_PREFIXES,
  };
  let changes: GitChange[];
  try {
    changes = readDesignProtectionChanges(input.git, input.baseRef, input.headRef);
  } catch (error) {
    if (!(error instanceof GitDiffAdapterError)) throw error;
    return {
      ok: false,
      classification: "unknown",
      implementationPaths: [],
      violations: [],
      error: { code: error.code, detail: error.message },
    };
  }

  const classification = classifyPullRequestChanges(changes, paths);
  const implementationPaths = [
    ...new Set(
      changes.flatMap(pathsForChange).filter((path) => hasPrefix(path, paths.implementation)),
    ),
  ]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 5);
  const violations: DesignProtectionViolation[] = [];

  if (classification === "implementation") {
    for (const change of changes) {
      if (change.kind === "renamed") {
        if (hasPrefix(change.from, paths.protected)) {
          violations.push({ code: "protected-renamed", from: change.from, path: change.path });
        } else if (
          hasPrefix(change.from, paths.implementation) &&
          !hasPrefix(change.path, paths.implementation)
        ) {
          violations.push({
            code: "implementation-moved-out",
            from: change.from,
            path: change.path,
          });
        }
      } else if (change.kind === "modified" && hasPrefix(change.path, paths.protected)) {
        violations.push({ code: "protected-modified", path: change.path });
      } else if (change.kind === "deleted" && hasPrefix(change.path, paths.protected)) {
        violations.push({ code: "protected-deleted", path: change.path });
      }
    }
  }

  violations.sort((left, right) => left.path.localeCompare(right.path));
  return {
    ok: violations.length === 0,
    classification,
    implementationPaths,
    violations,
  };
}

export function runDesignProtectionCommand(
  argv: readonly string[],
  deps: { git: GitCommandPort; write: (line: string) => void },
): number {
  let baseRef: string | undefined;
  let headRef: string | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--base") baseRef = argv[++index];
    else if (argument === "--head") headRef = argv[++index];
    else if (argument === "--json") json = true;
    else throw new Error(`unknown design-protection argument: ${argument}`);
  }
  if (baseRef === undefined || headRef === undefined)
    throw new Error("design-protection requires --base and --head");

  const result = checkDesignProtection({ baseRef, headRef, git: deps.git });
  if (json) {
    deps.write(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    deps.write("design-protection: PASS");
  } else {
    deps.write("design-protection: BLOCK");
    if (result.error) deps.write(`  [${result.error.code}] ${result.error.detail}`);
    for (const violation of result.violations) {
      deps.write(`  [${violation.code}] ${violation.path}`);
    }
    if (result.violations.length > 0) deps.write("  設計書の変更は別 PR に分割してください。");
  }
  return result.ok ? 0 : 1;
}

function pathsForChange(change: GitChange): string[] {
  return change.kind === "renamed" ? [change.from, change.path] : [change.path];
}

function hasPrefix(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path.startsWith(prefix));
}
