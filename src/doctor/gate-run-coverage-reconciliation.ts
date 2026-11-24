import type { GateRunCoverageStats } from "../lint/gate-run-coverage.ts";
import { HARNESS_DB_TABLES, SCHEMA_VERSION } from "../schema/harness-db.ts";
import { stableId } from "../stable-id.ts";
import { defaultHarnessDbPath, type HarnessDb, openHarnessDb } from "../state-db/index.ts";
import { tableNames } from "../state-db/migration.ts";
import {
  collectGateRunEvidenceProjection,
  rebuildHarnessDb,
} from "../state-db/projection-writer.ts";
import { runSqliteTransaction } from "../state-db/sqlite-transaction.ts";

const A132_PATH = ".ut-tdd/audit/A-132-l8-l14-verification-band-execution.md";
const VERIFICATION_LAYERS = ["L8", "L9", "L10", "L11", "L12", "L13", "L14"] as const;

interface GateRunRow extends Record<string, unknown> {
  gate_run_id: string;
  gate_id: string;
  plan_id: string | null;
  status: string;
  checked_at: string;
  evidence_path: string;
}

interface RoutineGateRow extends Record<string, unknown> {
  workflow_run_id: string;
  plan_id: string | null;
  workflow: string;
  phase: string;
}

interface ReconciliationFailure {
  readonly orphanGateRuns: number;
  readonly workflowPlansWithoutGateRun: number;
  readonly invalidEvidenceFindings: number;
}

type GateRunProjection = ReturnType<typeof collectGateRunEvidenceProjection>;
type ProjectedWorkflowRow = GateRunProjection["workflowRuns"][number];

function bindWorkflowPlan(workflow: ProjectedWorkflowRow, planId: GateRunRow["plan_id"]) {
  return { ...workflow, plan_id: planId };
}

type ExpectedWorkflowRow = ReturnType<typeof bindWorkflowPlan>;

interface ReconciliationPlan {
  readonly addGateRows: GateRunRow[];
  readonly addWorkflowRows: ExpectedWorkflowRow[];
  readonly deleteGateIds: string[];
  readonly deleteWorkflowIds: string[];
  readonly matchedGateIds: Set<string>;
  readonly matchedWorkflowIds: Set<string>;
  orphanGateRuns: number;
}

class GateRunCoverageMismatch extends Error {
  readonly failure: ReconciliationFailure;

  constructor(failure: ReconciliationFailure) {
    super("gate-run-coverage evidence and projection mismatch");
    this.failure = failure;
  }
}

function failGateRunCoverage(
  orphanGateRuns = 0,
  workflowPlansWithoutGateRun = 0,
  invalidEvidenceFindings = 0,
): never {
  throw new GateRunCoverageMismatch({
    orphanGateRuns,
    workflowPlansWithoutGateRun,
    invalidEvidenceFindings,
  });
}

function planValue(value: string | null): string {
  return value ?? "";
}

function sameGateRun(left: GateRunRow, right: GateRunRow, legacyPlanId?: string): boolean {
  const storedPlan = planValue(left.plan_id);
  return (
    left.gate_run_id === right.gate_run_id &&
    left.gate_id === right.gate_id &&
    (!storedPlan || storedPlan === legacyPlanId) &&
    left.status === right.status &&
    left.checked_at === right.checked_at &&
    left.evidence_path === right.evidence_path
  );
}

function sameSeed(left: GateRunRow, right: GateRunRow): boolean {
  return (
    left.gate_run_id === right.gate_run_id &&
    left.gate_id === right.gate_id &&
    planValue(left.plan_id) === "" &&
    left.status === "historical" &&
    left.evidence_path === A132_PATH
  );
}

function isSeedLike(row: GateRunRow): boolean {
  return (
    row.evidence_path === A132_PATH ||
    row.status === "historical" ||
    row.gate_id.startsWith("G-VERIFY.")
  );
}

