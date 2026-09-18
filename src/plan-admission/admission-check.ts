import {
  type AdmissionDiffFinding,
  type AdmissionReceiptPort,
  analyzePlanAdmissionDiff,
  type PlanBlob,
  type PlanChange,
} from "./diff-fence.ts";

export interface AdmissionComparison {
  base: readonly PlanBlob[];
  head: readonly PlanBlob[];
  changes: readonly PlanChange[];
  baseComplete: boolean;
  headComplete: boolean;
}

/** Git adapter boundary. Implementations must read blobs from the named revisions, not the worktree. */
export interface AdmissionChangesPort {
  compare(baseRef: string, headRef: string): AdmissionComparison;
}

export interface AdmissionProjectionValidation {
  ok: boolean;
  findings: readonly { code: string; detail?: string }[];
}

/** Receipt lookup and its independently validated tracked projection belong to one consistency boundary. */
export interface AdmissionProjectionPort extends AdmissionReceiptPort {
  validate(): AdmissionProjectionValidation;
}

export type AdmissionCheckFinding =
  | AdmissionDiffFinding
  | {
      path: string;
      code:
        | "plan-admission-comparison-unavailable"
        | "plan-admission-base-incomplete"
        | "plan-admission-head-incomplete"
        | "plan-admission-projection-invalid"
        | "plan-admission-analysis-failed";
      detail?: string;
    };

export interface AdmissionCheckResult {
  ok: boolean;
  findings: readonly AdmissionCheckFinding[];
}

/**
 * Application service for the admission fence.
 *
 * All boundary failures become findings. A malformed projection or incomplete Git
 * comparison can therefore never turn into an accidental pass.
 */
export function checkPlanAdmission(input: {
  baseRef: string;
  headRef: string;
  changes: AdmissionChangesPort;
  projection: AdmissionProjectionPort;
}): AdmissionCheckResult {
  const findings: AdmissionCheckFinding[] = [];
  let comparison: AdmissionComparison | undefined;

  try {
    comparison = input.changes.compare(input.baseRef, input.headRef);
  } catch (error) {
    findings.push({
      path: "<comparison>",
      code: "plan-admission-comparison-unavailable",
      detail: errorDetail(error),
    });
  }

  let projectionValid = false;
  try {
    const validation = input.projection.validate();
    projectionValid = validation.ok && validation.findings.length === 0;
    for (const finding of validation.findings) {
      findings.push({
        path: "<projection>",
        code: "plan-admission-projection-invalid",
        detail: finding.detail ? `${finding.code}: ${finding.detail}` : finding.code,
      });
    }
    if (!validation.ok && validation.findings.length === 0) {
      findings.push({ path: "<projection>", code: "plan-admission-projection-invalid" });
    }
  } catch (error) {
    findings.push({
      path: "<projection>",
      code: "plan-admission-projection-invalid",
      detail: errorDetail(error),
    });
  }

  if (comparison) {
    findings.push(...comparisonCompletenessFindings(comparison));
    const complete = findings.every(
      (finding) =>
        finding.code !== "plan-admission-base-incomplete" &&
        finding.code !== "plan-admission-head-incomplete",
    );
    if (complete && projectionValid) {
      try {
        findings.push(
          ...analyzePlanAdmissionDiff({
            base: comparison.base,
            head: comparison.head,
            changes: comparison.changes,
            receipts: input.projection,
          }).findings,
        );
      } catch (error) {
        findings.push({
          path: "<analysis>",
          code: "plan-admission-analysis-failed",
          detail: errorDetail(error),
        });
      }
    }
  }

  return { ok: findings.length === 0, findings };
}

function comparisonCompletenessFindings(comparison: AdmissionComparison): AdmissionCheckFinding[] {
  const findings: AdmissionCheckFinding[] = [];
  const basePaths = new Set(comparison.base.map((blob) => blob.path));
  const headPaths = new Set(comparison.head.map((blob) => blob.path));
  const baseMissing = new Set<string>();
  const headMissing = new Set<string>();

  if (!comparison.baseComplete) baseMissing.add("<base-snapshot>");
  if (!comparison.headComplete) headMissing.add("<head-snapshot>");

  for (const change of comparison.changes) {
    if (change.kind === "modified" || change.kind === "deleted") {
      if (!basePaths.has(change.path)) baseMissing.add(change.path);
    } else if (change.kind === "renamed" && !basePaths.has(change.from)) {
      baseMissing.add(change.from);
    }
    if (change.kind !== "deleted" && !headPaths.has(change.path)) {
      headMissing.add(change.path);
    }
  }

  for (const path of baseMissing) findings.push({ path, code: "plan-admission-base-incomplete" });
  for (const path of headMissing) findings.push({ path, code: "plan-admission-head-incomplete" });
  return findings;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
