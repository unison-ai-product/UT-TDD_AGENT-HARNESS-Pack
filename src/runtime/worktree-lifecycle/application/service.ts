import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, posix, win32 } from "node:path";
import { WorktreeLifecycleStore } from "../domain/store.ts";
import type {
  ActivationEvidence,
  LifecycleIdentity,
  PlannedLifecycleInput,
  TerminalInput,
  WorktreeLifecycleRecord,
} from "../domain/types.ts";
import { WORKTREE_USES } from "../domain/types.ts";
import type {
  CanonicalWorktreePath,
  LifecycleClockPort,
  PathLeaseReceipt,
  PathLeaseReleaseReceipt,
  WorkerStartReceipt,
  WorktreeLifecycleApplicationPorts,
  WorktreeLifecycleCreateInput,
  WorktreePathPort,
} from "./ports.ts";

export type LifecycleApplicationFailureCode =
  | "invalid_input"
  | "path_invalid"
  | "reserve_failed"
  | "plan_failed"
  | "worktree_create_failed"
  | "observation_failed"
  | "worker_spawn_failed"
  | "start_receipt_invalid"
  | "activation_failed"
  | "compensation_failed"
  | "terminal_failed";

export interface LifecycleCompensationReport {
  readonly pathLeaseReleased: boolean;
  readonly activationAborted: boolean;
  readonly cleanupHandoffRecorded: boolean;
  readonly errors: readonly string[];
}

export class WorktreeLifecycleApplicationError extends Error {
  readonly code: LifecycleApplicationFailureCode;
  readonly compensation?: LifecycleCompensationReport;
  readonly primaryError?: unknown;

  constructor(
    code: LifecycleApplicationFailureCode,
    message: string,
    details: { compensation?: LifecycleCompensationReport; primaryError?: unknown } = {},
  ) {
    super(message);
    this.name = "WorktreeLifecycleApplicationError";
    this.code = code;
    this.compensation = details.compensation;
    this.primaryError = details.primaryError;
  }
}

export interface LifecycleFailure {
  readonly ok: false;
  readonly error: WorktreeLifecycleApplicationError;
  readonly record?: WorktreeLifecycleRecord;
}

export interface LifecycleSuccess {
  readonly ok: true;
  readonly record: WorktreeLifecycleRecord;
}

export type LifecycleCreateResult = LifecycleSuccess | LifecycleFailure;

export function createDefaultWorktreePathPort(): WorktreePathPort {
  return {
    resolve(input) {
      const pathApi = input.platform === "win32" ? win32 : posix;
      const requested = pathApi.normalize(input.requestedPath);
      const canonicalRoot = pathApi.normalize(input.canonicalRoot);
      const canonicalWorktreeRealpath = existsSync(input.requestedPath)
        ? realpathSync.native(input.requestedPath)
        : requested;
      const adminEntryRealpath = pathApi.join(
        canonicalRoot,
        ".git",
        "worktrees",
        pathApi.basename(requested),
      );
      return Object.freeze({ canonicalWorktreeRealpath, adminEntryRealpath });
    },
  };
}

export function createSystemClock(): LifecycleClockPort {
  return { now: () => new Date().toISOString() };
}

export class WorktreeLifecycleApplication {
  private readonly ports: WorktreeLifecycleApplicationPorts;
  private readonly store: WorktreeLifecycleStore;
  private readonly platform: "win32" | "linux";

  constructor(
    ports: WorktreeLifecycleApplicationPorts,
    store: WorktreeLifecycleStore = new WorktreeLifecycleStore(),
    platform: "win32" | "linux" = process.platform === "win32" ? "win32" : "linux",
  ) {
    this.ports = ports;
    this.store = store;
    this.platform = platform;
  }

