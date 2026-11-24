import { type HarnessDb, upsertRow } from "../../src/state-db/index.ts";

export function putRoutineGateWorkflow(
  db: HarnessDb,
  input: { workflowRunId: string; planId: string; gateId: string },
): void {
  upsertRow(db, {
    table: "workflow_runs",
    primaryKey: "workflow_run_id",
    row: {
      workflow_run_id: input.workflowRunId,
      plan_id: input.planId,
      drive_run_id: "",
      workflow: "routine-gate",
      phase: input.gateId,
      ready_status: "pending",
      blocked_reason: "",
      human_required: 0,
      checked_at: "2026-10-27T00:00:00.000Z",
    },
  });
}

export function putGateRun(
  db: HarnessDb,
  input: {
    gateRunId: string;
    gateId: string;
    planId: string;
    status: "passed" | "failed" | "historical";
    evidencePath?: string;
  },
): void {
  upsertRow(db, {
    table: "gate_runs",
    primaryKey: "gate_run_id",
    row: {
      gate_run_id: input.gateRunId,
      gate_id: input.gateId,
      plan_id: input.planId,
      status: input.status,
      checked_at: "2026-10-27T00:00:00.000Z",
      evidence_path: input.evidencePath ?? "",
    },
  });
}
