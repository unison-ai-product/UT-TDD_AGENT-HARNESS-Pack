import { describe, expect, it } from "vitest";
import {
  type PlannedLifecycleInput,
  WorktreeLifecycleError,
  WorktreeLifecycleStore,
} from "../src/runtime/worktree-lifecycle/domain/index.ts";

function planned(overrides: Partial<PlannedLifecycleInput> = {}): PlannedLifecycleInput {
  const base: Omit<PlannedLifecycleInput, "identity"> = {
    lifecycleId: "lifecycle-001",
    attempt: 1,
    repositoryLineageId: "lineage-001",
    canonicalWorktreeRealpath: "C:/dev/worktree-001",
    adminEntryRealpath: "C:/dev/main/.git/worktrees/worktree-001",
    ownerSessionId: "session-001",
    issueId: 384,
    planId: "PLAN-L7-501-worktree-lifecycle-domain",
    planRevision: "r1",
    use: "worker",
    branch: "feat/issue384-worktree-lifecycle-domain",
    headOid: "1111111111111111111111111111111111111111",
    createdAt: "2026-08-24T00:00:00.000Z",
    activationDeadline: "2026-08-24T00:05:00.000Z",
    expiresAt: "2026-08-25T00:00:00.000Z",
    pathLeaseId: "lease-001",
    parentProcessId: "process-001",
    parentSessionId: "parent-session-001",
    ...overrides,
  };
  return {
    ...base,
    identity: {
      repositoryLineageId: base.repositoryLineageId,
      lifecycleId: base.lifecycleId,
      canonicalWorktreeRealpath: base.canonicalWorktreeRealpath,
    },
  };
}

const identity1 = {
  repositoryLineageId: "lineage-001",
  lifecycleId: "lifecycle-001",
  canonicalWorktreeRealpath: "C:/dev/worktree-001",
} as const;
const identity2 = {
  repositoryLineageId: "lineage-001",
  lifecycleId: "lifecycle-002",
  canonicalWorktreeRealpath: "C:/dev/worktree-001",
} as const;

const abortEvidence = {
  attempt: 1,
  reason: "activation_unresolved" as const,
  activationAbortReceiptDigest: "sha256:abort",
  pathLeaseRelease: { released: true as const, receiptDigest: "sha256:lease-release" },
};

const ownerLossEvidence = {
  kind: "authenticated_owner_loss" as const,
  authenticated: true as const,
  sessionId: "session-001",
  observedAt: "2026-08-24T00:10:00.000Z",
  evidenceDigest: "sha256:owner-loss",
};

describe("U-WTLIFE-001 planned lifecycle record", () => {
  it("atomically registers the complete identity and refuses a duplicate", () => {
    const store = new WorktreeLifecycleStore();
    const record = store.plan(planned());

    expect(record.state).toBe("planned");
    expect(record.revision).toBe(1);
    expect(record.activationStatus).toBe("unresolved");
    expect(record.denyReasons).toEqual([]);
    expect(Object.isFrozen(record)).toBe(true);
    expect(() => store.plan(planned())).toThrowError(
      expect.objectContaining({ code: "duplicate_lifecycle" }),
    );
    const otherIdentityRecord = store.plan(
      planned({
        repositoryLineageId: "lineage-002",
        canonicalWorktreeRealpath: "C:/dev/worktree-002",
      }),
    );
    expect(otherIdentityRecord.identity.repositoryLineageId).toBe("lineage-002");
    expect(
      store.get({
        repositoryLineageId: "lineage-002",
        lifecycleId: "lifecycle-001",
        canonicalWorktreeRealpath: "C:/dev/worktree-002",
      }),
    ).toBe(otherIdentityRecord);
    expect(store.events()).toHaveLength(2);
  });
});

