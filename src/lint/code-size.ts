/**
 * code-size gate の純粋関数 (issue #1310)。
 * 契約: docs/design/harness/L6-function-design/code-size-gate.md §3 / §5 / §6 / §7 / §8。
 * ファイルも git も読まない (構文木は渡された文字列から作る)。I/O は code-size-inputs.ts が担う。
 */

import ts from "typescript";

export type CodeClass = "src" | "tests";

export interface CodeSizeSource {
  path: string;
  text: string;
}

export interface CodeRename {
  from: string;
  to: string;
}

export type CodeSizeBaselineRow = { lines: number | null; functionExcess: number | null };

export type CodeSizeBaseline = Readonly<Record<string, CodeSizeBaselineRow>>;

export interface CodeSizeInput {
  sources: readonly CodeSizeSource[];
  baseline: CodeSizeBaseline;
  previousBaseline: CodeSizeBaseline | null;
  mergeBaseMeasures: CodeSizeBaseline | null;
  renames: readonly CodeRename[];
}

export interface CodeFunctionMeasure {
  name: string;
  line: number;
  lines: number;
}

export interface CodeStatementMeasure {
  name: string;
  lines: number;
}

export interface CodeMeasure {
  path: string;
  codeClass: CodeClass;
  lines: number;
  functionExcess: number | null;
  functions: CodeFunctionMeasure[];
  overFunctions: CodeFunctionMeasure[];
  topLevel: CodeStatementMeasure[];
}

export interface CodeSizeFinding {
  path: string;
  kind: string;
  reason: string;
}

export interface CodeSizeSummary {
  checked: number;
  over: number;
  stale: number;
  baseline: number;
}

export interface CodeSizeResult {
  ok: boolean;
  findings: CodeSizeFinding[];
  summary: CodeSizeSummary;
}

/** 関数の本体を測った結果。`extractCodeFunctions` が返し、候補側の抽出にも使う。 */
export interface CodeFunctionSpan extends CodeFunctionMeasure {
  body: string;
}

export const CODE_SIZE_LIMITS = {
  src: { lines: 500, functionLines: 120 },
  tests: { lines: 500 },
} as const;

export const CODE_SIZE_BASELINE_PATH = "docs/governance/code-size-baseline.json";

const FUNCTION_LIMIT = CODE_SIZE_LIMITS.src.functionLines;
const REQUIRED = "code-size-required";
const STALE = "code-size-stale-baseline";
const CLASS_CHANGED = "code-size-class-changed";
const BASELINE_GROWN = "code-size-baseline-grown";
const INITIAL_GROWN = "code-size-initial-baseline-grown";
const INITIAL_NEW_ENTRY = "code-size-initial-baseline-new-entry";
const BASE_UNREADABLE = "code-size-baseline-base-unreadable";
const INPUT_UNREADABLE = "code-size-input-unreadable";

export function classifyCodeFile(path: string): CodeClass | null {
  const normalized = path.replace(/\\/g, "/");
  if (!/\.(?:ts|tsx|mts|cts)$/.test(normalized) || normalized.endsWith(".d.ts")) return null;
  if (normalized.split("/").some((segment) => segment === "node_modules" || segment === "dist")) {
    return null;
  }
  if (normalized.startsWith("tests/fixtures/")) return null;
  if (normalized.startsWith("src/")) return "src";
  if (normalized.startsWith("tests/")) return "tests";
  return null;
}

const normalizeNewlines = (text: string): string => text.replace(/\r\n/g, "\n");

function parseCodeSource(path: string, text: string): ts.SourceFile {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
}

const lineOf = (sourceFile: ts.SourceFile, position: number): number =>
  sourceFile.getLineAndCharacterOfPosition(position).line;

function isJsDocNode(node: ts.Node): boolean {
  return node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode;
}

/** 木の葉のトークンの範囲を集める (コメントは trivia なので含まれない)。 */
function collectTokenSpans(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  spans: Array<[number, number]>,
): void {
  if (node.kind < ts.SyntaxKind.FirstNode) {
    spans.push([node.getStart(sourceFile), node.getEnd()]);
    return;
  }
  for (const child of node.getChildren(sourceFile)) {
    if (!isJsDocNode(child)) collectTokenSpans(child, sourceFile, spans);
  }
}

