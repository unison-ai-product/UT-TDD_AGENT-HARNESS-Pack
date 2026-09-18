import type { HarnessDb } from "./index.ts";

export interface ScopePreviewInput {
  profileId: string;
  activationProfileId?: string;
  capabilityFlags?: string[];
}

export interface ScopePreviewDocumentRow {
  profile_id: string;
  doc_type_id: string;
  decision: string;
  resolved_scope_status: "in_scope" | "conditional" | "deferred" | "skipped";
  detail_override: string;
  status_override: string;
  reason: string;
  required_plan_id: string;
  catalog_layer: string;
  catalog_sub_doc: string;
  requirement_class: string;
  gate_id: string;
  required_action: string;
}

export interface ScopePreviewActivationRow {
  profile_id: string;
  plan_id: string;
  target_id: string;
  scope_status: string;
  enabled: number;
  current_location: string;
  rag: string;
  schedule_status: string;
  layer: string;
  sub_doc: string;
  gate_id: string;
}

export interface ScopePreviewFinding {
  kind: string;
  severity: "error" | "warn";
  subject_id: string;
  message: string;
}

export interface ScopePreviewResult {
  ok: boolean;
  profile_id: string;
  activation_profile_id: string;
  capability_flags: string[];
  documents: ScopePreviewDocumentRow[];
  activations: ScopePreviewActivationRow[];
  gates: string[];
  detectors: string[];
  findings: ScopePreviewFinding[];
  summary: {
    documents_total: number;
    documents_in_scope: number;
    documents_conditional: number;
    documents_deferred: number;
    documents_skipped: number;
    activations_total: number;
  };
}

interface DocumentScaleProfileReviewDbRow {
  profile_id: string;
  doc_type_id: string;
  decision: string;
  detail_override: string;
  status_override: string;
  reason: string;
  required_plan_id: string;
  catalog_layer: string;
  catalog_sub_doc: string;
  requirement_class: string;
}

