import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  analyzeDbConstraintCoverage,
  analyzeDbProjectionCoverage,
  dbConstraintCoverageMessages,
  dbProjectionCoverageMessages,
  loadDbProjectionRequirements,
} from "../lint/db-projection-coverage.ts";
import {
  analyzeDbProjectionIngestion,
  type DbProjectionIngestionResult,
  type DbTelemetryProvenanceStats,
  dbProjectionIngestionMessages,
} from "../lint/db-projection-ingestion.ts";
import type { LintResult } from "../plan/lint.ts";
import {
  analyzeDesignDetectionStats,
  collectDesignDetectionStats,
  designDetectionMessages,
} from "../state-db/design-detection.ts";
import type { HarnessDb } from "../state-db/index.ts";
import { openHarnessDb } from "../state-db/index.ts";
import { migrate } from "../state-db/migration.ts";
import {
  type ProjectionTiming,
  projectTokenUsage,
  rebuildHarnessDb,
} from "../state-db/projection-writer.ts";
import {
  type AgentContractIntegrityResult,
  analyzeAgentContractIntegrity,
  analyzeDesignDocCrossIntegrity,
  analyzeTypedSpecLedgerBodySync,
  analyzeTypedSpecOwnedArtifactDispersal,
  analyzeTypedSpecPhaseLayerAlignment,
  analyzeTypedSpecTraceClosure,
  collectSpecIrProjection,
  type DesignDocCrossIntegrityResult,
  loadSpecIrSources,
  type TypedSpecLedgerBodySyncResult,
  type TypedSpecOwnedArtifactDispersalResult,
  type TypedSpecPhaseLayerAlignmentResult,
  type TypedSpecTraceClosureResult,
} from "../state-db/spec-ir-projections.ts";
import { loadRuntimeSessionUsage } from "../state-db/token-tracker.ts";
import { FULL_DOCTOR_OUTPUT_IDS } from "./profiles.ts";

export interface DbProjectionDoctorOptions {
  strictTelemetryProvenance?: boolean;
  timing?: boolean;
}

interface DbProjectionIngestionCheckResult extends LintResult {
  timingSubsteps?: ProjectionTiming[];
}

export function checkDbProjectionCoverage(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["db-projection-coverage - violation: repo root could not be read"],
      ok: false,
    };
  }
  try {
    const result = analyzeDbProjectionCoverage(loadDbProjectionRequirements(repoRoot));
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      const constraints = analyzeDbConstraintCoverage(db);
      return {
        messages: [
          ...dbProjectionCoverageMessages(result),
          ...dbConstraintCoverageMessages(constraints),
        ],
        ok: result.ok && constraints.ok,
      };
    } finally {
      db.close();
    }
  } catch {
    return {
      messages: ["db-projection-coverage - violation: physical-data/schema coverage could not run"],
      ok: false,
    };
  }
}

function telemetryStatsRow(db: HarnessDb, table: string, sql: string): DbTelemetryProvenanceStats {
  const row = db.prepare(sql).get() ?? {};
  return {
    table,
    rows: Number(row.rows ?? 0),
    runtimeRows: Number(row.runtime_rows ?? 0),
    projectionRows: Number(row.projection_rows ?? 0),
    emptySessionRows: Number(row.empty_session_rows ?? 0),
    valuedRows: Number(row.valued_rows ?? 0),
  };
}

