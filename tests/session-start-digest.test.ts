import { afterEach, describe, expect, it } from "vitest";
import {
  renderSessionStartDigest,
  selectSessionStartDigest,
} from "../src/handover/session-start-digest.ts";
import { type HarnessDb, openHarnessDb, upsertRow } from "../src/state-db/index.ts";
import { migrate } from "../src/state-db/migration.ts";

const opened: HarnessDb[] = [];

function db(): HarnessDb {
  const value = openHarnessDb(":memory:");
  migrate(value);
  opened.push(value);
  return value;
}

function put(
  database: HarnessDb,
  table: string,
  primaryKey: string,
  row: Record<string, unknown>,
): void {
  upsertRow(database, { table, primaryKey, row });
}

afterEach(() => {
  for (const database of opened.splice(0)) database.close();
});

describe("SessionStart digest", () => {
  it("U-SCHEDULE-LIVE-004: renders the generic digest sections", () => {
    const database = db();
    put(database, "gate_runs", "gate_run_id", {
      gate_run_id: "gate:old",
      gate_id: "G-VERIFY.L8",
      plan_id: null,
      status: "failed",
      checked_at: "2026-07-10T00:00:00Z",
    });
    put(database, "gate_runs", "gate_run_id", {
      gate_run_id: "gate:new",
      gate_id: "G-VERIFY.L8",
      plan_id: null,
      status: "passed",
      checked_at: "2026-07-10T00:00:00Z",
    });
    put(database, "gate_runs", "gate_run_id", {
      gate_run_id: "gate:l9",
      gate_id: "G-VERIFY.L9",
      plan_id: null,
      status: "passed",
      checked_at: "2026-07-10T00:00:00Z",
    });
    for (let index = 1; index <= 7; index += 1) {
      put(database, "feedback_events", "feedback_event_id", {
        feedback_event_id: `feedback:${index}`,
        signal_type: `action-${index}`,
        severity: "warn",
        status: "open",
        next_action: `review action ${index}`,
        created_at: `2026-07-10T00:00:0${index}Z`,
      });
    }
    put(database, "feedback_events", "feedback_event_id", {
      feedback_event_id: "feedback:telemetry",
      signal_type: "skill_firing_rate",
      severity: "info",
      status: "open",
      next_action: "observe only",
      created_at: "2026-07-10T00:01:00Z",
    });
    // PLAN-L7-468: memory の本文は DB ではなく正本ファイル側 (MemoryService) から渡る。
    // digest は受け取った entries をそのまま描画する契約なので、ここでは呼び元として供給する。
    const memoryFromService = [
      {
        memory_id: "memory:project:vmodel",
        kind: "project" as const,
        title: "V-model engine swap",
        body: "設計を正本として検出系を追従させる。",
        tags: ["engine-swap"],
        source_path: ".ut-tdd/memory/project-vmodel.md",
        updated_at: "2026-07-10T00:00:00Z",
        content_hash: "abc",
      },
    ];

    const transactionEvents: string[] = [];
    let gateReads = 0;
    const snapshotDb: HarnessDb = {
      path: database.path,
      driver: database.driver,
      exec(sql) {
        transactionEvents.push(sql);
        database.exec(sql);
      },
      prepare(sql) {
        if (sql.includes("FROM gate_runs")) gateReads += 1;
        return database.prepare(sql);
      },
      userVersion: () => database.userVersion(),
      setUserVersion: (version) => database.setUserVersion(version),
      close: () => database.close(),
    };
    const digest = selectSessionStartDigest(snapshotDb, ["abc123 feat: session digest"], {
      escalationLines: ["attempt-escalation warning", "subject: 3 consecutive failures"],
      memory: memoryFromService,
    });
    const rendered = renderSessionStartDigest(digest);

    expect(rendered.match(/^\[[1-4]\/4 /gm)).toHaveLength(4);
    expect(rendered).toContain("gate: G-VERIFY.L8=passed");
    expect(rendered).toContain("gate: G-VERIFY.L9=passed");
    expect(rendered).toContain("escalation: attempt-escalation warning");
    expect(rendered).not.toContain("gate: G-VERIFY.L8=failed");
    expect(rendered).toContain("abc123 feat: session digest");
    expect(rendered.match(/review action/g)).toHaveLength(5);
    expect(rendered).toContain("(+2 more actionable");
    expect(rendered).toContain("telemetry summarized: skill_firing_rate=1");
    expect(rendered).not.toContain("observe only");
    expect(rendered).toContain("V-model engine swap");
    expect(transactionEvents).toEqual(["BEGIN", "COMMIT"]);
    expect(gateReads).toBe(1);
  });

  it("U-SCHEDULE-LIVE-005: renders unclaimed inbox backlog in session-start digest", () => {
    const database = db();
    const digest = selectSessionStartDigest(database, ["abc123 feat: backlog visibility"], {
      memory: [],
      unclaimedInbox: {
        workspaceId: "workspace-1",
        pending: 2,
        oldestEntryId: "memory:backlog-1",
        oldestCreatedAt: "2026-08-01T00:00:00Z",
        oldestAgeMs: 1234,
      },
    });
    const rendered = renderSessionStartDigest(digest);

    expect(rendered).toContain(
      "inbox: pending=2 oldest=memory:backlog-1 at=2026-08-01T00:00:00Z age_ms=1234",
    );
  });
});
