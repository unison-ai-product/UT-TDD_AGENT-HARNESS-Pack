/**
 * PLAN-L7-262: skill telemetry の provenance 分離 (A-178 G-8/G-9/G-11)。
 *
 * Oracle:
 *   - firing/acceptance rate は実 runtime 発火 (source=runtime-hook:*) のみを数え、
 *     auto-projection:review-evidence の間接推定行を含めない。
 *   - 新規 skill 推奨は session_id を持つ (空文字での偽装をやめる)。
 *   - 注入 skip (rebuild 失敗等) が session jsonl へ記録される。
 */
import { describe, expect, it } from "vitest";
import { computeSkillMetrics } from "../src/feedback/engine";
import {
  recordSkillInjectionAttempt,
  type SessionLogDeps,
  SKILL_INJECTION_UNKNOWN_SESSION_ID,
} from "../src/runtime/session-log";
import {
  recommendSkillsForPlan,
  resolveRuntimeSessionId,
  UNKNOWN_RUNTIME_SESSION_ID,
} from "../src/skill-engine/recommend";
import { openHarnessDb, upsertRow } from "../src/state-db/index";
import { migrate } from "../src/state-db/migration";
import {
  projectSkillMetrics,
  projectSkillTelemetry,
  REBUILD_INDIRECT_SESSION_ID,
  RUNTIME_SKILL_SOURCE_PREFIX,
} from "../src/state-db/skill-projections";

const PLAN_ID = "PLAN-L7-262-skill-telemetry-provenance";
const SKILL_ID = "skill:review-checklist";

function seedRecommendation(db: ReturnType<typeof openHarnessDb>, id: string): void {
  upsertRow(db, {
    table: "skill_recommendations",
    primaryKey: "skill_recommendation_id",
    row: {
      skill_recommendation_id: id,
      session_id: REBUILD_INDIRECT_SESSION_ID,
      plan_id: PLAN_ID,
      skill_id: SKILL_ID,
      rank: 1,
      score: 1,
      reason: "test",
      recommended_at: "2026-07-02T00:00:00.000Z",
    },
  });
}

function seedInvocation(
  db: ReturnType<typeof openHarnessDb>,
  id: string,
  source: string,
  accepted: number,
): void {
  upsertRow(db, {
    table: "skill_invocations",
    primaryKey: "skill_invocation_id",
    row: {
      skill_invocation_id: id,
      session_id: source.startsWith(RUNTIME_SKILL_SOURCE_PREFIX)
        ? "session-1"
        : REBUILD_INDIRECT_SESSION_ID,
      plan_id: PLAN_ID,
      skill_id: SKILL_ID,
      layer: "L7",
      drive: "db",
      fired_at: "2026-07-02T00:01:00.000Z",
      source,
      accepted,
    },
  });
}

