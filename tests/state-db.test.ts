import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HARNESS_DB_TABLE_BY_NAME,
  primaryKeyOf,
  SCHEMA_VERSION,
  schemaDdl,
} from "../src/schema/harness-db.ts";
import { HARNESS_DB_INDEXES, HARNESS_DB_TABLES } from "../src/schema/harness-db-catalog.ts";
import { HARNESS_DB_INDEXES as SECTION_HARNESS_DB_INDEXES } from "../src/schema/harness-db-indexes.ts";
import { col, pk } from "../src/schema/harness-db-table-builders.ts";
import { HARNESS_DB_CORE_TABLES } from "../src/schema/harness-db-tables-core.ts";
import { HARNESS_DB_EVALUATION_TABLES } from "../src/schema/harness-db-tables-evaluation.ts";
import { HARNESS_DB_GITHUB_TABLES } from "../src/schema/harness-db-tables-github.ts";
import { HARNESS_DB_GRAPH_EXPORT_TABLES } from "../src/schema/harness-db-tables-graph.ts";
import { HARNESS_DB_SPEC_IR_TABLES } from "../src/schema/harness-db-tables-spec-ir.ts";
import { HARNESS_DB_VMODEL_TABLES } from "../src/schema/harness-db-tables-vmodel.ts";
import { assertWithinUtTdd, openHarnessDb, upsertRow } from "../src/state-db/index.ts";
import { ensureHarnessSchema, harnessDbStatus } from "../src/state-db/maintenance.ts";
import { migrate, missingTables, rowCounts, tableNames } from "../src/state-db/migration.ts";
import { removeTestTree } from "./support/temp-tree.ts";

/**
 * node:sqlite releases the OS file handle synchronously on close(), so cleanup can remove
 * the temporary repository without a runtime-specific GC hook.
 */
const cleanupRepo = removeTestTree;

/**
 * IT-DB-01: harness.db state-db foundation。
 * table 作成 (registry-driven migration) + idempotent upsert 基盤 + DB path guard。
 * 設計 pair: docs/test-design/harness/L8-integration-test-design.md IT-DB-01。
 */
