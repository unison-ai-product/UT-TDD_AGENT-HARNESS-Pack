/**
 * FR registry audit lint (A-57 ledger).
 * 機能一覧 (L1 functional §1) の登録完全性・整合性を機械検証 = 漏れ監査の自動化。
 * Manual audit backfill from A-51/A-52/A-54 is enforced as lint.
 * PO 指摘「機能一覧の漏れ監査の自動化と登録の機構」反映。requirements §1.10.G.10。
 *
 * 漏れ 5 型 (doc 間 ID 整合で自動判定、外部 corpus 不要):
 *  1. 登録漏れ  : 他 doc (screen §5 / L3) で参照される FR-L1 が §1 table に未登録
 *  2. 欠番漏れ  : 連番の gap で carry/forward 宣言の無いもの
 *  3. 属性漏れ  : §1 行が必須 7 列を欠く / 重要度が P0|P1|P2 でない
 *  4. 件数整合  : §1 実数が header 宣言 (計 / P0 / P1 / P2) と不一致
 *  5. 画面被覆  : P0 FR-L1 に対応画面が無い (block 相当)
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

/** FR-L1-NN の素朴参照 (range 記法 〜 は展開しない、端点のみ拾う) */
const FR_L1_REF_REGEX = /\bFR-L1-(\d+)\b/g;
const VALID_PRIORITIES = new Set(["P0", "P1", "P2"]);

export interface FrDocSource {
  l1Functional: string;
  l3Functional: string;
  screen: string;
}

// A-120 I-5: repoRoot 注入可 (default = ROOT で挙動保存)。
export function loadFrDocs(repoRoot: string = ROOT): FrDocSource {
  return {
    l1Functional: readFileSync(
      resolve(repoRoot, "docs/design/harness/L1-requirements/functional-requirements.md"),
      "utf-8",
    ),
    l3Functional: readFileSync(
      resolve(repoRoot, "docs/design/harness/L3-functional/functional-requirements.md"),
      "utf-8",
    ),
    screen: readFileSync(
      resolve(repoRoot, "docs/design/harness/L1-requirements/screen-requirements.md"),
      "utf-8",
    ),
  };
}

export interface FrRow {
  id: string; // FR-L1-NN (NN zero-padded 2 桁、3 桁以上はそのまま)
  num: number;
  name: string;
  source: string;
  input: string;
  output: string;
  priority: string;
  screens: string;
  cellCount: number;
}

