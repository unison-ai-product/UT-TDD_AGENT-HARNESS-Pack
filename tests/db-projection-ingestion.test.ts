import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDbProjectionIngestion } from "../src/doctor/db-projection.ts";
import {
  AUTOMATIC_DB_PROJECTION_REQUIREMENTS,
  analyzeDbProjectionIngestion,
  dbProjectionIngestionMessages,
  EVIDENCE_GATED_DB_PROJECTION_TABLES,
} from "../src/lint/db-projection-ingestion.ts";
import { openHarnessDb } from "../src/state-db/index.ts";
import { rebuildHarnessDb } from "../src/state-db/projection-writer.ts";

const populatedAutomaticProjectionCounts = {
  graph_nodes: 1,
  dependency_edges: 1,
  trace_edges: 1,
  graph_snapshots: 1,
  impact_rules: 1,
  verification_profiles: 1,
  mcp_server_profiles: 1,
  mcp_profile_triggers: 1,
  document_export_profiles: 1,
  document_export_triggers: 1,
  document_export_runs: 1,
  document_export_datasets: 1,
  test_cases: 1,
  test_artifact_edges: 1,
  artifact_progress: 1,
  spec_defs: 1,
  spec_relations: 1,
  schedule_entries: 1,
  execution_readiness_projection: 1,
  activation_entries: 1,
  activation_schedule_reviews: 1,
  document_catalog_entries: 1,
  document_scale_profile_entries: 1,
  document_scale_profile_reviews: 1,
  spec_rag_closure_entries: 1,
  agent_contracts: 1,
};

