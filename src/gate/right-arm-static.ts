import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { extractAcIds, extractAtIds, extractL3FrIds, extractL3NfrIds } from "../lint/g3-trace.ts";
import {
  parseG8IntegrationEvidenceManifest,
  validateG8IntegrationEvidenceManifest,
} from "../lint/g8-integration-workflow.ts";
import { readGateAssetText } from "../lint/gate-confirm.ts";
import { fmValue } from "../lint/shared.ts";
import { resolveAuthoringSourceAbsolutePath } from "../shared/design-root.ts";
import { designLayerFromPath, loadPairDocs } from "../vmodel/lint.ts";
import {
  loadCompiledRightArmRegistry,
  VMODEL_CONTRACT_PATH,
} from "../vmodel-contract/adapters/yaml-contract-loader.ts";
import type { CompiledVerificationObligation } from "../vmodel-contract/application/contract-compiler.ts";

interface CaseRow {
  id: string;
  citations: string;
  family?: string;
}

interface CheckCaseIdsInput {
  rows: readonly CaseRow[];
  prefix: string;
  content: string;
  violations: string[];
}

interface CheckManifestInput {
  repoRoot: string;
  absolutePath: string;
  evidenceDirectory: string;
  obligation: CompiledVerificationObligation;
  caseIds: ReadonlySet<string>;
  g11RequirementIds?: ReadonlySet<string>;
  deferCaseIdField: "it_id" | "st_id" | "uxv_id" | "uat_id" | "at_id" | "smoke_id";
  violations: string[];
}

type JsonRecord = Record<string, unknown>;

const REQUIRED_G8_HEADINGS = [
  "# DOC-L8-INTEGRATION-TEST-DESIGN: 結合テスト設計書",
  "#### 第1章 テスト方針",
  "#### 第2章 テスト観点",
  "#### 第3章 テストケース一覧",
  "#### 第4章 不具合・判定基準",
  "##### 4-1 重要度定義",
  "##### 4-2 不具合記録",
] as const;
const REQUIRED_G8_CASE_COLUMNS = [
  "テストID",
  "分類",
  "テスト項目",
  "検証内容/手順",
  "期待結果",
  "トレース元",
] as const;
const REQUIRED_G9_HEADINGS = [
  "# DOC-L9-SYSTEM-TEST-DESIGN: 総合テスト設計書 / セキュリティテスト計画・脆弱性診断書",
  "#### 第1章 テスト方針",
  "##### 1-1 目的・範囲",
  "##### 1-2 トレース元",
  "##### 1-3 合否基準",
  "##### 1-4 テスト環境",
  "#### 第2章 テスト観点",
  "#### 第3章 テストケース一覧",
  "#### 第4章 不具合・判定基準",
  "##### 4-1 重要度定義",
  "##### 4-2 不具合記録",
  "#### 第1章 方針・診断フェーズ",
  "##### 1-2 診断の独立性",
  "#### 第2章 診断チェックリスト(OWASP Top 10 2021)",
  "#### 第3章 API・マルチテナント診断",
  "#### 第4章 LLM・AIエージェント診断(OWASP LLM Top 10 抜粋)",
  "#### 第5章 判定基準・対応SLA",
  "##### 5-1 エグジット基準",
  "#### 第6章 実施計画・記録",
] as const;
const REQUIRED_G9_CASE_COLUMNS = [...REQUIRED_G8_CASE_COLUMNS.slice(0, -1), "family", "トレース元"];
const REQUIRED_G10_HEADINGS = [
  "# DOC-L10-UX-VALIDATION: 画面検証(UIテスト)設計",
  "#### 第1章 方針",
  "#### 第2章 検証レベル・種別",
  "#### 第3章 E2Eシナリオ",
  "#### 第4章 ビジュアルリグレッション",
  "#### 第5章 クロスブラウザ・レスポンシブ",
  "#### 第6章 アクセシビリティ検証",
  "#### 第7章 テストデータ・環境",
  "#### 第8章 CI連携・合否",
] as const;
const REQUIRED_G10_CASE_COLUMNS = ["No", "シナリオ", "対象画面", "期待"] as const;
const REQUIRED_G11_HEADINGS = [
  "# DOC-L11-TRACE-UAT: 検証設計書 (+ traceability.yaml のトレース俯瞰)",
  "#### 第1章 検証方針・方式",
  "#### 第2章 検証マトリクス",
  "#### 第3章 テスト設計技法カタログ",
  "#### 第4章 テストデータ設計",
  "#### 第5章 カバレッジ基準",
  "#### 第6章 リスクベーステスト",
  "#### 第7章 エントリ/エグジット基準",
  "#### 第8章 契約テスト(CDC)",
] as const;
const REQUIRED_G11_CASE_COLUMNS = ["要件", "検証方式", "テストレベル", "技法", "ケースID"] as const;
const REQUIRED_G12_HEADINGS = [
  "# DOC-L12-ACCEPTANCE: 受入テスト設計書",
  "#### 第1章 テスト方針",
  "##### 1-1 目的・範囲",
  "##### 1-2 トレース元",
  "##### 1-3 合否基準",
  "##### 1-4 テスト環境",
  "#### 第2章 テスト観点",
  "#### 第3章 テストケース一覧",
  "#### 第4章 不具合・判定基準",
  "##### 4-1 重要度定義",
  "##### 4-2 不具合記録",
] as const;
const REQUIRED_G13_CASE_COLUMNS = ["ケースID", "観測内容", "合否基準", "トレース元"] as const;
const G13_CASE_HEADING = "### harness 追補: G13 検証ケース";
const REQUIRED_G13_HEADINGS = [
  "# DOC-L13-PRODUCTION-OBSERVATION: 運用設計書 (監視・後検証節) / ログ・トレース設計書",
  "#### 第1章 運用方針",
  "#### 第2章 監視設計",
  "##### 2-1 監視指標(SLI)とアラート",
  "#### 第3章 SLO/SLA・エラーバジェット",
  "##### 3-1 SLI/SLO",
  "##### 3-2 エラーバジェット",
  "##### 3-3 エラーバジェットポリシー",
  "##### 3-4 SLA(対顧客)",
  "#### 第4章 バックアップ/リストア",
  "##### 4-1 方式",
  "##### 4-2 リストア運用",
  "#### 第5章 障害対応・ランブック",
  "##### 5-1 重大度とエスカレーション",
  "##### 5-2 ランブック(抜粋)",
  "#### 第6章 リリース/ロールバック",
  "##### 6-1 リリース方式",
  "##### 6-2 ロールバック",
  "#### 第7章 キャパシティ/コスト",
  "#### 第1章 ログ方針",
  "#### 第2章 ログ種別一覧",
  "#### 第3章 共通ログ項目",
  "#### 第4章 ログレベル方針",
  "#### 第5章 構造化フォーマット",
  "#### 第6章 分散トレース設計",
  "#### 第7章 保管・マスキング",
  "#### 第8章 監視連携",
] as const;
const REQUIRED_L2_SCREEN_COLUMNS = ["画面ID", "画面名称", "概要", "関連機能", "ロール"] as const;
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function tableCells(line: string): string[] {
  return line
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim().replace(/\*\*/g, ""));
}

