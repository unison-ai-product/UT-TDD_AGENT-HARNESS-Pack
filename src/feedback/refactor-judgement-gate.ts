import type { ReviewDispatchEntry } from "./review-dispatch.ts";

type ExecFileSync = typeof import("node:child_process").execFileSync;
type PlanChange =
  | { kind: "added"; path: string }
  | { kind: "modified"; path: string }
  | { kind: "deleted"; path: string }
  | { kind: "renamed"; from: string; path: string };

export interface RefactorJudgementGateDecision {
  target: boolean;
  ok: boolean;
  reasons: string[];
}

export function evaluateRefactorJudgementGate(
  _changes: readonly PlanChange[],
  _entries: readonly ReviewDispatchEntry[],
): RefactorJudgementGateDecision {
  return { target: false, ok: true, reasons: [] };
}

export function readPullRequestChanges(_pr: number, _runGh: ExecFileSync): PlanChange[] {
  return [];
}
