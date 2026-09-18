import { describe, expect, it, vi } from "vitest";
import {
  WorktreeLifecycleApplication,
  type WorktreeLifecycleApplicationPorts,
  type WorktreeLifecycleCreateInput,
} from "../src/runtime/worktree-lifecycle/application/index.ts";
import type { LifecycleIdentity } from "../src/runtime/worktree-lifecycle/domain/index.ts";

const identity = {
  repositoryLineageId: "lineage-001",
  lifecycleId: "lifecycle-001",
  canonicalWorktreeRealpath: "C:/dev/worktree-001",
} as const;

function input(
  overrides: Partial<WorktreeLifecycleCreateInput> = {},
): WorktreeLifecycleCreateInput {
  return {
    repositoryLineageId: identity.repositoryLineageId,
    lifecycleId: identity.lifecycleId,
    ownerSessionId: "session-001",
    issueId: 425,
    planId: "PLAN-L7-513-worktree-lifecycle-application",
    planRevision: "r1",
    use: "worker",
    branch: "feat/issue425-worktree-lifecycle-application",
    headOid: "1111111111111111111111111111111111111111",
    worktreePath: identity.canonicalWorktreeRealpath,
    canonicalRoot: "C:/dev",
    activationDeadline: "2026-08-27T12:05:00.000Z",
    expiresAt: "2026-08-28T12:00:00.000Z",
    parentProcessId: "process-001",
    parentSessionId: "parent-session-001",
    operationId: "operation-001",
    attempt: 1,
    ...overrides,
  };
}

function ports(overrides: Partial<WorktreeLifecycleApplicationPorts> = {}) {
  const calls: string[] = [];
  const canonical = {
    canonicalWorktreeRealpath: identity.canonicalWorktreeRealpath,
    adminEntryRealpath: "C:/dev/.git/worktrees/worktree-001",
  };
  const defaults: WorktreeLifecycleApplicationPorts = {
    path: { resolve: () => canonical },
    lease: {
      reservePath: (request) => {
        calls.push("reserve");
        return {
          identity: request,
          ownerSessionId: request.ownerSessionId,
          operationId: request.operationId,
          attempt: request.attempt,
          leaseId: "lease-001",
          receiptDigest: "sha256:lease",
        };
      },
      releasePath: ({ lease }) => {
        calls.push("release");
        return {
          released: true,
          receiptDigest: "sha256:release",
          leaseId: lease.leaseId,
          operationId: lease.operationId,
          attempt: lease.attempt,
        };
      },
    },
    worktree: {
      create: (request) => {
        calls.push("create");
        return {
          identity: request.identity,
          operationId: request.operationId,
          attempt: request.attempt,
          created: true,
        };
      },
    },
    observation: {
      observe: (request) => {
        calls.push("observe");
        return {
          identity: request.identity,
          operationId: request.operationId,
          attempt: request.attempt,
          adminEntryRealpath: canonical.adminEntryRealpath,
          inventoryAvailable: true,
        };
      },
    },
    worker: {
      spawn: (request) => {
        calls.push("spawn");
        return {
          identity: request.identity,
          ownerSessionId: request.ownerSessionId,
          operationId: request.operationId,
          attempt: request.attempt,
          receiptDigest: "sha256:start",
        };
      },
    },
    cleanup: {
      record: () => {
        calls.push("handoff");
        return { handoffId: "handoff-001", receiptDigest: "sha256:handoff" };
      },
    },
    clock: { now: () => "2026-08-27T12:00:00.000Z" },
  };
  return { ports: { ...defaults, ...overrides }, calls, canonical };
}