function parseG8CaseRows(content: string, violations: string[]): CaseRow[] {
  for (const heading of REQUIRED_G8_HEADINGS) {
    if (!content.includes(heading)) violations.push(`missing section ${heading}`);
  }
  const lines = content.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => {
    const cells = tableCells(line);
    return REQUIRED_G8_CASE_COLUMNS.every((column) => cells.includes(column));
  });
  if (headerIndex < 0) {
    violations.push("missing section 第3章 テストケース一覧: required case table columns");
    return [];
  }
  const header = tableCells(lines[headerIndex] ?? "");
  const idIndex = header.indexOf("テストID");
  const citationIndex = header.indexOf("トレース元");
  const rows: CaseRow[] = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.trimStart().startsWith("|")) break;
    const cells = tableCells(line);
    const id = cells[idIndex] ?? "";
    if (!id || id.startsWith("<")) continue;
    rows.push({ id, citations: cells[citationIndex] ?? "" });
  }
  if (rows.length === 0) violations.push("missing section 第3章 テストケース一覧: case rows");
  return rows;
}

function parseG9CaseRows(content: string, violations: string[]): CaseRow[] {
  for (const heading of REQUIRED_G9_HEADINGS) {
    if (!content.includes(heading)) violations.push(`missing section ${heading}`);
  }
  const lines = content.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => {
    const cells = tableCells(line);
    return REQUIRED_G9_CASE_COLUMNS.every((column) => cells.includes(column));
  });
  if (headerIndex < 0) {
    violations.push("missing section 第3章 テストケース一覧: required case table columns");
    return [];
  }
  const header = tableCells(lines[headerIndex] ?? "");
  const idIndex = header.indexOf("テストID");
  const citationIndex = header.indexOf("トレース元");
  const familyIndex = header.indexOf("family");
  const rows: CaseRow[] = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.trimStart().startsWith("|")) break;
    const cells = tableCells(line);
    const id = cells[idIndex] ?? "";
    if (!id || id.startsWith("<")) continue;
    rows.push({
      id,
      citations: cells[citationIndex] ?? "",
      family: cells[familyIndex] ?? "",
    });
  }
  if (rows.length === 0) violations.push("missing section 第3章 テストケース一覧: case rows");
  return rows;
}

function parseG10CaseRows(content: string, violations: string[]): CaseRow[] {
  for (const heading of REQUIRED_G10_HEADINGS) {
    if (!content.includes(heading)) violations.push(`missing section ${heading}`);
  }
  const lines = content.split(/\r?\n/);
  const chapterIndex = lines.findIndex((line) => line.trim() === "#### 第3章 E2Eシナリオ");
  const nextChapterIndex =
    chapterIndex < 0
      ? -1
      : lines.findIndex(
          (line, index) => index > chapterIndex && /^#### 第[1-8]章 /.test(line.trim()),
        );
  const chapterLines =
    chapterIndex < 0
      ? []
      : lines.slice(chapterIndex + 1, nextChapterIndex < 0 ? undefined : nextChapterIndex);
  const headerIndex = chapterLines.findIndex((line) => {
    const cells = tableCells(line);
    return REQUIRED_G10_CASE_COLUMNS.every((column) => cells.includes(column));
  });
  if (headerIndex < 0) {
    violations.push("missing section 第3章 E2Eシナリオ: required case table columns");
    return [];
  }
  const header = tableCells(chapterLines[headerIndex] ?? "");
  const idIndex = header.indexOf("No");
  const screenIndex = header.indexOf("対象画面");
  const rows: CaseRow[] = [];
  for (const line of chapterLines.slice(headerIndex + 2)) {
    if (!line.trimStart().startsWith("|")) break;
    const cells = tableCells(line);
    const id = cells[idIndex] ?? "";
    if (!id || id.startsWith("<")) continue;
    rows.push({ id, citations: cells[screenIndex] ?? "" });
  }
  if (rows.length === 0) violations.push("missing section 第3章 E2Eシナリオ: case rows");
  return rows;
}

function parseG11CaseRows(content: string, violations: string[]): CaseRow[] {
  for (const heading of REQUIRED_G11_HEADINGS) {
    if (!content.includes(heading)) violations.push(`missing section ${heading}`);
  }
  const lines = content.split(/\r?\n/);
  const chapterIndex = lines.findIndex((line) => line.trim() === "#### 第2章 検証マトリクス");
  const nextChapterIndex =
    chapterIndex < 0
      ? -1
      : lines.findIndex(
          (line, index) => index > chapterIndex && /^#### 第[1-8]章 /.test(line.trim()),
        );
  const chapterLines =
    chapterIndex < 0
      ? []
      : lines.slice(chapterIndex + 1, nextChapterIndex < 0 ? undefined : nextChapterIndex);
  const headerIndex = chapterLines.findIndex((line) => {
    const cells = tableCells(line);
    return REQUIRED_G11_CASE_COLUMNS.every((column) => cells.includes(column));
  });
  if (headerIndex < 0) {
    violations.push("missing section 第2章 検証マトリクス: required case table columns");
    return [];
  }
  const header = tableCells(chapterLines[headerIndex] ?? "");
  const idIndex = header.indexOf("ケースID");
  const citationIndex = header.indexOf("要件");
  const rows: CaseRow[] = [];
  for (const line of chapterLines.slice(headerIndex + 2)) {
    if (!line.trimStart().startsWith("|")) break;
    const cells = tableCells(line);
    const id = cells[idIndex] ?? "";
    if (!id || id.startsWith("<")) continue;
    rows.push({ id, citations: cells[citationIndex] ?? "" });
  }
  if (rows.length === 0) violations.push("missing section 第2章 検証マトリクス: case rows");
  return rows;
}

