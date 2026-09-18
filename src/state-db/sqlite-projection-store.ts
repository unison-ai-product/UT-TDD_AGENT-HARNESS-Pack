import type {
  ModelEvaluationReadPort,
  OperationalMetricsReadPort,
  ProjectionEvent,
  ProjectionStore,
} from "../projection/contracts/projection-store.ts";
import type { ModelEvaluationFacts } from "../projection/domain/model-evaluations.ts";
import type { OperationalMetricFacts } from "../projection/domain/operational-metrics.ts";
import { PLAN_SUCCESS_STATUSES } from "../projection/domain/plan-status.ts";
import type { PocDecisionCount } from "../projection/domain/poc-evaluations.ts";
import { HARNESS_DB_TABLE_BY_NAME, primaryKeyOf, type TableDef } from "../schema/harness-db.ts";
import { stableId } from "../stable-id.ts";
import { type HarnessDb, SECRET_PATTERN, upsertRow } from "./index.ts";
import { runSqliteTransaction } from "./sqlite-transaction.ts";

const RAW_PAYLOAD_KEYS = new Set([
  "rawMcpResponse",
  "browserTrace",
  "providerTranscript",
  "transcript",
  "secret",
  "credential",
  "screenshotBlob",
]);

export interface ProjectionFindingInput {
  kind: string;
  severity?: "error" | "warn" | "info";
  subjectId: string;
  source: string;
  evidencePath?: string;
  nextAction?: string;
}

export class SqliteProjectionStore
  implements ProjectionStore, ModelEvaluationReadPort, OperationalMetricsReadPort
{
  readonly #db: HarnessDb;

  constructor(db: HarnessDb) {
    this.#db = db;
  }

  record(event: ProjectionEvent): void {
    runSqliteTransaction(this.#db, () => this.recordInSession(event));
  }

  recordFinding(input: ProjectionFindingInput): void {
    runSqliteTransaction(this.#db, () => this.recordFindingInSession(input));
  }

  private recordInSession(event: ProjectionEvent): void {
    const table = tableDef(event.table);
    const row = normalizeRow(table, event);
    upsertRow(this.#db, { table: table.name, primaryKey: primaryKeyOf(table), row });
    checkResolvablePlanJoin(this, table.name, row);
  }

  private recordFindingInSession(input: ProjectionFindingInput): void {
    assertFindingInputSafe(input);
    upsertRow(this.#db, {
      table: "findings",
      primaryKey: "finding_id",
      row: {
        finding_id: stableId(`finding:${input.kind}`, input.subjectId),
        kind: input.kind,
        severity: input.severity ?? "warn",
        subject_id: input.subjectId,
        source: input.source,
        status: "open",
        evidence_path: input.evidencePath ?? "",
        next_action: input.nextAction ?? "",
      },
    });
  }

  planExists(planId: string): boolean {
    return (
      this.#db.prepare("SELECT plan_id FROM plan_registry WHERE plan_id = ?").get(planId) !==
      undefined
    );
  }

  readPocDecisionCounts(): readonly PocDecisionCount[] {
    return this.#db
      .prepare(
        `SELECT decision_outcome, COUNT(*) AS cnt
         FROM plan_registry
         WHERE kind = 'poc'
           AND decision_outcome IN ('confirmed', 'rejected', 'pivot')
         GROUP BY decision_outcome`,
      )
      .all() as unknown as PocDecisionCount[];
  }

  readModelEvaluationFacts(): readonly ModelEvaluationFacts[] {
    const placeholders = PLAN_SUCCESS_STATUSES.map(() => "?").join(", ");
    return this.#db
      .prepare(
        `SELECT mr.model,
                COUNT(*) AS run_count,
                SUM(CASE WHEN pr.status IN (${placeholders}) THEN 1 ELSE 0 END) AS success_count,
                COALESCE(SUM(mr.input_tokens), 0) AS total_input_tokens,
                COALESCE(SUM(mr.output_tokens), 0) AS total_output_tokens,
                SUM(mr.cost_usd) AS total_cost_usd
           FROM model_runs mr
           LEFT JOIN plan_registry pr ON mr.plan_id = pr.plan_id
          GROUP BY mr.model
          ORDER BY mr.model`,
      )
      .all(...PLAN_SUCCESS_STATUSES)
      .map(modelEvaluationFacts);
  }

  readOperationalMetricFacts(): OperationalMetricFacts {
    const drives = this.#db
      .prepare(
        `SELECT COALESCE(mode, 'unknown') AS mode,
                COUNT(*) AS total,
                SUM(CASE WHEN status IN ('completed', 'confirmed', 'documented') THEN 1 ELSE 0 END) AS completed
           FROM drive_runs
          GROUP BY COALESCE(mode, 'unknown')
          ORDER BY mode`,
      )
      .all()
      .map((row) => ({
        mode: String(row.mode ?? "unknown"),
        total: Number(row.total ?? 0),
        completed: Number(row.completed ?? 0),
      }));
    const hooks = this.#db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN event_type IN ('forced_stop', 'error', 'failed')
                              OR digest LIKE '%fail%' OR digest LIKE '%error%'
                         THEN 1 ELSE 0 END) AS trouble
           FROM hook_events`,
      )
      .get();
    const workflow = this.#db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN ready_status NOT IN ('passed_local', 'passed', 'ready') THEN 1 ELSE 0 END) AS blocked,
                SUM(CASE WHEN human_required = 1 THEN 1 ELSE 0 END) AS human_required,
                (SELECT COUNT(*) FROM (
                  SELECT plan_id, workflow, phase
                    FROM workflow_runs
                   GROUP BY plan_id, workflow, phase
                  HAVING COUNT(*) > 1
                )) AS retry_groups
           FROM workflow_runs`,
      )
      .get();
    return {
      drives,
      hooks: { total: numeric(hooks?.total), trouble: numeric(hooks?.trouble) },
      workflow: {
        total: numeric(workflow?.total),
        blocked: numeric(workflow?.blocked),
        humanRequired: numeric(workflow?.human_required),
        retryGroups: numeric(workflow?.retry_groups),
      },
    };
  }

  uniqueShortPlanExists(planId: string): boolean {
    if (!isBareNumericPlanContext(planId)) return false;
    const row = this.#db
      .prepare("SELECT COUNT(*) AS count FROM plan_registry WHERE plan_id LIKE ?")
      .get(`${planId}-%`) as { count: number } | undefined;
    return (row?.count ?? 0) === 1;
  }
}

