/**
 * oracle 宣言 ⇔ 実テスト citation の突合 (IMP-128、PLAN-REVERSE-41 塊B、FR-L1-18 descent)。
 *
 * l6-fr-coverage は FR→oracle ID の接続のみで、その oracle に対応する**実テストが tests/ に
 * 実在するか**を見ない (coverage≠substance の穴、[[feedback_coverage_not_substance]])。本 lint は
 * test-design で宣言された oracle ID が tests/ 内に citation を持つことを検査する。
 *
 * forward-citation 規律: NEW oracle は tests に ID 明記必須 (未 citation = fail-close)。既存の
 * 未 citation 89 件は baseline (known-debt、縮小のみ可)。素朴 ID マッチは「テスト実在・ID 未記載」
 * を false-positive にする (2026-06-10 実測 89 件) ため、既存を baseline 化し NEW のみ gate する。
 *
 * 2026-08-05 検出範囲拡張 (issue #165 / PLAN-L7-480): 旧パターンは 3 桁番号 + `U|IT` 固定で
 * 2 桁番号・ST/P/M prefix・多 segment 名が丸ごと視野外だった。拡張で可視化された既存債務
 * 344 件は `ORACLE_TEST_TRACE_WIDENED_BASELINE` へ ratchet した (既存 89 とは別集合)。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ORACLE_ID_DUPLICATE_BASELINE } from "./oracle-id-duplicate-baseline.ts";
import { collectOracleCitationSites, type OracleCitationSite } from "./oracle-test-citation.ts";
import { ORACLE_TEST_CITATION_BASELINE } from "./oracle-test-citation-baseline.ts";
import { ORACLE_TEST_TRACE_BASELINE } from "./oracle-test-trace-baseline.ts";
import { ORACLE_TEST_TRACE_WIDENED_BASELINE } from "./oracle-test-trace-widened-baseline.ts";

export type { OracleCitationSite } from "./oracle-test-citation.ts";
export {
  collectOracleCitationSites,
  ORACLE_ID_DUPLICATE_BASELINE,
  ORACLE_TEST_CITATION_BASELINE,
  ORACLE_TEST_TRACE_BASELINE,
  ORACLE_TEST_TRACE_WIDENED_BASELINE,
};

/**
 * oracle ID パターン (`U-RELGRAPH-001` / `ST-DATA-01` / `U-RVGHA-D3C-001` 等)。
 *
 * prefix は U / IT / ST / P / M、番号は 2〜3 桁、名前部は `-` 区切りの多 segment を許す。
 * **token 境界は左右対称** (`(?<![A-Z0-9-])` / `(?![A-Z0-9-])`): 左が無いと `CANDIDATE-M-SP-002`
 * から `M-SP-002` を抜き出し (PLAN-L7-480 契約 1、main に該当 8 件が実在)、右が `\b` のままだと
 * `U-VTRIG-005-L7` から `U-VTRIG-005` を部分抽出する (blind review PR #263 Minor 1)。
 * `CANDIDATE-*` を一致させないのは仕様である — 未実装 oracle を宣言する正規表記であり、
 * citation を要求しない (docs/test-design/harness/L7-unit-test-design.md の CANDIDATE 節)。
 */
const ORACLE_ID = /(?<![A-Z0-9-])(?:U|IT|ST|P|M)-[A-Z0-9]+(?:-[A-Z0-9]+)*-[0-9]{2,3}(?![A-Z0-9-])/g;

export interface OracleTestTraceInput {
  /** test-design doc で宣言された oracle ID。 */
  declared: string[];
  /** tests/ 内で citation された oracle ID。 */
  referenced: Set<string>;
  /** known-debt allowlist (既存未 citation、2026-06-10 凍結の 89 件)。 */
  baseline: ReadonlySet<string>;
  /** 検出範囲拡張で可視化された既存債務 (2026-08-05 凍結の 344 件)。 */
  widenedBaseline: ReadonlySet<string>;
  /** test-design の宣言 provenance (ID / path / line / 説明)。 */
  declarationSites?: readonly OracleDeclarationSite[];
  /** 既存の ID→説明集合の ratchet。ID 単独の免除は許可しない。 */
  duplicateBaseline?: ReadonlySet<string>;
  /** test label の明示 citation provenance (fixture / 本文参照は含めない)。 */
  citationSites?: readonly OracleCitationSite[];
  /** 既存の未宣言 test-label citation。縮小のみ可。 */
  citationBaseline?: ReadonlySet<string>;
}

export interface OracleDeclarationSite {
  id: string;
  path: string;
  line: number;
  description: string;
}

/**
 * 既知の「候補/概要表 → confirmed/freeze 表」の構造的再掲だけを折り畳む。
 * 見出し名ではなく列スキーマで認識するため、見出しの改名で検出範囲が変わらない。
 */