function parseG12CaseRows(content: string, violations: string[]): CaseRow[] {
  for (const heading of REQUIRED_G12_HEADINGS) {
    if (!content.includes(heading)) violations.push(`missing section ${heading}`);
  }
  const lines = content.split(/\r?\n/);
  const chapterIndex = lines.findIndex((line) => line.trim() === "#### 第3章 テストケース一覧");
  const nextChapterIndex =
    chapterIndex < 0
      ? -1
      : lines.findIndex(
          (line, index) => index > chapterIndex && /^#### 第[1-4]章 /.test(line.trim()),
        );
  const chapterLines =
    chapterIndex < 0
      ? []
      : lines.slice(chapterIndex + 1, nextChapterIndex < 0 ? undefined : nextChapterIndex);
  const headerIndex = chapterLines.findIndex((line) => {
    const cells = tableCells(line);
    return REQUIRED_G8_CASE_COLUMNS.every((column) => cells.includes(column));
  });
  if (headerIndex < 0) {
    violations.push("missing section 第3章 テストケース一覧: required case table columns");
    return [];
  }
  const header = tableCells(chapterLines[headerIndex] ?? "");
  const idIndex = header.indexOf("テストID");
  const citationIndex = header.indexOf("トレース元");
  const rows: CaseRow[] = [];
  for (const line of chapterLines.slice(headerIndex + 2)) {
    if (!line.trimStart().startsWith("|")) break;
    const cells = tableCells(line);
    const id = cells[idIndex] ?? "";
    if (!id || id.startsWith("<")) continue;
    rows.push({ id, citations: cells[citationIndex] ?? "" });
  }
  if (rows.length === 0) violations.push("missing section 第3章 テストケース一覧: case rows");
  return rows;
}

function parseG13CaseRows(content: string, violations: string[]): CaseRow[] {
  for (const heading of REQUIRED_G13_HEADINGS) {
    if (!content.includes(heading)) violations.push(`missing section ${heading}`);
  }
  const lines = content.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => line.trim() === G13_CASE_HEADING);
  if (headingIndex < 0) {
    violations.push(`missing section ${G13_CASE_HEADING}`);
    return [];
  }
  const nextHeadingIndex = lines.findIndex(
    (line, index) => index > headingIndex && /^#{1,6} /.test(line.trim()),
  );
  const section = lines.slice(
    headingIndex + 1,
    nextHeadingIndex < 0 ? undefined : nextHeadingIndex,
  );
  const headerIndex = section.findIndex((line) => {
    const cells = tableCells(line);
    return REQUIRED_G13_CASE_COLUMNS.every((column) => cells.includes(column));
  });
  if (headerIndex < 0) {
    violations.push(`missing section ${G13_CASE_HEADING}: required case table columns`);
    return [];
  }
  const header = tableCells(section[headerIndex] ?? "");
  const idIndex = header.indexOf("ケースID");
  const citationIndex = header.indexOf("トレース元");
  const rows: CaseRow[] = [];
  for (const line of section.slice(headerIndex + 2)) {
    if (!line.trimStart().startsWith("|")) break;
    const cells = tableCells(line);
    const id = cells[idIndex] ?? "";
    if (!id || id.startsWith("<")) continue;
    rows.push({ id, citations: cells[citationIndex] ?? "" });
  }
  if (rows.length === 0) violations.push(`missing section ${G13_CASE_HEADING}: case rows`);
  return rows;
}

function g8SlotContent(
  repoRoot: string,
  obligation: CompiledVerificationObligation,
): string | null {
  const slot = resolveAuthoringSourceAbsolutePath(repoRoot, obligation.governanceArtifact);
  if (!existsSync(slot)) return null;
  const content = readFileSync(slot, "utf8");
  return fmValue(content, "doc_type_id") === "DOC-L8-INTEGRATION-TEST-DESIGN" ? content : null;
}

function g9SlotContent(
  repoRoot: string,
  obligation: CompiledVerificationObligation,
): string | null {
  const slot = resolveAuthoringSourceAbsolutePath(repoRoot, obligation.governanceArtifact);
  if (!existsSync(slot)) return null;
  const content = readFileSync(slot, "utf8");
  return fmValue(content, "doc_type_id") === "DOC-L9-SYSTEM-TEST-DESIGN" ? content : null;
}

function g10SlotContent(
  repoRoot: string,
  obligation: CompiledVerificationObligation,
): string | null {
  const slot = resolveAuthoringSourceAbsolutePath(repoRoot, obligation.governanceArtifact);
  if (!existsSync(slot)) return null;
  const content = readFileSync(slot, "utf8");
  return fmValue(content, "doc_type_id") === "DOC-L10-UX-VALIDATION" ? content : null;
}

function g11SlotContent(
  repoRoot: string,
  obligation: CompiledVerificationObligation,
): string | null {
  const slot = resolveAuthoringSourceAbsolutePath(repoRoot, obligation.governanceArtifact);
  if (!existsSync(slot)) return null;
  const content = readFileSync(slot, "utf8");
  return fmValue(content, "doc_type_id") === "DOC-L11-TRACE-UAT" ? content : null;
}

function g12SlotContent(
  repoRoot: string,
  obligation: CompiledVerificationObligation,
): string | null {
  const slot = resolveAuthoringSourceAbsolutePath(repoRoot, obligation.governanceArtifact);
  if (!existsSync(slot)) return null;
  const content = readFileSync(slot, "utf8");
  return fmValue(content, "doc_type_id") === "DOC-L12-ACCEPTANCE" ? content : null;
}

