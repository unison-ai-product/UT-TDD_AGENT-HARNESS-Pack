import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HmacLeaseTokenKeyRing } from "../../src/plan-asset/adapters/hmac-lease-token-key-ring.ts";
import {
  frameLeaseTokenContext,
  ReservationService,
} from "../../src/plan-asset/application/reservation-service.ts";
import { PlanLedger } from "../../src/plan-asset/ledger/plan-ledger.ts";
import { migratePlanLedger } from "../../src/plan-asset/ledger/schema.ts";
import type { ClockPort } from "../../src/plan-asset/ports/clock.ts";
import type {
  LeaseTokenKeyRingPort,
  LeaseTokenMac,
} from "../../src/plan-asset/ports/lease-token-key-ring.ts";
import type {
  ReservationLedgerPort,
  ReservationLedgerRecord,
  ReservationLedgerResult,
  ReserveLedgerInput,
} from "../../src/plan-asset/ports/reservation-ledger.ts";
import { openHarnessDb } from "../../src/state-db/index.ts";

describe("PLAN reservation service", () => {
  it("U-PA-043: freezes the seven-field length-prefixed HMAC input and known vector", () => {
    const message = frameLeaseTokenContext({
      commandId: "command:a",
      reservationId: "reservation:a",
      namespace: "PLAN-L7",
      ordinal: 418,
      assetId: "plan:a",
      occurredAt: "2026-07-14T00:00:00.000Z",
      expiresAt: "2026-07-14T01:00:00.000Z",
    });
    expect(Buffer.from(message).toString("hex")).toBe(
      "00000009636f6d6d616e643a610000000d7265736572766174696f6e3a6100000007504c414e2d4c370000000334313800000006706c616e3a6100000018323032362d30372d31345430303a30303a30302e3030305a00000018323032362d30372d31345430313a30303a30302e3030305a",
    );
    const keyRing = new HmacLeaseTokenKeyRing("v2", [
      { version: "v2", secret: Buffer.alloc(32, 0x0b) }, // test-only deterministic fixture
    ]);
    expect(Object.getOwnPropertyNames(keyRing)).not.toEqual(
      expect.arrayContaining(["keys", "currentVersion"]),
    );
    expect(Buffer.from(keyRing.issueMac(message).mac).toString("hex")).toBe(
      "487c01a611e5644dca7e5cf7b0e02cd7cf974c320e60bcbaabb816930eafdb2b",
    );
  });

  it("U-PA-043: issues a raw lease once, stores only its hash, and recovers the same replay", () => {
    const db = openHarnessDb(":memory:");
    try {
      migratePlanLedger(db);
      db.prepare("INSERT INTO plan_assets VALUES (?, ?, ?, ?)").run(
        "plan:a",
        "2026-07-14T00:00:00Z",
        "b".repeat(40),
        "test",
      );
      const clock = new SequenceClock(["2026-07-14T00:00:00Z"]);
      const keyRing = new FakeKeyRing();
      const service = new ReservationService(new PlanLedger(db), clock, keyRing);
      const request = {
        reservationId: "reservation:a",
        namespace: "PLAN-L7",
        ordinal: 418,
        assetId: "plan:a",
        leaseMs: 3_600_000,
        commandId: "command:a",
      };

      const first = service.reserve(request);
      const replay = service.reserve(request);

      expect(first).toMatchObject({ ok: true, replayed: false });
      expect(replay).toEqual({ ...first, replayed: true });
      if (!first.ok) throw new Error("reservation fixture must succeed");
      expect(first.leaseToken).toMatch(/^utl1\.v2\.[A-Za-z0-9_-]+$/);
      expect(clock.calls).toBe(1);
      expect(keyRing.issueCalls).toBe(1);
      expect(keyRing.recoverVersions).toEqual(["v2"]);
      const persisted = JSON.stringify({
        events: db.prepare("SELECT * FROM plan_id_reservation_events").all(),
        current: db.prepare("SELECT * FROM plan_id_reservations").all(),
        receipts: db.prepare("SELECT * FROM append_command_receipts").all(),
      });
      expect(persisted).not.toContain(first.leaseToken);
      expect(persisted).toContain(first.leaseTokenHash);
      expect(persisted).toContain('"lease_key_version":"v2"');
    } finally {
      db.close();
    }
  });

  it("U-PA-043: rejects replay payload drift and never replaces an unavailable historical key", () => {
    const db = openHarnessDb(":memory:");
    try {
      migratePlanLedger(db);
      db.prepare("INSERT INTO plan_assets VALUES (?, ?, ?, ?)").run(
        "plan:a",
        "2026-07-14T00:00:00Z",
        "b".repeat(40),
        "test",
      );
      const keyRing = new FakeKeyRing();
      const service = new ReservationService(
        new PlanLedger(db),
        new SequenceClock(["2026-07-14T00:00:00Z", "2026-07-14T00:00:00Z"]),
        keyRing,
      );
      const request = {
        reservationId: "reservation:a",
        namespace: "PLAN-L7",
        ordinal: 418,
        assetId: "plan:a",
        leaseMs: 3_600_000,
        commandId: "command:a",
      };
      expect(service.reserve(request)).toMatchObject({ ok: true });
      expect(service.reserve({ ...request, leaseMs: 7_200_000 })).toEqual({
        ok: false,
        ruleId: "plan-id-reservation-command-conflict",
      });
      expect(
        service.reserve({
          ...request,
          commandId: "command:huge-lease",
          leaseMs: Number.MAX_SAFE_INTEGER,
        }),
      ).toEqual({ ok: false, ruleId: "plan-id-reservation-invalid" });
      keyRing.corruptRecovery = true;
      expect(service.reserve(request)).toEqual({
        ok: false,
        ruleId: "plan-id-reservation-token-mismatch",
      });
      keyRing.corruptRecovery = false;
      keyRing.availableVersions.clear();
      expect(service.reserve(request)).toEqual({
        ok: false,
        ruleId: "plan-id-reservation-key-unavailable",
      });
      expect(keyRing.issueCalls).toBe(1);
    } finally {
      db.close();
    }
  });

  it("U-PA-043: hashes a raw release token before crossing the ledger boundary", () => {
    const db = openHarnessDb(":memory:");
    try {
      migratePlanLedger(db);
      db.prepare("INSERT INTO plan_assets VALUES (?, ?, ?, ?)").run(
        "plan:a",
        "2026-07-14T00:00:00Z",
        "b".repeat(40),
        "test",
      );
      const service = new ReservationService(
        new PlanLedger(db),
        new SequenceClock(["2026-07-14T00:00:00Z", "2026-07-14T00:30:00Z"]),
        new FakeKeyRing(),
      );
      const lease = service.reserve({
        reservationId: "reservation:a",
        namespace: "PLAN-L7",
        ordinal: 418,
        assetId: "plan:a",
        leaseMs: 3_600_000,
        commandId: "command:a",
      });
      if (!lease.ok) throw new Error("reservation fixture must succeed");
      expect(
        service.release({
          reservationId: "reservation:a",
          leaseToken: lease.leaseToken,
          commandId: "command:release",
        }),
      ).toMatchObject({ ok: true });
      expect(
        JSON.stringify(db.prepare("SELECT * FROM plan_id_reservation_events").all()),
      ).not.toContain(lease.leaseToken);
    } finally {
      db.close();
    }
  });

  it("U-PA-043: discards locally issued material and recovers the race winner version", () => {
    const request = {
      reservationId: "reservation:a",
      namespace: "PLAN-L7",
      ordinal: 418,
      assetId: "plan:a",
      leaseMs: 3_600_000,
      commandId: "command:a",
    };
    const occurredAt = "2026-07-14T00:00:00.000Z";
    const expiresAt = "2026-07-14T01:00:00.000Z";
    const message = frameLeaseTokenContext({ ...request, occurredAt, expiresAt });
    const winnerToken = `utl1.v2.${Buffer.from(mac("v2", message)).toString("base64url")}`;
    const winner: ReservationLedgerRecord = {
      ...request,
      leaseKeyVersion: "v2",
      leaseTokenHash: createHash("sha256").update(winnerToken).digest("hex"),
      occurredAt,
      expiresAt,
    };
    const keyRing = new FakeKeyRing();
    keyRing.currentVersion = "v3";
    keyRing.availableVersions.add("v3");
    const service = new ReservationService(
      new RaceLedger(winner),
      new SequenceClock([occurredAt]),
      keyRing,
    );
    expect(service.reserve(request)).toMatchObject({
      ok: true,
      replayed: true,
      leaseKeyVersion: "v2",
      leaseToken: winnerToken,
    });
    expect(keyRing.issueCalls).toBe(1);
    expect(keyRing.recoverVersions).toEqual(["v2"]);
  });
});

