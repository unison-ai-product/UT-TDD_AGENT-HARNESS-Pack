/**
 * doc-split gate の純粋関数 (issue #1032)。
 * 契約: docs/design/harness/L6-function-design/doc-split-gate.md (§2 対象と種別、§3 測る量、
 * §4 閾値、§5 baseline、§6 判定規則と finding)。ファイルも git も読まない。I/O は doc-split-inputs.ts。
 */

export type DocClass = "l6-topic" | "l7-topic" | "layer-doc";

export interface DocSplitSource {
  path: string;
  text: string;
}

export interface DocRename {
  from: string;
  to: string;
}

export type DocSplitBaseline = Readonly<
  Record<string, { lines: number; responsibilities: number | null }>
>;

export interface DocSplitInput {
  sources: readonly DocSplitSource[];
  baseline: DocSplitBaseline;
  previousBaseline: DocSplitBaseline | null;
  mergeBaseMeasures: DocSplitBaseline | null;
  renames: readonly DocRename[];
}

export interface DocMeasure {
  path: string;
  docClass: DocClass;
  lines: number;
  responsibilities: number | null;
  names: string[];
}

export interface DocSplitFinding {
  path: string;
  kind: string;
  reason: string;
  message: string;
}

export interface DocSplitSummary {
  checked: number;
  over: number;
  stale: number;
  baseline: number;
}

export interface DocSplitResult {
  ok: boolean;
  findings: DocSplitFinding[];
  summary: DocSplitSummary;
}

type Measured = { lines: number; responsibilities: number | null };

/** §4.2 の閾値 (PO 確定 2026-10-14)。値の変更は設計の改訂として扱う。 */
export const DOC_SPLIT_LIMITS: Readonly<Record<DocClass, Measured>> = {
  "l6-topic": { lines: 400, responsibilities: 16 },
  "l7-topic": { lines: 400, responsibilities: 4 },
  "layer-doc": { lines: 1200, responsibilities: null },
};

const L6_ROOT = "docs/design/harness/L6-function-design/";
const DESIGN_ROOT = "docs/design/harness/";
const TEST_DESIGN_ROOT = "docs/test-design/harness/";
const L7_ID_RE =
  /(?<![A-Za-z0-9-])(?:CANDIDATE-)?[A-Z]+-([A-Z][A-Z0-9]*)(?:-[A-Z0-9]+)*-\d+(?![A-Za-z0-9-])/g;
const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/;

const normalizePath = (path: string): string => path.replaceAll("\\", "/");

export function classifyDoc(path: string): DocClass | null {
  const normalized = normalizePath(path);
  if (!normalized.endsWith(".md")) return null;
  if (normalized.startsWith(L6_ROOT)) return "l6-topic";
  if (normalized.startsWith(TEST_DESIGN_ROOT)) {
    const name = normalized.slice(normalized.lastIndexOf("/") + 1);
    return name.startsWith("L7-") ? "l7-topic" : "layer-doc";
  }
  return normalized.startsWith(DESIGN_ROOT) ? "layer-doc" : null;
}

/** フェンスの外にある行だけを返す (行頭が 3 個のバッククォートの行で開閉する)。 */
function unfencedLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (line.startsWith("```")) inFence = !inFence;
    else if (!inFence) out.push(line);
  }
  return out;
}

/** §3 の責務の名前 (出現順)。l6-topic は レベル 2〜6 の見出し、l7-topic は表の行の ID family。 */
function responsibilityNames(docClass: DocClass, lines: readonly string[]): string[] | null {
  if (docClass === "layer-doc") return null;
  const visible = unfencedLines(lines);
  if (docClass === "l6-topic") {
    return visible.flatMap((line) => {
      const heading = line.match(HEADING_RE);
      return heading && heading[1].length >= 2 ? [heading[2].trim()] : [];
    });
  }
  const families: string[] = [];
  for (const line of visible) {
    if (!line.startsWith("|")) continue;
    for (const match of line.matchAll(L7_ID_RE)) {
      if (!families.includes(match[1])) families.push(match[1]);
    }
  }
  return families;
}

export function measureDoc(source: DocSplitSource): DocMeasure {
  const path = normalizePath(source.path);
  const docClass = classifyDoc(path) ?? "layer-doc";
  const text = source.text.replaceAll("\r\n", "\n");
  const lines = text === "" ? [] : text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const names = responsibilityNames(docClass, lines);
  return {
    path,
    docClass,
    lines: lines.length,
    responsibilities: names === null ? null : names.length,
    names: names ?? [],
  };
}

