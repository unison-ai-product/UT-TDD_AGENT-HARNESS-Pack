import type {
  ModelEvaluationReadPort,
  OperationalMetricsReadPort,
  ProjectionEvent,
  ProjectionStore,
} from "../projection/contracts/projection-store.ts";
import type { ModelEvaluationFacts } from "../projection/domain/model-evaluations.ts";
import type { OperationalMetricFacts } from "../projection/domain/operational-metrics.ts";
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

  readModelEvaluationFacts(): readonly ModelEvaluationFacts[] {
    return this.#db
      .prepare(
        `SELECT model,
                COUNT(*) AS run_count,
                COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
                COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
                SUM(cost_usd) AS total_cost_usd
           FROM model_runs
          GROUP BY model
          ORDER BY model`,
      )
      .all()
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
                   WHERE COALESCE(workflow, '') <> 'routine-gate'
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
}

function modelEvaluationFacts(row: Record<string, unknown>): ModelEvaluationFacts {
  return {
    model: String(row.model ?? ""),
    runCount: Number(row.run_count ?? 0),
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
