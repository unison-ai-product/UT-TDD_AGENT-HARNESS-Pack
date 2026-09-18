import { WorktreeLifecycleError } from "./errors.ts";
import { reduceLifecycle } from "./reducer.ts";
import type {
  ActivationAbortInput,
  ActivationEvidence,
  LifecycleEvent,
  LifecycleIdentity,
  PlannedLifecycleInput,
  RetainedReevaluationInput,
  RetainInput,
  RetireInput,
  TerminalInput,
  WorktreeLifecycleRecord,
} from "./types.ts";

function freezeRecord(record: WorktreeLifecycleRecord): WorktreeLifecycleRecord {
  return Object.freeze({
    ...record,
    identity: Object.freeze({ ...record.identity }),
    denyReasons: Object.freeze([...record.denyReasons]),
    denyHistory: Object.freeze([...record.denyHistory]),
    ...(record.retention ? { retention: Object.freeze({ ...record.retention }) } : {}),
  });
}

function lifecycleKey(input: LifecycleIdentity): string {
  return `${input.repositoryLineageId}\u0000${input.lifecycleId}\u0000${input.canonicalWorktreeRealpath}`;
}

function sameIdentity(left: LifecycleIdentity, right: LifecycleIdentity): boolean {
  return (
    left.repositoryLineageId === right.repositoryLineageId &&
    left.lifecycleId === right.lifecycleId &&
    left.canonicalWorktreeRealpath === right.canonicalWorktreeRealpath
  );
}

function nonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function authenticatedOwnerLoss(current: WorktreeLifecycleRecord, input: TerminalInput): boolean {
  const evidence = input.ownerLossEvidence;
  return (
    input.kind === "parent_loss" &&
    evidence?.kind === "authenticated_owner_loss" &&
    evidence.authenticated === true &&
    evidence.sessionId === current.ownerSessionId &&
    nonEmpty(evidence.sessionId) &&
    nonEmpty(evidence.observedAt) &&
    Number.isFinite(Date.parse(evidence.observedAt)) &&
    nonEmpty(evidence.evidenceDigest)
  );
}

export class WorktreeLifecycleStore {
  private readonly records = new Map<string, WorktreeLifecycleRecord>();
  private readonly keys = new Set<string>();
  private readonly eventLog: LifecycleEvent[] = [];

  plan(input: PlannedLifecycleInput): WorktreeLifecycleRecord {
    if (
      input.identity.repositoryLineageId !== input.repositoryLineageId ||
      input.identity.lifecycleId !== input.lifecycleId ||
      input.identity.canonicalWorktreeRealpath !== input.canonicalWorktreeRealpath
    ) {
      throw new WorktreeLifecycleError("attempt_mismatch", "record identity fields disagree", {
        lifecycleId: input.lifecycleId,
      });
    }
    const key = lifecycleKey(input.identity);
    if (this.keys.has(key)) {
      throw new WorktreeLifecycleError(
        "duplicate_lifecycle",
        "lifecycle identity is already planned",
        {
          lifecycleId: input.lifecycleId,
        },
      );
    }
    if (input.attempt < 1 || !Number.isSafeInteger(input.attempt)) {
      throw new WorktreeLifecycleError(
        "invalid_transition",
        "attempt must be a positive safe integer",
        {
          lifecycleId: input.lifecycleId,
        },
      );
    }
    const record = freezeRecord({
      ...input,
      identity: Object.freeze({ ...input.identity }),
      state: "planned",
      revision: 1,
      activationStatus: input.activationStatus ?? "unresolved",
      denyReasons: Object.freeze([]),
      denyHistory: Object.freeze([]),
    });
    const event: LifecycleEvent = {
      type: "planned",
      identity: record.identity,
      lifecycleId: record.lifecycleId,
      attempt: record.attempt,
      revision: 1,
      record,
    };
    return this.append(key, undefined, event);
  }

  activate(identity: LifecycleIdentity, evidence: ActivationEvidence): WorktreeLifecycleRecord {
    const current = this.require(identity);
    this.assertAttempt(current, evidence.attempt);
    if (current.state !== "planned") return this.invalid(current, "active");
    let activationFailure:
      | "activation_unresolved"
      | "owner_unknown"
      | "inventory_unavailable"
      | undefined;
    if (current.activationStatus !== "unresolved" || !evidence.workerStartReceiptDigest) {
      activationFailure = "activation_unresolved";
    } else if (!evidence.ownerAuthenticated) {
      activationFailure = "owner_unknown";
    } else if (!evidence.inventoryAvailable) {
      activationFailure = "inventory_unavailable";
    }
    if (activationFailure) {
      throw new WorktreeLifecycleError(
        activationFailure,
        `activation evidence is incomplete: ${activationFailure}`,
        {
          lifecycleId: identity.lifecycleId,
          reason: activationFailure,
        },
      );
    }
    return this.transition(current, {
      type: "activated",
      identity,
      lifecycleId: identity.lifecycleId,
      attempt: current.attempt,
      revision: current.revision + 1,
      workerStartReceiptDigest: evidence.workerStartReceiptDigest,
    });
  }

