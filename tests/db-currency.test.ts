import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeDbCurrency, dbCurrencyMessages } from "../src/lint/db-currency";
import type { DriveDbRegistrationStats } from "../src/lint/drive-db-registration";
import { loadDriveDbRegistrationStats } from "../src/state-db/drive-registration";
import { rebuildHarnessDb } from "../src/state-db/projection-writer";

const currentStats: DriveDbRegistrationStats = {
  planCount: 10,
  expectedPlanCount: 10,
  planRegistryFingerprint: "sha256:1234567890abcdef",
  expectedPlanRegistryFingerprint: "sha256:1234567890abcdef",
  driveRuns: 10,
  plansWithoutDriveRun: 0,
  workflowRuns: 2,
  workflowOrphans: 0,
  modelRuns: 4,
  modelOrphans: 0,
  skillRecommendations: 10,
  skillRecommendationOrphans: 0,
  skillInvocations: 5,
  skillInvocationOrphans: 0,
  registeredHookEvents: 3,
  hookOrphans: 0,
  modes: ["Forward"],
};

describe("db-currency lint", () => {
  it("U-DBCURRENCY-001: accepts persisted harness.db when plan count and fingerprint match docs", () => {
    const result = analyzeDbCurrency(currentStats);

    expect(result.ok).toBe(true);
    expect(dbCurrencyMessages(result)[0]).toBe(
      "db-currency - OK (plans=10, fingerprint=1234567890ab)",
    );
  });

  it("U-DBCURRENCY-002: fails closed when on-disk harness.db is missing", () => {
    const result = analyzeDbCurrency(null);

    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([{ reason: "missing_db" }]);
    expect(dbCurrencyMessages(result)[0]).toContain("missing_db");
  });

  it("U-DBCURRENCY-003: detects stale plan count and stale content fingerprint separately", () => {
    const result = analyzeDbCurrency({
      ...currentStats,
      planCount: 9,
      expectedPlanCount: 10,
      planRegistryFingerprint: "sha256:old",
      expectedPlanRegistryFingerprint: "sha256:new",
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      { reason: "stale_plan_registry", count: -1 },
      { reason: "stale_plan_registry_fingerprint" },
    ]);
    expect(dbCurrencyMessages(result)[0]).toContain("stale_plan_registry=-1");
    expect(dbCurrencyMessages(result)[0]).toContain("stale_plan_registry_fingerprint");
  });

  it("U-DBCURRENCY-004: rebuilt on-disk harness.db is current against its PLAN docs", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-db-currency-"));
    try {
      const planDir = join(root, "docs", "plans");
      mkdirSync(planDir, { recursive: true });
      writeFileSync(
        join(planDir, "PLAN-TEST-db-currency.md"),
        [
          "---",
          "plan_id: PLAN-TEST-db-currency",
          "kind: impl",
          "layer: L7",
          "drive: db",
          "status: draft",
          "updated: 2026-07-07",
          "---",
          "",
          "## Body",
          "",
        ].join("\n"),
        "utf8",
      );

      rebuildHarnessDb({ repoRoot: root });
      const stats = loadDriveDbRegistrationStats(root);
      const result = analyzeDbCurrency(stats);

      expect(stats).not.toBeNull();
      expect(result.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
