import { describe, expect, it } from "vitest";
import { analyzeArtifactOwnership } from "../src/lint/artifact-ownership.ts";

describe("PLAN-L7-450 W2 duplicate artifact ownership", () => {
  it("U-L7-450-W2-001: duplicate declaration is a fail-closed finding, not last-wins", () => {
    const result = analyzeArtifactOwnership({
      ownersByPath: new Map([["src/example.ts", ["PLAN-A", "PLAN-B"]]]),
      baseline: new Set(),
    });
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({
        kind: "duplicate-artifact-ownership",
        artifactPath: "src/example.ts",
        planIds: ["PLAN-A", "PLAN-B"],
      }),
    ]);
  });

  it("U-L7-450-W2-002: a live-style unique ownership map is green", () => {
    expect(
      analyzeArtifactOwnership({
        ownersByPath: new Map([["src/example.ts", ["PLAN-A"]]]),
        baseline: new Set(),
      }).ok,
    ).toBe(true);
  });
});