  create(input: WorktreeLifecycleCreateInput): LifecycleCreateResult {
    const validated = this.validateInput(input);
    if (!validated.ok) return validated;
    const { canonical, planned } = validated.value;
    const identity: LifecycleIdentity = {
      repositoryLineageId: input.repositoryLineageId,
      lifecycleId: input.lifecycleId,
      canonicalWorktreeRealpath: canonical.canonicalWorktreeRealpath,
    };
    let lease: PathLeaseReceipt;
    try {
      lease = this.ports.lease.reservePath({
        ...identity,
        ownerSessionId: input.ownerSessionId,
        operationId: input.operationId,
        attempt: input.attempt,
      });
      this.assertLeaseBinding({
        lease,
        identity,
        ownerSessionId: input.ownerSessionId,
        operationId: input.operationId,
        attempt: input.attempt,
      });
    } catch (error) {
      return this.failure("reserve_failed", "path reservation failed", { primaryError: error });
    }

    let record: WorktreeLifecycleRecord;
    try {
      record = this.store.plan({ ...planned, identity, pathLeaseId: lease.leaseId });
    } catch (error) {
      const compensation = this.compensate({
        input,
        identity,
        lease,
        primaryError: error,
        record: undefined,
      });
      return this.failure("plan_failed", "lifecycle plan append failed", {
        primaryError: error,
        compensation,
      });
    }

    const run = <T>(
      code: LifecycleApplicationFailureCode,
      action: () => T,
    ): { readonly ok: true; readonly value: T } | LifecycleFailure => {
      try {
        return { ok: true, value: action() };
      } catch (error) {
        const compensation = this.compensate({
          input,
          identity,
          lease,
          primaryError: error,
          record,
        });
        return this.failure(code, `${code.replaceAll("_", " ")} failed`, {
          primaryError: error,
          compensation,
          record,
        });
      }
    };

    const created = run("worktree_create_failed", () => {
      const result = this.ports.worktree.create({
        identity,
        operationId: input.operationId,
        attempt: input.attempt,
        branch: input.branch,
        headOid: input.headOid,
      });
      this.assertBinding({
        value: result,
        identity,
        operationId: input.operationId,
        attempt: input.attempt,
      });
      if (result.created !== true)
        throw new WorktreeLifecycleApplicationError(
          "worktree_create_failed",
          "worktree create was not acknowledged",
        );
      return result;
    });
    if (!created.ok) return created;

    const observed = run("observation_failed", () => {
      const result = this.ports.observation.observe({
        identity,
        operationId: input.operationId,
        attempt: input.attempt,
      });
      this.assertBinding({
        value: result,
        identity,
        operationId: input.operationId,
        attempt: input.attempt,
      });
      if (
        !samePath(result.adminEntryRealpath, canonical.adminEntryRealpath, this.platform) ||
        !result.inventoryAvailable
      ) {
        throw new WorktreeLifecycleApplicationError(
          "observation_failed",
          "worktree observation is unavailable or does not match the planned admin entry",
        );
      }
      return result;
    });
    if (!observed.ok) return observed;

    const started = run("worker_spawn_failed", () => {
      const result = this.ports.worker.spawn({
        identity,
        operationId: input.operationId,
        attempt: input.attempt,
        ownerSessionId: input.ownerSessionId,
      });
      this.assertStartReceipt(result, identity, input);
      return result;
    });
    if (!started.ok) return started;

    const activated = run("activation_failed", () => {
      const evidence: ActivationEvidence = {
        attempt: input.attempt,
        workerStartReceiptDigest: started.value.receiptDigest,
        inventoryAvailable: observed.value.inventoryAvailable,
        ownerAuthenticated: started.value.ownerSessionId === input.ownerSessionId,
      };
      return this.store.activate(identity, evidence);
    });
    if (!activated.ok) return activated;
    return { ok: true, record: activated.value };
  }

