// 標準成果物 § 構造定義 (要件 §G.6.1): L4 report/batch/notification/code-value の design PLAN が
// IPA 共通フレーム外部設計の必須 § を h2 で持つことを fail-close 検証する。
import { describe, expect, it } from "vitest";
import {
  analyzeSubDocSectionStructure,
  extractPlanSections,
  loadSubDocSectionStructureInput,
  STANDARD_DELIVERABLE_SECTIONS,
  type SubDocSectionStructureInput,
  subDocSectionStructureMessages,
} from "../src/lint/sub-doc-section-structure";

function plan(subDoc: string, h2Names: string[], status = "confirmed") {
  return {
    planId: `PLAN-L4-XX-${subDoc}`,
    subDoc,
    status,
    h2: h2Names.map((n, i) => `## §${i + 1} ${n}`),
  };
}

function input(plans: SubDocSectionStructureInput["plans"]): SubDocSectionStructureInput {
  return { plans, requiredSections: STANDARD_DELIVERABLE_SECTIONS };
}

describe("analyzeSubDocSectionStructure (U-SDSS-001..006)", () => {
  it("U-SDSS-001: report が必須 § 全件を h2 で持てば ok", () => {
    const r = analyzeSubDocSectionStructure(
      input([plan("report", STANDARD_DELIVERABLE_SECTIONS.report)]),
    );
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(1);
  });

  it("U-SDSS-002: report が必須 § を 1 件欠くと violation (欠落名を報告)", () => {
    const r = analyzeSubDocSectionStructure(
      input([plan("report", ["帳票一覧", "レイアウト", "出力項目定義", "関連 doc"])]),
    );
    expect(r.ok).toBe(false);
    expect(r.violations[0].missing).toContain("出力条件・タイミング");
    expect(subDocSectionStructureMessages(r)[0]).toContain("G.6.1");
  });

  it("U-SDSS-003: 4 型すべてに必須 § 集合が定義されている", () => {
    expect(Object.keys(STANDARD_DELIVERABLE_SECTIONS).sort()).toEqual([
      "batch",
      "code-value",
      "notification",
      "report",
    ]);
    for (const sections of Object.values(STANDARD_DELIVERABLE_SECTIONS)) {
      expect(sections.length).toBeGreaterThanOrEqual(5);
      expect(sections).toContain("関連 doc");
    }
  });

  it("U-SDSS-004: 標準成果物でない sub_doc (function 等) は検査対象外 (checked=0)", () => {
    const r = analyzeSubDocSectionStructure(input([plan("function", ["機能一覧"])]));
    expect(r.checked).toBe(0);
    expect(r.ok).toBe(true);
  });

  it("U-SDSS-005: archived PLAN は検査対象外 (成果物整理後の false-positive 回避)", () => {
    const r = analyzeSubDocSectionStructure(input([plan("batch", ["バッチ一覧"], "archived")]));
    expect(r.checked).toBe(0);
    expect(r.ok).toBe(true);
  });

  it("U-SDSS-006: notification / code-value も同様に欠落検出", () => {
    const r = analyzeSubDocSectionStructure(
      input([
        plan("notification", STANDARD_DELIVERABLE_SECTIONS.notification),
        plan("code-value", ["コード体系"]),
      ]),
    );
    expect(r.ok).toBe(false);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].subDoc).toBe("code-value");
  });
});

describe("extractPlanSections (U-SDSS-007)", () => {
  it("U-SDSS-007: frontmatter を分離し body の h2 のみ抽出 (h3 除外)", () => {
    const md = [
      "---",
      "plan_id: PLAN-L4-50-report",
      "sub_doc: report",
      "status: confirmed",
      "---",
      "# 帳票設計",
      "## §1 帳票一覧",
      "### §1.1 明細",
      "## §2 レイアウト",
    ].join("\n");
    const { fm, h2 } = extractPlanSections(md);
    expect(fm.sub_doc).toBe("report");
    expect(h2).toEqual(["## §1 帳票一覧", "## §2 レイアウト"]);
  });
});

describe("loadSubDocSectionStructureInput real repo (U-SDSS-008)", () => {
  it("U-SDSS-008: 実 repo に標準成果物 PLAN は無い (subject 0) ゆえ ok (downstream 起票時に発火)", () => {
    const r = analyzeSubDocSectionStructure(loadSubDocSectionStructureInput(process.cwd()));
    expect(r.ok).toBe(true);
  });
});
