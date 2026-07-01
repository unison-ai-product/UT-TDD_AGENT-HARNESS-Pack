/**
 * Doc consistency lint test (A-58 ledger、4 つ目の lint)。
 * doc 間整合の自動化 = 手動 audit (A-51/52/54) の機械化。
 * PO 指摘「ドキュメント間の整合性チェックを自動化できるか」反映。
 */
import { describe, expect, it } from "vitest";
import {
  analyzeDocConsistency,
  checkCarryConsistency,
  checkNfrCount,
  checkScreenIdValidity,
  expandFrL1Refs,
  loadDocConsistencyDocs,
} from "../src/lint/doc-consistency";

describe("doc consistency (doc 間整合の自動化)", () => {
  const docs = loadDocConsistencyDocs();
  const result = analyzeDocConsistency(docs);

  it("expandFrL1Refs: slash リスト + range 記法を展開", () => {
    expect([...expandFrL1Refs("FR-L1-37/39/40")].sort((a, b) => a - b)).toEqual([37, 39, 40]);
    expect([...expandFrL1Refs("FR-L1-31〜35")].sort((a, b) => a - b)).toEqual([31, 32, 33, 34, 35]);
  });

  it("チェック1 carry 整合: §3 純 L4 carry 宣言 = 残 P1 9 件 が §3.1 詳細表に全件存在 (orphan = 0)", () => {
    const carry = checkCarryConsistency(docs.l3Functional);
    // 残 P1 L4 carry = FR-L1-21/22/28/37/39/40/41/42/44 = 9 件 (§3.1 line 724 と一致)
    expect(carry.required).toEqual([21, 22, 28, 37, 39, 40, 41, 42, 44]);
    expect(carry.orphans).toEqual([]);
  });

  it("チェック2 画面ID実在: functional §1 の対応画面 ID が screen で全件定義済 (orphan = 0)", () => {
    const screen = checkScreenIdValidity(docs.l1Functional, docs.screen);
    expect(screen.definedScreens.length).toBe(15); // PM 6 + HM 8 + GD 1 (PM-06 設計書ビューア)
    expect(screen.referenced.length).toBeGreaterThan(0);
    expect(screen.orphans).toEqual([]);
  });

  it("チェック3 NFR件数整合: nfr.md 宣言 15 件 = 実定義数 15 (mismatch なし)", () => {
    const nfr = checkNfrCount(docs.nfr);
    expect(nfr.declared).toBe(15);
    expect(nfr.actual).toBe(15);
    expect(nfr.mismatch).toBe(false);
  });

  it("統合結果: 全チェック orphan/mismatch = 0", () => {
    expect(result.carryOrphans).toEqual([]);
    expect(result.screenIdOrphans).toEqual([]);
    expect(result.nfrCount.mismatch).toBe(false);
    expect(result.definedScreenCount).toBe(15);
  });
});