describe("IT-DB-01: harness.db state-db foundation", () => {
  it("uses the sealed node:sqlite driver", () => {
    const db = openHarnessDb(":memory:");
    try {
      expect(db.driver).toBe("node");
      db.exec("CREATE TABLE fallback_smoke (id TEXT PRIMARY KEY)");
      db.prepare("INSERT INTO fallback_smoke (id) VALUES (?)").run("ok");
      expect(db.prepare("SELECT id FROM fallback_smoke").get()?.id).toBe("ok");
    } finally {
      db.close();
    }
  });

  it("migrate が registry の全 table を作成し user_version を設定する", () => {
    const db = openHarnessDb(":memory:");
    const result = migrate(db);

    expect(result.applied).toBe(true);
    expect(result.fromVersion).toBe(0);
    expect(result.toVersion).toBe(SCHEMA_VERSION);
    expect(db.userVersion()).toBe(SCHEMA_VERSION);
    expect(pk("fixture_id")).toMatchObject({ name: "fixture_id", primaryKey: true });
    expect(col("fixture_count", "INTEGER")).toEqual({ name: "fixture_count", type: "INTEGER" });
    expect(HARNESS_DB_TABLES.map((t) => t.name)).toEqual(
      [
        ...HARNESS_DB_CORE_TABLES,
        ...HARNESS_DB_GRAPH_EXPORT_TABLES,
        ...HARNESS_DB_GITHUB_TABLES,
        ...HARNESS_DB_EVALUATION_TABLES,
        ...HARNESS_DB_VMODEL_TABLES,
        ...HARNESS_DB_SPEC_IR_TABLES,
      ].map((t) => t.name),
    );
    expect(HARNESS_DB_INDEXES.map((i) => i.name)).toEqual(
      SECTION_HARNESS_DB_INDEXES.map((i) => i.name),
    );
    expect(HARNESS_DB_INDEXES).toEqual(
      expect.arrayContaining([
        {
          name: "idx_spec_defs_owner",
          table: "spec_defs",
          columns: ["owner_path", "section_anchor"],
        },
        {
          name: "idx_detector_candidates_filing",
          table: "detector_route_candidates",
          columns: ["filing_target_id", "severity", "candidate_status"],
        },
        {
          name: "idx_refactor_candidates_state",
          table: "refactor_candidates",
          columns: ["state", "confidence", "last_seen_at"],
        },
        {
          name: "idx_document_catalog_doc_type",
          table: "document_catalog_entries",
          columns: ["doc_type_id", "default_status"],
        },
        {
          name: "idx_document_scale_profile_entry",
          table: "document_scale_profile_entries",
          columns: ["profile_id", "doc_type_id", "decision"],
        },
        {
          name: "idx_spec_rag_closure_rag_status",
          table: "spec_rag_closure_entries",
          columns: ["rag", "closure_status"],
        },
      ]),
    );

    const present = tableNames(db);
    for (const table of HARNESS_DB_TABLES) {
      expect(present).toContain(table.name);
    }
    const planRegistryColumns = db
      .prepare("PRAGMA table_info(plan_registry)")
      .all()
      .map((row) => String(row.name));
    expect(planRegistryColumns).toContain("source_hash");
    const specDefsColumns = db
      .prepare("PRAGMA table_info(spec_defs)")
      .all()
      .map((row) => String(row.name));
    expect(specDefsColumns).toEqual(
      expect.arrayContaining([
        "spec_id",
        "spec_kind",
        "layer",
        "sub_doc",
        "owner_path",
        "section_anchor",
        "source_hash",
      ]),
    );
    const detectorCandidateColumns = db
      .prepare("PRAGMA table_info(detector_route_candidates)")
      .all()
      .map((row) => String(row.name));
    expect(detectorCandidateColumns).toEqual(
      expect.arrayContaining([
        "route_candidate_id",
        "source_table",
        "filing_target_id",
        "target_layer",
        "target_sub_doc",
        "candidate_status",
      ]),
    );
    const documentCatalogColumns = db
      .prepare("PRAGMA table_info(document_catalog_entries)")
      .all()
      .map((row) => String(row.name));
    expect(documentCatalogColumns).toEqual(
      expect.arrayContaining([
        "document_catalog_entry_id",
        "doc_type_id",
        "layer",
        "sub_doc",
        "applicability",
        "default_status",
        "profile_controlled",
        "skip_reason_required",
      ]),
    );
    const documentScaleProfileColumns = db
      .prepare("PRAGMA table_info(document_scale_profile_reviews)")
      .all()
      .map((row) => String(row.name));
    expect(documentScaleProfileColumns).toEqual(
      expect.arrayContaining([
        "document_scale_profile_review_id",
        "profile_id",
        "doc_type_id",
        "decision",
        "catalog_layer",
        "catalog_sub_doc",
        "catalog_skip_reason_required",
      ]),
    );
    const specRagColumns = db
      .prepare("PRAGMA table_info(spec_rag_closure_entries)")
      .all()
      .map((row) => String(row.name));
    expect(specRagColumns).toEqual(
      expect.arrayContaining([
        "spec_rag_entry_id",
        "spec_id",
        "rag",
        "closure_status",
        "requires_test",
        "test_count",
        "finding_count",
      ]),
    );
    const refactorCandidateColumns = db
      .prepare("PRAGMA table_info(refactor_candidates)")
      .all()
      .map((row) => String(row.name));
    expect(refactorCandidateColumns).toEqual(
      expect.arrayContaining([
        "candidate_key",
        "kind",
        "subject",
        "state",
        "linked_plan_id",
        "first_seen_at",
        "last_seen_at",
        "decided_at",
      ]),
    );
    expect(missingTables(db)).toEqual([]);
    db.close();
  });

  it("migrate は冪等 (2 回目は no-op、version 安定、例外なし)", () => {
    const db = openHarnessDb(":memory:");
    const first = migrate(db);
    const second = migrate(db);

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.fromVersion).toBe(SCHEMA_VERSION);
    expect(second.toVersion).toBe(SCHEMA_VERSION);
    expect(missingTables(db)).toEqual([]);
    db.close();
  });

  it("migrate は v26 DB の既存rowを保持してv27 Forward escape custody表を追加する", () => {
    const db = openHarnessDb(":memory:");
    db.exec("CREATE TABLE retained_fixture (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec("INSERT INTO retained_fixture VALUES ('before-v27', 'preserved')");
    db.setUserVersion(26);

    const result = migrate(db);

    expect(result).toMatchObject({ fromVersion: 26, toVersion: SCHEMA_VERSION, applied: true });
    expect(db.prepare("SELECT value FROM retained_fixture WHERE id = 'before-v27'").get()).toEqual({
      value: "preserved",
    });
    expect(tableNames(db)).toEqual(
      expect.arrayContaining([
        "forward_escape_validation_certificates",
        "forward_escape_projection_events",
      ]),
    );
    expect(
      db
        .prepare("PRAGMA foreign_key_list(forward_escape_projection_events)")
        .all()
        .map((row) => String(row.table)),
    ).toContain("forward_escape_validation_certificates");
    db.close();
  });

  it("migrate repairs missing added columns even when user_version is current", () => {
    const db = openHarnessDb(":memory:");
    db.exec(`
      CREATE TABLE issue_queue (
        issue_queue_id TEXT PRIMARY KEY,
        source_event_id TEXT,
        plan_id TEXT,
        target TEXT,
        title TEXT,
        body TEXT,
        status TEXT,
        human_approval_required INTEGER,
        created_at TEXT
      )
    `);
    db.setUserVersion(SCHEMA_VERSION);

    const result = migrate(db);
    const issueQueueColumns = db
      .prepare("PRAGMA table_info(issue_queue)")
      .all()
      .map((row) => String(row.name));

    expect(result.applied).toBe(true);
    expect(issueQueueColumns).toContain("approved_by");
    expect(issueQueueColumns).toContain("approved_at");
    expect(issueQueueColumns).toContain("external_issue_id");
    expect(issueQueueColumns).toContain("external_issue_url");
    expect(db.userVersion()).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("upsertRow が PK conflict で idempotent (二重適用で重複せず更新)", () => {
    const db = openHarnessDb(":memory:");
    migrate(db);
    const planTable = HARNESS_DB_TABLE_BY_NAME.get("plan_registry");
    if (!planTable) throw new Error("plan_registry が registry に存在しません");
    const pk = primaryKeyOf(planTable);

    const row = {
      plan_id: "PLAN-L7-45-harness-db-foundation",
      kind: "impl",
      layer: "L7",
      status: "draft",
    };
    upsertRow(db, { table: "plan_registry", primaryKey: pk, row });
    upsertRow(db, { table: "plan_registry", primaryKey: pk, row: { ...row, status: "confirmed" } });

    expect(rowCounts(db).plan_registry).toBe(1);
    const stored = db
      .prepare("SELECT status FROM plan_registry WHERE plan_id = ?")
      .get("PLAN-L7-45-harness-db-foundation");
    expect(stored?.status).toBe("confirmed");
    db.close();
  });

  it("upsertRow は primaryKey 列を含まない row を拒否する", () => {
    const db = openHarnessDb(":memory:");
    migrate(db);
    expect(() =>
      upsertRow(db, { table: "plan_registry", primaryKey: "plan_id", row: { kind: "impl" } }),
    ).toThrow();
    db.close();
  });

  it("upsertRow は不正な SQL 識別子 (table/column) を拒否する (injection 防止)", () => {
    const db = openHarnessDb(":memory:");
    migrate(db);
    expect(() =>
      upsertRow(db, {
        table: "plan_registry; DROP TABLE plan_registry",
        primaryKey: "plan_id",
        row: { plan_id: "x" },
      }),
    ).toThrow();
    expect(() =>
      upsertRow(db, {
        table: "plan_registry",
        primaryKey: "plan_id",
        row: { plan_id: "x", "evil)--": "y" },
      }),
    ).toThrow();
    db.close();
  });

  it("assertWithinUtTdd は .ut-tdd 配下と :memory: を許可し外を拒否する", () => {
    const repo = process.cwd();
    expect(() => assertWithinUtTdd(":memory:", repo)).not.toThrow();
    expect(() => assertWithinUtTdd(".ut-tdd/harness.db", repo)).not.toThrow();
    expect(() => assertWithinUtTdd(".ut-tdd/sub/x.db", repo)).not.toThrow();
    expect(() => assertWithinUtTdd("harness.db", repo)).toThrow();
    expect(() => assertWithinUtTdd("../escape.db", repo)).toThrow();
  });

  it("userVersion は setUserVersion と round-trip し負値を拒否する", () => {
    const db = openHarnessDb(":memory:");
    db.setUserVersion(3);
    expect(db.userVersion()).toBe(3);
    expect(() => db.setUserVersion(-1)).toThrow();
    db.close();
  });

  it("schemaDdl は deterministic (同一順序の DDL を返す)", () => {
    expect(schemaDdl()).toEqual(schemaDdl());
    expect(schemaDdl().some((s) => s.startsWith("CREATE TABLE IF NOT EXISTS plan_registry"))).toBe(
      true,
    );
  });
});

/** db status / rebuild (maintenance) — PLAN-L7-45 §4 DoD: runnable・deterministic。 */
describe("IT-DB-01: db status / rebuild maintenance", () => {
  it("harnessDbStatus は未初期化 path で initialized:false を返す (DB を作らない)", () => {
    const repo = mkdtempSync(join(tmpdir(), "utdb-"));
    try {
      const s = harnessDbStatus(repo);
      expect(s.initialized).toBe(false);
      expect(s.tableCount).toBe(0);
      expect(s.expectedVersion).toBe(SCHEMA_VERSION);
    } finally {
      cleanupRepo(repo);
    }
  });

  it("ensureHarnessSchema が schema を適用し harnessDbStatus が報告する (rebuild 冪等)", () => {
    const repo = mkdtempSync(join(tmpdir(), "utdb-"));
    try {
      const r = ensureHarnessSchema(repo);
      expect(r.migration.applied).toBe(true);
      expect(r.migration.tables.length).toBe(HARNESS_DB_TABLES.length);

      const s = harnessDbStatus(repo);
      expect(s.initialized).toBe(true);
      expect(s.schemaVersion).toBe(SCHEMA_VERSION);
      expect(s.tableCount).toBe(HARNESS_DB_TABLES.length);
      expect(s.missingTables).toEqual([]);
      expect(s.totalRows).toBe(0);
      expect(s.orphanTraceEdges).toBe(0);

      const again = ensureHarnessSchema(repo);
      expect(again.migration.applied).toBe(false);
    } finally {
      cleanupRepo(repo);
    }
  });
});
