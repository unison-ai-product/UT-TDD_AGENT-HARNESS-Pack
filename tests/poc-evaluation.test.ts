/**
 * U-FR-L1-43: PoC success measurement projection (FR-L1-43 / PLAN-L7-53-learning-engine)
 *
 * Oracle: projectPocEvaluations projects one summary row with:
 *   poc_success_rate = confirmed_count / (confirmed + rejected + pivot)
 *   from plan_registry (kind="poc", decision_outcome != "").
 *   PoC PLANs with empty decision_outcome are excluded from denominator.
 *   Pivot counts as non-success (denominator, not numerator).
 *   Cold-start: 0 decided PoC PLANs => 0 poc_evaluations rows (no throw).
 *
 * AC-FR-BR21-43-01: 10 PoC, 6 confirmed / 3 rejected / 1 pivot => rate 0.60
 * AC-FR-BR21-43-02 cold-start: 0 PoC PLANs => 0 rows
 */
import { describe, expect, it } from "vitest";
import { openHarnessDb, upsertRow } from "../src/state-db/index";
import { migrate, rowCounts } from "../src/state-db/migration";
import { projectPocEvaluations } from "../src/state-db/projection-writer";

function seedPocPlan(
  db: ReturnType<typeof openHarnessDb>,
  planId: string,
  decisionOutcome: string,
): void {
  upsertRow(db, {
    table: "plan_registry",
    primaryKey: "plan_id",
    row: {
      plan_id: planId,
      kind: "poc",
      layer: "cross",
      drive: "fullstack",
      status: "confirmed",
      updated_at: "",
      decision_outcome: decisionOutcome,
    },
  });
}

