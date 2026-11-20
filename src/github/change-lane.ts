// PLAN-L7-455 (troubleshoot): GitHub CI 高速化 Phase 1 — 変更ファイル分類 (doc-only lane 判定)。
//
// 設計 (docs/plans/PLAN-L7-455-ci-cost-speedup-phase1.md §設計判断記録・FLAG 是正記録):
// - 「code を 1 ファイルでも含む → full」「保守的 allowlist のみ → doc lane」。判定不能・
//   新種 path は fail-close で full へフォールバックする。
// - doc-safe allowlist は非正本の参照 prose 4 tree
//   (`docs/archive|migration|reference|research/**.md`) のみに限定する。正本設計・governance・
//   runtime規則・共有memoryはfullへfail-closeする。
// - diff range を解決できない (force-push / 新規ブランチ / 未対応 event 等) 場合も full。
//
// 純粋関数 (classifyChangeLane / resolveChangeDiffRange) と副作用 (git diff 実行) を分離し、
// git 呼び出しは `GitDiffNamesPort` 経由の DI にしてテスト容易性を確保する。

import { execFileSync } from "node:child_process";
import { type ChangeLaneClassification, classifyChangeLane } from "../shared/change-lane.ts";

export {
  type ChangeLane,
  type ChangeLaneClassification,
  classifyChangeLane,
  DOC_LANE_PREFIXES,
  isDocSafeChangePath,
} from "../shared/change-lane.ts";

const NULL_SHA = "0000000000000000000000000000000000000000";

export interface ChangeDiffRangeInput {
  eventName: string;
  headSha: string;
  baseSha?: string;
  beforeSha?: string;
}

export interface ChangeDiffRangeResult {
  range: string | null;
  reason: string;
}

/**
 * GitHub Actions event context から git diff range を解決する純粋関数。
 * 解決不能 (未対応 event / 欠落 SHA / force-push で before が null SHA) は
 * `range: null` を返し、呼び出し側で fail-close (full lane) させる。
 */
export function resolveChangeDiffRange(input: ChangeDiffRangeInput): ChangeDiffRangeResult {
  const headSha = input.headSha?.trim();
  if (!headSha) return { range: null, reason: "missing-head-sha" };
  if (input.eventName === "pull_request") {
    const baseSha = input.baseSha?.trim();
    if (!baseSha) return { range: null, reason: "missing-base-sha" };
    return { range: `${baseSha}...${headSha}`, reason: "pull_request-base-diff" };
  }
  if (input.eventName === "push") {
    const beforeSha = input.beforeSha?.trim();
    if (!beforeSha || beforeSha === NULL_SHA) {
      return { range: null, reason: "push-without-resolvable-before (force-push/new-branch)" };
    }
    return { range: `${beforeSha}...${headSha}`, reason: "push-before-diff" };
  }
  return { range: null, reason: `unsupported-event:${input.eventName}` };
}

/** git diff の名前一覧を取得する副作用ポート (テストでは fake 実装を注入する)。 */
export interface GitDiffNamesPort {
  diffNames(range: string): string[];
}

export class SystemGitDiffNamesPort implements GitDiffNamesPort {
  private readonly repoRoot: string;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
  }

  diffNames(range: string): string[] {
    const output = execFileSync("git", ["-C", this.repoRoot, "diff", "--name-only", range], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return output.split(/\r?\n/).filter(Boolean);
  }
}

export interface RunChangeLaneClassificationInput extends ChangeDiffRangeInput {
  git: GitDiffNamesPort;
}

export interface ChangeLaneClassificationResult extends ChangeLaneClassification {
  range: string | null;
  rangeReason: string;
}

/** diff range 解決 + git diff 実行 + 分類を束ねるオーケストレーション (fail-close)。 */
export function runChangeLaneClassification(
  input: RunChangeLaneClassificationInput,
): ChangeLaneClassificationResult {
  const { range, reason: rangeReason } = resolveChangeDiffRange(input);
  if (!range) {
    return {
      lane: "full",
      reason: `no-diff-range:${rangeReason} (fail-close)`,
      fileCount: 0,
      range,
      rangeReason,
    };
  }
  let files: string[];
  try {
    files = input.git.diffNames(range);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      lane: "full",
      reason: `diff-failed:${detail} (fail-close)`,
      fileCount: 0,
      range,
      rangeReason,
    };
  }
  const classification = classifyChangeLane(files);
  return { ...classification, range, rangeReason };
}