const exceeds = (value: Measured, limit: Measured): boolean =>
  value.lines > limit.lines ||
  (value.responsibilities !== null &&
    limit.responsibilities !== null &&
    value.responsibilities > limit.responsibilities);

/** baseline の記録値が比較元より緩い。増えた値に加え、数値の責務を null に落とすことも緩和とみなす (§5)。 */
const loosens = (recorded: Measured, bound: Measured): boolean =>
  exceeds(recorded, bound) ||
  (bound.responsibilities !== null && recorded.responsibilities === null);

const isSmaller = (value: Measured, limit: Measured): boolean =>
  value.lines < limit.lines ||
  (value.responsibilities !== null &&
    limit.responsibilities !== null &&
    value.responsibilities < limit.responsibilities);

function kebab(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "topic" : slug;
}

const ratio = (value: number | null, limit: number | null): string =>
  `${value ?? "-"}/${limit ?? "-"}`;

/** §6 の分割指示。分ける責務は出現順の後ろから max(1, 責務の超過個数) 個。 */
function requiredMessage(measure: DocMeasure, reason: string, limit: Measured): string {
  const head = `${measure.path}:doc-split-required:${reason} lines=${ratio(measure.lines, limit.lines)} responsibilities=${ratio(measure.responsibilities, limit.responsibilities)}`;
  if (measure.docClass === "layer-doc") return `${head}\n  責務ごとの文書に分ける`;
  const overBy =
    measure.responsibilities !== null && limit.responsibilities !== null
      ? measure.responsibilities - limit.responsibilities
      : 0;
  const names = measure.names.slice(-Math.max(1, overBy));
  const topic = kebab(names[0] ?? "topic");
  const l7 = `${TEST_DESIGN_ROOT}L7-${topic}-test-design.md`;
  const target =
    measure.docClass === "l7-topic"
      ? `${l7} へ分ける`
      : `${L6_ROOT}${topic}.md と\n  ${l7} へ分ける`;
  return `${head}\n  責務 ${names.join(", ")} を ${target}`;
}

/** finding を作る。メッセージは `<path>:<kind>:<reason>` (doc-split-required だけは呼び出し側で分割指示に差し替える)。 */
export function docSplitFinding(path: string, kind: string, reason: string): DocSplitFinding {
  return { path, kind, reason, message: `${path}:${kind}:${reason}` };
}