interface ActivationScheduleReviewDbRow {
  profile_id: string;
  plan_id: string;
  target_id: string;
  scope_status: string;
  enabled: number;
  current_location: string;
  rag: string;
  schedule_status: string;
  layer: string;
  sub_doc: string;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function gateIdFromLayer(layer: string): string {
  if (layer === "L0") return "G0.5";
  const match = layer.match(/^L(\d+)$/);
  return match ? `G${match[1]}` : "";
}

function matchesCapability(row: DocumentScaleProfileReviewDbRow, flags: Set<string>): boolean {
  if (flags.size === 0) return false;
  const values = [
    row.doc_type_id,
    row.catalog_sub_doc,
    row.requirement_class,
    row.doc_type_id.replace(/^DOC-L\d+-/i, ""),
  ].map(normalize);
  return values.some((value) => flags.has(value));
}

function resolveDocumentScope(
  row: DocumentScaleProfileReviewDbRow,
  capabilityFlags: Set<string>,
): ScopePreviewDocumentRow["resolved_scope_status"] {
  if (row.decision === "adopt") return "in_scope";
  if (row.decision === "defer") return "deferred";
  if (row.decision === "skip") return "skipped";
  if (row.decision === "conditional") {
    return matchesCapability(row, capabilityFlags) ? "in_scope" : "conditional";
  }
  return "conditional";
}

function requiredAction(
  row: DocumentScaleProfileReviewDbRow,
  resolved: ScopePreviewDocumentRow["resolved_scope_status"],
): string {
  if (resolved === "in_scope") return "include in detection scope";
  if (resolved === "skipped") return "keep explicit skip reason visible";
  if (resolved === "deferred") {
    return row.required_plan_id
      ? `follow required plan ${row.required_plan_id}`
      : "route defer target before implementation";
  }
  return "set matching capability flag or keep explicit conditional reason";
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function planExists(db: HarnessDb, planId: string): boolean {
  const row = db.prepare("SELECT plan_id FROM plan_registry WHERE plan_id = ? LIMIT 1").get(planId);
  return Boolean(row);
}

const VALID_DOCUMENT_DECISIONS = new Set(["adopt", "conditional", "skip", "defer"]);

export function buildScopeDryRunPreview(
  db: HarnessDb,
  input: ScopePreviewInput,
): ScopePreviewResult {
  const profileId = input.profileId.trim();
  const activationProfileProvided = input.activationProfileId !== undefined;
  const activationProfileId = input.activationProfileId?.trim() ?? "";
  const capabilityFlags = (input.capabilityFlags ?? []).map(normalize).filter(Boolean).sort();
  const capabilityFlagSet = new Set(capabilityFlags);
  const findings: ScopePreviewFinding[] = [];

  const documentRows = db
    .prepare(
      `SELECT profile_id, doc_type_id, decision, detail_override, status_override, reason,
              required_plan_id, catalog_layer, catalog_sub_doc, requirement_class
       FROM document_scale_profile_reviews
       WHERE profile_id = ?
       ORDER BY doc_type_id`,
    )
    .all(profileId) as unknown as DocumentScaleProfileReviewDbRow[];

  const documents = documentRows.map((row) => {
    const resolved = resolveDocumentScope(row, capabilityFlagSet);
    return {
      profile_id: row.profile_id,
      doc_type_id: row.doc_type_id,
      decision: row.decision,
      resolved_scope_status: resolved,
      detail_override: row.detail_override,
      status_override: row.status_override,
      reason: row.reason,
      required_plan_id: row.required_plan_id,
      catalog_layer: row.catalog_layer,
      catalog_sub_doc: row.catalog_sub_doc,
      requirement_class: row.requirement_class,
      gate_id: gateIdFromLayer(row.catalog_layer),
      required_action: requiredAction(row, resolved),
    } satisfies ScopePreviewDocumentRow;
  });

  if (documents.length === 0) {
    findings.push({
      kind: "scope-preview-profile-missing",
      severity: "error",
      subject_id: profileId,
      message: `document scale profile not found: ${profileId}`,
    });
  }
  for (const row of documents) {
    if (!VALID_DOCUMENT_DECISIONS.has(row.decision)) {
      findings.push({
        kind: "scope-preview-document-decision-unknown",
        severity: "warn",
        subject_id: `${row.profile_id}:${row.doc_type_id}:${row.decision}`,
        message: `unknown document scale decision: ${row.decision}`,
      });
    }
    if (row.required_plan_id && !planExists(db, row.required_plan_id)) {
      findings.push({
        kind: "scope-preview-required-plan-missing",
        severity: "warn",
        subject_id: `${row.profile_id}:${row.doc_type_id}:${row.required_plan_id}`,
        message: `required plan is not projected: ${row.required_plan_id}`,
      });
    }
  }

  if (activationProfileProvided && activationProfileId === "") {
    findings.push({
      kind: "scope-preview-activation-profile-empty",
      severity: "warn",
      subject_id: profileId,
      message: "activation profile option was provided but empty",
    });
  }

  const activations = activationProfileId
    ? (
        db
          .prepare(
            `SELECT profile_id, plan_id, target_id, scope_status, enabled, current_location,
                  rag, schedule_status, layer, sub_doc
           FROM activation_schedule_reviews
           WHERE profile_id = ?
           ORDER BY plan_id`,
          )
          .all(activationProfileId) as unknown as ActivationScheduleReviewDbRow[]
      ).map((row) => ({
        profile_id: row.profile_id,
        plan_id: row.plan_id,
        target_id: row.target_id,
        scope_status: row.scope_status,
        enabled: row.enabled,
        current_location: row.current_location,
        rag: row.rag,
        schedule_status: row.schedule_status,
        layer: row.layer,
        sub_doc: row.sub_doc,
        gate_id: gateIdFromLayer(row.layer),
      }))
    : [];

  if (activationProfileId && activations.length === 0) {
    findings.push({
      kind: "scope-preview-activation-profile-missing",
      severity: "warn",
      subject_id: activationProfileId,
      message: `activation profile not found: ${activationProfileId}`,
    });
  }

  const detectors = uniqueSorted([
    "document-scale-profile",
    "document-catalog",
    "spec-ir-integrity",
    ...(activationProfileId ? ["activation-schedule-review"] : []),
  ]);
  const gates = uniqueSorted([
    ...documents.map((row) => row.gate_id),
    ...activations.map((row) => row.gate_id),
  ]);
  const summary = {
    documents_total: documents.length,
    documents_in_scope: documents.filter((row) => row.resolved_scope_status === "in_scope").length,
    documents_conditional: documents.filter((row) => row.resolved_scope_status === "conditional")
      .length,
    documents_deferred: documents.filter((row) => row.resolved_scope_status === "deferred").length,
    documents_skipped: documents.filter((row) => row.resolved_scope_status === "skipped").length,
    activations_total: activations.length,
  };

  return {
    ok: !findings.some((finding) => finding.severity === "error"),
    profile_id: profileId,
    activation_profile_id: activationProfileId,
    capability_flags: capabilityFlags,
    documents,
    activations,
    gates,
    detectors,
    findings,
    summary,
  };
}