type DeclarationMirror =
  | { kind: "it-case"; role: "summary" | "canonical" }
  | { kind: "resource-kernel"; role: "summary" | "canonical" };

interface RawOracleDeclarationSite extends OracleDeclarationSite {
  mirror: DeclarationMirror | null;
}

export interface OracleDuplicate {
  id: string;
  descriptions: string[];
  sites: OracleDeclarationSite[];
}

export interface OracleTestTraceResult {
  orphans: string[];
  duplicates: OracleDuplicate[];
  staleDuplicateBaseline: string[];
  undeclaredCitations: OracleCitationSite[];
  staleCitationBaseline: string[];
  ok: boolean;
}

/** 宣言済だが未 citation かつ両 baseline 外の oracle を orphan として返す。 */
export function analyzeOracleTestTrace(input: OracleTestTraceInput): OracleTestTraceResult {
  const orphans = [...new Set(input.declared)]
    .filter(
      (id) =>
        !input.referenced.has(id) && !input.baseline.has(id) && !input.widenedBaseline.has(id),
    )
    .sort();
  const { duplicates, staleDuplicateBaseline } = analyzeDeclarationUniqueness(
    input.declarationSites ?? [],
    input.duplicateBaseline ?? new Set(),
  );
  const citationDeclared = input.declarationSites?.map((site) => site.id) ?? input.declared;
  const { undeclaredCitations, staleCitationBaseline } = analyzeCitationTrace(
    citationDeclared,
    input.citationSites ?? [],
    input.citationBaseline ?? new Set(),
  );
  return {
    orphans,
    duplicates,
    staleDuplicateBaseline,
    undeclaredCitations,
    staleCitationBaseline,
    ok:
      orphans.length === 0 &&
      duplicates.length === 0 &&
      staleDuplicateBaseline.length === 0 &&
      undeclaredCitations.length === 0 &&
      staleCitationBaseline.length === 0,
  };
}

function analyzeCitationTrace(
  declared: readonly string[],
  sites: readonly OracleCitationSite[],
  baseline: ReadonlySet<string>,
): { undeclaredCitations: OracleCitationSite[]; staleCitationBaseline: string[] } {
  const declaredSet = new Set(declared);
  const observedUndeclared = new Set(
    sites.filter((site) => !declaredSet.has(site.id)).map((site) => site.id),
  );
  const undeclaredCitations = sites
    .filter((site) => observedUndeclared.has(site.id) && !baseline.has(site.id))
    .sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path) || a.line - b.line);
  const staleCitationBaseline = [...baseline].filter((id) => !observedUndeclared.has(id)).sort();
  return { undeclaredCitations, staleCitationBaseline };
}

const DUPLICATE_KEY_SEPARATOR = "\t";

function declarationKey(id: string, description: string): string {
  return `${id}${DUPLICATE_KEY_SEPARATOR}${description}`;
}

function analyzeDeclarationUniqueness(
  sites: readonly OracleDeclarationSite[],
  baseline: ReadonlySet<string>,
): { duplicates: OracleDuplicate[]; staleDuplicateBaseline: string[] } {
  const byId = new Map<string, Map<string, OracleDeclarationSite[]>>();
  for (const site of sites) {
    const description = normalizeDescription(site.description);
    const byDescription = byId.get(site.id) ?? new Map<string, OracleDeclarationSite[]>();
    const previous = byDescription.get(description) ?? [];
    byDescription.set(description, [...previous, { ...site, description }]);
    byId.set(site.id, byDescription);
  }

  const baselineById = new Map<string, Set<string>>();
  for (const key of baseline) {
    const separator = key.indexOf(DUPLICATE_KEY_SEPARATOR);
    if (separator <= 0) continue;
    const id = key.slice(0, separator);
    const description = key.slice(separator + DUPLICATE_KEY_SEPARATOR.length);
    const descriptions = baselineById.get(id) ?? new Set<string>();
    descriptions.add(description);
    baselineById.set(id, descriptions);
  }

  const duplicates: OracleDuplicate[] = [];
  for (const [id, descriptions] of byId) {
    const observed = new Set(descriptions.keys());
    const known = baselineById.get(id);
    const unexpected = known
      ? [...observed].filter((description) => !known.has(description))
      : [...observed];
    if (observed.size <= 1 || (known && unexpected.length === 0)) continue;
    const conflictDescriptions = [...observed].sort();
    duplicates.push({
      id,
      descriptions: conflictDescriptions,
      sites: conflictDescriptions.flatMap((description) => descriptions.get(description) ?? []),
    });
  }

  const observedKeys = new Set<string>();
  for (const [id, descriptions] of byId) {
    for (const description of descriptions.keys())
      observedKeys.add(declarationKey(id, description));
  }
  const staleDuplicateBaseline = [...baseline].filter((key) => !observedKeys.has(key)).sort();
  duplicates.sort((a, b) => a.id.localeCompare(b.id));
  return { duplicates, staleDuplicateBaseline };
}