/** §1 機能一覧 table (§1.1 手前まで) の行を構造化抽出 */
export function parseFrRows(l1Functional: string): FrRow[] {
  const sec = l1Functional.match(/## §1 機能一覧[\s\S]*?(?=\n### §1\.1)/);
  if (!sec) return [];
  const rows: FrRow[] = [];
  for (const line of sec[0].split("\n")) {
    const idMatch = line.match(/^\|\s*\*\*FR-L1-(\d+)\*\*\s*\|/);
    if (!idMatch) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    const num = Number.parseInt(idMatch[1], 10);
    rows.push({
      id: `FR-L1-${idMatch[1].padStart(2, "0")}`,
      num,
      name: cells[1] ?? "",
      source: cells[2] ?? "",
      input: cells[3] ?? "",
      output: cells[4] ?? "",
      priority: cells[5] ?? "",
      screens: cells[6] ?? "",
      cellCount: cells.length,
    });
  }
  return rows;
}

/** 任意テキストから参照されている FR-L1 番号集合を抽出 */
export function extractReferencedFrL1Nums(text: string): Set<number> {
  const nums = new Set<number>();
  for (const m of text.matchAll(FR_L1_REF_REGEX)) {
    nums.add(Number.parseInt(m[1], 10));
  }
  return nums;
}

/**
 * carry/forward 宣言された「意図的に §1 未登録」の番号集合。
 * 例: header「FR-L1-36/38/43 は P2 のため L3 forward carry」→ {36,38,43}
 */
export function extractExplainedGapNums(l1Functional: string): Set<number> {
  const nums = new Set<number>();
  for (const m of l1Functional.matchAll(/FR-L1-([\d/]+)\s*は[^。\n]*?(?:carry|forward)/g)) {
    for (const part of m[1].split("/")) {
      const n = Number.parseInt(part, 10);
      if (!Number.isNaN(n)) nums.add(n);
    }
  }
  return nums;
}

/** header の件数確定宣言 (計 N / P0 / P1 / P2) を抽出 */
export interface DeclaredCounts {
  total: number | null;
  p0: number | null;
  p1: number | null;
  p2: number | null;
}

export function extractDeclaredCounts(l1Functional: string): DeclaredCounts {
  const totalMatch = l1Functional.match(/計\s*(\d+)\s*件/);
  const breakdownMatch = l1Functional.match(/P0:\s*(\d+)\s*\/\s*P1:\s*(\d+)\s*\/\s*P2:\s*(\d+)/);
  return {
    total: totalMatch ? Number.parseInt(totalMatch[1], 10) : null,
    p0: breakdownMatch ? Number.parseInt(breakdownMatch[1], 10) : null,
    p1: breakdownMatch ? Number.parseInt(breakdownMatch[2], 10) : null,
    p2: breakdownMatch ? Number.parseInt(breakdownMatch[3], 10) : null,
  };
}

export interface CountMismatch {
  field: "total" | "p0" | "p1" | "p2";
  declared: number;
  actual: number;
}

export interface AttributeOrphan {
  id: string;
  missing: string[];
}

export interface FrRegistryAuditResult {
  registered: string[];
  /** 1. 登録漏れ: 参照されるが §1 未登録 (carry 宣言済みを除く) */
  unregistered: string[];
  /** 2. 欠番漏れ: carry/forward 宣言の無い連番 gap */
  unexplainedGaps: number[];
  /** 3. 属性漏れ: 必須列欠落 / 不正な重要度 */
  attributeOrphans: AttributeOrphan[];
  /** 4. 件数整合: header 宣言との差分 */
  countMismatches: CountMismatch[];
  /** 5. 画面被覆: 対応画面の無い P0 FR-L1 */
  screenCoverageOrphans: string[];
  totals: { registered: number; p0: number; p1: number; p2: number };
}

export function analyzeFrRegistry(docs?: FrDocSource): FrRegistryAuditResult {
  const d = docs ?? loadFrDocs();
  const rows = parseFrRows(d.l1Functional);

  const registeredNums = new Set(rows.map((r) => r.num));
  const explained = extractExplainedGapNums(d.l1Functional);

  // 1. 登録漏れ: screen + L3 で参照される FR-L1 が §1 未登録 (carry 宣言済みは除外)
  const referenced = new Set<number>([
    ...extractReferencedFrL1Nums(d.screen),
    ...extractReferencedFrL1Nums(d.l3Functional),
  ]);
  const unregistered: string[] = [];
  for (const n of referenced) {
    if (registeredNums.has(n)) continue;
    if (explained.has(n)) continue;
    unregistered.push(`FR-L1-${n.toString().padStart(2, "0")}`);
  }
  unregistered.sort();

  // 2. 欠番漏れ: 1..max の gap で carry/forward 宣言の無いもの
  const maxNum = rows.reduce((acc, r) => Math.max(acc, r.num), 0);
  const unexplainedGaps: number[] = [];
  for (let n = 1; n <= maxNum; n++) {
    if (registeredNums.has(n)) continue;
    if (explained.has(n)) continue;
    unexplainedGaps.push(n);
  }

  // 3. 属性漏れ: 必須 7 列 + 重要度 enum
  const attributeOrphans: AttributeOrphan[] = [];
  for (const r of rows) {
    const missing: string[] = [];
    if (r.cellCount < 7) missing.push(`列数不足(${r.cellCount}/7)`);
    if (!r.name) missing.push("機能要求名");
    if (!r.source) missing.push("出典 doc");
    if (!r.input) missing.push("必要 input");
    if (!r.output) missing.push("出力 output");
    if (!VALID_PRIORITIES.has(r.priority)) missing.push(`重要度(${r.priority || "空"})`);
    if (!r.screens) missing.push("対応画面");
    if (missing.length > 0) attributeOrphans.push({ id: r.id, missing });
  }

  // 4. 件数整合: header 宣言 vs 実数
  const actualP0 = rows.filter((r) => r.priority === "P0").length;
  const actualP1 = rows.filter((r) => r.priority === "P1").length;
  const actualP2 = rows.filter((r) => r.priority === "P2").length;
  const declared = extractDeclaredCounts(d.l1Functional);
  const countMismatches: CountMismatch[] = [];
  if (declared.total !== null && declared.total !== rows.length) {
    countMismatches.push({ field: "total", declared: declared.total, actual: rows.length });
  }
  if (declared.p0 !== null && declared.p0 !== actualP0) {
    countMismatches.push({ field: "p0", declared: declared.p0, actual: actualP0 });
  }
  if (declared.p1 !== null && declared.p1 !== actualP1) {
    countMismatches.push({ field: "p1", declared: declared.p1, actual: actualP1 });
  }
  if (declared.p2 !== null && declared.p2 !== actualP2) {
    countMismatches.push({ field: "p2", declared: declared.p2, actual: actualP2 });
  }

  // 5. 画面被覆: P0 FR-L1 に対応画面が無い
  const screenCoverageOrphans = rows
    .filter((r) => r.priority === "P0" && !r.screens)
    .map((r) => r.id);

  return {
    registered: rows.map((r) => r.id),
    unregistered,
    unexplainedGaps,
    attributeOrphans,
    countMismatches,
    screenCoverageOrphans,
    totals: { registered: rows.length, p0: actualP0, p1: actualP1, p2: actualP2 },
  };
}
