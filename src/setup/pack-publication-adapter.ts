import { createHash } from "node:crypto";
import type {
  PackPublicationCommitEntry,
  PackPublicationReleaseAsset,
  SealedPackPublicationPlan,
} from "./pack-publication-staging.ts";
import { parsePackageSemver } from "./update-check.ts";

export type PublicationPortResult<T> =
  | { readonly status: "attested"; readonly value: T }
  | { readonly status: "mismatch" | "unavailable" | "indeterminate"; readonly reason: string };

export type PublicationTransition =
  | "planned"
  | "pack_commit"
  | "release_draft"
  | "assets"
  | "tag"
  | "release_visible"
  | "canary";

export type PublicationMutation =
  | "planned"
  | "pack_branch_commit"
  | "pack_pr_create"
  | "pack_pr_merge"
  | "release_draft_create"
  | `asset_upload:${string}`
  | "tag_create"
  | "release_visibility"
  | "canary_pointer_append";

export interface PackPublicationApproval {
  readonly transition: PublicationTransition;
  readonly mutation: PublicationMutation;
  readonly operationId: string;
  readonly nonce: string;
  readonly approver: string;
  readonly expiresAt: string;
  readonly intentDigest: string;
  readonly approvalStateDigest: string;
  readonly idempotencyKey: string;
}

export interface PackPublicationRemoteIdentity {
  readonly repository: string;
  readonly publicationBranch: string;
  readonly expectedMainSha: string;
  readonly expectedMainStateDigest: string;
  readonly expectedPointerObjectDigest: string;
  readonly beforeControlManifestSnapshotDigest: string;
  readonly allowedMergeMode: "pull_request_cas";
  readonly derivationRule: "entries-and-sidecar-v2";
}

export interface PackPublicationIntent {
  readonly kind: "pack-publication-intent-v2";
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly releaseId: string;
  readonly sourceRevision: string;
  readonly materializerVersion: string;
  readonly artifactSetDigest: string;
  readonly artifactInventoryDigest: string;
  readonly releaseRecordDigest: string;
  readonly stagingPlanDigest: string;
  readonly controlManifestSnapshotDigest: string;
  readonly commitEntries: readonly PackPublicationCommitEntry[];
  readonly releaseAssets: readonly [PackPublicationReleaseAsset, PackPublicationReleaseAsset];
  readonly remote: PackPublicationRemoteIdentity;
  readonly expectedTreeDigest: string;
  readonly releaseVersion: string;
  readonly tagName: string;
  readonly approvals: Readonly<Record<string, PackPublicationApproval>>;
  readonly intentDigest: string;
}

export interface PackPublicationIntentInput {
  readonly plan: SealedPackPublicationPlan;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly remote: PackPublicationRemoteIdentity;
  readonly releaseVersion: string;
  readonly tagName: string;
  readonly approvals?: readonly PackPublicationApproval[];
}

export type PackPublicationIntentResult =
  | { readonly ok: true; readonly intent: PackPublicationIntent }
  | {
      readonly ok: false;
      readonly error:
        | "invalid_operation"
        | "invalid_remote_identity"
        | "invalid_inventory"
        | "release_version_mismatch"
        | "tag_version_mismatch"
        | "approval_missing"
        | "approval_duplicate"
        | "approval_binding_mismatch"
        | "nonce_replay";
    };

export interface PackMainObservation {
  readonly mainSha: string;
  readonly mainStateDigest: string;
  readonly pointerObjectDigest: string;
  readonly controlManifestSnapshotDigest: string;
}

export interface PackCommitObservation {
  readonly commitSha: string;
  readonly treeDigest: string;
  readonly controlManifestSnapshotDigest: string;
  readonly releaseId: string;
  readonly sourceRevision: string;
  readonly materializerVersion: string;
  readonly mergeMode: "pull_request_cas";
}

export interface DraftReleaseObservation {
  readonly releaseId: string;
  readonly releaseVersion: string;
  readonly tagName: string;
  readonly targetCommit: string;
  readonly draft: boolean;
}

export interface ReleaseAssetObservation {
  readonly name: string;
  readonly size: number;
  readonly contentDigest: string;
}

export interface TagObservation {
  readonly name: string;
  readonly targetCommit: string;
  readonly annotated: boolean;
}

export interface VisibilityObservation {
  readonly releaseId: string;
  readonly draft: boolean;
}

export interface CanaryObservation {
  readonly pointerObjectDigest: string;
  readonly controlManifestSnapshotDigest: string;
  readonly mainSha: string;
  readonly mainStateDigest: string;
}

export interface PublicationJournalEvent {
  readonly transition: PublicationTransition;
  readonly mutation: PublicationMutation;
  readonly kind: "planned_nonce_consumed" | "mutation_intent" | "read_back_observation";
  readonly intentDigest: string;
  readonly nonce: string;
  readonly detailDigest: string;
}

export interface PackPublicationReceipt {
  readonly kind: "pack-publication-receipt-v2";
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly intentDigest: string;
  readonly releaseId: string;
  readonly sourceRevision: string;
  readonly releaseVersion: string;
  readonly releasePackCommit: string;
  readonly releasePackTreeDigest: string;
  readonly pointerPackCommit: string;
  readonly pointerPackTreeDigest: string;
  readonly tagName: string;
  readonly assets: readonly [ReleaseAssetObservation, ReleaseAssetObservation];
  readonly beforeControlManifestSnapshotDigest: string;
  readonly afterControlManifestSnapshotDigest: string;
  readonly pointerObjectDigest: string;
  readonly approver: string;
  readonly nonces: Readonly<Record<string, string>>;
  readonly durableExecutionStateDigest: string;
  readonly receiptDigest: string;
}

