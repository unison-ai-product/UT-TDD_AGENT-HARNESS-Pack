import {
  type CapturedEvidenceAttestationVerifier,
  captureEvidenceAttestationVerifier,
} from "../kernel/hmac-evidence-attestation-verifier.ts";
import type { EvidenceAttestationVerifierPort } from "../ports/evidence-attestation.ts";
import { cloneCanonical, deepFreeze } from "./evidence-canonical.ts";
import { claimsRuleValidFor, claimsSatisfy } from "./evidence-claims.ts";
import type { EvidenceRecord } from "./evidence-record.ts";
import {
  EVIDENCE_KINDS,
  EVIDENCE_PRODUCERS,
  type EvidenceClaimsRule,
  type EvidenceExitRule,
  type EvidenceKind,
  type EvidenceProducer,
} from "./evidence-types.ts";

type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export interface EvidenceRequirement {
  readonly requirementId: string;
  readonly requiredKind: EvidenceKind;
  readonly minCount: number;
  readonly maxCount?: number;
  readonly acceptedProducers: readonly EvidenceProducer[];
  readonly exitRule: EvidenceExitRule;
  readonly claimsRule: EvidenceClaimsRule;
}

export interface EvidenceEvaluationContext {
  readonly subjectId: string;
  readonly subjectRevision: number;
  readonly sourceCommit: string;
  readonly now: string;
}

export class EvidencePolicy {
  readonly policyId: string;
  readonly revision: number;
  readonly requirements: readonly EvidenceRequirement[];
  readonly maxAgeMs?: number;
  readonly #verify: CapturedEvidenceAttestationVerifier;

  private constructor(
    input: {
      readonly policyId: string;
      readonly revision: number;
      readonly requirements: readonly EvidenceRequirement[];
      readonly maxAgeMs?: number;
    },
    verify: CapturedEvidenceAttestationVerifier,
  ) {
    this.policyId = input.policyId;
    this.revision = input.revision;
    this.requirements = Object.freeze(
      input.requirements
        .map((requirement) => deepFreeze(cloneCanonical(requirement)))
        .sort((left, right) => bytewise(left.requirementId, right.requirementId)),
    );
    this.maxAgeMs = input.maxAgeMs;
    this.#verify = verify;
    Object.freeze(this);
  }

  static create(
    input: {
      readonly policyId: string;
      readonly revision: number;
      readonly requirements: readonly EvidenceRequirement[];
      readonly maxAgeMs?: number;
    },
    verifier: EvidenceAttestationVerifierPort,
  ): Result<EvidencePolicy, { readonly ruleId: string }> {
    const ids = input.requirements.map((requirement) => requirement.requirementId);
    const verify = captureEvidenceAttestationVerifier(verifier);
    const valid =
      input.policyId.trim().length > 0 &&
      Number.isSafeInteger(input.revision) &&
      input.revision > 0 &&
      input.requirements.length > 0 &&
      new Set(ids).size === ids.length &&
      (input.maxAgeMs === undefined ||
        (Number.isSafeInteger(input.maxAgeMs) && input.maxAgeMs > 0)) &&
      input.requirements.every(requirementValid) &&
      verify !== null;
    return valid
      ? { ok: true, value: new EvidencePolicy(input, verify) }
      : { ok: false, error: { ruleId: "evidence-policy-invalid" } };
  }

