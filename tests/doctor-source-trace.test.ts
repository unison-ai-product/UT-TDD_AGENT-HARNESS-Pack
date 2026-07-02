import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkImplPlanTrace,
  checkMergedPlanStatus,
  checkOracleTestTrace,
  checkPlanArtifactExistence,
  checkTrackedCanonical,
} from "../src/doctor/index";
import {
  checkImplPlanTrace as checkImplPlanTraceAdapter,
  checkMergedPlanStatus as checkMergedPlanStatusAdapter,
  checkOracleTestTrace as checkOracleTestTraceAdapter,
  checkPlanArtifactExistence as checkPlanArtifactExistenceAdapter,
  checkTrackedCanonical as checkTrackedCanonicalAdapter,
} from "../src/doctor/source-trace";

describe("doctor source trace adapters", () => {
  it("keeps source/artifact trace gates fail-closed through the extracted module", () => {
    const missingRoot = join(tmpdir(), `ut-tdd-source-trace-missing-${Date.now()}-nope`);
    const checks = [
      checkMergedPlanStatusAdapter(missingRoot),
      checkPlanArtifactExistenceAdapter(missingRoot),
      checkImplPlanTraceAdapter(missingRoot),
      checkTrackedCanonicalAdapter(missingRoot),
      checkOracleTestTraceAdapter(missingRoot),
    ];

    expect(checks.map((result) => result.ok)).toEqual([false, false, false, false, false]);
    for (const result of checks) {
      expect(result.messages.join("\n")).toMatch(/violation/i);
    }
  });

  it("preserves the public doctor/index re-export surface", () => {
    expect(checkMergedPlanStatus).toBe(checkMergedPlanStatusAdapter);
    expect(checkPlanArtifactExistence).toBe(checkPlanArtifactExistenceAdapter);
    expect(checkImplPlanTrace).toBe(checkImplPlanTraceAdapter);
    expect(checkTrackedCanonical).toBe(checkTrackedCanonicalAdapter);
    expect(checkOracleTestTrace).toBe(checkOracleTestTraceAdapter);
  });
});
