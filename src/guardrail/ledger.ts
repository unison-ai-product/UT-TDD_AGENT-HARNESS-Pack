import {
  type GuardrailDecisionInput,
  type GuardrailDecisionValue,
  inspectGuardrailInvariants,
} from "../state-db/guardrail-invariants";
import type { HarnessDb } from "../state-db/index";
import { upsertRow } from "../state-db/index";

// The invariant logic + decision types live in state-db (single source of truth,
// shared with the projection advisory path) to avoid a guardrail <-> state-db
// module cycle. Re-exported here so existing guardrail/ledger consumers and
// tests keep their import path.
export type {
  GuardrailDecisionInput,
  GuardrailDecisionValue,
  GuardrailInvariantInspection,
  GuardrailInvariantRule,
  GuardrailInvariantViolation,
} from "../state-db/guardrail-invariants";
export { inspectGuardrailInvariants } from "../state-db/guardrail-invariants";

export interface GuardrailDecisionRow {
  guardrail_decision_id: string;
  plan_id: string;
  session_id: string;
  guardrail: string;
  decision: GuardrailDecisionValue;
  mode: string;
  human_signoff_required: number;
  evidence_path: string;
  decided_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function decisionId(input: GuardrailDecisionInput): string {
  return `${input.plan_id}:${input.session_id}:${input.guardrail}`.replace(
    /[^A-Za-z0-9._:-]+/g,
    "-",
  );
}

export function recordGuardrailDecision(
  db: HarnessDb,
  input: GuardrailDecisionInput,
): GuardrailDecisionRow {
  const inspection = inspectGuardrailInvariants(input);
  if (inspection.violations.some((violation) => violation.rule === "secret-evidence")) {
    throw new Error("guardrail evidence_path must not contain secret-like values");
  }
  const decision = inspection.normalizedDecision;
  const row: GuardrailDecisionRow = {
    guardrail_decision_id: decisionId(input),
    plan_id: input.plan_id,
    session_id: input.session_id,
    guardrail: input.guardrail,
    decision,
    mode: input.mode,
    human_signoff_required: input.human_signoff_required || decision === "human-required" ? 1 : 0,
    evidence_path: input.evidence_path,
    decided_at: nowIso(),
  };
  upsertRow(db, {
    table: "guardrail_decisions",
    primaryKey: "guardrail_decision_id",
    row: { ...row },
  });
  if (decision === "block") {
    upsertRow(db, {
      table: "findings",
      primaryKey: "finding_id",
      row: {
        finding_id: `finding:guardrail:${row.guardrail_decision_id}`,
        kind: "guardrail-block",
        severity: "warn",
        subject_id: input.plan_id,
        source: "guardrail-ledger",
        status: "open",
        evidence_path: input.evidence_path,
      },
    });
  }
  return row;
}
