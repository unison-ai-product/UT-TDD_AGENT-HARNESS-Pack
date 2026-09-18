import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GitAuthoringProvenance } from "../disposition/adapters/git-authoring-provenance.ts";
import { buildTrackedTargetRegistry } from "../disposition/adapters/tracked-target-registry.ts";
import { loadTrackedCatalogInput } from "../disposition/adapters/tracked-vmodel-loader.ts";
import { DocumentDispositionCatalog } from "../disposition/domain/document-disposition-catalog.ts";
import {
  reconcileDispositionTarget,
  resolveCanonicalTarget,
} from "../disposition/domain/target-resolver.ts";
import type { AuthoringProvenancePort } from "../disposition/ports/authoring-provenance.ts";
import { loadTrackedDocumentProfileCatalog } from "../profile/adapters/tracked-profile-loader.ts";
import { stableId } from "../stable-id.ts";
import type { HarnessDb } from "./index.ts";
import { upsertRow } from "./index.ts";

const catalogPaths = [
  "docs/governance/vmodel-source-manifest.md",
  "docs/governance/vmodel-document-disposition-catalog.md",
  "docs/governance/vmodel-semantic-item-catalog.md",
  "docs/governance/vmodel-source-target-edges.md",
  "docs/governance/vmodel-item-target-ledger.md",
] as const;
const profilePaths = [
  "docs/governance/vmodel-document-scale-profiles.md",
  "docs/governance/vmodel-document-catalog.md",
] as const;

export interface VmodelProjectionDeps {
  readonly read: (path: string) => Uint8Array;
  readonly provenance: AuthoringProvenancePort;
}

export function hasVmodelAuthoring(repoRoot: string): boolean {
  return existsSync(join(repoRoot, catalogPaths[0]));
}

export function projectVmodelAuthoring(
  repoRoot: string,
  db: HarnessDb,
  deps: VmodelProjectionDeps = {
    read: (path) => readFileSync(join(repoRoot, path)),
    provenance: new GitAuthoringProvenance(repoRoot),
  },
): void {
  const catalogBundle = bundle(catalogPaths, deps.read);
  const catalogInput = loadTrackedCatalogInput(
    catalogBundle,
    deps.provenance.receipts(catalogPaths),
  );
  const catalog = DocumentDispositionCatalog.create(catalogInput);
  if (!catalog.ok) throw new Error(JSON.stringify(catalog.errors));
  validateTargets(repoRoot, catalogInput);
  for (const finding of catalog.value.unresolved()) {
    upsert(db, {
      table: "findings",
      primaryKey: "finding_id",
      row: {
        finding_id: stableId("vmodel-item-target-pending", finding.subjectId),
        kind: finding.ruleId,
        severity: finding.severity,
        subject_id: finding.subjectId,
        source: "vmodel-item-target",
        status: "open",
        evidence_path: "docs/governance/vmodel-item-target-ledger.md",
      },
    });
  }

  for (const row of catalogInput.sources)
    upsert(db, { table: "vmodel_sources", primaryKey: "source_id", row: snake(row) });
  for (const row of catalogInput.categories)
    upsert(db, { table: "vmodel_categories", primaryKey: "category_id", row: snake(row) });
  for (const row of catalogInput.metaSourceMappings)
    upsert(db, {
      table: "vmodel_meta_source_mappings",
      primaryKey: "meta_source_ref",
      row: snake(row),
    });
  for (const row of catalogInput.items)
    upsert(db, { table: "vmodel_semantic_items", primaryKey: "item_id", row: snake(row) });
  for (const row of catalogInput.sourceItemEdges)
    upsert(db, { table: "vmodel_source_item_edges", primaryKey: "edge_id", row: snake(row) });
  for (const row of catalogInput.sourceTargetEdges)
    upsert(db, { table: "vmodel_source_target_edges", primaryKey: "edge_id", row: snake(row) });
  for (const row of catalogInput.itemTargetEdges)
    upsert(db, { table: "vmodel_item_target_edges", primaryKey: "edge_id", row: snake(row) });

  const profileBundle = bundle(profilePaths, deps.read);
  const profiles = loadTrackedDocumentProfileCatalog(
    profileBundle,
    deps.provenance.receipts(profilePaths),
  );
  for (const row of profiles.catalog.profiles)
    upsert(db, { table: "document_scale_profiles", primaryKey: "profile_id", row: snake(row) });
}

function validateTargets(
  repoRoot: string,
  input: ReturnType<typeof loadTrackedCatalogInput>,
): void {
  const families = input.sourceTargetEdges
    .filter((edge) => edge.targetType === "artifact_family")
    .map((edge) => edge.targetRef);
  const registry = buildTrackedTargetRegistry(repoRoot, families);
  for (const edge of input.sourceTargetEdges) {
    const resolved = resolveCanonicalTarget(
      { kind: edge.targetType, ref: edge.targetRef },
      registry,
    );
    if (!resolved.ok) throw new Error(JSON.stringify(resolved.findings));
  }
  for (const source of input.sources) {
    const edges = input.sourceTargetEdges.filter((edge) => edge.sourceId === source.sourceId);
    if (edges.length !== 1) continue;
    const reconciled = reconcileDispositionTarget(
      {
        displayRef: source.targetRef,
        edge: { kind: edges[0].targetType, ref: edges[0].targetRef },
      },
      registry,
    );
    if (!reconciled.ok) throw new Error(JSON.stringify(reconciled.findings));
  }
}

function bundle(paths: readonly string[], read: (path: string) => Uint8Array) {
  return Object.fromEntries(paths.map((path) => [path, read(path)]));
}

function snake(row: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      value ?? null,
    ]),
  );
}

function upsert(
  db: HarnessDb,
  request: { table: string; primaryKey: string; row: Record<string, unknown> },
): void {
  upsertRow(db, request);
}