function g13SlotContent(
  repoRoot: string,
  obligation: CompiledVerificationObligation,
): string | null {
  const slot = resolveAuthoringSourceAbsolutePath(repoRoot, obligation.governanceArtifact);
  if (!existsSync(slot)) return null;
  const content = readFileSync(slot, "utf8");
  return fmValue(content, "doc_type_id") === "DOC-L13-PRODUCTION-OBSERVATION" ? content : null;
}

function g11L3Texts(
  repoRoot: string,
  docs = loadPairDocs(repoRoot),
): {
  functional: string;
  businessDetail: string;
  nfrGrade: string;
} {
  const texts = { functional: "", businessDetail: "", nfrGrade: "" };
  for (const doc of docs) {
    if (!doc.content || designLayerFromPath(doc.path) !== "L3") continue;
    if (basename(doc.path) === "functional-requirements.md") texts.functional = doc.content;
    else if (basename(doc.path) === "business-detail.md") texts.businessDetail = doc.content;
    else if (basename(doc.path) === "nfr-grade.md") texts.nfrGrade = doc.content;
  }
  return texts;
}

function g11RequirementIds(texts: ReturnType<typeof g11L3Texts>): Set<string> {
  const { functional, nfrGrade } = texts;
  return new Set([...extractL3FrIds(functional), ...extractL3NfrIds(nfrGrade)]);
}

function g11CitationIds(texts: ReturnType<typeof g11L3Texts>): Set<string> {
  const { functional, businessDetail, nfrGrade } = texts;
  return new Set([
    ...extractL3FrIds(functional),
    ...extractAcIds(functional, businessDetail, nfrGrade),
  ]);
}

function pairLayerIds(
  repoRoot: string,
  pairLayers: readonly string[],
  docs = loadPairDocs(repoRoot),
): Set<string> {
  const ids = new Set<string>();
  for (const doc of docs) {
    const layer = designLayerFromPath(doc.path);
    if (!doc.content || !layer || !pairLayers.includes(layer)) continue;
    const docTypeId = fmValue(doc.content, "doc_type_id");
    if (docTypeId) ids.add(docTypeId);
    for (const match of doc.content.matchAll(/\*\*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\*\*/g)) {
      ids.add(match[1] as string);
    }
  }
  return ids;
}

function g12L3HeadingIds(docs: ReturnType<typeof loadPairDocs>): Set<string> {
  const l3Contents = new Map<string, string>();
  for (const doc of docs) {
    if (!doc.content || designLayerFromPath(doc.path) !== "L3") continue;
    const name = basename(doc.path);
    if (
      name === "functional-requirements.md" ||
      name === "business-detail.md" ||
      name === "nfr-grade.md"
    ) {
      l3Contents.set(name, doc.content);
    }
  }
  const functional = l3Contents.get("functional-requirements.md") ?? "";
  const business = l3Contents.get("business-detail.md") ?? "";
  const nfr = l3Contents.get("nfr-grade.md") ?? "";
  return new Set([...extractL3FrIds(functional), ...extractAcIds(functional, business, nfr)]);
}

function allDesignIds(repoRoot: string): Set<string> {
  const ids = new Set<string>();
  for (const doc of loadPairDocs(repoRoot)) {
    if (!doc.content) continue;
    const docTypeId = fmValue(doc.content, "doc_type_id");
    if (docTypeId) ids.add(docTypeId);
    for (const match of doc.content.matchAll(/\*\*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\*\*/g)) {
      ids.add(match[1] as string);
    }
  }
  return ids;
}

function l2ScreenIds(repoRoot: string): Set<string> {
  const ids = new Set<string>();
  for (const doc of loadPairDocs(repoRoot)) {
    if (!doc.content || designLayerFromPath(doc.path) !== "L2") continue;
    if (fmValue(doc.content, "doc_type_id") !== "DOC-L2-SCREEN") continue;
    const lines = doc.content.split(/\r?\n/);
    const sectionIndex = lines.findIndex((line) => line.trim() === "#### 第4章 画面一覧");
    if (sectionIndex < 0) continue;
    const sectionLines = lines.slice(sectionIndex + 1);
    const headerOffset = sectionLines.findIndex((line) => {
      const cells = tableCells(line);
      return REQUIRED_L2_SCREEN_COLUMNS.every((column) => cells.includes(column));
    });
    if (headerOffset < 0) continue;
    const idIndex = tableCells(sectionLines[headerOffset] ?? "").indexOf("画面ID");
    for (const line of sectionLines.slice(headerOffset + 2)) {
      if (!line.trimStart().startsWith("|")) break;
      const id = stringValue(tableCells(line)[idIndex]);
      if (id && !id.startsWith("<")) ids.add(id);
    }
  }
  return ids;
}

function checkCaseIds({ rows, prefix, content, violations }: CheckCaseIdsInput): void {
  const defined = new Set<string>();
  for (const { id } of rows) {
    if (!id.startsWith(prefix)) violations.push(`case id must start with ${prefix}: ${id}`);
    if (defined.has(id)) violations.push(`duplicate case id ${id}`);
    defined.add(id);
  }
  const pattern = new RegExp(`\\b${prefix}[A-Z0-9][A-Z0-9-]*\\b`, "g");
  for (const match of content.matchAll(pattern)) {
    if (!defined.has(match[0])) violations.push(`dangling reference ${match[0]}`);
  }
}

function checkCaseTraces(
  rows: readonly CaseRow[],
  pairIds: ReadonlySet<string>,
  violations: string[],
): void {
  for (const row of rows) {
    const citedIds = [...row.citations.matchAll(/\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\b/g)].map(
      (match) => match[0],
    );
    if (citedIds.length === 0) {
      violations.push(`untraced case ${row.id}`);
      continue;
    }
    for (const id of citedIds) {
      if (!pairIds.has(id)) violations.push(`trace target missing ${id}`);
    }
  }
}

