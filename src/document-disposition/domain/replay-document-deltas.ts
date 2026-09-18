import { canonicalField, sha256 } from "./canonical-frame.ts";
import {
  afterOf,
  beforeOf,
  type DocumentDelta,
  type DocumentMemberIdentity,
  documentDeltaChainDigest,
  documentDeltaEventDigest,
  validDocumentMemberIdentity,
} from "./document-delta.ts";
import {
  createDocumentDeltaFinding,
  type DocumentDeltaFinding,
  stableDocumentDeltaFindings,
} from "./document-delta-finding.ts";
import {
  affectedPath,
  applyDocumentDelta,
  caseFoldCollisions,
  compareUtf8,
  duplicatePaths,
  effectiveReductionDigest,
  sameMember,
} from "./document-delta-reducer.ts";
import {
  type DocumentDispositionInput,
  validateDocumentDisposition,
} from "./document-disposition.ts";

export {
  createDocumentDeltaEvent,
  type DocumentDelta,
  type DocumentDeltaPayload,
  type DocumentMemberIdentity,
  documentDeltaChainDigest,
} from "./document-delta.ts";

export type { DocumentDeltaFinding } from "./document-delta-finding.ts";

export interface DocumentDeltaDecision {
  readonly deltaId: string;
  readonly ledgerId: string;
  readonly fromSnapshotDigest: string;
  readonly toSnapshotDigest: string;
  readonly operationKind: DocumentDelta["kind"];
  readonly before?: DocumentMemberIdentity;
  readonly after?: DocumentMemberIdentity;
  readonly affectedPath: string;
  readonly decisionDigest: string;
  readonly record: DocumentDispositionInput;
}

export type DocumentDeltaDecisionDraft = Omit<DocumentDeltaDecision, "decisionDigest">;

export function documentDeltaDecisionDigest(decision: DocumentDeltaDecisionDraft): string {
  const { record } = decision;
  const applicability = record.applicability;
  return sha256([
    canonicalField("delta_id", decision.deltaId),
    canonicalField("ledger_id", decision.ledgerId),
    canonicalField("from_snapshot_digest", decision.fromSnapshotDigest),
    canonicalField("to_snapshot_digest", decision.toSnapshotDigest),
    canonicalField("operation_kind", decision.operationKind),
    canonicalField("before_path", decision.before?.path ?? ""),
    canonicalField("before_blob_oid", decision.before?.blobOid ?? ""),
    canonicalField("before_content_digest", decision.before?.contentDigest ?? ""),
    canonicalField("after_path", decision.after?.path ?? ""),
    canonicalField("after_blob_oid", decision.after?.blobOid ?? ""),
    canonicalField("after_content_digest", decision.after?.contentDigest ?? ""),
    canonicalField("affected_path", decision.affectedPath),
    canonicalField("baseline_path", record.baselinePath),
    canonicalField("disposition", record.disposition),
    canonicalField("reason", record.reason),
    canonicalField("targets", [...record.targets].sort(compareUtf8).join("\0")),
    canonicalField("plan_ids", [...record.planIds].sort(compareUtf8).join("\0")),
    canonicalField("application_status", record.applicationStatus),
    canonicalField("applicability_kind", applicability.kind),
    canonicalField("applicability_reason", applicability.reason ?? ""),
    canonicalField("observed_condition", applicability.observedCondition ?? ""),
    canonicalField("reevaluation_trigger", applicability.reevaluationTrigger ?? ""),
    canonicalField("applicability_plan_id", applicability.planId ?? ""),
    canonicalField("applicability_decider", applicability.decider ?? ""),
  ]);
}

export function createDocumentDeltaDecision(
  decision: DocumentDeltaDecisionDraft,
): DocumentDeltaDecision {
  const validation = validateDocumentDisposition(decision.record);
  const operationShapeIsValid =
    (decision.operationKind === "add" &&
      decision.before === undefined &&
      validDocumentMemberIdentity(decision.after)) ||
    (decision.operationKind === "delete" &&
      validDocumentMemberIdentity(decision.before) &&
      decision.after === undefined) ||
    ((decision.operationKind === "modify" || decision.operationKind === "rename") &&
      validDocumentMemberIdentity(decision.before) &&
      validDocumentMemberIdentity(decision.after));
  const expectedPath =
    decision.operationKind === "delete" ? decision.before?.path : decision.after?.path;
  if (
    !validation.ok ||
    !operationShapeIsValid ||
    decision.deltaId.trim().length === 0 ||
    decision.ledgerId.trim().length === 0 ||
    decision.fromSnapshotDigest.trim().length === 0 ||
    decision.toSnapshotDigest.trim().length === 0 ||
    expectedPath !== decision.affectedPath ||
    decision.record.baselinePath !== decision.affectedPath
  ) {
    throw new TypeError("document-delta-decision-invalid");
  }
  return { ...decision, decisionDigest: documentDeltaDecisionDigest(decision) };
}