describe("U-FR-L1-43: projectPocEvaluations", () => {
  it("AC-FR-BR21-43-02 cold-start: zero PoC PLANs produces zero rows and does not throw", () => {
    // U-FR-L1-43 cold-start oracle
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      projectPocEvaluations(db, { asOf: "2026-06-15T00:00:00.000Z" });
      expect(rowCounts(db).poc_evaluations).toBe(0);
    } finally {
      db.close();
    }
  });

  it("AC-FR-BR21-43-01: 10 PoC (6 confirmed / 3 rejected / 1 pivot) => rate 0.60", () => {
    // U-FR-L1-43 AC-01
    const asOf = "2026-06-15T12:00:00.000Z";
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);

      for (let i = 1; i <= 6; i++) {
        seedPocPlan(db, `PLAN-POC-CONFIRMED-0${i}`, "confirmed");
      }
      for (let i = 1; i <= 3; i++) {
        seedPocPlan(db, `PLAN-POC-REJECTED-0${i}`, "rejected");
      }
      seedPocPlan(db, "PLAN-POC-PIVOT-01", "pivot");

      projectPocEvaluations(db, { asOf });

      const row = db
        .prepare("SELECT * FROM poc_evaluations WHERE poc_evaluation_id = ?")
        .get("poc-evaluation:summary") as Record<string, unknown> | undefined;

      expect(row).toBeDefined();
      expect(Number(row?.confirmed_count)).toBe(6);
      expect(Number(row?.rejected_count)).toBe(3);
      expect(Number(row?.pivot_count)).toBe(1);
      expect(Number(row?.total_count)).toBe(10);
      expect(Number(row?.poc_success_rate)).toBeCloseTo(0.6, 4);
      expect(String(row?.evaluated_at)).toBe(asOf);
    } finally {
      db.close();
    }
  });

  it("undecided PoC PLANs (decision_outcome='') are excluded from denominator", () => {
    // U-FR-L1-43: only decided outcomes contribute to the rate
    const asOf = "2026-06-15T12:00:00.000Z";
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);

      seedPocPlan(db, "PLAN-POC-C-01", "confirmed");
      seedPocPlan(db, "PLAN-POC-C-02", "confirmed");
      // undecided — should NOT count toward denominator
      seedPocPlan(db, "PLAN-POC-UNDECIDED-01", "");
      seedPocPlan(db, "PLAN-POC-UNDECIDED-02", "");

      projectPocEvaluations(db, { asOf });

      const row = db
        .prepare("SELECT * FROM poc_evaluations WHERE poc_evaluation_id = ?")
        .get("poc-evaluation:summary") as Record<string, unknown> | undefined;

      expect(row).toBeDefined();
      // Only 2 confirmed, 0 rejected, 0 pivot, total_count = 2
      expect(Number(row?.confirmed_count)).toBe(2);
      expect(Number(row?.total_count)).toBe(2);
      expect(Number(row?.poc_success_rate)).toBeCloseTo(1.0, 4);
    } finally {
      db.close();
    }
  });

  it("pivot counts as non-success (denominator only, not numerator)", () => {
    // U-FR-L1-43: pivot_count in denominator, not numerator
    const asOf = "2026-06-15T12:00:00.000Z";
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);

      seedPocPlan(db, "PLAN-POC-C-01", "confirmed");
      seedPocPlan(db, "PLAN-POC-PIVOT-01", "pivot");
      seedPocPlan(db, "PLAN-POC-PIVOT-02", "pivot");
      seedPocPlan(db, "PLAN-POC-PIVOT-03", "pivot");

      projectPocEvaluations(db, { asOf });

      const row = db
        .prepare("SELECT * FROM poc_evaluations WHERE poc_evaluation_id = ?")
        .get("poc-evaluation:summary") as Record<string, unknown> | undefined;

      expect(row).toBeDefined();
      expect(Number(row?.confirmed_count)).toBe(1);
      expect(Number(row?.pivot_count)).toBe(3);
      expect(Number(row?.total_count)).toBe(4);
      // 1 / 4 = 0.25
      expect(Number(row?.poc_success_rate)).toBeCloseTo(0.25, 4);
    } finally {
      db.close();
    }
  });

  it("non-poc PLANs are not counted even if they have decision_outcome", () => {
    // U-FR-L1-43: only kind='poc' PLANs contribute
    const asOf = "2026-06-15T12:00:00.000Z";
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);

      // impl PLAN with decision_outcome — must NOT contribute
      upsertRow(db, {
        table: "plan_registry",
        primaryKey: "plan_id",
        row: {
          plan_id: "PLAN-IMPL-01",
          kind: "impl",
          layer: "L7",
          drive: "db",
          status: "confirmed",
          updated_at: "",
          decision_outcome: "confirmed",
        },
      });
      // Only real poc PLAN
      seedPocPlan(db, "PLAN-POC-C-01", "rejected");

      projectPocEvaluations(db, { asOf });

      const row = db
        .prepare("SELECT * FROM poc_evaluations WHERE poc_evaluation_id = ?")
        .get("poc-evaluation:summary") as Record<string, unknown> | undefined;

      expect(row).toBeDefined();
      expect(Number(row?.confirmed_count)).toBe(0);
      expect(Number(row?.rejected_count)).toBe(1);
      expect(Number(row?.total_count)).toBe(1);
      expect(Number(row?.poc_success_rate)).toBeCloseTo(0.0, 4);
    } finally {
      db.close();
    }
  });

  it("all confirmed PLANs => rate 1.0", () => {
    // U-FR-L1-43: 100% success case
    const asOf = "2026-06-15T12:00:00.000Z";
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);

      for (let i = 1; i <= 5; i++) {
        seedPocPlan(db, `PLAN-POC-C-0${i}`, "confirmed");
      }

      projectPocEvaluations(db, { asOf });

      const row = db
        .prepare("SELECT * FROM poc_evaluations WHERE poc_evaluation_id = ?")
        .get("poc-evaluation:summary") as Record<string, unknown> | undefined;

      expect(row).toBeDefined();
      expect(Number(row?.poc_success_rate)).toBeCloseTo(1.0, 4);
      expect(Number(row?.total_count)).toBe(5);
      expect(rowCounts(db).poc_evaluations).toBe(1);
    } finally {
      db.close();
    }
  });

  it("all rejected PLANs => rate 0.0", () => {
    // U-FR-L1-43: 0% success case
    const asOf = "2026-06-15T12:00:00.000Z";
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);

      seedPocPlan(db, "PLAN-POC-R-01", "rejected");
      seedPocPlan(db, "PLAN-POC-R-02", "rejected");

      projectPocEvaluations(db, { asOf });

      const row = db
        .prepare("SELECT * FROM poc_evaluations WHERE poc_evaluation_id = ?")
        .get("poc-evaluation:summary") as Record<string, unknown> | undefined;

      expect(row).toBeDefined();
      expect(Number(row?.poc_success_rate)).toBeCloseTo(0.0, 4);
      expect(Number(row?.confirmed_count)).toBe(0);
      expect(Number(row?.rejected_count)).toBe(2);
    } finally {
      db.close();
    }
  });
});