  abortActivation(
    identity: LifecycleIdentity,
    input: ActivationAbortInput,
  ): WorktreeLifecycleRecord {
    const current = this.require(identity);
    this.assertAttempt(current, input.attempt);
    if (
      !input.activationAbortReceiptDigest ||
      input.pathLeaseRelease.released !== true ||
      !input.pathLeaseRelease.receiptDigest
    ) {
      throw new WorktreeLifecycleError(
        "activation_abort_unresolved",
        "activation abort requires a sealed abort receipt and released path-lease receipt",
        { lifecycleId: identity.lifecycleId, reason: "activation_unresolved" },
      );
    }
    return this.transition(current, {
      type: "activation_aborted",
      identity,
      lifecycleId: identity.lifecycleId,
      attempt: current.attempt,
      revision: current.revision + 1,
      reason: input.reason,
      activationAbortReceiptDigest: input.activationAbortReceiptDigest,
      pathLeaseReleaseReceiptDigest: input.pathLeaseRelease.receiptDigest,
    });
  }

  terminal(identity: LifecycleIdentity, input: TerminalInput): WorktreeLifecycleRecord {
    const current = this.require(identity);
    this.assertAttempt(current, input.attempt);
    const hasReceipt = Boolean(input.terminalReceiptDigest);
    const hasOwnerLoss = authenticatedOwnerLoss(current, input);
    if (!hasReceipt && !hasOwnerLoss) {
      throw new WorktreeLifecycleError(
        "terminal_missing",
        "terminal receipt is required unless authenticated parent loss is present",
        { lifecycleId: identity.lifecycleId, reason: "terminal_missing" },
      );
    }
    const denyReasons = [
      ...new Set([
        ...(input.denyReasons ?? []),
        ...(hasReceipt ? [] : ["terminal_missing" as const]),
      ]),
    ];
    return this.transition(current, {
      type: "terminal_pending",
      identity,
      lifecycleId: identity.lifecycleId,
      attempt: current.attempt,
      revision: current.revision + 1,
      terminalKind: input.kind,
      ...(input.terminalReceiptDigest
        ? { terminalReceiptDigest: input.terminalReceiptDigest }
        : {}),
      ...(hasOwnerLoss ? { ownerLossEvidenceDigest: input.ownerLossEvidence?.evidenceDigest } : {}),
      denyReasons,
    });
  }

  retain(identity: LifecycleIdentity, input: RetainInput): WorktreeLifecycleRecord {
    const current = this.require(identity);
    this.assertAttempt(current, input.attempt);
    if (input.denyReasons.length === 0) {
      throw new WorktreeLifecycleError(
        "invalid_transition",
        "retention requires at least one typed deny reason",
        {
          lifecycleId: identity.lifecycleId,
        },
      );
    }
    return this.transition(current, {
      type: "retained",
      identity,
      lifecycleId: identity.lifecycleId,
      attempt: current.attempt,
      revision: current.revision + 1,
      // Retention is an observation of the current lifecycle, not a replacement
      // for domain-owned denial state. A caller may add a typed reason, but it
      // must not be able to erase an activation/terminal denial before the
      // corresponding discharge transition has been observed.
      denyReasons: [...new Set([...current.denyReasons, ...input.denyReasons])].sort(),
      ...(input.retention ? { retention: input.retention } : {}),
    });
  }

  retire(identity: LifecycleIdentity, input: RetireInput): WorktreeLifecycleRecord {
    const current = this.require(identity);
    this.assertAttempt(current, input.attempt);
    if (current.state !== "terminal_pending") {
      return this.invalid(current, "retired");
    }
    if (!input.inventoryAvailable) {
      throw new WorktreeLifecycleError(
        "inventory_unavailable",
        "retire requires an available inventory snapshot",
        {
          lifecycleId: identity.lifecycleId,
          reason: "inventory_unavailable",
        },
      );
    }
    const digest = input.terminalReceiptDigest ?? current.terminalReceiptDigest;
    if (
      input.terminalReceiptDigest &&
      current.terminalReceiptDigest &&
      input.terminalReceiptDigest !== current.terminalReceiptDigest
    ) {
      throw new WorktreeLifecycleError(
        "terminal_mismatch",
        "retire receipt does not match the current terminal receipt",
        { lifecycleId: identity.lifecycleId, reason: "terminal_mismatch" },
      );
    }
    if (!digest || current.denyReasons.length > 0) {
      throw new WorktreeLifecycleError(
        "terminal_missing",
        "retire requires a sealed terminal receipt and no deny reason",
        {
          lifecycleId: identity.lifecycleId,
          reason: current.denyReasons[0] ?? "terminal_missing",
        },
      );
    }
    return this.transition(current, {
      type: "retired",
      identity,
      lifecycleId: identity.lifecycleId,
      attempt: current.attempt,
      revision: current.revision + 1,
      terminalReceiptDigest: digest,
    });
  }

