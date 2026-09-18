export type MigrationDecision = "pending" | "migrated" | "rekeyed" | "rejected";
export type MigrationEventKind = "observed" | "decided" | "revised";

export interface MigrationFields {
  readonly decision: MigrationDecision;
  readonly resolvedAlias: string | null;
  readonly collisionGroup: string | null;
  readonly lossFields: readonly string[];
  readonly reason: string;
  readonly reviewPlanId: string | null;
}

export interface MigrationEvent extends MigrationFields {
  readonly kind: MigrationEventKind;
  readonly sequence: number;
  readonly legacyPlanId: string;
  readonly assetId: string;
  readonly repositoryIdentity: string;
  readonly identityDigest: string;
  readonly sourceDigest: string;
  readonly occurredAt: string;
}

export interface MigrationState extends MigrationFields {
  readonly sequence: number;
  readonly legacyPlanId: string;
  readonly assetId: string;
  readonly repositoryIdentity: string;
  readonly identityDigest: string;
  readonly sourceDigest: string;
  readonly occurredAt: string;
}

type MigrationResult =
  | { readonly ok: true; readonly state: Readonly<MigrationState> }
  | { readonly ok: false; readonly ruleId: string };

export function reduceLegacyMigration(events: readonly MigrationEvent[]): MigrationResult {
  let state: Readonly<MigrationState> | null = null;
  for (const event of events) {
    const violation = eventViolation(state, event);
    if (violation) return { ok: false, ruleId: violation };
    state = Object.freeze({ ...event, occurredAt: event.occurredAt });
  }
  return state ? { ok: true, state } : { ok: false, ruleId: "plan-migration-event-stream-empty" };
}

export function validateMigrationFields(fields: MigrationFields): string | null {
  const loss = uniqueNonEmpty(fields.lossFields);
  if (!fields.reason.trim() || !loss) return "plan-migration-decision-invalid";
  switch (fields.decision) {
    case "pending":
      return fields.resolvedAlias === null && fields.reviewPlanId !== null && loss.length === 0
        ? null
        : "plan-migration-decision-invalid";
    case "migrated":
      return fields.resolvedAlias !== null &&
        fields.collisionGroup === null &&
        fields.reviewPlanId === null &&
        loss.length === 0
        ? null
        : "plan-migration-decision-invalid";
    case "rekeyed":
      return fields.resolvedAlias !== null &&
        fields.collisionGroup !== null &&
        fields.reviewPlanId !== null &&
        loss.length === 0
        ? null
        : "plan-migration-decision-invalid";
    case "rejected":
      return fields.resolvedAlias === null && fields.reviewPlanId !== null && loss.length > 0
        ? null
        : "plan-migration-decision-invalid";
  }
}

function eventViolation(
  state: Readonly<MigrationState> | null,
  event: MigrationEvent,
): string | null {
  if (validateMigrationFields(event)) return "plan-migration-decision-invalid";
  if (!Number.isSafeInteger(event.sequence) || event.sequence !== (state?.sequence ?? 0) + 1) {
    return "plan-migration-event-sequence-invalid";
  }
  if (!state) {
    return event.kind === "observed" && event.decision === "pending"
      ? null
      : "plan-migration-transition-invalid";
  }
  if (!sameIdentity(state, event) || Date.parse(event.occurredAt) < Date.parse(state.occurredAt)) {
    return "plan-migration-provenance-invalid";
  }
  if (state.decision === "pending") {
    return event.kind === "decided" && event.decision !== "pending"
      ? null
      : "plan-migration-transition-invalid";
  }
  return event.kind === "revised" &&
    event.decision !== "pending" &&
    event.decision !== state.decision
    ? null
    : "plan-migration-transition-invalid";
}

function sameIdentity(left: MigrationState, right: MigrationEvent): boolean {
  return ["legacyPlanId", "assetId", "repositoryIdentity", "identityDigest", "sourceDigest"].every(
    (key) => left[key as keyof MigrationState] === right[key as keyof MigrationEvent],
  );
}

function uniqueNonEmpty(values: readonly string[]): readonly string[] | null {
  return values.every((value) => value.trim()) && new Set(values).size === values.length
    ? values
    : null;
}
