import { WorktreeLifecycleError } from "./errors.ts";
import type { LifecycleEvent, LifecycleIdentity, WorktreeLifecycleRecord } from "./types.ts";

function immutable<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function uniqueReasons(
  current: readonly WorktreeLifecycleRecord["denyReasons"][number][],
  incoming: readonly WorktreeLifecycleRecord["denyReasons"][number][],
): WorktreeLifecycleRecord["denyReasons"] {
  return Object.freeze([...new Set([...current, ...incoming])].sort());
}

const RECEIPT_DERIVED_DENY_REASONS = new Set<WorktreeLifecycleRecord["denyReasons"][number]>([
  "terminal_missing",
]);

function preserveDomainDenyReasons(
  reasons: readonly WorktreeLifecycleRecord["denyReasons"][number][],
): WorktreeLifecycleRecord["denyReasons"] {
  return Object.freeze(reasons.filter((reason) => !RECEIPT_DERIVED_DENY_REASONS.has(reason)));
}

function sameIdentity(left: LifecycleIdentity, right: LifecycleIdentity): boolean {
  return (
    left.repositoryLineageId === right.repositoryLineageId &&
    left.lifecycleId === right.lifecycleId &&
    left.canonicalWorktreeRealpath === right.canonicalWorktreeRealpath
  );
}

function assertRevision(state: WorktreeLifecycleRecord, event: LifecycleEvent): void {
  if (
    !sameIdentity(event.identity, state.identity) ||
    event.lifecycleId !== state.lifecycleId ||
    event.attempt !== state.attempt
  ) {
    throw new WorktreeLifecycleError("attempt_mismatch", "lifecycle identity or attempt mismatch", {
      lifecycleId: state.lifecycleId,
    });
  }
  if (event.revision !== state.revision + 1) {
    throw new WorktreeLifecycleError("stale_revision", "lifecycle revision is not monotonic", {
      lifecycleId: state.lifecycleId,
    });
  }
}

function transitionError(
  state: WorktreeLifecycleRecord,
  toState: WorktreeLifecycleRecord["state"],
): never {
  throw new WorktreeLifecycleError(
    "invalid_transition",
    `invalid lifecycle transition: ${state.state} -> ${toState}`,
    {
      lifecycleId: state.lifecycleId,
      fromState: state.state,
      toState,
    },
  );
}

export function reduceLifecycle(
  state: WorktreeLifecycleRecord | undefined,
  event: LifecycleEvent,
): WorktreeLifecycleRecord {
  if (!state) {
    if (event.type !== "planned" || event.revision !== 1) {
      throw new WorktreeLifecycleError(
        "invalid_transition",
        "lifecycle must begin with a planned event",
      );
    }
    if (event.record.state !== "planned" || event.record.revision !== 1) {
      throw new WorktreeLifecycleError(
        "invalid_transition",
        "planned event must contain revision-one planned record",
      );
    }
    if (
      !sameIdentity(event.identity, event.record.identity) ||
      event.record.lifecycleId !== event.lifecycleId ||
      event.record.attempt !== event.attempt
    ) {
      throw new WorktreeLifecycleError(
        "attempt_mismatch",
        "planned event identity does not match its record",
        {
          lifecycleId: event.lifecycleId,
        },
      );
    }
    return immutable({
      ...event.record,
      denyReasons: Object.freeze([...event.record.denyReasons]),
      denyHistory: Object.freeze([...event.record.denyHistory]),
    });
  }

  assertRevision(state, event);
  switch (event.type) {
    case "planned":
      return transitionError(state, "planned");
    case "activated":
      if (state.state !== "planned") return transitionError(state, "active");
      return immutable({
        ...state,
        state: "active",
        revision: event.revision,
        activationStatus: "resolved",
        activationReceiptDigest: event.workerStartReceiptDigest,
        denyReasons: Object.freeze([]),
      });
    case "activation_aborted":
      if (state.state !== "planned") return transitionError(state, "terminal_pending");
      return immutable({
        ...state,
        state: "terminal_pending",
        revision: event.revision,
        activationStatus: "aborted",
        activationAbortReceiptDigest: event.activationAbortReceiptDigest,
        pathLeaseReleaseReceiptDigest: event.pathLeaseReleaseReceiptDigest,
        denyReasons: Object.freeze([event.reason]),
        denyHistory: uniqueReasons(state.denyHistory, [event.reason]),
      });
    case "terminal_pending":
      if (state.state !== "active") return transitionError(state, "terminal_pending");
      return immutable({
        ...state,
        state: "terminal_pending",
        revision: event.revision,
        terminalKind: event.terminalKind,
        ...(event.terminalReceiptDigest
          ? { terminalReceiptDigest: event.terminalReceiptDigest }
          : {}),
        ...(event.ownerLossEvidenceDigest
          ? { ownerLossEvidenceDigest: event.ownerLossEvidenceDigest }
          : {}),
        denyReasons: Object.freeze([...event.denyReasons].sort()),
        denyHistory: uniqueReasons(state.denyHistory, event.denyReasons),
      });
    case "retained":
      if (state.state !== "terminal_pending") return transitionError(state, "retained");
      return immutable({
        ...state,
        state: "retained",
        revision: event.revision,
        denyReasons: Object.freeze([...event.denyReasons].sort()),
        denyHistory: uniqueReasons(state.denyHistory, event.denyReasons),
        ...(event.retention ? { retention: immutable({ ...event.retention }) } : {}),
      });
    case "retired":
      if (state.state !== "terminal_pending") return transitionError(state, "retired");
      return immutable({
        ...state,
        state: "retired",
        revision: event.revision,
        terminalReceiptDigest: event.terminalReceiptDigest,
        denyReasons: Object.freeze([]),
      });
    case "reevaluated":
      if (state.state !== "retained") return transitionError(state, "terminal_pending");
      return immutable({
        ...state,
        state: "terminal_pending",
        revision: event.revision,
        terminalKind: event.terminalKind,
        terminalReceiptDigest: event.terminalReceiptDigest,
        denyReasons: preserveDomainDenyReasons(state.denyReasons),
      });
  }
}
