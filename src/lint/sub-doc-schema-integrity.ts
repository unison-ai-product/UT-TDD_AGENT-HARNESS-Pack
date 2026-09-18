/**
 * sub-doc-schema-integrity — 設計 doc frontmatter の実 sub_doc 宣言値と schema 正本
 * (`VALID_SUB_DOCS`, src/schema/index.ts) / document-system-map.md の明示カタログを
 * fail-close で 3 者突合する (PLAN-L7-245)。
 *
 * 背景 (A-174 F-5 latent-defect / 2026-07-13 spec-ir triage cluster A、22 件中 18 件):
 * `docs/design/harness/L6-function-design/` 配下 18 件が sub_doc 未宣言、または schema 外の
 * bespoke 値 (`skill-index` / `function-spec-addendum` / `context` / `graph` / `memory` / `secret` /
 * `skill-admission` 等) を独自宣言していた。内容を確認すると全件が既存 function-spec doc
 * (cross-review-enforcement.md / gate-confirm.md / plan-schedule-lint.md 等、6 件) と同型の
 * L6 単体契約 doc (`L6 contract marker` + `pair_artifact: .../L7-unit-test-design.md`) であり、
 * L6 の sub_doc catalog は「関数仕様 doc という artifact *type*」を表す coarse な bucket である
 * (L4 §1b の per-product-artifact 標準成果物カタログとは異なる粒度、§1b-1 grounding)。
 *
 * 方式判断 (TL、PLAN-L7-245 Step 2): **方式 b (artifact_role 区別で吸収) を採用**。
 * sub_doc は schema 正本値 (`function-spec`) に統一し、元の bespoke 値/未宣言だった topic 識別は
 * `artifact_role: topic_<name>` (L2 の `artifact_role: supplemental_*` 系 frontmatter と同型の
 * non-schema free-form メタデータ) で保持する。方式 a (`VALID_SUB_DOCS.L6` へ 18 件を正式登録) を
 * 採らない理由: (1) 登録すると既存 `sub-doc-catalog-drift` gate (schema ↔ 要件 v1.2 §G.1 mirror、
 * `tests/sub-doc-catalog-drift.test.ts` U-SDCD-007 real-repo regression) が要件側未同期で即座に
 * fail-close する — 要件 v1.2 の更新は本 PLAN の許諾編集面の外。(2) 18 件は実装機構ごとに 1 file の
 * 単体契約 doc であり、per-topic の enumerable catalog (L4 §1b 型) ではなく、既存 6 件と同じ
 * many-docs-per-one-schema-value の慣行に合わせる方が schema の無制限増殖を防ぐ。
 *
 * 3 者:
 *  1. 実 doc frontmatter の `sub_doc` 宣言値 (docs/design/harness/** の design doc、メタ doc
 *     `doc_type: index` / `verification-roadmap` は catalog 実体でないため除外)
 *  2. schema 正本 (`VALID_SUB_DOCS`)
 *  3. document-system-map.md の明示カタログ: L4 は §1b の per-slug table (`architecture` は
 *     方式設計 §0 の別区分として §1b 外部設計カタログの対象外、既知の exemption)。L6 は
 *     enumerable catalog を持たない代わりに §1b-1 の bucket 方針ノートを正本とし、その存在を検証する。
 *
 * 純関数 (analyzeSubDocSchemaIntegrity) + I/O loader (loadSubDocSchemaIntegrityInput) を分離
 * (lint 共通様式、architecture §3.2)。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { isValidSubDocForLayer, VALID_SUB_DOCS } from "../schema/index.ts";
import { normalizePath } from "./shared.ts";

export const DESIGN_DOC_ROOT = "docs/design/harness";
export const DOCUMENT_SYSTEM_MAP_PATH = "docs/governance/document-system-map.md";

/** メタ doc (index / verification-roadmap) は catalog 実体でないため sub_doc 検証対象外 (PLAN-L7-429 cluster B と同じ除外条件)。 */
const META_DOC_TYPES = new Set(["index", "verification-roadmap"]);