function checkG13CaseTraces(
  rows: readonly CaseRow[],
  atIds: ReadonlySet<string>,
  violations: string[],
): void {
  for (const row of rows) {
    const citedIds = [...row.citations.matchAll(/\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\b/g)].map(
      (match) => match[0],
    );
    const untraced = !citedIds.some((id) => atIds.has(id));
    for (const id of citedIds) {
      if (atIds.has(id)) continue;
      violations.push(`trace target missing ${id}`);
    }
    if (untraced) violations.push(`untraced case ${row.id}`);
  }
}

function checkG9CaseTraces({
  rows,
  pairIds,
  definedIds,
  violations,
}: {
  rows: readonly CaseRow[];
  pairIds: ReadonlySet<string>;
  definedIds: ReadonlySet<string>;
  violations: string[];
}): void {
  for (const row of rows) {
    const citedIds = [...row.citations.matchAll(/\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\b/g)].map(
      (match) => match[0],
    );
    if (!citedIds.some((id) => pairIds.has(id))) {
      violations.push(`untraced case ${row.id}`);
    }
    for (const id of citedIds) {
      if (!definedIds.has(id)) violations.push(`trace target missing ${id}`);
    }
  }
}

function checkG9Families(
  rows: readonly CaseRow[],
  evidenceFamilies: readonly string[],
  violations: string[],
): void {
  const found = new Set<string>();
  for (const row of rows) {
    const family = stringValue(row.family);
    if (!evidenceFamilies.includes(family)) {
      violations.push(`invalid evidence family ${family || "<empty>"} for ${row.id}`);
    } else {
      found.add(family);
    }
  }
  for (const family of evidenceFamilies) {
    if (!found.has(family)) violations.push(`missing evidence family ${family}`);
  }
}

function manifestFiles(repoRoot: string, evidenceDirectory: string): string[] {
  const absoluteDirectory = resolve(repoRoot, evidenceDirectory);
  if (!existsSync(absoluteDirectory)) return [];
  return readdirSync(absoluteDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(absoluteDirectory, entry.name))
    .sort();
}

function manifestPath(repoRoot: string, absolutePath: string): string {
  return relative(repoRoot, absolutePath).replaceAll("\\", "/");
}

function resolveRepoFile(repoRoot: string, path: unknown): string | null {
  const value = stringValue(path);
  if (!value || value.includes("\\") || isAbsolute(value)) return null;
  const absolutePath = resolve(repoRoot, value);
  const rel = relative(repoRoot, absolutePath);
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
    return null;
  return absolutePath;
}

function parseG9EvidenceManifest(path: string, raw: unknown) {
  if (!isRecord(raw)) return parseG8IntegrationEvidenceManifest(path, raw);
  const commands = Array.isArray(raw.commands)
    ? raw.commands.map((command) =>
        isRecord(command) ? { ...command, it_ids: command.st_ids } : command,
      )
    : raw.commands;
  const coverage = Array.isArray(raw.coverage)
    ? raw.coverage.map((entry) => (isRecord(entry) ? { ...entry, it_id: entry.st_id } : entry))
    : raw.coverage;
  return parseG8IntegrationEvidenceManifest(path, {
    ...raw,
    selected_it_ids: raw.selected_st_ids,
    mandatory_it_ids: raw.mandatory_st_ids,
    deferred_it_ids: raw.deferred_st_ids,
    commands,
    coverage,
  });
}

function parseG10EvidenceManifest(path: string, raw: unknown) {
  if (!isRecord(raw)) return parseG8IntegrationEvidenceManifest(path, raw);
  const commands = Array.isArray(raw.commands)
    ? raw.commands.map((command) =>
        isRecord(command) ? { ...command, it_ids: command.uxv_ids } : command,
      )
    : raw.commands;
  const coverage = Array.isArray(raw.coverage)
    ? raw.coverage.map((entry) => (isRecord(entry) ? { ...entry, it_id: entry.uxv_id } : entry))
    : raw.coverage;
  return parseG8IntegrationEvidenceManifest(path, {
    ...raw,
    selected_it_ids: raw.selected_uxv_ids,
    mandatory_it_ids: raw.mandatory_uxv_ids,
    deferred_it_ids: raw.deferred_uxv_ids,
    commands,
    coverage,
  });
}

function parseG11EvidenceManifest(path: string, raw: unknown) {
  if (!isRecord(raw)) return parseG8IntegrationEvidenceManifest(path, raw);
  const commands = Array.isArray(raw.commands)
    ? raw.commands.map((command) =>
        isRecord(command) ? { ...command, it_ids: command.uat_ids } : command,
      )
    : raw.commands;
  const coverage = Array.isArray(raw.coverage)
    ? raw.coverage.map((entry) => (isRecord(entry) ? { ...entry, it_id: entry.uat_id } : entry))
    : raw.coverage;
  return parseG8IntegrationEvidenceManifest(path, {
    ...raw,
    selected_it_ids: raw.selected_uat_ids,
    mandatory_it_ids: raw.mandatory_uat_ids,
    deferred_it_ids: raw.deferred_uat_ids,
    commands,
    coverage,
  });
}

function parseG12EvidenceManifest(path: string, raw: unknown) {
  if (!isRecord(raw)) return parseG8IntegrationEvidenceManifest(path, raw);
  const commands = Array.isArray(raw.commands)
    ? raw.commands.map((command) =>
        isRecord(command) ? { ...command, it_ids: command.at_ids } : command,
      )
    : raw.commands;
  const coverage = Array.isArray(raw.coverage)
    ? raw.coverage.map((entry) => (isRecord(entry) ? { ...entry, it_id: entry.at_id } : entry))
    : raw.coverage;
  return parseG8IntegrationEvidenceManifest(path, {
    ...raw,
    selected_it_ids: raw.selected_at_ids,
    mandatory_it_ids: raw.mandatory_at_ids,
    deferred_it_ids: raw.deferred_at_ids,
    commands,
    coverage,
  });
}

