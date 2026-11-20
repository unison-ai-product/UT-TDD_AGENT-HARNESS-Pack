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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { ORACLE_ID_DUPLICATE_BASELINE } from "./oracle-id-duplicate-baseline.ts";
import { collectOracleCitationSites, type OracleCitationSite } from "./oracle-test-citation.ts";

declare const __UT_TDD_BUNDLED__: boolean;

const bundled = typeof __UT_TDD_BUNDLED__ !== "undefined" && __UT_TDD_BUNDLED__ === true;

const EMBEDDED_ORACLE_BASELINE = bundled
  ? (require("ut-tdd-oracle-test-trace-baseline") as string)
  : null;

export type { OracleCitationSite } from "./oracle-test-citation.ts";
export { collectOracleCitationSites, ORACLE_ID_DUPLICATE_BASELINE };

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

const BASELINE_JSON_PATH = "docs/governance/oracle-test-trace-baseline.json" as const;

export type OracleTraceFailureReason =
  | "authority_read_failed"
  | "baseline_asset_missing"
  | "baseline_json_malformed"
  | "baseline_schema_invalid"
  | "baseline_id_invalid"
  | "baseline_id_duplicate"
  | "baseline_sets_overlap";

export class OracleTestTraceLoadError extends Error {
  readonly reason: OracleTraceFailureReason;

  constructor(reason: OracleTraceFailureReason) {
    super(reason);
    this.name = "OracleTestTraceLoadError";
    this.reason = reason;
  }
}

export type OracleTracePortResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "authority_read_failed" };

export interface OracleTraceAuthority {
  readText(path: typeof BASELINE_JSON_PATH): OracleTracePortResult<string | null>;
}

export interface OracleTestTracePorts {
  authority?: OracleTraceAuthority;
}

export type OracleTraceGitIoFailureReason =
  | "git_first_parent_read_failed"
  | "git_object_read_failed";

export type OracleTraceGitPortResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: OracleTraceGitIoFailureReason };

export type OracleTraceGitPath =
  | typeof BASELINE_JSON_PATH
  | "src/lint/oracle-test-trace-baseline.ts"
  | "src/lint/oracle-test-trace-widened-baseline.ts"
  | "src/lint/oracle-test-citation-baseline.ts";

export type OracleBaselineRatchetFailureReason =
  | "pr_context_invalid"
  | "git_first_parent_missing"
  | "git_first_parent_read_failed"
  | "git_baseline_missing"
  | "git_object_read_failed"
  | "trusted_baseline_invalid"
  | "baseline_growth"
  | "bootstrap_base_invalid"
  | "bootstrap_value_mismatch";

export interface OracleBaselineRatchetInput {
  /** Loader と同じ authority binding を composition で受け取る。 */
  authority: OracleTraceAuthority;
  ci: {
    eventName: string;
    mergeSha: string;
    git: {
      readTextAt(
        commitSha: string,
        path: OracleTraceGitPath,
      ): OracleTraceGitPortResult<string | null>;
      readFirstParent(mergeSha: string): OracleTraceGitPortResult<string | null>;
    };
  };
}

export type OracleBaselineRatchetResult =
  | { ok: true }
  | { ok: false; reason: OracleBaselineRatchetFailureReason };

const BASELINE_ARRAY_KEYS = ["legacy", "widened", "citations"] as const;
const ORACLE_ID_TOKEN = /^(?:U|IT|ST|P|M)-[A-Z0-9]+(?:-[A-Z0-9]+)*-[0-9]{2,3}(?![\s\S])/u;
const IMMUTABLE_SHA = /^[0-9a-f]{40}(?![\s\S])/iu;

interface DecodedOracleBaseline {
  legacy: Set<string>;
  widened: Set<string>;
  citations: Set<string>;
}

function decodeOracleBaseline(text: string): DecodedOracleBaseline {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new OracleTestTraceLoadError("baseline_json_malformed");
  }

  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new OracleTestTraceLoadError("baseline_schema_invalid");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = ["citations", "legacy", "schemaVersion", "widened"];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    record.schemaVersion !== 2
  ) {
    throw new OracleTestTraceLoadError("baseline_schema_invalid");
  }

  const sets = {} as DecodedOracleBaseline;
  for (const key of BASELINE_ARRAY_KEYS) {
    const ids = record[key];
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
      throw new OracleTestTraceLoadError("baseline_schema_invalid");
    const strings = ids as string[];
    if (strings.some((id) => !ORACLE_ID_TOKEN.test(id)))
      throw new OracleTestTraceLoadError("baseline_id_invalid");
    if (new Set(strings).size !== strings.length)
      throw new OracleTestTraceLoadError("baseline_id_duplicate");
    sets[key] = new Set(strings);
  }
  if ([...sets.legacy].some((id) => sets.widened.has(id)))
    throw new OracleTestTraceLoadError("baseline_sets_overlap");
  return sets;
}

