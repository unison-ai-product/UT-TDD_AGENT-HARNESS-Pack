import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface BaselinePreviewFinding {
  path: string;
  kind: string;
  reason: string;
}

export interface BaselinePreviewGateResult {
  name: string;
  ok: boolean;
  findings: BaselinePreviewFinding[];
}

export interface BaselinePreview {
  mainSha: string;
  headSha: string;
  treeSha: string;
  commitSha: string;
  gates: BaselinePreviewGateResult[];
  cleanup?: "failed";
  cleanupReason?: string;
}

export interface PreviewGate {
  name: string;
  check: (repoRoot: string) => {
    ok: boolean;
    findings: readonly BaselinePreviewFinding[];
  };
}

export interface BaselinePreviewResult {
  preview: BaselinePreview | null;
  reason: string | null;
}

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function gitFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
  return message || "git_command_failed";
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function requireMergeTreeSupport(repoRoot: string): void {
  const version = git(repoRoot, ["--version"]).trim();
  const match = /^git version (\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error("git_version_unrecognized");
  const [, majorText, minorText] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  if (major < 2 || (major === 2 && minor < 38)) {
    throw new Error("merge_tree_write_tree_unsupported");
  }
}

class PreviewSetupError extends Error {
  readonly reason: "preview_parent_unresolved" | "preview_dir_create_failed";

  constructor(reason: "preview_parent_unresolved" | "preview_dir_create_failed", cause: unknown) {
    super(gitFailureReason(cause));
    this.reason = reason;
    this.name = "PreviewSetupError";
  }
}

function previewParent(repoRoot: string): string {
  try {
    const topLevel = git(repoRoot, ["rev-parse", "--show-toplevel"]).trim();
    if (!topLevel) throw new Error("repository_root_empty");
    const realRoot = realpathSync.native(topLevel);
    const parent = dirname(realRoot);
    if (parent === realRoot) throw new Error("repository_root_is_filesystem_root");
    return parent;
  } catch (error) {
    throw new PreviewSetupError("preview_parent_unresolved", error);
  }
}

function ownedPreviewPath(repoRoot: string, pr: number): string {
  const parent = previewParent(repoRoot);
  try {
    return mkdtempSync(join(parent, `ut-tdd-baseline-preview-${pr}-`));
  } catch (error) {
    throw new PreviewSetupError("preview_dir_create_failed", error);
  }
}

function isRegisteredWorktree(repoRoot: string, previewPath: string): boolean {
  const expected = resolve(previewPath).toLowerCase();
  return git(repoRoot, ["worktree", "list", "--porcelain"])
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .some((line) => resolve(line.slice("worktree ".length)).toLowerCase() === expected);
}

function normalizeFindings(value: unknown): BaselinePreviewFinding[] {
  if (!Array.isArray(value)) throw new Error("baseline_gate_findings_invalid");
  return value.map((finding) => {
    if (
      typeof finding !== "object" ||
      finding === null ||
      typeof (finding as BaselinePreviewFinding).path !== "string" ||
      typeof (finding as BaselinePreviewFinding).kind !== "string" ||
      typeof (finding as BaselinePreviewFinding).reason !== "string"
    ) {
      throw new Error("baseline_gate_finding_invalid");
    }
    const { path, kind, reason } = finding as BaselinePreviewFinding;
    return { path, kind, reason };
  });
}

function evaluatePreviewGates(
  previewPath: string,
  gates: readonly PreviewGate[],
  preview: BaselinePreview,
): string | null {
  let firstFindingReason: string | null = null;
  for (const gate of gates) {
    const checked = gate.check(previewPath);
    const findings = normalizeFindings(checked.findings);
    const ok = checked.ok === true && findings.length === 0;
    preview.gates.push({ name: gate.name, ok, findings });
    if (!ok && firstFindingReason === null) {
      const findingKind = findings[0]?.kind ?? "gate-check-failed";
      firstFindingReason = `baseline_conflict_recomputed:${gate.name}=${findingKind}`;
    }
  }
  return firstFindingReason;
}

function cleanupPreviewWorktree(
  repoRoot: string,
  previewPath: string,
  initiallyRegistered: boolean,
): string[] {
  const failures: string[] = [];
  let pathExists = false;
  let registered = initiallyRegistered;
  try {
    pathExists = existsSync(previewPath);
  } catch (error) {
    failures.push(`directory_inspect:${gitFailureReason(error)}`);
  }
  if (!registered && pathExists) {
    try {
      registered = isRegisteredWorktree(repoRoot, previewPath);
    } catch (error) {
      failures.push(`worktree_registration_check:${gitFailureReason(error)}`);
      // The add may have registered this exact path before failing.
      registered = true;
    }
  }
  try {
    git(repoRoot, ["worktree", "remove", "--force", previewPath]);
  } catch (error) {
    // A failed add can leave an owned directory that was never registered.
    // In that case remove reports the expected absence; directory removal
    // and prune still run below.
    if (registered) failures.push(`worktree_remove:${gitFailureReason(error)}`);
  }
  try {
    if (existsSync(previewPath)) rmSync(previewPath, { recursive: true, force: true });
  } catch (error) {
    failures.push(`directory_remove:${gitFailureReason(error)}`);
  }
  try {
    git(repoRoot, ["worktree", "prune"]);
  } catch (error) {
    failures.push(`worktree_prune:${gitFailureReason(error)}`);
  }
  return failures;
}

interface BaselinePreviewState {
  previewPath: string | null;
  registered: boolean;
  candidatePreview: BaselinePreview | null;
}

function calculateBaselinePreview(
  input: {
    repoRoot: string;
    pr: number;
    mainSha: string;
    headSha: string;
    gates: readonly PreviewGate[];
  },
  state: BaselinePreviewState,
): BaselinePreviewResult {
  try {
    requireMergeTreeSupport(input.repoRoot);
    let treeSha: string;
    try {
      const output = git(input.repoRoot, [
        "merge-tree",
        "--write-tree",
        input.mainSha,
        input.headSha,
      ]);
      treeSha = output.split(/\r?\n/)[0]?.trim() ?? "";
    } catch (error) {
      // merge-tree exits 1 for a content conflict. Path-level conflict reporting
      // remains owned by the caller, so no conflict is treated as a clean tree.
      if (errorStatus(error) === 1) {
        return { preview: null, reason: "merge_tree_content_conflict" };
      }
      throw error;
    }
    if (!/^[0-9a-f]{40,64}$/i.test(treeSha)) {
      throw new Error("merge_tree_output_invalid");
    }

    const commitSha = git(input.repoRoot, [
      "-c",
      "user.name=UT-TDD baseline preview",
      "-c",
      "user.email=ut-tdd-baseline-preview@example.invalid",
      "commit-tree",
      treeSha,
      "-p",
      input.mainSha,
      "-p",
      input.headSha,
      "-m",
      "UT-TDD baseline preview",
    ]).trim();
    if (!/^[0-9a-f]{40,64}$/i.test(commitSha)) {
      throw new Error("preview_commit_invalid");
    }

    const preview: BaselinePreview = {
      mainSha: input.mainSha,
      headSha: input.headSha,
      treeSha,
      commitSha,
      gates: [],
    };
    state.candidatePreview = preview;
    state.previewPath = ownedPreviewPath(input.repoRoot, input.pr);
    git(input.repoRoot, ["worktree", "add", "-q", "--detach", state.previewPath, commitSha]);
    state.registered = true;
    return { preview, reason: evaluatePreviewGates(state.previewPath, input.gates, preview) };
  } catch (error) {
    const reason =
      error instanceof PreviewSetupError
        ? `baseline_conflict_unknown:${error.reason}`
        : `baseline_conflict_unknown:${gitFailureReason(error)}`;
    return { preview: state.candidatePreview, reason };
  }
}

function cleanupBaselinePreview(
  repoRoot: string,
  state: BaselinePreviewState,
  result: BaselinePreviewResult,
): BaselinePreviewResult {
  if (state.previewPath === null) return result;

  const cleanupFailures = cleanupPreviewWorktree(repoRoot, state.previewPath, state.registered);
  if (cleanupFailures.length === 0) return result;

  const cleanupReason = cleanupFailures.join("; ");
  try {
    process.stderr.write(`baseline preview cleanup failed: ${cleanupReason}\n`);
  } catch {
    // Diagnostics must not change the already calculated gate decision.
  }
  if (result.preview === null) return result;
  return {
    ...result,
    preview: { ...result.preview, cleanup: "failed", cleanupReason },
  };
}

/** Recompute only the conflicting gates against a temporary merge tree. */
export function recomputeBaselinePreview(input: {
  repoRoot: string;
  pr: number;
  mainSha: string;
  headSha: string;
  gates: readonly PreviewGate[];
}): BaselinePreviewResult {
  const state: BaselinePreviewState = {
    previewPath: null,
    registered: false,
    candidatePreview: null,
  };
  let result: BaselinePreviewResult = { preview: null, reason: null };
  try {
    result = calculateBaselinePreview(input, state);
  } catch (error) {
    result = {
      preview: state.candidatePreview,
      reason: `baseline_conflict_unknown:${gitFailureReason(error)}`,
    };
  } finally {
    result = cleanupBaselinePreview(input.repoRoot, state, result);
  }
  return result;
}