export interface PackPublicationPorts {
  readonly approval: {
    readonly consume: (
      approval: PackPublicationApproval,
    ) =>
      | PublicationPortResult<{ readonly mode: "new" | "reconcile" }>
      | Promise<PublicationPortResult<{ readonly mode: "new" | "reconcile" }>>;
  };
  readonly durableState: {
    readonly append: (event: PublicationJournalEvent) => void | Promise<void>;
    readonly digest: () => string;
  };
  readonly pack: {
    readonly observeBefore: () =>
      | PublicationPortResult<PackMainObservation>
      | Promise<PublicationPortResult<PackMainObservation>>;
    readonly commitPublicationBranch: (input: {
      readonly repository: string;
      readonly branch: string;
      readonly entries: readonly PackPublicationCommitEntry[];
    }) =>
      | PublicationPortResult<{ readonly branchCommit: string }>
      | Promise<PublicationPortResult<{ readonly branchCommit: string }>>;
    readonly createPullRequest: (input: {
      readonly repository: string;
      readonly branch: string;
      readonly expectedMainSha: string;
    }) =>
      | PublicationPortResult<{ readonly pullRequest: string }>
      | Promise<PublicationPortResult<{ readonly pullRequest: string }>>;
    readonly mergePullRequestCas: (input: {
      readonly repository: string;
      readonly pullRequest: string;
      readonly expectedMainSha: string;
    }) =>
      | PublicationPortResult<{ readonly mainSha: string }>
      | Promise<PublicationPortResult<{ readonly mainSha: string }>>;
    readonly observeReleaseCommit: (input: {
      readonly repository: string;
      readonly mainSha: string;
    }) =>
      | PublicationPortResult<PackCommitObservation>
      | Promise<PublicationPortResult<PackCommitObservation>>;
  };
  readonly release: {
    readonly createDraft: (input: {
      readonly releaseId: string;
      readonly releaseVersion: string;
      readonly tagName: string;
      readonly targetCommit: string;
    }) =>
      | PublicationPortResult<DraftReleaseObservation>
      | Promise<PublicationPortResult<DraftReleaseObservation>>;
    readonly observeDraft: (input: {
      readonly releaseId: string;
      readonly releaseVersion: string;
      readonly tagName: string;
    }) =>
      | PublicationPortResult<DraftReleaseObservation>
      | Promise<PublicationPortResult<DraftReleaseObservation>>;
    readonly uploadAsset: (input: {
      readonly releaseId: string;
      readonly asset: PackPublicationReleaseAsset;
    }) =>
      | PublicationPortResult<ReleaseAssetObservation>
      | Promise<PublicationPortResult<ReleaseAssetObservation>>;
    readonly observeAsset: (input: {
      readonly releaseId: string;
      readonly name: string;
    }) =>
      | PublicationPortResult<ReleaseAssetObservation>
      | Promise<PublicationPortResult<ReleaseAssetObservation>>;
  };
  readonly tag: {
    readonly observe: (
      name: string,
    ) =>
      | PublicationPortResult<TagObservation | null>
      | Promise<PublicationPortResult<TagObservation | null>>;
    readonly createAnnotatedCas: (input: {
      readonly name: string;
      readonly targetCommit: string;
    }) => PublicationPortResult<TagObservation> | Promise<PublicationPortResult<TagObservation>>;
  };
  readonly visibility: {
    readonly makeVisible: (input: {
      readonly releaseId: string;
      readonly tagName: string;
    }) =>
      | PublicationPortResult<VisibilityObservation>
      | Promise<PublicationPortResult<VisibilityObservation>>;
    readonly observe: (
      releaseId: string,
    ) =>
      | PublicationPortResult<VisibilityObservation>
      | Promise<PublicationPortResult<VisibilityObservation>>;
  };
  readonly canary: {
    readonly observeBefore: () =>
      | PublicationPortResult<CanaryObservation>
      | Promise<PublicationPortResult<CanaryObservation>>;
    readonly appendCas: (input: {
      readonly releaseId: string;
      readonly before: CanaryObservation;
      readonly afterControlManifestSnapshotDigest: string;
    }) =>
      | PublicationPortResult<CanaryObservation>
      | Promise<PublicationPortResult<CanaryObservation>>;
  };
  readonly auditor: {
    readonly attest: (input: {
      readonly intent: PackPublicationIntent;
      readonly commit: PackCommitObservation;
      readonly draft: DraftReleaseObservation;
      readonly assets: readonly ReleaseAssetObservation[];
      readonly tag: TagObservation;
      readonly visibility: VisibilityObservation;
    }) =>
      | PublicationPortResult<{ readonly attested: true }>
      | Promise<PublicationPortResult<{ readonly attested: true }>>;
  };
  readonly reconcile: {
    readonly observe: (
      intent: PackPublicationIntent,
    ) =>
      | PublicationPortResult<PackPublicationReceipt>
      | Promise<PublicationPortResult<PackPublicationReceipt>>;
  };
  readonly receipt: { readonly persist: (receipt: PackPublicationReceipt) => void | Promise<void> };
  readonly cleanup?: { readonly run: () => void | Promise<void> };
}