function defaultOracleTraceAuthority(): OracleTraceAuthority {
  return {
    readText(path) {
      if (bundled) {
        if (EMBEDDED_ORACLE_BASELINE === null)
          return { ok: false, reason: "authority_read_failed" };
        return { ok: true, value: EMBEDDED_ORACLE_BASELINE };
      }
      const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
      try {
        return { ok: true, value: readFileSync(resolve(sourceRoot, path), "utf8") };
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
          return { ok: true, value: null };
        return { ok: false, reason: "authority_read_failed" };
      }
    },
  };
}

function parseBootstrapSource(text: string, expectedName: string): Set<string> | null {
  const transpiled = ts.transpileModule(text, {
    fileName: expectedName,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.Latest },
  });
  if (
    transpiled.diagnostics?.some(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    )
  )
    return null;
  const source = ts.createSourceFile(
    expectedName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if (source.statements.length !== 1) return null;
  const statement = source.statements[0];
  if (!statement) return null;
  if (!ts.isVariableStatement(statement)) return null;
  if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
    return null;
  if (
    !(statement.declarationList.flags & ts.NodeFlags.Const) ||
    statement.declarationList.declarations.length !== 1
  )
    return null;
  const declaration = statement.declarationList.declarations[0];
  if (!declaration) return null;
  if (!ts.isIdentifier(declaration.name) || declaration.name.text !== expectedName) return null;
  const declarationType = declaration.type;
  if (
    !declarationType ||
    !ts.isTypeReferenceNode(declarationType) ||
    !ts.isIdentifier(declarationType.typeName) ||
    declarationType.typeName.text !== "ReadonlySet"
  ) {
    return null;
  }
  const typeArguments = declarationType.typeArguments;
  if (!typeArguments || typeArguments.length !== 1) return null;
  const typeArgument = typeArguments[0];
  if (!typeArgument || typeArgument.kind !== ts.SyntaxKind.StringKeyword) return null;
  const initializer = declaration.initializer;
  const setArgument =
    initializer && ts.isNewExpression(initializer) ? initializer.arguments?.[0] : undefined;
  if (
    !initializer ||
    !ts.isNewExpression(initializer) ||
    !ts.isIdentifier(initializer.expression) ||
    initializer.expression.text !== "Set" ||
    (initializer.typeArguments?.length ?? 0) !== 0 ||
    initializer.arguments?.length !== 1 ||
    !setArgument ||
    !ts.isArrayLiteralExpression(setArgument)
  ) {
    return null;
  }
  const ids: string[] = [];
  for (const element of setArgument.elements) {
    if (!ts.isStringLiteral(element) || !ORACLE_ID_TOKEN.test(element.text)) return null;
    ids.push(element.text);
  }
  if (new Set(ids).size !== ids.length) return null;
  return new Set(ids);
}

const BOOTSTRAP_SOURCES = [
  {
    path: "src/lint/oracle-test-trace-baseline.ts",
    name: "ORACLE_TEST_TRACE_BASELINE",
    key: "legacy",
    count: 89,
  },
  {
    path: "src/lint/oracle-test-trace-widened-baseline.ts",
    name: "ORACLE_TEST_TRACE_WIDENED_BASELINE",
    key: "widened",
    count: 317,
  },
  {
    path: "src/lint/oracle-test-citation-baseline.ts",
    name: "ORACLE_TEST_CITATION_BASELINE",
    key: "citations",
    count: 582,
  },
] as const;

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function isPortFailure<T>(
  result: OracleTraceGitPortResult<T>,
): result is { ok: false; reason: OracleTraceGitIoFailureReason } {
  return !result.ok;
}

function readFirstParentSafely(
  git: OracleBaselineRatchetInput["ci"]["git"],
  mergeSha: string,
): OracleTraceGitPortResult<string | null> {
  try {
    return git.readFirstParent(mergeSha);
  } catch {
    return { ok: false, reason: "git_first_parent_read_failed" };
  }
}

function readTextAtSafely(
  git: OracleBaselineRatchetInput["ci"]["git"],
  commitSha: string,
  path: OracleTraceGitPath,
): OracleTraceGitPortResult<string | null> {
  try {
    return git.readTextAt(commitSha, path);
  } catch {
    return { ok: false, reason: "git_object_read_failed" };
  }
}