const sameOptionalMember = (
  left: DocumentMemberIdentity | undefined,
  right: DocumentMemberIdentity | undefined,
): boolean => (left === undefined && right === undefined) || sameMember(left, right);

export interface ReplayDocumentDeltasInput {
  readonly ledgerId: string;
  readonly baseline: readonly DocumentMemberIdentity[];
  readonly final: readonly DocumentMemberIdentity[];
  readonly deltas: readonly DocumentDelta[];
  readonly decisions: readonly DocumentDeltaDecision[];
  readonly baselineSnapshotDigest: string;
  readonly finalSnapshotDigest: string;
  readonly expectedDeltaChainDigest: string;
  readonly policyRevision: string;
}

export type DocumentDeltaReplayResult =
  | {
      readonly findings: readonly [];
      readonly ok: true;
      readonly effective: readonly DocumentMemberIdentity[];
      readonly reductionDigest: string;
      readonly deltaChainDigest: string;
    }
  | {
      readonly findings: readonly DocumentDeltaFinding[];
      readonly ok: false;
      readonly deltaChainDigest: string;
    };

export function replayDocumentDeltas(input: ReplayDocumentDeltasInput): DocumentDeltaReplayResult {
  const findings: DocumentDeltaFinding[] = [];
  const baselineDuplicates = duplicatePaths(input.baseline);
  const finalDuplicates = duplicatePaths(input.final);
  for (const path of baselineDuplicates) {
    findings.push(
      createDocumentDeltaFinding({
        context: input,
        kind: "chain",
        subjectIdentity: path,
        reasonCode: "baseline-duplicate",
      }),
    );
  }
  for (const path of finalDuplicates) {
    findings.push(
      createDocumentDeltaFinding({
        context: input,
        kind: "chain",
        subjectIdentity: path,
        reasonCode: "final-duplicate",
      }),
    );
  }
  for (const collision of caseFoldCollisions(input.baseline)) {
    findings.push(
      createDocumentDeltaFinding({
        context: input,
        kind: "chain",
        subjectIdentity: collision,
        reasonCode: "baseline-casefold-collision",
      }),
    );
  }
  for (const collision of caseFoldCollisions(input.final)) {
    findings.push(
      createDocumentDeltaFinding({
        context: input,
        kind: "chain",
        subjectIdentity: collision,
        reasonCode: "final-casefold-collision",
      }),
    );
  }

  const state = new Map(input.baseline.map((member) => [member.path, member]));
  const decisionCounts = new Map<string, number>();
  for (const decision of input.decisions) {
    decisionCounts.set(decision.deltaId, (decisionCounts.get(decision.deltaId) ?? 0) + 1);
  }
  const deltaIdCounts = new Map<string, number>();
  for (const delta of input.deltas) {
    deltaIdCounts.set(delta.deltaId, (deltaIdCounts.get(delta.deltaId) ?? 0) + 1);
  }
  const decisionIds = [...new Set(input.decisions.map(({ deltaId }) => deltaId))];
  for (const decisionId of decisionIds) {
    if (!deltaIdCounts.has(decisionId)) {
      findings.push(
        createDocumentDeltaFinding({
          context: input,
          kind: "chain",
          subjectIdentity: decisionId,
          reasonCode: "decision-phantom",
        }),
      );
    }
  }

  const deltas = [...input.deltas].sort(
    (left, right) =>
      left.sequence - right.sequence || compareUtf8(left.eventDigest, right.eventDigest),
  );
  const sequenceCounts = new Map<number, number>();
  for (const delta of deltas) {
    sequenceCounts.set(delta.sequence, (sequenceCounts.get(delta.sequence) ?? 0) + 1);
  }
  let previous: string | null = null;
  let poisoned = findings.length > 0;

  for (let index = 0; index < deltas.length; index += 1) {
    const delta = deltas[index];
    const decisions = input.decisions.filter(({ deltaId }) => deltaId === delta.deltaId);
    const decision = decisions[0];
    const decisionValidation = decision && validateDocumentDisposition(decision.record);
    const reason =
      delta.ledgerId !== input.ledgerId
        ? "ledger-mismatch"
        : deltaIdCounts.get(delta.deltaId) !== 1
          ? "delta-id-duplicate"
          : delta.fromSnapshotDigest !== input.baselineSnapshotDigest ||
              delta.toSnapshotDigest !== input.finalSnapshotDigest
            ? "snapshot-mismatch"
            : sequenceCounts.get(delta.sequence) !== 1 || delta.sequence !== index + 1
              ? "sequence-invalid"
              : delta.previousEventDigest !== previous
                ? "chain-link-invalid"
                : delta.eventDigest !== documentDeltaEventDigest(delta)
                  ? "event-digest-invalid"
                  : decisionCounts.get(delta.deltaId) !== 1
                    ? "decision-cardinality-invalid"
                    : decision?.decisionDigest !== delta.decisionDigest ||
                        (decision &&
                          decision.decisionDigest !== documentDeltaDecisionDigest(decision)) ||
                        decision.ledgerId !== delta.ledgerId ||
                        decision.fromSnapshotDigest !== delta.fromSnapshotDigest ||
                        decision.toSnapshotDigest !== delta.toSnapshotDigest ||
                        decision.operationKind !== delta.kind ||
                        !sameOptionalMember(decision.before, beforeOf(delta)) ||
                        !sameOptionalMember(decision.after, afterOf(delta)) ||
                        decision.affectedPath !== affectedPath(delta) ||
                        decision.record.baselinePath !== decision.affectedPath
                      ? "decision-mismatch"
                      : decisionValidation && !decisionValidation.ok
                        ? "decision-incomplete"
                        : poisoned
                          ? "prior-invalid"
                          : applyDocumentDelta(state, delta);
    if (reason) {
      findings.push(
        createDocumentDeltaFinding({
          context: input,
          kind: delta.kind,
          subjectIdentity: delta.deltaId,
          reasonCode: reason,
          sequence: delta.sequence,
          before: beforeOf(delta),
          after: afterOf(delta),
        }),
      );
      poisoned = true;
    }
    previous = delta.eventDigest;
  }

  const chainDigest = documentDeltaChainDigest(input);
  if (chainDigest !== input.expectedDeltaChainDigest) {
    findings.push(
      createDocumentDeltaFinding({
        context: input,
        kind: "chain",
        subjectIdentity: input.ledgerId,
        reasonCode: "chain-digest-invalid",
      }),
    );
    poisoned = true;
  }

  const finalByPath = new Map(input.final.map((member) => [member.path, member]));
  if (!poisoned) {
    const paths = new Set([...state.keys(), ...finalByPath.keys()]);
    for (const path of paths) {
      const actual = state.get(path);
      const expected = finalByPath.get(path);
      if (!actual && expected) {
        findings.push(
          createDocumentDeltaFinding({
            context: input,
            kind: "add",
            subjectIdentity: path,
            reasonCode: "final-mismatch",
            after: expected,
          }),
        );
      } else if (actual && !expected) {
        findings.push(
          createDocumentDeltaFinding({
            context: input,
            kind: "delete",
            subjectIdentity: path,
            reasonCode: "final-mismatch",
            before: actual,
          }),
        );
      } else if (!sameMember(actual, expected)) {
        findings.push(
          createDocumentDeltaFinding({
            context: input,
            kind: "modify",
            subjectIdentity: path,
            reasonCode: "final-mismatch",
            before: actual,
            after: expected,
          }),
        );
      }
    }
  }

  if (findings.length > 0) {
    return {
      findings: stableDocumentDeltaFindings(findings),
      ok: false,
      deltaChainDigest: chainDigest,
    };
  }
  const effective = [...state.values()].sort((left, right) => compareUtf8(left.path, right.path));
  return {
    findings: [],
    ok: true,
    effective,
    reductionDigest: effectiveReductionDigest(effective),
    deltaChainDigest: chainDigest,
  };
}
