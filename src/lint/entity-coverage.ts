/**
 * Entity coverage lint (A-48 ledger).
 * L1 business §10.1 主要 entity + §10.1.1 L3 由来 entity (back-propagation) の件数 / 名称整合を機械検証。
 * PO 指摘「機能一覧やドメインチェックのテストが走るべき」反映、ドメイン側の最小実装。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

export interface EntityCoverageResult {
  primaryEntities: string[]; // §10.1
  l3DerivedEntities: string[]; // §10.1.1
  totalCount: number;
  duplicates: string[];
}

// A-120 I-5: repoRoot 注入可 (default = __filename 由来 ROOT で挙動保存、test fixture 注入を許可)。
export function loadBusiness(repoRoot: string = ROOT): string {
  return readFileSync(
    resolve(repoRoot, "docs/design/harness/L1-requirements/business-requirements.md"),
    "utf-8",
  );
}

/** §10.1 主要業務 entity 一覧 表から entity 名抽出 (table 行 | **<name>** | ...) */
export function extractPrimaryEntities(business: string): string[] {
  // §10.1 〜 §10.1.1 範囲のみ抽出
  const sec = business.match(/### §10\.1 主要業務 entity 一覧[\s\S]*?(?=### §10\.1\.1)/);
  if (!sec) return [];
  const names: string[] = [];
  for (const m of sec[0].matchAll(/^\|\s*\*\*([a-z_]+)\*\*\s*\|/gm)) {
    names.push(m[1]);
  }
  return names;
}

/** §10.1.1 L3 由来 entity 表から entity 名抽出 */
export function extractL3DerivedEntities(business: string): string[] {
  const sec = business.match(/### §10\.1\.1 L3 由来 entity 追加[\s\S]*?(?=### §10\.2)/);
  if (!sec) return [];
  const names: string[] = [];
  // table 行 | **<name>** ... 形式、後続が括弧 (AC 等) or 直接パイプ両方 match
  for (const m of sec[0].matchAll(/^\|\s*\*\*([a-z_]+)\*\*/gm)) {
    names.push(m[1]);
  }
  return names;
}

export function analyzeEntityCoverage(business?: string): EntityCoverageResult {
  const src = business ?? loadBusiness();
  const primary = extractPrimaryEntities(src);
  const derived = extractL3DerivedEntities(src);
  const all = [...primary, ...derived];
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const name of all) {
    if (seen.has(name)) duplicates.push(name);
    seen.add(name);
  }
  return {
    primaryEntities: primary,
    l3DerivedEntities: derived,
    totalCount: all.length,
    duplicates,
  };
}