function expectedSeedRows(
  rows: ReturnType<typeof collectGateRunEvidenceProjection>["gateRuns"],
): GateRunRow[] {
  const seeds = rows.filter(isSeedLike);
  const expected = new Map(
    VERIFICATION_LAYERS.map((layer) => [
      stableId("verification-band-gate", layer),
      {
        gate_run_id: stableId("verification-band-gate", layer),
        gate_id: `G-VERIFY.${layer}`,
        plan_id: null,
        status: "historical",
        checked_at: "",
        evidence_path: A132_PATH,
      } satisfies GateRunRow,
    ]),
  );
  if (seeds.length === 0) return [];
  if (seeds.length !== VERIFICATION_LAYERS.length) {
    failGateRunCoverage(0, 0, 1);
  }
  for (const seed of seeds) {
    const canonical = expected.get(seed.gate_run_id);
    if (!canonical || !sameGateRun(seed, canonical)) {
      failGateRunCoverage(0, 0, 1);
    }
    expected.delete(seed.gate_run_id);
  }
  if (expected.size > 0) {
    failGateRunCoverage(0, 0, 1);
  }
  return seeds;
}

function readGateRuns(db: HarnessDb): GateRunRow[] {
  return db
    .prepare(
      "SELECT gate_run_id, gate_id, plan_id, status, checked_at, evidence_path FROM gate_runs",
    )
    .all() as GateRunRow[];
}

function readRoutineGateRows(db: HarnessDb): RoutineGateRow[] {
  return db
    .prepare(
      "SELECT workflow_run_id, plan_id, workflow, phase FROM workflow_runs WHERE workflow = 'routine-gate'",
    )
    .all() as RoutineGateRow[];
}

function count(db: HarnessDb, sql: string): number {
  const row = db.prepare(sql).get() as { value?: number } | undefined;
  return Number(row?.value ?? 0);
}

function currentStats(
  db: HarnessDb,
  failure: ReconciliationFailure = {
    orphanGateRuns: 0,
    workflowPlansWithoutGateRun: 0,
    invalidEvidenceFindings: 0,
  },
): GateRunCoverageStats {
  return {
    gateRuns: count(db, "SELECT COUNT(*) AS value FROM gate_runs"),
    workflowRuns: count(db, "SELECT COUNT(*) AS value FROM workflow_runs"),
    workflowPlansWithoutGateRun: failure.workflowPlansWithoutGateRun,
    orphanGateRuns: failure.orphanGateRuns,
    blankPlanGateRuns: count(
      db,
      "SELECT COUNT(*) AS value FROM gate_runs WHERE COALESCE(plan_id, '') = ''",
    ),
    invalidEvidenceFindings: failure.invalidEvidenceFindings,
  };
}

function verifyWorkflowPair(
  gate: GateRunRow,
  workflow: RoutineGateRow | undefined,
  expectedWorkflowId: string,
): boolean {
  return Boolean(
    workflow &&
      workflow.workflow_run_id === expectedWorkflowId &&
      workflow.workflow === "routine-gate" &&
      workflow.phase === gate.gate_id &&
      planValue(workflow.plan_id) === planValue(gate.plan_id),
  );
}

