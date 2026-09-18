import { EvidencePolicy } from "../../plan-asset/domain/evidence-policy.ts";
import type { EvidenceRecord } from "../../plan-asset/domain/evidence-record.ts";
import type { EvidenceAttestationVerifierPort } from "../../plan-asset/ports/evidence-attestation.ts";
import type { EvidenceRequirementSpec } from "../domain/transition-policy.ts";
import type {
  ForwardEvidenceContext,
  ForwardEvidenceEvaluationInput,
  ForwardEvidenceEvaluator,
  ForwardEvidenceResult,
  ForwardSubject,
} from "../domain/types.ts";

export class ForwardEvidencePolicy implements ForwardEvidenceEvaluator {
  private readonly verifier: EvidenceAttestationVerifierPort;
  constructor(verifier: EvidenceAttestationVerifierPort) {
    this.verifier = verifier;
  }

  evaluate(input: ForwardEvidenceEvaluationInput): ForwardEvidenceResult {
    const { spec, subject, evidence, context } = input;
    const accepted: string[] = [];
    const rejected: string[] = [];
    const required: string[] = [];
    for (const requirement of spec.evidence) {
      const result = this.evaluateRequirement({ requirement, subject, records: evidence, context });
      required.push(requirement.requirementId);
      accepted.push(...result.accepted);
      rejected.push(...result.rejected);
      if (!result.usable) required.push(`${requirement.requirementId}:missing`);
    }
    return {
      usable: !required.some((item) => item.endsWith(":missing")),
      required,
      accepted: stable(accepted),
      rejected: stable(rejected),
    };
  }

  private evaluateRequirement(input: {
    readonly requirement: EvidenceRequirementSpec;
    readonly subject: ForwardSubject;
    readonly records: readonly EvidenceRecord[];
    readonly context: ForwardEvidenceContext;
  }): ForwardEvidenceResult {
    const { requirement, subject, records, context } = input;
    const acceptedProducers =
      requirement.requiredKind !== "independent-review"
        ? requirement.acceptedProducers
        : context.authorFamily
          ? requirement.acceptedProducers.filter((producer) => producer !== context.authorFamily)
          : [];
    const cardinality =
      requirement.requiredKind === "targeted-test-run"
        ? { minCount: 1 }
        : { minCount: 1, maxCount: 1 };
    const created = EvidencePolicy.create(
      {
        policyId: `forward/${requirement.requirementId}`,
        revision: 1,
        requirements: [
          {
            requirementId: requirement.requirementId,
            requiredKind: requirement.requiredKind,
            ...cardinality,
            acceptedProducers,
            exitRule: requirement.exitRule,
            claimsRule: requirement.claimsRule,
          },
        ],
        ...(requirement.maxAgeMs === undefined ? {} : { maxAgeMs: requirement.maxAgeMs }),
      },
      this.verifier,
    );
    if (!created.ok)
      return { usable: false, required: [requirement.requirementId], accepted: [], rejected: [] };
    const result = created.value.evaluate(records, {
      subjectId: subject.subjectId,
      subjectRevision: subject.subjectRevision,
      sourceCommit: subject.sourceCommit,
      now: context.now ?? new Date().toISOString(),
    });
    return {
      usable: result.usable,
      required: [requirement.requirementId],
      accepted: result.eligibleEvidenceIds,
      rejected: result.rejectedEvidenceIds,
    };
  }
}

function stable(values: readonly string[]): readonly string[] {
  return Object.freeze(
    [...new Set(values)].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
  );
}