function loadDbTelemetryProvenanceStats(db: HarnessDb): DbTelemetryProvenanceStats[] {
  return [
    telemetryStatsRow(
      db,
      "skill_invocations",
      `SELECT COUNT(*) AS rows,
              SUM(CASE WHEN COALESCE(session_id, '') <> ''
                        AND COALESCE(source, '') NOT LIKE 'auto-projection%'
                       THEN 1 ELSE 0 END) AS runtime_rows,
              SUM(CASE WHEN COALESCE(source, '') LIKE 'auto-projection%'
                         OR COALESCE(session_id, '') = ''
                       THEN 1 ELSE 0 END) AS projection_rows,
              SUM(CASE WHEN COALESCE(session_id, '') = '' THEN 1 ELSE 0 END) AS empty_session_rows,
              0 AS valued_rows
         FROM skill_invocations`,
    ),
    telemetryStatsRow(
      db,
      "test_runs",
      `SELECT COUNT(*) AS rows,
              SUM(CASE WHEN COALESCE(session_id, '') <> '' THEN 1 ELSE 0 END) AS runtime_rows,
              SUM(CASE WHEN COALESCE(session_id, '') = '' THEN 1 ELSE 0 END) AS projection_rows,
              SUM(CASE WHEN COALESCE(session_id, '') = '' THEN 1 ELSE 0 END) AS empty_session_rows,
              SUM(CASE WHEN COALESCE(output_digest, '') <> '' THEN 1 ELSE 0 END) AS valued_rows
         FROM test_runs`,
    ),
    telemetryStatsRow(
      db,
      "guardrail_decisions",
      `SELECT COUNT(*) AS rows,
              SUM(CASE WHEN COALESCE(session_id, '') <> '' THEN 1 ELSE 0 END) AS runtime_rows,
              SUM(CASE WHEN COALESCE(session_id, '') = '' THEN 1 ELSE 0 END) AS projection_rows,
              SUM(CASE WHEN COALESCE(session_id, '') = '' THEN 1 ELSE 0 END) AS empty_session_rows,
              0 AS valued_rows
         FROM guardrail_decisions`,
    ),
    telemetryStatsRow(
      db,
      "model_runs",
      `SELECT COUNT(*) AS rows,
              SUM(CASE WHEN input_tokens IS NOT NULL
                         OR output_tokens IS NOT NULL
                         OR cached_input_tokens IS NOT NULL
                         OR reasoning_tokens IS NOT NULL
                         OR cost_usd IS NOT NULL
                       THEN 1 ELSE 0 END) AS runtime_rows,
              SUM(CASE WHEN input_tokens IS NULL
                         AND output_tokens IS NULL
                         AND cached_input_tokens IS NULL
                         AND reasoning_tokens IS NULL
                         AND cost_usd IS NULL
                       THEN 1 ELSE 0 END) AS projection_rows,
              0 AS empty_session_rows,
              SUM(CASE WHEN input_tokens IS NOT NULL
                         OR output_tokens IS NOT NULL
                         OR cached_input_tokens IS NOT NULL
                         OR reasoning_tokens IS NOT NULL
                         OR cost_usd IS NOT NULL
                       THEN 1 ELSE 0 END) AS valued_rows
         FROM model_runs`,
    ),
  ];
}

function projectRuntimeModelTelemetryForDoctor(db: HarnessDb): void {
  const claudeDir =
    process.env.UT_TDD_CLAUDE_SESSIONS_DIR ?? join(homedir(), ".claude", "projects");
  const codexDir = process.env.UT_TDD_CODEX_SESSIONS_DIR ?? join(homedir(), ".codex", "sessions");
  const usages = loadRuntimeSessionUsage({ claudeDirs: [claudeDir], codexDirs: [codexDir] });
  projectTokenUsage(db, usages);
}

export function checkDbProjectionIngestion(
  repoRoot: string,
  options: DbProjectionDoctorOptions = {},
): DbProjectionIngestionCheckResult {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["db-projection-ingestion - violation: repo root could not be read"],
      ok: false,
    };
  }
  try {
    const profile: ProjectionTiming[] = [];
    const timed = <T>(id: string, run: () => T): T => {
      if (options.timing !== true) return run();
      const started = performance.now();
      const result = run();
      profile.push({ id, duration_ms: Number((performance.now() - started).toFixed(3)) });
      return result;
    };
    const db = timed("open-db", () => openHarnessDb(":memory:", { repoRoot }));
    try {
      const rebuilt = rebuildHarnessDb({ repoRoot, db, timing: options.timing === true });
      timed("runtime-model-telemetry", () => projectRuntimeModelTelemetryForDoctor(db));
      let telemetryStats: DbTelemetryProvenanceStats[] = [];
      timed("telemetry-stats", () => {
        telemetryStats = loadDbTelemetryProvenanceStats(db);
      });
      const result = timed("analyze", (): DbProjectionIngestionResult => {
        return analyzeDbProjectionIngestion(rebuilt.rowCounts, undefined, {
          telemetryStats,
          enforceTelemetryProvenance: options.strictTelemetryProvenance === true,
        });
      });
      const checkResult: DbProjectionIngestionCheckResult = {
        messages: dbProjectionIngestionMessages(result),
        ok: result.ok,
      };
      if (options.timing === true) {
        checkResult.timingSubsteps = [...(rebuilt.timings ?? []), ...profile];
      }
      return checkResult;
    } finally {
      db.close();
    }
  } catch {
    return {
      messages: [
        "db-projection-ingestion - violation: automatic projection ingestion could not run",
      ],
      ok: false,
    };
  }
}

export function checkDesignDetection(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["design-detection - violation: repo root could not be read"],
      ok: false,
    };
  }
  const db = openHarnessDb(":memory:", { repoRoot });
  try {
    rebuildHarnessDb({ repoRoot, db });
    const result = analyzeDesignDetectionStats(collectDesignDetectionStats(db));
    return { messages: designDetectionMessages(result), ok: result.ok };
  } catch {
    return {
      messages: ["design-detection - violation: design detection projection could not run"],
      ok: false,
    };
  } finally {
    db.close();
  }
}

