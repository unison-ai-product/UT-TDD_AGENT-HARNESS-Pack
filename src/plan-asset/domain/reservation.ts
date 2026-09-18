type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export interface ReservationEvent {
  readonly reservationId: string;
  readonly namespace: string;
  readonly ordinal: number;
  readonly assetId: string;
  readonly leaseKeyVersion: string;
  readonly leaseTokenHash: string;
  readonly commandId: string;
  readonly occurredAt: string;
  readonly expiresAt: string;
  readonly kind: "reserved";
}

export const PlanIdReservation = Object.freeze({
  reserve(
    events: readonly ReservationEvent[],
    input: Omit<ReservationEvent, "kind">,
  ): Result<
    {
      events: readonly ReservationEvent[];
      lease: ReservationEvent;
    },
    { ruleId: string }
  > {
    const replay = events.find((event) => event.commandId === input.commandId);
    if (replay) {
      return samePayload(replay, input)
        ? { ok: true, value: { events, lease: replay } }
        : { ok: false, error: { ruleId: "plan-id-reservation-command-conflict" } };
    }
    const active = events.find(
      (event) =>
        event.namespace === input.namespace &&
        event.ordinal === input.ordinal &&
        Date.parse(event.expiresAt) > Date.parse(input.occurredAt),
    );
    if (active) return { ok: false, error: { ruleId: "plan-id-reservation-conflict" } };
    const lease = Object.freeze({ ...input, kind: "reserved" as const });
    return { ok: true, value: { events: Object.freeze([...events, lease]), lease } };
  },
});

function samePayload(event: ReservationEvent, input: Omit<ReservationEvent, "kind">): boolean {
  return (
    event.reservationId === input.reservationId &&
    event.namespace === input.namespace &&
    event.ordinal === input.ordinal &&
    event.assetId === input.assetId &&
    event.leaseKeyVersion === input.leaseKeyVersion &&
    event.leaseTokenHash === input.leaseTokenHash &&
    event.expiresAt === input.expiresAt
  );
}