export type PackPublicationResult =
  | {
      readonly status: "published";
      readonly receipt: PackPublicationReceipt;
      readonly remoteWrites: number;
      readonly cleanup: "not_requested" | "complete" | "failed";
    }
  | {
      readonly status: "denied" | "partial_publication" | "indeterminate";
      readonly stage: "preflight" | PublicationTransition;
      readonly reason: string;
      readonly remoteWrites: number;
    };

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const CONTROL_MANIFEST_PATH = "release/manifest.yaml";
const PACKAGE_JSON_PATH = "package.json";
const PACKAGE_LOCK_JSON_PATH = "package-lock.json";

function sha256(input: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
    .join(",")}}`;
}

function immutableBytes<T extends { readonly bytes: Uint8Array }>(value: T): T {
  const bytes = Buffer.from(value.bytes);
  return Object.freeze({
    ...value,
    get bytes(): Uint8Array {
      return new Uint8Array(bytes);
    },
  });
}

function digestEntry(entry: PackPublicationCommitEntry): string {
  return sha256(
    stable({
      path: entry.path,
      mode: entry.mode,
      kind: entry.kind,
      size: entry.size,
      contentDigest: entry.contentDigest,
      bytesDigest: sha256(entry.bytes),
    }),
  );
}

export interface SealedPackageVersionIdentity {
  readonly packageVersion: string;
  readonly lockfileVersion: string;
  readonly lockfileRootVersion: string;
}

function parseJsonEntry(
  entries: readonly PackPublicationCommitEntry[],
  path: string,
): Record<string, unknown> | null {
  const matching = entries.filter((entry) => entry.path === path);
  if (matching.length !== 1) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(matching[0].bytes);
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function parseSealedPackageVersionIdentity(
  entries: readonly PackPublicationCommitEntry[],
): SealedPackageVersionIdentity | null {
  const packageJson = parseJsonEntry(entries, PACKAGE_JSON_PATH);
  const packageLock = parseJsonEntry(entries, PACKAGE_LOCK_JSON_PATH);
  if (!packageJson || !packageLock) return null;
  const rootPackages = packageLock.packages;
  const rootPackage =
    typeof rootPackages === "object" && rootPackages !== null && !Array.isArray(rootPackages)
      ? (rootPackages as Record<string, unknown>)[""]
      : null;
  if (typeof rootPackage !== "object" || rootPackage === null || Array.isArray(rootPackage))
    return null;
  const packageVersion = packageJson.version;
  const lockfileVersion = packageLock.version;
  const lockfileRootVersion = (rootPackage as Record<string, unknown>).version;
  if (
    typeof packageVersion !== "string" ||
    typeof lockfileVersion !== "string" ||
    typeof lockfileRootVersion !== "string" ||
    !parsePackageSemver(packageVersion) ||
    !parsePackageSemver(lockfileVersion) ||
    !parsePackageSemver(lockfileRootVersion)
  )
    return null;
  return { packageVersion, lockfileVersion, lockfileRootVersion };
}

const sealedPackageVersionIdentity = parseSealedPackageVersionIdentity;

export function derivePackPublicationTreeDigest(plan: {
  readonly commitEntries: readonly PackPublicationCommitEntry[];
}): string {
  return sha256(
    stable(
      [...plan.commitEntries]
        .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
        .map(digestEntry),
    ),
  );
}

export function derivePackPublicationStagingPlanDigest(plan: SealedPackPublicationPlan): string {
  return sha256(
    stable({
      releaseId: plan.releaseId,
      controlManifestSnapshotDigest: plan.controlManifestSnapshotDigest,
      treeDigest: derivePackPublicationTreeDigest(plan),
      assets: plan.releaseAssets.map((asset) => ({
        name: asset.name,
        size: asset.size,
        contentDigest: asset.contentDigest,
        bytesDigest: sha256(asset.bytes),
      })),
    }),
  );
}

function mutationsFor(plan: SealedPackPublicationPlan): readonly PublicationMutation[] {
  return [
    "planned",
    "pack_branch_commit",
    "pack_pr_create",
    "pack_pr_merge",
    "release_draft_create",
    ...plan.releaseAssets.map((asset) => `asset_upload:${asset.name}` as const),
    "tag_create",
    "release_visibility",
    "canary_pointer_append",
  ];
}

function transitionFor(mutation: PublicationMutation): PublicationTransition {
  if (mutation.startsWith("asset_upload:")) return "assets";
  const transitions: Record<
    Exclude<PublicationMutation, `asset_upload:${string}`>,
    PublicationTransition
  > = {
    planned: "planned",
    pack_branch_commit: "pack_commit",
    pack_pr_create: "pack_commit",
    pack_pr_merge: "pack_commit",
    release_draft_create: "release_draft",
    tag_create: "tag",
    release_visibility: "release_visible",
    canary_pointer_append: "canary",
  };
  return transitions[mutation as Exclude<PublicationMutation, `asset_upload:${string}`>];
}

function intentIdentity(
  input: PackPublicationIntentInput,
): Omit<PackPublicationIntent, "approvals"> {
  const release = input.plan.manifest.releases[input.plan.releaseId];
  const intent = {
    kind: "pack-publication-intent-v2" as const,
    operationId: input.operationId,
    idempotencyKey: input.idempotencyKey,
    releaseId: input.plan.releaseId,
    sourceRevision: release?.artifactSourceCommit ?? "",
    materializerVersion: release?.materializerVersion ?? "",
    artifactSetDigest: release?.artifactSetDigest ?? "",
    artifactInventoryDigest: release?.artifactInventoryDigest ?? "",
    releaseRecordDigest: release?.releaseRecordDigest ?? "",
    stagingPlanDigest: derivePackPublicationStagingPlanDigest(input.plan),
    controlManifestSnapshotDigest: input.plan.controlManifestSnapshotDigest,
    commitEntries: input.plan.commitEntries.map(immutableBytes),
    releaseAssets: input.plan.releaseAssets.map(immutableBytes) as unknown as readonly [
      PackPublicationReleaseAsset,
      PackPublicationReleaseAsset,
    ],
    remote: Object.freeze({ ...input.remote }),
    expectedTreeDigest: derivePackPublicationTreeDigest(input.plan),
    releaseVersion: input.releaseVersion,
    tagName: input.tagName,
    intentDigest: "",
  };
  return Object.freeze({ ...intent, intentDigest: sha256(stable(intent)) });
}

export function derivePackPublicationIntentDigest(input: PackPublicationIntentInput): string {
  return intentIdentity(input).intentDigest;
}

function validInventory(intent: Omit<PackPublicationIntent, "approvals">): boolean {
  const entries = intent.commitEntries;
  const assets = intent.releaseAssets;
  const paths = entries.map((entry) => entry.path);
  return (
    entries.length > 0 &&
    new Set(paths).size === paths.length &&
    paths.filter((path) => path === CONTROL_MANIFEST_PATH).length === 1 &&
    entries.every(
      (entry) =>
        entry.size === entry.bytes.length &&
        entry.contentDigest === sha256(entry.bytes) &&
        (entry.mode === "100644" || entry.mode === "100755"),
    ) &&
    assets.length === 2 &&
    new Set(assets.map((asset) => asset.name)).size === 2 &&
    assets.every(
      (asset) => asset.size === asset.bytes.length && asset.contentDigest === sha256(asset.bytes),
    ) &&
    (() => {
      const versions = sealedPackageVersionIdentity(entries);
      return (
        versions !== null &&
        versions.packageVersion === versions.lockfileVersion &&
        versions.packageVersion === versions.lockfileRootVersion
      );
    })()
  );
}

function validStagingPlan(plan: SealedPackPublicationPlan): boolean {
  const release = plan.manifest.releases[plan.releaseId];
  if (!release) return false;
  const payloadEntries = plan.commitEntries.filter((entry) => entry.path !== CONTROL_MANIFEST_PATH);
  if (payloadEntries.length !== release.artifacts.length) return false;
  return release.artifacts.every((artifact, index) => {
    const entry = payloadEntries[index];
    return (
      entry?.path === artifact.destinationPath &&
      entry.mode === artifact.mode &&
      entry.size === artifact.size &&
      entry.contentDigest === artifact.contentDigest
    );
  });
}

export function sealPackPublicationIntent(
  input: PackPublicationIntentInput,
): PackPublicationIntentResult {
  if (!input.operationId || !input.idempotencyKey || !input.releaseVersion || !input.tagName)
    return { ok: false, error: "invalid_operation" };
  if (
    !input.remote.repository ||
    !input.remote.publicationBranch ||
    !SHA1.test(input.remote.expectedMainSha) ||
    !SHA256.test(input.remote.expectedMainStateDigest) ||
    !SHA256.test(input.remote.expectedPointerObjectDigest) ||
    input.remote.beforeControlManifestSnapshotDigest !== input.plan.controlManifestSnapshotDigest ||
    input.remote.allowedMergeMode !== "pull_request_cas" ||
    input.remote.derivationRule !== "entries-and-sidecar-v2"
  )
    return { ok: false, error: "invalid_remote_identity" };
  const packageVersions = sealedPackageVersionIdentity(input.plan.commitEntries);
  if (packageVersions === null) return { ok: false, error: "invalid_inventory" };
  if (
    packageVersions.packageVersion !== packageVersions.lockfileVersion ||
    packageVersions.packageVersion !== packageVersions.lockfileRootVersion ||
    packageVersions.packageVersion !== input.releaseVersion
  )
    return { ok: false, error: "release_version_mismatch" };
  if (input.tagName !== `v${input.releaseVersion}`)
    return { ok: false, error: "tag_version_mismatch" };
  const identity = intentIdentity(input);
  if (!validStagingPlan(input.plan) || !validInventory(identity))
    return { ok: false, error: "invalid_inventory" };
  const required = mutationsFor(input.plan);
  const approvals: Record<string, PackPublicationApproval> = {};
  const nonces = new Set<string>();
  for (const approval of input.approvals ?? []) {
    if (approvals[approval.mutation]) return { ok: false, error: "approval_duplicate" };
    if (nonces.has(approval.nonce)) return { ok: false, error: "nonce_replay" };
    if (
      approval.transition !== transitionFor(approval.mutation) ||
      approval.operationId !== input.operationId ||
      approval.idempotencyKey !== input.idempotencyKey ||
      approval.intentDigest !== identity.intentDigest ||
      !approval.nonce ||
      !approval.approver ||
      !approval.expiresAt ||
      !SHA256.test(approval.approvalStateDigest)
    )
      return { ok: false, error: "approval_binding_mismatch" };
    nonces.add(approval.nonce);
    approvals[approval.mutation] = Object.freeze({ ...approval });
  }
  if (required.some((mutation) => !approvals[mutation]))
    return { ok: false, error: "approval_missing" };
  if (
    Object.keys(approvals).some((mutation) => !required.includes(mutation as PublicationMutation))
  )
    return { ok: false, error: "approval_binding_mismatch" };
  return {
    ok: true,
    intent: Object.freeze({ ...identity, approvals: Object.freeze(approvals) }),
  };
}

function validateSealedIntent(intent: PackPublicationIntent): boolean {
  const bare = { ...intent, approvals: undefined, intentDigest: "" };
  delete (bare as { approvals?: unknown }).approvals;
  const required = [
    "planned",
    "pack_branch_commit",
    "pack_pr_create",
    "pack_pr_merge",
    "release_draft_create",
    ...intent.releaseAssets.map((asset) => `asset_upload:${asset.name}` as const),
    "tag_create",
    "release_visibility",
    "canary_pointer_append",
  ] satisfies readonly PublicationMutation[];
  const approvals = Object.values(intent.approvals);
  const nonces = new Set(approvals.map((approval) => approval.nonce));
  const approvalKeys = Object.keys(intent.approvals);
  const approvalsValid =
    approvals.length === required.length &&
    approvalKeys.every((mutation) => required.includes(mutation as PublicationMutation)) &&
    approvalKeys.every((mutation) => intent.approvals[mutation]?.mutation === mutation) &&
    required.every((mutation) => intent.approvals[mutation] !== undefined) &&
    nonces.size === approvals.length &&
    approvals.every(
      (approval) =>
        approval.transition === transitionFor(approval.mutation) &&
        approval.operationId === intent.operationId &&
        approval.idempotencyKey === intent.idempotencyKey &&
        approval.intentDigest === intent.intentDigest &&
        Boolean(approval.nonce) &&
        Boolean(approval.approver) &&
        Boolean(approval.expiresAt) &&
        SHA256.test(approval.approvalStateDigest),
    );
  return intent.intentDigest === sha256(stable(bare)) && validInventory(intent) && approvalsValid;
}

function eventDigest(value: unknown): string {
  return sha256(stable(value));
}

interface FailureContext {
  readonly result: Exclude<PublicationPortResult<unknown>, { status: "attested" }>;
  readonly stage: "preflight" | PublicationTransition;
  readonly remoteWrites: number;
  readonly prewrite?: boolean;
}

function failure(context: FailureContext): PackPublicationResult {
  const { result, stage, remoteWrites, prewrite = false } = context;
  return {
    status:
      result.status === "mismatch" && prewrite
        ? "denied"
        : result.status === "mismatch"
          ? "partial_publication"
          : "indeterminate",
    stage,
    reason: result.reason,
    remoteWrites,
  };
}

function validReceipt(receipt: PackPublicationReceipt, intent: PackPublicationIntent): boolean {
  const unsigned = { ...receipt, receiptDigest: "" };
  return (
    receipt.operationId === intent.operationId &&
    receipt.idempotencyKey === intent.idempotencyKey &&
    receipt.intentDigest === intent.intentDigest &&
    receipt.releaseId === intent.releaseId &&
    receipt.sourceRevision === intent.sourceRevision &&
    receipt.releaseVersion === intent.releaseVersion &&
    receipt.tagName === intent.tagName &&
    receipt.receiptDigest === sha256(stable(unsigned))
  );
}

class PublicationRun {
  private remoteWrites = 0;
  private readonly intent: PackPublicationIntent;
  private readonly ports: PackPublicationPorts;

  constructor(intent: PackPublicationIntent, ports: PackPublicationPorts) {
    this.intent = intent;
    this.ports = ports;
  }

  count(): number {
    return this.remoteWrites;
  }

  async journal(
    approval: PackPublicationApproval,
    kind: PublicationJournalEvent["kind"],
    detail: unknown,
  ): Promise<boolean> {
    try {
      await this.ports.durableState.append({
        transition: approval.transition,
        mutation: approval.mutation,
        kind,
        intentDigest: this.intent.intentDigest,
        nonce: approval.nonce,
        detailDigest: eventDigest(detail),
      });
      return true;
    } catch {
      return false;
    }
  }

  async authorize(
    mutation: PublicationMutation,
  ): Promise<PackPublicationResult | "new" | "reconcile"> {
    const approval = this.intent.approvals[mutation];
    if (!approval)
      return {
        status: "denied",
        stage: transitionFor(mutation),
        reason: "approval_missing",
        remoteWrites: this.remoteWrites,
      };
    let result: PublicationPortResult<{ readonly mode: "new" | "reconcile" }>;
    try {
      result = await this.ports.approval.consume(approval);
    } catch {
      return {
        status: "indeterminate",
        stage: approval.transition,
        reason: "approval_unavailable",
        remoteWrites: this.remoteWrites,
      };
    }
    if (result.status !== "attested")
      return failure({
        result,
        stage: approval.transition,
        remoteWrites: this.remoteWrites,
        prewrite: this.remoteWrites === 0,
      });
    if (
      !(await this.journal(approval, "planned_nonce_consumed", {
        mode: result.value.mode,
        approvalStateDigest: approval.approvalStateDigest,
      }))
    )
      return {
        status: "indeterminate",
        stage: approval.transition,
        reason: "journal_persist_failed",
        remoteWrites: this.remoteWrites,
      };
    return result.value.mode;
  }

  async mutate<T>(
    mutation: PublicationMutation,
    detail: unknown,
    invoke: () => PublicationPortResult<T> | Promise<PublicationPortResult<T>>,
  ): Promise<{ value: T } | { failure: PackPublicationResult } | { reconcile: true }> {
    const authorization = await this.authorize(mutation);
    if (typeof authorization !== "string") return { failure: authorization };
    if (authorization === "reconcile") return { reconcile: true };
    const approval = this.intent.approvals[mutation];
    if (!(await this.journal(approval, "mutation_intent", detail)))
      return {
        failure: {
          status: "indeterminate",
          stage: approval.transition,
          reason: "journal_persist_failed",
          remoteWrites: this.remoteWrites,
        },
      };
    this.remoteWrites += 1;
    let result: PublicationPortResult<T>;
    try {
      result = await invoke();
    } catch {
      return {
        failure: {
          status: "indeterminate",
          stage: approval.transition,
          reason: "remote_response_lost",
          remoteWrites: this.remoteWrites,
        },
      };
    }
    if (result.status !== "attested")
      return {
        failure: failure({ result, stage: approval.transition, remoteWrites: this.remoteWrites }),
      };
    if (!(await this.journal(approval, "read_back_observation", result.value)))
      return {
        failure: {
          status: "indeterminate",
          stage: approval.transition,
          reason: "journal_persist_failed",
          remoteWrites: this.remoteWrites,
        },
      };
    return { value: result.value };
  }
}

async function reconcile(
  intent: PackPublicationIntent,
  ports: PackPublicationPorts,
  remoteWrites: number,
): Promise<PackPublicationResult> {
  let observed: PublicationPortResult<PackPublicationReceipt>;
  try {
    observed = await ports.reconcile.observe(intent);
  } catch {
    return {
      status: "indeterminate",
      stage: "preflight",
      reason: "reconciliation_unavailable",
      remoteWrites,
    };
  }
  if (observed.status !== "attested")
    return failure({
      result: observed,
      stage: "preflight",
      remoteWrites,
      prewrite: remoteWrites === 0,
    });
  if (!validReceipt(observed.value, intent))
    return {
      status: "indeterminate",
      stage: "preflight",
      reason: "reconciliation_identity_mismatch",
      remoteWrites,
    };
  return { status: "published", receipt: observed.value, remoteWrites, cleanup: "not_requested" };
}

function sameAsset(
  expected: PackPublicationReleaseAsset,
  actual: ReleaseAssetObservation,
): boolean {
  return (
    expected.name === actual.name &&
    expected.size === actual.size &&
    expected.contentDigest === actual.contentDigest
  );
}

interface ObservationRequest<T> {
  readonly stage: "preflight" | PublicationTransition;
  readonly remoteWrites: number;
  readonly invoke: () => PublicationPortResult<T> | Promise<PublicationPortResult<T>>;
  readonly prewrite?: boolean;
}

async function observeAttested<T>(
  request: ObservationRequest<T>,
): Promise<{ readonly value: T } | { readonly failure: PackPublicationResult }> {
  const { stage, remoteWrites, invoke, prewrite = false } = request;
  let observed: PublicationPortResult<T>;
  try {
    observed = await invoke();
  } catch {
    return {
      failure: {
        status: "indeterminate",
        stage,
        reason: "observation_unavailable",
        remoteWrites,
      },
    };
  }
  if (observed.status !== "attested") {
    return { failure: failure({ result: observed, stage, remoteWrites, prewrite }) };
  }
  return { value: observed.value };
}

export async function publishPackCanary(
  intent: PackPublicationIntent,
  ports: PackPublicationPorts,
): Promise<PackPublicationResult> {
  if (!validateSealedIntent(intent))
    return {
      status: "denied",
      stage: "preflight",
      reason: "sealed_intent_mismatch",
      remoteWrites: 0,
    };
  const run = new PublicationRun(intent, ports);
  const [before, pointerBefore, tagBefore] = await Promise.all([
    observeAttested({
      stage: "preflight",
      remoteWrites: 0,
      invoke: () => ports.pack.observeBefore(),
      prewrite: true,
    }),
    observeAttested({
      stage: "preflight",
      remoteWrites: 0,
      invoke: () => ports.canary.observeBefore(),
      prewrite: true,
    }),
    observeAttested({
      stage: "preflight",
      remoteWrites: 0,
      invoke: () => ports.tag.observe(intent.tagName),
      prewrite: true,
    }),
  ]);
  if ("failure" in before) return before.failure;
  if ("failure" in pointerBefore) return pointerBefore.failure;
  if ("failure" in tagBefore) return tagBefore.failure;
  if (
    before.value.mainSha !== intent.remote.expectedMainSha ||
    before.value.mainStateDigest !== intent.remote.expectedMainStateDigest ||
    before.value.pointerObjectDigest !== intent.remote.expectedPointerObjectDigest ||
    before.value.controlManifestSnapshotDigest !==
      intent.remote.beforeControlManifestSnapshotDigest ||
    pointerBefore.value.mainSha !== intent.remote.expectedMainSha ||
    pointerBefore.value.mainStateDigest !== intent.remote.expectedMainStateDigest ||
    pointerBefore.value.pointerObjectDigest !== intent.remote.expectedPointerObjectDigest ||
    pointerBefore.value.controlManifestSnapshotDigest !==
      intent.remote.beforeControlManifestSnapshotDigest
  )
    return {
      status: "denied",
      stage: "preflight",
      reason: "initial_identity_drift",
      remoteWrites: 0,
    };
  if (tagBefore.value !== null)
    return {
      status: "denied",
      stage: "preflight",
      reason: "duplicate_or_retargeted_tag",
      remoteWrites: 0,
    };

  const planned = await run.authorize("planned");
  if (typeof planned !== "string") return planned;
  if (planned === "reconcile") return reconcile(intent, ports, run.count());

  const branch = await run.mutate("pack_branch_commit", intent.commitEntries, () =>
    ports.pack.commitPublicationBranch({
      repository: intent.remote.repository,
      branch: intent.remote.publicationBranch,
      entries: intent.commitEntries,
    }),
  );
  if ("failure" in branch) return branch.failure;
  if ("reconcile" in branch) return reconcile(intent, ports, run.count());
  const pullRequest = await run.mutate("pack_pr_create", branch.value, () =>
    ports.pack.createPullRequest({
      repository: intent.remote.repository,
      branch: intent.remote.publicationBranch,
      expectedMainSha: intent.remote.expectedMainSha,
    }),
  );
  if ("failure" in pullRequest) return pullRequest.failure;
  if ("reconcile" in pullRequest) return reconcile(intent, ports, run.count());
  const merged = await run.mutate("pack_pr_merge", pullRequest.value, () =>
    ports.pack.mergePullRequestCas({
      repository: intent.remote.repository,
      pullRequest: pullRequest.value.pullRequest,
      expectedMainSha: intent.remote.expectedMainSha,
    }),
  );
  if ("failure" in merged) return merged.failure;
  if ("reconcile" in merged) return reconcile(intent, ports, run.count());

  const commit = await observeAttested({
    stage: "pack_commit",
    remoteWrites: run.count(),
    invoke: () =>
      ports.pack.observeReleaseCommit({
        repository: intent.remote.repository,
        mainSha: merged.value.mainSha,
      }),
  });
  if ("failure" in commit) return commit.failure;
  if (
    commit.value.commitSha !== merged.value.mainSha ||
    commit.value.treeDigest !== intent.expectedTreeDigest ||
    commit.value.controlManifestSnapshotDigest !== intent.controlManifestSnapshotDigest ||
    commit.value.releaseId !== intent.releaseId ||
    commit.value.sourceRevision !== intent.sourceRevision ||
    commit.value.materializerVersion !== intent.materializerVersion ||
    commit.value.mergeMode !== intent.remote.allowedMergeMode
  )
    return {
      status: "partial_publication",
      stage: "pack_commit",
      reason: "release_commit_attestation_mismatch",
      remoteWrites: run.count(),
    };

  const draft = await run.mutate("release_draft_create", commit.value, () =>
    ports.release.createDraft({
      releaseId: intent.releaseId,
      releaseVersion: intent.releaseVersion,
      tagName: intent.tagName,
      targetCommit: commit.value.commitSha,
    }),
  );
  if ("failure" in draft) return draft.failure;
  if ("reconcile" in draft) return reconcile(intent, ports, run.count());
  const draftObserved = await observeAttested({
    stage: "release_draft",
    remoteWrites: run.count(),
    invoke: () =>
      ports.release.observeDraft({
        releaseId: intent.releaseId,
        releaseVersion: intent.releaseVersion,
        tagName: intent.tagName,
      }),
  });
  if ("failure" in draftObserved) return draftObserved.failure;
  if (
    !draftObserved.value.draft ||
    draftObserved.value.releaseId !== intent.releaseId ||
    draftObserved.value.releaseVersion !== intent.releaseVersion ||
    draftObserved.value.tagName !== intent.tagName ||
    draftObserved.value.targetCommit !== commit.value.commitSha
  )
    return {
      status: "partial_publication",
      stage: "release_draft",
      reason: "draft_identity_mismatch",
      remoteWrites: run.count(),
    };

  const assets: ReleaseAssetObservation[] = [];
  for (const asset of intent.releaseAssets) {
    const uploaded = await run.mutate(`asset_upload:${asset.name}`, asset, () =>
      ports.release.uploadAsset({ releaseId: intent.releaseId, asset }),
    );
    if ("failure" in uploaded) return uploaded.failure;
    if ("reconcile" in uploaded) return reconcile(intent, ports, run.count());
    const observed = await observeAttested({
      stage: "assets",
      remoteWrites: run.count(),
      invoke: () => ports.release.observeAsset({ releaseId: intent.releaseId, name: asset.name }),
    });
    if ("failure" in observed) return observed.failure;
    if (!sameAsset(asset, observed.value))
      return {
        status: "partial_publication",
        stage: "assets",
        reason: "asset_identity_mismatch",
        remoteWrites: run.count(),
      };
    assets.push(observed.value);
  }

  const tag = await run.mutate("tag_create", commit.value, () =>
    ports.tag.createAnnotatedCas({ name: intent.tagName, targetCommit: commit.value.commitSha }),
  );
  if ("failure" in tag) return tag.failure;
  if ("reconcile" in tag) return reconcile(intent, ports, run.count());
  const tagObserved = await observeAttested({
    stage: "tag",
    remoteWrites: run.count(),
    invoke: () => ports.tag.observe(intent.tagName),
  });
  if ("failure" in tagObserved) return tagObserved.failure;
  if (tagObserved.value === null)
    return {
      status: "partial_publication",
      stage: "tag",
      reason: "tag_identity_mismatch",
      remoteWrites: run.count(),
    };
  const observedTag = tagObserved.value;
  if (
    !observedTag.annotated ||
    observedTag.name !== intent.tagName ||
    observedTag.targetCommit !== commit.value.commitSha
  )
    return {
      status: "partial_publication",
      stage: "tag",
      reason: "tag_identity_mismatch",
      remoteWrites: run.count(),
    };

  const visible = await run.mutate("release_visibility", observedTag, () =>
    ports.visibility.makeVisible({ releaseId: intent.releaseId, tagName: intent.tagName }),
  );
  if ("failure" in visible) return visible.failure;
  if ("reconcile" in visible) return reconcile(intent, ports, run.count());
  const visibleObserved = await observeAttested({
    stage: "release_visible",
    remoteWrites: run.count(),
    invoke: () => ports.visibility.observe(intent.releaseId),
  });
  if ("failure" in visibleObserved) return visibleObserved.failure;
  if (visibleObserved.value.draft || visibleObserved.value.releaseId !== intent.releaseId)
    return {
      status: "partial_publication",
      stage: "release_visible",
      reason: "visibility_identity_mismatch",
      remoteWrites: run.count(),
    };
  const audit = await observeAttested({
    stage: "release_visible",
    remoteWrites: run.count(),
    invoke: () =>
      ports.auditor.attest({
        intent,
        commit: commit.value,
        draft: draftObserved.value,
        assets,
        tag: observedTag,
        visibility: visibleObserved.value,
      }),
  });
  if ("failure" in audit) return audit.failure;

  const lateBefore = await observeAttested({
    stage: "canary",
    remoteWrites: run.count(),
    invoke: () => ports.canary.observeBefore(),
  });
  if ("failure" in lateBefore) return lateBefore.failure;
  if (
    lateBefore.value.mainSha !== commit.value.commitSha ||
    lateBefore.value.pointerObjectDigest !== intent.remote.expectedPointerObjectDigest ||
    lateBefore.value.controlManifestSnapshotDigest !==
      intent.remote.beforeControlManifestSnapshotDigest
  )
    return {
      status: "partial_publication",
      stage: "canary",
      reason: "late_pointer_cas_drift",
      remoteWrites: run.count(),
    };
  const afterDigest = sha256(
    stable({
      before: intent.controlManifestSnapshotDigest,
      releaseId: intent.releaseId,
      releasePackCommit: commit.value.commitSha,
    }),
  );
  const pointer = await run.mutate("canary_pointer_append", afterDigest, () =>
    ports.canary.appendCas({
      releaseId: intent.releaseId,
      before: lateBefore.value,
      afterControlManifestSnapshotDigest: afterDigest,
    }),
  );
  if ("failure" in pointer) return pointer.failure;
  if ("reconcile" in pointer) return reconcile(intent, ports, run.count());
  if (
    pointer.value.controlManifestSnapshotDigest !== afterDigest ||
    pointer.value.pointerObjectDigest === intent.remote.expectedPointerObjectDigest
  )
    return {
      status: "indeterminate",
      stage: "canary",
      reason: "pointer_read_back_mismatch",
      remoteWrites: run.count(),
    };

  const unsigned = {
    kind: "pack-publication-receipt-v2" as const,
    operationId: intent.operationId,
    idempotencyKey: intent.idempotencyKey,
    intentDigest: intent.intentDigest,
    releaseId: intent.releaseId,
    sourceRevision: intent.sourceRevision,
    releaseVersion: intent.releaseVersion,
    releasePackCommit: commit.value.commitSha,
    releasePackTreeDigest: commit.value.treeDigest,
    pointerPackCommit: pointer.value.mainSha,
    pointerPackTreeDigest: pointer.value.mainStateDigest,
    tagName: intent.tagName,
    assets: assets as unknown as readonly [ReleaseAssetObservation, ReleaseAssetObservation],
    beforeControlManifestSnapshotDigest: intent.remote.beforeControlManifestSnapshotDigest,
    afterControlManifestSnapshotDigest: afterDigest,
    pointerObjectDigest: pointer.value.pointerObjectDigest,
    approver: intent.approvals.planned.approver,
    nonces: Object.freeze(
      Object.fromEntries(
        Object.entries(intent.approvals).map(([key, value]) => [key, value.nonce]),
      ),
    ),
    durableExecutionStateDigest: ports.durableState.digest(),
    receiptDigest: "",
  };
  const receipt = Object.freeze({ ...unsigned, receiptDigest: sha256(stable(unsigned)) });
  try {
    await ports.receipt.persist(receipt);
  } catch {
    return {
      status: "indeterminate",
      stage: "canary",
      reason: "receipt_persist_failed",
      remoteWrites: run.count(),
    };
  }
  let cleanup: "not_requested" | "complete" | "failed" = "not_requested";
  if (ports.cleanup) {
    try {
      await ports.cleanup.run();
      cleanup = "complete";
    } catch {
      cleanup = "failed";
    }
  }
  return { status: "published", receipt, remoteWrites: run.count(), cleanup };
}

export const executePackPublication = publishPackCanary;
