import { parseIssueUrl } from "../../shared/issue-ref.ts";

export type DocumentDisposition =
  | "retain"
  | "update"
  | "merge"
  | "supersede"
  | "archive"
  | "not_applicable";

export type ApplicationStatus = "pending" | "applied" | "verified";

export type CanonicalDocumentApplicability =
  | { readonly kind: "applicable" }
  | {
      readonly kind: "conditional";
      readonly reason: string;
      readonly observedCondition: string;
      readonly reevaluationTrigger: string;
    }
  | {
      readonly kind: "deferred";
      readonly reason: string;
      readonly reevaluationTrigger: string;
      readonly issue: string;
    }
  | { readonly kind: "not_applicable"; readonly reason: string; readonly decider: string };

export interface DocumentDispositionInput {
  readonly baselinePath: string;
  readonly disposition: string;
  readonly reason: string;
  readonly targets: readonly string[];
  /** Legacy input retained only so recorded decisions can be replayed. */
  readonly planIds?: readonly string[];
  readonly issues?: readonly string[];
  readonly applicationStatus: string;
  readonly applicability: {
    readonly kind: string;
    readonly reason?: string;
    readonly observedCondition?: string;
    readonly reevaluationTrigger?: string;
    readonly issue?: string;
    /** Historical field. New records must not use it. */
    readonly planId?: string;
    readonly decider?: string;
  };
}

type AuthoringApplicability =
  | CanonicalDocumentApplicability
  | { readonly kind: "skip"; readonly reason: string; readonly decider: string }
  | {
      readonly kind: "defer";
      readonly reason: string;
      readonly reevaluationTrigger: string;
      readonly issue: string;
    };

export type ApplicabilityNormalization =
  | { readonly ok: true; readonly value: CanonicalDocumentApplicability }
  | { readonly ok: false; readonly missingFields: readonly string[] };

const nonEmpty = (value: string | undefined): boolean => (value?.trim().length ?? 0) > 0;

export function normalizeDocumentApplicability(
  input: AuthoringApplicability,
): ApplicabilityNormalization {
  const kind =
    input.kind === "skip" ? "not_applicable" : input.kind === "defer" ? "deferred" : input.kind;
  const candidate = { ...input, kind } as CanonicalDocumentApplicability;
  const validation = validateApplicability(candidate);
  return validation.length === 0
    ? { ok: true, value: candidate }
    : { ok: false, missingFields: validation };
}

function validateApplicability(applicability: DocumentDispositionInput["applicability"]): string[] {
  const missing: string[] = [];
  switch (applicability.kind) {
    case "applicable":
      break;
    case "conditional":
      if (!nonEmpty(applicability.reason)) missing.push("applicability.reason");
      if (!nonEmpty(applicability.observedCondition)) {
        missing.push("applicability.observed_condition");
      }
      if (!nonEmpty(applicability.reevaluationTrigger)) {
        missing.push("applicability.reevaluation_trigger");
      }
      break;
    case "deferred":
      if (!nonEmpty(applicability.reason)) missing.push("applicability.reason");
      if (!nonEmpty(applicability.reevaluationTrigger)) {
        missing.push("applicability.reevaluation_trigger");
      }
      if (!parseIssueUrl(applicability.issue ?? "")) missing.push("applicability.issue");
      break;
    case "not_applicable":
      if (!nonEmpty(applicability.reason)) missing.push("applicability.reason");
      if (!nonEmpty(applicability.decider)) missing.push("applicability.decider");
      break;
    default:
      missing.push("applicability.kind");
  }
  return missing;
}

export type DocumentDispositionValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly missingFields: readonly string[] };

function validateCommonDocumentDispositionFields(
  input: DocumentDispositionInput,
  missing: string[],
): void {
  if (
    !["retain", "update", "merge", "supersede", "archive", "not_applicable"].includes(
      input.disposition,
    )
  ) {
    missing.push("disposition");
  }
  if (!nonEmpty(input.reason)) missing.push("reason");
  if (!["pending", "applied", "verified"].includes(input.applicationStatus)) {
    missing.push("application_status");
  }
  if (input.issues?.some((issue) => !parseIssueUrl(issue))) missing.push("issues");
}

function validateNewDocumentDispositionReferences(
  input: DocumentDispositionInput,
  missing: string[],
): void {
  if (
    ["update", "merge", "supersede", "archive"].includes(input.disposition) &&
    input.targets.length === 0 &&
    (input.issues?.length ?? 0) === 0
  ) {
    missing.push("targets_or_issues");
  }
  if ((input.planIds?.length ?? 0) > 0) missing.push("plan_ids");
  if (nonEmpty(input.applicability.planId) && parseIssueUrl(input.applicability.issue ?? "")) {
    missing.push("applicability.plan_id");
  }
}

function validateLegacyReplayReferences(input: DocumentDispositionInput, missing: string[]): void {
  if (
    ["update", "merge", "supersede", "archive"].includes(input.disposition) &&
    input.targets.length === 0 &&
    (input.issues?.length ?? 0) === 0 &&
    (input.planIds?.length ?? 0) === 0
  ) {
    missing.push("targets_or_issues");
  }
  if (
    input.applicability.kind === "deferred" &&
    !input.applicability.issue &&
    nonEmpty(input.applicability.planId)
  ) {
    const issueIndex = missing.indexOf("applicability.issue");
    if (issueIndex >= 0) missing.splice(issueIndex, 1);
  }
}

export function validateDocumentDisposition(
  input: DocumentDispositionInput,
  options: { readonly allowLegacyPlanReferences?: boolean } = {},
): DocumentDispositionValidation {
  const missing = validateApplicability(input.applicability);
  validateCommonDocumentDispositionFields(input, missing);
  if (options.allowLegacyPlanReferences) validateLegacyReplayReferences(input, missing);
  else validateNewDocumentDispositionReferences(input, missing);
  missing.sort();
  return missing.length === 0 ? { ok: true } : { ok: false, missingFields: missing };
}
