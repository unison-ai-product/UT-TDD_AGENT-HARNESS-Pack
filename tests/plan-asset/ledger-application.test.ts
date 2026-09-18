import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PlanLedger } from "../../src/plan-asset/ledger/plan-ledger.ts";
import {
  ledgerSchemaDdl,
  migratePlanLedger,
  openPlanLedger,
} from "../../src/plan-asset/ledger/schema.ts";
import { openHarnessDb } from "../../src/state-db/index.ts";

const digest = "a".repeat(64);
const now = "2026-07-13T00:00:00Z";
const later = "2026-07-14T00:00:00Z";

describe("PLAN ledger reservation application", () => {
  it("U-PA-014: atomically appends event, active projection, and receipt", () => {
    withLedger(({ db, ledger }) => {
      const result = ledger.reserve(reserveInput());
      expect(result).toMatchObject({ ok: true, replayed: false });
      expect(count(db, "plan_id_reservation_events")).toBe(1);
      expect(count(db, "plan_id_reservations")).toBe(1);
      expect(count(db, "append_command_receipts")).toBe(1);
      expect(migratePlanLedger(db)).toMatchObject({ ok: true });
    });
  });

  it("U-PA-014: reconstructs the same state and digest sets after file reopen", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "ut-tdd-plan-ledger-"));
    try {
      const firstDb = openPlanLedger({ repoRoot });
      migratePlanLedger(firstDb);
      seedAsset(firstDb, "plan:a");
      const firstLedger = new PlanLedger(firstDb);
      expect(firstLedger.reserve(reserveInput())).toMatchObject({ ok: true });
      const before = firstLedger.reconstruct("reservation:a");
      firstDb.close();
      const reopened = openPlanLedger({ repoRoot });
      const after = new PlanLedger(reopened).reconstruct("reservation:a");
      expect(after).toEqual(before);
      reopened.close();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("U-PA-015: replays the same command and rejects a different payload", () => {
    withLedger(({ db, ledger }) => {
      const first = ledger.reserve(reserveInput());
      expect(ledger.reserve(reserveInput())).toMatchObject({
        ok: true,
        replayed: true,
        resultRef: first.ok ? first.resultRef : "",
      });
      expect(
        ledger.reserve({ ...reserveInput(), occurredAt: "2026-07-13T01:00:00Z" }),
      ).toMatchObject({ ok: true, replayed: true });
      expect(ledger.reserve({ ...reserveInput(), ordinal: 419 })).toMatchObject({
        ok: false,
        ruleId: "plan-id-reservation-command-conflict",
      });
      expect(count(db, "plan_id_reservation_events")).toBe(1);
    });
  });

  it("U-PA-016: release and expiry have one terminal transaction winner", () => {
    withLedger(({ db, ledger }) => {
      expect(ledger.reserve(reserveInput())).toMatchObject({ ok: true });
      const before = counts(db);
      expect(
        ledger.release({
          reservationId: "reservation:a",
          leaseTokenHash: "f".repeat(64),
          commandId: "command:wrong-token",
          occurredAt: "2026-07-13T11:00:00Z",
        }),
      ).toMatchObject({ ok: false, ruleId: "plan-id-reservation-token-mismatch" });
      expect(
        ledger.expire({
          reservationId: "reservation:a",
          commandId: "command:premature",
          occurredAt: "2026-07-13T11:00:00Z",
        }),
      ).toMatchObject({ ok: false, ruleId: "plan-id-reservation-not-expired" });
      expect(counts(db)).toEqual(before);
      expect(
        ledger.release({
          reservationId: "reservation:a",
          leaseTokenHash: digest,
          commandId: "command:release",
          occurredAt: "2026-07-13T12:00:00Z",
        }),
      ).toMatchObject({ ok: true });
      expect(
        ledger.expire({
          reservationId: "reservation:a",
          commandId: "command:expire",
          occurredAt: later,
        }),
      ).toMatchObject({ ok: false, ruleId: "plan-id-reservation-not-active" });
    });
  });

  it("U-PA-016: expiry may win before release and remains replayable", () => {
    withLedger(({ ledger }) => {
      ledger.reserve(reserveInput());
      const expired = ledger.expire({
        reservationId: "reservation:a",
        commandId: "command:expire",
        occurredAt: later,
      });
      expect(expired).toMatchObject({ ok: true, replayed: false });
      expect(
        ledger.release({
          reservationId: "reservation:a",
          leaseTokenHash: digest,
          commandId: "command:release",
          occurredAt: later,
        }),
      ).toMatchObject({ ok: false, ruleId: "plan-id-reservation-not-active" });
      expect(
        ledger.expire({
          reservationId: "reservation:a",
          commandId: "command:expire",
          occurredAt: "2026-07-15T00:00:00Z",
        }),
      ).toMatchObject({ ok: true, replayed: true, resultRef: expired.ok ? expired.resultRef : "" });
    });
  });

  it("U-PA-017: rolls back all rows when an active ordinal conflicts", () => {
    withLedger(({ db, ledger }) => {
      ledger.reserve(reserveInput());
      const result = ledger.reserve({
        ...reserveInput(),
        reservationId: "reservation:b",
        assetId: "plan:b",
        commandId: "command:b",
      });
      expect(result).toMatchObject({ ok: false, ruleId: "plan-id-reservation-conflict" });
      expect(count(db, "plan_id_reservation_events")).toBe(1);
      expect(count(db, "plan_id_reservations")).toBe(1);
      expect(count(db, "append_command_receipts")).toBe(1);
    });
  });

  it.each([
    "reservation-event",
    "reservation-current",
    "receipt",
  ])("U-PA-044: rolls back event/current/receipt when %s boundary faults", (boundary) => {
    withLedger(({ db }) => {
      const faulting = new PlanLedger(db, undefined, {
        after(actual) {
          if (actual === boundary) throw new Error(`fault:${boundary}`);
        },
      });
      expect(() => faulting.reserve(reserveInput())).toThrow(`fault:${boundary}`);
      expect(counts(db)).toEqual([0, 0, 0]);
      expect(new PlanLedger(db).reserve(reserveInput())).toMatchObject({ ok: true });
    });
  });

  it.each([
    ["subject kind", "subject_kind = 'legacy_migration'"],
    ["subject key", "subject_key = 'reservation:other'"],
    ["result kind", "result_kind = 'other'"],
    ["command type", "command_type = 'reservation.expire'"],
    ["recorded time", "recorded_at = '2026-07-13T01:00:00Z'"],
  ])("U-PA-018: rejects receipt %s tampering", (_label, mutation) => {
    withLedger(({ db, ledger }) => {
      ledger.reserve(reserveInput());
      db.exec("DROP TRIGGER trg_append_command_receipts_no_update");
      db.exec(`UPDATE append_command_receipts SET ${mutation}`);
      const trigger = ledgerSchemaDdl().find((sql) =>
        sql.includes("trg_append_command_receipts_no_update"),
      );
      if (!trigger) throw new Error("fixture trigger missing");
      db.exec(trigger);
      expect(migratePlanLedger(db)).toMatchObject({
        ok: false,
        ruleId: "plan-ledger-unavailable",
      });
    });
  });
});

