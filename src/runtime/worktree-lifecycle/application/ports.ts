import type {
  ActivationEvidence,
  LifecycleIdentity,
  TerminalInput,
  WorktreeLifecycleRecord,
  WorktreeUse,
} from "../domain/types.ts";

export interface WorktreeLifecycleCreateInput {
  readonly repositoryLineageId: string;
  readonly lifecycleId: string;
  readonly ownerSessionId: string;
  readonly issueId: number;
  readonly planId: string;
  readonly planRevision: string;
  readonly use: WorktreeUse;
  readonly branch: string;
  readonly headOid: string;
  readonly worktreePath: string;
  readonly canonicalRoot: string;
  readonly activationDeadline: string;
  readonly expiresAt: string;
  readonly parentProcessId: string;
  readonly parentSessionId: string;
  readonly operationId: string;
  readonly attempt: number;
}

export interface CanonicalWorktreePath {
  readonly canonicalWorktreeRealpath: string;
  readonly adminEntryRealpath: string;
}

export interface WorktreePathPort {
  resolve(input: {
    readonly requestedPath: string;
    readonly canonicalRoot: string;
    readonly platform: "win32" | "linux";
  }): CanonicalWorktreePath;
}

export interface PathLeaseRequest extends LifecycleIdentity {
  readonly ownerSessionId: string;
  readonly operationId: string;
  readonly attempt: number;
}

export interface PathLeaseReceipt {
  readonly identity: LifecycleIdentity;
  readonly leaseId: string;
  readonly ownerSessionId: string;
  readonly operationId: string;
  readonly attempt: number;
  readonly receiptDigest: string;
}

export interface PathLeasePort {
  reservePath(input: PathLeaseRequest): PathLeaseReceipt;
  releasePath(input: {
    readonly lease: PathLeaseReceipt;
    readonly reason: "activation_abort" | "terminal";
  }): PathLeaseReleaseReceipt;
}

export interface PathLeaseReleaseReceipt {
  readonly released: true;
  readonly receiptDigest: string;
  readonly leaseId: string;
  readonly operationId: string;
  readonly attempt: number;
}

export interface WorktreeCreateRequest {
  readonly identity: LifecycleIdentity;
  readonly operationId: string;
  readonly attempt: number;
  readonly branch: string;
  readonly headOid: string;
}

export interface WorktreeCreateResult {
  readonly identity: LifecycleIdentity;
  readonly operationId: string;
  readonly attempt: number;
  readonly created: true;
}

export interface WorktreeCreatePort {
  create(input: WorktreeCreateRequest): WorktreeCreateResult;
}

export interface WorktreeObservation {
  readonly identity: LifecycleIdentity;
  readonly operationId: string;
  readonly attempt: number;
  readonly adminEntryRealpath: string;
  readonly inventoryAvailable: boolean;
}

export interface WorktreeObservePort {
  observe(input: {
    readonly identity: LifecycleIdentity;
    readonly operationId: string;
    readonly attempt: number;
  }): WorktreeObservation;
}

export interface WorkerStartReceipt {
  readonly identity: LifecycleIdentity;
  readonly ownerSessionId: string;
  readonly operationId: string;
  readonly attempt: number;
  readonly receiptDigest: string;
}

export interface WorkerSpawnPort {
  spawn(input: {
    readonly identity: LifecycleIdentity;
    readonly operationId: string;
    readonly attempt: number;
    readonly ownerSessionId: string;
  }): WorkerStartReceipt;
}

export interface CleanupHandoff {
  readonly identity: LifecycleIdentity;
  readonly operationId: string;
  readonly attempt: number;
  readonly reason: string;
  readonly activationAbortReceiptDigest?: string;
  readonly pathLeaseReleaseReceiptDigest?: string;
  readonly primaryError: string;
}

export interface CleanupHandoffReceipt {
  readonly handoffId: string;
  readonly receiptDigest: string;
}

export interface CleanupHandoffPort {
  record(input: CleanupHandoff): CleanupHandoffReceipt;
}

export interface LifecycleClockPort {
  now(): string;
}

export interface WorktreeLifecycleApplicationPorts {
  readonly path: WorktreePathPort;
  readonly lease: PathLeasePort;
  readonly worktree: WorktreeCreatePort;
  readonly observation: WorktreeObservePort;
  readonly worker: WorkerSpawnPort;
  readonly cleanup: CleanupHandoffPort;
  readonly clock: LifecycleClockPort;
}

export interface LifecycleTerminalRequest {
  readonly identity: LifecycleIdentity;
  readonly ownerSessionId: string;
  readonly operationId: string;
  readonly input: TerminalInput;
}

export interface LifecycleApplicationResult {
  readonly record: WorktreeLifecycleRecord;
  readonly activation?: ActivationEvidence;
}