/** 関数の本体 (ブロックなら括弧の間、式なら式全体) のうち、トークンを含む行の数。 */
function bodyLineCount(body: ts.Node, sourceFile: ts.SourceFile): number {
  const spans: Array<[number, number]> = [];
  collectTokenSpans(body, sourceFile, spans);
  const open = ts.isBlock(body) ? body.getStart(sourceFile) : -1;
  const close = ts.isBlock(body) ? body.getEnd() - 1 : -1;
  const lines = new Set<number>();
  for (const [start, end] of spans) {
    if (start === open || start === close) continue;
    for (let line = lineOf(sourceFile, start); line <= lineOf(sourceFile, end); line++) {
      lines.add(line);
    }
  }
  return lines.size;
}

function functionBodyOf(node: ts.Node): ts.Node | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return node.body;
  }
  return undefined;
}

function functionName(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) {
    return node.name.text;
  }
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return node.name.getText(sourceFile);
  }
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text;
  }
  return undefined;
}

function functionSpans(sourceFile: ts.SourceFile): CodeFunctionSpan[] {
  const spans: CodeFunctionSpan[] = [];
  const visit = (node: ts.Node): void => {
    const body = functionBodyOf(node);
    if (body) {
      const line = lineOf(sourceFile, node.getStart(sourceFile)) + 1;
      const text = body.getText(sourceFile);
      spans.push({
        name: functionName(node, sourceFile) ?? `<anon@${line}>`,
        line,
        lines: bodyLineCount(body, sourceFile),
        body: ts.isBlock(body) ? text.slice(1, -1) : text,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return spans;
}

/** ソース内の全関数 (出現順、入れ子を含む) を §3 の数え方で測る。候補側の抽出と共有する。 */
export function extractCodeFunctions(path: string, text: string): CodeFunctionSpan[] {
  return functionSpans(parseCodeSource(path, normalizeNewlines(text)));
}

function hasDefaultModifier(statement: ts.Statement): boolean {
  const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
  return modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
}

function statementName(statement: ts.Statement, sourceFile: ts.SourceFile): string {
  if (ts.isExportAssignment(statement) || hasDefaultModifier(statement)) return "default";
  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)) &&
    statement.name
  ) {
    return statement.name.text;
  }
  if (ts.isVariableStatement(statement)) {
    const name = statement.declarationList.declarations[0]?.name;
    if (name && ts.isIdentifier(name)) return name.text;
  }
  if (
    ts.isExpressionStatement(statement) &&
    ts.isCallExpression(statement.expression) &&
    ts.isIdentifier(statement.expression.expression) &&
    statement.expression.expression.text === "describe"
  ) {
    const title = statement.expression.arguments[0];
    if (title && (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))) {
      return `describe: ${title.text}`;
    }
  }
  return `<statement@${lineOf(sourceFile, statement.getStart(sourceFile)) + 1}>`;
}

const isNonblank = (line: string): boolean => /\S/.test(line);

export function measureCodeFile(source: CodeSizeSource): CodeMeasure {
  const codeClass = classifyCodeFile(source.path) ?? "src";
  const text = normalizeNewlines(source.text);
  const sourceFile = parseCodeSource(source.path, text);
  const textLines = text.split("\n");
  const functions =
    codeClass === "src"
      ? functionSpans(sourceFile).map(({ name, line, lines }) => ({ name, line, lines }))
      : [];
  return {
    path: source.path,
    codeClass,
    lines: textLines.filter(isNonblank).length,
    functionExcess:
      codeClass === "src"
        ? functions.reduce((sum, fn) => sum + Math.max(0, fn.lines - FUNCTION_LIMIT), 0)
        : null,
    functions,
    overFunctions: functions
      .filter((fn) => fn.lines > FUNCTION_LIMIT)
      .sort((a, b) => b.lines - a.lines),
    topLevel: sourceFile.statements.map((statement) => {
      const first = lineOf(sourceFile, statement.getStart(sourceFile));
      const last = lineOf(sourceFile, statement.getEnd());
      return {
        name: statementName(statement, sourceFile),
        lines: textLines.slice(first, last + 1).filter(isNonblank).length,
      };
    }),
  };
}

/** 記録形 (§5): 上限を超えたものだけを値にし、超えなければ null。 */
export function recordForm(measure: CodeMeasure): CodeSizeBaselineRow {
  const limit = CODE_SIZE_LIMITS[measure.codeClass].lines;
  return {
    lines: measure.lines > limit ? measure.lines : null,
    functionExcess:
      measure.functionExcess !== null && measure.functionExcess > 0 ? measure.functionExcess : null,
  };
}