export function typedSpecTraceClosureMessages(result: TypedSpecTraceClosureResult): string[] {
  if (result.ok) {
    return [
      `typed-spec-trace-closure - OK (typed_specs=${result.typedSpecCount}, relations=${result.relationCount})`,
    ];
  }
  return [
    `typed-spec-trace-closure - violation (typed_specs=${result.typedSpecCount}, findings=${result.findings.length})`,
    ...result.findings
      .slice(0, 8)
      .map(
        (finding) =>
          `typed-spec-trace-closure - ${finding.kind}: ${finding.subject_id} (${finding.evidence_path})`,
      ),
  ];
}

export function checkTypedSpecTraceClosure(repoRoot: string): {
  messages: string[];
  ok: boolean;
  result?: TypedSpecTraceClosureResult;
} {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["typed-spec-trace-closure - violation: repo root could not be read"],
      ok: false,
    };
  }
  try {
    const projection = collectSpecIrProjection(repoRoot, new Date(0).toISOString());
    const result = analyzeTypedSpecTraceClosure({
      defs: projection.spec_defs,
      relations: projection.spec_relations,
    });
    return { messages: typedSpecTraceClosureMessages(result), ok: result.ok, result };
  } catch {
    return {
      messages: ["typed-spec-trace-closure - violation: typed spec trace closure could not run"],
      ok: false,
    };
  }
}

export function designDocCrossIntegrityMessages(result: DesignDocCrossIntegrityResult): string[] {
  if (result.ok) {
    return [
      `design-doc-cross-integrity - OK (docs=${result.checked_docs}, duplicate_definitions=0, dependency_cycles=0)`,
    ];
  }
  return [
    `design-doc-cross-integrity - violation (docs=${result.checked_docs}, duplicate_definitions=${result.duplicate_definitions.length}, dependency_cycles=${result.dependency_cycles.length})`,
    ...result.findings
      .slice(0, 8)
      .map(
        (finding) =>
          `design-doc-cross-integrity - ${finding.kind}: ${finding.subject_id} (${finding.evidence_path})`,
      ),
  ];
}

export function checkDesignDocCrossIntegrity(repoRoot: string): {
  messages: string[];
  ok: boolean;
  result?: DesignDocCrossIntegrityResult;
} {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["design-doc-cross-integrity - violation: repo root could not be read"],
      ok: false,
    };
  }
  try {
    const projection = collectSpecIrProjection(repoRoot, new Date(0).toISOString());
    const result = analyzeDesignDocCrossIntegrity({
      defs: projection.spec_defs,
      relations: projection.spec_relations,
      catalog_entries: projection.document_catalog_entries,
    });
    return { messages: designDocCrossIntegrityMessages(result), ok: result.ok, result };
  } catch {
    return {
      messages: [
        "design-doc-cross-integrity - violation: design doc cross integrity could not run",
      ],
      ok: false,
    };
  }
}

export function typedSpecLedgerBodySyncMessages(result: TypedSpecLedgerBodySyncResult): string[] {
  if (result.ok) {
    return [
      `typed-spec-ledger-body-sync - OK (typed_specs=${result.typedSpecCount}, ledger_rows=${result.ledgerRowCount})`,
    ];
  }
  return [
    `typed-spec-ledger-body-sync - violation (typed_specs=${result.typedSpecCount}, findings=${result.findings.length})`,
    ...result.findings
      .slice(0, 8)
      .map(
        (finding) =>
          `typed-spec-ledger-body-sync - ${finding.kind}: ${finding.subject_id} (${finding.evidence_path})`,
      ),
  ];
}

export function checkTypedSpecLedgerBodySync(repoRoot: string): {
  messages: string[];
  ok: boolean;
  result?: TypedSpecLedgerBodySyncResult;
} {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["typed-spec-ledger-body-sync - violation: repo root could not be read"],
      ok: false,
    };
  }
  try {
    const projection = collectSpecIrProjection(repoRoot, new Date(0).toISOString());
    const sources = loadSpecIrSources(repoRoot).map((source) => ({
      path: source.path,
      content: source.content,
    }));
    const result = analyzeTypedSpecLedgerBodySync({
      defs: projection.spec_defs,
      relations: projection.spec_relations,
      sources,
    });
    return { messages: typedSpecLedgerBodySyncMessages(result), ok: result.ok, result };
  } catch {
    return {
      messages: [
        "typed-spec-ledger-body-sync - violation: typed spec ledger/body sync could not run",
      ],
      ok: false,
    };
  }
}

