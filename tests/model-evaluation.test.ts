/**
 * U-FR-L1-38: model evaluation projection (FR-L1-38 / PLAN-L7-53-learning-engine)
 *
 * Oracle: projectModelEvaluations は model ごとに run_count と token / cost 総量を投影する。
 * PLAN 由来の success_count / success_rate / tokens_per_success / cost_per_success は NULL のまま (S7 #1379)。
 * Opt-in: runs only when .ut-tdd/config/model-opt-in.yaml exists with enabled:true.
 * Default (no file) = disabled => 0 rows.
 *
 * AC-38-01 (enabled): model-A (2 runs) / model-B (2 runs) => run_count 2、PLAN 由来値は NULL。
 * AC-38-02 (disabled): no opt-in file => 0 model_evaluations rows.
 * Cold-start: enabled but 0 model_runs => 0 rows, no throw.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openHarnessDb, upsertRow } from "../src/state-db/index.ts";
import { migrate, rowCounts } from "../src/state-db/migration.ts";
import { projectModelEvaluations } from "../src/state-db/projection-writer.ts";
import { removeTestTree } from "./support/temp-tree.ts";

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

describe("U-FR-L1-38: projectModelEvaluations", () => {
  it("AC-38-02 disabled: no opt-in file => 0 model_evaluations rows (default disabled)", () => {
    // U-FR-L1-38 AC-38-02 oracle: no config file = 0 rows
    const root = makeTmpRoot();
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      // Seed some model_runs so we confirm opt-in gate is the blocker
      seedModelRun(db, { runId: "run-01", model: "claude-sonnet", planId: "PLAN-IMPL-01" });

      // No opt-in file written — must write 0 rows
      projectModelEvaluations(db, root);
      expect(rowCounts(db).model_evaluations).toBe(0);
    } finally {
      db.close();
      removeTestTree(root);
    }
  });

  it("AC-38-02 disabled: opt-in file present but enabled:false => 0 rows", () => {
    // U-FR-L1-38 AC-38-02: enabled:false is also disabled
    const root = makeTmpRoot();
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      writeOptIn(root, false);

      seedModelRun(db, { runId: "run-02", model: "claude-haiku", planId: "PLAN-IMPL-02" });

      projectModelEvaluations(db, root);
      expect(rowCounts(db).model_evaluations).toBe(0);
    } finally {
      db.close();
      removeTestTree(root);
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
      removeTestTree(root);
    }
  });

  it("AC-38-01: per-model run_count is projected and PLAN-derived values stay NULL", () => {
    // U-FR-L1-38 AC-38-01 oracle: enabled, two models in the same DB
    const root = makeTmpRoot();
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      writeOptIn(root, true);

      seedModelRun(db, { runId: "run-a-01", model: "model-A", planId: "" });
      seedModelRun(db, { runId: "run-a-02", model: "model-A", planId: "" });
      seedModelRun(db, { runId: "run-b-01", model: "model-B", planId: "" });
      seedModelRun(db, { runId: "run-b-02", model: "model-B", planId: "" });

      projectModelEvaluations(db, root);

      expect(rowCounts(db).model_evaluations).toBe(2);
      for (const model of ["model-A", "model-B"]) {
        const row = db.prepare("SELECT * FROM model_evaluations WHERE model = ?").get(model) as
          | Record<string, unknown>
          | undefined;
        expect(Number(row?.run_count)).toBe(2);
        expect(row?.success_count).toBeNull();
        expect(row?.success_rate).toBeNull();
        expect(row?.tokens_per_success).toBeNull();
        expect(row?.cost_per_success).toBeNull();
      }
    } finally {
      db.close();
      removeTestTree(root);
    }
  });

  it("evaluated_at is written to every row", () => {
    // U-FR-L1-38: evaluated_at column is populated
    const root = makeTmpRoot();
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      writeOptIn(root, true);

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
      removeTestTree(root);
    }
  });
});
