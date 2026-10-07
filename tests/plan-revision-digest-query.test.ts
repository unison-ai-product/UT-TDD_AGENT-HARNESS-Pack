import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readPlanRevisionCanonicalPayloadDigest,
  setPlanRevisionDigestQueryTestHook,
} from "../src/plan-asset/ledger/plan-revision-digest-query.ts";
import {
  type AppendPlanRevisionInput,
  PlanRevisionLedgerTransaction,
} from "../src/plan-asset/ledger/plan-revision-ledger.ts";
import {
  ledgerRowDigest,
  migratePlanLedger,
  openPlanLedger,
} from "../src/plan-asset/ledger/schema.ts";
import type { HarnessDb, HarnessStatement, ReadOnlyHarnessDb } from "../src/state-db/index.ts";
import * as stateDb from "../src/state-db/index.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const activeDatabases: HarnessDb[] = [];
const fixtureRoots: string[] = [];
const cwdRestorers: Array<() => void> = [];
const cliEntryPath = join(process.cwd(), "src", "cli.ts");

const snapshotWriterScript = `
import { DatabaseSync } from "node:sqlite";
import { closeSync, openSync, writeSync } from "node:fs";
const [databasePath, signalPath] = process.argv.slice(1);
const db = new DatabaseSync(databasePath);
db.exec("PRAGMA busy_timeout = 30000");
db.exec("BEGIN IMMEDIATE");
const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get("trg_plan_revisions_no_update");
if (!trigger?.sql) throw new Error("revision immutability trigger missing");
db.exec("DROP TRIGGER trg_plan_revisions_no_update");
db.prepare("UPDATE plan_revisions SET canonical_payload_json = ? WHERE asset_id = ? AND revision = 1").run('{"title":"query A writer version"}', "plan:query-a");
db.exec(String(trigger.sql));
const signal = openSync(signalPath, "w");
try {
  writeSync(signal, Buffer.from("before-commit"));
} finally {
  closeSync(signal);
}
db.exec("COMMIT");
db.close();
`;

const pendingLockProbeScript = `
import { DatabaseSync } from "node:sqlite";
const databasePath = process.argv[1];
const db = new DatabaseSync(databasePath, { readOnly: true });
const wait = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 4500;
let code = "timeout";
while (Date.now() < deadline) {
  try {
    db.prepare("SELECT count(*) FROM sqlite_master").get();
  } catch (error) {
    code = String(error.errcode ?? "missing-errcode");
    break;
  }
  Atomics.wait(wait, 0, 0, 10);
}
db.close();
process.stdout.write(code);
`;

afterEach(() => {
  for (const db of activeDatabases.splice(0)) db.close();
  for (const restore of cwdRestorers.splice(0)) restore();
  for (const root of fixtureRoots.splice(0)) removeTestTree(root);
});

