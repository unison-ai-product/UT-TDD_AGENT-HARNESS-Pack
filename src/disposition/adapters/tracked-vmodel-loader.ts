import { createHash } from "node:crypto";
import {
  type AuthoringReceipt,
  verifyAuthoringProvenance,
} from "../domain/authoring-provenance.ts";
import { type CatalogInput, sourceItemEdgeId } from "../domain/document-disposition-catalog.ts";
import { parseStrictMarkdownTable } from "./strict-markdown-table.ts";

export type AuthoringBundle = Readonly<Record<string, Uint8Array>>;
type Row = Readonly<Record<string, string>>;

const paths = {
  manifest: "docs/governance/vmodel-source-manifest.md",
  dispositions: "docs/governance/vmodel-document-disposition-catalog.md",
  semantics: "docs/governance/vmodel-semantic-item-catalog.md",
  sourceTargets: "docs/governance/vmodel-source-target-edges.md",
  itemTargets: "docs/governance/vmodel-item-target-ledger.md",
} as const;

function table(input: {
  bundle: AuthoringBundle;
  path: string;
  headers: string[];
  expectedRows?: number;
}): readonly Row[] {
  const { bundle, path, headers, expectedRows } = input;
  const bytes = bundle[path];
  if (!bytes) throw new Error(`catalog authoring source missing: ${path}`);
  const result = parseStrictMarkdownTable(bytes, {
    subjectId: path,
    expectedHeaders: headers,
    ...(expectedRows === undefined ? {} : { expectedRows }),
  });
  if (!result.ok) throw new Error(JSON.stringify(result.findings));
  return result.rows;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function required(row: Row, key: string): string {
  const value = row[key]?.trim();
  if (!value) throw new Error(`catalog authored value missing: ${key}`);
  return value;
}

function optional(row: Row, key: string): string | undefined {
  const value = row[key]?.trim();
  return value && value !== "—" ? value : undefined;
}

export function loadTrackedCatalogInput(
  bundle: AuthoringBundle,
  receipts: readonly AuthoringReceipt[],
): CatalogInput {
  const provenance = verifyAuthoringProvenance(bundle, receipts);
  if (!provenance.ok) throw new Error(JSON.stringify(provenance.findings));
  const manifestRows = table({ bundle, path: paths.manifest, headers: ["field", "value"] });
  const manifest = new Map(manifestRows.map((row) => [row.field, row.value]));
  const manifestObject = Object.fromEntries(manifest);
  const dispositions = table({
    bundle,
    path: paths.dispositions,
    headers: ["source_id", "source_title", "disposition", "target", "profile / 判断理由"],
  });
  const categories = table({
    bundle,
    path: paths.semantics,
    headers: ["category_id", "category_name"],
  });
  const items = table({
    bundle,
    path: paths.semantics,
    headers: ["item_id", "item_name", "category_id", "source_status", "source_ref", "source_file"],
  });
  const metaSourceMappings = table({
    bundle,
    path: paths.semantics,
    headers: ["meta_source_ref", "allowed_source_status", "source_file_policy", "reason"],
  });
  const sourceTargets = table({
    bundle,
    path: paths.sourceTargets,
    headers: ["edge_id", "source_id", "disposition", "target_type", "target_ref"],
    expectedRows: Number(required(manifestObject, "source_target_edges")),
  });
  const itemTargets = table({
    bundle,
    path: paths.itemTargets,
    headers: [
      "edge_id",
      "item_id",
      "項目名",
      "category_id",
      "source_ref",
      "source_digest",
      "target_status",
      "target_kind",
      "target_ref",
      "判断理由",
      "plan_id",
    ],
  });
  const manifestDigest = digest(manifestRows);
  const sourceItemEdges = items.map((row) => ({
    edgeId: sourceItemEdgeId(row.source_ref, row.item_id),
    sourceId: row.source_ref,
    itemId: row.item_id,
    sourceStatus: row.source_status,
    sourceFile: row.source_file,
    rowDigest: digest(row),
  }));
  return {
    manifestIdentity: {
      auditedOn: required(manifestObject, "audited_on"),
      zipSha256: required(manifestObject, "sha256"),
    },
    declaredCounts: {
      sources: Number(required(manifestObject, "numbered_source_documents")),
      categories: Number(required(manifestObject, "semantic_catalog_categories")),
      metaSourceMappings: metaSourceMappings.length,
      items: Number(required(manifestObject, "semantic_catalog_items")),
      sourceItemEdges: sourceItemEdges.length,
      sourceTargetEdges: Number(required(manifestObject, "source_target_edges")),
      itemTargetEdges: itemTargets.length,
    },
    sources: dispositions.map((row) => ({
      sourceId: row.source_id,
      ordinal: Number(row.source_id.replace("ZIP-DOC-", "")),
      sourceTitle: row.source_title,
      disposition: row.disposition as CatalogInput["sources"][number]["disposition"],
      targetRef: row.target,
      reason: row["profile / 判断理由"],
      rowDigest: digest(row),
      manifestDigest,
    })),
    categories: categories.map((row) => ({
      categoryId: row.category_id,
      categoryName: row.category_name,
      rowDigest: digest(row),
    })),
    metaSourceMappings: metaSourceMappings.map((row) => ({
      metaSourceRef: row.meta_source_ref,
      allowedSourceStatus: row.allowed_source_status,
      sourceFilePolicy: row.source_file_policy as "empty" | "required",
      reason: row.reason,
      rowDigest: digest(row),
    })),
    items: items.map((row) => ({
      itemId: row.item_id,
      itemName: row.item_name,
      categoryId: row.category_id,
      sourceStatus: row.source_status,
      sourceRef: row.source_ref,
      sourceFile: row.source_file,
      rowDigest: digest(row),
    })),
    sourceItemEdges,
    sourceTargetEdges: sourceTargets.map((row) => ({
      edgeId: row.edge_id,
      sourceId: row.source_id,
      disposition: row.disposition as CatalogInput["sourceTargetEdges"][number]["disposition"],
      targetType: row.target_type as CatalogInput["sourceTargetEdges"][number]["targetType"],
      targetRef: row.target_ref,
      rowDigest: digest(row),
    })),
    itemTargetEdges: itemTargets.map((row) => ({
      edgeId: row.edge_id,
      itemId: row.item_id,
      targetStatus: row.target_status as CatalogInput["itemTargetEdges"][number]["targetStatus"],
      reason: row.判断理由,
      sourceDigest: row.source_digest,
      ...(optional(row, "target_kind")
        ? {
            targetKind: optional(
              row,
              "target_kind",
            ) as CatalogInput["itemTargetEdges"][number]["targetKind"],
          }
        : {}),
      ...(optional(row, "target_ref") ? { targetRef: optional(row, "target_ref") } : {}),
      ...(optional(row, "plan_id") ? { planId: optional(row, "plan_id") } : {}),
    })),
  };
}
