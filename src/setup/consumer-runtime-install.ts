import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parseNodeBootstrapReceiptBytes } from "../runtime/node-bootstrap.ts";
import {
  admitConsumerLocalRuntime,
  type ConsumerLocalRuntimeAdmission,
} from "./consumer-local-runtime-admission.ts";
import {
  type ConsumerNodeRuntimeIdentity,
  digestConsumerRuntimeBytes,
} from "./consumer-node-runtime.ts";
import type {
  ConsumerRuntimeReleaseInstallResult,
  SetupConsumerRuntimeInput,
  SetupResult,
} from "./consumer-runtime-contracts.ts";
import type { verifyConsumerRuntimeReleaseAssets } from "./consumer-runtime-release.ts";
import type { ConsumerRuntimePin } from "./consumer-worktree-runtime.ts";
import { cacheConsumerRuntimeRelease, mainWorktreeCommonDir } from "./consumer-worktree-runtime.ts";
import type { ReleaseChannelAttestation } from "./release-channel-adapter.ts";

export function consumerReleaseAttestation(
  document: ReturnType<typeof verifyConsumerRuntimeReleaseAssets>["document"],
): Extract<ReleaseChannelAttestation, { status: "attested" }> {
  const raw = document.admission_input.aggregate_input.attestation;
  return {
    status: "attested",
    releaseId: raw.releaseId,
    artifactSourceCommit: raw.artifactSourceCommit,
    expectedDigest: raw.expectedDigest,
    actualDigest: raw.actualDigest,
    entries: raw.entries.map((entry) => ({
      path: entry.path,
      mode: entry.mode,
      content: Buffer.from(entry.content_base64, "base64"),
    })),
  };
}

export function cacheAlreadyInstalledRuntime(input: {
  readonly consumerRoot: string;
  readonly releaseDirectory: string;
  readonly releaseId: string;
  readonly tag: string;
  readonly expectedConsumerDigest: string;
  readonly executingModulePath: string;
  readonly expectedPin: ConsumerRuntimePin;
}): ConsumerRuntimeReleaseInstallResult {
  const commonDir = mainWorktreeCommonDir(input.consumerRoot);
  if (!commonDir) return { status: "already-installed" };
  return { status: "already-installed", ...cacheConsumerRuntimeRelease({ ...input, commonDir }) };
}

export function sameCanonicalSetupPath(left: string, right: string): boolean {
  try {
    return canonicalSetupPath(left) === canonicalSetupPath(right);
  } catch {
    return false;
  }
}

function canonicalSetupPath(path: string): string {
  let current = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new Error("consumer_runtime_external_path");
    suffix.unshift(basename(current));
    current = parent;
  }
  return resolve(realpathSync.native(current), ...suffix);
}

export function createSetupConsumerRuntimeInput(input: {
  readonly identity: ConsumerNodeRuntimeIdentity;
  readonly admission: ConsumerLocalRuntimeAdmission;
  readonly compiledEsm: Uint8Array;
  readonly nodeBootstrapReceipt: Uint8Array;
}): SetupConsumerRuntimeInput {
  return {
    identity: input.identity,
    admission: input.admission,
    compiled_esm: input.compiledEsm,
    node_bootstrap_receipt: input.nodeBootstrapReceipt,
  };
}

import type { SealedReleaseAggregatePlan } from "./release-aggregate-admission.ts";

export function parseConsumerRuntimeReceipt(input: {
  readonly receiptBytes: Uint8Array;
  readonly tag: string;
  readonly generationId: string;
}): {
  readonly receipt: ReturnType<typeof parseNodeBootstrapReceiptBytes>;
  readonly operationId: string;
} {
  let receipt: ReturnType<typeof parseNodeBootstrapReceiptBytes>;
  try {
    receipt = parseNodeBootstrapReceiptBytes(input.receiptBytes);
  } catch {
    throw new Error("consumer_runtime_node_receipt_invalid");
  }
  const operationId = `packrt-${digestConsumerRuntimeBytes(
    Buffer.from(`${input.tag}\0${input.generationId}`, "utf8"),
  ).slice(7, 31)}`;
  return { receipt, operationId };
}