const finding = (path: string, kind: string, reason: string): CodeSizeFinding => ({
  path,
  kind,
  reason,
});

/** 行 (baseline があればその値、無ければ class の上限) と関数超過量の許容値。 */
function allowedValues(
  codeClass: CodeClass,
  row: CodeSizeBaselineRow | undefined,
): CodeSizeBaselineRow {
  return {
    lines: row?.lines ?? CODE_SIZE_LIMITS[codeClass].lines,
    functionExcess: codeClass === "src" ? (row?.functionExcess ?? 0) : 0,
  };
}

function checkMeasure(measure: CodeMeasure, row: CodeSizeBaselineRow | undefined) {
  const allowed = allowedValues(measure.codeClass, row);
  const excess = measure.functionExcess ?? 0;
  if (row) {
    if (measure.lines > (allowed.lines ?? 0) || excess > (allowed.functionExcess ?? 0)) {
      return [finding(measure.path, REQUIRED, "exceeds-baseline")];
    }
  } else if (measure.lines > CODE_SIZE_LIMITS[measure.codeClass].lines || excess > 0) {
    return [finding(measure.path, REQUIRED, "new-file-over-limit")];
  }
  if (!row) return [];
  const recorded = recordForm(measure);
  const same =
    (row.lines ?? null) === recorded.lines &&
    (row.functionExcess || null) === recorded.functionExcess;
  if (same) return [];
  const reason =
    recorded.lines === null && recorded.functionExcess === null ? "within-limit" : "shrunk";
  return [finding(measure.path, STALE, reason)];
}

function previousRowOf(
  path: string,
  previous: CodeSizeBaseline,
  renames: readonly CodeRename[],
): CodeSizeBaselineRow | undefined {
  if (previous[path]) return previous[path];
  const rename = renames.find((item) => item.to === path && previous[item.from]);
  return rename ? previous[rename.from] : undefined;
}

/** §5 縮小のみ: 比較元 (merge-base) と比べて、行は path ごと、関数超過量は合計で増えていないか。 */
function growthAgainstPrevious(input: CodeSizeInput, previous: CodeSizeBaseline) {
  const findings: CodeSizeFinding[] = [];
  for (const [path, row] of Object.entries(input.baseline)) {
    if (row.lines === null) continue;
    const prior = previousRowOf(path, previous, input.renames);
    if (prior === undefined || prior.lines === null || row.lines > prior.lines) {
      findings.push(finding(path, BASELINE_GROWN, "lines"));
    }
  }
  const total = (baseline: CodeSizeBaseline) =>
    Object.values(baseline).reduce((sum, row) => sum + (row.functionExcess ?? 0), 0);
  if (total(input.baseline) > total(previous)) {
    findings.push(finding(CODE_SIZE_BASELINE_PATH, BASELINE_GROWN, "functionExcess-total"));
  }
  return findings;
}

/** §5 初回記録: 記録の行は merge-base の実測 (記録形) と比べて増えていないか。 */
function initialBaselineFindings(input: CodeSizeInput) {
  if (input.mergeBaseMeasures === null) {
    return [finding(CODE_SIZE_BASELINE_PATH, BASE_UNREADABLE, "merge-base-unresolved")];
  }
  const findings: CodeSizeFinding[] = [];
  for (const [path, row] of Object.entries(input.baseline)) {
    const base: CodeSizeBaselineRow | undefined = input.mergeBaseMeasures[path];
    if (base === undefined) {
      findings.push(finding(path, INITIAL_NEW_ENTRY, "new-entry"));
      continue;
    }
    const linesGrown = row.lines !== null && (base.lines === null || row.lines > base.lines);
    const excessGrown = (row.functionExcess ?? 0) > (base.functionExcess ?? 0);
    if (linesGrown || excessGrown) findings.push(finding(path, INITIAL_GROWN, "grown"));
  }
  return findings;
}

const compareFindings = (a: CodeSizeFinding, b: CodeSizeFinding): number => {
  const left = `${a.path}\u0000${a.kind}\u0000${a.reason}`;
  const right = `${b.path}\u0000${b.kind}\u0000${b.reason}`;
  return left < right ? -1 : left > right ? 1 : 0;
};

