import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkRoadmap as checkRoadmapFromIndex } from "../src/doctor/index";
import { checkRoadmap, checkVerificationGroupsResult } from "../src/doctor/roadmap-verification";

describe("doctor roadmap verification checks", () => {
  it("fails closed when roadmap and verification inputs cannot read the repo root", () => {
    const missingRoot = join(tmpdir(), `ut-tdd-doctor-roadmap-verification-${Date.now()}-missing`);

    const checks = [
      ["roadmap", checkRoadmap(missingRoot)],
      ["verification", checkVerificationGroupsResult(missingRoot)],
    ] as const;

    for (const [name, result] of checks) {
      expect(result.ok, name).toBe(false);
      expect(result.messages.join("\n"), name).toMatch(/violation/i);
    }
  });

  it("keeps the doctor index re-export path available", () => {
    const missingRoot = join(
      tmpdir(),
      `ut-tdd-doctor-roadmap-verification-index-${Date.now()}-missing`,
    );

    const result = checkRoadmapFromIndex(missingRoot);

    expect(result.ok).toBe(false);
    expect(result.messages.join("\n")).toContain("roadmap - violation");
  });
});
