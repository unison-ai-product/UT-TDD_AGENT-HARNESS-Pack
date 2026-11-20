import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadFrDocs, parseFrRows } from "./fr-registry-audit.ts";
import { hasDbcTable } from "./shared.ts";

export interface L6FrCoverageDocs {
  frIds: string[];
  coverageText: string;
  repoRoot?: string;
}

export interface L6FrCoverageRow {
  fr_id: string;
  l6_spec: string;
  unit_contract: string;
  unit_oracle: string;
}

export interface L6FrCoverageResult {
  totalFr: number;
  covered: number;
  missing: string[];
  unknown: string[];
  incomplete: { fr_id: string; missing: string[] }[];
  missingSpecFiles: { fr_id: string; l6_spec: string }[];
  weakContracts: { fr_id: string; contract: string; reason: string }[];
  missingSubstance: { fr_id: string; contract: string; reason: string }[];
  ok: boolean;
}

const FR_ROW_RE = /^\|\s*(FR-L1-\d{2})\s*\|(.+)$/gm;

function cells(lineTail: string): string[] {
  return lineTail
    .split("|")
    .slice(0, -1)
    .map((c) => c.trim());
}

function expectedOracle(frId: string): string {
  return `U-${frId}`;
}

function contractRefs(contract: string): string[] {
  return [...contract.matchAll(/`([A-Za-z][A-Za-z0-9_]*)`/g)].map((m) => m[1]);
}

/** 表の行をセルへ分ける。先頭・末尾の pipe は省略されていてもよい (末尾 pipe 無しでも最終セルを捨てない)。 */
function markdownCells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function readSpecText(repoRoot: string | undefined, specPath: string): string | null {
  if (!repoRoot || !specPath.startsWith("docs/")) return null;
  const path = join(repoRoot, specPath);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// substance gate (type body + pseudocode/defer) を要求する L6 spec doc。
// 根拠: A-110 MUST-2 / A-120 で「explicit_l7_defer 行が hollow になりうる」と指摘された
// FR-alias 契約表を持つ 3 doc のみが対象 (他 L6 doc は alias 表を持たない)。
// 新たに FR-alias 契約表を持つ L6 spec を追加したら、このリストへ追記すること。
function requiresSubstanceMarker(specPath: string): boolean {
  return (
    specPath.endsWith("function-spec.md") ||
    specPath.endsWith("governance-enforcement.md") ||
    specPath.endsWith("agent-slots.md")
  );
}

function hasSubstanceMarker(specText: string, ref: string): boolean {
  const refRe = new RegExp(`\\|[^\\n]*\`${escapeRe(ref)}\`[^\\n]*\\|`, "i");
  return specText
    .split(/\r?\n/)
    .filter((line) => refRe.test(line))
    .some((row) => {
      const [, typeBody = "", state = ""] = markdownCells(row);
      const hasTypeBody = /(Input|Result|Frontmatter|GuardDecision|Slot|SkillMetricInput)/.test(
        typeBody,
      );
      const hasFieldBlock = /\{[^}]+[;:?][^}]*\}/.test(typeBody);
      const isExplicitDefer = /\bexplicit_l7_defer\b/i.test(state);
      const hasPseudoOrDefer =
        /\b(pseudocode|explicit_l7_defer|implemented|implementation_state)\b/i.test(state) ||
        /§2\./.test(state);
      return hasTypeBody && hasPseudoOrDefer && (!isExplicitDefer || hasFieldBlock);
    });
}

const REGISTRY_REL = "docs/design/harness/L1-requirements/functional-requirements.md";
const L7_UNIT_REL = "docs/test-design/harness/L7-unit-test-design.md";
const CANDIDATE_ORACLE_RE = /^CANDIDATE-U-[A-Z0-9-]+$/;
const FORMAL_ORACLE_RE = /^U-[A-Z0-9-]+$/;

interface RegistryState {
  state: string;
  ref: string;
}

