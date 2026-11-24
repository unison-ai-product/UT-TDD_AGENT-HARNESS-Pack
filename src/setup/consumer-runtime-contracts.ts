import type { ConsumerLocalRuntimeAdmission } from "./consumer-local-runtime-admission.ts";
import type {
  ConsumerNodeRuntimeBundle,
  ConsumerNodeRuntimeIdentity,
  ConsumerNodeRuntimeInstallResult,
  ConsumerNodeRuntimeOperationKind,
  ConsumerNodeRuntimePriorPointer,
} from "./consumer-node-runtime.ts";
import type { ProjectIdentityBootstrapResult } from "./project-identity-bootstrap.ts";

export interface SetupConsumerRuntimeInput {
  readonly identity: ConsumerNodeRuntimeIdentity;
  readonly admission: ConsumerLocalRuntimeAdmission;
  readonly compiled_esm: Uint8Array;
  readonly node_bootstrap_receipt: Uint8Array;
  readonly prior_bundle_digest?: string;
  readonly prior_history_tip_digest?: string;
  readonly history_sequence?: number;
  readonly prior_history?: Uint8Array;
  readonly prior_identity?: ConsumerNodeRuntimeIdentity;
  readonly prior_pointer?: ConsumerNodeRuntimePriorPointer | null;
  readonly operation_kind?: ConsumerNodeRuntimeOperationKind;
  readonly prior_attestation?: Uint8Array;
  readonly fault?: (barrier: string) => void;
  readonly verifySealedAggregate?: () => void;
}

export interface SetupConsumerRuntimeInstall {
  readonly bundle: ConsumerNodeRuntimeBundle;
  readonly result: ConsumerNodeRuntimeInstallResult;
}

export interface SetupResult {
  readonly phase: "0-A" | "0-B";
  readonly written: string[];
  readonly branchProtection: { readonly applied: boolean; readonly reason: string };
  readonly notices?: string[];
  readonly projectIdentity?: ProjectIdentityBootstrapResult;
  readonly consumerRuntime?: SetupConsumerRuntimeInstall;
}

export type ConsumerRuntimeReleaseInstallResult =
  | { readonly status: "installed"; readonly setup: SetupResult }
  | {
      readonly status: "already-installed";
      readonly cacheCreated?: boolean;
      readonly cacheWarning?: string;
    };
