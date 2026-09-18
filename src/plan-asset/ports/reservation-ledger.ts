export interface ReservationLedgerRecord {
  readonly reservationId: string;
  readonly namespace: string;
  readonly ordinal: number;
  readonly assetId: string;
  readonly leaseKeyVersion: string;
  readonly leaseTokenHash: string;
  readonly commandId: string;
  readonly occurredAt: string;
  readonly expiresAt: string;
}

export interface ReserveLedgerInput extends ReservationLedgerRecord {}

export type ReservationLedgerResult =
  | { readonly ok: true; readonly replayed: boolean; readonly resultRef: string }
  | { readonly ok: false; readonly ruleId: string };

export interface ReservationLedgerPort {
  findReserveByCommand(commandId: string): ReservationLedgerRecord | null;
  reserve(input: ReserveLedgerInput): ReservationLedgerResult;
  release(input: {
    readonly reservationId: string;
    readonly leaseTokenHash: string;
    readonly commandId: string;
    readonly occurredAt: string;
  }): ReservationLedgerResult;
}
