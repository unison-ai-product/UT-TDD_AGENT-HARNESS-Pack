import { describe, expect, it } from "vitest";
import {
  type CanonicalPlanDraftCommand,
  calculatePlanDraftCommandDigests,
} from "../src/kernel/plan-draft-command-digest.ts";

const command: CanonicalPlanDraftCommand = {
  commandId: "command:draft-1",
  assetId: "asset:draft-1",
  planId: "PLAN-L7-999",
  alias: "PLAN-L7-999",
  sourcePath: "docs/plans/PLAN-L7-999.md",
  projectionPath: "docs/governance/plan-admission-receipts.json",
  sourceCommit: "a".repeat(40),
  actor: "codex",
  reason: "draft",
  canonicalPayloadJson: '{"title":"draft"}',
  bodyDigest: "b".repeat(64),
  identityAlgorithm: "uuid-v5",
  reservationId: "reservation:draft-1",
  namespace: "L7",
  ordinal: 999,
  leaseTokenHash: "c".repeat(64),
  expiresAt: "2026-07-16T00:00:00.000Z",
  routeTupleDigest: "d".repeat(64),
  certificateId: "certificate:draft-1",
  occurredAt: "2026-07-15T00:00:00.000Z",
};

describe("canonical PLAN draft command digest", () => {
  it("U-PADM-038: 同一commandからjournal/ledger共通の再現可能なSHA-256を導出する", () => {
    const first = calculatePlanDraftCommandDigests(command);
    const second = calculatePlanDraftCommandDigests({ ...command });

    expect(second).toEqual(first);
    expect(Object.values(first).every((digest) => /^[a-f0-9]{64}$/.test(digest))).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it.each([
    ["commandId", "command:draft-2"],
    ["canonicalPayloadJson", '{"title":"changed"}'],
    ["projectionPath", "docs/governance/other-plan-admission-receipts.json"],
    ["reason", "redesign"],
    ["routeTupleDigest", "e".repeat(64)],
    ["occurredAt", "2026-07-15T00:00:01.000Z"],
  ] as const)("%s の変更をcommand digestへ反映する", (field, value) => {
    const baseline = calculatePlanDraftCommandDigests(command);
    const changed = calculatePlanDraftCommandDigests({ ...command, [field]: value });

    expect(changed.commandPayloadDigest).not.toBe(baseline.commandPayloadDigest);
  });

  it("U-PADM-039: 外部のdigest自己申告を受け取るフィールドをdomain commandに持たない", () => {
    expect(Object.keys(command)).not.toContain("payloadDigest");
    expect(Object.keys(command)).not.toContain("commandPayloadDigest");
    const claimed = { ...command, payloadDigest: "f".repeat(64) };

    expect(calculatePlanDraftCommandDigests(claimed)).toEqual(
      calculatePlanDraftCommandDigests(command),
    );
  });
});