function stripMark(cell: string): string {
  return cell.replace(/[*`]/g, "").trim();
}

/** FR registry 行の末尾任意列 (fr_state / retirement_ref)。列なし = 空 = active。 */
function loadRegistryStates(repoRoot: string | undefined): Map<string, RegistryState> {
  const states = new Map<string, RegistryState>();
  const path = repoRoot ? join(repoRoot, REGISTRY_REL) : "";
  if (!path || !existsSync(path)) return states;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const id = line.match(/^\|\s*\*\*(FR-L1-\d{2})\*\*\s*\|/)?.[1];
    if (!id || states.has(id)) continue;
    const c = markdownCells(line);
    states.set(id, { state: stripMark(c[7] ?? ""), ref: unwrapCode(c[8] ?? "") });
  }
  return states;
}

const ISSUE_REF_RE = /^#[1-9][0-9]*$/;
const REF_DOC_RE = /^(docs\/design\/|docs\/adr\/)[^#]*\.md$/;

/**
 * CommonMark の fenced code block を行ごとに追跡する。開きの文字と長さを保持し、同じ文字で
 * 開き以上の長さの閉じ fence だけで終える。返す関数は、その行が fence (開き・閉じ行を含む) なら true。
 */
function fenceTracker(): (line: string) => boolean {
  let fence = "";
  return (line) => {
    if (fence !== "") {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/)?.[1];
      if (close?.[0] === fence[0] && close.length >= fence.length) fence = "";
      return true;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      fence = open[1];
      return true;
    }
    return false;
  };
}

function isRegularFile(abs: string): boolean {
  return existsSync(abs) && statSync(abs).isFile();
}

/** ATX 見出し行 (fence 外) の text 一覧。level は無視し、前後空白 (全角含む) と先頭 # 群を除く。 */
function atxHeadings(text: string): string[] {
  const out: string[] = [];
  const inFence = fenceTracker();
  for (const line of text.split(/\r?\n/)) {
    if (inFence(line)) continue;
    const h = line.match(/^#{1,6}[ \t\u3000]+(.*)$/);
    if (h) out.push(h[1].trim());
  }
  return out;
}

/** 退役根拠 (Issue 参照 / 設計文書見出し参照) の閉じた文法で一意に解決できたときだけ true。 */
function resolveRetirementRef(repoRoot: string, rawRef: string): boolean {
  const ref = rawRef.trim();
  if (ISSUE_REF_RE.test(ref)) return true;
  const hash = ref.indexOf(".md#");
  if (hash < 0) return false;
  const rel = ref.slice(0, hash + 3);
  const heading = ref.slice(hash + 4);
  if (!REF_DOC_RE.test(rel) || rel.includes("..") || rel.includes("\\") || heading === "") {
    return false;
  }
  const abs = join(repoRoot, rel);
  if (!isRegularFile(abs)) return false;
  return atxHeadings(readFileSync(abs, "utf8")).filter((h) => h === heading).length === 1;
}

function citesId(text: string, id: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9-])${escapeRe(id)}(?![A-Za-z0-9-])`).test(text);
}

const TABLE_SEPARATOR_RE = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const FR_ID_RE = /(?<![A-Za-z0-9-])FR-L1-\d+(?![A-Za-z0-9-])/g;

/** セル全体を囲む code 記法と前後空白だけを除く (本文中の強調等は剥がさない)。 */
function unwrapCode(cell: string): string {
  return cell
    .trim()
    .replace(/^`([^`]*)`$/, "$1")
    .trim();
}

/**
 * L7 unit-test design の宣言行 (L6「宣言行の識別規則」条件1〜2・6)。
 * ヘッダ + 区切り行を持つ 3 列以上の表の本体行で、第 1 セルが oracle ID と完全一致する行。
 * fenced code block 内は表として数えない。見出し・ヘッダ名には依存しない。
 */
function declarationRows(repoRoot: string, oracle: string): string[][] {
  const path = join(repoRoot, L7_UNIT_REL);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const rows: string[][] = [];
  const inFence = fenceTracker();
  let tableCols = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inFence(line)) {
      tableCols = 0;
      continue;
    }
    if (!line.trimStart().startsWith("|")) {
      tableCols = 0;
      continue;
    }
    if (tableCols === 0) {
      const next = lines[i + 1] ?? "";
      if (next.trimStart().startsWith("|") && TABLE_SEPARATOR_RE.test(next.trim())) {
        tableCols = markdownCells(line).length;
        i++;
      } else {
        tableCols = -1;
      }
      continue;
    }
    if (tableCols < 3) continue;
    const cells = markdownCells(line);
    if (unwrapCode(cells[0] ?? "") === oracle) rows.push(cells);
  }
  return rows;
}

/** 第 2 列以降の cell から `tests/` 始まり `.ts` 終わりの path token を取り出す (`:行番号` は除く)。 */
function testPathTokens(cells: string[]): string[] {
  return cells
    .slice(1)
    .flatMap((c) => c.split(/[\s,;、`()（）]+/))
    .map((t) => t.replace(/:\d+$/, ""))
    .filter((t) => t.startsWith("tests/") && t.endsWith(".ts"));
}

