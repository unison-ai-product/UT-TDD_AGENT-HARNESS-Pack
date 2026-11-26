import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadGateRunCoverageStats } from "../src/doctor/gate-run-coverage-reconciliation.ts";
import { stableId } from "../src/stable-id.ts";
import * as stateDb from "../src/state-db/index.ts";
import { defaultHarnessDbPath, openHarnessDb } from "../src/state-db/index.ts";
import { migrate } from "../src/state-db/migration.ts";
import * as projectionWriter from "../src/state-db/projection-writer.ts";
import { SqliteProjectionStore } from "../src/state-db/sqlite-projection-store.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const EVIDENCE_PATH = ".ut-tdd/gate_runs/gate-run.json";
const CHECKED_AT = "2026-11-26T00:00:00.000Z";
const SYNTHETIC_REJECTED_VALUE = `ghp_${"0".repeat(20)}`;

const GATE_RUN_ID = "gate-run:gprv-fixture";
const WORKFLOW_RUN_ID = stableId("gate-workflow", GATE_RUN_ID);

type WriteKind =
  | "workflow_runs:DELETE"
  | "gate_runs:DELETE"
  | "gate_runs:INSERT"
  | "workflow_runs:INSERT";

function newRepo(label: string): string {
  return mkdtempSync(join(tmpdir(), `ut-tdd-gprv-${label}-`));
}