function reserveInput() {
  return {
    reservationId: "reservation:a",
    namespace: "PLAN-L7",
    ordinal: 418,
    assetId: "plan:a",
    leaseKeyVersion: "v2",
    leaseTokenHash: digest,
    commandId: "command:a",
    occurredAt: now,
    expiresAt: later,
  };
}

function withLedger(
  run: (fixture: { db: ReturnType<typeof openHarnessDb>; ledger: PlanLedger }) => void,
): void {
  const db = openHarnessDb(":memory:");
  try {
    migratePlanLedger(db);
    seedAsset(db, "plan:a");
    seedAsset(db, "plan:b");
    run({ db, ledger: new PlanLedger(db) });
  } finally {
    db.close();
  }
}

function seedAsset(db: ReturnType<typeof openHarnessDb>, assetId: string): void {
  db.prepare("INSERT INTO plan_assets VALUES (?, ?, ?, ?)").run(
    assetId,
    now,
    "b".repeat(40),
    "test",
  );
}

function count(db: ReturnType<typeof openHarnessDb>, table: string): number {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0);
}

function counts(db: ReturnType<typeof openHarnessDb>): readonly number[] {
  return [
    count(db, "plan_id_reservation_events"),
    count(db, "plan_id_reservations"),
    count(db, "append_command_receipts"),
  ];
}
