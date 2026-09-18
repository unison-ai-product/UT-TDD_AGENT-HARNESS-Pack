import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseStrictMarkdownTable } from "../../src/disposition/adapters/strict-markdown-table.ts";
import { loadTrackedCatalogInput } from "../../src/disposition/adapters/tracked-vmodel-loader.ts";
import { gitBlobOid } from "../../src/disposition/domain/authoring-provenance.ts";
import { DocumentDispositionCatalog } from "../../src/disposition/domain/document-disposition-catalog.ts";

const read = (path: string) => readFileSync(path);

function rows(path: string, headers: string[], expected?: number) {
  const result = parseStrictMarkdownTable(read(path), {
    subjectId: path,
    expectedHeaders: headers,
    ...(expected === undefined ? {} : { expectedRows: expected }),
  });
  expect(result.ok, result.ok ? undefined : JSON.stringify(result.findings)).toBe(true);
  if (!result.ok) throw new Error(result.findings[0]?.message);
  return result.rows;
}

describe("tracked checked V-model authoring loader", () => {
  it("loads all six authored sources without silent row omission", () => {
    const manifest = rows("docs/governance/vmodel-source-manifest.md", ["field", "value"]);
    expect(manifest.find((row) => row.field === "numbered_source_documents")?.value).toBe("109");
    expect(manifest.find((row) => row.field === "semantic_catalog_categories")?.value).toBe("21");
    expect(manifest.find((row) => row.field === "semantic_catalog_items")?.value).toBe("163");

    rows(
      "docs/governance/vmodel-document-disposition-catalog.md",
      ["source_id", "source_title", "disposition", "target", "profile / 判断理由"],
      109,
    );
    rows("docs/governance/vmodel-semantic-item-catalog.md", ["category_id", "category_name"], 21);
    rows(
      "docs/governance/vmodel-semantic-item-catalog.md",
      ["item_id", "item_name", "category_id", "source_status", "source_ref", "source_file"],
      163,
    );
    const sourceTargets = rows("docs/governance/vmodel-source-target-edges.md", [
      "edge_id",
      "source_id",
      "disposition",
      "target_type",
      "target_ref",
    ]);
    expect(sourceTargets.length).toBeGreaterThanOrEqual(109);
    rows(
      "docs/governance/vmodel-item-target-ledger.md",
      [
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
      163,
    );
    rows(
      "docs/governance/vmodel-document-scale-profiles.md",
      [
        "profile_id",
        "profile_axis",
        "profile_rank",
        "description",
        "default_status",
        "default_detail",
        "scope_policy",
      ],
      8,
    );
    const decisions = rows("docs/governance/vmodel-document-scale-profiles.md", [
      "profile_id",
      "doc_type_id",
      "decision",
      "detail_override",
      "status_override",
      "reason",
      "required_plan_id",
    ]);
    expect(decisions.length).toBeGreaterThan(0);
  });

  it("constructs the tracked 109/21/163 catalog without deriving item targets", () => {
    const authoringPaths = [
      "docs/governance/vmodel-source-manifest.md",
      "docs/governance/vmodel-document-disposition-catalog.md",
      "docs/governance/vmodel-semantic-item-catalog.md",
      "docs/governance/vmodel-source-target-edges.md",
      "docs/governance/vmodel-item-target-ledger.md",
    ];
    const bundle = Object.fromEntries(authoringPaths.map((path) => [path, read(path)]));
    const receipts = authoringPaths.map((path) => ({
      path,
      blobOid: gitBlobOid(bundle[path]),
      contentDigest: createHash("sha256").update(bundle[path]).digest("hex"),
      sourceCommit: "a".repeat(40),
    }));
    const input = loadTrackedCatalogInput(bundle, receipts);
    expect(input.declaredCounts).toMatchObject({ sources: 109, categories: 21, items: 163 });
    const result = DocumentDispositionCatalog.create(input);
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.errors.slice(0, 5))).toBe(true);
    if (!result.ok) return;
    expect(result.value.unresolved()).toHaveLength(163);

    const tampered = {
      ...bundle,
      [authoringPaths[0]]: Buffer.concat([bundle[authoringPaths[0]], Buffer.from("\n")]),
    };
    expect(() => loadTrackedCatalogInput(tampered, receipts)).toThrow("catalog-provenance-invalid");
  });
});