describe("PLAN revision canonical payload digest read-only query", () => {
  it("CANDIDATE-U-PRDQ-001A/007A: returns an exact immutable historical-revision DTO, not latest", () => {
    const fixture = createFixture();
    appendRevision(fixture.db, {
      assetId: fixture.assetA,
      alias: fixture.aliasA,
      basePayload: fixture.payloadA1,
      nextPayload: fixture.payloadA2,
    });
    useFixtureCwd(fixture.root);

    const result = readPlanRevisionCanonicalPayloadDigest({
      alias: fixture.aliasA,
      assetId: fixture.assetA,
      revision: 1,
    });

    expect(result).toEqual({
      ok: true,
      alias: fixture.aliasA,
      assetId: fixture.assetA,
      revision: 1,
      canonicalPayloadDigest: `sha256:${sha256(fixture.payloadA1)}`,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.keys(result).sort()).toEqual(
      ["alias", "assetId", "canonicalPayloadDigest", "ok", "revision"].sort(),
    );
  });

  it("U-PRDQ-008: CLI O7 rollback query returns the exact API DTO without side effects", () => {
    const fixture = createFixture();
    appendRevision(fixture.db, {
      assetId: fixture.assetA,
      alias: fixture.aliasA,
      basePayload: fixture.payloadA1,
      nextPayload: fixture.payloadA2,
    });
    closeTracked(fixture.db);
    useFixtureCwd(fixture.root);
    const directory = join(fixture.root, ".ut-tdd", "ledger");
    const before = snapshotDirectory(directory);
    const apiResult = readPlanRevisionCanonicalPayloadDigest({
      alias: fixture.aliasA,
      assetId: fixture.assetA,
      revision: 1,
    });
    expect(snapshotDirectory(directory)).toEqual(before);
    expect(apiResult).toEqual({
      ok: true,
      alias: fixture.aliasA,
      assetId: fixture.assetA,
      revision: 1,
      canonicalPayloadDigest: `sha256:${sha256(fixture.payloadA1)}`,
    });

    const cliResult = runRevisionDigestCli({
      cwd: fixture.root,
      alias: fixture.aliasA,
      assetId: fixture.assetA,
      revision: 1,
    });

    expect(cliResult.error).toBeUndefined();
    expect(cliResult.status).toBe(0);
    const cliValue = JSON.parse(cliResult.stdout);
    expect(cliValue).toEqual(apiResult);
    expect(Object.keys(cliValue).sort()).toEqual(
      ["alias", "assetId", "canonicalPayloadDigest", "ok", "revision"].sort(),
    );
    expect(snapshotDirectory(directory)).toEqual(before);
    expect(readdirSync(directory).some((entry) => /-(journal|wal|shm)$/.test(entry))).toBe(false);
  });

  it("U-PRDQ-009: CLI O7 WAL rejection exits 1 without digest or side effects", () => {
    const fixture = createFixture();
    appendRevision(fixture.db, {
      assetId: fixture.assetA,
      alias: fixture.aliasA,
      basePayload: fixture.payloadA1,
      nextPayload: fixture.payloadA2,
    });
    fixture.db.exec("PRAGMA journal_mode = WAL");
    closeTracked(fixture.db);
    useFixtureCwd(fixture.root);
    const directory = join(fixture.root, ".ut-tdd", "ledger");
    const before = snapshotDirectory(directory);
    expect(before.entries.some((entry) => /-(wal|shm)$/.test(entry.name))).toBe(false);
    const apiResult = readPlanRevisionCanonicalPayloadDigest({
      alias: fixture.aliasA,
      assetId: fixture.assetA,
      revision: 1,
    });
    expect(snapshotDirectory(directory)).toEqual(before);
    expect(apiResult).toEqual({ ok: false, reason: "ledger_unavailable" });

    const cliResult = runRevisionDigestCli({
      cwd: fixture.root,
      alias: fixture.aliasA,
      assetId: fixture.assetA,
      revision: 1,
    });

    expect(cliResult.error).toBeUndefined();
    expect(cliResult.status).toBe(1);
    const cliValue = JSON.parse(cliResult.stdout);
    expect(cliValue).toEqual(apiResult);
    expect(Object.keys(cliValue).sort()).toEqual(["ok", "reason"]);
    expect(cliValue).not.toHaveProperty("canonicalPayloadDigest");
    expect(snapshotDirectory(directory)).toEqual(before);
  });

  it("U-PRDQ-010: CLI invalid revision returns the API invalid_input DTO and exits 1", () => {
    const fixture = createFixture();
    closeTracked(fixture.db);
    useFixtureCwd(fixture.root);
    const directory = join(fixture.root, ".ut-tdd", "ledger");
    const before = snapshotDirectory(directory);
    const apiResult = readPlanRevisionCanonicalPayloadDigest({
      alias: fixture.aliasA,
      assetId: fixture.assetA,
      revision: 0,
    });
    expect(apiResult).toEqual({ ok: false, reason: "invalid_input" });
    expect(snapshotDirectory(directory)).toEqual(before);

    const cliResult = runRevisionDigestCli({
      cwd: fixture.root,
      alias: fixture.aliasA,
      assetId: fixture.assetA,
      revision: 0,
    });

    expect(cliResult.error).toBeUndefined();
    expect(cliResult.status).toBe(1);
    const cliValue = JSON.parse(cliResult.stdout);
    expect(cliValue).toEqual(apiResult);
    expect(Object.keys(cliValue).sort()).toEqual(["ok", "reason"]);
    expect(cliValue).not.toHaveProperty("canonicalPayloadDigest");
    expect(snapshotDirectory(directory)).toEqual(before);
  });

  it.each([
    ["empty alias", { alias: "", assetId: "plan:query-a", revision: 1 }],
    ["empty asset id", { alias: "PLAN-L7-query-a", assetId: "", revision: 1 }],
    ["zero revision", { alias: "PLAN-L7-query-a", assetId: "plan:query-a", revision: 0 }],
    ["negative revision", { alias: "PLAN-L7-query-a", assetId: "plan:query-a", revision: -1 }],
    ["fractional revision", { alias: "PLAN-L7-query-a", assetId: "plan:query-a", revision: 1.5 }],
  ] as const)("CANDIDATE-U-PRDQ-002/003: rejects invalid selector: %s", (_label, selector) => {
    const fixture = createFixture();
    useFixtureCwd(fixture.root);

    const result = readPlanRevisionCanonicalPayloadDigest(selector);

    expect(result).toEqual({ ok: false, reason: "invalid_input" });
  });

  it("CANDIDATE-U-PRDQ-002: requires the exact active alias and matching asset", () => {
    const fixture = createFixture();
    useFixtureCwd(fixture.root);

    const omittedAlias = readPlanRevisionCanonicalPayloadDigest({
      assetId: fixture.assetA,
      revision: 1,
    } as Parameters<typeof readPlanRevisionCanonicalPayloadDigest>[0]);
    const missingAlias = readPlanRevisionCanonicalPayloadDigest({
      alias: "PLAN-L7-not-present",
      assetId: fixture.assetA,
      revision: 1,
    });
    const mismatchedAsset = readPlanRevisionCanonicalPayloadDigest({
      alias: fixture.aliasA,
      assetId: fixture.assetB,
      revision: 1,
    });

    expect(omittedAlias).toEqual({ ok: false, reason: "invalid_input" });
    expect(missingAlias).toEqual({ ok: false, reason: "alias_binding_mismatch" });
    expect(mismatchedAsset).toEqual({ ok: false, reason: "alias_binding_mismatch" });
  });

  it("CANDIDATE-U-PRDQ-002: rejects duplicate active alias bindings as ledger corruption", () => {
    const fixture = createFixture();
    fixture.db.exec("DROP INDEX uq_plan_aliases_active");
    fixture.db
      .prepare("INSERT INTO plan_aliases VALUES (?, ?, ?, ?, ?, ?)")
      .run("alias:duplicate-active", fixture.assetA, fixture.aliasA, 1, null, sha256("alias"));
    useFixtureCwd(fixture.root);

    const result = readPlanRevisionCanonicalPayloadDigest({
      alias: fixture.aliasA,
      assetId: fixture.assetA,
      revision: 1,
    });

    expect(result).toEqual({ ok: false, reason: "ledger_integrity_mismatch" });
  });

  it("CANDIDATE-U-PRDQ-003: rejects missing revisions without falling back to latest or another asset", () => {
    const fixture = createFixture();
    appendRevision(fixture.db, {
      assetId: fixture.assetB,
      alias: fixture.aliasB,
      basePayload: fixture.payloadB1,
      nextPayload: fixture.payloadB2,
    });
    useFixtureCwd(fixture.root);

    const missing = readPlanRevisionCanonicalPayloadDigest({
      alias: fixture.aliasA,
      assetId: fixture.assetA,
      revision: 3,
    });
    const revisionOnlyOnOtherAsset = readPlanRevisionCanonicalPayloadDigest({
      alias: fixture.aliasA,
      assetId: fixture.assetA,
      revision: 2,
    });

    expect(missing).toEqual({ ok: false, reason: "revision_not_found" });
    expect(revisionOnlyOnOtherAsset).toEqual({ ok: false, reason: "revision_not_found" });
  });

  it.each([
    [
      "payload bytes",
      (db: HarnessDb) => {
        mutateWithRestoredTrigger(db, "trg_plan_revisions_no_update", () => {
          db.prepare(
            "UPDATE plan_revisions SET canonical_payload_json = ? WHERE asset_id = ? AND revision = 1",
          ).run('{"title":"tampered"}', "plan:query-a");
        });
      },
    ],
    [
      "stored payload digest",
      (db: HarnessDb) => {
        mutateWithRestoredTrigger(db, "trg_plan_revisions_no_update", () => {
          db.prepare(
            "UPDATE plan_revisions SET canonical_payload_digest = ? WHERE asset_id = ? AND revision = 1",
          ).run("0".repeat(64), "plan:query-a");
        });
      },
    ],
    [
      "alias event digest",
      (db: HarnessDb) => {
        mutateWithRestoredTrigger(db, "trg_plan_alias_events_no_update", () => {
          db.prepare("UPDATE plan_alias_events SET event_digest = ? WHERE asset_id = ?").run(
            "0".repeat(64),
            "plan:query-a",
          );
        });
      },
    ],
    [
      "draft journal previous event digest with recomputed row digest",
      (db: HarnessDb) => {
        mutateWithRestoredTrigger(db, "trg_plan_draft_journal_events_no_update", () => {
          const event = db
            .prepare("SELECT * FROM plan_draft_journal_events WHERE command_id = ?")
            .get("command:query-journal");
          if (!event) throw new Error("fixture draft journal event missing");
          const changed: Record<string, unknown> = {
            ...event,
            previous_event_digest: "f".repeat(64),
          };
          changed.event_digest = ledgerRowDigest(changed, "event_digest");
          db.prepare(
            "UPDATE plan_draft_journal_events SET previous_event_digest = ?, event_digest = ? WHERE command_id = ?",
          ).run(changed.previous_event_digest, changed.event_digest, "command:query-journal");
        });
      },
    ],
    [
      "draft journal sequence with recomputed row digest",
      (db: HarnessDb) => {
        mutateWithRestoredTrigger(db, "trg_plan_draft_journal_events_no_update", () => {
          const event = db
            .prepare("SELECT * FROM plan_draft_journal_events WHERE command_id = ?")
            .get("command:query-journal");
          if (!event) throw new Error("fixture draft journal event missing");
          const changed: Record<string, unknown> = { ...event, sequence: 2 };
          changed.event_digest = ledgerRowDigest(changed, "event_digest");
          db.prepare(
            "UPDATE plan_draft_journal_events SET sequence = ?, event_digest = ? WHERE command_id = ?",
          ).run(changed.sequence, changed.event_digest, "command:query-journal");
        });
      },
    ],
  ] as const)("CANDIDATE-U-PRDQ-004: denies %s corruption", (label, corrupt) => {
    const fixture = createFixture();
    if (label.startsWith("draft journal")) seedDraftJournal(fixture.db);
    expect(migratePlanLedger(fixture.db)).toEqual({ ok: true, version: 7 });
    const schemaBefore = schemaSnapshot(fixture.db);
    corrupt(fixture.db);
    expect(schemaSnapshot(fixture.db)).toEqual(schemaBefore);
    expect(migratePlanLedger(fixture.db)).toEqual({
      ok: false,
      ruleId: "plan-ledger-unavailable",
    });
    useFixtureCwd(fixture.root);

    const result = readPlanRevisionCanonicalPayloadDigest({
      alias: fixture.aliasA,
      assetId: fixture.assetA,
      revision: 1,
    });

    expect(result).toEqual({ ok: false, reason: "ledger_integrity_mismatch" });
  });

  it.each([
    ["missing database", "missing"],
    ["unsupported schema version", "unsupported"],
    ["corrupt database file", "corrupt"],
  ] as const)("CANDIDATE-U-PRDQ-005: denies %s without initialization or repair", (_label, failure) => {
    const fixture = createFixture();
    closeTracked(fixture.db);
    const databasePath = join(fixture.root, ".ut-tdd", "ledger", "harness-ledger.db");
    if (failure === "missing") rmSync(databasePath);
    if (failure === "unsupported") {
      const db = openPlanLedger({ repoRoot: fixture.root });
      db.setUserVersion(999);
      db.close();
    }
    if (failure === "corrupt") {
      rmSync(databasePath);
      mkdirSync(join(fixture.root, ".ut-tdd", "ledger"), { recursive: true });
      writeFileSync(databasePath, "not a sqlite database", "utf8");
    }
    const bytesBeforeQuery = existsSync(databasePath) ? readFileSync(databasePath) : undefined;
    useFixtureCwd(fixture.root);

    const result = readPlanRevisionCanonicalPayloadDigest({
      alias: fixture.aliasA,
      assetId: fixture.assetA,
      revision: 1,
    });

    expect(result).toEqual({ ok: false, reason: "ledger_unavailable" });
    expect(existsSync(databasePath)).toBe(failure !== "missing");
    if (bytesBeforeQuery) expect(readFileSync(databasePath)).toEqual(bytesBeforeQuery);
  });

  it("CANDIDATE-U-PRDQ-006/O1/O10: success has no side effects and keeps busy_timeout disabled", () => {
    const fixture = createFixture();
    closeTracked(fixture.db);
    useFixtureCwd(fixture.root);
    const directory = join(fixture.root, ".ut-tdd", "ledger");
    const databasePath = join(directory, "harness-ledger.db");
    const before = snapshotDirectory(directory);
    const observer = observeReadOnlyOpenCalls(databasePath);

    let result: ReturnType<typeof readPlanRevisionCanonicalPayloadDigest>;
    try {
      result = readPlanRevisionCanonicalPayloadDigest({
        alias: fixture.aliasA,
        assetId: fixture.assetA,
        revision: 1,
      });
    } finally {
      observer.restore();
    }

    expect(result).toMatchObject({
      ok: true,
      canonicalPayloadDigest: `sha256:${sha256(fixture.payloadA1)}`,
    });
    expect(observer.attempts).toHaveLength(1);
    expect(observer.attempts[0]?.databasePath).toBe(databasePath);
    expect(observer.attempts[0]?.busyTimeout).toBe(0);
    expect(observer.attempts[0]?.closeCalls).toBe(1);
    expect(snapshotDirectory(directory)).toEqual(before);
    expect(readdirSync(directory).some((entry) => /-(journal|wal|shm)$/.test(entry))).toBe(false);
  });

  it("CANDIDATE-U-PRDQ-006/O2: denies WAL header without creating sidecars or changing files", () => {
    const fixture = createFixture();
    fixture.db.exec("PRAGMA journal_mode = WAL");
    closeTracked(fixture.db);
    useFixtureCwd(fixture.root);
    const directory = join(fixture.root, ".ut-tdd", "ledger");
    const before = snapshotDirectory(directory);

    const result = readPlanRevisionCanonicalPayloadDigest({
      alias: fixture.aliasA,
      assetId: fixture.assetA,
      revision: 1,
    });

    expect(result).toEqual({ ok: false, reason: "ledger_unavailable" });
    expect(snapshotDirectory(directory)).toEqual(before);
    expect(before.entries.some((entry) => /-(wal|shm)$/.test(entry.name))).toBe(false);
  });

  it("CANDIDATE-U-PRDQ-006/O3: denies live WAL sidecar and preserves its bytes", () => {
    const fixture = createFixture();
    fixture.db.exec("PRAGMA journal_mode = WAL");
    fixture.db
      .prepare("INSERT INTO plan_assets VALUES (?, ?, ?, ?)")
      .run("plan:wal-writer", "2026-09-29T00:00:02.000Z", "c".repeat(40), "test-writer");
    useFixtureCwd(fixture.root);
    const directory = join(fixture.root, ".ut-tdd", "ledger");
    const before = snapshotDirectory(directory);

    const result = readPlanRevisionCanonicalPayloadDigest({
      alias: fixture.aliasA,
      assetId: fixture.assetA,
      revision: 1,
    });

    expect(result).toEqual({ ok: false, reason: "ledger_unavailable" });
    expect(snapshotDirectory(directory)).toEqual(before);
    expect(before.entries.some((entry) => entry.name.endsWith("-shm"))).toBe(true);
  });

  it("CANDIDATE-U-PRDQ-006/O4: denies a hot journal without changing database or journal bytes", () => {
    const fixture = createFixture();
    closeTracked(fixture.db);
    const databasePath = join(fixture.root, ".ut-tdd", "ledger", "harness-ledger.db");
    const crashWriter = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); db.exec('PRAGMA cache_size = 1'); db.exec('BEGIN EXCLUSIVE'); const insert = db.prepare('INSERT INTO plan_assets VALUES (?, ?, ?, ?)'); for (let i = 0; i < 1000; i += 1) insert.run('plan:hot-' + i, '2026-09-29T00:00:03.000Z', 'd'.repeat(40), 'test-crash-writer'); process.exit(0);",
        databasePath,
      ],
      { encoding: "utf8" },
    );
    expect(crashWriter.status).toBe(0);
    const directory = join(fixture.root, ".ut-tdd", "ledger");
    const before = snapshotDirectory(directory);
    expect(before.entries.some((entry) => entry.name.endsWith("-journal"))).toBe(true);
    const journalBytes = readFileSync(`${databasePath}-journal`);
    expect(journalBytes.subarray(0, 8)).toEqual(Buffer.from("d9d505f920a163d7", "hex"));
    expect(readFileSync(databasePath).subarray(18, 20)).toEqual(Buffer.from([1, 1]));
    const readOnlyProbe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1], { readOnly: true }); let code = 'no-error'; try { db.prepare('SELECT count(*) FROM sqlite_master').get(); } catch (error) { code = String(error.errcode ?? 'missing-errcode'); } finally { db.close(); } process.stdout.write(code);",
        databasePath,
      ],
      { encoding: "utf8", timeout: 5_000, windowsHide: true },
    );
    expect(readOnlyProbe.status).toBe(0);
    expect(readOnlyProbe.stdout.trim()).toBe("776");
    expect(snapshotDirectory(directory)).toEqual(before);
    useFixtureCwd(fixture.root);

    const result = readPlanRevisionCanonicalPayloadDigest({
      alias: fixture.aliasA,
      assetId: fixture.assetA,
      revision: 1,
    });

    expect(result).toEqual({ ok: false, reason: "ledger_unavailable" });
    expect(snapshotDirectory(directory)).toEqual(before);
  });

  it("CANDIDATE-U-PRDQ-006/O5/O10/O11: denies a held exclusive lock three times without waiting or retrying", () => {
    const fixture = createFixture();
    useFixtureCwd(fixture.root);
    const databasePath = join(fixture.root, ".ut-tdd", "ledger", "harness-ledger.db");
    const warmup = readPlanRevisionCanonicalPayloadDigest({
      alias: fixture.aliasA,
      assetId: fixture.assetA,
      revision: 1,
    });
    expect(warmup).toMatchObject({ ok: true });

    fixture.db.exec("BEGIN EXCLUSIVE");
    const busyProbe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1], { readOnly: true }); let code = 'no-error'; try { db.prepare('SELECT count(*) FROM sqlite_master').get(); } catch (error) { code = String(error.errcode ?? 'missing-errcode'); } finally { db.close(); } process.stdout.write(code);",
        databasePath,
      ],
      { encoding: "utf8", timeout: 5_000, windowsHide: true },
    );
    expect(busyProbe.status).toBe(0);
    expect(busyProbe.stdout.trim()).toBe("5");
    const observer = observeReadOnlyOpenCalls(databasePath);
    const measurements: Array<{
      elapsedMs: number;
      result: ReturnType<typeof readPlanRevisionCanonicalPayloadDigest>;
    }> = [];
    const wait = new Int32Array(new SharedArrayBuffer(4));

    try {
      for (let index = 0; index < 3; index += 1) {
        const startedAt = performance.now();
        const result = readPlanRevisionCanonicalPayloadDigest({
          alias: fixture.aliasA,
          assetId: fixture.assetA,
          revision: 1,
        });
        measurements.push({ elapsedMs: performance.now() - startedAt, result });
      }
    } finally {
      // The frozen O5 window requires the EXCLUSIVE lock to outlive the last measurement by >=5s.
      Atomics.wait(wait, 0, 0, 5_050);
      observer.restore();
    }

    expect(measurements).toHaveLength(3);
    for (const measurement of measurements) {
      expect(measurement.result).toEqual({ ok: false, reason: "ledger_unavailable" });
      expect(measurement.elapsedMs).toBeLessThan(500);
    }
    expect(observer.attempts).toHaveLength(3);
    for (const attempt of observer.attempts) {
      expect(attempt.databasePath).toBe(databasePath);
      expect(attempt.busyTimeout).toBe(0);
      expect(attempt.closeCalls).toBe(1);

      const failedIndex = attempt.operations.findIndex((event) => event.errcode === 5);
      expect(failedIndex).toBeGreaterThanOrEqual(0);
      const failedOperation = attempt.operations[failedIndex]?.operation;
      expect(failedOperation).toMatch(
        /^(beginReadTransaction|userVersion|prepare|statement\.(get|all|run))$/,
      );
      expect(attempt.operations.slice(failedIndex + 1)).toEqual([]);

      const retryableOperations = attempt.operations.map((event) => event.operation);
      expect(new Set(retryableOperations).size).toBe(retryableOperations.length);
    }
  });

  it("CANDIDATE-U-PRDQ-006/O6: verifies the query connection rejects a write probe", () => {
    const fixture = createFixture();
    closeTracked(fixture.db);
    useFixtureCwd(fixture.root);
    let probeErrcode: number | undefined;
    setPlanRevisionDigestQueryTestHook(({ tryWrite }) => {
      probeErrcode = tryWrite();
    });

    try {
      const result = readPlanRevisionCanonicalPayloadDigest({
        alias: fixture.aliasA,
        assetId: fixture.assetA,
        revision: 1,
      });

      expect(result).toEqual({
        ok: true,
        alias: fixture.aliasA,
        assetId: fixture.assetA,
        revision: 1,
        canonicalPayloadDigest: `sha256:${sha256(fixture.payloadA1)}`,
      });
      expect(probeErrcode).toBe(8);
    } finally {
      setPlanRevisionDigestQueryTestHook(undefined);
    }
  });

  it("CANDIDATE-U-PRDQ-006/O8: selector uses the validated snapshot while a writer is pending", async () => {
    const fixture = createFixture();
    closeTracked(fixture.db);
    useFixtureCwd(fixture.root);
    const databasePath = join(fixture.root, ".ut-tdd", "ledger", "harness-ledger.db");
    const signalPath = join(fixture.root, "writer-before-commit.signal");
    let writer: ChildProcess | undefined;
    let barrierBusyCode: string | undefined;
    setPlanRevisionDigestQueryTestHook(() => {
      writer = spawn(
        process.execPath,
        ["--input-type=module", "-e", snapshotWriterScript, databasePath, signalPath],
        { stdio: "ignore", windowsHide: true },
      );
      if (!waitForFile(signalPath, 5_000)) {
        throw new Error("snapshot writer did not reach the pre-commit barrier");
      }
      const probe = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", pendingLockProbeScript, databasePath],
        { encoding: "utf8", timeout: 6_000, windowsHide: true },
      );
      barrierBusyCode = probe.status === 0 ? probe.stdout.trim() : "probe-failed";
    });

    try {
      const result = readPlanRevisionCanonicalPayloadDigest({
        alias: fixture.aliasA,
        assetId: fixture.assetA,
        revision: 1,
      });

      expect(result).toEqual({
        ok: true,
        alias: fixture.aliasA,
        assetId: fixture.assetA,
        revision: 1,
        canonicalPayloadDigest: `sha256:${sha256(fixture.payloadA1)}`,
      });
      expect(barrierBusyCode).toBe("5");
      if (!writer) throw new Error("snapshot writer process was not started");
      const writerExit =
        writer.exitCode === null
          ? await once(writer, "exit")
          : [writer.exitCode, writer.signalCode];
      expect(writerExit).toEqual([0, null]);

      const verifyDb = openPlanLedger({ repoRoot: fixture.root });
      activeDatabases.push(verifyDb);
      expect(
        verifyDb
          .prepare(
            "SELECT canonical_payload_json FROM plan_revisions WHERE asset_id = ? AND revision = 1",
          )
          .get(fixture.assetA)?.canonical_payload_json,
      ).toBe('{"title":"query A writer version"}');
    } finally {
      setPlanRevisionDigestQueryTestHook(undefined);
      if (writer && writer.exitCode === null) {
        const writerExit = once(writer, "exit");
        writer.kill();
        await writerExit;
      }
    }
  });

  it("CANDIDATE-U-PRDQ-006/O9: validates a 20,000-revision ledger within time and RSS bounds", () => {
    const fixture = createFixture();
    seedScaleRevisions(fixture.db, fixture.assetA, fixture.aliasA);
    closeTracked(fixture.db);
    useFixtureCwd(fixture.root);
    const rssBefore = process.memoryUsage().rss;
    const startedAt = performance.now();

    const result = readPlanRevisionCanonicalPayloadDigest({
      alias: fixture.aliasA,
      assetId: fixture.assetA,
      revision: 1,
    });

    const elapsedMs = performance.now() - startedAt;
    const rssIncrease = process.memoryUsage().rss - rssBefore;
    expect(result).toEqual({
      ok: true,
      alias: fixture.aliasA,
      assetId: fixture.assetA,
      revision: 1,
      canonicalPayloadDigest: `sha256:${sha256(fixture.payloadA1)}`,
    });
    expect(elapsedMs).toBeLessThanOrEqual(5_000);
    expect(rssIncrease).toBeLessThanOrEqual(256 * 1024 * 1024);
  });
});