/** 退役行の oracle 証拠 (宣言行 + 対象 FR 集合 + 実 test 引用) を検証し、欠落キーを返す。 */
function retiredOracleFailures(repoRoot: string, frId: string, oracle: string): string[] {
  const rows = declarationRows(repoRoot, oracle);
  if (rows.length !== 1) return ["unit_oracle_declaration"];
  const cells = rows[0];
  const targets = new Set(cells.slice(1).flatMap((c) => c.match(FR_ID_RE) ?? []));
  if (targets.size !== 1 || !targets.has(frId)) return ["unit_oracle_declaration_target"];
  const tokens = testPathTokens(cells);
  const resolved = tokens.map((t) => (t.includes("..") ? null : join(repoRoot, t)));
  if (tokens.length === 0 || resolved.some((abs) => abs === null || !isRegularFile(abs))) {
    return ["unit_oracle_test_file"];
  }
  return resolved.every((abs) => citesId(readFileSync(abs as string, "utf8"), oracle))
    ? []
    : ["unit_oracle_test_citation"];
}

/** fr_state 別の oracle / 退役根拠の欠落キー。未知 state は通常 FR へ fallback しない。 */
function stateFailures(
  row: L6FrCoverageRow,
  reg: RegistryState,
  repoRoot: string | undefined,
): string[] {
  if (reg.state !== "" && reg.state !== "active" && reg.state !== "retired") return ["fr_state"];
  const fails: string[] = [];
  if (reg.state !== "retired") {
    if (reg.ref !== "") fails.push("retirement_ref");
    if (row.unit_oracle && row.unit_oracle !== expectedOracle(row.fr_id)) {
      fails.push("unit_oracle_match");
    }
    return fails;
  }
  if (reg.ref === "" || !repoRoot || !resolveRetirementRef(repoRoot, reg.ref)) {
    fails.push("retirement_ref");
  }
  const oracle = row.unit_oracle;
  if (!CANDIDATE_ORACLE_RE.test(oracle) && !FORMAL_ORACLE_RE.test(oracle)) {
    fails.push("unit_oracle_match");
  } else {
    fails.push(
      ...(repoRoot
        ? retiredOracleFailures(repoRoot, row.fr_id, oracle)
        : ["unit_oracle_declaration"]),
    );
  }
  return fails;
}

export function parseL6FrCoverageRows(coverageText: string): L6FrCoverageRow[] {
  const rows: L6FrCoverageRow[] = [];
  for (const match of coverageText.matchAll(FR_ROW_RE)) {
    const [l6_spec = "", unit_contract = "", unit_oracle = ""] = cells(match[2]);
    rows.push({
      fr_id: match[1],
      l6_spec,
      unit_contract,
      unit_oracle,
    });
  }
  return rows;
}

