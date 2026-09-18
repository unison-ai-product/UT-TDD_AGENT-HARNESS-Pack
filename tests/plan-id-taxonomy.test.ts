import { describe, expect, it } from "vitest";
import { planIdTaxonomyViolations } from "../src/plan/lint.ts";

/**
 * 規定外起票ブロックゲート (plan_id taxonomy)。
 *
 * 背景: 2026-07-15、既存 PLAN-M-00/M-01 (cutover/migration 専用) から
 * 「M = master program」と外挿した規定外 plan_id (PLAN-M-02) が lint を素通りして
 * 起票された。ID 語彙への無断の意味追加 (taxonomy 汚染) を機械で fail-close する。
 *
 * 許可 prefix (実在 766 PLAN から抽出した閉じた語彙):
 *   PLAN-L<0..14>-<n>-<slug> / PLAN-REVERSE-<n>-<slug>
 *   PLAN-DISCOVERY-<n>-<slug> / PLAN-RECOVERY-<n>-<slug>
 *   PLAN-M-* は凍結 legacy 2 件のみ (新規追加は violation)。
 */
describe("planIdTaxonomyViolations", () => {
  const validPlanIds = [
    "PLAN-L0-01-vmodel-harness-upgrade-charter",
    "PLAN-L1-08-design-harness-internalization",
    "PLAN-L14-01-engine-swap-operational-value-verification",
    "PLAN-L2-00-master",
    "PLAN-REVERSE-434-universal-pr-trigger-backfill",
    "PLAN-DISCOVERY-01-workflow-metamodel",
    "PLAN-RECOVERY-09-hub-reference-removal",
    "PLAN-M-00-verify-cutover",
    "PLAN-M-01-cutover-backfill",
  ];

  it.each(validPlanIds)("accepts registered taxonomy: %s", (planId) => {
    expect(planIdTaxonomyViolations(planId)).toEqual([]);
  });

  const invalidPlanIds = [
    "PLAN-M-02-design-harness-internalization",
    "PLAN-M-03-anything",
    "PLAN-X-01-something",
    "PLAN-MASTER-01-program",
    "PLAN-UPDATE-01-refresh",
    "PLAN-01-legacy-style",
    "PLAN-L15-01-beyond-vmodel",
    "PLAN-L99-01-nope",
    "PLAN-L7-1-one-digit-ordinal",
    "PLAN-L6-82",
    "PLAN-L6-82-UPPER-Case",
  ];

  it.each(invalidPlanIds)("rejects unregistered taxonomy: %s", (planId) => {
    const violations = planIdTaxonomyViolations(planId);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.reason).toBe("plan_id_taxonomy");
  });
});
