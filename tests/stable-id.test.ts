import { describe, expect, it } from "vitest";
import { stableId } from "../src/stable-id.ts";

describe("stableId", () => {
  it("keeps existing ASCII identifiers unchanged", () => {
    expect(stableId("plan", "PLAN-L7-405-spec-ir-detector-precision")).toBe(
      "plan:PLAN-L7-405-spec-ir-detector-precision",
    );
  });

  it("adds a deterministic hash suffix when sanitization drops information", () => {
    expect(stableId("spec", "docs/plans/PLAN-L7-405.md#document")).toMatch(
      /^spec:docs-plans-PLAN-L7-405.md-document--[a-f0-9]{12}$/,
    );

    const first = stableId("spec", "docs/design.md#設計");
    const second = stableId("spec", "docs/design.md#試験");

    expect(first).toMatch(/^spec:docs-design.md---[a-f0-9]{12}$/);
    expect(second).toMatch(/^spec:docs-design.md---[a-f0-9]{12}$/);
    expect(first).not.toBe(second);
  });

  it("normalizes empty values to the existing unknown sentinel", () => {
    expect(stableId("asset", "")).toBe("asset:unknown");
  });
});
