import { afterEach, describe, expect, it } from "vitest";
import {
  renderSessionStartDigest,
  selectScheduleLiveState,
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

function schedule(
  database: HarnessDb,
  input: {
    id: string;
    location: string;
    rag: string;
    status: string;
    blocked?: string;
    source?: string;
    predecessors?: string;
  },
): void {
  put(database, "schedule_entries", "schedule_entry_id", {
    schedule_entry_id: `schedule:${input.id}`,
    plan_id: input.id,
    current_location: input.location,
    rag: input.rag,
    status: input.status,
    blocked_reason: input.blocked ?? "",
    source_path: input.source ?? "docs/governance/vmodel-upgrade-schedule.md",
    predecessor_plan_ids: input.predecessors ?? "",
  });
}

afterEach(() => {
  for (const database of opened.splice(0)) database.close();
});

describe("schedule live SessionStart digest", () => {
  it("U-SCHEDULE-LIVE-001/002/003: joins runtime signals without bypassing authoring order", () => {
    const database = db();
    schedule(database, {
      id: "PLAN-L7-501-live-red",
      location: "U17a: runtime signal join",
      rag: "green",
      status: "confirmed",
    });
    schedule(database, {
      id: "PLAN-L7-502-live-yellow",
      location: "U17b: digest wiring",
      rag: "yellow",
      status: "draft",
      predecessors: "PLAN-L7-501-live-red|PLAN-L7-998-resolved",
    });
    schedule(database, {
      id: "PLAN-L7-503-blocked",
      location: "U16z: blocked prerequisite",
      rag: "yellow",
      status: "draft",
      blocked: "upstream pair freeze is missing",
    });
    schedule(database, {
      id: "PLAN-L7-999-fallback",
      location: "L7:draft",
      rag: "red",
      status: "draft",
      source: "docs/plans/PLAN-L7-999-fallback.md",
    });
    put(database, "test_runs", "test_run_id", {
      test_run_id: "test:501",
      plan_id: "PLAN-L7-501-live-red",
      exit_code: 1,
      status: "failed",
      completed_at: "2026-07-10T01:00:00Z",
    });
    put(database, "test_runs", "test_run_id", {
      test_run_id: "test:502",
      plan_id: "PLAN-L7-502-live-yellow",
      exit_code: 0,
      status: "passed",
      completed_at: "2026-07-10T02:00:00Z",
    });
    put(database, "review_evidence_registry", "review_evidence_id", {
      review_evidence_id: "review:502",
      plan_id: "PLAN-L7-502-live-yellow",
      has_evidence: 1,
      verdict: "request-changes",
      status: "draft",
      reviewed_at: "2026-07-10T03:00:00Z",
    });
    put(database, "review_evidence_registry", "review_evidence_id", {
      review_evidence_id: "review:503",
      plan_id: "PLAN-L7-503-blocked",
      has_evidence: 1,
      verdict: "pass-with-fixes",
      status: "draft",
      reviewed_at: "2026-07-10T04:00:00Z",
    });
    schedule(database, {
      id: "PLAN-L7-504-predecessor-contradiction",
      location: "U17c: dependency must remain ordered",
      rag: "green",
      status: "confirmed",
      predecessors: "PLAN-L7-501-live-red",
    });
    put(database, "gate_runs", "gate_run_id", {
      gate_run_id: "gate:504",
      gate_id: "G-L7.504",
      plan_id: "PLAN-L7-504-predecessor-contradiction",
      status: "blocked",
      checked_at: "2026-07-10T05:00:00+09:00",
    });
    schedule(database, {
      id: "PLAN-L7-505-invalid-rag",
      location: "U17d: invalid authoring input",
      rag: "gren",
      status: "confirmed",
    });

    const state = selectScheduleLiveState(database);
    expect(state.entries).toHaveLength(5);
    expect(state.entries.find((entry) => entry.plan_id.endsWith("live-red"))).toMatchObject({
      authoring_rag: "green",
      effective_rag: "red",
      signal_state: "contradiction",
    });
    expect(state.entries.find((entry) => entry.plan_id.endsWith("live-yellow"))).toMatchObject({
      authoring_rag: "yellow",
      effective_rag: "red",
      signal_state: "aligned",
    });
    expect(state.current[0]?.plan_id).toBe("PLAN-L7-501-live-red");
    expect(state.current.map((entry) => entry.plan_id)).not.toContain("PLAN-L7-503-blocked");
    expect(state.next.map((entry) => entry.plan_id)).not.toContain("PLAN-L7-503-blocked");
    expect(state.current.map((entry) => entry.plan_id)).not.toContain(
      "PLAN-L7-504-predecessor-contradiction",
    );
    expect(state.next.map((entry) => entry.plan_id)).toContain("PLAN-L7-502-live-yellow");
    expect(state.blocked.map((entry) => entry.plan_id)).toEqual(["PLAN-L7-503-blocked"]);
    expect(state.entries.find((entry) => entry.plan_id.endsWith("blocked"))).toMatchObject({
      effective_rag: "yellow",
      signal_state: "aligned",
    });
    expect(
      state.entries.find((entry) => entry.plan_id.endsWith("predecessor-contradiction")),
    ).toMatchObject({
      authoring_rag: "green",
      effective_rag: "red",
      signal_state: "contradiction",
    });
    expect(state.entries.find((entry) => entry.plan_id.endsWith("invalid-rag"))).toMatchObject({
      authoring_rag: "yellow",
      effective_rag: "yellow",
    });
  });

  it("U-SCHEDULE-LIVE-003: keeps every ready lane current instead of relabeling overflow as next", () => {
    const database = db();
    for (let index = 1; index <= 6; index += 1) {
      schedule(database, {
        id: `PLAN-L7-52${index}-ready`,
        location: `U18${String.fromCharCode(96 + index)}: ready lane`,
        rag: "yellow",
        status: "draft",
      });
    }

    const state = selectScheduleLiveState(database);
    expect(state.current).toHaveLength(6);
    expect(state.next).toEqual([]);
    expect(state.blocked).toEqual([]);
  });

  it("U-SCHEDULE-LIVE-003/004: renders one snapshot as the fixed four-stage digest", () => {
    const database = db();
    schedule(database, {
      id: "PLAN-L7-510-current",
      location: "U18a: current",
      rag: "yellow",
      status: "draft",
    });
    put(database, "gate_runs", "gate_run_id", {
      gate_run_id: "gate:old",
      gate_id: "G-VERIFY.L8",
      plan_id: "PLAN-M-00-verify-cutover",
      status: "failed",
      checked_at: "2026-07-10T00:00:00Z",
    });
    put(database, "gate_runs", "gate_run_id", {
      gate_run_id: "gate:new",
      gate_id: "G-VERIFY.L8",
      plan_id: "PLAN-M-00-verify-cutover",
      status: "passed",
      checked_at: "2026-07-10T00:00:00Z",
    });
    put(database, "gate_runs", "gate_run_id", {
      gate_run_id: "gate:l9",
      gate_id: "G-VERIFY.L9",
      plan_id: "PLAN-M-00-verify-cutover",
      status: "passed",
      checked_at: "2026-07-10T00:00:00Z",
    });
    for (let index = 1; index <= 7; index += 1) {
      put(database, "feedback_events", "feedback_event_id", {
        feedback_event_id: `feedback:${index}`,
        plan_id: `PLAN-L7-5${index}`,
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
    const digest = selectSessionStartDigest(snapshotDb, ["abc123 feat: live schedule digest"], {
      escalationLines: ["attempt-escalation warning", "subject: 3 consecutive failures"],
      memory: memoryFromService,
    });
    const rendered = renderSessionStartDigest(digest);

    expect(rendered.match(/^\[[1-4]\/4 /gm)).toHaveLength(4);
    expect(rendered).toContain("gate: G-VERIFY.L8=passed");
    expect(rendered).toContain("gate: G-VERIFY.L9=passed");
    expect(rendered).toContain("escalation: attempt-escalation warning");
    expect(rendered).not.toContain("gate: G-VERIFY.L8=failed");
    expect(rendered).toContain("abc123 feat: live schedule digest");
    expect(rendered.match(/review action/g)).toHaveLength(5);
    expect(rendered).toContain("(+2 more actionable");
    expect(rendered).toContain("telemetry summarized: skill_firing_rate=1");
    expect(rendered).not.toContain("observe only");
    expect(rendered).toContain("V-model engine swap");
    expect(rendered).not.toContain("no unresolved schedule row");
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