describe("db projection ingestion detector", () => {
  it("passes when rebuildHarnessDb auto-populates catalog and graph projection tables", () => {
    const db = openHarnessDb(":memory:");
    try {
      const rebuilt = rebuildHarnessDb({ repoRoot: process.cwd(), db });
      const result = analyzeDbProjectionIngestion(rebuilt.rowCounts);

      expect(result.ok).toBe(true);
      expect(result.missingRows).toEqual([]);
      expect(result.rowCounts.graph_nodes).toBeGreaterThan(0);
      expect(result.rowCounts.trace_edges).toBeGreaterThan(0);
      expect(result.rowCounts.mcp_server_profiles).toBeGreaterThan(0);
      expect(result.rowCounts.document_export_profiles).toBeGreaterThan(0);
      expect(result.rowCounts.test_cases).toBeGreaterThan(0);
      expect(result.rowCounts.spec_defs).toBeGreaterThan(0);
      expect(result.rowCounts.spec_relations).toBeGreaterThan(0);
      expect(result.rowCounts.schedule_entries).toBeGreaterThan(0);
      expect(result.rowCounts.execution_readiness_projection).toBeGreaterThan(0);
      expect(result.rowCounts.activation_entries).toBeGreaterThan(0);
      expect(result.rowCounts.activation_schedule_reviews).toBeGreaterThan(0);
      expect(result.rowCounts.document_catalog_entries).toBeGreaterThan(0);
      expect(result.rowCounts.document_scale_profile_entries).toBeGreaterThan(0);
      expect(result.rowCounts.document_scale_profile_reviews).toBeGreaterThan(0);
      expect(result.rowCounts.spec_rag_closure_entries).toBeGreaterThan(0);
      expect(result.rowCounts.agent_contracts).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("profiles rebuild phases without changing projection counts", () => {
    const db = openHarnessDb(":memory:");
    try {
      const rebuilt = rebuildHarnessDb({ repoRoot: process.cwd(), db, timing: true });

      expect(rebuilt.ok).toBe(true);
      expect(rebuilt.rowCounts.graph_nodes).toBeGreaterThan(0);
      expect(rebuilt.timings?.map((timing) => timing.id)).toEqual(
        expect.arrayContaining(["plans", "graph-impact", "row-counts"]),
      );
      expect(rebuilt.timings?.every((timing) => timing.duration_ms >= 0)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("exposes db projection profiling as timing substeps for doctor JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-db-profile-"));
    const claudeDir = join(root, "claude");
    const codexDir = join(root, "codex");
    const previousClaude = process.env.UT_TDD_CLAUDE_SESSIONS_DIR;
    const previousCodex = process.env.UT_TDD_CODEX_SESSIONS_DIR;
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    try {
      process.env.UT_TDD_CLAUDE_SESSIONS_DIR = claudeDir;
      process.env.UT_TDD_CODEX_SESSIONS_DIR = codexDir;

      const result = checkDbProjectionIngestion(process.cwd(), { timing: true });

      expect(result.ok).toBe(true);
      expect(result.messages.join("\n")).not.toContain("db-projection-ingestion profile");
      expect(result.timingSubsteps?.map((timing) => timing.id)).toEqual(
        expect.arrayContaining(["plans", "graph-impact", "runtime-model-telemetry"]),
      );
    } finally {
      if (previousClaude === undefined) {
        delete process.env.UT_TDD_CLAUDE_SESSIONS_DIR;
      } else {
        process.env.UT_TDD_CLAUDE_SESSIONS_DIR = previousClaude;
      }
      if (previousCodex === undefined) {
        delete process.env.UT_TDD_CODEX_SESSIONS_DIR;
      } else {
        process.env.UT_TDD_CODEX_SESSIONS_DIR = previousCodex;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when an automatic projection table is empty", () => {
    const result = analyzeDbProjectionIngestion({
      ...populatedAutomaticProjectionCounts,
      mcp_server_profiles: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.missingRows.map((row) => row.table)).toEqual(["mcp_server_profiles"]);
    expect(dbProjectionIngestionMessages(result).join("\n")).toContain(
      "empty automatic projection table mcp_server_profiles",
    );
  });

  it("treats trace_edges as automatic and telemetry-only tables as explicit evidence-gated zeros", () => {
    expect(AUTOMATIC_DB_PROJECTION_REQUIREMENTS.map((item) => item.table)).toContain("trace_edges");
    expect(AUTOMATIC_DB_PROJECTION_REQUIREMENTS.map((item) => item.table)).toEqual(
      expect.arrayContaining([
        "spec_defs",
        "spec_relations",
        "schedule_entries",
        "activation_entries",
        "document_catalog_entries",
        "document_scale_profile_entries",
        "document_scale_profile_reviews",
        "spec_rag_closure_entries",
        "agent_contracts",
      ]),
    );
    expect(EVIDENCE_GATED_DB_PROJECTION_TABLES).toEqual(
      expect.arrayContaining([
        "model_evaluations",
        "retry_events",
        "detector_route_candidates",
        "github_review_lane_receipts",
      ]),
    );
  });

  it("fails closed when trace_edges is not populated", () => {
    const result = analyzeDbProjectionIngestion({
      ...populatedAutomaticProjectionCounts,
      trace_edges: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.missingRows.map((row) => row.table)).toEqual(["trace_edges"]);
  });

  it("surfaces populated telemetry tables that have only projection provenance", () => {
    const result = analyzeDbProjectionIngestion(
      {
        ...populatedAutomaticProjectionCounts,
        skill_invocations: 7,
        model_runs: 3,
      },
      undefined,
      [
        {
          table: "skill_invocations",
          rows: 7,
          runtimeRows: 0,
          projectionRows: 7,
          emptySessionRows: 7,
          valuedRows: 0,
        },
        {
          table: "model_runs",
          rows: 3,
          runtimeRows: 0,
          projectionRows: 3,
          emptySessionRows: 0,
          valuedRows: 0,
        },
      ],
    );

    expect(result.ok).toBe(true);
    expect(result.telemetryProvenance.map((row) => row.table)).toEqual([
      "skill_invocations",
      "model_runs",
    ]);
    expect(dbProjectionIngestionMessages(result).join("\n")).toContain(
      "db-telemetry-provenance - partial",
    );
  });

  it("fails closed on projection-only telemetry when provenance enforcement is enabled", () => {
    const result = analyzeDbProjectionIngestion(
      {
        ...populatedAutomaticProjectionCounts,
        test_runs: 9,
      },
      undefined,
      {
        telemetryStats: [
          {
            table: "test_runs",
            rows: 9,
            runtimeRows: 0,
            projectionRows: 9,
            emptySessionRows: 9,
            valuedRows: 9,
          },
        ],
        enforceTelemetryProvenance: true,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.telemetryProvenance.map((row) => row.table)).toEqual(["test_runs"]);
    expect(dbProjectionIngestionMessages(result).join("\n")).toContain(
      "db-telemetry-provenance - violation",
    );
  });
});