  finish(input: {
    readonly identity: LifecycleIdentity;
    readonly ownerSessionId: string;
    readonly operationId: string;
    readonly terminal: TerminalInput;
    readonly lease: PathLeaseReceipt;
  }): LifecycleCreateResult {
    const current = this.store.get(input.identity);
    if (!current) return this.failure("terminal_failed", "unknown lifecycle");
    if (current.ownerSessionId !== input.ownerSessionId)
      return this.failure("terminal_failed", "owner mismatch");
    try {
      this.assertLeaseBinding({
        lease: input.lease,
        identity: input.identity,
        ownerSessionId: input.ownerSessionId,
        operationId: input.operationId,
        attempt: input.terminal.attempt,
      });
    } catch (error) {
      return this.failure("terminal_failed", "path lease identity is invalid", {
        primaryError: error,
        record: current,
      });
    }
    let record: WorktreeLifecycleRecord;
    try {
      record = this.store.terminal(input.identity, input.terminal);
    } catch (error) {
      return this.failure("terminal_failed", "terminal event append failed", {
        primaryError: error,
        record: current,
      });
    }
    let release: PathLeaseReleaseReceipt | undefined;
    let cleanupHandoffRecorded = false;
    const errors: string[] = [];
    try {
      release = this.ports.lease.releasePath({ lease: input.lease, reason: "terminal" });
    } catch (error) {
      errors.push(errorMessage(error));
    }
    try {
      this.ports.cleanup.record({
        identity: input.identity,
        operationId: input.operationId,
        attempt: input.terminal.attempt,
        reason: "terminal",
        ...(release ? { pathLeaseReleaseReceiptDigest: release.receiptDigest } : {}),
        primaryError: errors[0] ?? "",
      });
      cleanupHandoffRecorded = true;
    } catch (error) {
      errors.push(errorMessage(error));
    }
    if (errors.length > 0) {
      return this.failure(
        "terminal_failed",
        "terminal handoff completed with compensation faults",
        {
          primaryError: new Error(errors.join("; ")),
          compensation: {
            pathLeaseReleased: Boolean(release),
            activationAborted: false,
            cleanupHandoffRecorded,
            errors,
          },
          record,
        },
      );
    }
    return { ok: true, record };
  }

  get(identity: LifecycleIdentity): WorktreeLifecycleRecord | undefined {
    return this.store.get(identity);
  }

  events() {
    return this.store.events();
  }

  private compensate(input: {
    readonly input: WorktreeLifecycleCreateInput;
    readonly identity: LifecycleIdentity;
    readonly lease: PathLeaseReceipt;
    readonly primaryError: unknown;
    readonly record?: WorktreeLifecycleRecord;
  }): LifecycleCompensationReport {
    const errors: string[] = [];
    let release: PathLeaseReleaseReceipt | undefined;
    try {
      release = this.ports.lease.releasePath({ lease: input.lease, reason: "activation_abort" });
    } catch (error) {
      errors.push(errorMessage(error));
    }
    if (!input.record) {
      return Object.freeze({
        pathLeaseReleased: Boolean(release),
        activationAborted: false,
        cleanupHandoffRecorded: false,
        errors: Object.freeze(errors),
      });
    }
    let activationAborted = false;
    let abortDigest: string | undefined;
    if (input.record && release) {
      abortDigest = digest({
        kind: "activation_abort",
        lifecycleId: input.input.lifecycleId,
        operationId: input.input.operationId,
        attempt: input.input.attempt,
        reason: errorMessage(input.primaryError),
        at: this.ports.clock.now(),
      });
      try {
        this.store.abortActivation(input.identity, {
          attempt: input.input.attempt,
          reason: "activation_unresolved",
          activationAbortReceiptDigest: abortDigest,
          pathLeaseRelease: { released: true, receiptDigest: release.receiptDigest },
        });
        activationAborted = true;
      } catch (error) {
        errors.push(errorMessage(error));
      }
    }
    let cleanupHandoffRecorded = false;
    try {
      this.ports.cleanup.record({
        identity: input.identity,
        operationId: input.input.operationId,
        attempt: input.input.attempt,
        reason: errorMessage(input.primaryError),
        ...(abortDigest ? { activationAbortReceiptDigest: abortDigest } : {}),
        ...(release ? { pathLeaseReleaseReceiptDigest: release.receiptDigest } : {}),
        primaryError: errorMessage(input.primaryError),
      });
      cleanupHandoffRecorded = true;
    } catch (error) {
      errors.push(errorMessage(error));
    }
    return Object.freeze({
      pathLeaseReleased: Boolean(release),
      activationAborted,
      cleanupHandoffRecorded,
      errors: Object.freeze(errors),
    });
  }

