/**
 * G3-trace lint (requirements_v1.2 §1.10.H / A-47 + A-48 ledger).
 * L1 → L3 → AC → AT の双方向 trace 整合を機械検証 (孤児 = 0)。
 * pmo-sonnet 手動 matrix (A-47) の機械強制化、PO 指摘「機能一覧やドメインチェックのテストが走るべき」反映。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

// 注: 抽出ロジックは各 extractor 内の inline regex (表行・見出しアンカー付きで厳密) を使う。
// 旧 module 級 regex 定数 (FR_L1_REGEX 等) は陳腐化のため削除 (PLAN-L7-05、未使用 dead code)。

interface DocSource {
  l1Functional: string;
  l3Functional: string;
  l3BusinessDetail: string;
  l3NfrGrade: string;
  l12AcceptanceTest: string;
}

// A-120 I-5: repoRoot 注入可 (default = ROOT で挙動保存)。
export function loadDocs(repoRoot: string = ROOT): DocSource {
  return {
    l1Functional: readFileSync(
      resolve(repoRoot, "docs/design/harness/L1-requirements/functional-requirements.md"),
      "utf-8",
    ),
    l3Functional: readFileSync(
      resolve(repoRoot, "docs/design/harness/L3-functional/functional-requirements.md"),
      "utf-8",
    ),
    l3BusinessDetail: readFileSync(
      resolve(repoRoot, "docs/design/harness/L3-functional/business-detail.md"),
      "utf-8",
    ),
    l3NfrGrade: readFileSync(
      resolve(repoRoot, "docs/design/harness/L3-functional/nfr-grade.md"),
      "utf-8",
    ),
    l12AcceptanceTest: readFileSync(
      resolve(repoRoot, "docs/test-design/harness/L3-acceptance-test-design.md"),
      "utf-8",
    ),
  };
}

/** §1 表内の FR-L1 ID 全件を抽出 (L1 functional sub-doc) */
export function extractFrL1Ids(l1Functional: string): Set<string> {
  const matches = new Set<string>();
  // §1 機能一覧表のみ対象 (§1.1 翻案注記の重複参照を含むため、表行 | **FR-L1-NN** | で限定)
  for (const m of l1Functional.matchAll(/\|\s*\*\*FR-L1-(\d+)\*\*\s*\|/g)) {
    matches.add(`FR-L1-${m[1].padStart(2, "0")}`);
  }
  return matches;
}

