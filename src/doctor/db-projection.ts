import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  analyzeDbProjectionCoverage,
  dbProjectionCoverageMessages,
  loadDbProjectionRequirements,
} from "../lint/db-projection-coverage";
import {
  analyzeDbProjectionIngestion,
  type DbProjectionIngestionResult,
  type DbTelemetryProvenanceStats,
  dbProjectionIngestionMessages,
} from "../lint/db-projection-ingestion";
import type { LintResult } from "../plan/lint";
import type { HarnessDb } from "../state-db/index";
import { openHarnessDb } from "../state-db/index";
import {
  type ProjectionTiming,
  projectTokenUsage,
  rebuildHarnessDb,
} from "../state-db/projection-writer";
import { loadRuntimeSessionUsage } from "../state-db/token-tracker";

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
    return { messages: dbProjectionCoverageMessages(result), ok: result.ok };
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
