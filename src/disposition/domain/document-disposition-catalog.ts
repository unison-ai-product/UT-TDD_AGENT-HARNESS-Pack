import { createHash } from "node:crypto";

export type Disposition = "adopt" | "merge" | "reference" | "defer" | "not_applicable" | "reject";
export type TargetKind = "artifact_path" | "artifact_family" | "plan_alias" | "target_slot";
export type ItemTargetStatus = Disposition | "pending_review";

export interface DeclaredCounts {
  sources: number;
  items: number;
  categories: number;
  metaSourceMappings: number;
  sourceItemEdges: number;
  sourceTargetEdges: number;
  itemTargetEdges: number;
}

export interface MetaSourceMapping {
  metaSourceRef: string;
  allowedSourceStatus: string;
  sourceFilePolicy: "empty" | "required";
  reason: string;
  rowDigest: string;
}

export interface CatalogSource {
  sourceId: string;
  ordinal: number;
  sourceTitle: string;
  disposition: Disposition;
  targetRef: string;
  reason: string;
  rowDigest: string;
  manifestDigest: string;
}

export interface CatalogCategory {
  categoryId: string;
  categoryName: string;
  rowDigest: string;
}

export interface CatalogItem {
  itemId: string;
  itemName: string;
  categoryId: string;
  sourceStatus: string;
  sourceRef: string;
  sourceFile: string;
  rowDigest: string;
}

export interface SourceItemEdge {
  edgeId: string;
  sourceId: string;
  itemId: string;
  sourceStatus: string;
  sourceFile: string;
  rowDigest: string;
}

export interface SourceTargetEdge {
  edgeId: string;
  sourceId: string;
  targetType: TargetKind;
  targetRef: string;
  disposition: Disposition;
  rowDigest: string;
}

export interface ItemTargetEdge {
  edgeId: string;
  itemId: string;
  targetStatus: ItemTargetStatus;
  reason: string;
  sourceDigest: string;
  targetKind?: TargetKind;
  targetRef?: string;
  planId?: string;
}

export interface CatalogInput {
  manifestIdentity: { auditedOn: string; zipSha256: string };
  declaredCounts: DeclaredCounts;
  sources: CatalogSource[];
  items: CatalogItem[];
  categories: CatalogCategory[];
  metaSourceMappings: MetaSourceMapping[];
  sourceItemEdges: SourceItemEdge[];
  sourceTargetEdges: SourceTargetEdge[];
  itemTargetEdges: ItemTargetEdge[];
}

export interface CatalogViolation {
  ruleId: string;
  subjectId: string;
  message: string;
  severity: "error" | "warning";
  evidenceRefs: string[];
}

export interface SourceItemTargetTrace {
  source: CatalogSource;
  items: CatalogItem[];
  sourceTargets: SourceTargetEdge[];
  itemTargets: ItemTargetEdge[];
}

export type CatalogResult =
  | { ok: true; value: DocumentDispositionCatalog }
  | { ok: false; errors: CatalogViolation[] };

const DIMENSIONS: (keyof DeclaredCounts)[] = [
  "categories",
  "itemTargetEdges",
  "items",
  "metaSourceMappings",
  "sourceItemEdges",
  "sources",
  "sourceTargetEdges",
];

function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function ordered<T>(rows: readonly T[], identity: (row: T) => string): T[] {
  return [...rows].sort((left, right) => compareBytes(identity(left), identity(right)));
}