export function analyzeL6FrCoverage(docs: L6FrCoverageDocs): L6FrCoverageResult {
  const expected = new Set(docs.frIds);
  const rows = parseL6FrCoverageRows(docs.coverageText);
  const byFr = new Map(rows.map((r) => [r.fr_id, r]));
  const missing = docs.frIds.filter((id) => !byFr.has(id));
  const unknown = rows
    .map((r) => r.fr_id)
    .filter((id) => !expected.has(id))
    .sort();
  const incomplete: L6FrCoverageResult["incomplete"] = [];
  const missingSpecFiles: L6FrCoverageResult["missingSpecFiles"] = [];
  const weakContracts: L6FrCoverageResult["weakContracts"] = [];
  const missingSubstance: L6FrCoverageResult["missingSubstance"] = [];
  const registry = loadRegistryStates(docs.repoRoot);

  for (const row of rows) {
    const missingFields: string[] = [];
    if (!row.l6_spec) missingFields.push("l6_spec");
    const refs = contractRefs(row.unit_contract);
    if (!row.unit_contract || refs.length === 0) missingFields.push("unit_contract");
    if (!/\bU-[A-Z0-9-]+/.test(row.unit_oracle)) missingFields.push("unit_oracle");
    missingFields.push(
      ...stateFailures(row, registry.get(row.fr_id) ?? { state: "", ref: "" }, docs.repoRoot),
    );
    if (missingFields.length > 0) {
      incomplete.push({ fr_id: row.fr_id, missing: missingFields });
    }

    const specText = readSpecText(docs.repoRoot, row.l6_spec);
    if (docs.repoRoot && row.l6_spec.startsWith("docs/") && specText === null) {
      missingSpecFiles.push({ fr_id: row.fr_id, l6_spec: row.l6_spec });
    }
    if (specText !== null) {
      for (const ref of refs) {
        if (!specText.includes(ref)) {
          weakContracts.push({
            fr_id: row.fr_id,
            contract: ref,
            reason: "contract_ref_missing_in_l6_spec",
          });
        }
        if (requiresSubstanceMarker(row.l6_spec) && !hasSubstanceMarker(specText, ref)) {
          missingSubstance.push({
            fr_id: row.fr_id,
            contract: ref,
            reason: "missing_type_body_or_pseudocode_defer_marker",
          });
        }
      }
      const hasDbcStructure = hasDbcTable(specText);
      if (row.l6_spec.endsWith("function-spec.md") && !hasDbcStructure) {
        weakContracts.push({
          fr_id: row.fr_id,
          contract: refs.join(","),
          reason: "function_spec_missing_structured_dbc_table",
        });
      }
    }
  }

  const ok =
    missing.length === 0 &&
    unknown.length === 0 &&
    incomplete.length === 0 &&
    missingSpecFiles.length === 0 &&
    weakContracts.length === 0 &&
    missingSubstance.length === 0;

  return {
    totalFr: docs.frIds.length,
    covered: docs.frIds.length - missing.length,
    missing,
    unknown,
    incomplete,
    missingSpecFiles,
    weakContracts,
    missingSubstance,
    ok,
  };
}

export function loadL6FrCoverageDocs(repoRoot: string = process.cwd()): L6FrCoverageDocs {
  return {
    frIds: parseFrRows(loadFrDocs().l1Functional).map((r) => r.id),
    coverageText: readFileSync(
      join(repoRoot, "docs", "design", "harness", "L6-function-design", "fr-unit-coverage.md"),
      "utf8",
    ),
    repoRoot,
  };
}

export function l6FrCoverageMessages(result: L6FrCoverageResult): string[] {
  if (result.ok) {
    return [
      `l6-fr-coverage — OK (FR registry ${result.totalFr}件すべて L6 unit contract / U-* oracle に接続)`,
    ];
  }
  const messages: string[] = [];
  if (result.missing.length > 0) {
    messages.push(
      `l6-fr-coverage — ⚠ missing FR rows ${result.missing.length}件 (${result.missing.join(", ")})`,
    );
  }
  if (result.unknown.length > 0) {
    messages.push(
      `l6-fr-coverage — ⚠ unknown FR rows ${result.unknown.length}件 (${result.unknown.join(", ")})`,
    );
  }
  if (result.incomplete.length > 0) {
    const ids = result.incomplete.map((r) => `${r.fr_id}:${r.missing.join("+")}`).join(", ");
    messages.push(
      `l6-fr-coverage — ⚠ incomplete unit coverage ${result.incomplete.length}件 (${ids})`,
    );
  }
  if (result.missingSpecFiles.length > 0) {
    const ids = result.missingSpecFiles.map((r) => `${r.fr_id}:${r.l6_spec}`).join(", ");
    messages.push(
      `l6-fr-coverage — ⚠ missing L6 spec files ${result.missingSpecFiles.length}件 (${ids})`,
    );
  }
  if (result.weakContracts.length > 0) {
    const ids = result.weakContracts.map((r) => `${r.fr_id}:${r.contract}:${r.reason}`).join(", ");
    messages.push(
      `l6-fr-coverage — ⚠ weak unit contracts ${result.weakContracts.length}件 (${ids})`,
    );
  }
  if (result.missingSubstance.length > 0) {
    const ids = result.missingSubstance
      .map((r) => `${r.fr_id}:${r.contract}:${r.reason}`)
      .join(", ");
    messages.push(
      `l6-fr-coverage — ⚠ missing type/pseudocode substance ${result.missingSubstance.length}件 (${ids})`,
    );
  }
  return messages;
}
