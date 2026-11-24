import { execFileSync } from "node:child_process";

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

export type GitChange =
  | { kind: "added"; path: string }
  | { kind: "modified"; path: string }
  | { kind: "deleted"; path: string }
  | { kind: "renamed"; from: string; path: string };

export interface GitCommandPort {
  run(args: readonly string[]): Uint8Array;
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

export function resolveCommit(git: GitCommandPort, ref: string): string {
  validateCommitRef(ref);
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

export function validateCommitRef(ref: string): void {
  if (!ref || ref.includes("\0") || ref.includes("\n") || ref.includes("\r")) {
    throw new GitDiffAdapterError(
      "git-ref-invalid",
      "git ref is empty or contains a control separator",
    );
  }
}

export function parseNameStatusEntries(fields: readonly string[]): GitChange[] {
  const changes: GitChange[] = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    if (!status) throw new GitDiffAdapterError("git-diff-malformed", "missing diff status");
    if (/^R\d{1,3}$/.test(status)) {
      const from = requirePath(fields[index++]);
      const path = requirePath(fields[index++]);
      changes.push({ kind: "renamed", from, path });
      continue;
    }
    if (status !== "A" && status !== "M" && status !== "D") {
      throw new GitDiffAdapterError("git-status-unknown", `unsupported git diff status: ${status}`);
    }
    const path = requirePath(fields[index++]);
    changes.push({
      kind: status === "A" ? "added" : status === "M" ? "modified" : "deleted",
      path,
    });
  }
  return changes;
}

/** @internal Shared with the PLAN-private blob reader to keep path validation single-sourced. */
export function requirePath(value: string | undefined): string {
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

export function splitNul(bytes: Uint8Array): string[] {
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

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** @internal Shared with the PLAN-private blob reader; the fatal decoder stays private. */
export function decodeUtf8(bytes: Uint8Array): string {
  return UTF8.decode(bytes);
}
