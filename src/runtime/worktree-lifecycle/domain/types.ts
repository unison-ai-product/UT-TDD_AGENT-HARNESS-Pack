export const LIFECYCLE_STATES = [
  "planned",
  "active",
  "terminal_pending",
  "retained",
  "retired",
] as const;

export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export const WORKTREE_USES = ["worker", "review", "snapshot", "scratch"] as const;
export type WorktreeUse = (typeof WORKTREE_USES)[number];

export const TERMINAL_KINDS = ["success", "failure", "timeout", "parent_loss", "cancel"] as const;
export type TerminalKind = (typeof TERMINAL_KINDS)[number];

export const LIFECYCLE_DENY_REASONS = [
  "activation_unresolved",
  "dirty",
  "unpushed",
  "unmerged",
  "active_process",
  "active_path_lease",
  "owner_unknown",
  "terminal_missing",
  "terminal_mismatch",
  "realpath_mismatch",
  "lineage_mismatch",
  "admin_entry_mismatch",
  "inventory_unavailable",
  "retention_active",
  "canonical_state",
  "replay_conflict",
] as const;
export type LifecycleDenyReason = (typeof LIFECYCLE_DENY_REASONS)[number];

export type ActivationStatus = "unresolved" | "resolved" | "aborted";

export interface LifecycleIdentity {
  readonly repositoryLineageId: string;
  readonly lifecycleId: string;
  readonly canonicalWorktreeRealpath: string;
}

export interface RetentionSnapshot {
  readonly policyId: string;
  readonly policyRevision: string;
  readonly retainUntil: string;
  readonly disposition: "retain" | "retire";
}

export interface WorktreeLifecycleRecord {
  readonly identity: LifecycleIdentity;
  readonly lifecycleId: string;
  readonly attempt: number;
  readonly repositoryLineageId: string;
  readonly canonicalWorktreeRealpath: string;
  readonly adminEntryRealpath: string;
  readonly ownerSessionId: string;
  readonly issueId: number;
  readonly planId: string;
  readonly planRevision: string;
  readonly use: WorktreeUse;
  readonly branch: string;
  readonly headOid: string;
  readonly createdAt: string;
  readonly activationDeadline: string;
  readonly expiresAt: string;
  readonly pathLeaseId: string;
  readonly parentProcessId: string;
  readonly parentSessionId: string;
  readonly state: LifecycleState;
  readonly revision: number;
  readonly activationStatus: ActivationStatus;
  readonly activationReceiptDigest?: string;
  readonly activationAbortReceiptDigest?: string;
  readonly pathLeaseReleaseReceiptDigest?: string;
  readonly ownerLossEvidenceDigest?: string;
  readonly terminalKind?: TerminalKind;
  readonly terminalReceiptDigest?: string;
  readonly denyReasons: readonly LifecycleDenyReason[];
  readonly denyHistory: readonly LifecycleDenyReason[];
  readonly retention?: RetentionSnapshot;
}

export type PlannedLifecycleInput = Omit<
  WorktreeLifecycleRecord,
  | "state"
  | "revision"
  | "activationStatus"
  | "activationReceiptDigest"
  | "activationAbortReceiptDigest"
  | "pathLeaseReleaseReceiptDigest"
  | "terminalKind"
  | "terminalReceiptDigest"
  | "denyReasons"
  | "denyHistory"
  | "retention"
> & {
  readonly activationStatus?: "unresolved";
};

export interface ActivationEvidence {
  readonly attempt: number;
  readonly workerStartReceiptDigest: string;
  readonly inventoryAvailable: boolean;
  readonly ownerAuthenticated: boolean;
}

export interface ActivationAbortInput {
  readonly attempt: number;
  readonly reason: "activation_unresolved";
  readonly activationAbortReceiptDigest: string;
  readonly pathLeaseRelease: {
    readonly released: true;
    readonly receiptDigest: string;
  };
}

export interface AuthenticatedOwnerLossEvidence {
  readonly kind: "authenticated_owner_loss";
  readonly authenticated: true;
  readonly sessionId: string;
  readonly observedAt: string;
  readonly evidenceDigest: string;
}

export type TerminalInput = {
  readonly attempt: number;
  readonly kind: TerminalKind;
  readonly terminalReceiptDigest?: string;
  readonly denyReasons?: readonly LifecycleDenyReason[];
  readonly ownerLossEvidence?: AuthenticatedOwnerLossEvidence;
};

export interface RetainInput {
  readonly attempt: number;
  readonly denyReasons: readonly LifecycleDenyReason[];
  readonly retention?: RetentionSnapshot;
}

export interface RetireInput {
  readonly attempt: number;
  readonly inventoryAvailable: boolean;
  readonly terminalReceiptDigest?: string;
}

export interface RetainedReevaluationInput {
  readonly attempt: number;
  readonly terminalReceiptDigest: string;
  readonly terminalKind: TerminalKind;
}

export type LifecycleEvent =
  | {
      readonly type: "planned";
      readonly identity: LifecycleIdentity;
      readonly lifecycleId: string;
      readonly attempt: number;
      readonly revision: 1;
      readonly record: WorktreeLifecycleRecord;
    }
  | {
      readonly type: "activated";
      readonly identity: LifecycleIdentity;
      readonly lifecycleId: string;
      readonly attempt: number;
      readonly revision: number;
      readonly workerStartReceiptDigest: string;
    }
  | {
      readonly type: "activation_aborted";
      readonly identity: LifecycleIdentity;
      readonly lifecycleId: string;
      readonly attempt: number;
      readonly revision: number;
      readonly reason: "activation_unresolved";
      readonly activationAbortReceiptDigest: string;
      readonly pathLeaseReleaseReceiptDigest: string;
    }
  | {
      readonly type: "terminal_pending";
      readonly identity: LifecycleIdentity;
      readonly lifecycleId: string;
      readonly attempt: number;
      readonly revision: number;
      readonly terminalKind: TerminalKind;
      readonly terminalReceiptDigest?: string;
      readonly ownerLossEvidenceDigest?: string;
      readonly denyReasons: readonly LifecycleDenyReason[];
    }
  | {
      readonly type: "retained";
      readonly identity: LifecycleIdentity;
      readonly lifecycleId: string;
      readonly attempt: number;
      readonly revision: number;
      readonly denyReasons: readonly LifecycleDenyReason[];
      readonly retention?: RetentionSnapshot;
    }
  | {
      readonly type: "retired";
      readonly identity: LifecycleIdentity;
      readonly lifecycleId: string;
      readonly attempt: number;
      readonly revision: number;
      readonly terminalReceiptDigest: string;
    }
  | {
      readonly type: "reevaluated";
      readonly identity: LifecycleIdentity;
      readonly lifecycleId: string;
      readonly attempt: number;
      readonly revision: number;
      readonly terminalKind: TerminalKind;
      readonly terminalReceiptDigest: string;
    };
