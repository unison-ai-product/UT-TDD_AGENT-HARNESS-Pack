/**
 * baseline を持つ gate の並行 PR 競合を merge 前に止める (Issue #1423)。
 * 契約: docs/design/harness/L6-function-design/merge-gate-check-run-selection.md §6。
 * 純粋関数 `evaluateBaselineConflict` と、git を読む adapter `checkBaselineConflict` に分ける。
 */
import { execFileSync } from "node:child_process";
import { CODE_SIZE_BASELINE_PATH, classifyCodeFile } from "../lint/code-size.ts";
import { checkCodeSize } from "../lint/code-size-inputs.ts";
import { classifyDoc } from "../lint/doc-split.ts";
import { checkDocSplit, DOC_SPLIT_BASELINE_PATH } from "../lint/doc-split-inputs.ts";
import {
  type BaselinePreview,
  type BaselinePreviewFinding,
  type PreviewGate,
  recomputeBaselinePreview,
} from "./baseline-preview.ts";

export interface BaselineGate {
  name: string;
  inScope: (path: string) => boolean;
  baselinePath: string;
  check?: (repoRoot: string) => {
    ok: boolean;
    findings: readonly BaselinePreviewFinding[];
  };
}

export const BASELINE_GATES: readonly Required<BaselineGate>[] = [
  {
    name: "doc-split",
    inScope: (path) => classifyDoc(path) !== null,
    baselinePath: DOC_SPLIT_BASELINE_PATH,
    check: checkDocSplit,
  },
  {
    name: "code-size",
    inScope: (path) => classifyCodeFile(path) !== null,
    baselinePath: CODE_SIZE_BASELINE_PATH,
    check: checkCodeSize,
  },
];

export interface BaselineConflict {
  gate: string;
  paths: string[];
}

/** §6.2: 共通 path、または baseline の変更と相手側の対象変更の組を競合とする。 */
export function evaluateBaselineConflict(
  prChanged: readonly string[],
  mainChanged: readonly string[],
  gates: readonly BaselineGate[] = BASELINE_GATES,
): { conflicts: BaselineConflict[] } {
  const conflicts: BaselineConflict[] = [];
  for (const gate of gates) {
    const inGate = (path: string): boolean => path === gate.baselinePath || gate.inScope(path);
    const p = prChanged.filter(inGate);
    const m = mainChanged.filter(inGate);
    const paths = new Set(p.filter((path) => m.includes(path)));
    if (p.includes(gate.baselinePath) && m.length > 0) for (const path of m) paths.add(path);
    if (m.includes(gate.baselinePath) && p.length > 0) for (const path of p) paths.add(path);
    if (paths.size > 0) conflicts.push({ gate: gate.name, paths: [...paths].sort() });
  }
  return { conflicts };
}

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export interface BaselineConflictCheckResult {
  reason: string | null;
  preview: BaselinePreview | null;
}

export interface BaselineConflictOptions {
  gates?: readonly BaselineGate[];
  pr?: number;
}

function conflictReason(conflicts: readonly BaselineConflict[]): string {
  return `baseline_conflict:${conflicts.map((c) => `${c.gate}=${c.paths.join("|")}`).join(";")}`;
}

/** `git diff -M --name-status -z` の出力から、rename の旧 path と新 path を含む path 一覧を得る。 */
function changedPaths(repoRoot: string, from: string, to: string): string[] {
  const tokens = execFileSync(
    "git",
    ["-C", repoRoot, "diff", "-M", "--name-status", "-z", from, to],
    {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
    .split("\0")
    .filter((token) => token !== "");
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    const count = /^[RC]/.test(tokens[i]) ? 2 : 1;
    paths.push(...tokens.slice(i + 1, i + 1 + count));
    i += 1 + count;
  }
  return paths;
}

/**
 * deny の reason を返す。競合なしは null。
 * git の起動・fetch・merge-base・diff の失敗はすべて `baseline_conflict_unknown` で返す (L6 §6.2。競合なしにしない)。
 */
export function checkBaselineConflict(
  repoRoot: string,
  headSha: string,
  options: BaselineConflictOptions = {},
): string | null {
  return checkBaselineConflictWithPreview(repoRoot, headSha, options).reason;
}

/** Path-level conflicts are re-evaluated against the synthetic merge tree. */
export function checkBaselineConflictWithPreview(
  repoRoot: string,
  headSha: string,
  options: BaselineConflictOptions = {},
): BaselineConflictCheckResult {
  const { gates = BASELINE_GATES, pr = 0 } = options;
  try {
    git(repoRoot, ["fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
    const mainSha = git(repoRoot, ["rev-parse", "origin/main^{commit}"]);
    const mergeBase = git(repoRoot, ["merge-base", headSha, mainSha]);
    const { conflicts } = evaluateBaselineConflict(
      changedPaths(repoRoot, mergeBase, headSha),
      changedPaths(repoRoot, mergeBase, mainSha),
      gates,
    );
    if (conflicts.length === 0) return { reason: null, preview: null };

    const conflictingNames = new Set(conflicts.map((conflict) => conflict.gate));
    const previewGates: PreviewGate[] = [];
    for (const gate of gates) {
      if (!conflictingNames.has(gate.name)) continue;
      if (gate.check === undefined) {
        return { reason: "baseline_conflict_unknown:baseline_gate_check_missing", preview: null };
      }
      previewGates.push({ name: gate.name, check: gate.check });
    }
    const recomputed = recomputeBaselinePreview({
      repoRoot,
      pr,
      mainSha,
      headSha,
      gates: previewGates,
    });
    if (recomputed.reason === "merge_tree_content_conflict") {
      return { reason: conflictReason(conflicts), preview: null };
    }
    return { reason: recomputed.reason, preview: recomputed.preview };
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return { reason: `baseline_conflict_unknown:${message}`, preview: null };
  }
}