function modelEvaluationFacts(row: Record<string, unknown>): ModelEvaluationFacts {
  return {
    model: String(row.model ?? ""),
    runCount: Number(row.run_count ?? 0),
    successCount: Number(row.success_count ?? 0),
    totalInputTokens: Number(row.total_input_tokens ?? 0),
    totalOutputTokens: Number(row.total_output_tokens ?? 0),
    totalCostUsd: row.total_cost_usd == null ? null : Number(row.total_cost_usd),
  };
}

function numeric(value: unknown): number {
  return Number(value ?? 0);
}

function tableDef(name: string): TableDef {
  const table = HARNESS_DB_TABLE_BY_NAME.get(name);
  if (!table) throw new Error(`unknown harness.db projection table: ${name}`);
  return table;
}

function normalizeRow(table: TableDef, event: ProjectionEvent): Record<string, unknown> {
  const allowed = new Set(table.columns.map((column) => column.name));
  const primaryKey = primaryKeyOf(table);
  const row = Object.fromEntries(Object.entries(event.row).filter(([key]) => allowed.has(key)));
  if (row[primaryKey] === undefined) row[primaryKey] = event.id;
  assertNoSensitivePayload(row);
  return row;
}

function assertNoSensitivePayload(row: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(row)) {
    if (RAW_PAYLOAD_KEYS.has(key)) {
      throw new Error(`raw/sensitive payload column is not allowed in harness.db: ${key}`);
    }
    assertNoSecretLikeString(value, "projection column", key);
  }
}

/**
 * Finding は任意の外部文脈を受けるため、構造化 ID の例外を適用しない。
 * 移行中の recordFinding も ProjectionWrite と同じ fail-close 境界に置く。
 */
function assertFindingInputSafe(input: ProjectionFindingInput): void {
  for (const [field, value] of Object.entries(input)) {
    assertNoSecretLikeString(value, "finding field", field);
  }
}

function assertNoSecretLikeString(value: unknown, scope: string, field: string): void {
  if (typeof value === "string" && SECRET_PATTERN.test(value)) {
    throw new Error(`secret-like value is not allowed in harness.db ${scope}: ${field}`);
  }
}

function checkResolvablePlanJoin(
  store: SqliteProjectionStore,
  table: string,
  row: Record<string, unknown>,
): void {
  if (table === "plan_registry" || table === "feedback_events") return;
  const planId = asString(row.plan_id);
  if (!planId || store.planExists(planId) || store.uniqueShortPlanExists(planId)) return;
  if (/^A-\d/.test(planId) || planId.includes("+")) return;
  const subjectId = `${table}:${String(row[primaryKeyOf(tableDef(table))] ?? "")}`;
  const staleRuntime =
    isBareNumericPlanContext(planId) &&
    (isRuntimeStateEvidencePath(asString(row.evidence_path)) || isRuntimeContextTable(table));
  store.recordFinding({
    kind: staleRuntime ? "stale-runtime-plan-context" : "unresolved-join",
    subjectId,
    source: "projection-writer",
    ...(asString(row.evidence_path) ? { evidencePath: asString(row.evidence_path) as string } : {}),
  });
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isBareNumericPlanContext(planId: string): boolean {
  return /^PLAN-L\d+-\d+$/.test(planId);
}

function isRuntimeStateEvidencePath(path: string | undefined): boolean {
  return Boolean(path?.startsWith(".ut-tdd/logs/") || path?.startsWith(".ut-tdd/handover/"));
}

function isRuntimeContextTable(table: string): boolean {
  return ["hook_events", "test_runs", "trouble_events", "guardrail_decisions"].includes(table);
}