type ReadOnlyOperation =
  | "beginReadTransaction"
  | "commitReadTransaction"
  | "userVersion"
  | "prepare"
  | "statement.get"
  | "statement.all"
  | "statement.run";

interface ReadOnlyOperationEvent {
  operation: ReadOnlyOperation;
  errcode?: number;
}

interface ReadOnlyOpenAttempt {
  databasePath: string;
  operations: ReadOnlyOperationEvent[];
  closeCalls: number;
  busyTimeout?: number;
}

function observeReadOnlyOpenCalls(databasePath: string): {
  attempts: ReadOnlyOpenAttempt[];
  restore: () => void;
} {
  const attempts: ReadOnlyOpenAttempt[] = [];
  const callThrough = stateDb.openReadOnlyHarnessDb;
  const openSpy = vi.spyOn(stateDb, "openReadOnlyHarnessDb").mockImplementation((path, options) => {
    expect(path).toBe(databasePath);
    const database = callThrough(path, options);
    const attempt: ReadOnlyOpenAttempt = {
      databasePath: path,
      operations: [],
      closeCalls: 0,
    };
    attempts.push(attempt);

    const observe = <T>(operation: ReadOnlyOperation, callback: () => T): T => {
      const event: ReadOnlyOperationEvent = { operation };
      attempt.operations.push(event);
      try {
        return callback();
      } catch (error) {
        if (typeof error === "object" && error !== null && "errcode" in error) {
          const errcode = error.errcode;
          if (typeof errcode === "number") event.errcode = errcode;
        }
        throw error;
      }
    };

    const wrapStatement = (statement: HarnessStatement): HarnessStatement => ({
      get: (...params) => observe("statement.get", () => statement.get(...params)),
      all: (...params) => observe("statement.all", () => statement.all(...params)),
      run: (...params) => observe("statement.run", () => statement.run(...params)),
    });

    const observedDatabase: ReadOnlyHarnessDb = {
      path: database.path,
      driver: database.driver,
      beginReadTransaction: () =>
        observe("beginReadTransaction", () => database.beginReadTransaction()),
      commitReadTransaction: () =>
        observe("commitReadTransaction", () => database.commitReadTransaction()),
      userVersion: () => observe("userVersion", () => database.userVersion()),
      prepare: (sql) => wrapStatement(observe("prepare", () => database.prepare(sql))),
      close: () => {
        attempt.closeCalls += 1;
        try {
          // This direct call-through probe is intentionally outside the observed operation counts.
          const row = database.prepare("PRAGMA busy_timeout").get();
          attempt.busyTimeout = Number(row?.timeout);
        } finally {
          database.close();
        }
      },
    };
    return observedDatabase;
  });

  return { attempts, restore: () => openSpy.mockRestore() };
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-prdq-"));
  fixtureRoots.push(root);
  const db = openPlanLedger({ repoRoot: root });
  activeDatabases.push(db);
  expect(migratePlanLedger(db)).toEqual({ ok: true, version: 7 });
  const fixture = {
    root,
    db,
    assetA: "plan:query-a",
    aliasA: "PLAN-L7-query-a",
    payloadA1: '{"title":"query A v1"}',
    payloadA2: '{"title":"query A v2"}',
    assetB: "plan:query-b",
    aliasB: "PLAN-L7-query-b",
    payloadB1: '{"title":"query B v1"}',
    payloadB2: '{"title":"query B v2"}',
  };
  seedAdoptedRevision({
    db,
    assetId: fixture.assetA,
    alias: fixture.aliasA,
    payload: fixture.payloadA1,
    suffix: "a",
  });
  seedAdoptedRevision({
    db,
    assetId: fixture.assetB,
    alias: fixture.aliasB,
    payload: fixture.payloadB1,
    suffix: "b",
  });
  expect(migratePlanLedger(db)).toEqual({ ok: true, version: 7 });
  return fixture;
}

