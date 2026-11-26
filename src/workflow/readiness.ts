import { stableId } from "../stable-id.ts";
import { type HarnessDb, upsertRow } from "../state-db/index.ts";
import { runSqliteTransaction } from "../state-db/sqlite-transaction.ts";

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

function passedRoutineGateIndex(db: HarnessDb): Map<string, Set<string>> {
  const rows = db.prepare("SELECT gate_run_id, gate_id, status FROM gate_runs").all();
  const gateIdsByWorkflow = new Map<string, Set<string>>();
  for (const gate of rows) {
    const gateRunId = String(gate.gate_run_id ?? "");
    if (gateRunId === "" || String(gate.status ?? "") !== "passed") continue;
    const workflowRunId = stableId("gate-workflow", gateRunId);
    const gateId = String(gate.gate_id ?? "");
    let gateIds = gateIdsByWorkflow.get(workflowRunId);
    if (!gateIds) {
      gateIds = new Set<string>();
      gateIdsByWorkflow.set(workflowRunId, gateIds);
    }
    gateIds.add(gateId);
  }
  return gateIdsByWorkflow;
}

export function evaluateAutomationReadiness(db: HarnessDb): AutomationReadinessRow[] {
  return runSqliteTransaction(db, () => {
    const rows = db.prepare("SELECT * FROM workflow_runs ORDER BY workflow_run_id").all();
    const hasRoutineWorkflow = rows.some((row) => String(row.workflow ?? "") === "routine-gate");
    const gateIdsByWorkflow = hasRoutineWorkflow ? passedRoutineGateIndex(db) : undefined;
    const checkedAt = nowIso();
    const results: AutomationReadinessRow[] = [];
    for (const row of rows) {
      const workflowRunId = String(row.workflow_run_id ?? "");
      const workflow = String(row.workflow ?? "");
      const phase = String(row.phase ?? "");
      const planId = String(row.plan_id ?? "");
      const hasGateEvidence =
        workflow === "routine-gate" && gateIdsByWorkflow?.get(workflowRunId)?.has(phase) === true;
      const readyStatus: AutomationReadinessRow["ready_status"] = hasGateEvidence
        ? "ready"
        : "blocked";
      const blockedReason = hasGateEvidence
        ? ""
        : "missing evidence: passed gate evidence is required";
      const humanRequired = 0;
      const result: AutomationReadinessRow = {
        workflow_run_id: workflowRunId,
        plan_id: planId,
        workflow,
        phase,
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
  });
}
