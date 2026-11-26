import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stableId } from "../src/stable-id.ts";
import { type HarnessDb, openHarnessDb, upsertRow } from "../src/state-db/index.ts";
import { migrate } from "../src/state-db/migration.ts";
import { evaluateAutomationReadiness } from "../src/workflow/readiness.ts";
import { putGateRun, putRoutineGateWorkflow } from "./support/readiness-fixture.ts";
import { removeTestTree } from "./support/temp-tree.ts";

function countGateReads(
  db: HarnessDb,
  onFirstRead?: () => void,
): {
  db: HarnessDb;
  selectCount(): number;
  fieldReadCount(): number;
} {
  let selectCount = 0;
  let fieldReadCount = 0;
  const instrumented: HarnessDb = {
    path: db.path,
    driver: db.driver,
    exec: (sql) => db.exec(sql),
    userVersion: () => db.userVersion(),
    setUserVersion: (version) => db.setUserVersion(version),
    close: () => db.close(),
    prepare(sql) {
      const statement = db.prepare(sql);
      if (!/\bFROM\s+gate_runs\b/i.test(sql)) return statement;
      return {
        run: (...params) => statement.run(...params),
        get: (...params) => statement.get(...params),
        all: (...params) => {
          selectCount += 1;
          const rows = statement.all(...params).map(
            (row) =>
              new Proxy(row, {
                get(target, property, receiver) {
                  if (
                    property === "gate_run_id" ||
                    property === "gate_id" ||
                    property === "status"
                  ) {
                    fieldReadCount += 1;
                  }
                  return Reflect.get(target, property, receiver);
                },
              }),
          );
          if (selectCount === 1) onFirstRead?.();
          return rows;
        },
      };
    },
  };
  return {
    db: instrumented,
    selectCount: () => selectCount,
    fieldReadCount: () => fieldReadCount,
  };
}

function readinessState(db: HarnessDb, workflowRunIds: string[]): string[] {
  const states = new Map(
    db
      .prepare("SELECT workflow_run_id, ready_status FROM workflow_runs")
      .all()
      .map((row) => [String(row.workflow_run_id), String(row.ready_status)] as const),
  );
  return workflowRunIds.map((id) => states.get(id) ?? "missing");
}

function openIsolatedFileDbs(): {
  repoRoot: string;
  dbPath: string;
  close(): void;
  db: ReturnType<typeof openHarnessDb>;
} {
  const repoRoot = mkdtempSync(join(tmpdir(), "ut-tdd-readiness-snapshot-"));
  const dbPath = join(repoRoot, ".ut-tdd", "harness.db");
  const db = openHarnessDb(dbPath, { repoRoot });
  return {
    repoRoot,
    dbPath,
    db,
    close() {
      db.close();
      removeTestTree(repoRoot);
    },
  };
}

