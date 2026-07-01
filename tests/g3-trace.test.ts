/**
 * G3-trace lint test (A-48 ledger).
 * L1 → L3 → AC → AT の双方向 trace 整合を機械検証 (孤児 = 0)。
 * PO 指摘「機能一覧やドメインチェックのテストが走るべき」反映の最小実装。
 */
import { describe, expect, it } from "vitest";
import {
  analyzeG3Trace,
  extractAcIds,
  extractAtIds,
  extractFrL1Ids,
  extractL1NfrIds,
  extractL3FrIds,
  extractL3NfrIds,
  loadDocs,
} from "../src/lint/g3-trace";

describe("G3-trace coverage (機能一覧 + ドメイン整合の機械検証)", () => {
  const docs = loadDocs();
  const result = analyzeG3Trace(docs);

  it("L1 FR-L1 51 件全件抽出される (P0:19 + P1:24 + P2:8、FR-L1-51 artifact progress 追加 PLAN-L7-56/REVERSE-56)", () => {
    const frL1 = extractFrL1Ids(docs.l1Functional);
    // L1 表で確定済の件数 (50 + FR-L1-51 artifact progress color projection = 51 件、PLAN-L7-56/REVERSE-56)
    expect(frL1.size).toBe(51);
    expect(frL1.has("FR-L1-45")).toBe(true);
    expect(frL1.has("FR-L1-49")).toBe(true);
    expect(frL1.has("FR-L1-50")).toBe(true);
    expect(frL1.has("FR-L1-43")).toBe(true);
    expect(frL1.has("FR-L1-38")).toBe(true);
  });

  it("L3 FR-* (P0 18 + FR-45 + workflow core FR-23/24/25/26/27/29/30 = 26 件) 全件抽出", () => {
    const l3Fr = extractL3FrIds(docs.l3Functional);
    expect(l3Fr.size).toBeGreaterThanOrEqual(26);
    expect(l3Fr.has("FR-45")).toBe(true);
    expect(l3Fr.has("FR-23")).toBe(true);
    expect(l3Fr.has("FR-30")).toBe(true);
  });

  it("L3 AC-* (FR × 3 + workflow core 21 + BR-21 + UX-01 + AC-NFR-* = 100+ 件) 全件抽出", () => {
    const ac = extractAcIds(docs.l3Functional, docs.l3BusinessDetail, docs.l3NfrGrade);
    // 実測 111 件 = AC-FR 79 (FR-09-04 含む) + AC-FR-BR21 12 + AC-UX-01 1 + AC-NFR-* 19 (A-54)
    expect(ac.size).toBeGreaterThanOrEqual(110);
  });

  it("L12 AT-* 全件抽出 (Phase A 即実装 + carry placeholder、A-54 で実数 117 件に再カウント)", () => {
    const at = extractAtIds(docs.l12AcceptanceTest);
    // 実測 117 件 = AT-FR 79 + AT-BR21/FR-BR21 15 + AT-UX 1 + AT-NFR 22
    expect(at.size).toBeGreaterThanOrEqual(116);
  });

  it("L1 NFR 15 件 (NFR-09/10 欠番、NFR-17 統合セキュリティ A-54 追加) が正しく定義", () => {
    const l1Nfr = extractL1NfrIds();
    expect(l1Nfr.size).toBe(15);
    expect(l1Nfr.has("NFR-09")).toBe(false);
    expect(l1Nfr.has("NFR-10")).toBe(false);
    expect(l1Nfr.has("NFR-17")).toBe(true);
  });

  it("L3 nfr-grade で L1 NFR 14 件全件被覆 (orphan NFR = 0)", () => {
    const l3Nfr = extractL3NfrIds(docs.l3NfrGrade);
    // NFR-D01 / NFR-D04 (A-47 補完) も含むため 14 + 2+ = 16+ 件
    expect(l3Nfr.size).toBeGreaterThanOrEqual(14);
    expect(result.orphanNfr).toEqual([]);
  });

  it("R1: L1 FR-L1 全件が L3 FR or L3 carry で被覆 (orphan = 0)", () => {
    // P0 18 件 → L3 FR-01〜18 直接 / P1+P2 23 件 → carry §3 + §3.1 明示
    expect(result.orphanFrL1).toEqual([]);
  });

  it("R2: 全 L3 FR-* に AC 最低 1 件 (orphan = 0)", () => {
    expect(result.orphanL3Fr).toEqual([]);
  });

  it("R3: 全 AC が AT で被覆 (orphan = 0、Phase B carry placeholder 含む)", () => {
    expect(result.orphanAc).toEqual([]);
  });

  it("R3-rev: 全 AT-FR-NN-MM が対応 AC を持つ (逆引き孤児 = 0、A-54: AT-FR-09-04 解消)", () => {
    expect(result.orphanAt).toEqual([]);
  });

  it("件数サマリ (G3 readiness v4 整合確認、FR-L1 51 / NFR 15)", () => {
    expect(result.totals.frL1).toBe(51);
    expect(result.totals.l3Fr).toBeGreaterThanOrEqual(26);
    expect(result.totals.ac).toBeGreaterThanOrEqual(110);
    expect(result.totals.l1Nfr).toBe(15);
  });
});