function insertGateRun(db: HarnessDb, row: GateRunRow): void {
  db.prepare(
    "INSERT INTO gate_runs (gate_run_id, gate_id, plan_id, status, checked_at, evidence_path) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(row.gate_run_id, row.gate_id, row.plan_id, row.status, row.checked_at, row.evidence_path);
}

function insertRoutineGate(db: HarnessDb, row: ExpectedWorkflowRow): void {
  db.prepare(
    "INSERT INTO workflow_runs (workflow_run_id, plan_id, drive_run_id, workflow, phase, ready_status, blocked_reason, human_required, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    row.workflow_run_id,
    row.plan_id,
    row.drive_run_id,
    row.workflow,
    row.phase,
    row.ready_status,
    row.blocked_reason,
    row.human_required,
    row.checked_at,
  );
}

function matchSeedRows(input: {
  existingGateRows: GateRunRow[];
  seedsById: Map<string, GateRunRow>;
  plan: ReconciliationPlan;
}): void {
  for (const row of input.existingGateRows) {
    if (!isSeedLike(row)) continue;
    const canonical = input.seedsById.get(row.gate_run_id);
    if (!canonical || !sameSeed(row, canonical)) failGateRunCoverage(0, 0, 1);
    input.plan.matchedGateIds.add(row.gate_run_id);
  }
  for (const seed of input.seedsById.values()) {
    if (!input.plan.matchedGateIds.has(seed.gate_run_id)) {
      input.plan.addGateRows.push(seed);
    }
  }
}

function matchEvidenceRows(input: {
  projection: GateRunProjection;
  sourceRows: GateRunRow[];
  existingGateRows: GateRunRow[];
  workflowById: Map<string, RoutineGateRow>;
  plan: ReconciliationPlan;
}): void {
  for (const expected of input.sourceRows) {
    const candidates = input.existingGateRows.filter(
      (row) =>
        row.gate_run_id === expected.gate_run_id || row.evidence_path === expected.evidence_path,
    );
    if (candidates.length > 1) {
      input.plan.orphanGateRuns += 1;
      continue;
    }
    const existingGate = candidates[0];
    const projectedWorkflow = input.projection.workflowRuns.find(
      (row) => row.gate_run_id === expected.gate_run_id,
    );
    const expectedWorkflow = projectedWorkflow
      ? bindWorkflowPlan(projectedWorkflow, expected.plan_id)
      : undefined;
    if (!isExpectedWorkflow(expected, expectedWorkflow)) {
      input.plan.orphanGateRuns += 1;
      continue;
    }
    matchEvidencePair({
      expected,
      legacyPlanId: input.projection.legacyPlanIds.get(expected.gate_run_id),
      existingGate,
      expectedWorkflow,
      workflowById: input.workflowById,
      plan: input.plan,
    });
  }
}

function isExpectedWorkflow(
  expected: GateRunRow,
  workflow: ExpectedWorkflowRow | undefined,
): workflow is ExpectedWorkflowRow {
  return Boolean(
    workflow &&
      workflow.workflow_run_id === stableId("gate-workflow", expected.gate_run_id) &&
      workflow.phase === expected.gate_id &&
      planValue(workflow.plan_id) === planValue(expected.plan_id),
  );
}

function matchEvidencePair(input: {
  expected: GateRunRow;
  legacyPlanId: string | undefined;
  existingGate: GateRunRow | undefined;
  expectedWorkflow: ExpectedWorkflowRow;
  workflowById: Map<string, RoutineGateRow>;
  plan: ReconciliationPlan;
}): void {
  const existingWorkflow = input.workflowById.get(input.expectedWorkflow.workflow_run_id);
  if (!input.existingGate && !existingWorkflow) {
    input.plan.addGateRows.push(input.expected);
    input.plan.addWorkflowRows.push(input.expectedWorkflow);
    return;
  }
  if (!input.existingGate || !sameGateRun(input.existingGate, input.expected, input.legacyPlanId)) {
    input.plan.orphanGateRuns += 1;
    return;
  }
  input.plan.matchedGateIds.add(input.existingGate.gate_run_id);
  if (
    !verifyWorkflowPair(
      input.existingGate,
      existingWorkflow,
      input.expectedWorkflow.workflow_run_id,
    )
  ) {
    input.plan.orphanGateRuns += 1;
    return;
  }
  input.plan.matchedWorkflowIds.add(input.expectedWorkflow.workflow_run_id);
}

function excludeDatabaseOnlyRows(input: {
  existingGateRows: GateRunRow[];
  workflowById: Map<string, RoutineGateRow>;
  plan: ReconciliationPlan;
}): void {
  for (const row of input.existingGateRows) {
    if (input.plan.matchedGateIds.has(row.gate_run_id) || isSeedLike(row)) continue;
    const expectedWorkflowId = stableId("gate-workflow", row.gate_run_id);
    const workflow = input.workflowById.get(expectedWorkflowId);
    if (workflow && !verifyWorkflowPair(row, workflow, expectedWorkflowId)) {
      input.plan.orphanGateRuns += 1;
      continue;
    }
    input.plan.deleteGateIds.push(row.gate_run_id);
    if (workflow) {
      input.plan.deleteWorkflowIds.push(workflow.workflow_run_id);
      input.plan.matchedWorkflowIds.add(workflow.workflow_run_id);
    }
  }
}

function validateMatches(input: {
  existingWorkflowRows: RoutineGateRow[];
  plan: ReconciliationPlan;
}): void {
  const unmatchedWorkflows = input.existingWorkflowRows.filter(
    (row) => !input.plan.matchedWorkflowIds.has(row.workflow_run_id),
  ).length;
  if (input.plan.orphanGateRuns > 0 || unmatchedWorkflows > 0) {
    failGateRunCoverage(input.plan.orphanGateRuns, unmatchedWorkflows, 0);
  }
}

function applyReconciliation(db: HarnessDb, plan: ReconciliationPlan): void {
  for (const workflowRunId of plan.deleteWorkflowIds) {
    db.prepare(
      "DELETE FROM workflow_runs WHERE workflow_run_id = ? AND workflow = 'routine-gate'",
    ).run(workflowRunId);
  }
  for (const gateRunId of plan.deleteGateIds) {
    db.prepare("DELETE FROM gate_runs WHERE gate_run_id = ?").run(gateRunId);
  }
  for (const row of plan.addGateRows) insertGateRun(db, row);
  for (const row of plan.addWorkflowRows) insertRoutineGate(db, row);
}

function reconcile(db: HarnessDb, repoRoot: string): GateRunCoverageStats {
  const projection = collectGateRunEvidenceProjection(repoRoot);
  if (projection.findings.length > 0) {
    failGateRunCoverage(0, 0, projection.findings.length);
  }

  const seeds = expectedSeedRows(projection.gateRuns);
  const sourceRows = projection.gateRuns.filter((row) => !isSeedLike(row));
  const existingGateRows = readGateRuns(db);
  const existingWorkflowRows = readRoutineGateRows(db);
  const workflowById = new Map(existingWorkflowRows.map((row) => [row.workflow_run_id, row]));
  const plan: ReconciliationPlan = {
    addGateRows: [],
    addWorkflowRows: [],
    deleteGateIds: [],
    deleteWorkflowIds: [],
    matchedGateIds: new Set(),
    matchedWorkflowIds: new Set(),
    orphanGateRuns: 0,
  };

  if (existingGateRows.some((row) => !row.gate_id.trim())) failGateRunCoverage(1);
  matchSeedRows({
    existingGateRows,
    seedsById: new Map(seeds.map((row) => [row.gate_run_id, row])),
    plan,
  });
  matchEvidenceRows({ projection, sourceRows, existingGateRows, workflowById, plan });
  excludeDatabaseOnlyRows({ existingGateRows, workflowById, plan });
  validateMatches({ existingWorkflowRows, plan });
  applyReconciliation(db, plan);

  return currentStats(db);
}

export function loadGateRunCoverageStats(repoRoot: string): GateRunCoverageStats {
  const dbPath = defaultHarnessDbPath(repoRoot);
  const db = openHarnessDb(dbPath, { repoRoot });
  let uninitialized = false;
  try {
    try {
      return runSqliteTransaction(db, () => {
        const names = new Set(tableNames(db).filter((name) => !name.startsWith("sqlite_")));
        const userVersion = db.userVersion();
        uninitialized = userVersion === 0 && names.size === 0;
        const schemaOnly =
          userVersion === SCHEMA_VERSION &&
          HARNESS_DB_TABLES.every((table) => names.has(table.name)) &&
          !HARNESS_DB_TABLES.some(
            (table) => db.prepare(`SELECT 1 FROM ${table.name} LIMIT 1`).get() !== undefined,
          );

        if (uninitialized || schemaOnly) {
          rebuildHarnessDb({ repoRoot, db, skipTokenTelemetry: true });
        }
        return reconcile(db, repoRoot);
      });
    } catch (error) {
      if (!(error instanceof GateRunCoverageMismatch)) throw error;
      if (uninitialized) {
        return { gateRuns: 0, workflowRuns: 0, blankPlanGateRuns: 0, ...error.failure };
      }
      return currentStats(db, error.failure);
    }
  } finally {
    db.close();
  }
}