/** L3 functional sub-doc から FR-NN 見出し全件を抽出 */
export function extractL3FrIds(l3Functional: string): Set<string> {
  const matches = new Set<string>();
  for (const m of l3Functional.matchAll(/^### FR-(\d{2}):/gm)) {
    matches.add(`FR-${m[1]}`);
  }
  // FR-45 (BR-08 派生、A-49 で FR-19 → FR-45 リネーム) も上記正規表現で抽出される
  return matches;
}

/** L3 functional + business-detail + nfr-grade から AC-* 全件を抽出 */
export function extractAcIds(
  l3Functional: string,
  l3BusinessDetail: string,
  l3NfrGrade: string,
): Set<string> {
  const matches = new Set<string>();
  // L3 functional: AC-FR-NN-NN
  for (const m of l3Functional.matchAll(/####\s+AC-FR-(\d{2})-(\d{2})\b/g)) {
    matches.add(`AC-FR-${m[1]}-${m[2]}`);
  }
  // L3 business-detail: AC-FR-BR21-NN
  for (const m of l3BusinessDetail.matchAll(/####\s+AC-FR-BR21-(\d{2})/g)) {
    matches.add(`AC-FR-BR21-${m[1]}`);
  }
  // L3 functional §3.2 UX-01 補完
  for (const m of l3Functional.matchAll(/####\s+AC-UX-(\d{2})-(\d{2})/g)) {
    matches.add(`AC-UX-${m[1]}-${m[2]}`);
  }
  // L3 nfr-grade: AC-NFR-* (A-54 audit 軸4 C-04: NFR 由来 AC を孤児検出対象に追加)
  for (const m of l3NfrGrade.matchAll(/####\s+AC-NFR-([A-Z0-9-]+)/g)) {
    matches.add(`AC-NFR-${m[1]}`);
  }
  return matches;
}

/** L12 受入テストから AT-* ID 全件を抽出 */
export function extractAtIds(l12: string): Set<string> {
  const matches = new Set<string>();
  for (const m of l12.matchAll(/\|\s*\*\*AT-([A-Z0-9-]+)\*\*\s*\|/g)) {
    matches.add(`AT-${m[1]}`);
  }
  return matches;
}

/** L1 NFR (NFR-01〜16、欠番 NFR-09/10) を抽出 */
export function extractL1NfrIds(): Set<string> {
  // L1 nfr.md は確定済 15 件 (NFR-09/10 欠番、NFR-17 統合セキュリティ A-54 追加)
  const ids = new Set<string>();
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 16, 17]) {
    ids.add(`NFR-${n.toString().padStart(2, "0")}`);
  }
  return ids;
}

/** L3 nfr-grade から NFR-NN + NFR-DNN を抽出 */
export function extractL3NfrIds(l3Nfr: string): Set<string> {
  const matches = new Set<string>();
  for (const m of l3Nfr.matchAll(/\|\s*\*\*NFR-(\d{2}|D\d{2})\*\*\s*\|/g)) {
    matches.add(`NFR-${m[1]}`);
  }
  return matches;
}

/** L3 carry 宣言 §3 / §3.1 で FR-L1-* を carry 先として明示宣言された ID */
export function extractL3CarryFrL1Ids(l3Functional: string): Set<string> {
  const matches = new Set<string>();
  // §3 表内 + §3.1 P1 carry 明示 note 内の FR-L1-NN を抽出
  // FR-L1-19 / FR-L1-20 / FR-L1-21〜35 / FR-L1-23〜30 / FR-L1-31/32/37/39/42/44 等
  for (const m of l3Functional.matchAll(/FR-L1-(\d+)(?:[〜～](\d+))?/g)) {
    const start = parseInt(m[1], 10);
    const end = m[2] ? parseInt(m[2], 10) : start;
    for (let n = start; n <= end; n++) {
      matches.add(`FR-L1-${n.toString().padStart(2, "0")}`);
    }
  }
  return matches;
}

export interface G3TraceResult {
  orphanFrL1: string[];
  orphanL3Fr: string[];
  orphanAc: string[];
  orphanAt: string[];
  orphanNfr: string[];
  totals: {
    frL1: number;
    l3Fr: number;
    ac: number;
    at: number;
    l1Nfr: number;
    l3Nfr: number;
  };
}

export function g3TraceOk(result: G3TraceResult): boolean {
  return (
    result.orphanFrL1.length === 0 &&
    result.orphanL3Fr.length === 0 &&
    result.orphanAc.length === 0 &&
    result.orphanAt.length === 0 &&
    result.orphanNfr.length === 0
  );
}

export function g3TraceMessages(result: G3TraceResult): string[] {
  if (g3TraceOk(result)) {
    return [
      `g3-trace - OK (frL1=${result.totals.frL1}, l3Fr=${result.totals.l3Fr}, ac=${result.totals.ac}, at=${result.totals.at}, l1Nfr=${result.totals.l1Nfr}, l3Nfr=${result.totals.l3Nfr})`,
    ];
  }
  const orphanGroups: [string, string[]][] = [
    ["orphanFrL1", result.orphanFrL1],
    ["orphanL3Fr", result.orphanL3Fr],
    ["orphanAc", result.orphanAc],
    ["orphanAt", result.orphanAt],
    ["orphanNfr", result.orphanNfr],
  ];
  const parts = orphanGroups
    .filter(([, ids]) => ids.length > 0)
    .map(([kind, ids]) => `${kind}=${ids.slice(0, 8).join(",")}${ids.length > 8 ? ",..." : ""}`);
  return [`g3-trace - violation: ${parts.join("; ")}`];
}

export function analyzeG3Trace(docs?: DocSource): G3TraceResult {
  const d = docs ?? loadDocs();

  const frL1 = extractFrL1Ids(d.l1Functional);
  const l3Fr = extractL3FrIds(d.l3Functional);
  const ac = extractAcIds(d.l3Functional, d.l3BusinessDetail, d.l3NfrGrade);
  const at = extractAtIds(d.l12AcceptanceTest);
  const l1Nfr = extractL1NfrIds();
  const l3Nfr = extractL3NfrIds(d.l3NfrGrade);
  const carryFrL1 = extractL3CarryFrL1Ids(d.l3Functional);

  // R1: 全 FR-L1-NN が L3 FR-* に直接対応 OR carry 宣言で被覆
  // L1 FR-L1-NN の数字 NN と L3 FR-NN の数字 NN は P0 で 1:1 対応 (FR-L1-01 ↔ FR-01)
  const orphanFrL1: string[] = [];
  for (const id of frL1) {
    const num = id.replace("FR-L1-", "");
    const l3CorrespondingFr = `FR-${num}`;
    if (l3Fr.has(l3CorrespondingFr)) continue;
    if (carryFrL1.has(id)) continue;
    orphanFrL1.push(id);
  }

  // R2: 全 L3 FR-* に AC が最低 1 件存在
  const orphanL3Fr: string[] = [];
  for (const fr of l3Fr) {
    const num = fr.replace("FR-", "");
    const acExists = [...ac].some((a) => a.startsWith(`AC-FR-${num}-`));
    if (!acExists) orphanL3Fr.push(fr);
  }

  // R3: 全 AC が AT で被覆 (AT-FR-NN-NN または AT-FR-BR21-NN または AT-UX-NN-NN)
  const orphanAc: string[] = [];
  for (const acId of ac) {
    // AC-FR-NN-NN → AT-FR-NN-NN
    // AC-FR-BR21-NN → AT-FR-BR21-NN または AT-BR21-NN
    // AC-UX-NN-NN → AT-UX-NN
    const acSuffix = acId.replace("AC-", "");
    const candidateAts = [
      `AT-${acSuffix}`, // 直接対応
      `AT-${acSuffix.replace(/-\d{2}$/, "")}`, // suffix 削除版
    ];
    const matched = candidateAts.some((cand) => [...at].some((atId) => atId.startsWith(cand)));
    if (!matched) orphanAc.push(acId);
  }

  // R3-rev: functional FR 由来の AT-FR-NN-MM は対応 AC-FR-NN-MM を必須とする
  // (A-54 audit 軸4 C-03: AT-FR-09-04 が AC 不在のまま pass していた逆引き孤児を機械検出)
  // 他 family (AT-FR-BR21 / AT-UX / AT-NFR / AT-NFR-MIGRATION) は AC 構造が疎のため対象外
  const orphanAt: string[] = [];
  for (const atId of at) {
    const m = atId.match(/^AT-FR-(\d{2})-(\d{2})$/);
    if (m && !ac.has(`AC-FR-${m[1]}-${m[2]}`)) orphanAt.push(atId);
  }

  // R4: L1 NFR (15 件) が L3 nfr-grade で全件被覆
  const orphanNfr: string[] = [];
  for (const nfr of l1Nfr) {
    if (!l3Nfr.has(nfr)) orphanNfr.push(nfr);
  }

  return {
    orphanFrL1,
    orphanL3Fr,
    orphanAc,
    orphanAt,
    orphanNfr,
    totals: {
      frL1: frL1.size,
      l3Fr: l3Fr.size,
      ac: ac.size,
      at: at.size,
      l1Nfr: l1Nfr.size,
      l3Nfr: l3Nfr.size,
    },
  };
}
