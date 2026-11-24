import { describe, expect, it } from "vitest";
import {
  createRedactedCommandArgs,
  EvidenceRecord,
  type EvidenceRecordInput,
} from "../../src/forward/domain/evidence-record.ts";

const digest = "a".repeat(64);
const commit = "b".repeat(40);

describe("Forward evidence records", () => {
  it("U-PA-004: evidence snapshots remain immutable after a newer snapshot is created", () => {
    const input = {
      evidenceId: "evidence:old",
      subjectId: "evidence-subject:old",
      subjectRevision: 1,
      sourceCommit: commit,
      evidenceKind: "green-test-run",
      commandArgs: createRedactedCommandArgs(["bun", "test"]),
      claims: { runnerId: "vitest", testIds: ["U-PA-004"] },
      outputDigest: digest,
      exitCode: 0,
      producer: "ci",
      producedAt: "2026-07-10T00:00:00Z",
    } satisfies EvidenceRecordInput<"green-test-run">;
    const evidence = EvidenceRecord.create(input);
    if (!evidence.ok) throw new Error("fixture must be valid");
    const before = JSON.stringify(evidence.value);
    EvidenceRecord.create({ ...input, evidenceId: "evidence:new", subjectRevision: 2 });
    expect(JSON.stringify(evidence.value)).toBe(before);
    expect(Object.isFrozen(evidence.value)).toBe(true);
  });

  it("U-PA-005: rejects stale, mismatched, expired, and policy-incompatible evidence", () => {
    const record = EvidenceRecord.create({
      evidenceId: "evidence:red",
      subjectId: `plan:legacy:${"3".repeat(64)}`,
      subjectRevision: 1,
      sourceCommit: commit,
      evidenceKind: "red-test-run",
      commandArgs: createRedactedCommandArgs(["bun", "test"]),
      claims: {
        expectedFindingIds: ["expected:red"],
        observedFindingIds: ["expected:red"],
        todoCount: 0,
        skipCount: 0,
      },
      outputDigest: digest,
      exitCode: 1,
      producer: "ci",
      producedAt: "2026-07-10T00:00:00Z",
      expiresAt: "2026-07-11T00:00:00Z",
    });
    if (!record.ok) throw new Error("fixture must be valid");
    expect(
      record.value.isUsableFor({
        requiredKind: "red-test-run",
        subjectId: record.value.subjectId,
        subjectRevision: 1,
        sourceCommit: commit,
        now: "2026-07-10T12:00:00Z",
        acceptedProducers: ["ci"],
        exitRule: { kind: "exact", expected: 1 },
      }).usable,
    ).toBe(true);
    expect(
      record.value.isUsableFor({
        requiredKind: "green-test-run",
        subjectId: record.value.subjectId,
        subjectRevision: 2,
        sourceCommit: commit,
        now: "2026-07-12T00:00:00Z",
        acceptedProducers: ["ci"],
        exitRule: { kind: "exact", expected: 0 },
      }),
    ).toMatchObject({ usable: false, ruleId: "evidence-stale-or-subject-mismatch" });
  });
});
