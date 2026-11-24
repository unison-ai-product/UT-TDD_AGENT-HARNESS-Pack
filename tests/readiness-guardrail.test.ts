import { describe, expect, it } from "vitest";
import { recordGuardrailDecision } from "../src/guardrail/ledger.ts";
import { stableId } from "../src/stable-id.ts";
import { openHarnessDb, upsertRow } from "../src/state-db/index.ts";
import { migrate, rowCounts } from "../src/state-db/migration.ts";
import { evaluateAutomationReadiness } from "../src/workflow/readiness.ts";

import { putGateRun, putRoutineGateWorkflow } from "./support/readiness-fixture.ts";

describe("IT-AUTOMATION-01 / IT-GUARDRAIL-01", () => {
  it("evaluateAutomationReadiness never marks missing evidence as ready", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      upsertRow(db, {
        table: "workflow_runs",
        primaryKey: "workflow_run_id",
        row: {
          workflow_run_id: "workflow-1",
          plan_id: "PLAN-L7-48-readiness-guardrail",
          drive_run_id: "",
          workflow: "Forward",
          phase: "L7",
          ready_status: "pending",
          blocked_reason: "",
          human_required: 0,
          checked_at: "2026-06-11T00:00:00.000Z",
        },
      });

      const rows = evaluateAutomationReadiness(db);

      expect(rows).toContainEqual(
        expect.objectContaining({
          plan_id: "PLAN-L7-48-readiness-guardrail",
          ready_status: "blocked",
          blocked_reason: expect.stringContaining("missing evidence"),
        }),
      );
    } finally {
      db.close();
    }
  });

  describe("U-READY-GATE-01 routine-gate evidence", () => {
    it("unblocks only the routine-gate workflow mapped to its passed gate run", () => {
      const db = openHarnessDb(":memory:");
      try {
        migrate(db);
        const planId = "PLAN-L7-48-readiness-guardrail";
        const gateRunId = "gate-run-exact";
        const gateId = "G-L7.48";
        const workflowRunId = stableId("gate-workflow", gateRunId);
        putRoutineGateWorkflow(db, { workflowRunId, planId, gateId });
        putGateRun(db, { gateRunId, gateId, planId, status: "passed" });

        const result = evaluateAutomationReadiness(db);

        expect(result).toContainEqual(
          expect.objectContaining({
            workflow_run_id: workflowRunId,
            ready_status: "ready",
            blocked_reason: "",
          }),
        );
      } finally {
        db.close();
      }
    });

    it("allows a matching passed gate to unblock a workflow whose plan_id is empty", () => {
      const db = openHarnessDb(":memory:");
      try {
        migrate(db);
        const gateRunId = "gate-run-without-plan";
        const gateId = "G-GATE.01";
        const workflowRunId = stableId("gate-workflow", gateRunId);
        putRoutineGateWorkflow(db, { workflowRunId, planId: "", gateId });
        putGateRun(db, { gateRunId, gateId, planId: "", status: "passed" });

        const result = evaluateAutomationReadiness(db);

        expect(result).toContainEqual(
          expect.objectContaining({
            workflow_run_id: workflowRunId,
            ready_status: "ready",
            blocked_reason: "",
          }),
        );
      } finally {
        db.close();
      }
    });

    it("does not borrow a passed gate from another run with the same plan_id", () => {
      const db = openHarnessDb(":memory:");
      try {
        migrate(db);
        const planId = "PLAN-L7-48-readiness-guardrail";
        const gateId = "G-GATE.02";
        const workflowRunId = stableId("gate-workflow", "gate-run-required");
        putRoutineGateWorkflow(db, { workflowRunId, planId, gateId });
        putGateRun(db, {
          gateRunId: "gate-run-other",
          gateId,
          planId,
          status: "passed",
        });

        const result = evaluateAutomationReadiness(db);

        expect(result).toContainEqual(
          expect.objectContaining({
            workflow_run_id: workflowRunId,
            ready_status: "blocked",
          }),
        );
      } finally {
        db.close();
      }
    });

    it("does not borrow another run's passed gate when plan_id is empty", () => {
      const db = openHarnessDb(":memory:");
      try {
        migrate(db);
        const gateId = "G-GATE.02";
        const workflowRunId = stableId("gate-workflow", "gate-run-required-no-plan");
        putRoutineGateWorkflow(db, { workflowRunId, planId: "", gateId });
        putGateRun(db, {
          gateRunId: "gate-run-other-no-plan",
          gateId,
          planId: "",
          status: "passed",
        });

        const result = evaluateAutomationReadiness(db);

        expect(result).toContainEqual(
          expect.objectContaining({
            workflow_run_id: workflowRunId,
            ready_status: "blocked",
          }),
        );
      } finally {
        db.close();
      }
    });

    it("keeps a routine-gate workflow blocked when its mapped gate row is missing", () => {
      const db = openHarnessDb(":memory:");
      try {
        migrate(db);
        const planId = "PLAN-L7-48-readiness-guardrail";
        const gateRunId = "gate-run-missing";
        const workflowRunId = stableId("gate-workflow", gateRunId);
        putRoutineGateWorkflow(db, { workflowRunId, planId, gateId: "G-GATE.04" });

        const result = evaluateAutomationReadiness(db);

        expect(result).toContainEqual(
          expect.objectContaining({
            workflow_run_id: workflowRunId,
            ready_status: "blocked",
          }),
        );
      } finally {
        db.close();
      }
    });

    it("does not let another run's passed gate override a failed matching gate", () => {
      const db = openHarnessDb(":memory:");
      try {
        migrate(db);
        const planId = "PLAN-L7-48-readiness-guardrail";
        const gateId = "G-GATE.03";
        const gateRunId = "gate-run-failed";
        const workflowRunId = stableId("gate-workflow", gateRunId);
        putRoutineGateWorkflow(db, { workflowRunId, planId, gateId });
        putGateRun(db, { gateRunId, gateId, planId, status: "failed" });
        putGateRun(db, {
          gateRunId: "gate-run-other-passed",
          gateId,
          planId,
          status: "passed",
        });

        const result = evaluateAutomationReadiness(db);

        expect(result).toContainEqual(
          expect.objectContaining({
            workflow_run_id: workflowRunId,
            ready_status: "blocked",
          }),
        );
      } finally {
        db.close();
      }
    });

    it("does not let another run's passed gate override a failed gate when plan_id is empty", () => {
      const db = openHarnessDb(":memory:");
      try {
        migrate(db);
        const gateId = "G-GATE.03";
        const gateRunId = "gate-run-failed-no-plan";
        const workflowRunId = stableId("gate-workflow", gateRunId);
        putRoutineGateWorkflow(db, { workflowRunId, planId: "", gateId });
        putGateRun(db, { gateRunId, gateId, planId: "", status: "failed" });
        putGateRun(db, {
          gateRunId: "gate-run-other-passed-no-plan",
          gateId,
          planId: "",
          status: "passed",
        });

        const result = evaluateAutomationReadiness(db);

        expect(result).toContainEqual(
          expect.objectContaining({
            workflow_run_id: workflowRunId,
            ready_status: "blocked",
          }),
        );
      } finally {
        db.close();
      }
    });

    it("does not treat the A-132 historical seed row as passed evidence", () => {
      const db = openHarnessDb(":memory:");
      try {
        migrate(db);
        const planId = "";
        const gateId = "G-VERIFY.L8";
        const gateRunId = stableId("verification-band-gate", "L8");
        const workflowRunId = stableId("gate-workflow", gateRunId);
        putRoutineGateWorkflow(db, { workflowRunId, planId, gateId });
        putGateRun(db, {
          gateRunId,
          gateId,
          planId,
          status: "historical",
          evidencePath: ".ut-tdd/audit/A-132-l8-l14-verification-band-execution.md",
        });

        const result = evaluateAutomationReadiness(db);

        expect(result).toContainEqual(
          expect.objectContaining({
            workflow_run_id: workflowRunId,
            ready_status: "blocked",
          }),
        );
      } finally {
        db.close();
      }
    });
  });

  it("recordGuardrailDecision stores block decisions for self-review and missing human signoff", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);

      const selfReview = recordGuardrailDecision(db, {
        plan_id: "PLAN-L7-48-readiness-guardrail",
        session_id: "s1",
        guardrail: "review_evidence",
        decision: "allow",
        mode: "codex-only",
        reviewer_model: "gpt-5.4",
        worker_model: "gpt-5.4",
        evidence_path: ".ut-tdd/evidence/review.json",
      });
      const humanRequired = recordGuardrailDecision(db, {
        plan_id: "PLAN-L7-48-readiness-guardrail",
        session_id: "s1",
        guardrail: "pii_scope",
        decision: "human-required",
        mode: "codex-only",
        human_signoff_required: true,
        evidence_path: "",
      });

      expect(selfReview.decision).toBe("block");
      expect(humanRequired.decision).toBe("block");
      expect(rowCounts(db).guardrail_decisions).toBe(2);
    } finally {
      db.close();
    }
  });

  it("recordGuardrailDecision rejects secret-like evidence_path (sk-/ghp_/github_pat_/xox) and stores no row", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      // shared SECRET_PATTERN (single source of truth with projection-writer): all four token
      // families must be rejected, not just the sk- family. Tokens are assembled at runtime so the
      // literal secret prefixes never appear in committed source (secret-scan pre-commit hook).
      const body = "0123456789abcdefABCDEFGHIJ";
      const secrets = [
        `.ut-tdd/evidence/sk-${body}.json`,
        `.ut-tdd/evidence/ghp_${body}.json`,
        `.ut-tdd/evidence/github_pat_${body}.json`,
        `.ut-tdd/evidence/xoxb-${body}.json`,
      ];
      for (const evidence_path of secrets) {
        expect(() =>
          recordGuardrailDecision(db, {
            plan_id: "PLAN-L7-48-readiness-guardrail",
            session_id: "s1",
            guardrail: "review_evidence",
            decision: "allow",
            mode: "codex-only",
            evidence_path,
          }),
        ).toThrow(/secret/i);
      }
      expect(rowCounts(db).guardrail_decisions).toBe(0);
    } finally {
      db.close();
    }
  });
});