  reevaluateRetained(
    identity: LifecycleIdentity,
    input: RetainedReevaluationInput,
  ): WorktreeLifecycleRecord {
    const current = this.require(identity);
    this.assertAttempt(current, input.attempt);
    if (
      current.state === "terminal_pending" &&
      current.terminalReceiptDigest === input.terminalReceiptDigest &&
      current.terminalKind === input.terminalKind
    ) {
      return current;
    }
    if (
      current.state === "terminal_pending" &&
      current.terminalReceiptDigest &&
      current.terminalReceiptDigest !== input.terminalReceiptDigest
    ) {
      throw new WorktreeLifecycleError(
        "replay_conflict",
        "a different terminal receipt cannot replace the pending receipt",
        { lifecycleId: identity.lifecycleId, reason: "replay_conflict" },
      );
    }
    if (current.state !== "retained") return this.invalid(current, "terminal_pending");
    if (
      current.terminalReceiptDigest &&
      current.terminalReceiptDigest !== input.terminalReceiptDigest
    ) {
      throw new WorktreeLifecycleError(
        "replay_conflict",
        "a different terminal receipt cannot replace the retained receipt",
        {
          lifecycleId: identity.lifecycleId,
          reason: "replay_conflict",
        },
      );
    }
    return this.transition(current, {
      type: "reevaluated",
      identity,
      lifecycleId: identity.lifecycleId,
      attempt: current.attempt,
      revision: current.revision + 1,
      terminalKind: input.terminalKind,
      terminalReceiptDigest: input.terminalReceiptDigest,
    });
  }

  events(): readonly LifecycleEvent[] {
    return Object.freeze(this.eventLog.map((event) => Object.freeze(event)));
  }

  get(identity: LifecycleIdentity): WorktreeLifecycleRecord | undefined {
    return this.records.get(lifecycleKey(identity));
  }

  private require(identity: LifecycleIdentity): WorktreeLifecycleRecord {
    const record = this.records.get(lifecycleKey(identity));
    if (!record)
      throw new WorktreeLifecycleError("invalid_transition", "unknown lifecycle", {
        lifecycleId: identity.lifecycleId,
      });
    if (!sameIdentity(record.identity, identity)) {
      throw new WorktreeLifecycleError(
        "attempt_mismatch",
        "requested lifecycle identity does not match record",
        {
          lifecycleId: identity.lifecycleId,
        },
      );
    }
    return record;
  }

  private assertAttempt(record: WorktreeLifecycleRecord, attempt: number): void {
    if (record.attempt !== attempt) {
      throw new WorktreeLifecycleError(
        "attempt_mismatch",
        "attempt does not match lifecycle record",
        {
          lifecycleId: record.lifecycleId,
        },
      );
    }
  }

  private invalid(
    record: WorktreeLifecycleRecord,
    toState: WorktreeLifecycleRecord["state"],
  ): never {
    throw new WorktreeLifecycleError(
      "invalid_transition",
      `invalid lifecycle transition: ${record.state} -> ${toState}`,
      {
        lifecycleId: record.lifecycleId,
        fromState: record.state,
        toState,
      },
    );
  }

  private transition(
    record: WorktreeLifecycleRecord,
    event: LifecycleEvent,
  ): WorktreeLifecycleRecord {
    return this.append(lifecycleKey(record.identity), record, event);
  }

  private append(
    key: string,
    current: WorktreeLifecycleRecord | undefined,
    event: LifecycleEvent,
  ): WorktreeLifecycleRecord {
    const next = reduceLifecycle(current, event);
    this.eventLog.push(
      Object.freeze({
        ...event,
        ...(event.type === "planned" ? { record: freezeRecord(event.record) } : {}),
        ...(event.type === "terminal_pending" || event.type === "retained"
          ? {
              denyReasons: Object.freeze([...event.denyReasons]),
              ...(event.type === "retained" && event.retention
                ? { retention: Object.freeze({ ...event.retention }) }
                : {}),
            }
          : {}),
      }) as LifecycleEvent,
    );
    this.records.set(lifecycleKey(next.identity), next);
    this.keys.add(key);
    return next;
  }
}