export function typedSpecOwnedArtifactDispersalMessages(
  result: TypedSpecOwnedArtifactDispersalResult,
): string[] {
  if (result.ok) {
    return [
      `typed-spec-owned-artifact-dispersal - OK (typed_specs=${result.typedSpecCount}, dispersed=${result.dispersedSpecCount})`,
    ];
  }
  return [
    `typed-spec-owned-artifact-dispersal - violation (typed_specs=${result.typedSpecCount}, findings=${result.findings.length})`,
    ...result.findings
      .slice(0, 8)
      .map(
        (finding) =>
          `typed-spec-owned-artifact-dispersal - ${finding.kind}: ${finding.subject_id} (${finding.evidence_path})`,
      ),
  ];
}

export function checkTypedSpecOwnedArtifactDispersal(repoRoot: string): {
  messages: string[];
  ok: boolean;
  result?: TypedSpecOwnedArtifactDispersalResult;
} {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["typed-spec-owned-artifact-dispersal - violation: repo root could not be read"],
      ok: false,
    };
  }
  try {
    const projection = collectSpecIrProjection(repoRoot, new Date(0).toISOString());
    const sources = loadSpecIrSources(repoRoot).map((source) => ({
      path: source.path,
      content: source.content,
    }));
    const result = analyzeTypedSpecOwnedArtifactDispersal({
      defs: projection.spec_defs,
      sources,
    });
    return { messages: typedSpecOwnedArtifactDispersalMessages(result), ok: result.ok, result };
  } catch {
    return {
      messages: [
        "typed-spec-owned-artifact-dispersal - violation: typed spec owned artifact dispersal could not run",
      ],
      ok: false,
    };
  }
}

export function typedSpecPhaseLayerAlignmentMessages(
  result: TypedSpecPhaseLayerAlignmentResult,
): string[] {
  if (result.ok) {
    return [
      `typed-spec-phase-layer-alignment - OK (typed_specs=${result.typedSpecCount}, aligned=${result.alignedSpecCount})`,
    ];
  }
  return [
    `typed-spec-phase-layer-alignment - violation (typed_specs=${result.typedSpecCount}, findings=${result.findings.length})`,
    ...result.findings
      .slice(0, 8)
      .map(
        (finding) =>
          `typed-spec-phase-layer-alignment - ${finding.kind}: ${finding.subject_id} (${finding.evidence_path})`,
      ),
  ];
}

export function checkTypedSpecPhaseLayerAlignment(repoRoot: string): {
  messages: string[];
  ok: boolean;
  result?: TypedSpecPhaseLayerAlignmentResult;
} {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["typed-spec-phase-layer-alignment - violation: repo root could not be read"],
      ok: false,
    };
  }
  try {
    const projection = collectSpecIrProjection(repoRoot, new Date(0).toISOString());
    const sources = loadSpecIrSources(repoRoot).map((source) => ({
      path: source.path,
      content: source.content,
    }));
    const result = analyzeTypedSpecPhaseLayerAlignment({
      defs: projection.spec_defs,
      sources,
    });
    return { messages: typedSpecPhaseLayerAlignmentMessages(result), ok: result.ok, result };
  } catch {
    return {
      messages: [
        "typed-spec-phase-layer-alignment - violation: typed spec phase/layer alignment could not run",
      ],
      ok: false,
    };
  }
}

export function agentContractDetectionMessages(result: AgentContractIntegrityResult): string[] {
  if (result.ok) {
    return [`agent-contract-detection - OK (contracts=${result.contractCount})`];
  }
  return [
    `agent-contract-detection - violation (contracts=${result.contractCount}, findings=${result.findings.length})`,
    ...result.findings
      .slice(0, 8)
      .map(
        (finding) =>
          `agent-contract-detection - ${finding.kind}: ${finding.subject_id} (${finding.evidence_path})`,
      ),
  ];
}

export function checkAgentContractDetection(repoRoot: string): {
  messages: string[];
  ok: boolean;
  result?: AgentContractIntegrityResult;
} {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["agent-contract-detection - violation: repo root could not be read"],
      ok: false,
    };
  }
  try {
    const projection = collectSpecIrProjection(repoRoot, new Date(0).toISOString());
    const sources = loadSpecIrSources(repoRoot).map((source) => ({
      path: source.path,
      content: source.content,
    }));
    const result = analyzeAgentContractIntegrity({
      contracts: projection.agent_contracts,
      sources,
      knownDoctorGateIds: FULL_DOCTOR_OUTPUT_IDS,
    });
    return { messages: agentContractDetectionMessages(result), ok: result.ok, result };
  } catch {
    return {
      messages: ["agent-contract-detection - violation: agent contract detection could not run"],
      ok: false,
    };
  }
}
