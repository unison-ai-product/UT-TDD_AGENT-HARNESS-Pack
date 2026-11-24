import { stableId } from "../stable-id.ts";
import type { HarnessDb } from "../state-db/index.ts";
import { upsertRow } from "../state-db/index.ts";

export interface AutomationReadinessRow {
  workflow_run_id: string;
  plan_id: string;
  workflow: string;
  phase: string;
  ready_status: "ready" | "blocked" | "human-required";
  blocked_reason: string;
  human_required: number;
  checked_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function hasMatchingPassedRoutineGate(
  db: HarnessDb,
  workflowRow: Record<string, unknown>,
): boolean {
  const workflowRunId = String(workflowRow.workflow_run_id ?? "");
  const phase = String(workflowRow.phase ?? "");
  const rows = db.prepare("SELECT gate_run_id, gate_id, status FROM gate_runs").all();
  return rows.some((gate) => {
    const gateRunId = String(gate.gate_run_id ?? "");
    return (
      gateRunId !== "" &&
      stableId("gate-workflow", gateRunId) === workflowRunId &&
      String(gate.gate_id ?? "") === phase &&
      String(gate.status ?? "") === "passed"
    );
  });
}

export function evaluateAutomationReadiness(db: HarnessDb): AutomationReadinessRow[] {
  const rows = db.prepare("SELECT * FROM workflow_runs ORDER BY workflow_run_id").all();
  const checkedAt = nowIso();
  const results: AutomationReadinessRow[] = [];
  for (const row of rows) {
    const planId = String(row.plan_id ?? "");
    const hasGateEvidence =
      String(row.workflow ?? "") === "routine-gate" && hasMatchingPassedRoutineGate(db, row);
    const readyStatus: AutomationReadinessRow["ready_status"] = hasGateEvidence
      ? "ready"
      : "blocked";
    const blockedReason = hasGateEvidence
      ? ""
      : "missing evidence: passed gate evidence is required";
    const humanRequired = 0;
    const result: AutomationReadinessRow = {
      workflow_run_id: String(row.workflow_run_id ?? ""),
      plan_id: planId,
      workflow: String(row.workflow ?? ""),
      phase: String(row.phase ?? ""),
      ready_status: readyStatus,
      blocked_reason: blockedReason,
      human_required: humanRequired,
      checked_at: checkedAt,
    };
    upsertRow(db, {
      table: "workflow_runs",
      primaryKey: "workflow_run_id",
      row: {
        ...row,
        ready_status: result.ready_status,
        blocked_reason: result.blocked_reason,
        human_required: result.human_required,
        checked_at: result.checked_at,
      },
    });
    results.push(result);
  }
  return results;
}