describe("PLAN-L7-262: skill telemetry provenance separation", () => {
  it("computeSkillMetrics counts only runtime-hook invocations (auto-projection excluded)", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      seedRecommendation(db, "rec-1");
      seedInvocation(db, "inv-auto", "auto-projection:review-evidence", 1);

      const autoOnly = computeSkillMetrics(db);
      expect(autoOnly).toContainEqual(
        expect.objectContaining({ plan_id: PLAN_ID, firing_rate: 0, acceptance_rate: 0 }),
      );

      seedInvocation(db, "inv-runtime", "runtime-hook:skill-suggest", 1);
      const withRuntime = computeSkillMetrics(db);
      expect(withRuntime).toContainEqual(
        expect.objectContaining({ plan_id: PLAN_ID, firing_rate: 1, acceptance_rate: 1 }),
      );
    } finally {
      db.close();
    }
  });

  it("projectSkillMetrics quality signals carry runtime provenance and exclude auto-projection", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      seedRecommendation(db, "rec-1");
      seedInvocation(db, "inv-auto", "auto-projection:review-evidence", 1);
      projectSkillMetrics({
        db,
        deps: {
          nowIso: () => "2026-07-02T00:02:00.000Z",
          stableId: (prefix, value) => `${prefix}:${value}`,
          recordProjectionEvent: (target, event) => {
            upsertRow(target, { table: event.table, primaryKey: "signal_id", row: event.row });
          },
        },
      });
      const rows = db.prepare("SELECT source, metric, value FROM quality_signals").all() as {
        source: string;
        metric: string;
        value: number;
      }[];
      expect(rows.length).toBe(2);
      for (const row of rows) {
        expect(row.source).toBe("skill-metrics:runtime");
        expect(row.value).toBe(0);
      }
    } finally {
      db.close();
    }
  });

  it("resolveRuntimeSessionId uses UT_TDD_SESSION_ID and falls back to an explicit marker", () => {
    expect(resolveRuntimeSessionId({ UT_TDD_SESSION_ID: "sess-42" } as NodeJS.ProcessEnv)).toBe(
      "sess-42",
    );
    expect(resolveRuntimeSessionId({} as NodeJS.ProcessEnv)).toBe(UNKNOWN_RUNTIME_SESSION_ID);
    expect(UNKNOWN_RUNTIME_SESSION_ID).not.toBe("");
  });

  it("recordSkillInjectionAttempt records injection skip to the session jsonl", () => {
    const lines: { path: string; line: string }[] = [];
    const deps: SessionLogDeps = {
      repoRoot: "/repo",
      now: () => "2026-07-02T00:03:00.000Z",
      appendLine: (path, line) => lines.push({ path, line }),
      readText: () => null,
      writeText: () => {},
      currentBranch: () => null,
    };

    recordSkillInjectionAttempt(
      { plan_id: PLAN_ID, status: "skipped", reason: "rebuild-failed", required: 0, optional: 0 },
      deps,
    );
    recordSkillInjectionAttempt(
      { plan_id: PLAN_ID, status: "injected", required: 2, optional: 3, session_id: "sess-7" },
      deps,
    );

    expect(lines.length).toBe(2);
    const skip = JSON.parse(lines[0].line);
    expect(skip.event_type).toBe("skill_injection");
    expect(skip.outcome).toBe("error");
    expect(skip.target).toContain("rebuild-failed");
    expect(skip.session_id === "" ? "empty" : "labeled").toBe("labeled");
    expect(lines[0].path.replaceAll("\\", "/")).toContain(".ut-tdd/logs/session/");

    const injected = JSON.parse(lines[1].line);
    expect(injected.session_id).toBe("sess-7");
    expect(injected.outcome).toBe("ok");
    expect(injected.target).toContain("required=2 optional=3");
    expect(SKILL_INJECTION_UNKNOWN_SESSION_ID).not.toBe("");
  });

  it("normal-path skip (no-matching-skills) is recorded but not flagged as a failure", () => {
    const lines: { path: string; line: string }[] = [];
    const deps: SessionLogDeps = {
      repoRoot: "/repo",
      now: () => "2026-07-02T00:04:00.000Z",
      appendLine: (path, line) => lines.push({ path, line }),
      readText: () => null,
      writeText: () => {},
      currentBranch: () => null,
    };

    recordSkillInjectionAttempt(
      {
        plan_id: PLAN_ID,
        status: "skipped",
        reason: "no-matching-skills",
        required: 0,
        optional: 0,
      },
      deps,
    );

    const event = JSON.parse(lines[0].line);
    expect(event.event_type).toBe("skill_injection");
    // 正常系 skip は PlanDigest failures (outcome=error 収集) へ混入させない。
    expect(event.outcome).toBe("ok");
    expect(event.target).toContain("no-matching-skills");
  });

  it("projectSkillTelemetry rows carry the rebuild marker session_id (never empty)", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      upsertRow(db, {
        table: "automation_assets",
        primaryKey: "asset_id",
        row: {
          asset_id: SKILL_ID,
          asset_type: "skill",
          path: "skills/review-checklist.md",
          trigger: "review",
          role: "reviewer",
          capability: "review checklist",
          skill_type: "workflow",
          applies_layers: "L7",
          applies_drive_models: "Add-feature",
        },
      });
      upsertRow(db, {
        table: "review_evidence_registry",
        primaryKey: "review_evidence_id",
        row: { review_evidence_id: `rev:${PLAN_ID}`, plan_id: PLAN_ID, has_evidence: 1 },
      });
      projectSkillTelemetry({
        db,
        plans: new Map([
          [
            PLAN_ID,
            {
              planId: PLAN_ID,
              kind: "add-impl",
              layer: "L7",
              drive: "db",
              status: "confirmed",
              updatedAt: "2026-07-02T00:00:00.000Z",
            },
          ],
        ]),
        deps: {
          nowIso: () => "2026-07-02T00:05:00.000Z",
          stableId: (prefix, value) => `${prefix}:${value}`,
          recordProjectionEvent: (target, event) => {
            upsertRow(target, {
              table: event.table,
              primaryKey:
                event.table === "skill_invocations"
                  ? "skill_invocation_id"
                  : "skill_recommendation_id",
              row: event.row,
            });
          },
          skillDriveModelForPlan: () => "Add-feature",
        },
      });
      const recs = db.prepare("SELECT session_id FROM skill_recommendations").all() as {
        session_id: string;
      }[];
      const invs = db.prepare("SELECT session_id FROM skill_invocations").all() as {
        session_id: string;
      }[];
      expect(recs.length).toBeGreaterThan(0);
      expect(invs.length).toBeGreaterThan(0);
      for (const row of [...recs, ...invs]) {
        expect(row.session_id).toBe(REBUILD_INDIRECT_SESSION_ID);
      }
    } finally {
      db.close();
    }
  });

  it("recommendSkillsForPlan output rows never carry an empty session_id", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      upsertRow(db, {
        table: "plan_registry",
        primaryKey: "plan_id",
        row: {
          plan_id: PLAN_ID,
          kind: "add-impl",
          layer: "L7",
          drive: "db",
          status: "draft",
          route_mode: "add-feature",
        },
      });
      upsertRow(db, {
        table: "automation_assets",
        primaryKey: "asset_id",
        row: {
          asset_id: SKILL_ID,
          asset_type: "skill",
          path: "skills/review-checklist.md",
          trigger: "review",
          role: "reviewer",
          capability: "review checklist",
          skill_type: "workflow",
          applies_layers: "L7",
          applies_drive_models: "Add-feature",
        },
      });
      const recs = recommendSkillsForPlan(db, PLAN_ID);
      expect(recs.length).toBeGreaterThan(0);
      for (const rec of recs) {
        expect(rec.session_id).not.toBe("");
        expect(rec.session_id.length).toBeGreaterThan(0);
      }
    } finally {
      db.close();
    }
  });
});
