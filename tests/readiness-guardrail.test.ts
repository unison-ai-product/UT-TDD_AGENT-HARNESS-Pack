import { describe, expect, it } from "vitest";
import { recordGuardrailDecision } from "../src/guardrail/ledger";
import { openHarnessDb, upsertRow } from "../src/state-db/index";
import { migrate, rowCounts } from "../src/state-db/migration";
import { evaluateAutomationReadiness } from "../src/workflow/readiness";

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

  it("human-required guardrail elevates the workflow_run and survives re-evaluation", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      upsertRow(db, {
        table: "workflow_runs",
        primaryKey: "workflow_run_id",
        row: {
          workflow_run_id: "workflow-hr",
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
      // a human-required guardrail decision must dominate any blocked/missing-evidence state
      recordGuardrailDecision(db, {
        plan_id: "PLAN-L7-48-readiness-guardrail",
        session_id: "s1",
        guardrail: "human_signoff",
        decision: "human-required",
        mode: "codex-only",
        human_signoff_required: true,
        evidence_path: ".ut-tdd/evidence/signoff.json",
      });

      const first = evaluateAutomationReadiness(db);
      expect(first).toContainEqual(
        expect.objectContaining({
          workflow_run_id: "workflow-hr",
          ready_status: "human-required",
          human_required: 1,
        }),
      );

      // re-evaluation (idempotent projection / DB rebuild) must NOT downgrade human-required
      const second = evaluateAutomationReadiness(db);
      expect(second).toContainEqual(
        expect.objectContaining({
          workflow_run_id: "workflow-hr",
          ready_status: "human-required",
          human_required: 1,
        }),
      );
      const persisted = db
        .prepare("SELECT human_required FROM workflow_runs WHERE workflow_run_id = 'workflow-hr'")
        .get() as { human_required?: number } | undefined;
      expect(Number(persisted?.human_required ?? 0)).toBe(1);
    } finally {
      db.close();
    }
  });
});
