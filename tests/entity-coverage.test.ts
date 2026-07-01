/**
 * Entity coverage test (A-48 ledger).
 * L1 business §10.1 (主要 12 entity) + §10.1.1 (L3 由来 11 entity) の整合機械検証。
 * PO 指摘「ドメインチェックのテストが走るべき」反映の最小実装。
 */
import { describe, expect, it } from "vitest";
import {
  analyzeEntityCoverage,
  extractL3DerivedEntities,
  extractPrimaryEntities,
  loadBusiness,
} from "../src/lint/entity-coverage";

describe("Entity coverage (DDD entity 整合の機械検証)", () => {
  const business = loadBusiness();
  const result = analyzeEntityCoverage(business);

  it("§10.1 主要業務 entity 12 件 (plan/gate/artifact/pair/mode/drive/agent_slot/handover/sprint/phase/carry/trace)", () => {
    const primary = extractPrimaryEntities(business);
    expect(primary.length).toBe(12);
    expect(primary).toContain("plan");
    expect(primary).toContain("gate");
    expect(primary).toContain("artifact");
    expect(primary).toContain("pair");
    expect(primary).toContain("mode");
    expect(primary).toContain("drive");
    expect(primary).toContain("agent_slot");
    expect(primary).toContain("handover");
    expect(primary).toContain("sprint");
    expect(primary).toContain("phase");
    expect(primary).toContain("carry");
    expect(primary).toContain("trace");
  });

  it("§10.1.1 L3 由来 entity 11 件 (back-propagation: AC/AT/evaluation 系/ipa_grade/cutover_command/kpi_metric/derived_view)", () => {
    const derived = extractL3DerivedEntities(business);
    expect(derived.length).toBe(11);
    expect(derived).toContain("acceptance_criterion");
    expect(derived).toContain("acceptance_test");
    expect(derived).toContain("plan_evaluation");
    expect(derived).toContain("skill_evaluation");
    expect(derived).toContain("model_evaluation");
    expect(derived).toContain("poc_evaluation");
    expect(derived).toContain("ipa_grade");
    expect(derived).toContain("cutover_command");
    expect(derived).toContain("kpi_metric");
    expect(derived).toContain("evaluation_batch");
    expect(derived).toContain("derived_view");
  });

  it("entity 重複なし (12 + 11 = 23 件全件 unique)", () => {
    expect(result.duplicates).toEqual([]);
    expect(result.totalCount).toBe(23);
  });

  it("L3 由来 entity は主要 entity と別カテゴリ (anti-corruption layer 維持)", () => {
    const primary = new Set(result.primaryEntities);
    for (const d of result.l3DerivedEntities) {
      expect(primary.has(d)).toBe(false);
    }
  });
});
