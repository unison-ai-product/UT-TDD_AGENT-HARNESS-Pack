export const PLAN_ID_PATTERN =
  /^PLAN-(L(?:[0-9]|1[0-4])|DISCOVERY|REVERSE|RECOVERY|M)-(\d{2,})(?:-[a-z0-9-]+)?$/;

export type PlanIdToken =
  | `L${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14}`
  | "DISCOVERY"
  | "REVERSE"
  | "RECOVERY"
  | "M";

export interface PlanIdIdentity {
  readonly token: PlanIdToken;
  readonly namespace: PlanIdToken;
  readonly ordinalText: string;
  readonly ordinal: number;
}

/** §1.10 Aの正規PLAN IDを、表示上のzero paddingを失わず予約座標へ分解する。 */
export function parsePlanIdIdentity(planId: string): PlanIdIdentity | null {
  const match = PLAN_ID_PATTERN.exec(planId);
  if (!match) return null;
  const ordinal = Number(match[2]);
  if (!Number.isSafeInteger(ordinal)) return null;
  const token = match[1] as PlanIdToken;
  return { token, namespace: token, ordinalText: match[2], ordinal };
}

/** M-*の凍結legacy identityと、新規ledger予約可能identityを分離する。 */
export function parseReservablePlanIdIdentity(planId: string): PlanIdIdentity | null {
  const identity = parsePlanIdIdentity(planId);
  return identity && identity.token !== "M" && identity.ordinal > 0 ? identity : null;
}

export function planIdMatchesShape(
  identity: PlanIdIdentity,
  shape: { readonly kind?: string; readonly layer?: string },
): boolean {
  if (identity.token.startsWith("L")) return shape.layer === identity.token;
  if (identity.token === "DISCOVERY") return shape.kind === "poc" && shape.layer === "cross";
  if (identity.token === "REVERSE") return shape.kind === "reverse" && shape.layer === "cross";
  if (identity.token === "RECOVERY") return shape.kind === "recovery" && shape.layer === "cross";
  return false;
}