function parseG13EvidenceManifest(path: string, raw: unknown) {
  if (!isRecord(raw)) return parseG8IntegrationEvidenceManifest(path, raw);
  const commands = Array.isArray(raw.commands)
    ? raw.commands.map((command) =>
        isRecord(command) ? { ...command, it_ids: command.smoke_ids } : command,
      )
    : raw.commands;
  const coverage = Array.isArray(raw.coverage)
    ? raw.coverage.map((entry) => (isRecord(entry) ? { ...entry, it_id: entry.smoke_id } : entry))
    : raw.coverage;
  return parseG8IntegrationEvidenceManifest(path, {
    ...raw,
    selected_it_ids: raw.selected_smoke_ids,
    mandatory_it_ids: raw.mandatory_smoke_ids,
    deferred_it_ids: raw.deferred_smoke_ids,
    commands,
    coverage,
  });
}

interface ReadArtifactObjectInput {
  repoRoot: string;
  manifestPath: string;
  artifacts: JsonRecord;
  key: string;
  violations: string[];
}

function readArtifactObject({
  repoRoot,
  manifestPath,
  artifacts,
  key,
  violations,
}: ReadArtifactObjectInput): JsonRecord | null {
  const absolutePath = resolveRepoFile(repoRoot, artifacts[key]);
  if (!absolutePath || !existsSync(absolutePath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(absolutePath, "utf8"));
    if (isRecord(parsed)) return parsed;
  } catch {
    // Report the same closed artifact-shape diagnostic for unreadable and non-object JSON.
  }
  violations.push(`${manifestPath}: invalid artifact ${key}: JSON object required`);
  return null;
}

function validateG11Artifacts({
  repoRoot,
  manifestPath,
  artifacts,
  requirementIds,
  violations,
}: {
  repoRoot: string;
  manifestPath: string;
  artifacts: JsonRecord;
  requirementIds: ReadonlySet<string>;
  violations: string[];
}): void {
  const traceReview = readArtifactObject({
    repoRoot,
    manifestPath,
    key: "end_to_end_trace_review",
    artifacts,
    violations,
  });
  if (requirementIds.size === 0) {
    violations.push("no requirement ids defined in DOC-L3-FUNCTIONAL");
  }
  if (traceReview) {
    const entries = Array.isArray(traceReview.requirements) ? traceReview.requirements : [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!isRecord(entry)) {
        violations.push(`${manifestPath}: invalid trace review requirement entry`);
        continue;
      }
      const requirementId = entry.requirement_id;
      if (typeof requirementId !== "string" || !requirementId) {
        violations.push(`${manifestPath}: invalid trace review requirement_id`);
        continue;
      }
      const keys = Object.keys(entry);
      if (
        keys.length !== 2 ||
        !Object.hasOwn(entry, "requirement_id") ||
        !Object.hasOwn(entry, "status")
      ) {
        violations.push(`${manifestPath}: invalid trace review requirement ${requirementId}`);
      }
      if (!requirementIds.has(requirementId)) {
        violations.push(
          `${manifestPath}: trace review references undefined requirement ${requirementId}`,
        );
      }
      if (seen.has(requirementId)) {
        violations.push(`${manifestPath}: duplicate trace requirement ${requirementId}`);
      }
      seen.add(requirementId);
      const status = entry.status;
      if (status !== "traced" && status !== "blocked") {
        violations.push(
          `${manifestPath}: invalid trace status ${requirementId}: ${String(status)}`,
        );
      } else if (status === "blocked") {
        violations.push(`${manifestPath}: blocked requirement ${requirementId}`);
      }
    }
    for (const requirementId of requirementIds) {
      if (!seen.has(requirementId)) {
        violations.push(`${manifestPath}: untraced requirement ${requirementId}`);
      }
    }
  }

  const decision = readArtifactObject({
    repoRoot,
    manifestPath,
    key: "po_uat_decision",
    artifacts,
    violations,
  });
  if (!decision) return;
  if (decision.decision !== "accept" && decision.decision !== "reject") {
    violations.push(
      `${manifestPath}: invalid po_uat_decision.decision ${String(decision.decision)}`,
    );
  } else if (decision.decision === "reject") {
    violations.push(`${manifestPath}: po_uat_decision.decision is reject`);
  }
  if (typeof decision.decided_by_role !== "string" || !decision.decided_by_role.trim()) {
    violations.push(`${manifestPath}: po_uat_decision.decided_by_role is required`);
  }
  if (typeof decision.revision !== "string" || !/^[0-9a-f]{40}$/i.test(decision.revision)) {
    violations.push(`${manifestPath}: invalid po_uat_decision.revision`);
  }
}

interface CheckG12ArtifactsInput {
  repoRoot: string;
  manifestPath: string;
  artifacts: JsonRecord;
  violations: string[];
}

function checkG12Artifacts({
  repoRoot,
  manifestPath,
  artifacts,
  violations,
}: CheckG12ArtifactsInput): void {
  const deployReceipt = readArtifactObject({
    repoRoot,
    manifestPath,
    artifacts,
    key: "deploy_receipt",
    violations,
  });
  if (deployReceipt) {
    if (
      typeof deployReceipt.revision !== "string" ||
      !/^[0-9a-fA-F]{40}$/.test(deployReceipt.revision)
    ) {
      violations.push(`${manifestPath}: invalid deploy_receipt.revision`);
    }
    if (!stringValue(deployReceipt.environment)) {
      violations.push(`${manifestPath}: deploy_receipt.environment is required`);
    }
  }
  const rollbackReadiness = readArtifactObject({
    repoRoot,
    manifestPath,
    artifacts,
    key: "rollback_readiness",
    violations,
  });
  if (rollbackReadiness) {
    if (!stringValue(rollbackReadiness.rollback_command)) {
      violations.push(`${manifestPath}: rollback_readiness.rollback_command is required`);
    }
    const verifiedAt = stringValue(rollbackReadiness.verified_at);
    const hasTimezone =
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        verifiedAt,
      );
    if (!hasTimezone || !Number.isFinite(Date.parse(verifiedAt))) {
      violations.push(`${manifestPath}: invalid rollback_readiness.verified_at`);
    }
  }
}