function normalizeDescription(description: string): string {
  return description.replace(/\s+/g, " ").trim();
}

function oracleMatches(text: string): string[] {
  ORACLE_ID.lastIndex = 0;
  return [...text.matchAll(ORACLE_ID)].map((match) => match[0]);
}

function collectIds(dir: string, ext: string, acc: Set<string>): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) {
      collectIds(full, ext, acc);
    } else if (e.endsWith(ext)) {
      for (const id of oracleMatches(readFileSync(full, "utf8"))) acc.add(id);
    }
  }
}

function markdownCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function normalizedHeaderCells(headers: readonly string[]): string[] {
  return headers.map((header) =>
    header.replace(/`/g, "").replace(/\s+/g, " ").trim().toLowerCase(),
  );
}

function declarationMirror(headers: readonly string[]): DeclarationMirror | null {
  const normalized = normalizedHeaderCells(headers);
  const has = (value: string): boolean => normalized.some((header) => header === value);
  const hasContaining = (value: string): boolean =>
    normalized.some((header) => header.includes(value));

  // L8 candidate skeleton and §5 GWT table. The schema, not the heading, is the contract.
  if (
    hasContaining("it-id") &&
    (has("検証対象") || has("対象") || has("source contract")) &&
    (has("シナリオ") || has("scenario"))
  ) {
    return { kind: "it-case", role: "summary" };
  }
  if (has("it-id") && has("given") && has("when") && has("then")) {
    return { kind: "it-case", role: "canonical" };
  }

  // Resource Kernel overview and its freeze-attribute table.
  if (has("id") && has("boundary / fault injection") && has("expected")) {
    return { kind: "resource-kernel", role: "summary" };
  }
  if (
    has("id") &&
    has("lane") &&
    hasContaining("対象os") &&
    has("fixture") &&
    hasContaining("観測点") &&
    has("negative expected") &&
    hasContaining("created count")
  ) {
    return { kind: "resource-kernel", role: "canonical" };
  }
  return null;
}

function isMarkdownSeparatorRow(line: string): boolean {
  const cells = markdownCells(line);
  return cells !== null && cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

function collectDeclarationSitesFromFile(
  fullPath: string,
  relativePath: string,
): RawOracleDeclarationSite[] {
  const lines = readFileSync(fullPath, "utf8").split(/\r?\n/);
  const sites: RawOracleDeclarationSite[] = [];
  let tableHeaders: string[] | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^#{1,6}\s/u.test(line)) {
      tableHeaders = null;
      continue;
    }
    const cells = markdownCells(line);
    if (!cells) {
      tableHeaders = null;
      continue;
    }
    if (isMarkdownSeparatorRow(line)) continue;
    if (isMarkdownSeparatorRow(lines[index + 1] ?? "")) {
      tableHeaders = cells;
      continue;
    }
    const idCells = cells.flatMap((cell, cellIndex) => {
      const matches = oracleMatches(cell);
      const normalized = cell.replace(/`/g, "").trim();
      return matches.length === 1 && normalized === matches[0]
        ? [{ cellIndex, id: matches[0] }]
        : [];
    });
    if (idCells.length === 0) continue;
    const description = normalizeDescription(
      cells
        .filter((_, cellIndex) => !idCells.some((entry) => entry.cellIndex === cellIndex))
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(" | "),
    );
    for (const { id } of idCells) {
      sites.push({
        id,
        path: relativePath,
        line: index + 1,
        description,
        mirror: declarationMirror(tableHeaders ?? []),
      });
    }
  }
  return sites;
}

function selectCanonicalDeclarationSites(
  sites: readonly RawOracleDeclarationSite[],
): OracleDeclarationSite[] {
  const byIdAndPath = new Map<string, RawOracleDeclarationSite[]>();
  for (const site of sites) {
    const key = `${site.path}\t${site.id}`;
    const group = byIdAndPath.get(key) ?? [];
    group.push(site);
    byIdAndPath.set(key, group);
  }
  const selected: OracleDeclarationSite[] = [];
  for (const group of byIdAndPath.values()) {
    const canonicalMirrors = group.filter((site) => site.mirror?.role === "canonical");
    const summaryMirrors = group.filter((site) => site.mirror?.role === "summary");
    const mirrorKinds = new Set(group.flatMap((site) => (site.mirror ? [site.mirror.kind] : [])));
    const hasStructuralMirror =
      canonicalMirrors.length > 0 && summaryMirrors.length > 0 && mirrorKinds.size === 1;
    const retained =
      hasStructuralMirror && summaryMirrors.length === 1
        ? group.filter((site) => site.mirror?.role !== "summary")
        : group;
    selected.push(...retained.map(({ mirror: _mirror, ...site }) => site));
  }
  return selected;
}