/** CI-only immutable Git-tree comparison; it never consults working files or authority.readText. */
export function checkOracleBaselineRatchet(
  input: OracleBaselineRatchetInput,
): OracleBaselineRatchetResult {
  const { eventName, mergeSha, git } = input.ci;
  if (eventName !== "pull_request" || !IMMUTABLE_SHA.test(mergeSha))
    return { ok: false, reason: "pr_context_invalid" };

  const parentResult = readFirstParentSafely(git, mergeSha);
  if (isPortFailure(parentResult)) return { ok: false, reason: "git_first_parent_read_failed" };
  const baseSha = parentResult.value;
  if (baseSha === null) return { ok: false, reason: "git_first_parent_missing" };
  if (!IMMUTABLE_SHA.test(baseSha)) return { ok: false, reason: "git_first_parent_read_failed" };

  const baseTextResult = readTextAtSafely(git, baseSha, BASELINE_JSON_PATH);
  if (isPortFailure(baseTextResult)) return { ok: false, reason: "git_object_read_failed" };

  let base: DecodedOracleBaseline | null = null;
  if (baseTextResult.value !== null) {
    try {
      base = decodeOracleBaseline(baseTextResult.value);
    } catch {
      return { ok: false, reason: "trusted_baseline_invalid" };
    }
  }

  const headTextResult = readTextAtSafely(git, mergeSha, BASELINE_JSON_PATH);
  if (isPortFailure(headTextResult)) return { ok: false, reason: "git_object_read_failed" };
  if (headTextResult.value === null) return { ok: false, reason: "git_baseline_missing" };
  let head: DecodedOracleBaseline;
  try {
    head = decodeOracleBaseline(headTextResult.value);
  } catch {
    return { ok: false, reason: "trusted_baseline_invalid" };
  }

  if (base === null) {
    const oldSets = {} as DecodedOracleBaseline;
    for (const source of BOOTSTRAP_SOURCES) {
      const result = readTextAtSafely(git, baseSha, source.path);
      if (isPortFailure(result)) return { ok: false, reason: "git_object_read_failed" };
      if (result.value === null) return { ok: false, reason: "bootstrap_base_invalid" };
      const parsed = parseBootstrapSource(result.value, source.name);
      if (parsed === null) return { ok: false, reason: "bootstrap_base_invalid" };
      oldSets[source.key] = parsed;
      if (parsed.size !== source.count) return { ok: false, reason: "bootstrap_value_mismatch" };
    }
    return BASELINE_ARRAY_KEYS.every((key) => sameSet(oldSets[key], head[key]))
      ? { ok: true }
      : { ok: false, reason: "bootstrap_value_mismatch" };
  }

  return BASELINE_ARRAY_KEYS.every((key) => [...head[key]].every((id) => base[key].has(id)))
    ? { ok: true }
    : { ok: false, reason: "baseline_growth" };
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
  | { kind: "resource-kernel"; role: "summary" | "canonical" }
  | { kind: "system-oracle"; role: "canonical" };

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

  // L9 system-oracle matrix pairs an ST oracle with its AC contract in one cell.
  if (
    has("st-id / ac") &&
    has("system fixture / fault") &&
    (has("positive expected") || hasContaining("正oracle")) &&
    (has("negative expected") || hasContaining("負oracle"))
  ) {
    return { kind: "system-oracle", role: "canonical" };
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
    const mirror = declarationMirror(tableHeaders ?? []);
    const idCells = cells.flatMap((cell, cellIndex) => {
      const matches = oracleMatches(cell);
      const normalized = cell.replace(/`/g, "").trim();
      const systemOraclePair =
        mirror?.kind === "system-oracle" && cellIndex === 0
          ? normalized.match(
              /^(ST-([A-Z0-9]+-[0-9]{2,3}))\s*\/\s*AC-\2(?:\s+\*\*DEFERRED\*\*)?$/u,
            )?.[1]
          : undefined;
      return matches.length === 1 && (normalized === matches[0] || systemOraclePair === matches[0])
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
        mirror,
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
  const declarationSites = collectOracleDeclarationSites(repoRoot);
  const declared = new Set(declarationSites.map((site) => site.id));
  const referenced = new Set<string>();
  collectIds(join(repoRoot, "tests"), ".ts", referenced);
  return {
    declared,
    referenced,
    declarationSites,
    citationSites: collectOracleCitationSites(repoRoot),
  };
}

export function loadOracleTestTraceInput(
  repoRoot: string,
  ports?: OracleTestTracePorts,
): OracleTestTraceInput {
  const { declared, referenced, declarationSites, citationSites } = collectOracleIds(repoRoot);
  const authority = ports?.authority ?? defaultOracleTraceAuthority();
  const result = authority.readText(BASELINE_JSON_PATH);
  if (!result.ok) throw new OracleTestTraceLoadError(result.reason);
  if (result.value === null) throw new OracleTestTraceLoadError("baseline_asset_missing");
  const baseline = decodeOracleBaseline(result.value);
  return {
    declared: [...declared],
    referenced,
    baseline: baseline.legacy,
    widenedBaseline: baseline.widened,
    declarationSites,
    duplicateBaseline: ORACLE_ID_DUPLICATE_BASELINE,
    citationSites,
    citationBaseline: baseline.citations,
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
