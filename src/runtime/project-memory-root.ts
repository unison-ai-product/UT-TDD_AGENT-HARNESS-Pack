import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  loadProjectIdentityFromHead,
  PROJECT_IDENTITY_COMMIT_RECOVERY_COMMANDS,
} from "../kernel/project-identity.ts";
import { memoryStorageRoot } from "../memory/index.ts";

export type ProjectMemoryRootDenyReason =
  | "git_topology_unavailable"
  | "project_identity_unavailable"
  | "project_identity_drift"
  | "canonical_root_invalid"
  | "authored_memory_root_escape"
  | "runtime_root_escape";

export type ProjectMemoryRootResult =
  | {
      readonly ok: true;
      readonly projectId: string;
      readonly projectNamespace: string;
      readonly currentWorktreeRoot: string;
      readonly canonicalProjectRoot: string;
      readonly gitCommonDir: string;
      readonly authoredMemoryRoot: string;
      readonly runtimeBusRoot: string;
    }
  | { readonly ok: false; readonly reason: ProjectMemoryRootDenyReason };

export interface ProjectMemoryRootPorts {
  readonly gitTopLevel: (repoRoot: string) => string;
  readonly gitCommonDir: (repoRoot: string) => string;
  readonly realpath: (path: string) => string;
  readonly isDirectory: (path: string) => boolean;
  readonly isSafeDescendant: (root: string, candidate: string) => boolean;
  readonly projectIdentity: (repoRoot: string) => string | null;
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function projectNamespace(projectId: string): string {
  return createHash("sha256").update(`ut-tdd-project\0${projectId}`, "utf8").digest("hex");
}

/** Existing directory links are rejected before a transient path is created. */
function isSafeDirectoryChain(root: string, candidate: string): boolean {
  if (!contained(root, candidate)) return false;
  let resolvedRoot: string;
  try {
    resolvedRoot = realpathSync(root);
  } catch {
    return false;
  }
  const rel = relative(resolve(root), resolve(candidate));
  let cursor = resolvedRoot;
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) continue;
    try {
      const stat = lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      if (!contained(resolvedRoot, realpathSync(cursor))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Resolve the single authored corpus and project-namespaced transient bus. */
export function resolveProjectMemoryRootWithPorts(
  repoRoot: string,
  ports: ProjectMemoryRootPorts,
): ProjectMemoryRootResult {
  let currentWorktreeRoot: string;
  let gitCommonDir: string;
  try {
    currentWorktreeRoot = ports.realpath(ports.gitTopLevel(repoRoot));
    gitCommonDir = ports.realpath(ports.gitCommonDir(repoRoot));
  } catch {
    return { ok: false, reason: "git_topology_unavailable" };
  }
  if (!ports.isDirectory(currentWorktreeRoot) || !ports.isDirectory(gitCommonDir)) {
    return { ok: false, reason: "git_topology_unavailable" };
  }
  if (basename(gitCommonDir).toLowerCase() !== ".git") {
    return { ok: false, reason: "canonical_root_invalid" };
  }

  const canonicalProjectRoot = ports.realpath(dirname(gitCommonDir));
  if (!ports.isDirectory(canonicalProjectRoot)) {
    return { ok: false, reason: "canonical_root_invalid" };
  }
  const currentProjectId = ports.projectIdentity(currentWorktreeRoot);
  const canonicalProjectId = ports.projectIdentity(canonicalProjectRoot);
  if (!currentProjectId || !canonicalProjectId) {
    return { ok: false, reason: "project_identity_unavailable" };
  }
  if (currentProjectId !== canonicalProjectId) {
    return { ok: false, reason: "project_identity_drift" };
  }

  const authoredMemoryRoot = memoryStorageRoot(canonicalProjectRoot);
  if (!ports.isSafeDescendant(canonicalProjectRoot, authoredMemoryRoot)) {
    return { ok: false, reason: "authored_memory_root_escape" };
  }
  const projectNamespace = projectNamespaceFor(currentProjectId);
  const runtimeBase = join(gitCommonDir, "ut-tdd-runtime", "projects");
  const runtimeBusRoot = join(runtimeBase, projectNamespace);
  if (
    !contained(gitCommonDir, runtimeBase) ||
    !contained(runtimeBase, runtimeBusRoot) ||
    !ports.isSafeDescendant(gitCommonDir, runtimeBusRoot)
  ) {
    return { ok: false, reason: "runtime_root_escape" };
  }
  return {
    ok: true,
    projectId: currentProjectId,
    projectNamespace,
    currentWorktreeRoot,
    canonicalProjectRoot,
    gitCommonDir,
    authoredMemoryRoot,
    runtimeBusRoot,
  };
}

function projectNamespaceFor(projectId: string): string {
  return projectNamespace(projectId);
}

function gitPath(repoRoot: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function resolveProjectMemoryRoot(repoRoot: string): ProjectMemoryRootResult {
  return resolveProjectMemoryRootWithPorts(repoRoot, {
    gitTopLevel: (root) => gitPath(root, ["rev-parse", "--show-toplevel"]),
    gitCommonDir: (root) =>
      gitPath(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    realpath: (path) => realpathSync(path),
    isDirectory: (path) => {
      try {
        const stat = lstatSync(path);
        return stat.isDirectory() && !stat.isSymbolicLink();
      } catch {
        return false;
      }
    },
    isSafeDescendant: isSafeDirectoryChain,
    projectIdentity: projectIdentityFromHead,
  });
}

/**
 * A linked worktree's git-dir (`.git/worktrees/<name>`) always resolves to a different absolute
 * path than its git-common-dir (the shared `.git`). A plain checkout, a bare-clone-less snapshot
 * clone, or a tree with no git topology at all report the same path for both (or throw), so this
 * predicate only fires true for the genuine linked-worktree case (P-MEMCUT-006).
 */
export function isLinkedWorktreeCheckout(repoRoot: string): boolean {
  try {
    const gitDir = realpathSync(
      gitPath(repoRoot, ["rev-parse", "--path-format=absolute", "--git-dir"]),
    );
    const commonDir = realpathSync(
      gitPath(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    );
    return gitDir !== commonDir;
  } catch {
    return false;
  }
}

export function requireProjectMemoryRoot(
  repoRoot: string,
): Extract<ProjectMemoryRootResult, { ok: true }> {
  const result = resolveProjectMemoryRoot(repoRoot);
  if (!result.ok) {
    const message = `project_memory_root_${result.reason}`;
    if (result.reason === "project_identity_unavailable") {
      throw new Error(
        [
          message,
          ...PROJECT_IDENTITY_COMMIT_RECOVERY_COMMANDS.map((command) => `recovery: ${command}`),
        ].join("\n"),
      );
    }
    throw new Error(message);
  }
  return result;
}

function projectIdentityFromHead(repoRoot: string): string | null {
  const loaded = loadProjectIdentityFromHead({ repoRoot });
  return loaded.ok ? loaded.value.repositoryIdentity : null;
}