/** test-design の宣言行だけを provenance 付きで収集する。family range / 本文再引用は除外する。 */
export function collectOracleDeclarationSites(repoRoot: string): OracleDeclarationSite[] {
  const sites: RawOracleDeclarationSite[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".md")) {
        const relativePath = full.slice(repoRoot.length + 1).replaceAll("\\", "/");
        sites.push(...collectDeclarationSitesFromFile(full, relativePath));
      }
    }
  };
  walk(join(repoRoot, "docs", "test-design"));
  return selectCanonicalDeclarationSites(sites);
}

/** 宣言 (test-design) と citation (tests) を規定パターンで収集する。derived 検証にも使う。 */
export function collectOracleIds(repoRoot: string): {
  declared: Set<string>;
  referenced: Set<string>;
  declarationSites: OracleDeclarationSite[];
  citationSites: OracleCitationSite[];
} {
  const declared = new Set<string>();
  collectIds(join(repoRoot, "docs", "test-design"), ".md", declared);
  const referenced = new Set<string>();
  collectIds(join(repoRoot, "tests"), ".ts", referenced);
  return {
    declared,
    referenced,
    declarationSites: collectOracleDeclarationSites(repoRoot),
    citationSites: collectOracleCitationSites(repoRoot),
  };
}

export function loadOracleTestTraceInput(repoRoot: string): OracleTestTraceInput {
  const { declared, referenced, declarationSites, citationSites } = collectOracleIds(repoRoot);
  return {
    declared: [...declared],
    referenced,
    baseline: ORACLE_TEST_TRACE_BASELINE,
    widenedBaseline: ORACLE_TEST_TRACE_WIDENED_BASELINE,
    declarationSites,
    duplicateBaseline: ORACLE_ID_DUPLICATE_BASELINE,
    citationSites,
    citationBaseline: ORACLE_TEST_CITATION_BASELINE,
  };
}

/**
 * failure 出力が是正手順を自分で案内する (issue #158 の発見可能性対策)。
 *
 * `CANDIDATE-*` 規約は 1300 行の test-design doc の 1 行にしか無く、2026-08-05 に 3 本の PR
 * (#234 / #237 / #226) が両ランタイム独立に同じ壁へ突っ込んだ。ゲートが直し方を言えば
 * doc の発見に依存しない。
 */
const ORPHAN_REMEDIATION =
  "未実装 oracle は `CANDIDATE-*` で宣言し、実装 PR で Red test と同時に正規 ID へ昇格する " +
  "(正本: docs/test-design/harness/L7-unit-test-design.md の CANDIDATE 節)。";

export function oracleTestTraceMessages(r: OracleTestTraceResult): string[] {
  const messages: string[] = [];
  if (r.orphans.length > 0) {
    messages.push(
      `oracle-test-trace — ⚠ tests 未 citation の宣言 oracle ${r.orphans.length} 件 (baseline 外): ${r.orphans.join(", ")}。${ORPHAN_REMEDIATION}`,
    );
  }
  if (r.duplicates.length > 0) {
    const ids = r.duplicates.map((duplicate) => duplicate.id).join(", ");
    messages.push(
      `oracle-test-trace — ⚠ provenance が異なる重複宣言 ${r.duplicates.length} 件: ${ids}。同一 ID を別説明へ再利用せず、既存衝突は baseline の説明集合を更新する。`,
    );
  }
  if (r.staleDuplicateBaseline.length > 0) {
    messages.push(
      `oracle-test-trace — ⚠ stale duplicate baseline ${r.staleDuplicateBaseline.length} 件: ${r.staleDuplicateBaseline.join(", ")}。解消済み行を baseline から削除する。`,
    );
  }
  if (r.undeclaredCitations.length > 0) {
    const ids = [...new Set(r.undeclaredCitations.map((site) => site.id))].sort();
    messages.push(
      `oracle-test-trace — ⚠ test-label citation が test-design 未宣言 ${ids.length} 件 (baseline 外): ${ids.join(", ")}。test-design に正確な ID 行を追加する。`,
    );
  }
  if (r.staleCitationBaseline.length > 0) {
    messages.push(
      `oracle-test-trace — ⚠ stale citation baseline ${r.staleCitationBaseline.length} 件: ${r.staleCitationBaseline.join(", ")}。解消済み行を baseline から削除する。`,
    );
  }
  return messages.length > 0
    ? messages
    : [
        "oracle-test-trace — OK (宣言 oracle 全件 tests citation / baseline 被覆、test-label 逆向き citation 断線 0、宣言 provenance 重複 0)",
      ];
}