describe("worktree lifecycle application saga", () => {
  it("CANDIDATE-U-WTAPP-001/002: validates before reserve and runs the canonical create order", () => {
    const fixture = ports();
    const app = new WorktreeLifecycleApplication(fixture.ports, undefined, "win32");
    const result = app.create(input());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record.state).toBe("active");
    expect(fixture.calls).toEqual(["reserve", "create", "observe", "spawn"]);
    expect(app.events().map((event) => event.type)).toEqual(["planned", "activated"]);

    const missing = app.create(input({ lifecycleId: "lifecycle-invalid", worktreePath: "" }));
    expect(missing.ok).toBe(false);
    expect(fixture.calls).toEqual(["reserve", "create", "observe", "spawn"]);
  });

  it("CANDIDATE-U-WTAPP-003: rejects escape paths and never reserves them", () => {
    const fixture = ports({
      path: {
        resolve: () => ({
          canonicalWorktreeRealpath: "C:/Users/micro/escape",
          adminEntryRealpath: "C:/dev/.git/worktrees/escape",
        }),
      },
    });
    const app = new WorktreeLifecycleApplication(fixture.ports, undefined, "win32");
    const result = app.create(
      input({ lifecycleId: "lifecycle-escape", worktreePath: "C:/dev/escape" }),
    );

    expect(result).toMatchObject({ ok: false, error: { code: "path_invalid" } });
    expect(fixture.calls).toEqual([]);
  });

  it("CANDIDATE-U-WTAPP-004: rejects a foreign lease before planning", () => {
    const fixture = ports({
      lease: {
        reservePath: (request) => ({
          identity: { ...request, lifecycleId: "foreign" },
          ownerSessionId: request.ownerSessionId,
          operationId: request.operationId,
          attempt: request.attempt,
          leaseId: "lease-foreign",
          receiptDigest: "sha256:foreign",
        }),
        releasePath: vi.fn(),
      },
    });
    const app = new WorktreeLifecycleApplication(fixture.ports, undefined, "win32");
    const result = app.create(input({ lifecycleId: "lifecycle-foreign" }));

    expect(result).toMatchObject({ ok: false, error: { code: "reserve_failed" } });
    expect(fixture.calls).toEqual([]);
  });

  it("CANDIDATE-U-WTAPP-002/005: preserves the primary fault and records abort, release, and handoff", () => {
    const fixture = ports({
      worktree: {
        create: () => {
          fixture.calls.push("create");
          throw new Error("create failed");
        },
      },
    });
    const app = new WorktreeLifecycleApplication(fixture.ports, undefined, "win32");
    const result = app.create(input({ lifecycleId: "lifecycle-fault" }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("worktree_create_failed");
      expect(result.error.primaryError).toEqual(expect.any(Error));
      expect(result.error.compensation).toMatchObject({
        pathLeaseReleased: true,
        activationAborted: true,
        cleanupHandoffRecorded: true,
      });
    }
    expect(fixture.calls).toEqual(["reserve", "create", "release", "handoff"]);
    expect(
      app.get({ ...identity, lifecycleId: "lifecycle-fault" } as LifecycleIdentity)?.state,
    ).toBe("terminal_pending");
  });

  it("CANDIDATE-U-WTAPP-005: release failure does not erase the primary error or handoff", () => {
    const fixture = ports({
      worktree: {
        create: () => {
          fixture.calls.push("create");
          throw new Error("primary");
        },
      },
      lease: {
        reservePath: (request) => {
          fixture.calls.push("reserve");
          return {
            identity: request,
            ownerSessionId: request.ownerSessionId,
            operationId: request.operationId,
            attempt: request.attempt,
            leaseId: "lease-001",
            receiptDigest: "sha256:lease",
          };
        },
        releasePath: () => {
          fixture.calls.push("release");
          throw new Error("release failed");
        },
      },
    });
    const app = new WorktreeLifecycleApplication(fixture.ports, undefined, "win32");
    const result = app.create(input({ lifecycleId: "lifecycle-release-fault" }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.primaryError).toEqual(expect.any(Error));
      expect(result.error.compensation?.errors).toContain("release failed");
      expect(result.error.compensation).toMatchObject({
        activationAborted: false,
        cleanupHandoffRecorded: true,
      });
    }
    expect(fixture.calls).toEqual(["reserve", "create", "release", "handoff"]);
  });

  it("CANDIDATE-U-WTAPP-005: finish appends terminal before release and handoff", () => {
    const fixture = ports();
    const app = new WorktreeLifecycleApplication(fixture.ports, undefined, "win32");
    const created = app.create(input());
    expect(created.ok).toBe(true);
    const lease = {
      identity,
      ownerSessionId: "session-001",
      operationId: "operation-001",
      attempt: 1,
      leaseId: "lease-001",
      receiptDigest: "sha256:lease",
    };
    const finished = app.finish({
      identity,
      ownerSessionId: "session-001",
      operationId: "operation-001",
      lease,
      terminal: { attempt: 1, kind: "success", terminalReceiptDigest: "sha256:terminal" },
    });

    expect(finished.ok).toBe(true);
    expect(fixture.calls).toEqual(["reserve", "create", "observe", "spawn", "release", "handoff"]);
    expect(app.get(identity)?.state).toBe("terminal_pending");
  });

  it("CANDIDATE-U-WTAPP-005: finish reports a failed cleanup handoff without silent success", () => {
    const fixture = ports({
      cleanup: {
        record: () => {
          fixture.calls.push("handoff");
          throw new Error("handoff failed");
        },
      },
    });
    const app = new WorktreeLifecycleApplication(fixture.ports, undefined, "win32");
    expect(app.create(input()).ok).toBe(true);

    const finished = app.finish({
      identity,
      ownerSessionId: "session-001",
      operationId: "operation-001",
      lease: {
        identity,
        ownerSessionId: "session-001",
        operationId: "operation-001",
        attempt: 1,
        leaseId: "lease-001",
        receiptDigest: "sha256:lease",
      },
      terminal: { attempt: 1, kind: "success", terminalReceiptDigest: "sha256:terminal" },
    });

    expect(finished).toMatchObject({
      ok: false,
      error: {
        code: "terminal_failed",
        compensation: {
          pathLeaseReleased: true,
          cleanupHandoffRecorded: false,
          errors: ["handoff failed"],
        },
      },
    });
    expect(fixture.calls).toEqual(["reserve", "create", "observe", "spawn", "release", "handoff"]);
  });
});
