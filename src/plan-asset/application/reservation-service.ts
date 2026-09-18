import { createHash, timingSafeEqual } from "node:crypto";
import type { ClockPort } from "../ports/clock.ts";
import type { LeaseTokenKeyRingPort } from "../ports/lease-token-key-ring.ts";
import type {
  ReservationLedgerPort,
  ReservationLedgerRecord,
} from "../ports/reservation-ledger.ts";

export interface ReserveRequest {
  readonly reservationId: string;
  readonly namespace: string;
  readonly ordinal: number;
  readonly assetId: string;
  readonly leaseMs: number;
  readonly commandId: string;
}

export type ReservationLease =
  | {
      readonly ok: true;
      readonly replayed: boolean;
      readonly reservationId: string;
      readonly leaseToken: string;
      readonly leaseTokenHash: string;
      readonly leaseKeyVersion: string;
      readonly occurredAt: string;
      readonly expiresAt: string;
    }
  | { readonly ok: false; readonly ruleId: string };

export class ReservationService {
  private readonly ledger: ReservationLedgerPort;
  private readonly clock: ClockPort;
  private readonly keyRing: LeaseTokenKeyRingPort;

  constructor(ledger: ReservationLedgerPort, clock: ClockPort, keyRing: LeaseTokenKeyRingPort) {
    this.ledger = ledger;
    this.clock = clock;
    this.keyRing = keyRing;
  }

  reserve(request: ReserveRequest): ReservationLease {
    if (!validRequest(request)) return failed("plan-id-reservation-invalid");
    const existing = this.ledger.findReserveByCommand(request.commandId);
    if (existing) return this.replay(request, existing);

    const occurredAt = canonicalTime(this.clock.now());
    if (!occurredAt) return failed("plan-id-reservation-clock-invalid");
    const expiresMs = Date.parse(occurredAt) + request.leaseMs;
    if (!Number.isSafeInteger(expiresMs) || Math.abs(expiresMs) > 8_640_000_000_000_000) {
      return failed("plan-id-reservation-invalid");
    }
    const expiresAt = new Date(expiresMs).toISOString();
    const context = contextFor(request, occurredAt, expiresAt);
    const message = frameLeaseTokenContext(context);
    const issued = this.keyRing.issueMac(message);
    const material = tokenMaterial(issued.keyVersion, issued.mac);
    if (!material) return failed("plan-id-reservation-key-invalid");

    try {
      const result = this.ledger.reserve({
        reservationId: request.reservationId,
        namespace: request.namespace,
        ordinal: request.ordinal,
        assetId: request.assetId,
        leaseKeyVersion: material.leaseKeyVersion,
        leaseTokenHash: material.leaseTokenHash,
        commandId: request.commandId,
        occurredAt,
        expiresAt,
      });
      if (result.ok && !result.replayed) {
        return {
          ok: true,
          replayed: false,
          reservationId: request.reservationId,
          ...material,
          occurredAt,
          expiresAt,
        };
      }
      const winner = this.ledger.findReserveByCommand(request.commandId);
      if (winner) return this.replay(request, winner);
      return result.ok ? failed("plan-id-reservation-command-conflict") : result;
    } catch (error) {
      const winner = this.ledger.findReserveByCommand(request.commandId);
      if (winner) return this.replay(request, winner);
      throw error;
    }
  }

  release(request: {
    readonly reservationId: string;
    readonly leaseToken: string;
    readonly commandId: string;
  }) {
    if (
      !request.reservationId.trim() ||
      !request.commandId.trim() ||
      !/^utl1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(request.leaseToken)
    ) {
      return failed("plan-id-reservation-invalid");
    }
    const occurredAt = canonicalTime(this.clock.now());
    if (!occurredAt) return failed("plan-id-reservation-clock-invalid");
    return this.ledger.release({
      reservationId: request.reservationId,
      leaseTokenHash: hashToken(request.leaseToken),
      commandId: request.commandId,
      occurredAt,
    });
  }

  private replay(request: ReserveRequest, record: ReservationLedgerRecord): ReservationLease {
    const leaseMs = Date.parse(record.expiresAt) - Date.parse(record.occurredAt);
    if (
      request.reservationId !== record.reservationId ||
      request.namespace !== record.namespace ||
      request.ordinal !== record.ordinal ||
      request.assetId !== record.assetId ||
      request.leaseMs !== leaseMs
    ) {
      return failed("plan-id-reservation-command-conflict");
    }
    const context = contextFor(request, record.occurredAt, record.expiresAt);
    const mac = this.keyRing.recoverMac(record.leaseKeyVersion, frameLeaseTokenContext(context));
    if (!mac) return failed("plan-id-reservation-key-unavailable");
    const material = tokenMaterial(record.leaseKeyVersion, mac);
    if (!material || !sameHash(material.leaseTokenHash, record.leaseTokenHash)) {
      return failed("plan-id-reservation-token-mismatch");
    }
    return {
      ok: true,
      replayed: true,
      reservationId: record.reservationId,
      ...material,
      occurredAt: record.occurredAt,
      expiresAt: record.expiresAt,
    };
  }
}

interface LeaseTokenContext {
  readonly commandId: string;
  readonly reservationId: string;
  readonly namespace: string;
  readonly ordinal: number;
  readonly assetId: string;
  readonly occurredAt: string;
  readonly expiresAt: string;
}

export function frameLeaseTokenContext(context: LeaseTokenContext): Uint8Array {
  const values = [
    context.commandId,
    context.reservationId,
    context.namespace,
    String(context.ordinal),
    context.assetId,
    context.occurredAt,
    context.expiresAt,
  ];
  const frames = values.map((value) => {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  });
  return Buffer.concat(frames);
}

function contextFor(
  request: ReserveRequest,
  occurredAt: string,
  expiresAt: string,
): LeaseTokenContext {
  return {
    commandId: request.commandId,
    reservationId: request.reservationId,
    namespace: request.namespace,
    ordinal: request.ordinal,
    assetId: request.assetId,
    occurredAt,
    expiresAt,
  };
}

function tokenMaterial(keyVersion: string, mac: Uint8Array) {
  if (!/^[A-Za-z0-9_-]+$/.test(keyVersion) || mac.byteLength !== 32) return null;
  const leaseToken = `utl1.${keyVersion}.${Buffer.from(mac).toString("base64url")}`;
  return {
    leaseToken,
    leaseTokenHash: hashToken(leaseToken),
    leaseKeyVersion: keyVersion,
  } as const;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sameHash(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

function canonicalTime(value: string): string | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function validRequest(request: ReserveRequest): boolean {
  return (
    Boolean(request.reservationId.trim()) &&
    Boolean(request.namespace.trim()) &&
    Boolean(request.assetId.trim()) &&
    Boolean(request.commandId.trim()) &&
    Number.isSafeInteger(request.ordinal) &&
    request.ordinal > 0 &&
    Number.isSafeInteger(request.leaseMs) &&
    request.leaseMs > 0
  );
}

function failed(ruleId: string): { readonly ok: false; readonly ruleId: string } {
  return { ok: false, ruleId };
}
