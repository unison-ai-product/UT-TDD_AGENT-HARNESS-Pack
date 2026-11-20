import { exactKeys, isNonempty, isPlainObject, validIso } from "./evidence-canonical.ts";
import type { EvidenceClaims, EvidenceClaimsRule, EvidenceKind } from "./evidence-types.ts";

export function claimsValid(kind: EvidenceKind, value: unknown): value is EvidenceClaims {
  if (!isPlainObject(value)) return false;
  switch (kind) {
    case "scope-approval":
      return (
        exactKeys(value, ["decision", "approver"]) &&
        value.decision === "approved" &&
        isNonempty(value.approver)
      );
    case "pair-artifact-declaration":
      return exactKeys(value, ["artifactIds"]) && nonemptyStringArray(value.artifactIds);
    case "design-pair-review":
      return reviewClaims(value, false);
    case "red-test-run":
      return redClaims(value);
    case "targeted-test-run":
    case "green-test-run":
      return testClaims(value);
    case "implementation-digest":
      return exactKeys(value, ["implementationDigest"]) && digest(value.implementationDigest);
    case "trace-materialization":
      return exactKeys(value, ["traceIds"]) && nonemptyStringArray(value.traceIds);
    case "trace-closure":
      return traceClaims(value);
    case "independent-review":
      return reviewClaims(value, true);
    case "gate-run":
      return gateClaims(value);
    case "acceptance-decision":
      return decisionClaims(value, ["accepted", "rejected"]);
    case "retention-decision":
      return decisionClaims(value, ["retain", "archive"]);
    case "exception-context":
      return exceptionClaims(value);
  }
}

export function claimsRuleValidFor(kind: EvidenceKind, rule: EvidenceClaimsRule): boolean {
  switch (rule.kind) {
    case "recorded":
      return true;
    case "review-approved":
      return kind === "design-pair-review" || kind === "independent-review";
    case "red-observed":
      return kind === "red-test-run";
    case "trace-clean":
      return kind === "trace-closure";
    case "gate-passed":
      return kind === "gate-run";
    case "decision":
      return kind === "acceptance-decision" || kind === "retention-decision";
    default:
      return false;
  }
}

export function claimsSatisfy(
  kind: EvidenceKind,
  claims: EvidenceClaims,
  rule: EvidenceClaimsRule,
): boolean {
  if (!claimsRuleValidFor(kind, rule)) return false;
  const value = claims as unknown as Record<string, unknown>;
  switch (rule.kind) {
    case "recorded":
      return true;
    case "review-approved":
      return value.verdict === "approved";
    case "red-observed":
      return redOutcomeSatisfied(value);
    case "trace-clean":
      return value.orphanCount === 0 && value.staleCount === 0;
    case "gate-passed":
      return Array.isArray(value.failedGateIds) && value.failedGateIds.length === 0;
    case "decision":
      return value.decision === rule.expected;
  }
}

function redOutcomeSatisfied(value: Record<string, unknown>): boolean {
  if (value.todoCount !== 0 || value.skipCount !== 0) return false;
  const expected = Array.isArray(value.expectedFindingIds)
    ? [...value.expectedFindingIds].sort()
    : [];
  const observed = Array.isArray(value.observedFindingIds)
    ? [...value.observedFindingIds].sort()
    : [];
  return JSON.stringify(expected) === JSON.stringify(observed);
}

function redClaims(value: Record<string, unknown>): boolean {
  return (
    exactKeys(value, ["expectedFindingIds", "observedFindingIds", "todoCount", "skipCount"]) &&
    nonemptyStringArray(value.expectedFindingIds) &&
    stringArray(value.observedFindingIds) &&
    nonnegativeInteger(value.todoCount) &&
    nonnegativeInteger(value.skipCount)
  );
}

function testClaims(value: Record<string, unknown>): boolean {
  return (
    exactKeys(value, ["runnerId", "testIds"]) &&
    isNonempty(value.runnerId) &&
    nonemptyStringArray(value.testIds)
  );
}

function traceClaims(value: Record<string, unknown>): boolean {
  return (
    exactKeys(value, ["orphanCount", "staleCount", "traceDigest"]) &&
    nonnegativeInteger(value.orphanCount) &&
    nonnegativeInteger(value.staleCount) &&
    digest(value.traceDigest)
  );
}

function reviewClaims(value: Record<string, unknown>, timed: boolean): boolean {
  const keys = timed ? ["verdict", "reviewerId", "reviewedAt"] : ["verdict", "reviewerId"];
  return (
    exactKeys(value, keys) &&
    (value.verdict === "approved" || value.verdict === "rejected") &&
    isNonempty(value.reviewerId) &&
    (!timed || validIso(String(value.reviewedAt)))
  );
}

function gateClaims(value: Record<string, unknown>): boolean {
  return (
    exactKeys(value, ["gateIds", "failedGateIds"]) &&
    nonemptyStringArray(value.gateIds) &&
    stringArray(value.failedGateIds)
  );
}

function decisionClaims(value: Record<string, unknown>, decisions: readonly string[]): boolean {
  return (
    exactKeys(value, ["decision", "decidedBy"]) &&
    decisions.includes(String(value.decision)) &&
    isNonempty(value.decidedBy)
  );
}

function exceptionClaims(value: Record<string, unknown>): boolean {
  const allowed = new Set(["action", "actor", "reason", "resumeState", "replacementSubjectId"]);
  return (
    Object.keys(value).every((key) => allowed.has(key)) &&
    ["block", "reject", "supersede", "reopen", "resume"].includes(String(value.action)) &&
    isNonempty(value.actor) &&
    isNonempty(value.reason) &&
    (value.resumeState === undefined || isNonempty(value.resumeState)) &&
    (value.replacementSubjectId === undefined || isNonempty(value.replacementSubjectId)) &&
    (value.action !== "supersede" || isNonempty(value.replacementSubjectId))
  );
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isNonempty) && new Set(value).size === value.length;
}

function nonemptyStringArray(value: unknown): value is readonly string[] {
  return stringArray(value) && value.length > 0;
}

function nonnegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function digest(value: unknown): boolean {
  return /^[a-f0-9]{64}$/.test(String(value));
}
