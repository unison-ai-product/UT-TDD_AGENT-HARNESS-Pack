import { describe, expect, it } from "vitest";
import { openHarnessDb } from "../src/state-db/index.ts";
import { migrate } from "../src/state-db/migration.ts";
import { clearRebuildableProjectionTables } from "../src/state-db/sqlite-projection-rebuild.ts";
import {
  type ProjectionFindingInput,
  SqliteProjectionStore,
} from "../src/state-db/sqlite-projection-store.ts";

describe("U-DOMAIN-004: SQLite projection adapter", () => {
  it("normalizes schema columns, preserves explicit PK, and fails closed on secrets", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      const store = new SqliteProjectionStore(db);
      expect(() => store.record({ table: "unknown", id: "x", row: {} })).toThrow(/unknown/);

      store.record({
        table: "artifact_registry",
        id: "artifact:store-1",
        row: { artifact_type: "spec", status: "draft", ignored_column: "removed" },
      });
      store.record({
        table: "artifact_registry",
        id: "event-id-is-not-used",
        row: { artifact_id: "artifact:store-2", artifact_type: "spec", status: "draft" },
      });
      expect(
        db.prepare("SELECT artifact_id FROM artifact_registry ORDER BY artifact_id").all(),
      ).toEqual([{ artifact_id: "artifact:store-1" }, { artifact_id: "artifact:store-2" }]);

      expect(() =>
        store.record({
          table: "model_runs",
          id: "secret-run",
          row: { model: `leak sk-${"a".repeat(20)}` },
        }),
      ).toThrow(/secret-like/);
      expect(
        db.prepare("SELECT run_id FROM model_runs WHERE run_id = ?").get("secret-run"),
      ).toBeUndefined();

      const secret = `sk-${"b".repeat(20)}`;
      for (const event of [
        { table: "artifact_registry", id: secret, row: { artifact_type: "spec" } },
        {
          table: "artifact_registry",
          id: "safe-event-id",
          row: { artifact_id: secret, artifact_type: "spec" },
        },
        {
          table: "model_runs",
          id: "safe-run-id",
          row: { run_id: secret, model: "safe-model" },
        },
      ]) {
        expect(() => store.record(event)).toThrow(/secret-like/);
      }
      expect(
        db.prepare("SELECT artifact_id FROM artifact_registry WHERE artifact_id = ?").get(secret),
      ).toBeUndefined();
      expect(
        db.prepare("SELECT run_id FROM model_runs WHERE run_id = ?").get(secret),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("U-DOMAIN-007: rejects secret-like data from every legacy recordFinding field without mutation", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      const store = new SqliteProjectionStore(db);
      const secret = `sk-${"a".repeat(20)}`;
      const safe = {
        kind: "projection-finding",
        severity: "warn" as const,
        subjectId: "projection:subject",
        source: "projection-test",
        evidencePath: "docs/evidence.md",
      };
      store.recordFinding(safe);
      const unsafeInputs: ProjectionFindingInput[] = [
        { ...safe, kind: secret },
        { ...safe, subjectId: secret },
        { ...safe, source: secret },
        { ...safe, evidencePath: secret },
        { ...safe, severity: secret as unknown as ProjectionFindingInput["severity"] },
      ];
      for (const input of unsafeInputs) {
        expect(() => store.recordFinding(input)).toThrow(/secret-like/);
      }
      expect(db.prepare("SELECT kind, subject_id FROM findings").all()).toEqual([
        { kind: safe.kind, subject_id: safe.subjectId },
      ]);
    } finally {
      db.close();
    }
  });

  it("clears rebuildable rows while retaining refactor debt and unregistered PLAN-era tables", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      const retiredTables = [
        "plan_registry",
        "roadmap_rollups",
        "roadmap_band_coverage",
        "roadmap_gate_progress",
      ];
      const store = new SqliteProjectionStore(db);
      for (const table of retiredTables) {
        db.exec(`CREATE TABLE ${table} (legacy_id TEXT PRIMARY KEY)`);
        db.prepare(`INSERT INTO ${table} (legacy_id) VALUES (?)`).run("legacy:keep");
        expect(() =>
          store.record({ table, id: "legacy:reject", row: { legacy_id: "legacy:reject" } }),
        ).toThrow(/unknown/);
      }
      db.prepare("INSERT INTO artifact_registry (artifact_id) VALUES (?)").run("artifact:clear");
      db.prepare("INSERT INTO refactor_candidates (candidate_key) VALUES (?)").run("debt:keep");
      clearRebuildableProjectionTables(db);
      expect(db.prepare("SELECT artifact_id FROM artifact_registry").all()).toEqual([]);
      expect(db.prepare("SELECT candidate_key FROM refactor_candidates").all()).toEqual([
        { candidate_key: "debt:keep" },
      ]);
      for (const table of retiredTables) {
        expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([{ legacy_id: "legacy:keep" }]);
      }
    } finally {
      db.close();
    }
  });

  it("groups operational facts without hiding trouble, human, or retry counts", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      const drive = db.prepare(
        "INSERT INTO drive_runs (drive_run_id, mode, status) VALUES (?, ?, ?)",
      );
      for (const [id, status] of [
        ["d1", "completed"],
        ["d2", "confirmed"],
        ["d3", "documented"],
        ["d4", "completed"],
        ["d5", "active"],
      ]) {
        drive.run(id, "forward", status);
      }
      drive.run("d6", null, "completed");
      drive.run("d7", "unknown", "active");
      db.prepare("INSERT INTO hook_events (event_id, event_type, digest) VALUES (?, ?, ?)").run(
        "h1",
        "error",
        "failed",
      );
      db.prepare("INSERT INTO hook_events (event_id, event_type, digest) VALUES (?, ?, ?)").run(
        "h2",
        "tool_use",
        "ok",
      );
      const workflow = db.prepare(
        `INSERT INTO workflow_runs
           (workflow_run_id, plan_id, workflow, phase, ready_status, human_required)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      workflow.run("w1", "PLAN-A", "forward", "implement", "ready", 0);
      workflow.run("w2", "PLAN-A", "forward", "implement", "blocked", 1);
      workflow.run("w3", "PLAN-B", "forward", "review", "passed", 1);

      expect(new SqliteProjectionStore(db).readOperationalMetricFacts()).toEqual({
        drives: [
          { mode: "forward", total: 5, completed: 4 },
          { mode: "unknown", total: 2, completed: 1 },
        ],
        hooks: { total: 2, trouble: 1 },
        workflow: { total: 3, blocked: 1, humanRequired: 2, retryGroups: 1 },
      });
    } finally {
      db.close();
    }
  });
});