function writePassedGatesAtomically(
  db: HarnessDb,
  gates: Array<{ gateRunId: string; gateId: string }>,
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const gate of gates) {
      putGateRun(db, {
        ...gate,
        planId: "PLAN-L7-48-readiness-guardrail",
        status: "passed",
      });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

describe("automation readiness gate snapshot", () => {
  it("U-READSNAP-001 reads and indexes gate evidence in linear work", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      const workflowRunIds: string[] = [];
      const workflowCount = 100;
      const gateCount = 250;
      const compatibleEvidence = [
        { gateId: "G-READSNAP.0", status: "passed" },
        { gateId: "G-WRONG-PHASE", status: "passed" },
        { gateId: "G-READSNAP.2", status: "failed" },
        { gateId: "G-READSNAP.3", status: "historical" },
      ] as const;
      for (let index = 0; index < workflowCount; index += 1) {
        const gateRunId = `unmatched-required-gate-${index}`;
        const workflowRunId = stableId("gate-workflow", gateRunId);
        workflowRunIds.push(workflowRunId);
        putRoutineGateWorkflow(db, {
          workflowRunId,
          planId: `plan-${index}`,
          gateId: `G-READSNAP.${index}`,
        });
      }
      for (let index = 0; index < gateCount; index += 1) {
        putGateRun(db, {
          gateRunId: `unrelated-passed-gate-${index}`,
          gateId: `G-READSNAP.${index}`,
          planId: `unrelated-plan-${index}`,
          status: "passed",
        });
      }
      compatibleEvidence.forEach((gate, index) => {
        putGateRun(db, {
          ...gate,
          gateRunId: `unmatched-required-gate-${index}`,
          planId: `plan-${index}`,
        });
      });

      const reads = countGateReads(db);
      const result = evaluateAutomationReadiness(reads.db);
      const persisted = readinessState(db, workflowRunIds);
      const expected = workflowRunIds.map((_, index) => (index === 0 ? "ready" : "blocked"));
      const returned = new Map(result.map((row) => [row.workflow_run_id, row.ready_status]));
      expect(returned.size).toBe(workflowCount);
      expect(workflowRunIds.map((id) => returned.get(id))).toEqual(expected);
      expect(persisted).toEqual(expected);
      expect(reads.selectCount()).toBe(1);
      expect(reads.fieldReadCount()).toBeGreaterThan(0);
      expect(reads.fieldReadCount()).toBeLessThanOrEqual(
        8 * (workflowCount + gateCount + compatibleEvidence.length),
      );
    } finally {
      db.close();
    }
  });

  it("SQLite second-connection readiness fixture permits an atomic write when unlocked", () => {
    const fixture = openIsolatedFileDbs();
    let writer: ReturnType<typeof openHarnessDb> | undefined;
    try {
      migrate(fixture.db);
      writer = openHarnessDb(fixture.dbPath, { repoRoot: fixture.repoRoot });
      writer.exec("PRAGMA busy_timeout = 0");
      writePassedGatesAtomically(writer, [{ gateRunId: "fixture-control", gateId: "G-CONTROL" }]);
      expect(
        writer
          .prepare("SELECT COUNT(*) AS count FROM gate_runs WHERE gate_run_id = ?")
          .get("fixture-control")?.count,
      ).toBe(1);
      writer.prepare("DELETE FROM gate_runs WHERE gate_run_id = ?").run("fixture-control");
      expect(
        writer
          .prepare("SELECT COUNT(*) AS count FROM gate_runs WHERE gate_run_id = ?")
          .get("fixture-control")?.count,
      ).toBe(0);
    } finally {
      writer?.close();
      fixture.close();
    }
  });

  it("U-READSNAP-002 keeps a mid-evaluation gate commit for the next call", () => {
    const fixture = openIsolatedFileDbs();
    let writer: ReturnType<typeof openHarnessDb> | undefined;
    try {
      migrate(fixture.db);
      const gates = [
        { gateRunId: "gate-run-concurrent-1", gateId: "G-CONCURRENT.1" },
        { gateRunId: "gate-run-concurrent-2", gateId: "G-CONCURRENT.2" },
      ];
      const workflowRunIds = gates.map((gate) => stableId("gate-workflow", gate.gateRunId));
      for (const gate of gates) {
        putRoutineGateWorkflow(fixture.db, {
          workflowRunId: stableId("gate-workflow", gate.gateRunId),
          planId: "PLAN-L7-48-readiness-guardrail",
          gateId: gate.gateId,
        });
      }
      writer = openHarnessDb(fixture.dbPath, { repoRoot: fixture.repoRoot });
      writer.exec("PRAGMA busy_timeout = 0");

      const secondConnection = writer;
      const write = { outcome: "not-attempted" as "not-attempted" | "committed" | "locked" };
      const reads = countGateReads(fixture.db, () => {
        try {
          writePassedGatesAtomically(secondConnection, gates);
          write.outcome = "committed";
        } catch (error) {
          const sqliteError = error as { code?: unknown; errcode?: unknown };
          if (sqliteError.code !== "SQLITE_BUSY" && sqliteError.errcode !== 5) throw error;
          write.outcome = "locked";
        }
      });

      const firstResult = evaluateAutomationReadiness(reads.db);
      const firstPersisted = readinessState(fixture.db, workflowRunIds);
      if (write.outcome === "locked") writePassedGatesAtomically(secondConnection, gates);
      const retryResult = evaluateAutomationReadiness(fixture.db);

      expect(write.outcome).toBe("locked");
      expect(firstResult.map((row) => row.ready_status)).toEqual(["blocked", "blocked"]);
      expect(firstPersisted).toEqual(["blocked", "blocked"]);
      expect(retryResult.map((row) => row.ready_status)).toEqual(["ready", "ready"]);
      expect(readinessState(fixture.db, workflowRunIds)).toEqual(["ready", "ready"]);
    } finally {
      writer?.close();
      fixture.close();
    }
  });

  it("SQLite trigger fixture rejects the targeted readiness update", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      const rejectedId = "fixture-control-rejected";
      putRoutineGateWorkflow(db, { workflowRunId: rejectedId, planId: "", gateId: "G-CONTROL" });
      db.exec(`CREATE TRIGGER fixture_reject_readiness BEFORE UPDATE OF ready_status ON workflow_runs
        WHEN OLD.workflow_run_id = '${rejectedId}'
        BEGIN SELECT RAISE(ABORT, 'fixture readiness rejection'); END`);
      let rejected = false;
      try {
        db.prepare("UPDATE workflow_runs SET ready_status = 'ready' WHERE workflow_run_id = ?").run(
          rejectedId,
        );
      } catch {
        rejected = true;
      }
      db.exec("DROP TRIGGER fixture_reject_readiness");
      db.prepare("UPDATE workflow_runs SET ready_status = 'ready' WHERE workflow_run_id = ?").run(
        rejectedId,
      );
      expect(rejected && readinessState(db, [rejectedId])[0] === "ready").toBe(true);
    } finally {
      db.close();
    }
  });

  it("U-READSNAP-003 rolls back all readiness writes after a later write fails", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      const gates = [
        { gateRunId: "gate-run-atomic-a", gateId: "G-ATOMIC" },
        { gateRunId: "gate-run-atomic-b", gateId: "G-ATOMIC" },
      ];
      const ordered = gates
        .map((gate) => ({ ...gate, workflowRunId: stableId("gate-workflow", gate.gateRunId) }))
        .sort((left, right) =>
          left.workflowRunId < right.workflowRunId
            ? -1
            : left.workflowRunId > right.workflowRunId
              ? 1
              : 0,
        );
      const workflowRunIds = ordered.map((item) => item.workflowRunId);
      ordered.forEach((item) => {
        putRoutineGateWorkflow(db, {
          workflowRunId: item.workflowRunId,
          planId: "PLAN-L7-48-readiness-guardrail",
          gateId: item.gateId,
        });
        putGateRun(db, {
          gateRunId: item.gateRunId,
          gateId: item.gateId,
          planId: "PLAN-L7-48-readiness-guardrail",
          status: "passed",
        });
      });
      const [, secondWorkflowId] = workflowRunIds;
      if (!secondWorkflowId) throw new Error("missing second workflow fixture");
      db.exec(`CREATE TRIGGER reject_second_readiness BEFORE UPDATE OF ready_status ON workflow_runs
        WHEN OLD.workflow_run_id = '${secondWorkflowId}' AND NEW.ready_status = 'ready'
        BEGIN SELECT RAISE(ABORT, 'reject second readiness update'); END`);

      expect(() => evaluateAutomationReadiness(db)).toThrow("reject second readiness update");
      const stateAfterFailure = readinessState(db, workflowRunIds);
      db.exec("DROP TRIGGER reject_second_readiness");
      const retryResult = evaluateAutomationReadiness(db);
      const stateAfterRetry = readinessState(db, workflowRunIds);

      expect(stateAfterFailure).toEqual(["pending", "pending"]);
      expect(retryResult.map((row) => row.ready_status)).toEqual(["ready", "ready"]);
      expect(stateAfterRetry).toEqual(["ready", "ready"]);
    } finally {
      db.close();
    }
  });

  it("U-READSNAP-004 skips gate reads for non-routine workflows", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      const workflowRunId = "workflow-non-routine-readiness";
      upsertRow(db, {
        table: "workflow_runs",
        primaryKey: "workflow_run_id",
        row: {
          workflow_run_id: workflowRunId,
          plan_id: "PLAN-L7-48-readiness-guardrail",
          drive_run_id: "",
          workflow: "Forward",
          phase: "L7",
          ready_status: "pending",
          blocked_reason: "",
          human_required: 0,
          checked_at: "2026-10-27T00:00:00.000Z",
        },
      });
      const reads = countGateReads(db);
      const result = evaluateAutomationReadiness(reads.db);
      const persisted = db
        .prepare(
          "SELECT ready_status, blocked_reason, human_required FROM workflow_runs WHERE workflow_run_id = ?",
        )
        .get(workflowRunId);

      expect(
        reads.selectCount() === 0 &&
          result.length === 1 &&
          result[0]?.ready_status === "blocked" &&
          result[0]?.blocked_reason.includes("missing evidence") === true &&
          persisted?.ready_status === "blocked" &&
          String(persisted.blocked_reason).includes("missing evidence") &&
          persisted.human_required === 0,
      ).toBe(true);
    } finally {
      db.close();
    }
  });
});
