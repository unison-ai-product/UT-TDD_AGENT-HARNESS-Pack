const GIT_REVISION = /^[0-9a-f]{40}$/;
const CONTENT_DIGEST = /^sha256:[0-9a-f]{64}$/;

export const NODE_GENERATION_CI_SCHEMA_VERSION = "node-generation-ci.v1" as const;
export const NODE_GENERATION_CI_LANES = ["linux", "windows"] as const;

export type NodeGenerationCiLane = (typeof NODE_GENERATION_CI_LANES)[number];

export interface NodeGenerationCiEvidence {
  schema_version: typeof NODE_GENERATION_CI_SCHEMA_VERSION;
  lane: NodeGenerationCiLane;
  generation_id: string;
  sealed_generation_id: string;
  artifact_digest: string;
  subject_revision: string;
  workflow_revision: string;
  run_id: string;
  run_attempt: number;
  conclusion: "success";
}

export interface NodeGenerationCiExpectedBinding {
  workflow_revision: string;
  subject_revision: string;
  run_id: string;
  run_attempt: number;
}

export type NodeGenerationAggregateAdmission =
  | {
      ok: true;
      generation_id: string;
      artifact_digest: string;
      subject_revision: string;
      workflow_revision: string;
      run_id: string;
      run_attempt: number;
    }
  | {
      ok: false;
      reason:
        | "evidence-invalid"
        | "evidence-count-mismatch"
        | "evidence-lane-mismatch"
        | "evidence-conclusion-not-success"
        | "attempt_binding_mismatch"
        | "evidence-binding-mismatch"
        | "evidence-generation-mismatch"
        | "evidence-artifact-mismatch";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function parseNodeGenerationCiEvidence(value: unknown): NodeGenerationCiEvidence | null {
  if (!isRecord(value)) return null;
  const keys = [
    "schema_version",
    "lane",
    "generation_id",
    "sealed_generation_id",
    "artifact_digest",
    "subject_revision",
    "workflow_revision",
    "run_id",
    "run_attempt",
    "conclusion",
  ] as const;
  if (!exactKeys(value, keys)) return null;
  if (
    value.schema_version !== NODE_GENERATION_CI_SCHEMA_VERSION ||
    !NODE_GENERATION_CI_LANES.includes(value.lane as NodeGenerationCiLane) ||
    typeof value.generation_id !== "string" ||
    !/^[a-z0-9._-]+$/.test(value.generation_id) ||
    typeof value.sealed_generation_id !== "string" ||
    !/^[a-z0-9._-]+$/.test(value.sealed_generation_id) ||
    typeof value.artifact_digest !== "string" ||
    !CONTENT_DIGEST.test(value.artifact_digest) ||
    typeof value.subject_revision !== "string" ||
    !GIT_REVISION.test(value.subject_revision) ||
    typeof value.workflow_revision !== "string" ||
    !GIT_REVISION.test(value.workflow_revision) ||
    typeof value.run_id !== "string" ||
    value.run_id.length === 0 ||
    typeof value.run_attempt !== "number" ||
    !Number.isSafeInteger(value.run_attempt) ||
    value.run_attempt < 1 ||
    value.conclusion !== "success"
  )
    return null;
  return value as unknown as NodeGenerationCiEvidence;
}

const reject = (
  reason: Exclude<NodeGenerationAggregateAdmission, { ok: true }>["reason"],
): NodeGenerationAggregateAdmission => ({
  ok: false,
  reason,
});

/**
 * Pure F0c admission oracle. It accepts neither a partial pair nor fields
 * borrowed from another workflow run/attempt/revision.
 */
export function admitNodeGenerationAggregate(input: {
  evidence: readonly unknown[];
  expected: NodeGenerationCiExpectedBinding;
}): NodeGenerationAggregateAdmission {
  if (input.evidence.length !== NODE_GENERATION_CI_LANES.length)
    return reject("evidence-count-mismatch");
  const evidence = input.evidence.map(parseNodeGenerationCiEvidence);
  if (evidence.some((item) => item === null)) return reject("evidence-invalid");
  const entries = evidence as NodeGenerationCiEvidence[];
  if (
    new Set(entries.map((item) => item.lane)).size !== NODE_GENERATION_CI_LANES.length ||
    NODE_GENERATION_CI_LANES.some((lane) => !entries.some((item) => item.lane === lane))
  )
    return reject("evidence-lane-mismatch");
  if (entries.some((item) => item.conclusion !== "success"))
    return reject("evidence-conclusion-not-success");
  if (
    typeof input.expected.workflow_revision !== "string" ||
    !GIT_REVISION.test(input.expected.workflow_revision) ||
    typeof input.expected.subject_revision !== "string" ||
    !GIT_REVISION.test(input.expected.subject_revision) ||
    typeof input.expected.run_id !== "string" ||
    input.expected.run_id.length === 0 ||
    !Number.isSafeInteger(input.expected.run_attempt) ||
    input.expected.run_attempt < 1
  )
    return reject("evidence-binding-mismatch");
  if (entries.some((item) => item.run_attempt !== input.expected.run_attempt))
    return reject("attempt_binding_mismatch");
  if (
    entries.some(
      (item) =>
        item.workflow_revision !== input.expected.workflow_revision ||
        item.subject_revision !== input.expected.subject_revision ||
        item.run_id !== input.expected.run_id,
    )
  )
    return reject("evidence-binding-mismatch");
  if (new Set(entries.map((item) => item.generation_id)).size !== 1)
    return reject("evidence-generation-mismatch");
  if (new Set(entries.map((item) => item.artifact_digest)).size !== 1)
    return reject("evidence-artifact-mismatch");
  const first = entries[0];
  if (!first) return reject("evidence-invalid");
  return {
    ok: true,
    generation_id: first.generation_id,
    artifact_digest: first.artifact_digest,
    subject_revision: first.subject_revision,
    workflow_revision: first.workflow_revision,
    run_id: first.run_id,
    run_attempt: first.run_attempt,
  };
}
