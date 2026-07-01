/**
 * U-FR-L1-38: model evaluation projection (FR-L1-38 / PLAN-L7-53-learning-engine)
 *
 * Oracle: projectModelEvaluations computes per-model success_rate by joining
 * model_runs.plan_id -> plan_registry.status IN PLAN_SUCCESS_STATUSES.
 * Opt-in: runs only when .ut-tdd/config/model-opt-in.yaml exists with enabled:true.
 * Default (no file) = disabled => 0 rows.
 *
 * AC-38-01 (enabled): model-A (2 runs both success) => rate 1.0;
 *                     model-B (2 runs, 1 success) => rate 0.5.
 * AC-38-02 (disabled): no opt-in file => 0 model_evaluations rows.
 * Cold-start: enabled but 0 model_runs => 0 rows, no throw.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openHarnessDb, upsertRow } from "../src/state-db/index";
import { migrate, rowCounts } from "../src/state-db/migration";
import { projectModelEvaluations } from "../src/state-db/projection-writer";

function makeTmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-model-eval-"));
  mkdirSync(join(root, ".ut-tdd", "config"), { recursive: true });
  return root;
}

function writeOptIn(root: string, enabled: boolean): void {
  writeFileSync(join(root, ".ut-tdd", "config", "model-opt-in.yaml"), `enabled: ${enabled}\n`);
}

function seedModelRun(
  db: ReturnType<typeof openHarnessDb>,
  opts: { runId: string; model: string; planId: string },
): void {
  upsertRow(db, {
    table: "model_runs",
    primaryKey: "run_id",
    row: {
      run_id: opts.runId,
      runtime: "claude",
      model: opts.model,
      role: "worker",
      drive: "db",
      plan_id: opts.planId,
      started_at: "2026-06-15T00:00:00.000Z",
      completed_at: "2026-06-15T01:00:00.000Z",
      evidence_path: "",
    },
  });
}

function seedPlan(db: ReturnType<typeof openHarnessDb>, planId: string, status: string): void {
  upsertRow(db, {
    table: "plan_registry",
    primaryKey: "plan_id",
    row: {
      plan_id: planId,
      kind: "impl",
      layer: "L7",
      drive: "db",
      status,
      updated_at: "",
      decision_outcome: "",
    },
  });
}

describe("U-FR-L1-38: projectModelEvaluations", () => {
  it("AC-38-02 disabled: no opt-in file => 0 model_evaluations rows (default disabled)", () => {
    // U-FR-L1-38 AC-38-02 oracle: no config file = 0 rows
    const root = makeTmpRoot();
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      // Seed some model_runs so we confirm opt-in gate is the blocker
      seedPlan(db, "PLAN-IMPL-01", "confirmed");
      seedModelRun(db, { runId: "run-01", model: "claude-sonnet", planId: "PLAN-IMPL-01" });

      // No opt-in file written — must write 0 rows
      projectModelEvaluations(db, root);
      expect(rowCounts(db).model_evaluations).toBe(0);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("AC-38-02 disabled: opt-in file present but enabled:false => 0 rows", () => {
    // U-FR-L1-38 AC-38-02: enabled:false is also disabled
    const root = makeTmpRoot();
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      writeOptIn(root, false);

      seedPlan(db, "PLAN-IMPL-02", "confirmed");
      seedModelRun(db, { runId: "run-02", model: "claude-haiku", planId: "PLAN-IMPL-02" });

      projectModelEvaluations(db, root);
      expect(rowCounts(db).model_evaluations).toBe(0);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cold-start: enabled but 0 model_runs => 0 rows, no throw", () => {
    // U-FR-L1-38 cold-start oracle
    const root = makeTmpRoot();
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      writeOptIn(root, true);

      // No model_runs seeded
      projectModelEvaluations(db, root);
      expect(rowCounts(db).model_evaluations).toBe(0);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("AC-38-01: model-A (2 runs both success) => rate 1.0, run_count 2, success_count 2", () => {
    // U-FR-L1-38 AC-38-01 oracle: enabled, model-A success_rate=1.0
    const root = makeTmpRoot();
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      writeOptIn(root, true);

      seedPlan(db, "PLAN-A-01", "confirmed");
      seedPlan(db, "PLAN-A-02", "completed");
      seedModelRun(db, { runId: "run-a-01", model: "model-A", planId: "PLAN-A-01" });
      seedModelRun(db, { runId: "run-a-02", model: "model-A", planId: "PLAN-A-02" });

      projectModelEvaluations(db, root);

      const row = db.prepare("SELECT * FROM model_evaluations WHERE model = ?").get("model-A") as
        | Record<string, unknown>
        | undefined;

      expect(row).toBeDefined();
      expect(Number(row?.run_count)).toBe(2);
      expect(Number(row?.success_count)).toBe(2);
      expect(Number(row?.success_rate)).toBeCloseTo(1.0, 4);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("AC-38-01: model-B (2 runs, 1 success) => rate 0.5, run_count 2, success_count 1", () => {
    // U-FR-L1-38 AC-38-01 oracle: enabled, model-B success_rate=0.5
    const root = makeTmpRoot();
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      writeOptIn(root, true);

      seedPlan(db, "PLAN-B-01", "confirmed");
      seedPlan(db, "PLAN-B-02", "draft"); // not a success status
      seedModelRun(db, { runId: "run-b-01", model: "model-B", planId: "PLAN-B-01" });
      seedModelRun(db, { runId: "run-b-02", model: "model-B", planId: "PLAN-B-02" });

      projectModelEvaluations(db, root);

      const row = db.prepare("SELECT * FROM model_evaluations WHERE model = ?").get("model-B") as
        | Record<string, unknown>
        | undefined;

      expect(row).toBeDefined();
      expect(Number(row?.run_count)).toBe(2);
      expect(Number(row?.success_count)).toBe(1);
      expect(Number(row?.success_rate)).toBeCloseTo(0.5, 4);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("AC-38-01 combined: model-A rate 1.0 and model-B rate 0.5 in same run", () => {
    // U-FR-L1-38 AC-38-01 oracle: both models in same DB
    const root = makeTmpRoot();
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      writeOptIn(root, true);

      seedPlan(db, "PLAN-A-01", "confirmed");
      seedPlan(db, "PLAN-A-02", "completed");
      seedPlan(db, "PLAN-B-01", "confirmed");
      seedPlan(db, "PLAN-B-02", "draft");

      seedModelRun(db, { runId: "run-a-01", model: "model-A", planId: "PLAN-A-01" });
      seedModelRun(db, { runId: "run-a-02", model: "model-A", planId: "PLAN-A-02" });
      seedModelRun(db, { runId: "run-b-01", model: "model-B", planId: "PLAN-B-01" });
      seedModelRun(db, { runId: "run-b-02", model: "model-B", planId: "PLAN-B-02" });

      projectModelEvaluations(db, root);

      expect(rowCounts(db).model_evaluations).toBe(2);

      const rowA = db.prepare("SELECT * FROM model_evaluations WHERE model = ?").get("model-A") as
        | Record<string, unknown>
        | undefined;
      const rowB = db.prepare("SELECT * FROM model_evaluations WHERE model = ?").get("model-B") as
        | Record<string, unknown>
        | undefined;

      expect(rowA).toBeDefined();
      expect(Number(rowA?.success_rate)).toBeCloseTo(1.0, 4);

      expect(rowB).toBeDefined();
      expect(Number(rowB?.success_rate)).toBeCloseTo(0.5, 4);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("model with no plan_registry match counts as 0 success", () => {
    // U-FR-L1-38: model_run without a matching plan => success_count = 0
    const root = makeTmpRoot();
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      writeOptIn(root, true);

      // model_run references a plan that has no plan_registry entry
      // upsertRow won't fail on FK-less SQLite, but the JOIN returns no rows
      seedModelRun(db, { runId: "run-orphan-01", model: "orphan-model", planId: "PLAN-ORPHAN-01" });

      projectModelEvaluations(db, root);

      const row = db
        .prepare("SELECT * FROM model_evaluations WHERE model = ?")
        .get("orphan-model") as Record<string, unknown> | undefined;

      expect(row).toBeDefined();
      expect(Number(row?.run_count)).toBe(1);
      expect(Number(row?.success_count)).toBe(0);
      expect(Number(row?.success_rate)).toBeCloseTo(0.0, 4);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("evaluated_at is written to every row", () => {
    // U-FR-L1-38: evaluated_at column is populated
    const root = makeTmpRoot();
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      writeOptIn(root, true);

      seedPlan(db, "PLAN-TS-01", "confirmed");
      seedModelRun(db, { runId: "run-ts-01", model: "ts-model", planId: "PLAN-TS-01" });

      projectModelEvaluations(db, root);

      const row = db
        .prepare("SELECT evaluated_at FROM model_evaluations WHERE model = ?")
        .get("ts-model") as { evaluated_at: string } | undefined;

      expect(row).toBeDefined();
      expect(typeof row?.evaluated_at).toBe("string");
      expect(row?.evaluated_at.length).toBeGreaterThan(0);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
