import { describe, expect, it } from "vitest";
import {
  admitNodeGenerationAggregate,
  type NodeGenerationCiEvidence,
} from "../src/lint/node-generation-ci-policy.ts";

const revision = "a".repeat(40);
const artifactDigest = `sha256:${"b".repeat(64)}`;

function evidence(lane: "linux" | "windows"): NodeGenerationCiEvidence {
  return {
    schema_version: "node-generation-ci.v1",
    lane,
    generation_id: "node-ci-a-run-1-1",
    sealed_generation_id: `node-${lane}`,
    artifact_digest: artifactDigest,
    subject_revision: revision,
    workflow_revision: revision,
    run_id: "run-1",
    run_attempt: 1,
    conclusion: "success",
  };
}

const expected = {
  workflow_revision: revision,
  subject_revision: revision,
  run_id: "run-1",
  run_attempt: 1,
};

describe("Node generation CI aggregate admission", () => {
  it("CAND-NODEBOOT-103: admits exactly one successful Linux/Windows generation pair", () => {
    expect(
      admitNodeGenerationAggregate({
        evidence: [evidence("linux"), evidence("windows")],
        expected,
      }),
    ).toMatchObject({
      ok: true,
      generation_id: "node-ci-a-run-1-1",
    });
  });

  it.each([
    ["failure", { conclusion: "failure" }],
    ["cancelled", { conclusion: "cancelled" }],
    ["skipped", { conclusion: "skipped" }],
    ["missing", undefined],
  ] as const)("CAND-NODEBOOT-104: rejects a Node leg that is %s", (_label, mutation) => {
    const linux = evidence("linux");
    const input = mutation ? { ...linux, ...mutation } : undefined;
    expect(
      admitNodeGenerationAggregate({
        evidence: input ? [input, evidence("windows")] : [evidence("windows")],
        expected,
      }).ok,
    ).toBe(false);
  });

  it.each([
    ["workflow revision", { workflow_revision: "c".repeat(40) }],
    ["run id", { run_id: "run-2" }],
    ["run attempt", { run_attempt: 2 }],
    ["subject revision", { subject_revision: "d".repeat(40) }],
    ["generation", { generation_id: "node-ci-other" }],
    ["artifact", { artifact_digest: `sha256:${"e".repeat(64)}` }],
  ] as const)("CAND-NODEBOOT-105: rejects a cross-run or stale %s mutation", (_label, mutation) => {
    expect(
      admitNodeGenerationAggregate({
        evidence: [evidence("linux"), { ...evidence("windows"), ...mutation }],
        expected,
      }).ok,
    ).toBe(false);
  });

  it("CAND-NODEBOOT-105: labels a different workflow run as an evidence binding mismatch", () => {
    expect(
      admitNodeGenerationAggregate({
        evidence: [evidence("linux"), { ...evidence("windows"), run_id: "run-2" }],
        expected,
      }),
    ).toEqual({ ok: false, reason: "evidence-binding-mismatch" });
  });

  it("CAND-NODEBOOT-106: does not waive a missing or partial Node evidence pair", () => {
    expect(admitNodeGenerationAggregate({ evidence: [evidence("linux")], expected }).ok).toBe(
      false,
    );
    expect(
      admitNodeGenerationAggregate({
        evidence: [evidence("linux"), evidence("windows"), evidence("linux")],
        expected,
      }).ok,
    ).toBe(false);
  });

  it("CAND-NODEBOOT-105: failed-job-only rerun rejects retained producer artifacts with a typed attempt reason", () => {
    const attemptOne = [evidence("linux"), evidence("windows")];
    expect(
      admitNodeGenerationAggregate({
        evidence: attemptOne,
        expected: { ...expected, run_attempt: 2 },
      }),
    ).toEqual({ ok: false, reason: "attempt_binding_mismatch" });
  });

  it("CAND-NODEBOOT-105: full rerun admits only a same-attempt producer pair", () => {
    const attemptTwo = [
      { ...evidence("linux"), run_attempt: 2 },
      { ...evidence("windows"), run_attempt: 2 },
    ];
    expect(
      admitNodeGenerationAggregate({
        evidence: attemptTwo,
        expected: { ...expected, run_attempt: 2 },
      }),
    ).toMatchObject({ ok: true, run_attempt: 2 });
  });
});
