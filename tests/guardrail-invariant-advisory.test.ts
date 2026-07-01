import { describe, expect, it } from "vitest";
import { inspectGuardrailInvariants } from "../src/guardrail/ledger";
import { openHarnessDb, upsertRow } from "../src/state-db/index";
import { migrate } from "../src/state-db/migration";
import { projectGuardrailInvariantAdvisories } from "../src/state-db/projection-writer";
import { evaluateAutomationReadiness } from "../src/workflow/readiness";

// PLAN-L7-52 C-1 (option C): the guardrail invariant SSoT is consulted against
// committed review evidence at CLI-rebuild time (non-API), surfacing violations
// as warn-first / non-blocking advisories. The fail-close write path
// (recordGuardrailDecision) is covered by readiness-guardrail.test.ts.

function reviewEvidenceRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    review_evidence_id: "",
    plan_id: "",
    kind: "impl",
    status: "confirmed",
    has_evidence: 1,
    review_kind: "cross",
    verdict: "approve",
    reviewed_at: "2026-06-15T00:00:00.000Z",
    tests_green_at: "2026-06-15T00:00:00.000Z",
    worker_model: "",
    reviewer_model: "",
    source: "docs/plans/PLAN.md",
    indexed_at: "2026-06-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("IT-GUARDRAIL-ADVISORY-01: projection-based invariant advisories", () => {
  it("inspectGuardrailInvariants is the SSoT — flags self-review, secret, human-required; ignores blank models", () => {
    const sameModel = inspectGuardrailInvariants({
      plan_id: "P",
      session_id: "",
      guardrail: "review-self-review",
      decision: "allow",
      mode: "review",
      evidence_path: "docs/plans/P.md",
      reviewer_model: "claude-opus-4-8",
      worker_model: "claude-opus-4-8",
    });
    expect(sameModel.violations.map((v) => v.rule)).toContain("same-model-self-review");
    expect(sameModel.normalizedDecision).toBe("block");

    const crossModel = inspectGuardrailInvariants({
      plan_id: "P",
      session_id: "",
      guardrail: "review-self-review",
      decision: "allow",
      mode: "review",
      evidence_path: "docs/plans/P.md",
      reviewer_model: "gpt-5.4",
      worker_model: "claude-opus-4-8",
    });
    expect(crossModel.violations).toHaveLength(0);

    const sameProvider = inspectGuardrailInvariants({
      plan_id: "P",
      session_id: "",
      guardrail: "review-self-review",
      decision: "allow",
      mode: "review",
      evidence_path: "docs/plans/P.md",
      reviewer_model: "claude-sonnet-4-6",
      worker_model: "claude-opus-4-8",
    });
    expect(sameProvider.violations.map((v) => v.rule)).toContain("same-provider-cross-review");
    expect(sameProvider.normalizedDecision).toBe("block");

    // blank model strings must NOT be read as "same model" — passed as undefined upstream.
    const blank = inspectGuardrailInvariants({
      plan_id: "P",
      session_id: "",
      guardrail: "review-self-review",
      decision: "allow",
      mode: "review",
      evidence_path: "docs/plans/P.md",
    });
    expect(blank.violations).toHaveLength(0);

    const humanRequired = inspectGuardrailInvariants({
      plan_id: "P",
      session_id: "",
      guardrail: "pii_scope",
      decision: "human-required",
      mode: "review",
      evidence_path: "",
    });
    expect(humanRequired.violations.map((v) => v.rule)).toContain(
      "human-required-without-evidence",
    );
  });

  it("projects advisory findings for same-model and same-provider review evidence", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      // same-model on a cross_agent review IS a real defect: it claims cross-runtime
      // independence yet the reviewer is the SAME model -> advisory fires.
      upsertRow(db, {
        table: "review_evidence_registry",
        primaryKey: "review_evidence_id",
        row: reviewEvidenceRow({
          review_evidence_id: "review-evidence:PLAN-SAME-MODEL-CROSS",
          plan_id: "PLAN-SAME-MODEL-CROSS",
          review_kind: "cross_agent",
          worker_model: "claude-opus-4-8",
          reviewer_model: "claude-opus-4-8",
          source: "docs/plans/PLAN-SAME-MODEL-CROSS.md",
        }),
      });
      // same-model on an intra_runtime_subagent review is the design-sanctioned Tier ②
      // substitute (concept §2.1.2.1, same model by definition) -> advisory suppressed.
      upsertRow(db, {
        table: "review_evidence_registry",
        primaryKey: "review_evidence_id",
        row: reviewEvidenceRow({
          review_evidence_id: "review-evidence:PLAN-SAME-MODEL-INTRA",
          plan_id: "PLAN-SAME-MODEL-INTRA",
          review_kind: "intra_runtime_subagent",
          worker_model: "claude-opus-4-8",
          reviewer_model: "claude-opus-4-8",
          source: "docs/plans/PLAN-SAME-MODEL-INTRA.md",
        }),
      });
      // same-provider on a cross_agent review IS a real defect (claims cross-runtime
      // independence yet shares a provider) -> advisory fires.
      upsertRow(db, {
        table: "review_evidence_registry",
        primaryKey: "review_evidence_id",
        row: reviewEvidenceRow({
          review_evidence_id: "review-evidence:PLAN-SAME-PROVIDER-B",
          plan_id: "PLAN-SAME-PROVIDER-B",
          review_kind: "cross_agent",
          worker_model: "claude-opus-4-8",
          reviewer_model: "claude-sonnet-4-6",
          source: "docs/plans/PLAN-SAME-PROVIDER-B.md",
        }),
      });
      // same-provider on an intra_runtime_subagent review is STRUCTURALLY FORCED
      // (single runtime) -> advisory is suppressed (PLAN-L7-143 projection-gate parity).
      upsertRow(db, {
        table: "review_evidence_registry",
        primaryKey: "review_evidence_id",
        row: reviewEvidenceRow({
          review_evidence_id: "review-evidence:PLAN-SAME-PROVIDER-INTRA",
          plan_id: "PLAN-SAME-PROVIDER-INTRA",
          review_kind: "intra_runtime_subagent",
          worker_model: "claude-opus-4-8",
          reviewer_model: "claude-sonnet-4-6",
          source: "docs/plans/PLAN-SAME-PROVIDER-INTRA.md",
        }),
      });
      upsertRow(db, {
        table: "review_evidence_registry",
        primaryKey: "review_evidence_id",
        row: reviewEvidenceRow({
          review_evidence_id: "review-evidence:PLAN-CROSS-B",
          plan_id: "PLAN-CROSS-B",
          review_kind: "cross_agent",
          worker_model: "claude-opus-4-8",
          reviewer_model: "gpt-5.4",
        }),
      });
      upsertRow(db, {
        table: "review_evidence_registry",
        primaryKey: "review_evidence_id",
        row: reviewEvidenceRow({
          review_evidence_id: "review-evidence:PLAN-BLANK-C",
          plan_id: "PLAN-BLANK-C",
        }),
      });

      projectGuardrailInvariantAdvisories(db);

      const findings = db
        .prepare(
          "SELECT kind, subject_id, source, evidence_path FROM findings WHERE status = 'open'",
        )
        .all() as Array<{
        kind: string;
        subject_id: string;
        source: string;
        evidence_path: string;
      }>;

      const advisories = findings.filter((f) => f.source === "guardrail-invariant-advisory");
      // only the cross_agent same-model + cross_agent same-provider fire; both
      // intra_runtime_subagent reviews are suppressed (design-sanctioned Tier ②).
      expect(advisories).toHaveLength(2);
      expect(advisories.map((a) => a.kind)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("same-model-self-review"),
          expect.stringContaining("same-provider-cross-review"),
        ]),
      );
      // traceability lives in evidence_path (readiness does not scan it)...
      expect(advisories.map((a) => a.evidence_path)).toEqual(
        expect.arrayContaining([
          "docs/plans/PLAN-SAME-MODEL-CROSS.md",
          "docs/plans/PLAN-SAME-PROVIDER-B.md",
        ]),
      );
      // ...and neither intra_runtime_subagent review surfaces an advisory
      // (same-model / same-provider in Tier ② are design-sanctioned, not defects).
      expect(advisories.map((a) => a.evidence_path)).not.toContain(
        "docs/plans/PLAN-SAME-MODEL-INTRA.md",
      );
      expect(advisories.map((a) => a.evidence_path)).not.toContain(
        "docs/plans/PLAN-SAME-PROVIDER-INTRA.md",
      );
      // ...while subject_id is plan-id-free so it cannot flip automation readiness.
      for (const finding of findings) {
        expect(finding.subject_id).not.toContain("PLAN-SAME-MODEL-CROSS");
      }
    } finally {
      db.close();
    }
  });

  it("is non-blocking: a self-review advisory does NOT flip a ready workflow_run to blocked", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      upsertRow(db, {
        table: "workflow_runs",
        primaryKey: "workflow_run_id",
        row: {
          workflow_run_id: "wf-advisory",
          plan_id: "PLAN-SELF-REVIEW-A",
          drive_run_id: "",
          workflow: "Forward",
          phase: "L7",
          ready_status: "pending",
          blocked_reason: "",
          human_required: 0,
          checked_at: "2026-06-15T00:00:00.000Z",
        },
      });
      upsertRow(db, {
        table: "gate_runs",
        primaryKey: "gate_run_id",
        row: {
          gate_run_id: "gate-advisory",
          gate_id: "G-L7",
          plan_id: "PLAN-SELF-REVIEW-A",
          status: "passed",
          checked_at: "2026-06-15T00:00:00.000Z",
          evidence_path: "docs/plans/PLAN-SELF-REVIEW-A.md",
        },
      });
      upsertRow(db, {
        table: "review_evidence_registry",
        primaryKey: "review_evidence_id",
        row: reviewEvidenceRow({
          review_evidence_id: "review-evidence:PLAN-SELF-REVIEW-A",
          plan_id: "PLAN-SELF-REVIEW-A",
          review_kind: "cross_agent",
          worker_model: "claude-opus-4-8",
          reviewer_model: "claude-opus-4-8",
          source: "docs/plans/PLAN-SELF-REVIEW-A.md",
        }),
      });

      const baseline = evaluateAutomationReadiness(db);
      expect(baseline).toContainEqual(
        expect.objectContaining({ workflow_run_id: "wf-advisory", ready_status: "ready" }),
      );

      projectGuardrailInvariantAdvisories(db);

      const afterAdvisory = evaluateAutomationReadiness(db);
      expect(afterAdvisory).toContainEqual(
        expect.objectContaining({ workflow_run_id: "wf-advisory", ready_status: "ready" }),
      );
    } finally {
      db.close();
    }
  });
});
