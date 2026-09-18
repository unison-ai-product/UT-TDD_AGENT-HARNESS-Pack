import { execFileSync } from "node:child_process";
import type { AdmissionChangesPort, AdmissionComparison } from "./admission-check.ts";
import type { PlanBlob, PlanChange } from "./diff-fence.ts";

const PLAN_PATH = /^docs\/plans\/PLAN-[A-Za-z0-9-]+\.md$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export type GitDiffAdapterErrorCode =
  | "git-command-failed"
  | "git-ref-invalid"
  | "git-diff-malformed"
  | "git-status-unknown"
  | "git-path-invalid"
  | "git-blob-missing"
  | "git-blob-invalid-utf8";

export class GitDiffAdapterError extends Error {
  readonly code: GitDiffAdapterErrorCode;
  readonly path?: string;

  constructor(code: GitDiffAdapterErrorCode, message: string, path?: string) {
    super(message);
    this.code = code;
    this.path = path;
    this.name = "GitDiffAdapterError";
  }
}

export interface GitCommandPort {
  run(args: readonly string[]): Uint8Array;
}

export interface AdmissionGitDiff {
  baseCommit: string;
  headCommit: string;
  base: readonly PlanBlob[];
  head: readonly PlanBlob[];
  changes: readonly PlanChange[];
}

export class SystemGitCommandPort implements GitCommandPort {
  private readonly repoRoot: string;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
  }

  run(args: readonly string[]): Uint8Array {
    try {
      return execFileSync("git", ["-C", this.repoRoot, ...args], {
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new GitDiffAdapterError("git-command-failed", `git command failed: ${detail}`);
    }
  }
}

export function readAdmissionGitDiff(input: {
  baseRef: string;
  headRef: string;
  git: GitCommandPort;
}): AdmissionGitDiff {
  const baseCommit = resolveCommit(input.git, input.baseRef);
  const headCommit = resolveCommit(input.git, input.headRef);
  const fields = splitNul(
    input.git.run([
      "diff",
      "--name-status",
      "-z",
      "--find-renames",
      baseCommit,
      headCommit,
      "--",
      "docs/plans",
    ]),
  );
  const changes = parseNameStatus(fields);
  const basePaths = new Set<string>();
  const headPaths = new Set<string>();

  for (const change of changes) {
    if (change.kind === "added") headPaths.add(change.path);
    if (change.kind === "modified") {
      basePaths.add(change.path);
      headPaths.add(change.path);
    }
    if (change.kind === "deleted") basePaths.add(change.path);
    if (change.kind === "renamed") {
      basePaths.add(change.from);
      headPaths.add(change.path);
    }
  }

  return {
    baseCommit,
    headCommit,
    base: readBlobs(input.git, baseCommit, basePaths),
    head: readBlobs(input.git, headCommit, headPaths),
    changes,
  };
}

export class GitAdmissionChangesAdapter implements AdmissionChangesPort {
  private readonly git: GitCommandPort;

  constructor(git: GitCommandPort) {
    this.git = git;
  }

  compare(baseRef: string, headRef: string): AdmissionComparison {
    const comparison = readAdmissionGitDiff({ baseRef, headRef, git: this.git });
    return { ...comparison, baseComplete: true, headComplete: true };
  }
}

export function readUtf8BlobAtRef(git: GitCommandPort, ref: string, path: string): string {
  const canonicalPath = requirePath(path);
  const commit = resolveCommit(git, ref);
  try {
    return decodeUtf8(git.run(["show", `${commit}:${canonicalPath}`]));
  } catch (error) {
    if (error instanceof GitDiffAdapterError && error.code === "git-command-failed") {
      throw new GitDiffAdapterError(
        "git-blob-missing",
        `required git blob is missing: ${canonicalPath}`,
        canonicalPath,
      );
    }
    if (error instanceof TypeError) {
      throw new GitDiffAdapterError(
        "git-blob-invalid-utf8",
        `git blob is not valid UTF-8: ${canonicalPath}`,
        canonicalPath,
      );
    }
    throw error;
  }
}

function resolveCommit(git: GitCommandPort, ref: string): string {
  if (!ref || ref.includes("\0") || ref.includes("\n") || ref.includes("\r")) {
    throw new GitDiffAdapterError(
      "git-ref-invalid",
      "git ref is empty or contains a control separator",
    );
  }
  let output: string;
  try {
    output = decodeUtf8(
      git.run(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]),
    ).trim();
  } catch (error) {
    if (error instanceof GitDiffAdapterError && error.code !== "git-command-failed") throw error;
    throw new GitDiffAdapterError("git-ref-invalid", `cannot resolve commit ref: ${ref}`);
  }
  if (!/^[0-9a-f]{40,64}$/i.test(output)) {
    throw new GitDiffAdapterError(
      "git-ref-invalid",
      `git ref did not resolve to one commit: ${ref}`,
    );
  }
  return output;
}

function parseNameStatus(fields: readonly string[]): PlanChange[] {
  const changes: PlanChange[] = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    if (!status) throw new GitDiffAdapterError("git-diff-malformed", "missing diff status");
    if (/^R\d{1,3}$/.test(status)) {
      const from = requirePath(fields[index++]);
      const path = requirePath(fields[index++]);
      const fromIsPlan = PLAN_PATH.test(from);
      const pathIsPlan = PLAN_PATH.test(path);
      if (fromIsPlan && pathIsPlan) changes.push({ kind: "renamed", from, path });
      else if (fromIsPlan) changes.push({ kind: "deleted", path: from });
      else if (pathIsPlan) changes.push({ kind: "added", path });
      continue;
    }
    if (status !== "A" && status !== "M" && status !== "D") {
      throw new GitDiffAdapterError("git-status-unknown", `unsupported git diff status: ${status}`);
    }
    const path = requirePath(fields[index++]);
    if (!PLAN_PATH.test(path)) continue;
    changes.push({
      kind: status === "A" ? "added" : status === "M" ? "modified" : "deleted",
      path,
    });
  }
  return changes;
}

function requirePath(value: string | undefined): string {
  if (value === undefined)
    throw new GitDiffAdapterError("git-diff-malformed", "diff status has no path");
  if (
    !value ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new GitDiffAdapterError(
      "git-path-invalid",
      `non-canonical git path: ${JSON.stringify(value)}`,
      value,
    );
  }
  return value;
}

function readBlobs(git: GitCommandPort, commit: string, paths: ReadonlySet<string>): PlanBlob[] {
  return [...paths].sort().map((path) => {
    let bytes: Uint8Array;
    try {
      bytes = git.run(["show", `${commit}:${path}`]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new GitDiffAdapterError(
        "git-blob-missing",
        `required git blob is missing: ${path} (${detail})`,
        path,
      );
    }
    try {
      return { path, content: decodeUtf8(bytes) };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new GitDiffAdapterError(
        "git-blob-invalid-utf8",
        `git blob is not valid UTF-8: ${path} (${detail})`,
        path,
      );
    }
  });
}

function splitNul(bytes: Uint8Array): string[] {
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== 0)
    throw new GitDiffAdapterError("git-diff-malformed", "NUL diff output is not terminated");
  const fields: string[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    try {
      fields.push(decodeUtf8(bytes.subarray(start, index)));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new GitDiffAdapterError(
        "git-diff-malformed",
        `diff path/status is not valid UTF-8 (${detail})`,
      );
    }
    start = index + 1;
  }
  return fields;
}

function decodeUtf8(bytes: Uint8Array): string {
  return UTF8.decode(bytes);
}