function runRevisionDigestCli(input: {
  cwd: string;
  alias: string;
  assetId: string;
  revision: number;
}) {
  return spawnSync(
    process.execPath,
    [
      cliEntryPath,
      "plan",
      "revision-digest",
      "--alias",
      input.alias,
      "--asset-id",
      input.assetId,
      "--revision",
      String(input.revision),
      "--json",
    ],
    { cwd: input.cwd, encoding: "utf8", timeout: 30_000 },
  );
}

function closeTracked(db: HarnessDb): void {
  const index = activeDatabases.indexOf(db);
  if (index >= 0) activeDatabases.splice(index, 1);
  db.close();
}

function useFixtureCwd(root: string): void {
  const spy = vi.spyOn(process, "cwd").mockReturnValue(root);
  cwdRestorers.push(() => spy.mockRestore());
}

function waitForFile(path: string, timeoutMs: number): boolean {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    Atomics.wait(wait, 0, 0, 10);
  }
  return existsSync(path);
}

function seedScaleRevisions(db: HarnessDb, assetId: string, alias: string): void {
  const insert = db.prepare("INSERT INTO plan_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const padding = "x".repeat(3_950);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let revision = 2; revision <= 20_000; revision += 1) {
      const canonicalPayloadJson = `{"index":${revision},"padding":"${padding}"}`;
      insert.run(
        assetId,
        revision,
        canonicalPayloadJson,
        sha256(canonicalPayloadJson),
        sha256(`scale-body-${revision}`),
        `docs/plans/${alias}.md`,
        "e".repeat(40),
        "test-fixture",
        "O9 performance fixture",
        "2026-09-29T00:00:04.000Z",
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function seedAdoptedRevision(input: {
  db: HarnessDb;
  assetId: string;
  alias: string;
  payload: string;
  suffix: string;
}): void {
  input.db
    .prepare("INSERT INTO plan_assets VALUES (?, ?, ?, ?)")
    .run(input.assetId, "2026-09-29T00:00:00.000Z", "a".repeat(40), "legacy-adopt-v1");
  input.db
    .prepare("INSERT INTO plan_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      input.assetId,
      1,
      input.payload,
      sha256(input.payload),
      sha256(`body-${input.suffix}-v1`),
      `docs/plans/${input.alias}.md`,
      "a".repeat(40),
      "migration",
      "adopt",
      "2026-09-29T00:00:00.000Z",
    );
  const event = {
    alias_event_id: `alias:${input.assetId}:1`,
    asset_id: input.assetId,
    sequence: 1,
    command_id: `command:adopt:${input.assetId}`,
    command_payload_digest: sha256(`alias-command-${input.suffix}`),
    event_kind: "assigned",
    alias: input.alias,
    revision: 1,
    reason: "adopt",
    occurred_at: "2026-09-29T00:00:00.000Z",
  };
  const eventDigest = ledgerRowDigest(event, "event_digest");
  input.db
    .prepare("INSERT INTO plan_alias_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(...Object.values(event), eventDigest);
  input.db
    .prepare("INSERT INTO plan_aliases VALUES (?, ?, ?, ?, ?, ?)")
    .run(`alias-current:${input.assetId}`, input.assetId, input.alias, 1, null, eventDigest);
}

function appendRevision(
  db: HarnessDb,
  input: {
    assetId: string;
    alias: string;
    basePayload: string;
    nextPayload: string;
  },
): void {
  const result = new PlanRevisionLedgerTransaction(db).append({
    commandId: `command:query:${input.assetId}:2`,
    assetId: input.assetId,
    planId: input.alias,
    baseRevision: 1,
    basePayloadDigest: sha256(input.basePayload),
    canonicalPayloadJson: input.nextPayload,
    contentDigest: sha256(`content-${input.assetId}-v2`),
    bodyDigest: sha256(`body-${input.assetId}-v2`),
    sourcePath: `docs/plans/${input.alias}.md`,
    sourceCommit: "b".repeat(40),
    actor: "codex",
    reason: "query fixture revision",
    routeTupleDigest: sha256(`route-${input.assetId}`),
    certificateId: `certificate:query:${input.assetId}:2`,
    occurredAt: "2026-09-29T00:00:01.000Z",
  } satisfies AppendPlanRevisionInput);
  expect(result).toMatchObject({ ok: true, revision: 2 });
}

function seedDraftJournal(db: HarnessDb): void {
  const event = {
    journal_event_id: "journal:query:event:1",
    command_id: "command:query-journal",
    sequence: 1,
    command_payload_digest: sha256("query-journal-payload"),
    event_kind: "intent",
    requested_plan_id: "PLAN-L7-query-journal",
    requested_source_path: "docs/plans/PLAN-L7-query-journal.md",
    plan_asset_id: null,
    plan_revision: null,
    certificate_id: null,
    occurred_at: "2026-09-29T00:00:00.000Z",
    failure_reason: null,
    previous_event_digest: null,
  };
  const eventDigest = ledgerRowDigest(event, "event_digest");
  db.prepare(
    "INSERT INTO plan_draft_journal_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(...Object.values(event), eventDigest);
  const current = {
    journal_id: "journal:query",
    command_id: event.command_id,
    command_payload_digest: event.command_payload_digest,
    status: "intent",
    requested_plan_id: event.requested_plan_id,
    requested_source_path: event.requested_source_path,
    plan_asset_id: null,
    plan_revision: null,
    certificate_id: null,
    intent_recorded_at: event.occurred_at,
    completed_at: null,
    failure_reason: null,
  };
  db.prepare("INSERT INTO plan_draft_journal VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    ...Object.values(current),
    ledgerRowDigest(current, "journal_digest"),
  );
}

function mutateWithRestoredTrigger(db: HarnessDb, triggerName: string, mutate: () => void): void {
  const trigger = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
    .get(triggerName);
  const triggerSql = String(trigger?.sql ?? "");
  if (triggerSql.length === 0) throw new Error(`fixture trigger missing: ${triggerName}`);
  db.exec(`DROP TRIGGER ${triggerName}`);
  try {
    mutate();
  } finally {
    db.exec(triggerSql);
  }
}

function schemaSnapshot(db: HarnessDb) {
  return db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function snapshotDirectory(path: string) {
  const entries = readdirSync(path)
    .sort()
    .map((name) => {
      const filePath = join(path, name);
      const metadata = statSync(filePath);
      return {
        name,
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
        digest: createHash("sha256").update(readFileSync(filePath)).digest("hex"),
      };
    });
  return { directoryMtimeMs: statSync(path).mtimeMs, entries };
}
