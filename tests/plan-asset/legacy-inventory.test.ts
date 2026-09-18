import { describe, expect, it } from "vitest";
import {
  buildLegacyPlanInventory,
  inventoryProjectionDigest,
  parseLegacyPlanSource,
} from "../../src/plan-asset/adapters/legacy-plan-inventory.ts";
import { REVIEWED_REKEY_DECISIONS } from "../../src/plan-asset/application/legacy-migration-decision-manifest.ts";
import { headPlanDocCount } from "./head-plan-doc-count.ts";

describe("legacy PLAN HEAD inventory", () => {
  it("U-PA-019: inventories every HEAD PLAN losslessly with unique asset identities", () => {
    const result = buildLegacyPlanInventory(process.cwd());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const planCount = headPlanDocCount(process.cwd());
    expect(planCount).toBeGreaterThanOrEqual(752);
    expect(result.value.items).toHaveLength(planCount);
    expect(new Set(result.value.items.map((item) => item.sourcePath)).size).toBe(planCount);
    expect(new Set(result.value.items.map((item) => item.assetId)).size).toBe(planCount);
    expect(result.value.items.every((item) => item.frontmatter.plan_id === item.legacyPlanId)).toBe(
      true,
    );
    expect(
      result.value.items.every(
        (item) =>
          Object.keys(item.frontmatter).length ===
          Object.keys(item.knownFrontmatter).length + Object.keys(item.unknownFrontmatter).length,
      ),
    ).toBe(true);
    expect(
      result.value.items.every((item) =>
        /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(item.sourceBlobOid),
      ),
    ).toBe(true);
  });

  it("U-PA-020: materializes all current numeric-core collisions without auto-selection", () => {
    const result = buildLegacyPlanInventory(process.cwd());
    if (!result.ok) throw new Error(result.error.ruleId);
    const reviewedGroups = new Map<string, string[]>();
    for (const [planId, group] of REVIEWED_REKEY_DECISIONS) {
      reviewedGroups.set(group, [...(reviewedGroups.get(group) ?? []), planId].sort());
    }
    expect(
      result.value.collisionGroups.map((group) => [group.numericCore, [...group.planIds].sort()]),
    ).toEqual([...reviewedGroups.entries()].sort(([left], [right]) => left.localeCompare(right)));
    expect(result.value.collisionGroups.every((group) => group.planIds.length > 1)).toBe(true);
  });

  it("U-PA-021: produces a deterministic inventory digest from the same HEAD", () => {
    const first = buildLegacyPlanInventory(process.cwd());
    const second = buildLegacyPlanInventory(process.cwd());
    expect(second).toEqual(first);
    if (first.ok) expect(first.value.inventoryDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("U-PA-021: fixes the canonical projection digest with an independent fixture oracle", () => {
    const projection = {
      sourceCommit: "1".repeat(40),
      repositoryIdentity: "owner/repository",
      collisions: [["PLAN-L7-1", ["PLAN-L7-1-a", "PLAN-L7-1-b"]]],
      items: [["docs/plans/PLAN-L7-1-a.md", "PLAN-L7-1-a", "plan:legacy:a"]],
    } as const;
    const expected = "2de67b9ca087811f3f87b9bb958d38d04eafb2321737559be87670d24d52b782";
    expect(inventoryProjectionDigest(projection)).toBe(expected);
    expect(inventoryProjectionDigest({ ...projection, sourceCommit: "2".repeat(40) })).not.toBe(
      expected,
    );
  });

  it.each([
    ["anchor", "extra: &base value\ncopy: *base"],
    ["merge", "base: &base { enabled: true }\nextra:\n  <<: *base"],
    ["tag", "extra: !custom value"],
    ["non-string key", "extra:\n  1: value"],
    ["unsafe integer", `extra: ${Number.MAX_SAFE_INTEGER + 1}`],
  ])("U-PA-022: rejects lossless-incompatible YAML %s", (_kind, extra) => {
    expect(
      parseLegacyPlanSource(`---\nplan_id: PLAN-L7-999-fixture\n${extra}\n---\nbody\n`),
    ).toBeNull();
  });
});
