import { describe, expect, it } from "vitest";
import { computeSkillMetrics, emitFeedbackEvents } from "../src/feedback/engine.ts";
import { findReference, upsertSearchReference } from "../src/search/index.ts";
import { openHarnessDb, upsertRow } from "../src/state-db/index.ts";
import { migrate, rowCounts } from "../src/state-db/migration.ts";

describe("IT-SEARCH-01 / IT-DB-03 / IT-FEEDBACK-01", () => {
  it("findReference returns exact ID matches before fuzzy token matches without mutating sources", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      upsertSearchReference(db, {
        subject_type: "plan",
        subject_id: "PLAN-L7-47-search-metrics-feedback",
        path: "docs/plans/PLAN-L7-47-search-metrics-feedback.md",
        title: "search metrics feedback",
        tokens: "search metrics feedback skill",
        summary: "ranked lookup",
        updated_at: "2026-06-11T00:00:00.000Z",
      });
      upsertSearchReference(db, {
        subject_type: "finding",
        subject_id: "finding:search",
        path: ".ut-tdd/evidence/finding.json",
        title: "search finding",
        tokens: "feedback search stale",
        summary: "open finding",
        updated_at: "2026-06-11T00:00:00.000Z",
      });

      const exact = findReference(db, "PLAN-L7-47-search-metrics-feedback");
      const fuzzy = findReference(db, "stale search");

      expect(exact[0]).toMatchObject({
        subject_type: "plan",
        subject_id: "PLAN-L7-47-search-metrics-feedback",
        reason: "exact-id",
      });
      expect(fuzzy[0].score).toBeGreaterThanOrEqual(fuzzy.at(-1)?.score ?? 0);
      expect(rowCounts(db).search_index).toBe(2);
    } finally {
      db.close();
    }
  });

  it("uses the canonical SECRET_PATTERN: legitimate hyphenated names index, real tokens are rejected", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      // "planning-and-task-breakdown" contains "sk-breakdown" but is NOT a secret;
      // the old weak regex (sk-[A-Za-z0-9_-]+) false-positively rejected it.
      expect(() =>
        upsertSearchReference(db, {
          subject_type: "automation_asset",
          subject_id: "skill:planning-and-task-breakdown",
          path: "docs/skills/planning-and-task-breakdown.md",
          title: "planning-and-task-breakdown",
          tokens: "skill process planning-and-task-breakdown",
          summary: "skill ok",
          updated_at: "2026-06-17T00:00:00.000Z",
        }),
      ).not.toThrow();
      expect(rowCounts(db).search_index).toBe(1);

      // A real high-entropy token (16+ chars) must still be rejected.
      // Built at runtime so the literal does not appear in source (and trip the
      // pre-commit secret scanner) while still matching SECRET_PATTERN.
      const leakToken = `sk-${"a".repeat(20)}`;
      expect(() =>
        upsertSearchReference(db, {
          subject_type: "finding",
          subject_id: "finding:leak",
          path: ".ut-tdd/audit/finding.json",
          title: "leak",
          tokens: `${leakToken} leaked`,
          summary: "open finding",
          updated_at: "2026-06-17T00:00:00.000Z",
        }),
      ).toThrow(/secret-like/);
      expect(rowCounts(db).search_index).toBe(1);
    } finally {
      db.close();
    }
  });

  it("computeSkillMetrics stores firing and acceptance rates as quality signals", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      for (const id of ["rec-1", "rec-2"]) {
        upsertRow(db, {
          table: "skill_recommendations",
          primaryKey: "skill_recommendation_id",
          row: {
            skill_recommendation_id: id,
            session_id: "s1",
            plan_id: "PLAN-L7-47-search-metrics-feedback",
            skill_id: "testing",
            rank: id === "rec-1" ? 1 : 2,
            score: 1,
            reason: "db span",
            recommended_at: "2026-06-11T00:00:00.000Z",
          },
        });
      }
      upsertRow(db, {
        table: "skill_invocations",
        primaryKey: "skill_invocation_id",
        row: {
          skill_invocation_id: "inv-1",
          session_id: "s1",
          plan_id: "PLAN-L7-47-search-metrics-feedback",
          skill_id: "testing",
          layer: "L7",
          drive: "db",
          fired_at: "2026-06-11T00:01:00.000Z",
          source: "runtime-hook:skill-suggest",
          accepted: 1,
        },
      });

      const metrics = computeSkillMetrics(db);

      expect(metrics).toContainEqual(
        expect.objectContaining({
          plan_id: "PLAN-L7-47-search-metrics-feedback",
          skill_id: "testing",
          firing_rate: 0.5,
          acceptance_rate: 1,
        }),
      );
      expect(rowCounts(db).quality_signals).toBe(2);
    } finally {
      db.close();
    }
  });

  it("emitFeedbackEvents groups open findings and quality failures without approving plans", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      upsertRow(db, {
        table: "findings",
        primaryKey: "finding_id",
        row: {
          finding_id: "finding-1",
          kind: "orphan-trace",
          severity: "warn",
          subject_id: "PLAN-L7-47-search-metrics-feedback",
          source: "doctor",
          status: "open",
          evidence_path: ".ut-tdd/evidence/orphan.json",
        },
      });
      upsertRow(db, {
        table: "quality_signals",
        primaryKey: "signal_id",
        row: {
          signal_id: "signal-1",
          source: "schedule-lint",
          subject_id: "PLAN-L7-47-search-metrics-feedback",
          metric: "schedule_lint",
          value: 1,
          threshold: 0,
          status: "fail",
          computed_at: "2026-06-11T00:02:00.000Z",
        },
      });
      upsertRow(db, {
        table: "quality_signals",
        primaryKey: "signal_id",
        row: {
          signal_id: "signal-2",
          source: "refactor-candidate-detector",
          subject_id: "PLAN-L7-47-search-metrics-feedback",
          metric: "refactor_candidate:split-module",
          value: 950,
          threshold: 700,
          status: "warn",
          computed_at: "2026-06-11T00:03:00.000Z",
        },
      });

      const events = emitFeedbackEvents(db);

      expect(events.length).toBe(3);
      expect(events.every((event) => event.status === "open")).toBe(true);
      expect(events.every((event) => event.next_action.includes("review"))).toBe(true);
      expect(events.find((event) => event.signal_type === "schedule_lint")?.severity).toBe("fail");
      expect(
        events.find((event) => event.signal_type === "refactor_candidate:split-module")?.severity,
      ).toBe("warn");
      const plan = db.prepare("SELECT * FROM plan_registry").get();
      expect(plan).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("emitFeedbackEvents promotes detector route candidates and suppresses duplicate source findings", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      upsertRow(db, {
        table: "findings",
        primaryKey: "finding_id",
        row: {
          finding_id: "finding:spec-ir-orphan",
          kind: "spec-ir-orphan-relation",
          severity: "warn",
          subject_id: "spec-relation:missing",
          source: "spec-ir-projection",
          status: "open",
          evidence_path: "docs/plans/PLAN-L6-39-vmodel-spec-ir-function-contracts.md",
        },
      });
      upsertRow(db, {
        table: "detector_route_candidates",
        primaryKey: "route_candidate_id",
        row: {
          route_candidate_id: "candidate:spec-ir-orphan",
          source_table: "findings",
          source_id: "finding:spec-ir-orphan",
          detector_id: "spec-ir-integrity",
          finding_kind: "spec-ir-orphan-relation",
          severity: "warn",
          subject_kind: "spec_ir",
          subject_id: "spec-relation:missing",
          filing_target_id: "routeFiling:feature_addition",
          target_layer: "L6",
          target_sub_doc: "function-spec",
          candidate_status: "non_ready",
          reason: "routeFiling SSoT evaluation required",
          evidence_path: "docs/plans/PLAN-L6-39-vmodel-spec-ir-function-contracts.md",
          computed_at: "2026-07-08T00:00:00.000Z",
        },
      });

      const events = emitFeedbackEvents(db);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        feedback_event_id: "feedback:detector-route-candidate:candidate:spec-ir-orphan",
        source_table: "detector_route_candidates",
        source_id: "candidate:spec-ir-orphan",
        source_color: "non_ready",
        signal_type: "detector_route_candidate:spec-ir-orphan-relation",
        severity: "warn",
      });
      expect(events[0]?.next_action).toContain("routeFiling SSoT");
      expect(events[0]?.next_action).toContain("route_eval_mode=add-feature");
      expect(events[0]?.next_action).toContain("allowed_kinds=add-design,add-impl");
      expect(events[0]?.next_action).toContain("requires_human_approval=false");
      expect(
        db
          .prepare("SELECT COUNT(*) AS n FROM feedback_events WHERE source_table = ?")
          .get("findings"),
      ).toMatchObject({ n: 0 });
    } finally {
      db.close();
    }
  });
});