export function analyzeCodeSize(input: CodeSizeInput): CodeSizeResult {
  const targets = input.sources.filter((source) => classifyCodeFile(source.path) !== null);
  const measures = targets.map((source) => measureCodeFile(source));
  const findings: CodeSizeFinding[] = [];
  if (measures.length === 0) findings.push(finding("src,tests", INPUT_UNREADABLE, "no-source"));
  for (const measure of measures) {
    findings.push(...checkMeasure(measure, input.baseline[measure.path]));
  }
  const measuredPaths = new Set(measures.map((measure) => measure.path));
  for (const path of Object.keys(input.baseline)) {
    if (!measuredPaths.has(path)) findings.push(finding(path, STALE, "missing-file"));
  }
  for (const rename of input.renames) {
    const from = classifyCodeFile(rename.from);
    const to = classifyCodeFile(rename.to);
    if (from !== null && from !== to) {
      findings.push(finding(rename.to, CLASS_CHANGED, `${from}->${to ?? "excluded"}`));
    }
  }
  if (input.previousBaseline !== null) {
    findings.push(...growthAgainstPrevious(input, input.previousBaseline));
  } else {
    findings.push(...initialBaselineFindings(input));
  }
  findings.sort(compareFindings);
  const count = (kind: string) => findings.filter((item) => item.kind === kind).length;
  return {
    ok: findings.length === 0,
    findings,
    summary: {
      checked: measures.length,
      over: count(REQUIRED),
      stale: count(STALE),
      baseline: Object.keys(input.baseline).length,
    },
  };
}

const topicOf = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "split";

/** §7: 超過行数を埋めるまでトップレベルの文を後ろから選ぶ (最低 1 個)。 */
function splitGuidance(measure: CodeMeasure, over: number): string {
  const selected: CodeStatementMeasure[] = [];
  let sum = 0;
  for (let index = measure.topLevel.length - 1; index >= 0; index--) {
    if (selected.length > 0 && sum >= over) break;
    const statement = measure.topLevel[index];
    if (statement === undefined) break;
    selected.unshift(statement);
    sum += statement.lines;
  }
  if (selected.length === 0) return "分ける宣言が無い";
  const list = selected.map((item) => `${item.name} (${item.lines} 行)`).join(", ");
  const topic = topicOf(selected[0]?.name ?? "split");
  if (measure.codeClass === "tests") {
    return `宣言 ${list} を tests/${topic}.test.ts へ分ける`;
  }
  const segments = measure.path.split("/");
  const module = segments.slice(1, -1).join("/") || (segments.at(-1) ?? "").replace(/\.\w+$/, "");
  return `宣言 ${list} を src/${module}/${topic}.ts へ移し、対のテストを tests/${topic}.test.ts へ分ける`;
}

/** §6 / §7: finding を人が読む行にする。末尾に `checked=... over=... stale=... baseline=...` を付ける。 */
export function codeSizeMessages(input: CodeSizeInput, result: CodeSizeResult): string[] {
  const sources = new Map(input.sources.map((source) => [source.path, source]));
  const messages: string[] = [];
  for (const item of result.findings) {
    const source = sources.get(item.path);
    if (item.kind !== REQUIRED || source === undefined) {
      messages.push(`${item.path}:${item.kind}:${item.reason}`);
      continue;
    }
    const measure = measureCodeFile(source);
    const allowed = allowedValues(measure.codeClass, input.baseline[item.path]);
    const excess = measure.functionExcess ?? 0;
    messages.push(
      `${item.path}:${item.kind}:${item.reason} lines=${measure.lines}/${allowed.lines} functionExcess=${excess}/${allowed.functionExcess}`,
    );
    const over = measure.lines - (allowed.lines ?? 0);
    if (over > 0) messages.push(`  ファイル: ${splitGuidance(measure, over)}`);
    if (excess > (allowed.functionExcess ?? 0)) {
      for (const fn of measure.overFunctions) {
        messages.push(
          `  関数: ${fn.name} (${fn.line} 行目、${fn.lines}/${FUNCTION_LIMIT} 行) を helper へ分ける`,
        );
      }
    }
  }
  const { checked, over, stale, baseline } = result.summary;
  messages.push(`checked=${checked} over=${over} stale=${stale} baseline=${baseline}`);
  return messages;
}

const isCount = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseCodeSizeBaseline(sourceText: string): CodeSizeBaseline | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceText);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const baseline: Record<string, CodeSizeBaselineRow> = {};
  for (const [path, value] of Object.entries(parsed)) {
    if (!isRecord(value) || !isCount(value.lines) || !isCount(value.functionExcess)) return null;
    baseline[path] = { lines: value.lines, functionExcess: value.functionExcess };
  }
  return baseline;
}
