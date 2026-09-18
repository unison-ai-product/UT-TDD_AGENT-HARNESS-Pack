import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LEDGER_SCHEMA_VERSION,
  ledgerRowDigest,
  ledgerSchemaDdl,
  migratePlanLedger,
  openPlanLedger,
} from "../../src/plan-asset/ledger/schema.ts";
import { openHarnessDb } from "../../src/state-db/index.ts";

describe("PLAN Asset canonical ledger schema", () => {
  it("U-PA-009: enforces active alias and ordinal partial uniqueness", () => {
    const db = openHarnessDb(":memory:");
    try {
      migratePlanLedger(db);
      seedAsset(db, "plan:a");
      seedAsset(db, "plan:b");
      db.prepare("INSERT INTO plan_aliases VALUES (?, ?, ?, ?, ?, ?)").run(
        "alias:a",
        "plan:a",
        "PLAN-L7-1-a",
        1,
        null,
        digest,
      );
      expect(() =>
        db
          .prepare("INSERT INTO plan_aliases VALUES (?, ?, ?, ?, ?, ?)")
          .run("alias:b", "plan:b", "PLAN-L7-1-a", 1, null, digest),
      ).toThrow();
      seedRevision(db, "plan:a", 2);
      db.prepare("UPDATE plan_aliases SET valid_to_revision = ? WHERE alias_id = ?").run(
        2,
        "alias:a",
      );
      db.prepare("INSERT INTO plan_aliases VALUES (?, ?, ?, ?, ?, ?)").run(
        "alias:b",
        "plan:b",
        "PLAN-L7-1-a",
        1,
        null,
        digest,
      );
      for (const invalidVersion of ["", "bad.version"]) {
        expect(() =>
          db
            .prepare(
              "INSERT INTO plan_id_reservation_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              `event:invalid:${invalidVersion}`,
              `reservation:event-invalid:${invalidVersion}`,
              1,
              `command:event-invalid:${invalidVersion}`,
              digest,
              "reserved",
              "PLAN-L7",
              98,
              "plan:a",
              invalidVersion,
              digest,
              now,
              later,
              digest,
            ),
        ).toThrow();
        expect(() =>
          db
            .prepare("INSERT INTO plan_id_reservations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .run(
              `reservation:invalid:${invalidVersion}`,
              "PLAN-L7",
              99,
              "plan:a",
              invalidVersion,
              digest,
              "active",
              now,
              later,
              null,
              digest,
            ),
        ).toThrow();
      }
      db.prepare("INSERT INTO plan_id_reservations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        "reservation:a",
        "PLAN-L7",
        1,
        "plan:a",
        "v2",
        digest,
        "active",
        now,
        later,
        null,
        digest,
      );
      expect(() =>
        db
          .prepare("INSERT INTO plan_id_reservations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(
            "reservation:b",
            "PLAN-L7",
            1,
            "plan:b",
            "v2",
            digest,
            "active",
            now,
            later,
            null,
            digest,
          ),
      ).toThrow();
      db.prepare(
        "UPDATE plan_id_reservations SET status = ?, closed_at = ? WHERE reservation_id = ?",
      ).run("released", now, "reservation:a");
      db.prepare("INSERT INTO plan_id_reservations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        "reservation:b",
        "PLAN-L7",
        1,
        "plan:b",
        "v2",
        digest,
        "active",
        now,
        later,
        null,
        digest,
      );
    } finally {
      db.close();
    }
  });

  it("U-PA-010: makes canonical history append-only and enforces revision FK", () => {
    const db = openHarnessDb(":memory:");
    try {
      migratePlanLedger(db);
      seedAsset(db, "plan:a");
      expect(() =>
        db.exec("UPDATE plan_assets SET identity_algorithm = 'changed' WHERE asset_id = 'plan:a'"),
      ).toThrow();
      expect(() => db.exec("DELETE FROM plan_assets WHERE asset_id = 'plan:a'")).toThrow();
      expect(() =>
        db
          .prepare("INSERT INTO plan_alias_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(
            "event:a",
            "plan:a",
            1,
            "command:a",
            digest,
            "assigned",
            "PLAN-L7-1-a",
            2,
            "test",
            now,
            digest,
          ),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it("U-PA-011: owns a dedicated versioned ledger and fails closed for stale schema", () => {
    const db = openHarnessDb(":memory:");
    try {
      expect(migratePlanLedger(db)).toMatchObject({ ok: true, version: LEDGER_SCHEMA_VERSION });
      expect(migratePlanLedger(db)).toMatchObject({ ok: true, version: LEDGER_SCHEMA_VERSION });
      expect(ledgerSchemaDdl().some((sql) => sql.includes("append-only:plan_assets"))).toBe(true);
      db.exec("DROP TRIGGER trg_plan_assets_no_update");
      expect(migratePlanLedger(db)).toMatchObject({ ok: false, ruleId: "plan-ledger-unavailable" });
      db.setUserVersion(LEDGER_SCHEMA_VERSION + 1);
      expect(migratePlanLedger(db)).toMatchObject({ ok: false, ruleId: "plan-ledger-unavailable" });
    } finally {
      db.close();
    }
    expect(() => openPlanLedger({ repoRoot: process.cwd(), path: "outside.db" })).toThrow(
      /\.ut-tdd/,
    );
    expect(() =>
      openPlanLedger({ repoRoot: process.cwd(), path: join(dirname(process.cwd()), "sibling.db") }),
    ).toThrow(/\.ut-tdd/);
    expect(() =>
      openPlanLedger({ repoRoot: process.cwd(), path: ".ut-tdd/ledger/../../../escape.db" }),
    ).toThrow(/\.ut-tdd/);
  });

  it("U-PA-011: rejects partial and current-version corrupted schemas", () => {
    const partial = openHarnessDb(":memory:");
    try {
      partial.exec("CREATE TABLE plan_assets (asset_id TEXT PRIMARY KEY)");
      expect(migratePlanLedger(partial)).toMatchObject({
        ok: false,
        ruleId: "plan-ledger-unavailable",
      });
    } finally {
      partial.close();
    }
    const corrupt = openHarnessDb(":memory:");
    try {
      corrupt.setUserVersion(LEDGER_SCHEMA_VERSION);
      expect(migratePlanLedger(corrupt)).toMatchObject({
        ok: false,
        ruleId: "plan-ledger-unavailable",
      });
    } finally {
      corrupt.close();
    }

    const rowCorrupt = openHarnessDb(":memory:");
    try {
      createV3Ledger(rowCorrupt);
      seedAsset(rowCorrupt, "plan:corrupt");
      insertReceipt(rowCorrupt, "plan_revision", "plan:corrupt", 1);
      replaceTrigger(rowCorrupt, "trg_append_command_receipts_no_update");
      rowCorrupt.exec(`UPDATE append_command_receipts SET receipt_digest = '${"f".repeat(64)}'`);
      restoreTrigger(rowCorrupt, "trg_append_command_receipts_no_update");
      expect(migratePlanLedger(rowCorrupt)).toEqual({
        ok: false,
        ruleId: "plan-ledger-unavailable",
      });
      expect(rowCorrupt.userVersion()).toBe(3);
      expect(
        rowCorrupt
          .prepare("SELECT name FROM sqlite_master WHERE name = 'plan_draft_journal'")
          .get(),
      ).toBeUndefined();
    } finally {
      rowCorrupt.close();
    }
  });

  it("U-PADM-020: creates admission and durable draft journal tables in v4", () => {
    const db = openHarnessDb(":memory:");
    try {
      expect(migratePlanLedger(db)).toEqual({ ok: true, version: LEDGER_SCHEMA_VERSION });
      const names = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => row.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "plan_admission_events",
          "plan_admission_receipts",
          "plan_draft_journal",
          "plan_draft_journal_events",
        ]),
      );
      expect(() =>
        db.exec("UPDATE plan_admission_events SET event_kind = 'admitted'"),
      ).not.toThrow();
      expect(ledgerSchemaDdl().join("\n")).toContain("append-only:plan_admission_events");
      expect(ledgerSchemaDdl().join("\n")).toContain("append-only:plan_draft_journal_events");
    } finally {
      db.close();
    }
  });

  it("U-PADM-021: fully validates custody v3 before migrating it atomically to v4", () => {
    const db = openHarnessDb(":memory:");
    try {
      createV3Ledger(db);
      seedAsset(db, "plan:a");
      insertReceipt(db, "plan_revision", "plan:a", 1);
      expect(migratePlanLedger(db)).toEqual({ ok: true, version: LEDGER_SCHEMA_VERSION });
      expect(db.userVersion()).toBe(LEDGER_SCHEMA_VERSION);
      expect(db.prepare("SELECT COUNT(*) AS n FROM plan_assets").get()?.n).toBe(1);
      expect(db.prepare("SELECT COUNT(*) AS n FROM append_command_receipts").get()?.n).toBe(1);
      expect(db.prepare("SELECT COUNT(*) AS n FROM plan_draft_journal").get()?.n).toBe(0);
      expect(db.prepare("SELECT COUNT(*) AS n FROM plan_draft_journal_events").get()?.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it("U-PA-REV-BOOT-007: custody v4を検証してbootstrap provenance v5へ原子的に拡張する", () => {
    const db = openHarnessDb(":memory:");
    try {
      createV4Ledger(db);
      seedAsset(db, "plan:a");
      expect(migratePlanLedger(db)).toEqual({ ok: true, version: LEDGER_SCHEMA_VERSION });
      expect(db.userVersion()).toBe(LEDGER_SCHEMA_VERSION);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'legacy_plan_bootstrap_provenance'",
          )
          .get(),
      ).toEqual({ name: "legacy_plan_bootstrap_provenance" });
      expect(ledgerSchemaDdl().join("\n")).toContain(
        "append-only:legacy_plan_bootstrap_provenance",
      );
    } finally {
      db.close();
    }
  });

  it("U-PADM-022: rejects v1, future, partial v2, and corrupt v3 without mutation", () => {
    for (const version of [1, LEDGER_SCHEMA_VERSION + 1]) {
      const db = openHarnessDb(":memory:");
      try {
        db.setUserVersion(version);
        expect(migratePlanLedger(db)).toEqual({ ok: false, ruleId: "plan-ledger-unavailable" });
        expect(db.userVersion()).toBe(version);
      } finally {
        db.close();
      }
    }

    const partial = openHarnessDb(":memory:");
    try {
      partial.exec("CREATE TABLE plan_assets (asset_id TEXT PRIMARY KEY)");
      partial.setUserVersion(2);
      expect(migratePlanLedger(partial)).toEqual({
        ok: false,
        ruleId: "plan-ledger-unavailable",
      });
      expect(partial.userVersion()).toBe(2);
      expect(
        partial.prepare("SELECT name FROM sqlite_master WHERE name = 'plan_draft_journal'").get(),
      ).toBeUndefined();
    } finally {
      partial.close();
    }

    const corrupt = openHarnessDb(":memory:");
    try {
      createV3Ledger(corrupt);
      corrupt.exec("DROP TRIGGER trg_plan_assets_no_update");
      expect(migratePlanLedger(corrupt)).toEqual({
        ok: false,
        ruleId: "plan-ledger-unavailable",
      });
      expect(corrupt.userVersion()).toBe(3);
      expect(
        corrupt.prepare("SELECT name FROM sqlite_master WHERE name = 'plan_draft_journal'").get(),
      ).toBeUndefined();
    } finally {
      corrupt.close();
    }
  });

  it("U-PA-047: atomically upgrades an empty-reservation v2 ledger through v3 to v4", () => {
    const db = openHarnessDb(":memory:");
    try {
      for (const ddl of legacyV2Ddl()) db.exec(ddl);
      db.setUserVersion(2);
      seedAsset(db, "plan:a");
      expect(LEDGER_SCHEMA_VERSION).toBe(7);
      expect(migratePlanLedger(db)).toEqual({ ok: true, version: LEDGER_SCHEMA_VERSION });
      expect(
        db
          .prepare("PRAGMA table_info(plan_id_reservation_events)")
          .all()
          .map((column) => column.name),
      ).toContain("lease_key_version");
      expect(migratePlanLedger(db)).toEqual({ ok: true, version: LEDGER_SCHEMA_VERSION });
    } finally {
      db.close();
    }
  });

  it("U-PADM-065: v5 ledgerへappend-only artifact cleanup operation schemaを原子的に追加する", () => {
    const db = openHarnessDb(":memory:");
    try {
      expect(migratePlanLedger(db)).toEqual({ ok: true, version: 7 });
      dropV7Objects(db);
      db.exec("DROP TRIGGER trg_plan_draft_artifact_operation_events_no_update");
      db.exec("DROP TRIGGER trg_plan_draft_artifact_operation_events_no_delete");
      db.exec("DROP INDEX idx_plan_draft_artifact_operations_command");
      db.exec("DROP TABLE plan_draft_artifact_operation_events");
      db.setUserVersion(5);

      expect(migratePlanLedger(db)).toEqual({ ok: true, version: 7 });
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name = 'plan_draft_artifact_operation_events'",
          )
          .get()?.name,
      ).toBe("plan_draft_artifact_operation_events");
    } finally {
      db.close();
    }
  });

  it.each([
    4, 5,
  ] as const)("U-PADM-067: committed journalを保持したv%s ledgerへlegacy_unknown証跡をbackfillする", (version) => {
    const db = openHarnessDb(":memory:");
    try {
      createLegacyCommittedLedger(db, version);
      const before = db.prepare("SELECT * FROM plan_draft_journal").get();

      expect(migratePlanLedger(db)).toEqual({ ok: true, version: 7 });
      expect(db.prepare("SELECT * FROM plan_draft_journal").get()).toEqual(before);
      const operations = db
        .prepare(
          `SELECT sequence, event_kind, command_payload_digest, previous_event_digest
             FROM plan_draft_artifact_operation_events ORDER BY sequence`,
        )
        .all();
      expect(operations).toHaveLength(1);
      expect(operations[0]).toMatchObject({
        sequence: 1,
        event_kind: "legacy_unknown",
        command_payload_digest: digest,
        previous_event_digest: null,
      });
      const operation = JSON.parse(
        String(
          db.prepare("SELECT operation_json FROM plan_draft_artifact_operation_events").get()
            ?.operation_json,
        ),
      );
      expect(operation).toEqual({
        operation: "legacy_unknown",
        sourceSchemaVersion: version,
        journalDigest: before?.journal_digest,
        latestJournalEventDigest: db
          .prepare("SELECT event_digest FROM plan_draft_journal_events ORDER BY sequence DESC")
          .get()?.event_digest,
        reason: "旧schemaにはartifact cleanup provenanceが存在せず完了状態を証明できない",
      });
      expect(migratePlanLedger(db)).toEqual({ ok: true, version: 7 });
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM plan_draft_artifact_operation_events").get()?.n,
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  it.each([
    4, 5,
  ] as const)("U-PADM-068: digest改竄されたv%s committed journalを移行せず原schemaに留める", (version) => {
    const db = openHarnessDb(":memory:");
    try {
      createLegacyCommittedLedger(db, version);
      db.exec("UPDATE plan_draft_journal SET requested_source_path = 'tampered.md'");
      expect(migratePlanLedger(db)).toEqual({
        ok: false,
        ruleId: "plan-ledger-unavailable",
      });
      expect(db.userVersion()).toBe(version);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name = 'plan_draft_artifact_operation_events'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("U-PADM-070: digestを再計算したlegacy_unknown provenance差替えもjournal束縛で拒否する", () => {
    const db = openHarnessDb(":memory:");
    try {
      createLegacyCommittedLedger(db, 5);
      expect(migratePlanLedger(db)).toEqual({ ok: true, version: 7 });
      db.exec("DROP TRIGGER trg_plan_draft_artifact_operation_events_no_update");
      const current = db.prepare("SELECT * FROM plan_draft_artifact_operation_events").get();
      if (!current) throw new Error("legacy_unknown fixture missing");
      const operation = JSON.parse(String(current.operation_json));
      operation.journalDigest = "f".repeat(64);
      const operationJson = JSON.stringify(operation);
      const changed = {
        ...current,
        operation_json: operationJson,
        operation_digest: createHash("sha256").update(operationJson).digest("hex"),
      };
      db.prepare(
        `UPDATE plan_draft_artifact_operation_events
         SET operation_json = ?, operation_digest = ?, event_digest = ?
         WHERE operation_event_id = ?`,
      ).run(
        changed.operation_json,
        changed.operation_digest,
        ledgerRowDigest(changed, "event_digest"),
        current.operation_event_id,
      );
      restoreTrigger(db, "trg_plan_draft_artifact_operation_events_no_update");

      expect(migratePlanLedger(db)).toEqual({
        ok: false,
        ruleId: "plan-ledger-unavailable",
      });
    } finally {
      db.close();
    }
  });

  it("U-PA-047: leaves a nonempty hash-only v2 ledger untouched without a custody manifest", () => {
    const db = openHarnessDb(":memory:");
    try {
      for (const ddl of legacyV2Ddl()) db.exec(ddl);
      db.setUserVersion(2);
      seedAsset(db, "plan:a");
      db.prepare(
        `INSERT INTO plan_id_reservation_events
          (reservation_event_id, reservation_id, sequence, command_id,
           command_payload_digest, event_kind, namespace, ordinal, asset_id,
           lease_token_hash, occurred_at, expires_at, event_digest)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "reservation:a:event:1",
        "reservation:a",
        1,
        "command:a",
        digest,
        "reserved",
        "PLAN-L7",
        418,
        "plan:a",
        digest,
        now,
        later,
        digest,
      );
      expect(migratePlanLedger(db)).toEqual({ ok: false, ruleId: "plan-ledger-unavailable" });
      expect(db.userVersion()).toBe(2);
      expect(
        db.prepare("SELECT lease_token_hash FROM plan_id_reservation_events").get()
          ?.lease_token_hash,
      ).toBe(digest);
    } finally {
      db.close();
    }
  });

  it("U-PA-047: rolls an interrupted v2-to-v3 schema migration back byte-for-byte", () => {
    const db = openHarnessDb(":memory:");
    try {
      for (const ddl of legacyV2Ddl()) db.exec(ddl);
      db.setUserVersion(2);
      seedAsset(db, "plan:a");
      const before = migrationSnapshot(db);
      expect(
        migratePlanLedger(db, {
          fault: {
            after(boundary) {
              if (boundary === "v2-v3-tables-created") throw new Error("migration-fault");
            },
          },
        }),
      ).toEqual({ ok: false, ruleId: "plan-ledger-unavailable" });
      expect(migrationSnapshot(db)).toBe(before);
      expect(db.userVersion()).toBe(2);
    } finally {
      db.close();
    }
  });

  it("U-PA-047: rolls an interrupted admission v4 extension back to the original v2 ledger", () => {
    const db = openHarnessDb(":memory:");
    try {
      for (const ddl of legacyV2Ddl()) db.exec(ddl);
      db.setUserVersion(2);
      seedAsset(db, "plan:a");
      const before = migrationSnapshot(db);
      expect(
        migratePlanLedger(db, {
          fault: {
            after(boundary) {
              if (boundary === "v2-v4-schema-created") throw new Error("migration-fault");
            },
          },
        }),
      ).toEqual({ ok: false, ruleId: "plan-ledger-unavailable" });
      expect(migrationSnapshot(db)).toBe(before);
      expect(db.userVersion()).toBe(2);
    } finally {
      db.close();
    }
  });

  it("U-PA-012: constrains global receipt subjects to real plan revisions", () => {
    const db = openHarnessDb(":memory:");
    try {
      migratePlanLedger(db);
      seedAsset(db, "plan:a");
      expect(() => insertReceipt(db, "plan_revision", "missing", 1)).toThrow();
      expect(() => insertReceipt(db, "reservation", "plan:a", 1)).toThrow();
      insertReceipt(db, "plan_revision", "plan:a", 1);
    } finally {
      db.close();
    }
  });

  it("U-PA-013: rejects a digest-tampered current ledger", () => {
    const db = openHarnessDb(":memory:");
    try {
      migratePlanLedger(db);
      seedAsset(db, "plan:a");
      insertReceipt(db, "plan_revision", "plan:a", 1);
      expect(migratePlanLedger(db)).toMatchObject({ ok: true });
      db.exec("DROP TRIGGER trg_append_command_receipts_no_update");
      db.exec(
        "UPDATE append_command_receipts SET receipt_digest = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'",
      );
      const trigger = ledgerSchemaDdl().find((sql) =>
        sql.includes("trg_append_command_receipts_no_update"),
      );
      if (!trigger) throw new Error("fixture trigger missing");
      db.exec(trigger);
      expect(migratePlanLedger(db)).toMatchObject({
        ok: false,
        ruleId: "plan-ledger-unavailable",
      });
    } finally {
      db.close();
    }
  });

  it("U-PA-013: rejects event, revision, and reduction projection tampering", () => {
    expect(() =>
      expectTamperRejected(
        (db) => seedAliasReduction(db, "plan:a"),
        (db) => db.exec("UPDATE plan_aliases SET alias = 'PLAN-L7-tampered'"),
      ),
    ).not.toThrow();
    expect(() =>
      expectTamperRejected(
        (db) => seedAliasReduction(db, "plan:a"),
        (db) => {
          replaceTrigger(db, "trg_plan_alias_events_no_update");
          db.exec("UPDATE plan_alias_events SET reason = 'tampered'");
          restoreTrigger(db, "trg_plan_alias_events_no_update");
        },
      ),
    ).not.toThrow();
    expect(() =>
      expectTamperRejected(
        (db) => seedAsset(db, "plan:a"),
        (db) => {
          replaceTrigger(db, "trg_plan_revisions_no_update");
          db.exec("UPDATE plan_revisions SET canonical_payload_json = '{\"tampered\":true}'");
          restoreTrigger(db, "trg_plan_revisions_no_update");
        },
      ),
    ).not.toThrow();
  });

  it("U-PA-023/028/029: separates derived identity from an adopted revision target", () => {
    const db = openHarnessDb(":memory:");
    try {
      migratePlanLedger(db);
      expect(() => insertMigrationEvent(db, "pending", null, null, "pending")).not.toThrow();
      expect(() => insertMigrationEvent(db, "rejected", null, null, "rejected")).not.toThrow();
      expect(() => insertMigrationEvent(db, "migrated", null, null, "missing-target")).toThrow();
      expect(() =>
        insertMigrationEvent(db, "migrated", "plan:missing", 1, "phantom-target"),
      ).toThrow();
      seedAsset(db, "plan:adopted");
      expect(() =>
        insertMigrationEvent(db, "migrated", "plan:adopted", 1, "adopted"),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });
});

const digest = "a".repeat(64);
const commit = "b".repeat(40);
const now = "2026-07-13T00:00:00Z";
const later = "2026-07-14T00:00:00Z";

function createV3Ledger(db: ReturnType<typeof openHarnessDb>): void {
  const v3Ddl = ledgerSchemaDdl().filter(
    (sql) =>
      !sql.includes("plan_admission_") &&
      !sql.includes("plan_draft_journal") &&
      !sql.includes("idx_plan_draft_journal_status") &&
      !sql.includes("legacy_plan_bootstrap_provenance") &&
      !sql.includes("idx_legacy_bootstrap_source_blob") &&
      !sql.includes("plan_draft_artifact_operation_events") &&
      !sql.includes("idx_plan_draft_artifact_operations_command") &&
      !sql.includes("genesis_issue_custody") &&
      !sql.includes("sealed_plan_lineages") &&
      !sql.includes("idx_sealed_lineages_") &&
      !sql.includes("plan_lineage_migration_certificates"),
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const sql of v3Ddl) db.exec(sql);
    db.setUserVersion(3);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function createV4Ledger(db: ReturnType<typeof openHarnessDb>): void {
  const v4Ddl = ledgerSchemaDdl().filter(
    (sql) =>
      !sql.includes("legacy_plan_bootstrap_provenance") &&
      !sql.includes("idx_legacy_bootstrap_source_blob") &&
      !sql.includes("plan_draft_artifact_operation_events") &&
      !sql.includes("idx_plan_draft_artifact_operations_command") &&
      !sql.includes("genesis_issue_custody") &&
      !sql.includes("sealed_plan_lineages") &&
      !sql.includes("idx_sealed_lineages_") &&
      !sql.includes("plan_lineage_migration_certificates"),
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const sql of v4Ddl) db.exec(sql);
    db.setUserVersion(4);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function createLegacyCommittedLedger(db: ReturnType<typeof openHarnessDb>, version: 4 | 5): void {
  expect(migratePlanLedger(db)).toEqual({ ok: true, version: 7 });
  dropV7Objects(db);
  db.exec("DROP TRIGGER trg_plan_draft_artifact_operation_events_no_update");
  db.exec("DROP TRIGGER trg_plan_draft_artifact_operation_events_no_delete");
  db.exec("DROP INDEX idx_plan_draft_artifact_operations_command");
  db.exec("DROP TABLE plan_draft_artifact_operation_events");
  if (version === 4) {
    db.exec("DROP TRIGGER trg_legacy_plan_bootstrap_provenance_no_update");
    db.exec("DROP TRIGGER trg_legacy_plan_bootstrap_provenance_no_delete");
    db.exec("DROP INDEX idx_legacy_bootstrap_source_blob");
    db.exec("DROP TABLE legacy_plan_bootstrap_provenance");
  }
  const eventBase = {
    journal_event_id: "journal:legacy:event:1",
    command_id: "command:legacy-committed",
    sequence: 1,
    command_payload_digest: digest,
    event_kind: "committed",
    requested_plan_id: "PLAN-L7-legacy",
    requested_source_path: "docs/plans/PLAN-L7-legacy.md",
    plan_asset_id: null,
    plan_revision: null,
    certificate_id: null,
    occurred_at: now,
    failure_reason: null,
    previous_event_digest: null,
  };
  db.prepare(
    "INSERT INTO plan_draft_journal_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(...Object.values(eventBase), ledgerRowDigest(eventBase, "event_digest"));
  const current = {
    journal_id: "journal:legacy",
    command_id: eventBase.command_id,
    command_payload_digest: digest,
    status: "committed",
    requested_plan_id: eventBase.requested_plan_id,
    requested_source_path: eventBase.requested_source_path,
    plan_asset_id: null,
    plan_revision: null,
    certificate_id: null,
    intent_recorded_at: now,
    completed_at: now,
    failure_reason: null,
  };
  db.prepare("INSERT INTO plan_draft_journal VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    ...Object.values(current),
    ledgerRowDigest(current, "journal_digest"),
  );
  db.setUserVersion(version);
}

function insertMigrationEvent(
  db: ReturnType<typeof openHarnessDb>,
  decision: "pending" | "migrated" | "rejected",
  targetAssetId: string | null,
  targetRevision: number | null,
  suffix: string,
): void {
  const pending = decision === "pending";
  const rejected = decision === "rejected";
  db.prepare(
    `INSERT INTO legacy_plan_migration_events (
      migration_event_id, legacy_plan_id, sequence, command_id, command_payload_digest,
      event_kind, asset_id, target_asset_id, target_revision, decision, resolved_alias,
      collision_group, loss_fields_json, reason, review_plan_id, repository_identity,
      identity_algorithm, identity_input_json, identity_digest, identity_config_path,
      identity_config_blob_oid, identity_config_content_digest, identity_config_receipt_digest,
      source_digest, occurred_at, event_digest
    ) VALUES (${Array.from({ length: 26 }, () => "?").join(",")})`,
  ).run(
    `migration-event:${suffix}`,
    `PLAN-L7-${suffix}`,
    1,
    `command:${suffix}`,
    digest,
    "observed",
    `plan:derived:${suffix}`,
    targetAssetId,
    targetRevision,
    decision,
    decision === "migrated" ? `PLAN-L7-${suffix}` : null,
    null,
    rejected ? '["loss"]' : "[]",
    "test",
    pending || rejected ? "PLAN-L7-418-review" : null,
    "owner/repository",
    "ut-tdd-plan-legacy-v1",
    "[]",
    digest,
    "ut-tdd.project.json",
    commit,
    digest,
    digest,
    digest,
    now,
    digest,
  );
}

function seedAsset(db: ReturnType<typeof openHarnessDb>, assetId: string): void {
  db.prepare("INSERT INTO plan_assets VALUES (?, ?, ?, ?)").run(assetId, now, commit, "test");
  seedRevision(db, assetId, 1);
}

function seedRevision(
  db: ReturnType<typeof openHarnessDb>,
  assetId: string,
  revision: number,
): void {
  db.prepare("INSERT INTO plan_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    assetId,
    revision,
    "{}",
    createHash("sha256").update("{}").digest("hex"),
    digest,
    "docs/plans/test.md",
    commit,
    "test",
    "test",
    now,
  );
}

function insertReceipt(
  db: ReturnType<typeof openHarnessDb>,
  kind: "plan_revision" | "reservation",
  assetId: string,
  revision: number,
): void {
  const row = {
    command_id: `command:${kind}:${assetId}`,
    command_type: "test",
    subject_kind: kind,
    subject_key: assetId,
    plan_asset_id: assetId,
    plan_revision: revision,
    command_payload_digest: digest,
    result_kind: "event",
    result_ref: "event:test",
    recorded_at: now,
  };
  db.prepare("INSERT INTO append_command_receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    ...Object.values(row),
    ledgerRowDigest(row, "receipt_digest"),
  );
}

function seedAliasReduction(db: ReturnType<typeof openHarnessDb>, assetId: string): void {
  seedAsset(db, assetId);
  const event = {
    alias_event_id: `alias-event:${assetId}`,
    asset_id: assetId,
    sequence: 1,
    command_id: `alias-command:${assetId}`,
    command_payload_digest: digest,
    event_kind: "assigned",
    alias: "PLAN-L7-1-a",
    revision: 1,
    reason: "test",
    occurred_at: now,
  };
  const eventDigest = ledgerRowDigest(event, "event_digest");
  db.prepare("INSERT INTO plan_alias_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    ...Object.values(event),
    eventDigest,
  );
  db.prepare("INSERT INTO plan_aliases VALUES (?, ?, ?, ?, ?, ?)").run(
    `alias:${assetId}`,
    assetId,
    event.alias,
    1,
    null,
    eventDigest,
  );
}

function expectTamperRejected(
  setup: (db: ReturnType<typeof openHarnessDb>) => void,
  tamper: (db: ReturnType<typeof openHarnessDb>) => void,
): void {
  const db = openHarnessDb(":memory:");
  try {
    migratePlanLedger(db);
    setup(db);
    expect(migratePlanLedger(db)).toMatchObject({ ok: true });
    tamper(db);
    expect(migratePlanLedger(db)).toMatchObject({
      ok: false,
      ruleId: "plan-ledger-unavailable",
    });
  } finally {
    db.close();
  }
}

function replaceTrigger(db: ReturnType<typeof openHarnessDb>, name: string): void {
  db.exec(`DROP TRIGGER ${name}`);
}

function restoreTrigger(db: ReturnType<typeof openHarnessDb>, name: string): void {
  const trigger = ledgerSchemaDdl().find((sql) => sql.includes(name));
  if (!trigger) throw new Error(`fixture trigger missing: ${name}`);
  db.exec(trigger);
}

// v7 (sealed lineage) のオブジェクトを旧版 fixture から落とす共通 helper
function dropV7Objects(db: ReturnType<typeof openHarnessDb>): void {
  for (const table of [
    "plan_lineage_migration_certificates",
    "sealed_plan_lineages",
    "genesis_issue_custody",
  ]) {
    db.exec(`DROP TRIGGER trg_${table}_no_update`);
    db.exec(`DROP TRIGGER trg_${table}_no_delete`);
    db.exec(`DROP TABLE ${table}`);
  }
}

function legacyV2Ddl(): readonly string[] {
  return ledgerSchemaDdl()
    .filter(
      (sql) =>
        !sql.includes("plan_admission_") &&
        !sql.includes("plan_draft_journal") &&
        !sql.includes("idx_plan_draft_journal_status") &&
        !sql.includes("legacy_plan_bootstrap_provenance") &&
        !sql.includes("idx_legacy_bootstrap_source_blob") &&
        !sql.includes("plan_draft_artifact_operation_events") &&
        !sql.includes("idx_plan_draft_artifact_operations_command") &&
        !sql.includes("genesis_issue_custody") &&
        !sql.includes("sealed_plan_lineages") &&
        !sql.includes("idx_sealed_lineages_") &&
        !sql.includes("plan_lineage_migration_certificates"),
    )
    .map((sql) =>
      sql
        .replace(/lease_key_version TEXT NOT NULL,\s*/g, "")
        .replace(/,\s*CHECK \(lease_key_version != ''\)/g, "")
        .replace(/,\s*CHECK \(INSTR\(lease_key_version, '\.'\) = 0\)/g, ""),
    );
}

function migrationSnapshot(db: ReturnType<typeof openHarnessDb>): string {
  return JSON.stringify({
    version: db.userVersion(),
    schema: db
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all(),
    assets: db.prepare("SELECT * FROM plan_assets ORDER BY asset_id").all(),
    revisions: db.prepare("SELECT * FROM plan_revisions ORDER BY asset_id, revision").all(),
  });
}