function writeEvidence(repoRoot: string, gateId = "G4"): void {
  const path = join(repoRoot, ...EVIDENCE_PATH.split("/"));
  mkdirSync(join(repoRoot, ".ut-tdd", "gate_runs"), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({
      schema_version: 1,
      gate_run_id: GATE_RUN_ID,
      gate_id: gateId,
      plan_id: null,
      status: "passed",
      checked_at: CHECKED_AT,
      session_id: "session-gprv-fixture",
      mode: "hybrid",
      tier: "cross_agent",
      review_kind: "cross_agent",
      static_applicable: true,
      source: "ut-tdd gate",
      messages: [],
    })}\n`,
    "utf8",
  );
}

function seedStaleProjection(repoRoot: string, conflictingWorkflow = false): void {
  const db = openHarnessDb(defaultHarnessDbPath(repoRoot), { repoRoot });
  try {
    migrate(db);
    const gateRunId = "gate-run:gprv-stale";
    db.prepare(
      "INSERT INTO gate_runs (gate_run_id, gate_id, plan_id, status, checked_at, evidence_path) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(gateRunId, "G3", null, "passed", CHECKED_AT, ".ut-tdd/gate_runs/stale.json");
    db.prepare(
      "INSERT INTO workflow_runs (workflow_run_id, plan_id, drive_run_id, workflow, phase, ready_status, blocked_reason, human_required, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      conflictingWorkflow ? WORKFLOW_RUN_ID : stableId("gate-workflow", gateRunId),
      null,
      "",
      conflictingWorkflow ? "other-workflow" : "routine-gate",
      "G3",
      "passed",
      "",
      0,
      CHECKED_AT,
    );
  } finally {
    db.close();
  }
}

function projectionRows(repoRoot: string): {
  gateRuns: Record<string, unknown>[];
  workflowRuns: Record<string, unknown>[];
} {
  const db = openHarnessDb(defaultHarnessDbPath(repoRoot), { repoRoot });
  try {
    return {
      gateRuns: db.prepare("SELECT * FROM gate_runs ORDER BY gate_run_id").all(),
      workflowRuns: db.prepare("SELECT * FROM workflow_runs ORDER BY workflow_run_id").all(),
    };
  } finally {
    db.close();
  }
}

function observeProjectionWrites(): {
  attempts: WriteKind[];
  writes: WriteKind[];
  restore: () => void;
} {
  const attempts: WriteKind[] = [];
  const writes: WriteKind[] = [];
  const open = stateDb.openHarnessDb;
  const spy = vi.spyOn(stateDb, "openHarnessDb").mockImplementation((path, options) => {
    const db = open(path, options);
    return {
      ...db,
      prepare(sql) {
        const statement = db.prepare(sql);
        const operation = /^\s*(DELETE\s+FROM|INSERT\s+INTO)\s+(gate_runs|workflow_runs)\b/i.exec(
          sql,
        );
        if (!operation) return statement;
        const kind = [operation[2], operation[1]?.split(/\s+/)[0]].join(":") as WriteKind;
        return {
          ...statement,
          run(...values) {
            attempts.push(kind);
            statement.run(...values);
            writes.push(kind);
          },
        };
      },
    };
  });
  return { attempts, writes, restore: () => spy.mockRestore() };
}

function captureError(action: () => unknown): Error | undefined {
  try {
    action();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error;
  }
  return undefined;
}

const ALL_WRITES: WriteKind[] = [
  "workflow_runs:DELETE",
  "gate_runs:DELETE",
  "gate_runs:INSERT",
  "workflow_runs:INSERT",
];

describe.each([
  { table: "gate_runs", field: "gate_id", priorWriteCount: 2 },
  { table: "workflow_runs", field: "checked_at", priorWriteCount: 3 },
])("CANDIDATE-U-GPRV-001 rejects $table before INSERT", ({ table, field, priorWriteCount }) => {
  let root: string;
  let before: ReturnType<typeof projectionRows>;
  let after: ReturnType<typeof projectionRows>;
  let error: Error | undefined;
  let observer: ReturnType<typeof observeProjectionWrites>;

  beforeAll(() => {
    root = newRepo(table);
    writeEvidence(root, table === "gate_runs" ? SYNTHETIC_REJECTED_VALUE : "G4");
    seedStaleProjection(root);
    before = projectionRows(root);

    const collect = projectionWriter.collectGateRunEvidenceProjection;
    const collectSpy =
      table === "workflow_runs"
        ? vi
            .spyOn(projectionWriter, "collectGateRunEvidenceProjection")
            .mockImplementation((path) => {
              const projection = collect(path);
              const [workflow] = projection.workflowRuns;
              if (projection.workflowRuns.length !== 1 || !workflow) {
                throw new Error("fixture requires one workflow projection row");
              }
              workflow.checked_at = SYNTHETIC_REJECTED_VALUE;
              return projection;
            })
        : undefined;
    observer = observeProjectionWrites();
    try {
      error = captureError(() => loadGateRunCoverageStats(root));
    } finally {
      observer.restore();
      collectSpy?.mockRestore();
    }
    after = projectionRows(root);
  });

  afterAll(() => {
    if (root) removeTestTree(root);
  });

  it("runs the seeded reconciliation and isolates the known Red from fixture errors", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      const validatorError = captureError(() =>
        new SqliteProjectionStore(db).record({
          table,
          id: "validator-fixture",
          row: { [field]: SYNTHETIC_REJECTED_VALUE },
        }),
      );
      expect(validatorError?.message).toBe(
        ["secret-like value is not allowed in harness.db projection column", field].join(": "),
      );
      expect(before.gateRuns).toHaveLength(1);
      expect(before.workflowRuns).toHaveLength(1);

      if (error) {
        expect(error.message.includes(SYNTHETIC_REJECTED_VALUE)).toBe(false);
        expect(error.message).toBe(validatorError?.message);
        expect(observer.attempts).toEqual(ALL_WRITES.slice(0, priorWriteCount));
        expect(observer.writes).toEqual(ALL_WRITES.slice(0, priorWriteCount));
        expect(isDeepStrictEqual(after, before)).toBe(true);
      } else {
        expect(observer.attempts).toEqual(ALL_WRITES);
        expect(observer.writes).toEqual(ALL_WRITES);
        const rows = table === "gate_runs" ? after.gateRuns : after.workflowRuns;
        expect(rows[0]?.[field] === SYNTHETIC_REJECTED_VALUE).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  // Green changes this to a normal assertion and removes the known-Red branch above.
  it.fails("rejects the row through the public coverage entry point", () => {
    expect(error !== undefined).toBe(true);
  });
});

describe("CANDIDATE-U-GPRV-002 preserves normal rows and SQLite duplicate rejection", () => {
  it("stores all expected columns, including the repo-relative evidence path", () => {
    const root = newRepo("normal");
    try {
      writeEvidence(root);
      seedStaleProjection(root);
      loadGateRunCoverageStats(root);
      expect(projectionRows(root)).toEqual({
        gateRuns: [
          {
            gate_run_id: GATE_RUN_ID,
            gate_id: "G4",
            plan_id: null,
            status: "passed",
            checked_at: CHECKED_AT,
            evidence_path: EVIDENCE_PATH,
          },
        ],
        workflowRuns: [
          {
            workflow_run_id: WORKFLOW_RUN_ID,
            plan_id: null,
            drive_run_id: "",
            workflow: "routine-gate",
            phase: "G4",
            ready_status: "passed",
            blocked_reason: "",
            human_required: 0,
            checked_at: CHECKED_AT,
          },
        ],
      });
    } finally {
      removeTestTree(root);
    }
  });

  it("rolls back when the workflow INSERT conflicts with an existing primary key", () => {
    const root = newRepo("duplicate");
    try {
      writeEvidence(root);
      seedStaleProjection(root, true);
      const before = projectionRows(root);
      const observer = observeProjectionWrites();
      let error: Error | undefined;
      try {
        error = captureError(() => loadGateRunCoverageStats(root));
      } finally {
        observer.restore();
      }

      expect(error?.message).toMatch(/UNIQUE constraint failed: workflow_runs\.workflow_run_id/);
      expect(observer.attempts).toEqual(ALL_WRITES.slice(1));
      expect(observer.writes).toEqual(ALL_WRITES.slice(1, 3));
      expect(projectionRows(root)).toEqual(before);
    } finally {
      removeTestTree(root);
    }
  });
});