/** finding を path、kind、reason の順で一意に並べる (§6)。 */
export function compareDocSplitFindings(left: DocSplitFinding, right: DocSplitFinding): number {
  const a = [left.path, left.kind, left.reason];
  const b = [right.path, right.kind, right.reason];
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

/** §6 の 1・2: 文書ごとの上限と baseline の比較。 */
function documentFindings(
  measures: readonly DocMeasure[],
  baseline: DocSplitBaseline,
): DocSplitFinding[] {
  const findings: DocSplitFinding[] = [];
  for (const measure of measures) {
    const recorded = Object.hasOwn(baseline, measure.path) ? baseline[measure.path] : undefined;
    const limit = DOC_SPLIT_LIMITS[measure.docClass];
    const required = (reason: string, bound: Measured): DocSplitFinding => ({
      ...docSplitFinding(measure.path, "doc-split-required", reason),
      message: requiredMessage(measure, reason, bound),
    });
    if (recorded === undefined) {
      if (exceeds(measure, limit)) findings.push(required("new-doc-over-limit", limit));
    } else if (exceeds(measure, recorded)) {
      findings.push(required("exceeds-baseline", recorded));
    } else if (!exceeds(measure, limit)) {
      findings.push(docSplitFinding(measure.path, "doc-split-stale-baseline", "within-limit"));
    } else if (isSmaller(measure, recorded)) {
      findings.push(docSplitFinding(measure.path, "doc-split-stale-baseline", "shrunk"));
    }
  }
  const present = new Set(measures.map((measure) => measure.path));
  for (const path of Object.keys(baseline)) {
    if (!present.has(path)) {
      findings.push(docSplitFinding(path, "doc-split-stale-baseline", "missing-file"));
    }
  }
  return findings;
}

/** §6 の 3: 種別を変える rename。対象外からの取り込み (from が null) は除く。 */
function classChangeFindings(renames: readonly DocRename[]): DocSplitFinding[] {
  return renames.flatMap((rename) => {
    const from = classifyDoc(rename.from);
    const to = classifyDoc(rename.to);
    if (from === to || (from === null && to !== null)) return [];
    return [docSplitFinding(normalizePath(rename.to), "doc-split-class-changed", `${from}->${to}`)];
  });
}

/** §5 の縮小のみ比較。同じ種別の rename による引き継ぎは行の追加として扱わない。 */
function baselineGrowthFindings(
  input: DocSplitInput,
  previous: DocSplitBaseline,
): DocSplitFinding[] {
  const findings: DocSplitFinding[] = [];
  for (const [path, recorded] of Object.entries(input.baseline)) {
    if (Object.hasOwn(previous, path)) {
      if (loosens(recorded, previous[path])) {
        findings.push(docSplitFinding(path, "doc-split-baseline-grown", "grown"));
      }
      continue;
    }
    const carried = input.renames.some((rename) => {
      const from = normalizePath(rename.from);
      return (
        normalizePath(rename.to) === path &&
        Object.hasOwn(previous, from) &&
        classifyDoc(from) === classifyDoc(path) &&
        !loosens(recorded, previous[from])
      );
    });
    if (!carried) findings.push(docSplitFinding(path, "doc-split-baseline-grown", "added"));
  }
  return findings;
}

/** §5 の初回記録の照合 (previousBaseline = null のとき、merge-base の実測と突き合わせる)。 */
function initialBaselineFindings(
  baseline: DocSplitBaseline,
  mergeBase: DocSplitBaseline,
): DocSplitFinding[] {
  const findings: DocSplitFinding[] = [];
  for (const [path, recorded] of Object.entries(baseline)) {
    const docClass = classifyDoc(path);
    const base = Object.hasOwn(mergeBase, path) ? mergeBase[path] : undefined;
    if (docClass === null || base === undefined || !exceeds(base, DOC_SPLIT_LIMITS[docClass])) {
      findings.push(
        docSplitFinding(path, "doc-split-initial-baseline-new-entry", "not-over-limit-at-base"),
      );
    } else if (loosens(recorded, base)) {
      findings.push(docSplitFinding(path, "doc-split-initial-baseline-grown", "grown-since-base"));
    }
  }
  return findings;
}

function baselineHistoryFindings(input: DocSplitInput): DocSplitFinding[] {
  if (input.previousBaseline !== null) return baselineGrowthFindings(input, input.previousBaseline);
  if (input.mergeBaseMeasures !== null) {
    return initialBaselineFindings(input.baseline, input.mergeBaseMeasures);
  }
  return [];
}

export function analyzeDocSplit(input: DocSplitInput): DocSplitResult {
  const measures = input.sources
    .filter((source) => classifyDoc(source.path) !== null)
    .map(measureDoc);
  const unreadable =
    measures.length === 0
      ? [docSplitFinding(DESIGN_ROOT, "doc-split-input-unreadable", "no-sources")]
      : [];
  const findings = [
    ...unreadable,
    ...documentFindings(measures, input.baseline),
    ...classChangeFindings(input.renames),
    ...baselineHistoryFindings(input),
  ].sort(compareDocSplitFindings);
  const count = (kind: string) => findings.filter((item) => item.kind === kind).length;
  return {
    ok: findings.length === 0,
    findings,
    summary: {
      checked: measures.length,
      over: count("doc-split-required"),
      stale: count("doc-split-stale-baseline"),
      baseline: Object.keys(input.baseline).length,
    },
  };
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

export function parseDocSplitBaseline(sourceText: string): DocSplitBaseline | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceText);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const baseline: Record<string, Measured> = {};
  for (const [path, entry] of Object.entries(parsed)) {
    if (typeof entry !== "object" || entry === null) return null;
    const { lines, responsibilities } = entry as Record<string, unknown>;
    // 責務の数を null にできるのは layer-doc だけ (§5)。topic 文書は非負整数に限る。
    const docClass = classifyDoc(path);
    const topic = docClass === "l6-topic" || docClass === "l7-topic";
    const validResponsibilities =
      isCount(responsibilities) || (responsibilities === null && !topic);
    if (!isCount(lines) || !validResponsibilities) return null;
    baseline[path] = { lines, responsibilities };
  }
  return baseline;
}