function frame(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

export function sourceItemEdgeId(sourceId: string, itemId: string): string {
  return createHash("sha256")
    .update(frame(sourceId) + frame(itemId), "utf8")
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareBytes(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function canonicalDigest(input: CatalogInput): string {
  const frames = [
    input.manifestIdentity.auditedOn,
    input.manifestIdentity.zipSha256,
    ...DIMENSIONS.map((key) => `${key}=${input.declaredCounts[key]}`),
    ...ordered(input.sources, (row) => row.sourceId).map(canonicalJson),
    ...ordered(input.categories, (row) => row.categoryId).map(canonicalJson),
    ...ordered(input.metaSourceMappings, (row) => row.metaSourceRef).map(canonicalJson),
    ...ordered(input.items, (row) => row.itemId).map(canonicalJson),
    ...ordered(input.sourceItemEdges, (row) => row.edgeId).map(canonicalJson),
    ...ordered(input.sourceTargetEdges, (row) => row.edgeId).map(canonicalJson),
    ...ordered(input.itemTargetEdges, (row) => row.edgeId).map(canonicalJson),
  ];
  return createHash("sha256").update(frames.map(frame).join(""), "utf8").digest("hex");
}

function violation(
  ruleId: string,
  subjectId: string,
  detail:
    | string
    | {
        message: string;
        evidenceRefs?: string[];
        severity?: CatalogViolation["severity"];
      },
): CatalogViolation {
  const {
    message,
    evidenceRefs = [],
    severity = "error",
  } = typeof detail === "string" ? { message: detail } : detail;
  return { ruleId, subjectId, message, severity, evidenceRefs: [...evidenceRefs].sort() };
}

function stableFindings(findings: CatalogViolation[]): CatalogViolation[] {
  return findings.sort((left, right) => {
    const leftKey = [left.ruleId, left.subjectId, left.evidenceRefs.join("\0")].join("\0");
    const rightKey = [right.ruleId, right.subjectId, right.evidenceRefs.join("\0")].join("\0");
    return compareBytes(leftKey, rightKey);
  });
}

function duplicateFindings<T>(
  rows: readonly T[],
  config: { identity: (row: T) => string; ruleId: string; evidence: string },
): CatalogViolation[] {
  const { identity, ruleId, evidence } = config;
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(identity(row), (counts.get(identity(row)) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) =>
      violation(ruleId, id, {
        message: `duplicate identity: ${id}`,
        evidenceRefs: [evidence],
      }),
    );
}

function validate(input: CatalogInput): CatalogViolation[] {
  const findings: CatalogViolation[] = [];
  const dispositions = new Set([
    "adopt",
    "merge",
    "reference",
    "defer",
    "not_applicable",
    "reject",
  ]);
  const targetKinds = new Set(["artifact_path", "artifact_family", "plan_alias", "target_slot"]);
  const itemStatuses = new Set([...dispositions, "pending_review"]);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(input.manifestIdentity.auditedOn) ||
    !isDigest(input.manifestIdentity.zipSha256)
  ) {
    findings.push(
      violation("catalog-manifest-identity-invalid", "manifest", "auditedOn/zipSha256 invalid"),
    );
  }
  for (const dimension of DIMENSIONS) {
    if (input.declaredCounts[dimension] !== input[dimension].length) {
      findings.push(
        violation("catalog-count-mismatch", dimension, {
          message: `declared=${input.declaredCounts[dimension]} actual=${input[dimension].length}`,
          evidenceRefs: ["manifest:declaredCounts", `catalog:${dimension}`],
        }),
      );
    }
  }

  findings.push(
    ...duplicateFindings(input.sources, {
      identity: (row) => row.sourceId,
      ruleId: "catalog-source-duplicate",
      evidence: "sources",
    }),
    ...duplicateFindings(input.sources, {
      identity: (row) => String(row.ordinal),
      ruleId: "catalog-source-duplicate",
      evidence: "sources:ordinal",
    }),
    ...duplicateFindings(input.categories, {
      identity: (row) => row.categoryId,
      ruleId: "catalog-category-duplicate",
      evidence: "categories",
    }),
    ...duplicateFindings(input.metaSourceMappings, {
      identity: (row) => row.metaSourceRef,
      ruleId: "catalog-edge-duplicate",
      evidence: "metaSourceMappings",
    }),
    ...duplicateFindings(input.items, {
      identity: (row) => row.itemId,
      ruleId: "catalog-item-duplicate",
      evidence: "items",
    }),
    ...duplicateFindings(input.sourceItemEdges, {
      identity: (row) => row.edgeId,
      ruleId: "catalog-edge-duplicate",
      evidence: "sourceItemEdges",
    }),
    ...duplicateFindings(input.sourceTargetEdges, {
      identity: (row) => row.edgeId,
      ruleId: "catalog-edge-duplicate",
      evidence: "sourceTargetEdges",
    }),
    ...duplicateFindings(input.itemTargetEdges, {
      identity: (row) => row.edgeId,
      ruleId: "catalog-edge-duplicate",
      evidence: "itemTargetEdges",
    }),
  );

  const sourceIds = new Set(input.sources.map((row) => row.sourceId));
  const metaSources = new Map(input.metaSourceMappings.map((row) => [row.metaSourceRef, row]));
  const categoryIds = new Set(input.categories.map((row) => row.categoryId));
  const itemIds = new Set(input.items.map((row) => row.itemId));
  for (const category of input.categories) {
    if (!isDigest(category.rowDigest)) {
      findings.push(
        violation(
          "catalog-authoring-digest-invalid",
          category.categoryId,
          "category digest invalid",
        ),
      );
    }
  }
  for (const source of input.sources) {
    const expectedOrdinal = Number(source.sourceId.replace(/^ZIP-DOC-/, ""));
    if (!dispositions.has(source.disposition) || source.ordinal !== expectedOrdinal) {
      findings.push(
        violation("catalog-authoring-enum-invalid", source.sourceId, "disposition/ordinal invalid"),
      );
    }
    if (!source.reason.trim() || !isDigest(source.rowDigest) || !isDigest(source.manifestDigest)) {
      findings.push(
        violation("catalog-disposition-incomplete", source.sourceId, {
          message: "reason/digest is required",
          evidenceRefs: [source.sourceId],
        }),
      );
    }
    if (
      ["adopt", "merge", "reference", "defer"].includes(source.disposition) &&
      !source.targetRef.trim()
    ) {
      findings.push(
        violation("catalog-disposition-incomplete", source.sourceId, {
          message: "target is required",
          evidenceRefs: [source.sourceId],
        }),
      );
    }
  }
  for (const mapping of input.metaSourceMappings) {
    if (
      !mapping.reason.trim() ||
      !isDigest(mapping.rowDigest) ||
      !["empty", "required"].includes(mapping.sourceFilePolicy)
    ) {
      findings.push(
        violation(
          "catalog-authoring-enum-invalid",
          mapping.metaSourceRef,
          "meta source mapping invalid",
        ),
      );
    }
  }
  for (const item of input.items) {
    if (!isDigest(item.rowDigest)) {
      findings.push(
        violation("catalog-authoring-digest-invalid", item.itemId, "item digest invalid"),
      );
    }
    const metaSource = metaSources.get(item.sourceRef);
    const metaMatches = Boolean(
      metaSource &&
        metaSource.allowedSourceStatus === item.sourceStatus &&
        ((metaSource.sourceFilePolicy === "empty" && !item.sourceFile) ||
          (metaSource.sourceFilePolicy === "required" && Boolean(item.sourceFile))),
    );
    if (!categoryIds.has(item.categoryId) || (!sourceIds.has(item.sourceRef) && !metaMatches)) {
      findings.push(
        violation("catalog-orphan-edge", item.itemId, {
          message: "item category/source is unresolved",
          evidenceRefs: [item.categoryId, item.sourceRef],
        }),
      );
    }
    const matchingSourceEdges = input.sourceItemEdges.filter(
      (edge) => edge.itemId === item.itemId && edge.sourceId === item.sourceRef,
    );
    if (matchingSourceEdges.length !== 1) {
      findings.push(
        violation("catalog-orphan-edge", item.itemId, {
          message: "item must have exactly one authored source edge",
          evidenceRefs: [item.sourceRef],
        }),
      );
    }
    if (input.itemTargetEdges.filter((edge) => edge.itemId === item.itemId).length !== 1) {
      findings.push(
        violation("catalog-item-target-incomplete", item.itemId, {
          message: "item must have exactly one authored target decision",
          evidenceRefs: [item.itemId],
        }),
      );
    }
  }
  for (const edge of input.sourceItemEdges) {
    if (!isDigest(edge.rowDigest)) {
      findings.push(
        violation("catalog-authoring-digest-invalid", edge.edgeId, "source-item digest invalid"),
      );
    }
    const item = input.items.find((row) => row.itemId === edge.itemId);
    const metaSource = metaSources.get(edge.sourceId);
    const metaMatches = Boolean(
      item &&
        metaSource &&
        metaSource.allowedSourceStatus === item.sourceStatus &&
        ((metaSource.sourceFilePolicy === "empty" && !item.sourceFile) ||
          (metaSource.sourceFilePolicy === "required" && Boolean(item.sourceFile))),
    );
    if ((!sourceIds.has(edge.sourceId) && !metaMatches) || !itemIds.has(edge.itemId)) {
      findings.push(
        violation("catalog-orphan-edge", edge.edgeId, {
          message: "source-item endpoint is unresolved",
          evidenceRefs: [edge.sourceId, edge.itemId],
        }),
      );
    }
    if (edge.edgeId !== sourceItemEdgeId(edge.sourceId, edge.itemId)) {
      findings.push(
        violation("catalog-edge-identity-invalid", edge.edgeId, {
          message: "source-item edge ID mismatch",
          evidenceRefs: [edge.sourceId, edge.itemId],
        }),
      );
    }
  }
  for (const edge of input.sourceTargetEdges) {
    if (
      !targetKinds.has(edge.targetType) ||
      !dispositions.has(edge.disposition) ||
      !isDigest(edge.rowDigest)
    ) {
      findings.push(
        violation(
          "catalog-authoring-enum-invalid",
          edge.edgeId,
          "source target enum/digest invalid",
        ),
      );
    }
    if (!sourceIds.has(edge.sourceId)) {
      findings.push(
        violation("catalog-orphan-edge", edge.edgeId, {
          message: "source-target source is unresolved",
          evidenceRefs: [edge.sourceId],
        }),
      );
    }
    const source = input.sources.find((row) => row.sourceId === edge.sourceId);
    if (source && source.disposition !== edge.disposition) {
      findings.push(
        violation("catalog-source-target-mismatch", edge.edgeId, {
          message: "disposition mismatch",
          evidenceRefs: [edge.sourceId],
        }),
      );
    }
  }
  for (const sourceId of sourceIds) {
    if (!input.sourceTargetEdges.some((edge) => edge.sourceId === sourceId)) {
      findings.push(
        violation("catalog-source-target-incomplete", sourceId, {
          message: "source has no target edge",
          evidenceRefs: [sourceId],
        }),
      );
    }
  }
  for (const edge of input.itemTargetEdges) {
    if (
      !itemStatuses.has(edge.targetStatus) ||
      (edge.targetKind && !targetKinds.has(edge.targetKind))
    ) {
      findings.push(
        violation("catalog-authoring-enum-invalid", edge.edgeId, "item target enum invalid"),
      );
    }
    if (!itemIds.has(edge.itemId)) {
      findings.push(
        violation("catalog-orphan-edge", edge.edgeId, {
          message: "item-target item is unresolved",
          evidenceRefs: [edge.itemId],
        }),
      );
    }
    const hasTarget = Boolean(edge.targetKind && edge.targetRef?.trim());
    const isPending = edge.targetStatus === "pending_review";
    const finalNeedsTarget = ["adopt", "merge", "reference", "defer"].includes(edge.targetStatus);
    if (
      !edge.reason.trim() ||
      !isDigest(edge.sourceDigest) ||
      (isPending && Boolean(edge.targetKind || edge.targetRef)) ||
      (finalNeedsTarget && !hasTarget) ||
      (edge.targetStatus === "defer" && !edge.planId)
    ) {
      findings.push(
        violation("catalog-item-target-incomplete", edge.itemId, {
          message: "item target decision is incomplete",
          evidenceRefs: [edge.edgeId],
        }),
      );
    }
  }
  return stableFindings(findings);
}

function isDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function snapshot<T>(input: T): T {
  return structuredClone(input);
}

export class DocumentDispositionCatalog {
  readonly digest: string;
  readonly #input: CatalogInput;

  private constructor(input: CatalogInput) {
    this.#input = snapshot(input);
    this.digest = canonicalDigest(this.#input);
    Object.freeze(this);
  }

  static create(input: CatalogInput): CatalogResult {
    const owned = snapshot(input);
    const errors = validate(owned);
    return errors.length > 0
      ? { ok: false, errors }
      : { ok: true, value: new DocumentDispositionCatalog(owned) };
  }

  traceSource(sourceId: string): SourceItemTargetTrace | null {
    const source = this.#input.sources.find((row) => row.sourceId === sourceId);
    if (!source) return null;
    const itemIds = new Set(
      this.#input.sourceItemEdges
        .filter((edge) => edge.sourceId === sourceId)
        .map((edge) => edge.itemId),
    );
    return snapshot({
      source,
      items: ordered(
        this.#input.items.filter((item) => itemIds.has(item.itemId)),
        (item) => item.itemId,
      ),
      sourceTargets: ordered(
        this.#input.sourceTargetEdges.filter((edge) => edge.sourceId === sourceId),
        (edge) => edge.edgeId,
      ),
      itemTargets: ordered(
        this.#input.itemTargetEdges.filter((edge) => itemIds.has(edge.itemId)),
        (edge) => edge.edgeId,
      ),
    });
  }

  unresolved(): CatalogViolation[] {
    return this.#input.itemTargetEdges
      .filter((edge) => edge.targetStatus === "pending_review")
      .map((edge) =>
        violation("catalog-item-target-pending", edge.itemId, {
          message: "item target review is pending",
          evidenceRefs: [edge.edgeId],
          severity: "warning",
        }),
      )
      .sort((left, right) => compareBytes(left.subjectId, right.subjectId));
  }
}
