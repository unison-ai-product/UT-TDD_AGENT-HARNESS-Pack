/**
 * PLAN-L7-262: skill telemetry の provenance 分離 (A-178 G-8/G-9/G-11)。
 *
 * Oracle:
 *   - firing/acceptance rate は実 runtime 発火 (source=runtime-hook:*) のみを数え、
 *     auto-projection:review-evidence の間接推定行を含めない。
 *   - テキスト由来の skill 推奨は session_id を持つ。
 *   - 注入 skip (rebuild 失敗等) が session jsonl へ記録される。
 */
import { describe, expect, it } from "vitest";
import { computeSkillMetrics } from "../src/feedback/engine.ts";
import {
  recordSkillInjectionAttempt,
  type SessionLogDeps,
  SKILL_INJECTION_UNKNOWN_SESSION_ID,
} from "../src/runtime/session-log.ts";
import {
  recommendSkillsForText,
  resolveRuntimeSessionId,
  UNKNOWN_RUNTIME_SESSION_ID,
} from "../src/skill-engine/recommend.ts";
import { openHarnessDb, upsertRow } from "../src/state-db/index.ts";
import { migrate, rowCounts } from "../src/state-db/migration.ts";
import {
  projectSkillMetrics,
  RUNTIME_SKILL_SOURCE_PREFIX,
} from "../src/state-db/skill-projections.ts";

const PLAN_ID = "PLAN-L7-262-skill-telemetry-provenance";
const SKILL_ID = "skill:review-checklist";
const LEGACY_REBUILD_SESSION_ID = "rebuild:indirect";

function seedRecommendation(
  db: ReturnType<typeof openHarnessDb>,
  id: string,
  skillId: string | null = SKILL_ID,
): void {
  upsertRow(db, {
    table: "skill_recommendations",
    primaryKey: "skill_recommendation_id",
    row: {
      skill_recommendation_id: id,
      session_id: LEGACY_REBUILD_SESSION_ID,
      plan_id: PLAN_ID,
      skill_id: skillId,
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
  { skillId, planId }: { skillId: string | null; planId: string | null } = {
    skillId: SKILL_ID,
    planId: PLAN_ID,
  },
): void {
  upsertRow(db, {
    table: "skill_invocations",
    primaryKey: "skill_invocation_id",
    row: {
      skill_invocation_id: id,
      session_id: source.startsWith(RUNTIME_SKILL_SOURCE_PREFIX)
        ? "session-1"
        : LEGACY_REBUILD_SESSION_ID,
      plan_id: planId,
      skill_id: skillId,
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

  it("projectSkillMetrics keeps historical runtime signals and excludes observations without a skill ID", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      seedRecommendation(db, "rec-1");
      seedRecommendation(db, "rec-missing-skill", null);
      seedRecommendation(db, "rec-empty-skill", "");
      seedInvocation(db, "inv-auto", "auto-projection:review-evidence", 1);
      seedInvocation(db, "inv-missing-skill", "runtime-hook:skill-suggest", 1, {
        planId: null,
        skillId: null,
      });
      seedInvocation(db, "inv-empty-skill", "runtime-hook:skill-suggest", 1, {
        planId: null,
        skillId: "",
      });

      const projection: Parameters<typeof projectSkillMetrics>[0] = {
        db,
        deps: {
          nowIso: () => "2026-07-02T00:02:00.000Z",
          stableId: (prefix, value) => `${prefix}:${value}`,
          recordProjectionEvent: (target, event) => {
            upsertRow(target, { table: event.table, primaryKey: "signal_id", row: event.row });
          },
        },
      };
      const selectSignals = db.prepare(
        "SELECT source, subject_id, metric, value FROM quality_signals ORDER BY metric",
      );
      const signal = { source: "skill-metrics:runtime", subject_id: `${PLAN_ID}:${SKILL_ID}` };
      projectSkillMetrics(projection);
      expect(selectSignals.all()).toEqual([
        { ...signal, metric: "skill_acceptance_rate", value: 0 },
        { ...signal, metric: "skill_firing_rate", value: 0 },
      ]);

      seedInvocation(db, "inv-runtime", "runtime-hook:skill-suggest", 1);
      projectSkillMetrics(projection);
      expect(selectSignals.all()).toEqual([
        { ...signal, metric: "skill_acceptance_rate", value: 1 },
        { ...signal, metric: "skill_firing_rate", value: 1 },
      ]);
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
    };

    recordSkillInjectionAttempt(
      { plan_id: "", status: "skipped", reason: "rebuild-failed", required: 0, optional: 0 },
      deps,
    );
    recordSkillInjectionAttempt(
      { plan_id: "", status: "injected", required: 2, optional: 3, session_id: "sess-7" },
      deps,
    );

    expect(lines.length).toBe(2);
    const skip = JSON.parse(lines[0].line);
    expect(skip.event_type).toBe("skill_injection");
    expect(skip.plan_id).toBeNull();
    expect(skip.outcome).toBe("error");
    expect(skip.target).toContain("rebuild-failed");
    expect(skip.session_id === "" ? "empty" : "labeled").toBe("labeled");
    expect(lines[0].path.replaceAll("\\", "/")).toContain(".ut-tdd/logs/session/");

    const injected = JSON.parse(lines[1].line);
    expect(injected.session_id).toBe("sess-7");
    expect(injected.plan_id).toBeNull();
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
    };

    recordSkillInjectionAttempt(
      {
        plan_id: "",
        status: "skipped",
        reason: "no-matching-skills",
        required: 0,
        optional: 0,
      },
      deps,
    );

    const event = JSON.parse(lines[0].line);
    expect(event.event_type).toBe("skill_injection");
    expect(event.plan_id).toBeNull();
    // 正常系 skip は error event にしない。
    expect(event.outcome).toBe("ok");
    expect(event.target).toContain("no-matching-skills");
  });

  it("recommendSkillsForText preserves runtime session and text provenance", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      const skillId = "skill:reverse-routing-review";
      upsertRow(db, {
        table: "automation_assets",
        primaryKey: "asset_id",
        row: {
          asset_id: skillId,
          asset_type: "skill",
          path: "skills/reverse-routing-review.md",
          trigger: "reverse routing review",
          role: "reviewer",
          capability: "reverse back-fill lint quality checklist",
          skill_type: "workflow",
          applies_layers: "L3",
          applies_drive_models: "Reverse",
        },
      });
      const recs = recommendSkillsForText(db, "reverse back-fill the L3 requirements as-is", {
        recordedAt: "2026-07-02T00:05:00.000Z",
      });
      expect(recs).toHaveLength(1);
      const sessionId = resolveRuntimeSessionId();
      expect(sessionId).not.toBe("");
      expect(recs[0]).toMatchObject({
        skill_id: skillId,
        session_id: sessionId,
        reason: expect.stringContaining("source=text"),
      });
      expect(rowCounts(db).skill_recommendations).toBe(0);
    } finally {
      db.close();
    }
  });
});