  private validateInput(input: WorktreeLifecycleCreateInput):
    | {
        readonly ok: true;
        readonly value: {
          readonly canonical: CanonicalWorktreePath;
          readonly planned: Omit<PlannedLifecycleInput, "identity" | "pathLeaseId">;
        };
      }
    | LifecycleFailure {
    const required = [
      input.repositoryLineageId,
      input.lifecycleId,
      input.ownerSessionId,
      input.planId,
      input.planRevision,
      input.branch,
      input.headOid,
      input.worktreePath,
      input.canonicalRoot,
      input.activationDeadline,
      input.expiresAt,
      input.parentProcessId,
      input.parentSessionId,
      input.operationId,
    ];
    if (required.some((value) => typeof value !== "string" || value.trim() === ""))
      return this.failure("invalid_input", "required lifecycle input is missing");
    if (
      !Number.isSafeInteger(input.issueId) ||
      input.issueId < 1 ||
      !Number.isSafeInteger(input.attempt) ||
      input.attempt < 1
    )
      return this.failure("invalid_input", "issueId and attempt must be positive safe integers");
    if (!WORKTREE_USES.includes(input.use))
      return this.failure("invalid_input", "worktree use is invalid");
    if (
      !Number.isFinite(Date.parse(input.activationDeadline)) ||
      !Number.isFinite(Date.parse(input.expiresAt))
    )
      return this.failure("invalid_input", "activation and expiry timestamps must be valid");
    if (!isAbsoluteFor(input.worktreePath, this.platform))
      return this.failure("path_invalid", "worktree path must be absolute");
    let canonical: CanonicalWorktreePath;
    try {
      canonical = this.ports.path.resolve({
        requestedPath: input.worktreePath,
        canonicalRoot: input.canonicalRoot,
        platform: this.platform,
      });
    } catch (error) {
      return this.failure("path_invalid", "worktree path cannot be canonicalized", {
        primaryError: error,
      });
    }
    if (
      typeof canonical.canonicalWorktreeRealpath !== "string" ||
      typeof canonical.adminEntryRealpath !== "string" ||
      !isCanonicalRoot(input.canonicalRoot, this.platform)
    )
      return this.failure("path_invalid", "canonical root or resolved path is invalid");
    if (!validDirectChild(canonical.canonicalWorktreeRealpath, input.canonicalRoot, this.platform))
      return this.failure(
        "path_invalid",
        "worktree path must be a canonical direct child of the root",
      );
    if (
      !validDirectChild(
        canonical.adminEntryRealpath,
        joinRoot(input.canonicalRoot, ".git", "worktrees"),
        this.platform,
      )
    )
      return this.failure("path_invalid", "worktree admin entry escapes the canonical admin root");
    if (
      canonical.canonicalWorktreeRealpath.length > 240 ||
      canonical.adminEntryRealpath.length > 240
    )
      return this.failure("path_invalid", "worktree path exceeds the 240 UTF-16 unit limit");
    if (reservedName(canonical.canonicalWorktreeRealpath, this.platform))
      return this.failure("path_invalid", "worktree path uses a Windows reserved name");
    const planned = {
      lifecycleId: input.lifecycleId,
      repositoryLineageId: input.repositoryLineageId,
      canonicalWorktreeRealpath: canonical.canonicalWorktreeRealpath,
      adminEntryRealpath: canonical.adminEntryRealpath,
      ownerSessionId: input.ownerSessionId,
      issueId: input.issueId,
      planId: input.planId,
      planRevision: input.planRevision,
      use: input.use,
      branch: input.branch,
      headOid: input.headOid,
      createdAt: this.ports.clock.now(),
      activationDeadline: input.activationDeadline,
      expiresAt: input.expiresAt,
      pathLeaseId: "pending",
      parentProcessId: input.parentProcessId,
      parentSessionId: input.parentSessionId,
      attempt: input.attempt,
    } satisfies Omit<PlannedLifecycleInput, "identity" | "pathLeaseId"> & { pathLeaseId: string };
    return { ok: true, value: { canonical, planned } };
  }

  private assertLeaseBinding(input: {
    readonly lease: PathLeaseReceipt;
    readonly identity: LifecycleIdentity;
    readonly ownerSessionId: string;
    readonly operationId: string;
    readonly attempt: number;
  }): void {
    const { lease, identity, ownerSessionId, operationId, attempt } = input;
    if (
      lease.identity.repositoryLineageId !== identity.repositoryLineageId ||
      lease.identity.lifecycleId !== identity.lifecycleId ||
      lease.identity.canonicalWorktreeRealpath !== identity.canonicalWorktreeRealpath ||
      lease.ownerSessionId !== ownerSessionId ||
      lease.operationId !== operationId ||
      lease.attempt !== attempt ||
      !lease.leaseId ||
      !lease.receiptDigest
    )
      throw new WorktreeLifecycleApplicationError(
        "reserve_failed",
        "path lease identity is invalid",
      );
  }

