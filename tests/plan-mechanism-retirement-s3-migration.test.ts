import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../src/state-db/migration.ts";
import { rebuildHarnessDb } from "../src/state-db/projection-writer.ts";
import {
  BASE_COMMIT,
  CATALOG_PATHS,
  cleanupPlanretS3MigrationFixtures,
  createIssueOnlyCatalogFixture,
  createLegacyDatabase,
  createTrackedIssueFixture,
  DROP_SENTINEL,
  databaseState,
  EDGE_TABLE,
  edgeTableSql,
  frozenSchema,
  ISSUE_LEDGER_PATH,
  ISSUE_URL,
  isTargetTableDrop,
  nonTargetState,
  tableRows,
  withDbExec,
} from "./support/plan-mechanism-retirement-s3-migration.ts";

afterEach(cleanupPlanretS3MigrationFixtures);

describe("CANDIDATE-U-PLANRET-019 frozen v29 migration", () => {
  it("precondition: frozen v29 fixture and seed contain the exact legacy state", () => {
    const fixture = frozenSchema();
    const { db } = createLegacyDatabase();
    try {
      const state = databaseState(db);
      const edgeDdl = edgeTableSql(db);
      expect(fixture.baseCommit).toBe(BASE_COMMIT);
      expect(fixture.ddlSha256).toBe(
        createHash("sha256").update(JSON.stringify(fixture.schemaDdls), "utf8").digest("hex"),
      );
      expect(fixture.schemaDdls.length).toBeGreaterThan(0);
      // 全 DDL が流れたこと (黙って飛ばされた DDL を通さない)。
      const countDdl = (pattern: RegExp) =>
        fixture.schemaDdls.filter((ddl) => pattern.test(ddl)).length;
      const tableDdls = countDdl(/^\s*CREATE\s+TABLE\b/i);
      const indexDdls = countDdl(/^\s*CREATE\s+(UNIQUE\s+)?INDEX\b/i);
      const objectCount = (type: "table" | "index") =>
        (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'",
            )
            .get(type) as { n: number }
        ).n;
      expect(tableDdls).toBeGreaterThan(0);
      expect(indexDdls).toBeGreaterThan(0);
      expect(objectCount("table")).toBe(tableDdls);
      expect(objectCount("index")).toBe(indexDdls);
      expect(db.userVersion()).toBe(29);
      expect(edgeDdl).toContain("plan_id");
      expect(edgeDdl).not.toContain("issue");
      expect(db.prepare("SELECT plan_id FROM plan_registry ORDER BY plan_id").all()).toEqual([
        { plan_id: "PLAN-L6-01" },
        { plan_id: "PLAN-L6-02" },
      ]);
      expect(tableRows(db, EDGE_TABLE)).toHaveLength(1);
      expect(state.rows.vmodel_categories).toHaveLength(1);
      expect(state.rows.vmodel_semantic_items).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("(1): migrate changes target definition and preserves both PLAN rows", () => {
    const { db } = createLegacyDatabase();
    try {
      const result = migrate(db);
      const edgeDdl = edgeTableSql(db);
      const observation = {
        fromVersion: result.fromVersion,
        applied: result.applied,
        toVersion: result.toVersion,
        hasLegacyPlanId: edgeDdl.includes("plan_id"),
        hasPlanRegistryForeignKey: edgeDdl.includes("REFERENCES plan_registry"),
        hasIssueColumn: edgeDdl.includes("issue"),
        hasIssueRequiredForDefer: /CHECK[\s\S]*defer[\s\S]*issue IS NOT NULL/.test(edgeDdl),
        planRows: db.prepare("SELECT plan_id FROM plan_registry ORDER BY plan_id").all(),
      };
      expect(observation).toEqual({
        fromVersion: 29,
        applied: true,
        toVersion: expect.any(Number),
        hasLegacyPlanId: false,
        hasPlanRegistryForeignKey: false,
        hasIssueColumn: true,
        hasIssueRequiredForDefer: true,
        planRows: [{ plan_id: "PLAN-L6-01" }, { plan_id: "PLAN-L6-02" }],
      });
      expect(observation.toVersion).toBeGreaterThan(29);
    } finally {
      db.close();
    }
  });

  it("precondition (2): issue-only catalog is a complete tracked fixture", () => {
    const { root, receipts } = createTrackedIssueFixture();
    const ledger = readFileSync(`${root}/${ISSUE_LEDGER_PATH}`, "utf8");
    const tracked = execFileSync("git", ["-C", root, "ls-files", "--", "docs/governance"], {
      encoding: "utf8",
    })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    expect(receipts).toHaveLength(CATALOG_PATHS.length);
    expect(tracked.sort()).toEqual([...CATALOG_PATHS].sort());
    expect(ledger).toContain("| issue |");
    expect(ledger).toContain(ISSUE_URL);
    expect(ledger).not.toContain("| plan_id |");
  });

  it("(2): issue-only catalog rebuild has no exception and projects one edge", () => {
    const { root, db } = createLegacyDatabase();
    try {
      createIssueOnlyCatalogFixture(root);
      let thrown: unknown;
      try {
        rebuildHarnessDb({ repoRoot: root, db, skipTokenTelemetry: true });
      } catch (error) {
        thrown = error;
      }
      const columns = db
        .prepare(`PRAGMA table_info(${EDGE_TABLE})`)
        .all()
        .map((row) => row.name);
      const hasIssue = columns.includes("issue");
      const projected = hasIssue
        ? db
            .prepare(
              `SELECT edge_id, item_id, target_status, issue FROM ${EDGE_TABLE} ORDER BY edge_id`,
            )
            .all()
        : [];
      let invalidDeferRejectedByCheck = false;
      db.prepare(`DELETE FROM ${EDGE_TABLE} WHERE edge_id = ?`).run("ITEM-TARGET-019");
      try {
        db.prepare(
          `INSERT INTO ${EDGE_TABLE}
            (edge_id, item_id, target_status, target_kind, target_ref, issue, reason, source_digest)
            VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
        ).run(
          "INVALID-DEFER-NULL-ISSUE",
          "ITEM-PLANRET-019",
          "defer",
          "target_slot",
          "DOC-L0-CHARTER",
          "invalid defer without issue",
          "digest-invalid-defer",
        );
      } catch (error) {
        invalidDeferRejectedByCheck =
          error instanceof Error && /CHECK constraint failed/.test(error.message);
      }
      const observation = {
        thrown:
          thrown === undefined ? null : thrown instanceof Error ? thrown.message : String(thrown),
        hasIssue,
        hasPlanId: columns.includes("plan_id"),
        projected,
        invalidDeferRejectedByCheck,
      };
      expect(observation).toEqual({
        thrown: null,
        hasIssue: true,
        hasPlanId: false,
        projected: [
          {
            edge_id: "ITEM-TARGET-019",
            item_id: "ITEM-PLANRET-019",
            target_status: "defer",
            issue: ISSUE_URL,
          },
        ],
        invalidDeferRejectedByCheck: true,
      });
    } finally {
      db.close();
    }
  }, 60000); // 24.1s measured (Windows), #1063

  it("(3): re-migrate is unapplied and leaves complete state unchanged", () => {
    const { root, db } = createLegacyDatabase();
    try {
      const first = migrate(db);
      createIssueOnlyCatalogFixture(root);
      let rebuildThrown: unknown;
      try {
        rebuildHarnessDb({ repoRoot: root, db, skipTokenTelemetry: true });
      } catch (error) {
        rebuildThrown = error;
      }
      const afterRebuild = databaseState(db);
      const projectedRowCount = tableRows(db, EDGE_TABLE).length;
      const second = migrate(db);
      const afterSecond = databaseState(db);
      expect({
        firstApplied: first.applied,
        rebuildThrown:
          rebuildThrown === undefined
            ? null
            : rebuildThrown instanceof Error
              ? rebuildThrown.message
              : String(rebuildThrown),
        projectedRowCount,
        secondApplied: second.applied,
        sameState: JSON.stringify(afterSecond) === JSON.stringify(afterRebuild),
      }).toEqual({
        firstApplied: true,
        rebuildThrown: null,
        projectedRowCount: 1,
        secondApplied: false,
        sameState: true,
      });
    } finally {
      db.close();
    }
  }, 120000); // 36.4s measured (Windows), #1063

  it("precondition (5): delegated DROP sentinel fires after quoted IF EXISTS target DROP", () => {
    const { db } = createLegacyDatabase();
    try {
      let dropSentinelFired = false;
      const wrapped = withDbExec(db, (sql) => {
        db.exec(sql);
        if (isTargetTableDrop(sql)) {
          dropSentinelFired = true;
          throw new Error(DROP_SENTINEL);
        }
      });
      db.exec("BEGIN");
      try {
        wrapped.exec("CREATE TABLE exec_wrapper_probe (value TEXT)");
        expect(
          db.prepare("SELECT name FROM sqlite_master WHERE name = ?").get("exec_wrapper_probe"),
        ).toEqual({ name: "exec_wrapper_probe" });
        expect(() => wrapped.exec(`DROP TABLE IF EXISTS "${EDGE_TABLE}"`)).toThrow(DROP_SENTINEL);
        expect(dropSentinelFired).toBe(true);
      } finally {
        db.exec("ROLLBACK");
      }
      expect(edgeTableSql(db)).toContain(EDGE_TABLE);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name = ?").get("exec_wrapper_probe"),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  }, 60000); // 26.7s measured (Windows), #1063

  it("(5): post-DROP failure preserves exact legacy schema, version, and rows", () => {
    const { db } = createLegacyDatabase();
    try {
      const before = databaseState(db);
      let dropSentinelFired = false;
      const wrapped = withDbExec(db, (sql) => {
        db.exec(sql);
        if (!dropSentinelFired && isTargetTableDrop(sql)) {
          dropSentinelFired = true;
          throw new Error(DROP_SENTINEL);
        }
      });
      let thrown: unknown;
      try {
        migrate(wrapped);
      } catch (error) {
        thrown = error;
      }
      expect({
        dropSentinelFired,
        thrown:
          thrown === undefined ? null : thrown instanceof Error ? thrown.message : String(thrown),
        sameState: JSON.stringify(databaseState(db)) === JSON.stringify(before),
      }).toEqual({ dropSentinelFired: true, thrown: DROP_SENTINEL, sameState: true });
    } finally {
      db.close();
    }
  });

  it("(5): successful migrate changes only target rows and preserves unrelated state", () => {
    const { db } = createLegacyDatabase();
    try {
      const before = databaseState(db);
      const result = migrate(db);
      const after = databaseState(db);
      // v31 の対象表でも、取り除く CHECK 以外の定義・索引・行を引き続き照合する。
      const expectedObjects = nonTargetState(before).objects.map((object) => {
        if (object.name !== "document_scale_profile_entries" || typeof object.sql !== "string") {
          return object;
        }
        return {
          ...object,
          sql: object.sql.replace(
            ",\n  CHECK ((NOT (decision = 'defer')) OR (required_plan_id IS NOT NULL))",
            "",
          ),
        };
      });
      const observation = {
        applied: result.applied,
        toVersion: result.toVersion,
        oldRowsRemoved: tableRows(db, EDGE_TABLE).length === 0,
        unrelatedObjectsUnchanged:
          JSON.stringify(nonTargetState(after).objects) === JSON.stringify(expectedObjects),
        unrelatedRowsUnchanged:
          JSON.stringify(nonTargetState(after).rows) ===
          JSON.stringify(nonTargetState(before).rows),
      };
      expect(observation).toEqual({
        applied: true,
        toVersion: expect.any(Number),
        oldRowsRemoved: true,
        unrelatedObjectsUnchanged: true,
        unrelatedRowsUnchanged: true,
      });
      expect(observation.toVersion).toBeGreaterThan(29);
    } finally {
      db.close();
    }
  }, 60000); // 21.1s measured (Windows), #1063

  it("precondition (4): isolated rebuild reaches its outer-commit path", () => {
    const { root, db } = createLegacyDatabase();
    try {
      expect(rebuildHarnessDb({ repoRoot: root, db, skipTokenTelemetry: true }).ok).toBe(true);
    } finally {
      db.close();
    }
  }, 60000); // 24.3s measured (Windows), #1063

  it("precondition (4): wrapper fires at the post-projection COMMIT", () => {
    const { root, db } = createLegacyDatabase();
    try {
      let projectionStarted = false;
      let sentinelFired = false;
      const wrapped = withDbExec(
        db,
        (sql) => {
          if (sql.trim().toUpperCase() === "COMMIT" && projectionStarted && !sentinelFired) {
            sentinelFired = true;
            throw new Error("planret-019-final-outer-commit");
          }
          db.exec(sql);
        },
        (sql) => {
          if (/^\s*(DELETE|INSERT|UPDATE)\b/i.test(sql)) projectionStarted = true;
          return db.prepare(sql);
        },
      );
      let thrown: unknown;
      try {
        rebuildHarnessDb({ repoRoot: root, db: wrapped, skipTokenTelemetry: true });
      } catch (error) {
        thrown = error;
      }
      expect(projectionStarted).toBe(true);
      expect(sentinelFired).toBe(true);
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe("planret-019-final-outer-commit");
    } finally {
      db.close();
    }
  }, 60000); // 30.0s measured (Windows), #1063

  it("(4): outer rebuild COMMIT failure restores schema, version, and all rows", () => {
    const { root, db } = createLegacyDatabase();
    try {
      const before = databaseState(db);
      let rebuildStarted = false;
      let sentinelFired = false;
      let schemaVersionRaised = false;
      const wrapped = withDbExec(
        db,
        (sql) => {
          if (sql.trim().toUpperCase() === "COMMIT" && rebuildStarted && !sentinelFired) {
            sentinelFired = true;
            throw new Error("planret-019-final-outer-commit");
          }
          db.exec(sql);
        },
        (sql) => {
          if (/^\s*(DELETE|INSERT|UPDATE)\b/i.test(sql)) rebuildStarted = true;
          return db.prepare(sql);
        },
        (version) => {
          db.setUserVersion(version);
          if (version > 29) schemaVersionRaised = true;
        },
      );
      let thrown: unknown;
      try {
        rebuildHarnessDb({ repoRoot: root, db: wrapped, skipTokenTelemetry: true });
      } catch (error) {
        thrown = error;
      }
      expect({
        rebuildStarted,
        schemaVersionRaised,
        sentinelFired,
        thrown:
          thrown === undefined ? null : thrown instanceof Error ? thrown.message : String(thrown),
        sameState: JSON.stringify(databaseState(db)) === JSON.stringify(before),
      }).toEqual({
        rebuildStarted: true,
        schemaVersionRaised: true,
        sentinelFired: true,
        thrown: "planret-019-final-outer-commit",
        sameState: true,
      });
    } finally {
      db.close();
    }
  }, 60000); // 28.1s measured (Windows), #1063
});
