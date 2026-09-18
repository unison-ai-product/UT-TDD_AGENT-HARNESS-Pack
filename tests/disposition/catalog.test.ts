import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type CatalogInput,
  DocumentDispositionCatalog,
  sourceItemEdgeId,
} from "../../src/disposition/domain/document-disposition-catalog.ts";

const digest = (seed: string) => createHash("sha256").update(seed).digest("hex");

function fixture(): CatalogInput {
  return {
    manifestIdentity: { auditedOn: "2026-07-10", zipSha256: digest("zip") },
    declaredCounts: {
      sources: 1,
      items: 1,
      categories: 1,
      metaSourceMappings: 0,
      sourceItemEdges: 1,
      sourceTargetEdges: 1,
      itemTargetEdges: 1,
    },
    sources: [
      {
        sourceId: "ZIP-DOC-001",
        ordinal: 1,
        sourceTitle: "企画書",
        disposition: "merge",
        targetRef: "PLAN-L0-01",
        reason: "上流企画へ統合",
        rowDigest: digest("source"),
        manifestDigest: digest("manifest"),
      },
    ],
    categories: [{ categoryId: "plan", categoryName: "企画・要求", rowDigest: digest("cat") }],
    metaSourceMappings: [],
    items: [
      {
        itemId: "kikaku",
        itemName: "企画書",
        categoryId: "plan",
        sourceStatus: "done",
        sourceRef: "ZIP-DOC-001",
        sourceFile: "01_企画書",
        rowDigest: digest("item"),
      },
    ],
    sourceItemEdges: [
      {
        edgeId: sourceItemEdgeId("ZIP-DOC-001", "kikaku"),
        sourceId: "ZIP-DOC-001",
        itemId: "kikaku",
        sourceStatus: "done",
        sourceFile: "01_企画書",
        rowDigest: digest("source-item"),
      },
    ],
    sourceTargetEdges: [
      {
        edgeId: "SOURCE-TARGET-001",
        sourceId: "ZIP-DOC-001",
        targetType: "plan_alias",
        targetRef: "PLAN-L0-01",
        disposition: "merge",
        rowDigest: digest("source-target"),
      },
    ],
    itemTargetEdges: [
      {
        edgeId: "ITEM-TARGET-KIKAKU",
        itemId: "kikaku",
        targetStatus: "pending_review",
        reason: "PO/TL review待ち",
        sourceDigest: digest("item-target"),
        planId: "PLAN-L7-417-source-disposition-profile-projection",
      },
    ],
  };
}

function rules(input: CatalogInput): string[] {
  const result = DocumentDispositionCatalog.create(input);
  return result.ok ? [] : result.errors.map((finding) => finding.ruleId);
}

