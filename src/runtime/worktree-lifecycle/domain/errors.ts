import type { LifecycleDenyReason, LifecycleState } from "./types.ts";

export type LifecycleErrorCode =
  | "duplicate_lifecycle"
  | "invalid_transition"
  | "stale_revision"
  | "attempt_mismatch"
  | "activation_unresolved"
  | "activation_abort_unresolved"
  | "owner_unknown"
  | "inventory_unavailable"
  | "terminal_missing"
  | "terminal_mismatch"
  | "replay_conflict";

export class WorktreeLifecycleError extends Error {
  readonly code: LifecycleErrorCode;
  readonly lifecycleId?: string;
  readonly fromState?: LifecycleState;
  readonly toState?: LifecycleState;
  readonly reason?: LifecycleDenyReason;

  constructor(
    code: LifecycleErrorCode,
    message: string,
    details: {
      lifecycleId?: string;
      fromState?: LifecycleState;
      toState?: LifecycleState;
      reason?: LifecycleDenyReason;
    } = {},
  ) {
    super(message);
    this.name = "WorktreeLifecycleError";
    this.code = code;
    this.lifecycleId = details.lifecycleId;
    this.fromState = details.fromState;
    this.toState = details.toState;
    this.reason = details.reason;
  }
}
