/**
 * U-FR-L1-36: skill evaluation projection (FR-L1-36 / PLAN-L7-53-learning-engine)
 *
 * Oracle: projectSkillEvaluations computes per-skill rating, adoption_count,
 * success_count, and unused_flag from skill_invocations + plan_registry.
 *   - skill_rating = success_count / adoption_count (0.0-1.0)
 *   - adoption = distinct plan_id with accepted=1
 *   - success = adopted plan whose plan_registry.status is "confirmed" or "completed"
 *   - unused_flag = 1 when no invocation has fired_at within last 30 days
 *   - Cold-start: 0 invocations => 0 evaluation rows (no throw)
 *
 * AC-FR-BR21-36-01: 5 adopted plans, all 5 success => rating 1.0, unused_flag 0
 * AC-FR-BR21-36-02: skill with 0 adoption in last 30 days => unused_flag 1; no auto-delete
 */
import { describe, expect, it } from "vitest";
import { openHarnessDb, upsertRow } from "../src/state-db/index";
import { migrate, rowCounts } from "../src/state-db/migration";
import { projectSkillEvaluations } from "../src/state-db/projection-writer";

function seedPlan(db: ReturnType<typeof openHarnessDb>, planId: string, status: string): void {
  upsertRow(db, {
    table: "plan_registry",
    primaryKey: "plan_id",
    row: { plan_id: planId, kind: "impl", layer: "L7", drive: "db", status, updated_at: "" },
  });
}

function seedInvocation(
  db: ReturnType<typeof openHarnessDb>,
  opts: { id: string; skillId: string; planId: string; accepted: number; firedAt: string },
): void {
  upsertRow(db, {
    table: "skill_invocations",
    primaryKey: "skill_invocation_id",
    row: {
      skill_invocation_id: opts.id,
      session_id: "",
      plan_id: opts.planId,
      skill_id: opts.skillId,
      layer: "L7",
      drive: "db",
      fired_at: opts.firedAt,
      source: "test",
      accepted: opts.accepted,
    },
  });
}

