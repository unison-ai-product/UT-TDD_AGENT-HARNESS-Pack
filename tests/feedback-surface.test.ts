import { describe, expect, it } from "vitest";
import {
  classifyFeedbackBucket,
  renderFeedbackEventRows,
  renderTakeoverFeedback,
  selectTakeoverFeedback,
} from "../src/feedback/surface.ts";
import { openHarnessDb, upsertRow } from "../src/state-db/index.ts";
import { migrate } from "../src/state-db/migration.ts";

function insertFinding(
  db: ReturnType<typeof openHarnessDb>,
  id: string,
  severity: string,
  subjectId: string,
): void {
  upsertRow(db, {
    table: "findings",
    primaryKey: "finding_id",
    row: {
      finding_id: id,
      kind: "takeover-drift",
      severity,
      subject_id: subjectId,
      source: "test",
      status: "open",
      evidence_path: "",
    },
  });
}

function insertFeedbackEvent(
  db: ReturnType<typeof openHarnessDb>,
  input: {
    id: string;
    signalType: string;
    severity: string;
    status?: string;
    planId?: string;
    nextAction?: string;
    sourceTable?: string;
    sourceId?: string;
    sourceGeneration?: string;
    findingId?: string;
  },
): void {
  upsertRow(db, {
    table: "feedback_events",
    primaryKey: "feedback_event_id",
    row: {
      feedback_event_id: input.id,
      finding_id: input.findingId ?? "",
      plan_id: input.planId ?? "",
      source_table: input.sourceTable ?? "",
      source_id: input.sourceId ?? "",
      source_generation: input.sourceGeneration ?? "generation:test",
      source_color: "",
      signal_type: input.signalType,
      severity: input.severity,
      status: input.status ?? "open",
      next_action: input.nextAction ?? `review ${input.id}`,
      created_at: "2026-07-07T00:00:00.000Z",
    },
  });
}

