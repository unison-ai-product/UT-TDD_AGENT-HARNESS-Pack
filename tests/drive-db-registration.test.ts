import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeDriveDbRegistration,
  type DriveDbRegistrationStats,
  driveDbRegistrationMessages,
} from "../src/lint/drive-db-registration.ts";
import {
  collectDriveDbRegistrationStats,
  loadDriveDbRegistrationStats,
  loadOrBuildDriveDbRegistrationStats,
} from "../src/state-db/drive-registration.ts";
import { defaultHarnessDbPath, openHarnessDb, upsertRow } from "../src/state-db/index.ts";
import { migrate } from "../src/state-db/migration.ts";
import { rebuildHarnessDb } from "../src/state-db/projection-writer.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const compliant: DriveDbRegistrationStats = {
  planCount: 10,
  expectedPlanCount: 10,
  planRegistryFingerprint: "sha256:current",
  expectedPlanRegistryFingerprint: "sha256:current",
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
  hookOrphans: 99,
  modes: ["Discovery", "Forward", "Recovery", "Reverse", "Verification"],
};

describe("drive DB registration lint", () => {
  it("U-DDBREG-001: accepts drive/workflow/model/skill rows with resolvable joins", () => {
    const r = analyzeDriveDbRegistration(compliant);

    expect(r.ok).toBe(true);
    expect(driveDbRegistrationMessages(r)[0]).toContain("OK");
    expect(driveDbRegistrationMessages(r)[0]).toContain("legacy_hook_orphans=99");
  });

  it("U-DDBREG-002: fails when current drive execution projection is missing or orphaned", () => {
    const r = analyzeDriveDbRegistration({
      ...compliant,
      plansWithoutDriveRun: 1,
      workflowOrphans: 1,
      modelOrphans: 1,
      skillRecommendationOrphans: 1,
      skillInvocationOrphans: 1,
      registeredHookEvents: 0,
      modes: ["Forward"],
    });

    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.reason)).toEqual(
      expect.arrayContaining([
        "plans_without_drive_run",
        "workflow_orphans",
        "model_orphans",
        "skill_recommendation_orphans",
        "skill_invocation_orphans",
        "missing_registered_hook_events",
        "missing_required_mode",
      ]),
    );
  });

  it("U-DDBREG-005: fails when persisted harness.db plan count is stale", () => {
    const r = analyzeDriveDbRegistration({
      ...compliant,
      planCount: 9,
      expectedPlanCount: 10,
    });

    expect(r.ok).toBe(false);
    expect(r.violations).toContainEqual(
      expect.objectContaining({ reason: "stale_plan_registry", count: -1 }),
    );
    expect(driveDbRegistrationMessages(r)[0]).toContain("stale_plan_registry=-1");
  });

  it("U-DDBREG-006: fails when persisted harness.db plan content fingerprint is stale", () => {
    const r = analyzeDriveDbRegistration({
      ...compliant,
      planRegistryFingerprint: "sha256:old",
      expectedPlanRegistryFingerprint: "sha256:new",
    });

    expect(r.ok).toBe(false);
    expect(r.violations).toContainEqual(
      expect.objectContaining({ reason: "stale_plan_registry_fingerprint" }),
    );
    expect(driveDbRegistrationMessages(r)[0]).toContain("stale_plan_registry_fingerprint");
  });

  it("U-DDBREG-004: only session-scoped token rows are excluded from model orphan checks (PLAN-L7-58)", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      // session telemetry row from `ut-tdd telemetry scan` — inherently plan-less, must not count.
      upsertRow(db, {
        table: "model_runs",
        primaryKey: "run_id",
        row: {
          run_id: "tok-1",
          runtime: "claude",
          model: "claude-opus-4-8",
          role: "session",
          drive: "",
          plan_id: "",
          started_at: "",
          completed_at: "",
          evidence_path: "sess.jsonl",
        },
      });
      // genuine orphan: a worker run that points at a non-existent PLAN — must still be flagged.
      upsertRow(db, {
        table: "model_runs",
        primaryKey: "run_id",
        row: {
          run_id: "orphan-1",
          runtime: "claude",
          model: "claude-opus-4-8",
          role: "worker",
          drive: "db",
          plan_id: "PLAN-DOES-NOT-EXIST",
          started_at: "",
          completed_at: "",
          evidence_path: "",
        },
      });
      // Missing/legacy role is not a session telemetry marker, so it must still be audited.
      upsertRow(db, {
        table: "model_runs",
        primaryKey: "run_id",
        row: {
          run_id: "orphan-null-role",
          runtime: "claude",
          model: "claude-opus-4-8",
          role: null,
          drive: "",
          plan_id: "PLAN-DOES-NOT-EXIST-2",
          started_at: "",
          completed_at: "",
          evidence_path: "",
        },
      });
      const stats = collectDriveDbRegistrationStats(db);
      expect(stats.modelRuns).toBe(3);
      expect(stats.modelOrphans).toBe(2); // worker + null-role, not the session row
      expect(stats.planRegistryFingerprint).toMatch(/^sha256:/);
    } finally {
      db.close();
    }
  });

  it("U-DDBREG-003: persisted fixture has complete automatic registration evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-ddbreg-current-"));
    const planId = "PLAN-TEST-ddbreg-current";
    try {
      const planDir = join(root, "docs", "plans");
      mkdirSync(planDir, { recursive: true });
      writeFileSync(
        join(planDir, `${planId}.md`),
        [
          "---",
          `plan_id: ${planId}`,
          "kind: impl",
          "layer: L7",
          "drive: agent",
          "status: draft",
          "route_mode: add-feature",
          "updated: 2026-07-13",
          "---",
          "",
          "## Body",
          "",
        ].join("\n"),
        "utf8",
      );
      const db = openHarnessDb(defaultHarnessDbPath(root), { repoRoot: root });
      try {
        migrate(db);
        rebuildHarnessDb({ repoRoot: root, db });
        const driveRunId = String(
          db.prepare("SELECT drive_run_id FROM drive_runs WHERE plan_id = ?").get(planId)
            ?.drive_run_id,
        );
        upsertRow(db, {
          table: "workflow_runs",
          primaryKey: "workflow_run_id",
          row: { workflow_run_id: "workflow-1", plan_id: planId, drive_run_id: driveRunId },
        });
        upsertRow(db, {
          table: "model_runs",
          primaryKey: "run_id",
          row: { run_id: "model-1", plan_id: planId, role: "worker" },
        });
        upsertRow(db, {
          table: "skill_recommendations",
          primaryKey: "skill_recommendation_id",
          row: { skill_recommendation_id: "recommendation-1", plan_id: planId },
        });
        upsertRow(db, {
          table: "skill_invocations",
          primaryKey: "skill_invocation_id",
          row: { skill_invocation_id: "invocation-1", plan_id: planId },
        });
        upsertRow(db, {
          table: "hook_events",
          primaryKey: "event_id",
          row: { event_id: "hook-1", plan_id: planId },
        });
      } finally {
        db.close();
      }

      const stats = loadDriveDbRegistrationStats(root);
      const r = analyzeDriveDbRegistration(stats);

      expect(stats).not.toBeNull();
      expect(r.ok).toBe(true);
      expect(stats?.expectedPlanCount).toBe(1);
      expect(stats?.expectedPlanCount).toBe(stats?.planCount);
      expect(stats?.expectedPlanRegistryFingerprint).toBe(stats?.planRegistryFingerprint);
      expect(stats?.driveRuns).toBe(1);
      expect(stats?.workflowRuns).toBe(1);
      expect(stats?.workflowOrphans).toBe(0);
      expect(stats?.modelOrphans).toBe(0);
      expect(stats?.skillRecommendationOrphans).toBe(0);
      expect(stats?.skillInvocationOrphans).toBe(0);
      expect(stats?.registeredHookEvents).toBe(1);
    } finally {
      removeTestTree(root);
    }
  });

  it("U-DDBREG-007: stale persisted plan registry falls back to deterministic memory rebuild", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-ddbreg-stale-"));
    try {
      const planDir = join(root, "docs", "plans");
      mkdirSync(planDir, { recursive: true });
      writeFileSync(
        join(planDir, "PLAN-TEST-ddbreg.md"),
        [
          "---",
          "plan_id: PLAN-TEST-ddbreg",
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
      const staleDb = openHarnessDb(defaultHarnessDbPath(root), { repoRoot: root });
      try {
        migrate(staleDb);
      } finally {
        staleDb.close();
      }

      const stats = loadOrBuildDriveDbRegistrationStats(root);

      expect(stats).not.toBeNull();
      expect(stats?.planCount).toBe(1);
      expect(stats?.expectedPlanCount).toBe(1);
      expect(stats?.planRegistryFingerprint).toBe(stats?.expectedPlanRegistryFingerprint);
    } finally {
      removeTestTree(root);
    }
  });
});
