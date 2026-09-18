import { describe, expect, it } from "vitest";
import {
  adaptLegacyPlan,
  resolveLegacyPlanAlias,
} from "../../src/plan-asset/adapters/legacy-plan-adapter.ts";
import {
  createRedactedCommandArgs,
  EvidenceRecord,
} from "../../src/plan-asset/domain/evidence-record.ts";
import { PlanAsset, PlanRevision } from "../../src/plan-asset/domain/plan-asset.ts";
import { PlanIdReservation } from "../../src/plan-asset/domain/reservation.ts";

const digest = "a".repeat(64);
const commit = "b".repeat(40);

describe("PLAN Asset v2 domain", () => {
  it("U-PA-001: rejects an invalid asset identity", () => {
    expect(
      PlanAsset.create({ assetId: "", alias: "PLAN-L7-1-a", payload: {}, bodyDigest: digest }).ok,
    ).toBe(false);
  });

  it("U-PA-002: rejects revision gaps and duplicates", () => {
    const revisions = [revision(1), revision(3)];
    const result = PlanAsset.reconstruct(revisions);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.ruleId).toBe("plan-revision-gap");
  });

  it("U-PA-003: revise preserves asset identity across alias and layer changes", () => {
    const created = PlanAsset.create({
      assetId: `plan:legacy:${"1".repeat(64)}`,
      alias: "PLAN-L4-1-old",
      payload: { layer: "L4" },
      bodyDigest: digest,
    });
    if (!created.ok) throw new Error("fixture must be valid");
    const revised = created.value.revise({
      baseRevision: 1,
      alias: "PLAN-L5-1-new",
      payload: { layer: "L5" },
      bodyDigest: "c".repeat(64),
      actor: "codex",
      reason: "layer move",
    });
    expect(revised.ok).toBe(true);
    if (revised.ok) {
      expect(revised.value.asset.assetId).toBe(created.value.assetId);
      expect(revised.value.asset.latest.revision).toBe(2);
    }
  });

  it("U-PA-004: revision and evidence snapshots remain immutable after revise", () => {
    const created = PlanAsset.create({
      assetId: `plan:legacy:${"2".repeat(64)}`,
      alias: "PLAN-L6-2-old",
      payload: { value: "before" },
      bodyDigest: digest,
    });
    if (!created.ok) throw new Error("fixture must be valid");
    const evidence = EvidenceRecord.create({
      evidenceId: "evidence:old",
      subjectId: created.value.assetId,
      subjectRevision: 1,
      sourceCommit: commit,
      evidenceKind: "green-test-run",
      commandArgs: createRedactedCommandArgs(["bun", "test"]),
      claims: { runnerId: "vitest", testIds: ["U-PA-004"] },
      outputDigest: digest,
      exitCode: 0,
      producer: "ci",
      producedAt: "2026-07-10T00:00:00Z",
    });
    if (!evidence.ok) throw new Error("fixture must be valid");
    const before = JSON.stringify({ revision: created.value.latest, evidence: evidence.value });
    created.value.revise({
      baseRevision: 1,
      alias: "PLAN-L6-2-new",
      payload: { value: "after" },
      bodyDigest: "d".repeat(64),
      actor: "codex",
      reason: "semantic update",
    });
    expect(JSON.stringify({ revision: created.value.latest, evidence: evidence.value })).toBe(
      before,
    );
    expect(Object.isFrozen(created.value.latest)).toBe(true);
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

  it("U-PA-006: converts legacy fields losslessly and rejects ambiguous short aliases", () => {
    const adapted = adaptLegacyPlan({
      repositoryIdentity: "unison-ai-product/UT-TDD_AGENT-HARNESS",
      sourcePath: "docs/plans/PLAN-L7-170-alpha.md",
      legacyPlanId: "PLAN-L7-170-alpha",
      knownFrontmatter: { kind: "add-impl", layer: "L7" },
      unknownFrontmatter: { custom_nested: { enabled: true } },
      bodyDigest: digest,
      sourceCommit: commit,
    });
    expect(adapted.ok).toBe(true);
    if (adapted.ok) {
      expect(adapted.value.canonicalPayload.unknownFrontmatter).toEqual({
        custom_nested: { enabled: true },
      });
      expect(adapted.value.assetId).toMatch(/^plan:legacy:[a-f0-9]{64}$/);
    }
    expect(
      resolveLegacyPlanAlias("PLAN-L7-170", ["PLAN-L7-170-alpha", "PLAN-L7-170-beta"]),
    ).toMatchObject({ ok: false, error: { ruleId: "plan-migration-collision" } });
  });

  it("U-PA-007: accepts one active ordinal reservation and rejects the competitor", () => {
    const first = PlanIdReservation.reserve([], {
      reservationId: "reservation:a",
      namespace: "PLAN-L7",
      ordinal: 418,
      assetId: `plan:legacy:${"4".repeat(64)}`,
      leaseKeyVersion: "v2",
      leaseTokenHash: digest,
      commandId: "command:a",
      occurredAt: "2026-07-10T00:00:00Z",
      expiresAt: "2026-07-11T00:00:00Z",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const competing = PlanIdReservation.reserve(first.value.events, {
      reservationId: "reservation:b",
      namespace: "PLAN-L7",
      ordinal: 418,
      assetId: `plan:legacy:${"5".repeat(64)}`,
      leaseKeyVersion: "v2",
      leaseTokenHash: "e".repeat(64),
      commandId: "command:b",
      occurredAt: "2026-07-10T00:01:00Z",
      expiresAt: "2026-07-11T00:01:00Z",
    });
    expect(competing.ok).toBe(false);
    if (!competing.ok) expect(competing.error.ruleId).toBe("plan-id-reservation-conflict");
  });
});

function revision(value: number): PlanRevision {
  const result = PlanRevision.create({
    assetId: `plan:legacy:${"9".repeat(64)}`,
    revision: value,
    alias: `PLAN-L7-${value}-fixture`,
    payload: { revision: value },
    bodyDigest: digest,
    actor: "fixture",
    reason: "fixture",
  });
  if (!result.ok) throw new Error("fixture must be valid");
  return result.value;
}
