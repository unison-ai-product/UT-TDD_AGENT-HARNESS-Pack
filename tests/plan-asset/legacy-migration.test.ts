import { describe, expect, it } from "vitest";
import {
  type MigrationDecision,
  type MigrationEvent,
  reduceLegacyMigration,
  validateMigrationFields,
} from "../../src/plan-asset/domain/legacy-migration.ts";

describe("legacy migration reducer", () => {
  it("U-PA-023: observes pending without inventing a canonical revision", () => {
    expect(reduceLegacyMigration([event()])).toMatchObject({
      ok: true,
      state: { sequence: 1, decision: "pending", resolvedAlias: null },
    });
  });

  it.each([
    ["pending", null, null, [], "PLAN-L7-418-review", true],
    ["migrated", "PLAN-L7-1-a", null, [], null, true],
    ["rekeyed", "PLAN-L7-900-a", "PLAN-L7-1", [], "PLAN-L7-418-review", true],
    ["rejected", null, null, ["frontmatter.extra"], "PLAN-L7-418-review", true],
    ["pending", "PLAN-L7-1-a", null, [], "PLAN-L7-418-review", false],
    ["migrated", "PLAN-L7-1-a", "PLAN-L7-1", [], null, false],
    ["rekeyed", "PLAN-L7-900-a", null, [], "PLAN-L7-418-review", false],
    ["rejected", null, null, [], "PLAN-L7-418-review", false],
  ] as const)("U-PA-025: validates %s decision field matrix", (decision, alias, group, loss, review, ok) => {
    const violation = validateMigrationFields({
      decision,
      resolvedAlias: alias,
      collisionGroup: group,
      lossFields: loss,
      reason: "explicit review",
      reviewPlanId: review,
    });
    if (ok) expect(violation).toBeNull();
    else expect(violation).not.toBeNull();
  });

  it.each([
    ["observe twice", [event(), event({ sequence: 2 })]],
    ["decide pending", [event(), event({ sequence: 2, kind: "decided" })]],
    ["revise pending", [event(), event({ sequence: 2, kind: "revised", ...fields("migrated") })]],
    [
      "repeat terminal",
      [
        event(),
        event({ sequence: 2, kind: "decided", ...fields("migrated") }),
        event({ sequence: 3, kind: "revised", ...fields("migrated") }),
      ],
    ],
  ])("U-PA-024: rejects invalid transition %s", (_case, events) => {
    expect(reduceLegacyMigration(events as MigrationEvent[])).toMatchObject({
      ok: false,
      ruleId: "plan-migration-transition-invalid",
    });
  });

  it.each([
    ["sequence", { sequence: 3 }, "plan-migration-event-sequence-invalid"],
    ["asset", { assetId: "plan:other" }, "plan-migration-provenance-invalid"],
    ["source", { sourceDigest: "c".repeat(64) }, "plan-migration-provenance-invalid"],
    ["time", { occurredAt: "2026-07-12T00:00:00Z" }, "plan-migration-provenance-invalid"],
  ])("U-PA-031: rejects immutable stream mutation %s", (_case, mutation, ruleId) => {
    expect(
      reduceLegacyMigration([
        event(),
        event({ sequence: 2, kind: "decided", ...fields("migrated"), ...mutation }),
      ]),
    ).toMatchObject({ ok: false, ruleId });
  });
});

function event(overrides: Partial<MigrationEvent> = {}): MigrationEvent {
  return {
    kind: "observed",
    sequence: 1,
    legacyPlanId: "PLAN-L7-1-a",
    assetId: "plan:legacy:a",
    repositoryIdentity: "owner/repository",
    identityDigest: "a".repeat(64),
    sourceDigest: "b".repeat(64),
    occurredAt: "2026-07-13T00:00:00Z",
    ...fields("pending"),
    ...overrides,
  };
}

function fields(decision: MigrationDecision) {
  const common = { decision, reason: "explicit review" } as const;
  if (decision === "pending")
    return {
      ...common,
      resolvedAlias: null,
      collisionGroup: null,
      lossFields: [],
      reviewPlanId: "PLAN-L7-418-review",
    };
  if (decision === "migrated")
    return {
      ...common,
      resolvedAlias: "PLAN-L7-1-a",
      collisionGroup: null,
      lossFields: [],
      reviewPlanId: null,
    };
  if (decision === "rekeyed")
    return {
      ...common,
      resolvedAlias: "PLAN-L7-900-a",
      collisionGroup: "PLAN-L7-1",
      lossFields: [],
      reviewPlanId: "PLAN-L7-418-review",
    };
  return {
    ...common,
    resolvedAlias: null,
    collisionGroup: null,
    lossFields: ["frontmatter.extra"],
    reviewPlanId: "PLAN-L7-418-review",
  };
}