class SequenceClock implements ClockPort {
  calls = 0;
  private readonly values: string[];

  constructor(values: string[]) {
    this.values = values;
  }
  now(): string {
    this.calls += 1;
    const value = this.values.shift();
    if (!value) throw new Error("clock exhausted");
    return value;
  }
}

class FakeKeyRing implements LeaseTokenKeyRingPort {
  issueCalls = 0;
  readonly recoverVersions: string[] = [];
  readonly availableVersions = new Set(["v2"]);
  corruptRecovery = false;
  currentVersion = "v2";

  issueMac(message: Uint8Array): LeaseTokenMac {
    this.issueCalls += 1;
    return { keyVersion: this.currentVersion, mac: mac(this.currentVersion, message) };
  }

  recoverMac(keyVersion: string, message: Uint8Array): Uint8Array | null {
    this.recoverVersions.push(keyVersion);
    if (!this.availableVersions.has(keyVersion)) return null;
    return this.corruptRecovery ? mac("corrupt", message) : mac(keyVersion, message);
  }
}

class RaceLedger implements ReservationLedgerPort {
  private reads = 0;

  private readonly winner: ReservationLedgerRecord;

  constructor(winner: ReservationLedgerRecord) {
    this.winner = winner;
  }

  findReserveByCommand(): ReservationLedgerRecord | null {
    this.reads += 1;
    return this.reads === 1 ? null : this.winner;
  }

  reserve(_input: ReserveLedgerInput): ReservationLedgerResult {
    return { ok: false, ruleId: "plan-id-reservation-command-conflict" };
  }

  release(): ReservationLedgerResult {
    return { ok: false, ruleId: "not-used" };
  }
}

function mac(version: string, message: Uint8Array): Uint8Array {
  return createHash("sha256").update(version).update(message).digest();
}