/** VALID_SUB_DOCS を持つ設計層のみ対象 (L1-L6)。 */
const DESIGN_LAYERS = new Set(Object.keys(VALID_SUB_DOCS));

/**
 * L4 §1b: 外部設計 標準成果物カタログの per-slug table。`architecture` (方式設計、§0 で L4 とは
 * 別区分と grounding 済) は §1b の対象外として明示 exempt する (§1b 前文「残る標準成果物」参照)。
 */
export const L4_MAP_CATALOG_EXEMPT: ReadonlySet<string> = new Set(["architecture"]);

/** L6 の sub_doc bucket 方針 (§1b-1) が document-system-map.md に存在することを示す marker 文字列。 */
export const L6_BUCKET_POLICY_MARKER = "L6 機能設計 sub_doc の粒度";

export interface DesignDocFrontmatter {
  path: string;
  layer?: string;
  subDoc?: string;
  docType?: string;
}

export interface SubDocSchemaIntegrityInput {
  docs: DesignDocFrontmatter[];
  schema: Record<string, readonly string[]>;
  mapDocText: string;
}

export type SubDocSchemaIntegrityIssueKind =
  | "undeclared_sub_doc"
  | "invalid_sub_doc"
  | "l4_map_catalog_drift"
  | "l6_bucket_policy_missing";

export interface SubDocSchemaIntegrityViolation {
  kind: SubDocSchemaIntegrityIssueKind;
  path: string;
  layer?: string;
  subDoc?: string;
  detail: string;
}

export interface SubDocSchemaIntegrityResult {
  checked: number;
  skippedMeta: number;
  violations: SubDocSchemaIntegrityViolation[];
  ok: boolean;
}

function fmValue(content: string, key: string): string | undefined {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const block = m ? m[1] : "";
  return block.match(new RegExp(`^${key}:\\s*(.+?)\\s*(?:#.*)?$`, "m"))?.[1]?.trim();
}

/** design doc md を frontmatter (layer/sub_doc/doc_type) へ分解する。 */
export function parseDesignDocFrontmatter(path: string, content: string): DesignDocFrontmatter {
  return {
    path,
    layer: fmValue(content, "layer"),
    subDoc: fmValue(content, "sub_doc"),
    docType: fmValue(content, "doc_type"),
  };
}

/**
 * §1b セクション本文 (`### §1b` 〜 次見出し `## §1c`) から「L4 sub_doc slug」列 (backtick 値) を抽出する。
 */
export function parseL4MapCatalog(mapDocText: string): string[] {
  const start = mapDocText.indexOf("### §1b");
  if (start < 0) return [];
  const rest = mapDocText.slice(start);
  const end = rest.indexOf("\n## §1c");
  const section = end < 0 ? rest : rest.slice(0, end);
  const slugs: string[] = [];
  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
    const slugCell = cells[1] ?? "";
    const m = slugCell.match(/`([a-z][a-z0-9-]*)`/);
    if (m) slugs.push(m[1]);
  }
  return [...new Set(slugs)];
}

function walkMarkdown(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of entries.sort()) {
    const full = join(root, name);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) files.push(...walkMarkdown(full));
    else if (stat.isFile() && name.endsWith(".md")) files.push(full);
  }
  return files;
}

export function loadSubDocSchemaIntegrityInput(
  repoRoot: string = process.cwd(),
): SubDocSchemaIntegrityInput {
  const root = join(repoRoot, ...DESIGN_DOC_ROOT.split("/"));
  const docs = walkMarkdown(root).map((absPath) => {
    const relPath = normalizePath(relative(repoRoot, absPath));
    return parseDesignDocFrontmatter(relPath, readFileSync(absPath, "utf8"));
  });
  let mapDocText = "";
  try {
    mapDocText = readFileSync(join(repoRoot, DOCUMENT_SYSTEM_MAP_PATH), "utf8");
  } catch {
    mapDocText = "";
  }
  return { docs, schema: VALID_SUB_DOCS as Record<string, readonly string[]>, mapDocText };
}

