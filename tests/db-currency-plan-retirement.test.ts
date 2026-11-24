import { describe, expect, it } from "vitest";
import { analyzeDbCurrency } from "../src/lint/db-currency.ts";

const currentStats = {
  planCount: 10,
  expectedPlanCount: 10,
  planRegistryFingerprint: "sha256:1234567890abcdef",
  expectedPlanRegistryFingerprint: "sha256:1234567890abcdef",
  driveRuns: 10,
  plansWithoutDriveRun: 0,
};

const stalePlanCountStats = {
  ...currentStats,
  planCount: 9,
  expectedPlanCount: 10,
};

const stalePlanFingerprintStats = {
  ...currentStats,
  planRegistryFingerprint: "sha256:old",
  expectedPlanRegistryFingerprint: currentStats.expectedPlanRegistryFingerprint,
};

describe("db-currency lint", () => {
  it("fixture precondition: candidate 010 mutates only one PLAN axis at a time", () => {
    expect(stalePlanCountStats.planCount).not.toBe(stalePlanCountStats.expectedPlanCount);
    expect(stalePlanCountStats.planRegistryFingerprint).toBe(
      stalePlanCountStats.expectedPlanRegistryFingerprint,
    );
    expect(stalePlanFingerprintStats.planCount).toBe(stalePlanFingerprintStats.expectedPlanCount);
    expect(stalePlanFingerprintStats.planRegistryFingerprint).not.toBe(
      stalePlanFingerprintStats.expectedPlanRegistryFingerprint,
    );
    expect(() => analyzeDbCurrency(stalePlanCountStats)).not.toThrow();
    expect(() => analyzeDbCurrency(stalePlanFingerprintStats)).not.toThrow();
  });

  it("U-PLANRET-010: PLAN count drift is not a db-currency violation", () => {
    const result = analyzeDbCurrency(stalePlanCountStats);

    expect(result).toMatchObject({ ok: true, violations: [] });
  });

  it("U-PLANRET-010: PLAN fingerprint drift is not a db-currency violation", () => {
    const result = analyzeDbCurrency(stalePlanFingerprintStats);

    expect(result).toMatchObject({ ok: true, violations: [] });
  });
});