function checkG13Artifacts({
  repoRoot,
  manifestPath,
  artifacts,
  violations,
}: CheckG12ArtifactsInput): void {
  const observation = readArtifactObject({
    repoRoot,
    manifestPath,
    artifacts,
    key: "sli_slo_observation",
    violations,
  });
  if (observation) {
    const parseTimestamp = (value: unknown): number | null => {
      const timestamp = stringValue(value);
      if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
          timestamp,
        )
      ) {
        return null;
      }
      const parsed = Date.parse(timestamp);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const windowStart = parseTimestamp(observation.window_start);
    const windowEnd = parseTimestamp(observation.window_end);
    if (windowStart === null) {
      violations.push(`${manifestPath}: invalid sli_slo_observation.window_start`);
    }
    if (windowEnd === null) {
      violations.push(`${manifestPath}: invalid sli_slo_observation.window_end`);
    } else if (windowStart !== null && windowEnd <= windowStart) {
      violations.push(`${manifestPath}: sli_slo_observation window is not closed`);
    }
    if (!Array.isArray(observation.slos) || observation.slos.length === 0) {
      violations.push(`${manifestPath}: sli_slo_observation.slos is required`);
    } else {
      const seenSloIds = new Set<string>();
      for (const [index, entry] of observation.slos.entries()) {
        if (!isRecord(entry)) {
          violations.push(`${manifestPath}: invalid sli_slo_observation.slo`);
          continue;
        }
        const sloId = stringValue(entry.slo_id);
        if (!sloId) {
          violations.push(`${manifestPath}: sli_slo_observation.slos[${index}].slo_id is required`);
        } else if (seenSloIds.has(sloId)) {
          violations.push(`${manifestPath}: duplicate slo ${sloId}`);
        }
        seenSloIds.add(sloId);
        if (
          !(typeof entry.target === "string" && entry.target.trim()) &&
          !(typeof entry.target === "number" && Number.isFinite(entry.target))
        ) {
          violations.push(
            `${manifestPath}: sli_slo_observation.slos[${sloId || "<empty>"}].target is required`,
          );
        }
        const observed = entry.observed;
        if (
          (typeof observed !== "string" && typeof observed !== "number") ||
          (typeof observed === "string" && !observed.trim()) ||
          (typeof observed === "number" && !Number.isFinite(observed))
        ) {
          violations.push(
            `${manifestPath}: sli_slo_observation.slos[${sloId || "<empty>"}].observed is required`,
          );
        }
      }
    }
  }

  const rollbackDecision = readArtifactObject({
    repoRoot,
    manifestPath,
    artifacts,
    key: "rollback_decision",
    violations,
  });
  if (
    rollbackDecision &&
    rollbackDecision.decision !== "keep" &&
    rollbackDecision.decision !== "rollback"
  ) {
    violations.push(
      `${manifestPath}: invalid rollback_decision.decision ${String(rollbackDecision.decision)}`,
    );
  }
}

function checkManifest({
  repoRoot,
  absolutePath,
  evidenceDirectory,
  obligation,
  caseIds,
  g11RequirementIds,
  deferCaseIdField,
  violations,
}: CheckManifestInput): { mandatoryIds: Set<string>; deferredIds: Set<string> } {
  const path = manifestPath(repoRoot, absolutePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolutePath, "utf8")) as unknown;
  } catch {
    violations.push(`${path}: invalid JSON`);
    return { mandatoryIds: new Set(), deferredIds: new Set() };
  }
  if (!isRecord(parsed)) {
    violations.push(`${path}: manifest must be an object`);
    return { mandatoryIds: new Set(), deferredIds: new Set() };
  }
  const evidence =
    obligation.gate === "G11"
      ? parseG11EvidenceManifest(path, parsed)
      : obligation.gate === "G12"
        ? parseG12EvidenceManifest(path, parsed)
        : obligation.gate === "G13"
          ? parseG13EvidenceManifest(path, parsed)
          : obligation.gate === "G10"
            ? parseG10EvidenceManifest(path, parsed)
            : obligation.gate === "G9"
              ? parseG9EvidenceManifest(path, parsed)
              : parseG8IntegrationEvidenceManifest(path, parsed);
  violations.push(
    ...validateG8IntegrationEvidenceManifest(evidence, repoRoot, {
      gate: obligation.gate,
      schemaVersion: `${basename(evidenceDirectory)}-evidence-v1`,
      doctorCheck: `${basename(evidenceDirectory)}-workflow`,
    }),
  );
  const mandatoryIds = new Set(evidence.mandatory_it_ids);
  const deferredIds = new Set(evidence.deferred_it_ids);
  const selectedIds = new Set(evidence.selected_it_ids);
  for (const id of selectedIds) {
    if (!caseIds.has(id)) violations.push(`${path}: evidence references undefined case ${id}`);
  }
  for (const id of [...mandatoryIds, ...deferredIds]) {
    if (!caseIds.has(id)) violations.push(`${path}: evidence references undefined case ${id}`);
  }
  for (const id of deferredIds) {
    const deferEntries = Array.isArray(evidence.defer) ? evidence.defer : [];
    const defer = deferEntries.find((entry) => isRecord(entry) && entry[deferCaseIdField] === id);
    if (!isRecord(defer) || !stringValue(defer.reason) || !stringValue(defer.plan_id)) {
      violations.push(`${path}: stale defer ${id}`);
      continue;
    }
    const planId = stringValue(defer.plan_id);
    if (
      !/^PLAN-[A-Z0-9-]+$/.test(planId) ||
      !existsSync(join(repoRoot, "docs", "plans", `${planId}.md`))
    ) {
      violations.push(`${path}: stale defer ${id}`);
    }
  }
  const artifacts = isRecord(evidence.artifacts) ? evidence.artifacts : {};
  for (const key of obligation.requiredArtifacts) {
    const artifactPath = resolveRepoFile(repoRoot, artifacts[key]);
    if (!artifactPath || !existsSync(artifactPath)) {
      violations.push(`${path}: missing artifact ${key}`);
    }
  }
  if (obligation.gate === "G11") {
    validateG11Artifacts({
      repoRoot,
      manifestPath: path,
      artifacts,
      requirementIds: g11RequirementIds ?? new Set(),
      violations,
    });
  } else if (obligation.gate === "G12") {
    checkG12Artifacts({ repoRoot, manifestPath: path, artifacts, violations });
  } else if (obligation.gate === "G13") {
    checkG13Artifacts({ repoRoot, manifestPath: path, artifacts, violations });
  }
  return { mandatoryIds, deferredIds };
}

