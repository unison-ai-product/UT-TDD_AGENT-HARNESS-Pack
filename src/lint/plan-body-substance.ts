/**
 * plan-body-substance lint — 「本文 0 行・成果物 declare のみの PLAN は無効」(concept AP-13) を
 * 機械強制する (hard、doctor.ok 連動)。PLAN-L7-92。
 *
 * 背景: PLAN は frontmatter (declare) だけでなく本文 (進め方/設計/根拠) を持つ実体であるべき
 * (concept §3.6 AP-13)。frontmatter + タイトルだけで本文が空の PLAN は「中身空っぽ」= declare-only
 * の hollow PLAN で、coverage (登録) はあるが substance (中身) が無い ([[plan-artifact-existence]]
 * の deliverable hollow / [[plan-supersession]] と同系の substance gate)。
 *
 * 検出規則: frontmatter を除いた本文に、**タイトル (先頭 h1) / 空行 / HTML コメントを除く実体行が
 * 1 行も無い** PLAN を violation とする。archived は対象外 (完了後の整理)。閾値は AP-13 の literal
 * bright-line (= 本文 0 行) ゆえ terse-but-real な PLAN を罰しない (実リポ最小 6 行 = blast radius 0)。
 *
 * 純関数 (analyze + countSubstantiveBodyLines) + I/O loader 分離 (lint 共通様式)。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadReviewPlans } from "./review-evidence";

export interface PlanBodyRow {
  planId: string;
  substantiveLines: number;
}

export interface PlanBodySubstanceResult {
  violations: { planId: string }[];
  ok: boolean;
}

/**
 * frontmatter を除いた本文の「実体行」数を数える純関数。
 * 実体行 = 空行でなく、HTML コメント行でなく、先頭 h1 タイトル (1 回のみ) でない行。
 * frontmatter が無ければ本文 = 全体 (missing_frontmatter は plan lint が別途検出)。
 */
export function countSubstantiveBodyLines(content: string): number {
  const fm = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  const body = fm ? content.slice(fm[0].length) : content;
  let titleSkipped = false;
  let count = 0;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith("<!--")) continue; // HTML コメント (剪定 breadcrumb / TODO placeholder 等)
    if (!titleSkipped && /^#\s/.test(line)) {
      titleSkipped = true; // 先頭 h1 タイトルは declare 相当 (本文ではない)
      continue;
    }
    count += 1;
  }
  return count;
}

/** 本文実体行 0 の PLAN を violation として返す (hollow PLAN = declare-only)。 */
export function analyzePlanBodySubstance(plans: PlanBodyRow[]): PlanBodySubstanceResult {
  const violations = plans
    .filter((p) => p.substantiveLines === 0)
    .map((p) => ({ planId: p.planId }))
    .sort((a, b) => a.planId.localeCompare(b.planId));
  return { violations, ok: violations.length === 0 };
}

export function loadPlanBodySubstanceInput(repoRoot: string): PlanBodyRow[] {
  let reviewPlans: ReturnType<typeof loadReviewPlans>;
  try {
    reviewPlans = loadReviewPlans(repoRoot);
  } catch {
    return []; // docs/plans 不在は空 (fail-open、他 lint と同方針)
  }
  const plansDir = join(repoRoot, "docs", "plans");
  const rows: PlanBodyRow[] = [];
  for (const rp of reviewPlans) {
    if (rp.status === "archived") continue;
    let content = "";
    try {
      content = readFileSync(join(plansDir, rp.file), "utf8");
    } catch {
      continue;
    }
    rows.push({ planId: rp.plan_id, substantiveLines: countSubstantiveBodyLines(content) });
  }
  return rows;
}

export function planBodySubstanceMessages(r: PlanBodySubstanceResult): string[] {
  if (r.ok) {
    return [
      "plan-body-substance — OK (全 PLAN が本文実体行を持つ、declare-only な hollow PLAN 無し)",
    ];
  }
  const ids = r.violations.map((v) => v.planId).join(", ");
  return [
    `plan-body-substance - violation: 本文が空 (declare-only) の hollow PLAN ${r.violations.length} 件 (${ids}): frontmatter + タイトルのみで本文が無い = AP-13 無効。進め方/設計/根拠を本文に書け`,
  ];
}