  private assertBinding(input: {
    readonly value: { identity: LifecycleIdentity; operationId: string; attempt: number };
    readonly identity: LifecycleIdentity;
    readonly operationId: string;
    readonly attempt: number;
  }): void {
    const { value, identity, operationId, attempt } = input;
    if (
      !sameIdentity(value.identity, identity) ||
      value.operationId !== operationId ||
      value.attempt !== attempt
    )
      throw new WorktreeLifecycleApplicationError(
        "observation_failed",
        "operation identity binding mismatch",
      );
  }

  private assertStartReceipt(
    receipt: WorkerStartReceipt,
    identity: LifecycleIdentity,
    input: WorktreeLifecycleCreateInput,
  ): void {
    if (
      !sameIdentity(receipt.identity, identity) ||
      receipt.ownerSessionId !== input.ownerSessionId ||
      receipt.operationId !== input.operationId ||
      receipt.attempt !== input.attempt ||
      !receipt.receiptDigest
    )
      throw new WorktreeLifecycleApplicationError(
        "start_receipt_invalid",
        "worker start receipt identity is invalid",
      );
  }

  private failure(
    code: LifecycleApplicationFailureCode,
    message: string,
    details: {
      readonly primaryError?: unknown;
      readonly compensation?: LifecycleCompensationReport;
      readonly record?: WorktreeLifecycleRecord;
    } = {},
  ): LifecycleFailure {
    const { primaryError, compensation, record } = details;
    return {
      ok: false,
      error: new WorktreeLifecycleApplicationError(code, message, { compensation, primaryError }),
      ...(record ? { record } : {}),
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function sameIdentity(left: LifecycleIdentity, right: LifecycleIdentity): boolean {
  return (
    left.repositoryLineageId === right.repositoryLineageId &&
    left.lifecycleId === right.lifecycleId &&
    left.canonicalWorktreeRealpath === right.canonicalWorktreeRealpath
  );
}

function isAbsoluteFor(value: string, platform: "win32" | "linux"): boolean {
  return platform === "win32" ? win32.isAbsolute(value) : isAbsolute(value);
}

function isCanonicalRoot(value: string, platform: "win32" | "linux"): boolean {
  const pathApi = platform === "win32" ? win32 : posix;
  const normalized = pathApi
    .normalize(value)
    .replace(/[\\/]$/, "")
    .replaceAll("\\", "/");
  const expected = platform === "win32" ? "C:/dev" : "/dev";
  return (platform === "win32" ? normalized.toLowerCase() : normalized) === expected.toLowerCase();
}

function joinRoot(root: string, ...parts: string[]): string {
  return (root.match(/^[A-Za-z]:[\\/]/) ? win32 : posix).join(root, ...parts);
}

function validDirectChild(candidate: string, root: string, platform: "win32" | "linux"): boolean {
  const pathApi = platform === "win32" ? win32 : posix;
  const canonicalRoot = pathApi.normalize(root).replace(/[\\/]$/, "");
  const normalized = pathApi.normalize(candidate);
  const compare = (value: string) => (platform === "win32" ? value.toLowerCase() : value);
  const relative = pathApi.relative(canonicalRoot, normalized);
  return (
    relative !== "" &&
    !relative.startsWith("..") &&
    !pathApi.isAbsolute(relative) &&
    !relative.includes("\\") &&
    !relative.includes("/") &&
    compare(pathApi.dirname(normalized)) === compare(canonicalRoot)
  );
}

function samePath(left: string, right: string, platform: "win32" | "linux"): boolean {
  const pathApi = platform === "win32" ? win32 : posix;
  const normalize = (value: string) => pathApi.normalize(value).replace(/[\\/]$/, "");
  const lhs = normalize(left);
  const rhs = normalize(right);
  return platform === "win32" ? lhs.toLowerCase() === rhs.toLowerCase() : lhs === rhs;
}

function reservedName(value: string, platform: "win32" | "linux"): boolean {
  if (platform !== "win32") return false;
  const name = win32
    .basename(value)
    .replace(/[ .]+$/, "")
    .toUpperCase();
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/.test(name);
}