/** doc frontmatter ↔ schema ↔ document-system-map を fail-close で 3 者突合する。 */
export function analyzeSubDocSchemaIntegrity(
  input: SubDocSchemaIntegrityInput,
): SubDocSchemaIntegrityResult {
  const violations: SubDocSchemaIntegrityViolation[] = [];
  let checked = 0;
  let skippedMeta = 0;

  for (const doc of input.docs) {
    if (!doc.layer || !DESIGN_LAYERS.has(doc.layer)) continue;
    if (doc.docType && META_DOC_TYPES.has(doc.docType)) {
      skippedMeta += 1;
      continue;
    }
    checked += 1;
    if (!doc.subDoc) {
      violations.push({
        kind: "undeclared_sub_doc",
        path: doc.path,
        layer: doc.layer,
        detail: `${doc.path}: sub_doc frontmatter 未宣言 (${doc.layer} 設計 doc は schema 有効値を宣言せよ)`,
      });
      continue;
    }
    if (!isValidSubDocForLayer(doc.layer, doc.subDoc)) {
      violations.push({
        kind: "invalid_sub_doc",
        path: doc.path,
        layer: doc.layer,
        subDoc: doc.subDoc,
        detail: `${doc.path}: sub_doc "${doc.subDoc}" は VALID_SUB_DOCS[${doc.layer}] 外 (schema 外値)`,
      });
    }
  }

  // leg 3a: L4 §1b の per-slug table ↔ schema (architecture は方式設計として exempt)。
  const schemaL4 = new Set(input.schema.L4 ?? []);
  const mapL4 = new Set(parseL4MapCatalog(input.mapDocText));
  const schemaOnly = [...schemaL4]
    .filter((v) => !mapL4.has(v) && !L4_MAP_CATALOG_EXEMPT.has(v))
    .sort();
  const mapOnly = [...mapL4].filter((v) => !schemaL4.has(v)).sort();
  for (const v of schemaOnly) {
    violations.push({
      kind: "l4_map_catalog_drift",
      path: DOCUMENT_SYSTEM_MAP_PATH,
      layer: "L4",
      subDoc: v,
      detail: `L4 sub_doc "${v}" は schema にあるが document-system-map.md §1b table に記載が無い`,
    });
  }
  for (const v of mapOnly) {
    violations.push({
      kind: "l4_map_catalog_drift",
      path: DOCUMENT_SYSTEM_MAP_PATH,
      layer: "L4",
      subDoc: v,
      detail: `L4 sub_doc "${v}" は document-system-map.md §1b table にあるが schema (VALID_SUB_DOCS.L4) に無い`,
    });
  }

  // leg 3b: L6 は enumerable catalog を持たず、bucket 方針ノート (§1b-1) の存在を正本とする。
  if (!input.mapDocText.includes(L6_BUCKET_POLICY_MARKER)) {
    violations.push({
      kind: "l6_bucket_policy_missing",
      path: DOCUMENT_SYSTEM_MAP_PATH,
      layer: "L6",
      detail: `document-system-map.md に L6 sub_doc bucket 方針ノート ("${L6_BUCKET_POLICY_MARKER}") が見つからない`,
    });
  }

  return { checked, skippedMeta, violations, ok: violations.length === 0 };
}

export function subDocSchemaIntegrityMessages(r: SubDocSchemaIntegrityResult): string[] {
  if (r.ok) {
    return [
      `sub-doc-schema-integrity — OK (checked=${r.checked}, meta skipped=${r.skippedMeta}, doc↔schema↔map drift 0)`,
    ];
  }
  const sample = r.violations
    .slice(0, 24)
    .map((v) => `${v.kind}: ${v.detail}`)
    .join("; ");
  return [
    `sub-doc-schema-integrity — violation ${r.violations.length} 件: ${sample} ` +
      `(PLAN-L7-245 3 者突合: doc frontmatter ↔ VALID_SUB_DOCS ↔ document-system-map)`,
  ];
}
