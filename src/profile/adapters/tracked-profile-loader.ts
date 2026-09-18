import { createHash } from "node:crypto";
import { parseStrictMarkdownTable } from "../../disposition/adapters/strict-markdown-table.ts";
import {
  type AuthoringReceipt,
  verifyAuthoringProvenance,
} from "../../disposition/domain/authoring-provenance.ts";
import {
  createProfileCatalog,
  type DocumentProfile,
  type DocumentProfileDecision,
  type ProfileCatalog,
} from "../domain/resolver.ts";

export type ProfileAuthoringBundle = Record<string, Uint8Array>;
type Row = Readonly<Record<string, string>>;

const profilePath = "docs/governance/vmodel-document-scale-profiles.md";
const catalogPath = "docs/governance/vmodel-document-catalog.md";

const profileHeaders = [
  "profile_id",
  "profile_axis",
  "profile_rank",
  "description",
  "default_status",
  "default_detail",
  "scope_policy",
] as const;
const decisionHeaders = [
  "profile_id",
  "doc_type_id",
  "decision",
  "detail_override",
  "status_override",
  "reason",
  "required_plan_id",
] as const;
const catalogHeaders = [
  "doc_type_id",
  "layer",
  "sub_doc",
  "category",
  "requirement_class",
  "applicability",
  "default_status",
  "source_doc_family",
  "authoring_source_path",
  "projection_table",
  "profile_controlled",
  "skip_reason_required",
] as const;

export interface TrackedDocumentProfileCatalog {
  readonly sourcePath: typeof profilePath;
  readonly sourceDigest: string;
  readonly catalogSourcePath: typeof catalogPath;
  readonly catalogSourceDigest: string;
  readonly catalog: ProfileCatalog;
}

export function loadTrackedDocumentProfileCatalog(
  bundle: ProfileAuthoringBundle,
  receipts: readonly AuthoringReceipt[],
): TrackedDocumentProfileCatalog {
  const provenance = verifyAuthoringProvenance(bundle, receipts);
  if (!provenance.ok) throw new Error(JSON.stringify(provenance.findings));
  const profileBytes = requiredSource(bundle, profilePath);
  const catalogBytes = requiredSource(bundle, catalogPath);
  const manifest = new Map(
    table(profileBytes, { path: profilePath, headers: ["field", "value"] }).map((row) => [
      required(row, "field"),
      required(row, "value"),
    ]),
  );
  const profileRows = table(profileBytes, {
    path: profilePath,
    headers: profileHeaders,
    expectedRows: manifestCount(manifest, "profile_count"),
  });
  const decisionRows = table(profileBytes, {
    path: profilePath,
    headers: decisionHeaders,
    expectedRows: manifestCount(manifest, "decision_count"),
  });
  const catalogRows = table(catalogBytes, { path: catalogPath, headers: catalogHeaders });
  const profiles = profileRows.map(toProfile);
  const decisions = decisionRows.map(toDecision);
  assertAxisCounts(profiles, manifest);
  const knownDocTypeIds = catalogRows.map((row) => required(row, "doc_type_id"));
  const decisionDocTypes = [...new Set(decisions.map((decision) => decision.docTypeId))];
  const coreDocTypeIds = catalogRows
    .filter((row) => row.requirement_class === "core")
    .map((row) => required(row, "doc_type_id"));
  const result = createProfileCatalog({
    profiles,
    decisions,
    knownDocTypeIds,
    requiredDocTypeIds: decisionDocTypes,
    coreDocTypeIds,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.findings));
  return Object.freeze({
    sourcePath: profilePath,
    sourceDigest: digestBytes(profileBytes),
    catalogSourcePath: catalogPath,
    catalogSourceDigest: digestBytes(catalogBytes),
    catalog: result.value,
  });
}

function manifestCount(manifest: ReadonlyMap<string, string>, field: string): number {
  const count = Number.parseInt(manifest.get(field) ?? "", 10);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`profile-authoring-manifest-invalid: ${field}`);
  }
  return count;
}

function assertAxisCounts(
  profiles: readonly DocumentProfile[],
  manifest: ReadonlyMap<string, string>,
): void {
  for (const axis of ["size", "product"] as const) {
    const expected = manifestCount(manifest, `${axis}_profile_count`);
    const actual = profiles.filter((profile) => profile.profileAxis === axis).length;
    if (actual !== expected) {
      throw new Error(
        `profile-authoring-count-mismatch: ${axis} declared=${expected} actual=${actual}`,
      );
    }
  }
}

function toProfile(row: Row): DocumentProfile {
  const rank = Number.parseInt(required(row, "profile_rank"), 10);
  if (!Number.isSafeInteger(rank)) throw new Error("profile-authoring-row-invalid: profile_rank");
  return Object.freeze({
    profileId: required(row, "profile_id"),
    profileAxis: required(row, "profile_axis") as DocumentProfile["profileAxis"],
    profileRank: rank,
    description: required(row, "description"),
    defaultStatus: required(row, "default_status") as DocumentProfile["defaultStatus"],
    defaultDetail: required(row, "default_detail") as DocumentProfile["defaultDetail"],
    scopePolicy: required(row, "scope_policy"),
    rowDigest: digestRow(row, profileHeaders),
  });
}

function toDecision(row: Row): DocumentProfileDecision {
  const profileId = required(row, "profile_id");
  const docTypeId = required(row, "doc_type_id");
  const requiredPlanId = optional(row, "required_plan_id");
  return Object.freeze({
    decisionId: `PROFILE-DECISION-${profileId}-${docTypeId}`,
    profileId,
    docTypeId,
    decision: required(row, "decision") as DocumentProfileDecision["decision"],
    detailOverride: required(row, "detail_override") as DocumentProfileDecision["detailOverride"],
    statusOverride: required(row, "status_override") as DocumentProfileDecision["statusOverride"],
    reason: required(row, "reason"),
    ...(requiredPlanId ? { requiredPlanId } : {}),
    rowDigest: digestRow(row, decisionHeaders),
  });
}

function table(
  bytes: Uint8Array,
  config: { path: string; headers: readonly string[]; expectedRows?: number },
): readonly Row[] {
  const { path, headers, expectedRows } = config;
  const result = parseStrictMarkdownTable(bytes, {
    subjectId: path,
    expectedHeaders: headers,
    ...(expectedRows === undefined ? {} : { expectedRows }),
  });
  if (!result.ok) throw new Error(JSON.stringify(result.findings));
  return result.rows;
}

function requiredSource(bundle: ProfileAuthoringBundle, path: string): Uint8Array {
  const bytes = bundle[path];
  if (!bytes) throw new Error(`catalog authoring source missing: ${path}`);
  return bytes;
}

function required(row: Row, field: string): string {
  const value = row[field]?.trim();
  if (!value) throw new Error(`profile-authoring-row-invalid: ${field}`);
  return value;
}

function optional(row: Row, field: string): string | undefined {
  const value = row[field]?.trim();
  return value && value !== "—" ? value : undefined;
}

function digestRow(row: Row, headers: readonly string[]): string {
  return digestBytes(Buffer.from(JSON.stringify(headers.map((header) => [header, row[header]]))));
}

function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