describe("DocumentDispositionCatalog", () => {
  it("U-DISP-001: 宣言件数とrecordsが一致し、queryはdigestを変更しない", () => {
    const result = DocumentDispositionCatalog.create(fixture());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const before = result.value.digest;
    const trace = result.value.traceSource("ZIP-DOC-001");
    expect(trace).toMatchObject({
      source: { sourceId: "ZIP-DOC-001" },
      items: [{ itemId: "kikaku" }],
      sourceTargets: [{ edgeId: "SOURCE-TARGET-001" }],
      itemTargets: [{ edgeId: "ITEM-TARGET-KIKAKU" }],
    });
    if (trace) trace.source.sourceTitle = "外部mutation";
    expect(result.value.traceSource("ZIP-DOC-001")?.source.sourceTitle).toBe("企画書");
    expect(result.value.unresolved().map((finding) => finding.subjectId)).toEqual(["kikaku"]);
    expect(result.value.unresolved()[0]).toMatchObject({
      ruleId: "catalog-item-target-pending",
      severity: "warning",
    });
    expect(result.value.digest).toBe(before);
  });

  it.each([
    ["sources", "sources"],
    ["items", "items"],
    ["categories", "categories"],
    ["metaSourceMappings", "metaSourceMappings"],
    ["sourceItemEdges", "sourceItemEdges"],
    ["sourceTargetEdges", "sourceTargetEdges"],
    ["itemTargetEdges", "itemTargetEdges"],
  ] as const)("U-DISP-002: %sの宣言件数不一致を拒否する", (_label, dimension) => {
    const input = fixture();
    input.declaredCounts[dimension] += 1;
    expect(rules(input)).toContain("catalog-count-mismatch");
  });

  it.each([
    ["item-category", (input: CatalogInput) => (input.items[0].categoryId = "missing")],
    ["item-source", (input: CatalogInput) => (input.items[0].sourceRef = "ZIP-DOC-999")],
    [
      "source-item-source",
      (input: CatalogInput) => (input.sourceItemEdges[0].sourceId = "ZIP-DOC-999"),
    ],
    ["source-item-item", (input: CatalogInput) => (input.sourceItemEdges[0].itemId = "missing")],
    [
      "source-target",
      (input: CatalogInput) => (input.sourceTargetEdges[0].sourceId = "ZIP-DOC-999"),
    ],
    ["item-target", (input: CatalogInput) => (input.itemTargetEdges[0].itemId = "missing")],
  ])("U-DISP-003: %s orphanを拒否する", (_label, mutate) => {
    const input = fixture();
    mutate(input);
    expect(rules(input)).toContain("catalog-orphan-edge");
  });

  it("U-DISP-003: source-item edge欠落を拒否する", () => {
    const input = fixture();
    input.sourceItemEdges = [];
    input.declaredCounts.sourceItemEdges = 0;
    expect(rules(input)).toContain("catalog-orphan-edge");
  });

  it("U-DISP-003: source-target edge欠落を宣言件数と無関係に拒否する", () => {
    const input = fixture();
    input.sourceTargetEdges = [];
    input.declaredCounts.sourceTargetEdges = 0;
    expect(rules(input)).toContain("catalog-source-target-incomplete");
  });

  it("U-DISP-003: 派生edge identityとsource disposition不一致を拒否する", () => {
    const identity = fixture();
    identity.sourceItemEdges[0].edgeId = "invented";
    expect(rules(identity)).toContain("catalog-edge-identity-invalid");

    const disposition = fixture();
    disposition.sourceTargetEdges[0].disposition = "adopt";
    expect(rules(disposition)).toContain("catalog-source-target-mismatch");
  });

  it("U-DISP-004: item ledger row欠落をsource-targetから補完しない", () => {
    const input = fixture();
    input.itemTargetEdges = [];
    input.declaredCounts.itemTargetEdges = 0;
    expect(rules(input)).toContain("catalog-item-target-incomplete");
  });

  it("U-DISP-004: source dispositionの理由欠落を拒否する", () => {
    const input = fixture();
    input.sources[0].reason = "";
    expect(rules(input)).toContain("catalog-disposition-incomplete");
  });

  it("U-DISP-004: runtime enum、ordinal、digest不整合を拒否する", () => {
    const input = fixture();
    input.sources[0].disposition = "unknown" as "merge";
    input.sources[0].ordinal = 999;
    input.items[0].rowDigest = "not-a-digest";
    input.sourceTargetEdges[0].targetType = "unknown" as "plan_alias";
    input.itemTargetEdges[0].targetStatus = "unknown" as "pending_review";
    expect(rules(input)).toEqual(
      expect.arrayContaining([
        "catalog-authoring-enum-invalid",
        "catalog-authoring-digest-invalid",
      ]),
    );
  });

  it.each([
    [
      "pending target",
      (edge: CatalogInput["itemTargetEdges"][number]) => (edge.targetRef = "PLAN-L0-01"),
    ],
    [
      "final target",
      (edge: CatalogInput["itemTargetEdges"][number]) => {
        edge.targetStatus = "merge";
        edge.targetKind = undefined;
        edge.targetRef = undefined;
      },
    ],
    ["reason", (edge: CatalogInput["itemTargetEdges"][number]) => (edge.reason = "")],
    ["digest", (edge: CatalogInput["itemTargetEdges"][number]) => (edge.sourceDigest = "")],
  ])("U-DISP-004: item targetの不完全な%sを拒否する", (_label, mutate) => {
    const input = fixture();
    mutate(input.itemTargetEdges[0]);
    expect(rules(input)).toContain("catalog-item-target-incomplete");
  });

  it.each([
    "sourceItemEdges",
    "sourceTargetEdges",
    "itemTargetEdges",
  ] as const)("U-DISP-005: %sのedge ID重複を拒否する", (dimension) => {
    const input = fixture();
    input[dimension].push({ ...input[dimension][0] } as never);
    input.declaredCounts[dimension] += 1;
    expect(rules(input)).toContain("catalog-edge-duplicate");
  });

  it.each([
    [
      "source ID",
      (input: CatalogInput) => input.sources.push({ ...input.sources[0], ordinal: 2 }),
      "sources",
    ],
    [
      "source ordinal",
      (input: CatalogInput) => input.sources.push({ ...input.sources[0], sourceId: "ZIP-DOC-002" }),
      "sources",
    ],
    [
      "category",
      (input: CatalogInput) => input.categories.push({ ...input.categories[0] }),
      "categories",
    ],
    ["item", (input: CatalogInput) => input.items.push({ ...input.items[0] }), "items"],
  ] as const)("U-DISP-005: %s重複を拒否する", (_label, mutate, dimension) => {
    const input = fixture();
    mutate(input);
    input.declaredCounts[dimension] += 1;
    expect(rules(input).some((rule) => rule.endsWith("-duplicate"))).toBe(true);
  });

  it("findingとdigestは入力順に依存しない", () => {
    const input = fixture();
    input.sources.push({ ...input.sources[0] });
    input.items.push({ ...input.items[0] });
    input.declaredCounts.sources = 2;
    input.declaredCounts.items = 2;
    const first = DocumentDispositionCatalog.create(input);
    const second = DocumentDispositionCatalog.create({
      ...input,
      sources: [...input.sources].reverse(),
      items: [...input.items].reverse(),
    });
    expect(first).toEqual(second);
  });
});