export function admitConsumerRuntimeIdentity(input: {
  readonly productId: string;
  readonly consumerRoot: string;
  readonly runtimeRoot: string;
  readonly operationId: string;
  readonly releaseId: string;
  readonly sourceRevision: string;
  readonly materializerVersion: string;
  readonly generationId: string;
  readonly subjectRevision: string;
  readonly artifactSetDigest: string;
  readonly compiledEsmDigest: string;
  readonly compiledCliDigest: string;
  readonly nodeVersion: string;
  readonly nodeDigest: string;
  readonly packageLockDigest: string;
  readonly sourceGraphDigest: string;
  readonly controlManifestBytes: Uint8Array;
  readonly plan: SealedReleaseAggregatePlan;
}): {
  readonly admission: ConsumerLocalRuntimeAdmission;
  readonly identity: ConsumerNodeRuntimeIdentity;
} {
  const artifactIdentity = {
    materializerVersion: input.materializerVersion,
    releaseId: input.releaseId,
    sourceRevision: input.sourceRevision,
    artifactSetDigest: input.artifactSetDigest,
  };
  const admissionResult = admitConsumerLocalRuntime({
    productId: input.productId,
    consumerRoot: input.consumerRoot,
    runtimeRoot: input.runtimeRoot,
    plan: input.plan,
    manifest: artifactIdentity,
    receipt: {
      ...artifactIdentity,
      productId: input.productId,
      consumerRoot: input.consumerRoot,
      runtimeRoot: input.runtimeRoot,
    },
    controlManifestBytes: input.controlManifestBytes,
  });
  if (!admissionResult.ok)
    throw new Error(`consumer_runtime_release_admission_${admissionResult.error}`);
  return {
    admission: admissionResult.admission,
    identity: {
      product_id: input.productId,
      consumer_root: input.consumerRoot,
      runtime_root: input.runtimeRoot,
      operation_id: input.operationId,
      attempt: 1,
      generation_id: input.generationId,
      subject_revision: input.subjectRevision,
      artifact_digest: `sha256:${input.compiledCliDigest}`,
      node_executable_identity: `node-${input.nodeVersion}|sha256:${input.nodeDigest}`,
      package_lock_digest: `sha256:${input.packageLockDigest}`,
      source_graph_digest: `sha256:${input.sourceGraphDigest}`,
      compiled_esm_digest: input.compiledEsmDigest,
      release_id: input.releaseId,
      materializer_version: input.materializerVersion,
      artifact_set_digest: input.artifactSetDigest,
      control_manifest_digest: admissionResult.admission.controlManifestSnapshotDigest,
      sealed_policy: "compiled-esm-only",
    },
  };
}

export async function completeConsumerRuntimeInstallation(input: {
  readonly consumerRoot: string;
  readonly releaseDirectory: string;
  readonly releaseId: string;
  readonly tag: string;
  readonly expectedConsumerDigest: string;
  readonly executingModulePath: string;
  readonly setup: () => Promise<SetupResult>;
  readonly expectedPin: ConsumerRuntimePin;
}): Promise<ConsumerRuntimeReleaseInstallResult> {
  const setup = await input.setup();
  const runtimeInstall = setup.consumerRuntime?.result;
  if (!runtimeInstall?.ok)
    throw new Error(
      runtimeInstall && !runtimeInstall.ok
        ? runtimeInstall.reason
        : "consumer_runtime_install_failed",
    );
  const commonDir = mainWorktreeCommonDir(input.consumerRoot);
  if (!commonDir) return { status: "installed", setup };
  const cache = cacheConsumerRuntimeRelease({
    commonDir,
    releaseDirectory: input.releaseDirectory,
    releaseId: input.releaseId,
    tag: input.tag,
    expectedConsumerDigest: input.expectedConsumerDigest,
    executingModulePath: input.executingModulePath,
    expectedPin: input.expectedPin,
  });
  if (!cache.cacheWarning) return { status: "installed", setup };
  return {
    status: "installed",
    setup: {
      ...setup,
      notices: [...(setup.notices ?? []), cache.cacheWarning],
    },
  };
}
