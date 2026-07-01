import type { HarnessDb } from "../state-db/index";
import { upsertRow } from "../state-db/index";

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

function openFindingCount(db: HarnessDb, planId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM findings WHERE status = 'open' AND subject_id LIKE ?")
    .get(`%${planId}%`);
  return Number(row?.n ?? 0);
}

function passedGateCount(db: HarnessDb, planId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM gate_runs WHERE plan_id = ? AND status = 'passed'")
    .get(planId);
  return Number(row?.n ?? 0);
}

function humanBlockCount(db: HarnessDb, planId: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM guardrail_decisions WHERE plan_id = ? AND (decision = 'human-required' OR decision = 'block' OR human_signoff_required = 1)",
    )
    .get(planId);
  return Number(row?.n ?? 0);
}

export function evaluateAutomationReadiness(db: HarnessDb): AutomationReadinessRow[] {
  const rows = db.prepare("SELECT * FROM workflow_runs ORDER BY workflow_run_id").all();
  const checkedAt = nowIso();
  const results: AutomationReadinessRow[] = [];
  for (const row of rows) {
    const planId = String(row.plan_id ?? "");
    const openFindings = planId ? openFindingCount(db, planId) : 0;
    const gates = planId ? passedGateCount(db, planId) : 0;
    const humanBlocks = planId ? humanBlockCount(db, planId) : 0;
    let readyStatus: AutomationReadinessRow["ready_status"] = "ready";
    let blockedReason = "";
    let humanRequired = 0;
    if (!planId || gates === 0) {
      readyStatus = "blocked";
      blockedReason = "missing evidence: passed gate evidence is required";
    }
    if (openFindings > 0) {
      readyStatus = "blocked";
      blockedReason = `open findings: ${openFindings}`;
    }
    if (humanBlocks > 0) {
      readyStatus = "human-required";
      blockedReason = `human-required guardrail decisions: ${humanBlocks}`;
      humanRequired = 1;
    }
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
