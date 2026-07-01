export interface DbProjectionIngestionRequirement {
  table: string;
  reason: string;
}

export interface DbTelemetryProvenanceStats {
  table: string;
  rows: number;
  runtimeRows: number;
  projectionRows: number;
  emptySessionRows: number;
  valuedRows: number;
}

export interface DbTelemetryProvenanceFinding {
  table: string;
  reason: string;
  rows: number;
  runtimeRows: number;
  projectionRows: number;
  emptySessionRows: number;
  valuedRows: number;
}

export interface DbProjectionIngestionResult {
  checked: number;
  missingRows: DbProjectionIngestionRequirement[];
  optionalEvidenceTables: string[];
  telemetryProvenance: DbTelemetryProvenanceFinding[];
  enforceTelemetryProvenance: boolean;
  rowCounts: Record<string, number>;
  ok: boolean;
}

export interface DbProjectionIngestionOptions {
  telemetryStats?: DbTelemetryProvenanceStats[];
  enforceTelemetryProvenance?: boolean;
}

type DbProjectionIngestionTelemetryInput =
  | DbTelemetryProvenanceStats[]
  | DbProjectionIngestionOptions;

export const AUTOMATIC_DB_PROJECTION_REQUIREMENTS: DbProjectionIngestionRequirement[] = [
  {
    table: "graph_nodes",
    reason: "relation graph nodes are derived from repo docs/src/test inputs",
  },
  { table: "dependency_edges", reason: "relation graph edges are derived from trace links" },
  { table: "trace_edges", reason: "trace edges are derived from relation graph edges" },
  { table: "graph_snapshots", reason: "graph snapshot is derived from the relation graph" },
  { table: "impact_rules", reason: "impact rules are built-in workflow policy" },
  { table: "verification_profiles", reason: "verification profile catalog is built-in" },
  {
    table: "mcp_server_profiles",
    reason: "MCP profile catalog is derived from verification profiles",
  },
  {
    table: "mcp_profile_triggers",
    reason: "MCP triggers are derived from profile trigger signals",
  },
  { table: "document_export_profiles", reason: "document export profile catalog is built-in" },
  { table: "document_export_triggers", reason: "document export triggers are built-in" },
  { table: "document_export_runs", reason: "canonical document dataset run is derived from docs" },
  { table: "document_export_datasets", reason: "canonical document dataset is derived from docs" },
  { table: "test_cases", reason: "test case catalog is derived from tests/**/*.test.ts" },
  { table: "test_artifact_edges", reason: "test artifact edges are derived from test imports" },
  {
    table: "artifact_progress",
    reason: "artifact progress colors are derived from relation graph, tests, and impact results",
  },
];

export const EVIDENCE_GATED_DB_PROJECTION_TABLES = [
  "test_runs",
  "test_results",
  "test_flake_events",
  "impact_results",
  "tool_runs",
  "diagram_artifacts",
  "verification_recommendations",
  "mcp_server_runs",
  "external_tool_findings",
  "document_export_artifacts",
  "model_evaluations",
  "retry_events",
];

export const TELEMETRY_PROVENANCE_REQUIREMENTS: DbProjectionIngestionRequirement[] = [
  {
    table: "skill_invocations",
    reason:
      "skill firing telemetry must include runtime session provenance, not only auto-projected review evidence",
  },
  {
    table: "test_runs",
    reason:
      "test execution telemetry must distinguish runtime executions from projected green-command evidence",
  },
  {
    table: "guardrail_decisions",
    reason:
      "guardrail telemetry must include runtime session provenance for fired safety decisions",
  },
  {
    table: "model_runs",
    reason:
      "model telemetry must include captured token/cost rows, not only review-evidence model projections",
  },
];

export function analyzeDbProjectionIngestion(
  rowCounts: Record<string, number>,
  requirements: DbProjectionIngestionRequirement[] = AUTOMATIC_DB_PROJECTION_REQUIREMENTS,
  telemetryInput: DbProjectionIngestionTelemetryInput = [],
): DbProjectionIngestionResult {
  const telemetryStats = Array.isArray(telemetryInput)
    ? telemetryInput
    : (telemetryInput.telemetryStats ?? []);
  const enforceTelemetryProvenance =
    !Array.isArray(telemetryInput) && telemetryInput.enforceTelemetryProvenance === true;
  const missingRows = requirements.filter(
    (requirement) => (rowCounts[requirement.table] ?? 0) <= 0,
  );
  const statsByTable = new Map(telemetryStats.map((stats) => [stats.table, stats]));
  const telemetryProvenance = TELEMETRY_PROVENANCE_REQUIREMENTS.flatMap((requirement) => {
    const stats = statsByTable.get(requirement.table);
    if (!stats || stats.rows <= 0 || stats.runtimeRows > 0) return [];
    return [
      {
        table: requirement.table,
        reason: requirement.reason,
        rows: stats.rows,
        runtimeRows: stats.runtimeRows,
        projectionRows: stats.projectionRows,
        emptySessionRows: stats.emptySessionRows,
        valuedRows: stats.valuedRows,
      },
    ];
  });
  return {
    checked: requirements.length,
    missingRows,
    optionalEvidenceTables: EVIDENCE_GATED_DB_PROJECTION_TABLES.filter(
      (table) => (rowCounts[table] ?? 0) <= 0,
    ),
    telemetryProvenance,
    enforceTelemetryProvenance,
    rowCounts,
    ok:
      requirements.length > 0 &&
      missingRows.length === 0 &&
      (!enforceTelemetryProvenance || telemetryProvenance.length === 0),
  };
}

export function dbProjectionIngestionMessages(result: DbProjectionIngestionResult): string[] {
  if (result.ok) {
    const messages = [
      `db-projection-ingestion - OK (${result.checked} automatic projection tables populated; evidence-gated zero tables: ${result.optionalEvidenceTables.length})`,
    ];
    if (result.telemetryProvenance.length > 0) {
      messages.push(
        `db-telemetry-provenance - partial (${result.telemetryProvenance.length} populated telemetry tables have no runtime provenance)`,
      );
      for (const item of result.telemetryProvenance) {
        messages.push(
          `telemetry table ${item.table}: rows=${item.rows}, runtime_rows=${item.runtimeRows}, projection_rows=${item.projectionRows}, empty_session_rows=${item.emptySessionRows}, valued_rows=${item.valuedRows} - ${item.reason}`,
        );
      }
    }
    return messages;
  }
  const messages = ["db-projection-ingestion - violation"];
  for (const item of result.missingRows) {
    messages.push(`empty automatic projection table ${item.table}: ${item.reason}`);
  }
  if (result.enforceTelemetryProvenance && result.telemetryProvenance.length > 0) {
    messages.push(
      `db-telemetry-provenance - violation (${result.telemetryProvenance.length} populated telemetry tables have no runtime provenance)`,
    );
    for (const item of result.telemetryProvenance) {
      messages.push(
        `projection-only telemetry table ${item.table}: rows=${item.rows}, runtime_rows=${item.runtimeRows}, projection_rows=${item.projectionRows}, empty_session_rows=${item.emptySessionRows}, valued_rows=${item.valuedRows} - ${item.reason}`,
      );
    }
  }
  return messages;
}