export function evaluateRightArmStaticGate(
  gate: string,
  repoRoot: string,
): {
  passed: boolean;
  messages: string[];
} {
  const key = gate.trim().toUpperCase();
  if (
    key !== "G8" &&
    key !== "G9" &&
    key !== "G10" &&
    key !== "G11" &&
    key !== "G12" &&
    key !== "G13"
  ) {
    return {
      passed: false,
      messages: [`right-arm-static - violation: no evaluator for ${key}`],
    };
  }
  const registry = loadCompiledRightArmRegistry(
    repoRoot,
    readGateAssetText(repoRoot, VMODEL_CONTRACT_PATH),
  );
  const obligation = registry.obligations.find((entry) => entry.gate === key);
  if (!obligation) {
    return {
      passed: false,
      messages: [`right-arm-static - violation: contract has no obligation for ${key}`],
    };
  }
  const violations: string[] = [];
  let g11Ids: Set<string> | undefined;
  const slot =
    key === "G11"
      ? g11SlotContent(repoRoot, obligation)
      : key === "G12"
        ? g12SlotContent(repoRoot, obligation)
        : key === "G13"
          ? g13SlotContent(repoRoot, obligation)
          : key === "G10"
            ? g10SlotContent(repoRoot, obligation)
            : key === "G9"
              ? g9SlotContent(repoRoot, obligation)
              : g8SlotContent(repoRoot, obligation);
  const slotDocTypeId =
    key === "G11"
      ? "DOC-L11-TRACE-UAT"
      : key === "G12"
        ? "DOC-L12-ACCEPTANCE"
        : key === "G13"
          ? "DOC-L13-PRODUCTION-OBSERVATION"
          : key === "G10"
            ? "DOC-L10-UX-VALIDATION"
            : key === "G9"
              ? "DOC-L9-SYSTEM-TEST-DESIGN"
              : "DOC-L8-INTEGRATION-TEST-DESIGN";
  if (!slot) violations.push(`missing slot ${slotDocTypeId}`);
  const content = slot ?? "";
  const rows =
    key === "G11"
      ? parseG11CaseRows(content, violations)
      : key === "G12"
        ? parseG12CaseRows(content, violations)
        : key === "G13"
          ? parseG13CaseRows(content, violations)
          : key === "G10"
            ? parseG10CaseRows(content, violations)
            : key === "G9"
              ? parseG9CaseRows(content, violations)
              : parseG8CaseRows(content, violations);
  const caseIds = new Set(rows.map((row) => row.id));
  checkCaseIds({
    rows,
    prefix: obligation.caseIdPrefix,
    content,
    violations,
  });
  const pairDocs = key === "G11" || key === "G12" ? loadPairDocs(repoRoot) : undefined;
  const pairIds =
    key === "G13" ? new Set<string>() : pairLayerIds(repoRoot, obligation.pairLayers, pairDocs);
  if (key === "G11") {
    const texts = g11L3Texts(repoRoot, pairDocs);
    g11Ids = g11RequirementIds(texts);
    const citationIds = g11CitationIds(texts);
    for (const id of citationIds) pairIds.add(id);
    const definedIds = allDesignIds(repoRoot);
    for (const id of citationIds) definedIds.add(id);
    checkG9CaseTraces({ rows, pairIds, definedIds, violations });
  } else if (key === "G12") {
    for (const id of g12L3HeadingIds(pairDocs ?? [])) pairIds.add(id);
    checkCaseTraces(rows, pairIds, violations);
  } else if (key === "G13") {
    const l12Path = resolveAuthoringSourceAbsolutePath(
      repoRoot,
      "docs/test-design/harness/L12-acceptance-test-design.md",
    );
    const atIds = existsSync(l12Path)
      ? extractAtIds(readFileSync(l12Path, "utf8"))
      : new Set<string>();
    checkG13CaseTraces(rows, atIds, violations);
  } else if (key === "G10") {
    if (fmValue(content, "status") === "skipped") {
      violations.push(
        "skipped slot DOC-L10-UX-VALIDATION: no consumer profile-selection authority (VMC-005)",
      );
    }
    checkCaseTraces(rows, l2ScreenIds(repoRoot), violations);
  } else if (key === "G9") {
    checkG9CaseTraces({ rows, pairIds, definedIds: allDesignIds(repoRoot), violations });
    checkG9Families(rows, obligation.evidenceFamilies, violations);
  } else {
    checkCaseTraces(rows, pairIds, violations);
  }
  const evidenceDirectory = dirname(obligation.evidenceManifest).replaceAll("\\", "/");
  const files = manifestFiles(repoRoot, evidenceDirectory);
  if (files.length === 0) violations.push(`evidence manifest missing under ${evidenceDirectory}`);
  const evidenced = new Set<string>();
  for (const file of files) {
    const manifestResult = checkManifest({
      repoRoot,
      absolutePath: file,
      evidenceDirectory,
      obligation,
      caseIds,
      g11RequirementIds: g11Ids,
      deferCaseIdField:
        key === "G11"
          ? "uat_id"
          : key === "G12"
            ? "at_id"
            : key === "G13"
              ? "smoke_id"
              : key === "G10"
                ? "uxv_id"
                : key === "G9"
                  ? "st_id"
                  : "it_id",
      violations,
    });
    for (const id of [...manifestResult.mandatoryIds, ...manifestResult.deferredIds])
      evidenced.add(id);
  }
  for (const id of caseIds) {
    if (!evidenced.has(id)) violations.push(`missing row evidence ${id}`);
  }
  const messages =
    violations.length > 0
      ? [`right-arm-static - violation: ${violations.join("; ")}`]
      : [`right-arm-static - OK (${key}, cases=${caseIds.size}, manifests=${files.length})`];
  messages.push(`未判定 (review): ${obligation.approvalRole}`);
  return { passed: violations.length === 0, messages };
}