describe("U-WTLIFE-002 lifecycle FSM", () => {
  it("covers activation, terminal, retained, late receipt reevaluation, and retirement", () => {
    const store = new WorktreeLifecycleStore();
    store.plan(planned());
    const active = store.activate(identity1, {
      attempt: 1,
      workerStartReceiptDigest: "sha256:start",
      inventoryAvailable: true,
      ownerAuthenticated: true,
    });
    expect(active.state).toBe("active");
    expect(active.revision).toBe(2);

    const pending = store.terminal(identity1, {
      attempt: 1,
      kind: "success",
      terminalReceiptDigest: "sha256:terminal",
    });
    expect(pending.state).toBe("terminal_pending");
    expect(pending.denyReasons).toEqual([]);
    expect(() =>
      store.retire(identity1, {
        attempt: 1,
        inventoryAvailable: true,
        terminalReceiptDigest: "sha256:other",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "terminal_mismatch", reason: "terminal_mismatch" }),
    );

    const retired = store.retire(identity1, {
      attempt: 1,
      inventoryAvailable: true,
    });
    expect(retired.state).toBe("retired");
    expect(retired.revision).toBe(4);
    expect(() =>
      store.reevaluateRetained(identity1, {
        attempt: 1,
        terminalKind: "success",
        terminalReceiptDigest: "sha256:terminal",
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_transition" }));
  });

  it("preserves terminal_missing on owner loss and reopens retained state for a late receipt", () => {
    const store = new WorktreeLifecycleStore();
    store.plan(planned({ lifecycleId: "lifecycle-002", pathLeaseId: "lease-002" }));
    store.activate(identity2, {
      attempt: 1,
      workerStartReceiptDigest: "sha256:start-2",
      inventoryAvailable: true,
      ownerAuthenticated: true,
    });
    const pending = store.terminal(identity2, {
      attempt: 1,
      kind: "parent_loss",
      ownerLossEvidence,
    });
    expect(pending.denyReasons).toEqual(["terminal_missing"]);
    expect(pending.ownerLossEvidenceDigest).toBe("sha256:owner-loss");
    const retained = store.retain(identity2, {
      attempt: 1,
      denyReasons: ["terminal_missing"],
      retention: {
        policyId: "policy-1",
        policyRevision: "r1",
        retainUntil: "2026-08-26T00:00:00.000Z",
        disposition: "retain",
      },
    });
    expect(retained.state).toBe("retained");
    expect(retained.denyHistory).toEqual(["terminal_missing"]);

    const reevaluated = store.reevaluateRetained(identity2, {
      attempt: 1,
      terminalKind: "parent_loss",
      terminalReceiptDigest: "sha256:late-terminal",
    });
    expect(reevaluated.state).toBe("terminal_pending");
    expect(reevaluated.denyReasons).toEqual([]);
    expect(reevaluated.denyHistory).toEqual(["terminal_missing"]);
    const retired = store.retire(identity2, {
      attempt: 1,
      inventoryAvailable: true,
    });
    expect(retired.state).toBe("retired");
  });

  it("keeps domain deny reasons when a retained record receives the same terminal receipt", () => {
    const store = new WorktreeLifecycleStore();
    store.plan(planned());
    store.activate(identity1, {
      attempt: 1,
      workerStartReceiptDigest: "sha256:start-dirty",
      inventoryAvailable: true,
      ownerAuthenticated: true,
    });
    store.terminal(identity1, {
      attempt: 1,
      kind: "success",
      terminalReceiptDigest: "sha256:dirty-terminal",
      denyReasons: ["dirty"],
    });
    store.retain(identity1, {
      attempt: 1,
      denyReasons: ["dirty"],
      retention: {
        policyId: "policy-dirty",
        policyRevision: "r1",
        retainUntil: "2026-08-26T00:00:00.000Z",
        disposition: "retain",
      },
    });

    const reevaluated = store.reevaluateRetained(identity1, {
      attempt: 1,
      terminalKind: "success",
      terminalReceiptDigest: "sha256:dirty-terminal",
    });

    expect(reevaluated.state).toBe("terminal_pending");
    expect(reevaluated.denyReasons).toEqual(["dirty"]);
    expect(() =>
      store.retire(identity1, {
        attempt: 1,
        inventoryAvailable: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "terminal_missing", reason: "dirty" }));
  });
});

describe("U-WTLIFE-006 typed activation and inventory denial", () => {
  it("fails closed for unresolved activation and unavailable inventory without mutating the record", () => {
    const store = new WorktreeLifecycleStore();
    store.plan(planned());
    const activationFailures = [
      {
        workerStartReceiptDigest: "",
        inventoryAvailable: true,
        ownerAuthenticated: true,
        error: "activation_unresolved",
      },
      {
        workerStartReceiptDigest: "sha256:start",
        inventoryAvailable: false,
        ownerAuthenticated: true,
        error: "inventory_unavailable",
      },
      {
        workerStartReceiptDigest: "sha256:start",
        inventoryAvailable: true,
        ownerAuthenticated: false,
        error: "owner_unknown",
      },
    ] as const;
    for (const failure of activationFailures) {
      expect(() =>
        store.activate(identity1, {
          attempt: 1,
          workerStartReceiptDigest: failure.workerStartReceiptDigest,
          inventoryAvailable: failure.inventoryAvailable,
          ownerAuthenticated: failure.ownerAuthenticated,
        }),
      ).toThrowError(expect.objectContaining({ code: failure.error, reason: failure.error }));
    }
    expect(store.get(identity1)?.state).toBe("planned");
    expect(store.get(identity1)?.revision).toBe(1);

    const pending = store.abortActivation(identity1, abortEvidence);
    expect(pending.state).toBe("terminal_pending");
    expect(pending.denyReasons).toEqual(["activation_unresolved"]);
    expect(pending.activationAbortReceiptDigest).toBe("sha256:abort");
    expect(pending.pathLeaseReleaseReceiptDigest).toBe("sha256:lease-release");
    expect(() => store.retire(identity1, { attempt: 1, inventoryAvailable: false })).toThrowError(
      expect.objectContaining({ code: "inventory_unavailable", reason: "inventory_unavailable" }),
    );
    const retained = store.retain(identity1, {
      attempt: 1,
      denyReasons: ["activation_unresolved", "inventory_unavailable"],
    });
    expect(retained.denyReasons).toEqual(["activation_unresolved", "inventory_unavailable"]);
  });

  it("rejects activation abort without sealed receipt or released lease evidence", () => {
    const store = new WorktreeLifecycleStore();
    store.plan(planned());
    expect(() =>
      store.abortActivation(identity1, {
        ...abortEvidence,
        activationAbortReceiptDigest: "",
      }),
    ).toThrowError(expect.objectContaining({ code: "activation_abort_unresolved" }));
    expect(() =>
      store.abortActivation(identity1, {
        ...abortEvidence,
        pathLeaseRelease: { released: true, receiptDigest: "" },
      }),
    ).toThrowError(expect.objectContaining({ code: "activation_abort_unresolved" }));
  });

  it("preserves activation denial when retention supplies a receipt-derived reason", () => {
    const store = new WorktreeLifecycleStore();
    store.plan(planned());

    const pending = store.abortActivation(identity1, abortEvidence);
    expect(pending.denyReasons).toEqual(["activation_unresolved"]);

    const retained = store.retain(identity1, {
      attempt: 1,
      denyReasons: ["terminal_missing"],
    });
    expect(retained.denyReasons).toEqual(["activation_unresolved", "terminal_missing"]);

    const reevaluated = store.reevaluateRetained(identity1, {
      attempt: 1,
      terminalKind: "failure",
      terminalReceiptDigest: "sha256:late-terminal",
    });
    expect(reevaluated.denyReasons).toEqual(["activation_unresolved"]);
    expect(() => store.retire(identity1, { attempt: 1, inventoryAvailable: true })).toThrowError(
      expect.objectContaining({ code: "terminal_missing", reason: "activation_unresolved" }),
    );
  });

  it("keeps a terminal deny reason blocking retirement even with a terminal receipt", () => {
    const store = new WorktreeLifecycleStore();
    store.plan(planned());
    store.activate(identity1, {
      attempt: 1,
      workerStartReceiptDigest: "sha256:start",
      inventoryAvailable: true,
      ownerAuthenticated: true,
    });
    const pending = store.terminal(identity1, {
      attempt: 1,
      kind: "failure",
      terminalReceiptDigest: "sha256:terminal",
      denyReasons: ["dirty"],
    });
    expect(pending.state).toBe("terminal_pending");
    expect(pending.terminalReceiptDigest).toBe("sha256:terminal");
    expect(pending.denyReasons).toEqual(["dirty"]);
    expect(() =>
      store.retire(identity1, {
        attempt: 1,
        inventoryAvailable: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "terminal_missing", reason: "dirty" }));
  });

  it("keeps terminal_mismatch denied when the same receipt reevaluates retained state", () => {
    const store = new WorktreeLifecycleStore();
    store.plan(planned());
    store.activate(identity1, {
      attempt: 1,
      workerStartReceiptDigest: "sha256:start",
      inventoryAvailable: true,
      ownerAuthenticated: true,
    });
    store.terminal(identity1, {
      attempt: 1,
      kind: "failure",
      terminalReceiptDigest: "sha256:terminal",
      denyReasons: ["terminal_mismatch"],
    });
    store.retain(identity1, {
      attempt: 1,
      denyReasons: ["terminal_mismatch"],
    });

    const reevaluated = store.reevaluateRetained(identity1, {
      attempt: 1,
      terminalKind: "failure",
      terminalReceiptDigest: "sha256:terminal",
    });

    expect(reevaluated.denyReasons).toEqual(["terminal_mismatch"]);
    expect(() => store.retire(identity1, { attempt: 1, inventoryAvailable: true })).toThrowError(
      expect.objectContaining({ code: "terminal_missing", reason: "terminal_mismatch" }),
    );
  });

  it("preserves terminal_missing when owner loss supplies an empty deny list", () => {
    const store = new WorktreeLifecycleStore();
    store.plan(planned());
    store.activate(identity1, {
      attempt: 1,
      workerStartReceiptDigest: "sha256:start",
      inventoryAvailable: true,
      ownerAuthenticated: true,
    });
    const pending = store.terminal(identity1, {
      attempt: 1,
      kind: "parent_loss",
      ownerLossEvidence,
      denyReasons: [],
    });
    expect(pending.denyReasons).toEqual(["terminal_missing"]);
    expect(() =>
      store.retire(identity1, {
        attempt: 1,
        inventoryAvailable: true,
        terminalReceiptDigest: "sha256/late-receipt",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "terminal_missing", reason: "terminal_missing" }),
    );
  });

  it("requires parent_loss kind before authenticated owner-loss evidence can excuse a receipt", () => {
    const store = new WorktreeLifecycleStore();
    store.plan(planned());
    store.activate(identity1, {
      attempt: 1,
      workerStartReceiptDigest: "sha256:start",
      inventoryAvailable: true,
      ownerAuthenticated: true,
    });
    expect(() =>
      store.terminal(identity1, {
        attempt: 1,
        kind: "failure",
        ownerLossEvidence,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "terminal_missing", reason: "terminal_missing" }),
    );
  });
});

describe("U-WTLIFE-010 replay and fail-close transitions", () => {
  it("keeps revisions monotonic, makes invalid transitions fail closed, and rejects receipt conflicts", () => {
    const store = new WorktreeLifecycleStore();
    store.plan(planned());
    expect(() => store.retire(identity1, { attempt: 1, inventoryAvailable: true })).toThrowError(
      expect.objectContaining({ code: "invalid_transition" }),
    );
    store.abortActivation(identity1, abortEvidence);
    const retained = store.retain(identity1, {
      attempt: 1,
      denyReasons: ["terminal_missing"],
    });
    expect(() =>
      store.reevaluateRetained(identity1, {
        attempt: 1,
        terminalKind: "cancel",
        terminalReceiptDigest: "sha256:first",
      }),
    ).not.toThrow();
    const current = store.get(identity1);
    expect(current?.revision).toBe(retained.revision + 1);
    expect(store.events().map((event) => event.revision)).toEqual([1, 2, 3, 4]);
    expect(
      store.reevaluateRetained(identity1, {
        attempt: 1,
        terminalKind: "cancel",
        terminalReceiptDigest: "sha256:first",
      }),
    ).toBe(current);
    expect(store.events().map((event) => event.revision)).toEqual([1, 2, 3, 4]);

    expect(() =>
      store.activate(identity1, {
        attempt: 1,
        workerStartReceiptDigest: "sha256:late",
        inventoryAvailable: true,
        ownerAuthenticated: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_transition" }));
    expect(() =>
      store.terminal(identity1, {
        attempt: 99,
        kind: "success",
        terminalReceiptDigest: "sha256:wrong-attempt",
      }),
    ).toThrowError(WorktreeLifecycleError);

    const replayStore = new WorktreeLifecycleStore();
    replayStore.plan(planned());
    replayStore.activate(identity1, {
      attempt: 1,
      workerStartReceiptDigest: "sha256:start",
      inventoryAvailable: true,
      ownerAuthenticated: true,
    });
    replayStore.terminal(identity1, {
      attempt: 1,
      kind: "success",
      terminalReceiptDigest: "sha256:terminal",
    });
    replayStore.retain(identity1, { attempt: 1, denyReasons: ["retention_active"] });
    expect(() =>
      replayStore.reevaluateRetained(identity1, {
        attempt: 1,
        terminalKind: "success",
        terminalReceiptDigest: "sha256:other",
      }),
    ).toThrowError(expect.objectContaining({ code: "replay_conflict", reason: "replay_conflict" }));

    const terminalStore = new WorktreeLifecycleStore();
    terminalStore.plan(planned());
    terminalStore.activate(identity1, {
      attempt: 1,
      workerStartReceiptDigest: "sha256:start",
      inventoryAvailable: true,
      ownerAuthenticated: true,
    });
    expect(() =>
      terminalStore.terminal(identity1, {
        attempt: 1,
        kind: "failure",
        terminalReceiptDigest: "",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "terminal_missing", reason: "terminal_missing" }),
    );
    expect(() =>
      terminalStore.terminal(identity1, {
        attempt: 1,
        kind: "parent_loss",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "terminal_missing", reason: "terminal_missing" }),
    );
    expect(() =>
      terminalStore.terminal(identity1, {
        attempt: 1,
        kind: "parent_loss",
        ownerLossEvidence: { ...ownerLossEvidence, sessionId: "foreign-session" },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "terminal_missing", reason: "terminal_missing" }),
    );
  });
});