describe("U-FR-L1-36: projectSkillEvaluations", () => {
  it("cold-start: zero invocations produces zero evaluation rows and does not throw", () => {
    // U-FR-L1-36 cold-start oracle
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      projectSkillEvaluations(db, { asOf: "2026-06-15T00:00:00.000Z" });
      expect(rowCounts(db).skill_evaluations).toBe(0);
    } finally {
      db.close();
    }
  });

  it("AC-FR-BR21-36-01: 5 adopted plans all confirmed => rating 1.0, unused_flag 0", () => {
    // U-FR-L1-36 AC-01
    const asOf = "2026-06-15T12:00:00.000Z";
    // recent: within 30 days of asOf
    const recentFiredAt = "2026-06-14T12:00:00.000Z";
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);

      for (let i = 1; i <= 5; i++) {
        const planId = `PLAN-SKILL-EVAL-0${i}`;
        seedPlan(db, planId, "confirmed");
        seedInvocation(db, {
          id: `inv-ac01-${i}`,
          skillId: "skill:review-checklist",
          planId,
          accepted: 1,
          firedAt: recentFiredAt,
        });
      }

      projectSkillEvaluations(db, { asOf });

      const row = db
        .prepare("SELECT * FROM skill_evaluations WHERE skill_id = ?")
        .get("skill:review-checklist") as Record<string, unknown> | undefined;

      expect(row).toBeDefined();
      expect(Number(row?.adoption_count)).toBe(5);
      expect(Number(row?.success_count)).toBe(5);
      expect(Number(row?.skill_rating)).toBeCloseTo(1.0, 4);
      expect(Number(row?.unused_flag)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("AC-FR-BR21-36-02: no invocation in last 30 days => unused_flag 1; skill row preserved (no auto-delete)", () => {
    // U-FR-L1-36 AC-02
    const asOf = "2026-06-15T12:00:00.000Z";
    // older than 30 days from asOf
    const oldFiredAt = "2026-05-01T00:00:00.000Z";
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);

      seedPlan(db, "PLAN-OLD-01", "confirmed");
      seedInvocation(db, {
        id: "inv-old-01",
        skillId: "skill:code-review",
        planId: "PLAN-OLD-01",
        accepted: 1,
        firedAt: oldFiredAt,
      });

      projectSkillEvaluations(db, { asOf });

      const row = db
        .prepare("SELECT * FROM skill_evaluations WHERE skill_id = ?")
        .get("skill:code-review") as Record<string, unknown> | undefined;

      expect(row).toBeDefined();
      expect(Number(row?.unused_flag)).toBe(1);
      // Row still exists — no auto-delete
      expect(rowCounts(db).skill_evaluations).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("partial success: 3 of 5 plans confirmed, 2 draft => rating 0.6", () => {
    // U-FR-L1-36: rating = success_count / adoption_count
    const asOf = "2026-06-15T12:00:00.000Z";
    const recentAt = "2026-06-14T12:00:00.000Z";
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);

      for (let i = 1; i <= 3; i++) {
        const planId = `PLAN-PART-OK-0${i}`;
        seedPlan(db, planId, "confirmed");
        seedInvocation(db, {
          id: `inv-part-ok-${i}`,
          skillId: "skill:linter",
          planId,
          accepted: 1,
          firedAt: recentAt,
        });
      }
      for (let i = 4; i <= 5; i++) {
        const planId = `PLAN-PART-DRAFT-0${i}`;
        seedPlan(db, planId, "draft");
        seedInvocation(db, {
          id: `inv-part-draft-${i}`,
          skillId: "skill:linter",
          planId,
          accepted: 1,
          firedAt: recentAt,
        });
      }

      projectSkillEvaluations(db, { asOf });

      const row = db
        .prepare("SELECT * FROM skill_evaluations WHERE skill_id = ?")
        .get("skill:linter") as Record<string, unknown> | undefined;

      expect(row).toBeDefined();
      expect(Number(row?.adoption_count)).toBe(5);
      expect(Number(row?.success_count)).toBe(3);
      expect(Number(row?.skill_rating)).toBeCloseTo(0.6, 4);
    } finally {
      db.close();
    }
  });

  it("rejected invocations (accepted=0) do not count toward adoption", () => {
    // U-FR-L1-36: adoption = distinct plan_id with accepted=1
    const asOf = "2026-06-15T12:00:00.000Z";
    const recentAt = "2026-06-14T12:00:00.000Z";
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);

      seedPlan(db, "PLAN-REJECTED-01", "confirmed");
      seedInvocation(db, {
        id: "inv-rejected-01",
        skillId: "skill:test-design",
        planId: "PLAN-REJECTED-01",
        accepted: 0,
        firedAt: recentAt,
      });

      projectSkillEvaluations(db, { asOf });
      // No accepted=1 invocations => cold-start branch => 0 rows
      expect(rowCounts(db).skill_evaluations).toBe(0);
    } finally {
      db.close();
    }
  });

  it("completed plans count as success (both terminal-success statuses)", () => {
    // U-FR-L1-36: success includes "completed" as well as "confirmed"
    const asOf = "2026-06-15T12:00:00.000Z";
    const recentAt = "2026-06-14T12:00:00.000Z";
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);

      seedPlan(db, "PLAN-COMP-01", "completed");
      seedInvocation(db, {
        id: "inv-comp-01",
        skillId: "skill:handover",
        planId: "PLAN-COMP-01",
        accepted: 1,
        firedAt: recentAt,
      });

      projectSkillEvaluations(db, { asOf });

      const row = db
        .prepare("SELECT success_count FROM skill_evaluations WHERE skill_id = ?")
        .get("skill:handover") as { success_count: number } | undefined;

      expect(Number(row?.success_count)).toBe(1);
    } finally {
      db.close();
    }
  });
});
