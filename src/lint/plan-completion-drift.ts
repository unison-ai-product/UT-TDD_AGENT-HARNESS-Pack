/**
 * plan-completion-drift lint — 「DoD/完了条件チェックリストを全消化したのに status が非終端
 * (draft/in_progress) のまま」放置される完了 bookkeeping drift を機械検出する (hard、doctor.ok 連動)。
 * PLAN-L7-93。
 *
 * 動機 (PO 指摘 2026-06-22): PLAN-RECOVERY-02 (V-model 正規式 recovery) は Phase 1-3 完了 +
 * gated downstream (L1 / L3 PLAN) が全 confirmed + 機械 trace green = freeze-ready だったのに、
 * recovery PLAN 自身の status だけが draft に取り残され、毎 session 「PO 判断待ちの未了」として
 * 再報告される false-state を生んでいた (= 「そもそも通過してないとおかしい段階」「ただの記載ミス /
 * 運用ミス」)。完了作業の status 前進忘れ ([[feedback_verify_carry_status_against_code]]) が
 * 機械で surface されず、人手照合でしか発見できなかった。
 *
 * 既存 plan-dod gate は逆方向 (status=confirmed/completed なのに DoD 未チェック → violation) で、
 * かつ L7-* 限定。本 gate はその欠けた半身 = 「DoD 完了 ⇒ status 非終端」を **全 layer の PLAN** に
 * 対し fail-close し、DoD↔status の双方向整合を閉じる。
 *
 * 検出規則: DoD/完了条件 (Definition of Done) 節を持つ非 archived PLAN で、節内のチェックリストが
 * **1 件以上ありかつ全て `- [x]` (未チェック `- [ ]` がゼロ)** なのに status が終端
 * (confirmed/completed/accepted) でない → 「DoD 完了なのに status 非終端」violation。
 *   - DoD が部分チェック (`- [ ]` 残あり) の PLAN は真に作業中なので violation にしない (DISCOVERY-03
 *     のような S2/S3/S4 未消化の WIP は素通りさせる = false positive を出さない)。
 *   - DoD 節が無い / チェックリスト項目ゼロの PLAN も対象外 ([[plan-body-substance]] / plan-dod が
 *     別観点で扱う。本 gate は「checklist が完了シグナルを出している」場合だけに限定し過剰検出を避ける)。
 * これにより「DoD を消化したら status を前進 (または明示 blocker を記録) せよ」を機械強制する。
 *
 * prose の「freeze-ready」等を真偽判定しない (= [[feedback_coverage_not_substance]] の false-confidence
 * 回避)。シグナルは構造化された checklist 消化状態のみ。
 *
 * 純関数 (analyzePlanCompletionDrift + dodChecklistState) + I/O loader (loadPlanCompletionDriftInput)
 * を分離 (lint 共通様式)。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadReviewPlans } from "./review-evidence";

/** status がこれなら終端 = DoD 完了でも drift でない。これ以外で DoD 全消化 = status 前進忘れ。 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["confirmed", "completed", "accepted"]);

export interface PlanCompletionRow {
  planId: string;
  status: string;
  /** DoD/完了条件 節のチェック済み項目数 (`- [x]`)。節やチェックリストが無ければ 0。 */
  checkedItems: number;
  /** DoD/完了条件 節の未チェック項目数 (`- [ ]`)。1 以上なら作業中とみなす。 */
  uncheckedItems: number;
}

export interface PlanCompletionDriftResult {
  violations: { planId: string; status: string; checkedItems: number }[];
  ok: boolean;
}

/**
 * DoD/完了条件 (Definition of Done) 節のチェックリスト消化状態を数える純関数。
 * 節 = `## ... DoD|Definition of Done|完了条件` 見出し以降、次の `## ` 見出しまで。
 * plan-dod と同一の節検出規則を使い、checked / unchecked を独立にカウントする。
 */
export function dodChecklistState(content: string): { checked: number; unchecked: number } {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) =>
    /^##\s+.*(?:DoD|Definition of Done|完了条件)/i.test(line),
  );
  if (start < 0) return { checked: 0, unchecked: 0 };
  const next = lines.findIndex((line, index) => index > start && /^##\s+/.test(line));
  const end = next < 0 ? lines.length : next;
  let checked = 0;
  let unchecked = 0;
  for (let index = start + 1; index < end; index += 1) {
    if (/^\s*-\s*\[[xX]\]\s+/.test(lines[index])) checked += 1;
    else if (/^\s*-\s*\[ \]\s+/.test(lines[index])) unchecked += 1;
  }
  return { checked, unchecked };
}

/**
 * DoD を全消化 (checked≥1 かつ unchecked=0) なのに status が非終端の PLAN を violation として返す。
 */
export function analyzePlanCompletionDrift(plans: PlanCompletionRow[]): PlanCompletionDriftResult {
  const violations = plans
    .filter(
      (p) =>
        p.checkedItems > 0 &&
        p.uncheckedItems === 0 &&
        !TERMINAL_STATUSES.has(p.status.toLowerCase()),
    )
    .map((p) => ({ planId: p.planId, status: p.status, checkedItems: p.checkedItems }))
    .sort((a, b) => a.planId.localeCompare(b.planId));
  return { violations, ok: violations.length === 0 };
}

export function loadPlanCompletionDriftInput(repoRoot: string): PlanCompletionRow[] {
  let reviewPlans: ReturnType<typeof loadReviewPlans>;
  try {
    reviewPlans = loadReviewPlans(repoRoot);
  } catch {
    return []; // docs/plans 不在は空 (fail-open、他 lint と同方針)
  }
  const plansDir = join(repoRoot, "docs", "plans");
  const rows: PlanCompletionRow[] = [];
  for (const rp of reviewPlans) {
    if (rp.status === "archived") continue;
    let content = "";
    try {
      content = readFileSync(join(plansDir, rp.file), "utf8");
    } catch {
      continue;
    }
    const { checked, unchecked } = dodChecklistState(content);
    rows.push({
      planId: rp.plan_id,
      status: rp.status,
      checkedItems: checked,
      uncheckedItems: unchecked,
    });
  }
  return rows;
}

export function planCompletionDriftMessages(r: PlanCompletionDriftResult): string[] {
  if (r.ok) {
    return [
      "plan-completion-drift — OK (DoD 全消化済の PLAN は全て status 終端、完了 bookkeeping drift 無し)",
    ];
  }
  return r.violations.map(
    (v) =>
      `plan-completion-drift - violation: PLAN ${v.planId} は DoD を全消化 (${v.checkedItems}件 checked / 未チェック 0) なのに status=${v.status} (非終端) → status を前進 (confirmed/completed) させるか、未了項目を DoD に明示せよ`,
  );
}