  evaluate(records: readonly EvidenceRecord[], context: EvidenceEvaluationContext) {
    const graph = validateSupersession(records);
    const active = new Set(records.map((record) => record.evidenceId));
    for (const record of records) {
      if (record.supersedesEvidenceId) active.delete(record.supersedesEvidenceId);
    }
    const results = this.requirements.map((requirement) => {
      const matching = records.filter((record) => record.evidenceKind === requirement.requiredKind);
      const eligible = matching.filter(
        (record) =>
          active.has(record.evidenceId) &&
          Boolean(
            record.attestation &&
              this.#verify(
                { producer: record.producer, recordDigest: record.recordDigest },
                record.attestation,
              ),
          ) &&
          record.isUsableFor({ ...context, ...requirement }).usable &&
          claimsSatisfy(record.evidenceKind, record.claims, requirement.claimsRule) &&
          (this.maxAgeMs === undefined ||
            Date.parse(context.now) - Date.parse(record.producedAt) <= this.maxAgeMs),
      );
      const eligibleIds = stableIds(eligible);
      const rejectedIds = stableIds(
        matching.filter((record) => !eligibleIds.includes(record.evidenceId)),
      );
      return Object.freeze({
        requirementId: requirement.requirementId,
        evidenceKind: requirement.requiredKind,
        eligibleEvidenceIds: eligibleIds,
        rejectedEvidenceIds: rejectedIds,
        missingCount: Math.max(0, requirement.minCount - eligible.length),
        excessCount: Math.max(0, eligible.length - (requirement.maxCount ?? eligible.length)),
      });
    });
    const eligibleEvidenceIds = stableStrings(
      results.flatMap((result) => result.eligibleEvidenceIds),
    );
    const rejectedEvidenceIds = stableStrings(
      records
        .map((record) => record.evidenceId)
        .filter((evidenceId) => !eligibleEvidenceIds.includes(evidenceId)),
    );
    const missingCount = results.reduce((sum, result) => sum + result.missingCount, 0);
    const excessCount = results.reduce((sum, result) => sum + result.excessCount, 0);
    return Object.freeze({
      usable: graph.length === 0 && missingCount === 0 && excessCount === 0,
      policyId: this.policyId,
      policyRevision: this.revision,
      eligibleEvidenceIds,
      rejectedEvidenceIds,
      missingCount,
      excessCount,
      violations: Object.freeze(graph),
      requirements: Object.freeze(results),
    });
  }
}

function requirementValid(requirement: EvidenceRequirement): boolean {
  return (
    requirement.requirementId.trim().length > 0 &&
    Number.isSafeInteger(requirement.minCount) &&
    requirement.minCount > 0 &&
    (requirement.maxCount === undefined ||
      (Number.isSafeInteger(requirement.maxCount) &&
        requirement.maxCount >= requirement.minCount)) &&
    requirement.acceptedProducers.length > 0 &&
    new Set(requirement.acceptedProducers).size === requirement.acceptedProducers.length &&
    EVIDENCE_KINDS.includes(requirement.requiredKind) &&
    requirement.acceptedProducers.every((producer) => EVIDENCE_PRODUCERS.includes(producer)) &&
    ["exact", "nonzero", "any"].includes(requirement.exitRule.kind) &&
    (requirement.exitRule.kind !== "exact" ||
      Number.isSafeInteger(requirement.exitRule.expected)) &&
    claimsRuleValidFor(requirement.requiredKind, requirement.claimsRule)
  );
}

function validateSupersession(records: readonly EvidenceRecord[]): readonly string[] {
  const violations: string[] = [];
  const byId = new Map<string, EvidenceRecord>();
  for (const record of records) {
    if (byId.has(record.evidenceId)) violations.push(`evidence-id-duplicate:${record.evidenceId}`);
    byId.set(record.evidenceId, record);
  }
  const superseders = new Map<string, number>();
  for (const record of records) {
    const targetId = record.supersedesEvidenceId;
    if (!targetId) continue;
    const target = byId.get(targetId);
    if (!target) violations.push(`evidence-supersession-orphan:${record.evidenceId}`);
    else if (
      target.subjectId !== record.subjectId ||
      target.subjectRevision !== record.subjectRevision ||
      target.evidenceKind !== record.evidenceKind
    ) {
      violations.push(`evidence-supersession-scope:${record.evidenceId}`);
    } else if (
      record.sourceCommit !== target.sourceCommit ||
      Date.parse(record.producedAt) <= Date.parse(target.producedAt)
    ) {
      violations.push(`evidence-supersession-causal-order:${record.evidenceId}`);
    }
    superseders.set(targetId, (superseders.get(targetId) ?? 0) + 1);
  }
  for (const [targetId, count] of superseders) {
    if (count > 1) violations.push(`evidence-supersession-fork:${targetId}`);
  }
  for (const record of records) {
    const seen = new Set<string>();
    let current: EvidenceRecord | undefined = record;
    while (current?.supersedesEvidenceId) {
      if (seen.has(current.supersedesEvidenceId)) {
        violations.push(`evidence-supersession-cycle:${record.evidenceId}`);
        break;
      }
      seen.add(current.evidenceId);
      current = byId.get(current.supersedesEvidenceId);
    }
  }
  return stableStrings(violations);
}

function stableIds(records: readonly EvidenceRecord[]): readonly string[] {
  return stableStrings(records.map((record) => record.evidenceId));
}

function stableStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort(bytewise));
}

function bytewise(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}