describe("takeover feedback surface (PLAN-L7-110)", () => {
  it("surfaces open findings from harness.db as takeover feedback (DB が正本、prose でない)", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      insertFinding(db, "finding:takeover-drift:PLAN-L7-110", "warn", "PLAN-L7-110");

      const result = selectTakeoverFeedback(db);
      expect(result.total).toBeGreaterThanOrEqual(1);
      const surfaced = result.items.find((item) => item.plan_id === "PLAN-L7-110");
      expect(surfaced).toBeDefined();
      expect(surfaced?.severity).toBe("warn");
      expect(surfaced?.bucket).toBe("actionable");
      expect(result.byBucket.actionable).toBe(1);

      const block = renderTakeoverFeedback(result);
      expect(block).toContain("harness.db feedback");
      expect(block).toContain("gate=0 actionable=1 telemetry=0");
      expect(block).toContain("PLAN-L7-110");
    } finally {
      db.close();
    }
  });

  it("renders empty when there is no open feedback (引き継ぎ時にノイズを出さない)", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      const result = selectTakeoverFeedback(db);
      expect(result.total).toBe(0);
      expect(renderTakeoverFeedback(result)).toBe("");
    } finally {
      db.close();
    }
  });

  it("surfaces warn/fail quality_signals (read-only、書き込みなし)", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      upsertRow(db, {
        table: "quality_signals",
        primaryKey: "signal_id",
        row: {
          signal_id: "skill:PLAN-Q:demo:firing_rate",
          source: "test",
          subject_id: "PLAN-Q",
          metric: "skill_firing_rate",
          value: 0,
          threshold: 1,
          status: "warn",
          computed_at: "2026-06-23T00:00:00.000Z",
        },
      });

      const result = selectTakeoverFeedback(db);
      expect(result.total).toBe(1);
      expect(result.items).toEqual([]);
      expect(result.byBucket.telemetry).toBe(1);
      expect(result.bySeverity.warn).toBe(1);
      expect(result.telemetryBySignal.skill_firing_rate).toBe(1);
      expect(renderTakeoverFeedback(result)).toContain("telemetry summarized: skill_firing_rate=1");

      // read-only 契約: surface は feedback_events を書かない。
      const inbox = (db.prepare("SELECT COUNT(*) AS n FROM feedback_events").get() as { n: number })
        .n;
      expect(inbox).toBe(0);
    } finally {
      db.close();
    }
  });

  it("orders higher severity first so the agent reads the most urgent feedback on top", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      insertFinding(db, "finding:takeover-drift:b-warn", "warn", "PLAN-A");
      insertFinding(db, "finding:takeover-drift:a-fail", "fail", "PLAN-B");

      const result = selectTakeoverFeedback(db);
      expect(result.items.length).toBeGreaterThanOrEqual(2);
      // fail outranks warn regardless of id ordering.
      expect(result.items[0]?.severity).toBe("fail");
      expect(result.items[0]?.bucket).toBe("gate");
      expect(result.byBucket.gate).toBe(1);
      expect(result.byBucket.actionable).toBe(1);
      expect(result.bySeverity.fail).toBe(1);
      expect(result.bySeverity.warn).toBe(1);
    } finally {
      db.close();
    }
  });

  it("caps surfaced signal groups and leaves a breadcrumb for the remainder", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      for (let i = 0; i < 5; i += 1) {
        insertFeedbackEvent(db, {
          id: `feedback:bulk-${i}`,
          signalType: `bulk-signal-${i}`,
          severity: "warn",
          planId: `PLAN-BULK-${i}`,
        });
      }
      const result = selectTakeoverFeedback(db, { limit: 2 });
      expect(result.total).toBe(5);
      expect(result.items.length).toBe(2);
      expect(renderTakeoverFeedback(result)).toContain("+3 more");
    } finally {
      db.close();
    }
  });

  it("selects diverse signal groups before applying the takeover surface limit", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      for (let i = 0; i < 12; i += 1) {
        insertFeedbackEvent(db, {
          id: `feedback:detector-${i.toString().padStart(2, "0")}`,
          signalType: "detector_route_candidate:spec-ir-invalid-subdoc",
          severity: "warn",
          nextAction: "review detector route candidates",
        });
      }
      insertFeedbackEvent(db, {
        id: "feedback:unresolved-join",
        signalType: "unresolved-join",
        severity: "warn",
        nextAction: "review unresolved join cluster",
      });

      const result = selectTakeoverFeedback(db, { limit: 2 });
      const rendered = renderTakeoverFeedback(result);

      expect(result.items).toHaveLength(2);
      expect(rendered).toContain("detector_route_candidate:spec-ir-invalid-subdoc");
      expect(rendered).toContain("count=12");
      expect(rendered).toContain("unresolved-join");
      expect(rendered).toContain("count=1");
      expect(result.items.some((item) => item.signal_type === "unresolved-join")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("keeps the takeover limit as a group limit and breadcrumbs hidden raw rows", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      for (let i = 0; i < 12; i += 1) {
        insertFeedbackEvent(db, {
          id: `feedback:detector-${i.toString().padStart(2, "0")}`,
          signalType: "detector_route_candidate:spec-ir-invalid-subdoc",
          severity: "warn",
        });
      }
      insertFeedbackEvent(db, {
        id: "feedback:unresolved-join",
        signalType: "unresolved-join",
        severity: "warn",
      });

      const result = selectTakeoverFeedback(db, { limit: 1 });
      const rendered = renderTakeoverFeedback(result);

      expect(result.items).toHaveLength(1);
      expect(rendered).toContain("detector_route_candidate:spec-ir-invalid-subdoc");
      expect(rendered).toContain("count=12");
      expect(rendered).not.toContain("unresolved-join");
      expect(rendered).toContain("+1 more actionable");
    } finally {
      db.close();
    }
  });

  it("keeps gate feedback ahead of larger actionable groups", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      insertFeedbackEvent(db, {
        id: "feedback:gate",
        signalType: "release-blocker",
        severity: "fail",
      });
      for (let i = 0; i < 12; i += 1) {
        insertFeedbackEvent(db, {
          id: `feedback:warn-${i.toString().padStart(2, "0")}`,
          signalType: "large-warn-group",
          severity: "warn",
        });
      }

      const result = selectTakeoverFeedback(db, { limit: 1 });

      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.signal_type).toBe("release-blocker");
      expect(result.items[0]?.bucket).toBe("gate");
    } finally {
      db.close();
    }
  });

  it("surfaces open feedback_events rows as the primary takeover source", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      insertFeedbackEvent(db, {
        id: "feedback:queue:PLAN-L7-366",
        signalType: "unresolved-join",
        severity: "warn",
        planId: "PLAN-L7-366",
        nextAction: "review queued feedback",
      });

      const result = selectTakeoverFeedback(db);
      expect(result.total).toBe(1);
      expect(result.items[0]).toMatchObject({
        feedback_event_id: "feedback:queue:PLAN-L7-366",
        signal_type: "unresolved-join",
        severity: "warn",
        plan_id: "PLAN-L7-366",
        bucket: "actionable",
      });
      expect(renderTakeoverFeedback(result)).toContain("review queued feedback");
    } finally {
      db.close();
    }
  });

  it("surfaces detector route candidate feedback as actionable routeFiling review work", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      insertFeedbackEvent(db, {
        id: "feedback:detector-route-candidate:spec-ir-1",
        signalType: "detector_route_candidate:spec-ir-orphan-relation",
        severity: "warn",
        nextAction:
          "review detector route candidate; candidate_status=non_ready; routeFiling SSoT evaluated signal=feature_addition; route_eval_mode=add-feature; allowed_kinds=add-design,add-impl; layer_band=L3-L6,L7; review_status=ssot_evaluated",
        sourceTable: "detector_route_candidates",
        sourceId: "candidate:spec-ir-1",
      });

      const result = selectTakeoverFeedback(db);
      expect(result.total).toBe(1);
      expect(result.items[0]).toMatchObject({
        signal_type: "detector_route_candidate:spec-ir-orphan-relation",
        severity: "warn",
        bucket: "actionable",
      });
      expect(renderTakeoverFeedback(result)).toContain("routeFiling SSoT");
      expect(renderTakeoverFeedback(result)).toContain("route_eval_mode=add-feature");
      expect(renderTakeoverFeedback(result)).toContain("allowed_kinds=add-design,add-impl");
      expect(renderTakeoverFeedback(result)).toContain("candidate_status=non_ready");
    } finally {
      db.close();
    }
  });

  it("does not surface closed feedback_events rows", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      insertFeedbackEvent(db, {
        id: "feedback:queue:closed",
        signalType: "unresolved-join",
        severity: "warn",
        status: "closed",
        planId: "PLAN-CLOSED",
      });

      const result = selectTakeoverFeedback(db);
      expect(result.total).toBe(0);
      expect(renderTakeoverFeedback(result)).toBe("");
    } finally {
      db.close();
    }
  });

  it("deduplicates findings and quality_signals already represented by feedback_events", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      insertFinding(db, "finding:takeover-drift:PLAN-L7-366", "warn", "PLAN-L7-366");
      insertFeedbackEvent(db, {
        id: "feedback:finding:finding:takeover-drift:PLAN-L7-366",
        signalType: "takeover-drift",
        severity: "warn",
        planId: "PLAN-L7-366",
        sourceTable: "findings",
        sourceId: "finding:takeover-drift:PLAN-L7-366",
        findingId: "finding:takeover-drift:PLAN-L7-366",
      });
      upsertRow(db, {
        table: "quality_signals",
        primaryKey: "signal_id",
        row: {
          signal_id: "refactor:PLAN-L7-366",
          source: "test",
          subject_id: "PLAN-L7-366",
          metric: "refactor_candidate:split-module",
          value: 1,
          threshold: 1,
          status: "warn",
          computed_at: "2026-07-07T00:00:00.000Z",
        },
      });
      insertFeedbackEvent(db, {
        id: "feedback:signal:refactor:PLAN-L7-366",
        signalType: "refactor_candidate:split-module",
        severity: "warn",
        planId: "PLAN-L7-366",
        sourceTable: "quality_signals",
        sourceId: "refactor:PLAN-L7-366",
      });

      const result = selectTakeoverFeedback(db);
      expect(result.total).toBe(2);
      expect(result.items.map((item) => item.feedback_event_id)).toEqual([
        "feedback:finding:finding:takeover-drift:PLAN-L7-366",
        "feedback:signal:refactor:PLAN-L7-366",
      ]);
    } finally {
      db.close();
    }
  });

  it("keeps high-confidence refactor warning signals actionable instead of telemetry-only", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      upsertRow(db, {
        table: "quality_signals",
        primaryKey: "signal_id",
        row: {
          signal_id: "refactor:src/large.ts",
          source: "test",
          subject_id: "src/large.ts",
          metric: "refactor_candidate:split-module",
          value: 950,
          threshold: 700,
          status: "warn",
          computed_at: "2026-07-07T00:00:00.000Z",
        },
      });

      const result = selectTakeoverFeedback(db);
      expect(result.total).toBe(1);
      expect(result.items[0]).toMatchObject({
        signal_type: "refactor_candidate:split-module",
        severity: "warn",
        bucket: "actionable",
      });
      expect(result.byBucket.actionable).toBe(1);
    } finally {
      db.close();
    }
  });

  it("renders feedback event rows with telemetry summarized for human CLI output", () => {
    const output = renderFeedbackEventRows([
      {
        feedback_event_id: "e1",
        signal_type: "unresolved-join",
        severity: "warn",
        plan_id: "PLAN-A",
        next_action: "review finding e1",
      },
      {
        feedback_event_id: "e2",
        signal_type: "missing-test-oracle-id",
        severity: "info",
        plan_id: "PLAN-B",
        next_action: "review quality signal e2",
      },
    ]);

    expect(output).toContain("feedback events: total=2 gate=0 actionable=1 telemetry=1");
    expect(output).toContain("(warn) unresolved-join [PLAN-A]: count=1");
    expect(output).toContain("telemetry summarized: missing-test-oracle-id=1");
    expect(output).not.toContain("review quality signal e2");
  });

  it("classifies gate, actionable, and telemetry feedback for display policy", () => {
    expect(classifyFeedbackBucket({ severity: "error", signal_type: "unresolved-join" })).toBe(
      "gate",
    );
    expect(classifyFeedbackBucket({ severity: "warn", signal_type: "unresolved-join" })).toBe(
      "actionable",
    );
    expect(
      classifyFeedbackBucket({ severity: "warn", signal_type: "artifact_progress_yellow" }),
    ).toBe("telemetry");
    expect(
      classifyFeedbackBucket({ severity: "info", signal_type: "missing-test-oracle-id" }),
    ).toBe("telemetry");
  });
});
