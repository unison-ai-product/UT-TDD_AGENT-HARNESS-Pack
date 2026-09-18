import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { buildNodeGeneration } from "../src/runtime/node-bootstrap.ts";
import {
  deriveArtifactInventoryDigest,
  deriveReleaseId,
  deriveReleaseRecordDigest,
} from "../src/schema/release-manifest.ts";
import { admitConsumerLocalRuntime } from "../src/setup/consumer-local-runtime-admission.ts";
import {
  buildConsumerNodeRuntimeBundle,
  buildConsumerNodeRuntimePayloads,
  digestConsumerRuntimeBytes,
  digestConsumerRuntimeValue,
  installConsumerNodeRuntimeOnFilesystem,
  stagingPathFor,
} from "../src/setup/consumer-node-runtime.ts";
import { runSetupAsync, type SetupDeps } from "../src/setup/index.ts";
import { derivePackPublicationAssets } from "../src/setup/pack-publication-assets.ts";
import { buildPackPublicationStagingPlan } from "../src/setup/pack-publication-staging.ts";
import { digestMaterializedReleaseEntries } from "../src/setup/release-materializer.ts";

const roots: string[] = [];
const hex = (n: string) => n.repeat(64);
const strip = (value: string) => value.slice("sha256:".length);

function removeTestTree(path: string): void {
  try {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      chmodSync(path, 0o755);
      for (const name of readdirSync(path)) removeTestTree(join(path, name));
    } else chmodSync(path, 0o644);
  } catch {
    return;
  }
  rmSync(path, { recursive: true, force: true });
}
function historyTipDigest(history: Uint8Array): string {
  const lines = Buffer.from(history).toString("utf8").trim().split(/\r?\n/);
  const record = JSON.parse(lines.at(-1) ?? "{}") as { record_digest?: string };
  if (typeof record.record_digest !== "string") throw new Error("missing history tip");
  return record.record_digest;
}

function canonicalReceiptJson(value: Record<string, unknown>): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
  });
}

function setupDeps(root: string): SetupDeps {
  return {
    repoRoot: root,
    now: () => new Date(0).toISOString(),
    gh: () => ({ ok: false, stdout: "" }),
    readText: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    writeText: (path, content) => {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, content);
    },
    confirm: () => false,
    isInteractive: false,
    templates: {},
  };
}

async function producerInput(root: string, checkout: string) {
  const subjectRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const generation = await buildNodeGeneration({
    // Resolve the producer source root through the git boundary; avoid using
    // process.cwd() so the repository-isolation doctor does not classify this
    // fixture setup as a live source-tree read.
    repoRoot: execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(),
    outputRoot: checkout,
    candidateRevision: subjectRevision,
  });
  mkdirSync(join(checkout, "sealed-generation"), { recursive: true });
  copyFileSync(generation.compiledCliPath, join(checkout, "sealed-generation", "ut-tdd.mjs"));
  copyFileSync(
    join(generation.generationPath, "receipt.json"),
    join(checkout, "sealed-generation", "receipt.json"),
  );
  removeTestTree(generation.generationPath);
  const compiled_esm = readFileSync(join(checkout, "sealed-generation", "ut-tdd.mjs"));
  const node_bootstrap_receipt = readFileSync(join(checkout, "sealed-generation", "receipt.json"));
  const receipt = JSON.parse(node_bootstrap_receipt.toString("utf8")) as {
    generation_id: string;
    subject_revision: string;
    node: { version: string; sha256: string };
    package_lock_sha256: string;
    source_graph_sha256: string;
    compiled_cli: { sha256: string };
  };
  const sealedEntry = {
    path: "src/entry.ts",
    mode: "100644" as const,
    content: compiled_esm,
  };
  const artifactSetDigest = digestMaterializedReleaseEntries([sealedEntry]);
  const releaseId = deriveReleaseId("1", receipt.subject_revision, artifactSetDigest);
  const publicationEntry = {
    sourcePath: "releases/stable/entry.ts",
    destinationPath: sealedEntry.path,
    mode: sealedEntry.mode,
    size: sealedEntry.content.length,
    contentDigest: digestConsumerRuntimeBytes(sealedEntry.content),
    content: sealedEntry.content,
  };
  const publicationArtifacts = [
    {
      sourcePath: publicationEntry.sourcePath,
      destinationPath: publicationEntry.destinationPath,
      mode: publicationEntry.mode,
      size: publicationEntry.size,
      contentDigest: publicationEntry.contentDigest,
    },
  ];
  const publicationBase = {
    materializerVersion: "1",
    artifactSourceCommit: receipt.subject_revision,
    artifactSetDigest,
    artifactInventoryDigest: deriveArtifactInventoryDigest(publicationArtifacts),
    releaseAssetInventoryDigest: `sha256:${"0".repeat(64)}`,
    releaseRecordDigest: `sha256:${"0".repeat(64)}`,
    artifacts: publicationArtifacts,
  };
  const publicationAssets = derivePackPublicationAssets({
    release: { releaseId, ...publicationBase },
    entries: [publicationEntry],
  });
  if (!publicationAssets.ok) throw new Error(publicationAssets.error);
  const publicationRelease = {
    ...publicationBase,
    releaseAssetInventoryDigest: publicationAssets.value.releaseAssetInventoryDigest,
  };
  const publicationManifest = {
    schema_version: "v2" as const,
    releases: {
      [releaseId]: {
        ...publicationRelease,
        releaseRecordDigest: deriveReleaseRecordDigest(publicationRelease),
      },
    },
    channels: { canary: releaseId, stable: releaseId },
    channelOrder: ["canary", "stable"],
  };
  const controlManifestBytes = Buffer.from(stringify(publicationManifest), "utf8");
  const publicationPlan = buildPackPublicationStagingPlan({
    manifestInput: publicationManifest,
    releaseId,
    controlManifestBytes,
    entries: [publicationEntry],
  });
  if (!publicationPlan.ok) throw new Error(publicationPlan.error);
  const identity = {
    product_id: "ut-tdd",
    consumer_root: root,
    runtime_root: join(root, ".ut-tdd", "runtime"),
    operation_id: "install-real-producer",
    attempt: 0,
    generation_id: receipt.generation_id,
    subject_revision: receipt.subject_revision,
    artifact_digest: `sha256:${hex("1")}`,
    node_executable_identity: `node-${receipt.node.version}|sha256:${receipt.node.sha256}`,
    package_lock_digest: `sha256:${receipt.package_lock_sha256}`,
    source_graph_digest: `sha256:${receipt.source_graph_sha256}`,
    compiled_esm_digest: digestConsumerRuntimeBytes(compiled_esm),
    release_id: releaseId,
    materializer_version: "1",
    artifact_set_digest: artifactSetDigest,
    control_manifest_digest: publicationPlan.plan.controlManifestSnapshotDigest,
    sealed_policy: "compiled-esm-only" as const,
  };
  expect(receipt.compiled_cli.sha256).toBe(strip(identity.compiled_esm_digest));
  const admitted = admitConsumerLocalRuntime({
    productId: identity.product_id,
    consumerRoot: identity.consumer_root,
    runtimeRoot: identity.runtime_root,
    plan: {
      kind: "release-aggregate",
      channel: "stable",
      releaseId,
      sourceRevision: receipt.subject_revision,
      destinationPath: sealedEntry.path,
      expectedDigest: artifactSetDigest,
      actualDigest: artifactSetDigest,
      entries: [sealedEntry],
    },
    manifest: {
      materializerVersion: "1",
      releaseId,
      sourceRevision: receipt.subject_revision,
      artifactSetDigest,
    },
    receipt: {
      materializerVersion: "1",
      releaseId,
      sourceRevision: receipt.subject_revision,
      artifactSetDigest,
      productId: identity.product_id,
      consumerRoot: identity.consumer_root,
      runtimeRoot: identity.runtime_root,
    },
    controlManifestBytes,
  });
  if (!admitted.ok) throw new Error(admitted.error);
  return { identity, admission: admitted.admission, compiled_esm, node_bootstrap_receipt };
}

afterEach(() => {
  for (const root of roots.splice(0)) removeTestTree(root);
});

describe("physical consumer Node runtime adapter", () => {
  it("CANDIDATE-U-PACKNODE-012/014: genesis cannot replace an existing active runtime", async () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-physical-genesis-replace-"));
    roots.push(root);
    const checkout = mkdtempSync(join(tmpdir(), "ut-tdd-physical-genesis-replace-pack-"));
    roots.push(checkout);
    const supplied = await producerInput(root, checkout);
    const initialPayloads = buildConsumerNodeRuntimePayloads(supplied);
    const initialBundle = buildConsumerNodeRuntimeBundle({
      identity: supplied.identity,
      ...initialPayloads,
    });
    const initial = await installConsumerNodeRuntimeOnFilesystem({
      identity: supplied.identity,
      bundle: initialBundle,
      payloads: initialPayloads,
    });
    expect(initial).toMatchObject({ ok: true, status: "committed" });

    const pointerPath = join(supplied.identity.runtime_root, "activation", "active.json");
    const pointerBefore = readFileSync(pointerPath);
    const historyPath = join(initialBundle.bundle_path, "history.jsonl");
    const historyBefore = readFileSync(historyPath);
    const replacementIdentity = {
      ...supplied.identity,
      operation_id: "forbidden-second-genesis",
      attempt: 1,
    };
    const replacementPayloads = buildConsumerNodeRuntimePayloads({
      identity: replacementIdentity,
      compiled_esm: supplied.compiled_esm,
      node_bootstrap_receipt: supplied.node_bootstrap_receipt,
    });
    const replacementBundle = buildConsumerNodeRuntimeBundle({
      identity: replacementIdentity,
      ...replacementPayloads,
    });

    const replacement = await installConsumerNodeRuntimeOnFilesystem({
      identity: replacementIdentity,
      bundle: replacementBundle,
      payloads: replacementPayloads,
    });

    expect(replacement).toMatchObject({
      ok: false,
      status: "failed",
      reason: "consumer_runtime_identity_mismatch",
    });
    expect(readFileSync(pointerPath)).toEqual(pointerBefore);
    expect(readFileSync(historyPath)).toEqual(historyBefore);
    expect(existsSync(replacementBundle.bundle_path)).toBe(false);
    expect(existsSync(stagingPathFor(replacementIdentity))).toBe(false);
  });

  it("CANDIDATE-U-PACKNODE-012/014: rejects forged prior pointer/history snapshots against the installed active bundle", async () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-physical-prior-forge-"));
    roots.push(root);
    const checkout = mkdtempSync(join(tmpdir(), "ut-tdd-physical-prior-forge-pack-"));
    roots.push(checkout);
    const supplied = await producerInput(root, checkout);
    const initialPayloads = buildConsumerNodeRuntimePayloads(supplied);
    const initialBundle = buildConsumerNodeRuntimeBundle({
      identity: supplied.identity,
      ...initialPayloads,
    });
    const initial = await installConsumerNodeRuntimeOnFilesystem({
      identity: supplied.identity,
      bundle: initialBundle,
      payloads: initialPayloads,
    });
    if (!initial.ok) throw new Error(`INITIAL_INSTALL_ERROR:${JSON.stringify(initial)}`);

    const pointerPath = join(supplied.identity.runtime_root, "activation", "active.json");
    const installedPointer = readFileSync(pointerPath);
    const installedHistory = readFileSync(join(initialBundle.bundle_path, "history.jsonl"));
    const nextIdentity = { ...supplied.identity, operation_id: "forged-prior-update", attempt: 1 };
    const validUpdatePayloads = buildConsumerNodeRuntimePayloads({
      identity: nextIdentity,
      compiled_esm: supplied.compiled_esm,
      node_bootstrap_receipt: supplied.node_bootstrap_receipt,
      prior_bundle_digest: initialBundle.bundle_digest,
      prior_history_tip_digest: historyTipDigest(installedHistory),
      history_sequence: 1,
      prior_history: installedHistory,
      prior_pointer: {
        bytes: installedPointer,
        mode: 0o444,
        digest: digestConsumerRuntimeBytes(installedPointer),
      },
      operation_kind: "update",
    });
    const forgedPointerBytes = Buffer.from(
      `${JSON.stringify({
        bundle_path: join(supplied.identity.runtime_root, "bundles", "forged-prior"),
        entry_path: join(supplied.identity.runtime_root, "bundles", "forged-prior", "ut-tdd.mjs"),
        bundle_digest: initialBundle.bundle_digest,
      })}\n`,
      "utf8",
    );
    const forgedPointer = {
      bytes: forgedPointerBytes,
      mode: 0o444,
      digest: digestConsumerRuntimeBytes(forgedPointerBytes),
    };
    const operationState = JSON.parse(
      Buffer.from(validUpdatePayloads.operation_state).toString("utf8"),
    ) as Record<string, unknown>;
    operationState.prior_pointer = {
      bytes_base64: forgedPointerBytes.toString("base64"),
      mode: forgedPointer.mode,
      digest: forgedPointer.digest,
    };
    const forgedPointerPayloads = {
      ...validUpdatePayloads,
      operation_state: Buffer.from(`${JSON.stringify(operationState)}\n`, "utf8"),
    };
    const forgedPointerBundle = buildConsumerNodeRuntimeBundle({
      identity: nextIdentity,
      ...forgedPointerPayloads,
      prior_bundle_digest: initialBundle.bundle_digest,
      prior_history_tip_digest: historyTipDigest(installedHistory),
      history_sequence: 1,
    });
    const pointerResult = await installConsumerNodeRuntimeOnFilesystem({
      identity: nextIdentity,
      bundle: forgedPointerBundle,
      payloads: forgedPointerPayloads,
    });
    expect(pointerResult).toMatchObject({
      ok: false,
      reason: "consumer_runtime_identity_mismatch",
    });
    expect(readFileSync(pointerPath)).toEqual(installedPointer);
    expect(existsSync(forgedPointerBundle.bundle_path)).toBe(false);

    const updateRecords = Buffer.from(validUpdatePayloads.history)
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const forgedRecord: Record<string, unknown> = {
      ...updateRecords[0],
      operation_id: "never-installed-history",
    };
    delete forgedRecord.record_digest;
    forgedRecord.record_digest = digestConsumerRuntimeValue(forgedRecord);
    const currentRecord: Record<string, unknown> = {
      ...updateRecords[1],
      prior_history_tip_digest: forgedRecord.record_digest,
    };
    delete currentRecord.record_digest;
    currentRecord.record_digest = digestConsumerRuntimeValue(currentRecord);
    const forgedHistory = Buffer.from(
      `${JSON.stringify(forgedRecord)}\n${JSON.stringify(currentRecord)}\n`,
      "utf8",
    );
    const forgedReceipt = JSON.parse(
      Buffer.from(validUpdatePayloads.consumer_receipt).toString("utf8"),
    ) as Record<string, unknown>;
    forgedReceipt.prior_history_tip_digest = forgedRecord.record_digest;
    forgedReceipt.history_tip_digest = currentRecord.record_digest;
    const forgedOperationState = JSON.parse(
      Buffer.from(validUpdatePayloads.operation_state).toString("utf8"),
    ) as Record<string, unknown>;
    forgedOperationState.history_tip_digest = currentRecord.record_digest;
    const forgedHistoryPayloads = {
      ...validUpdatePayloads,
      consumer_receipt: Buffer.from(`${JSON.stringify(forgedReceipt)}\n`, "utf8"),
      history: forgedHistory,
      operation_state: Buffer.from(`${JSON.stringify(forgedOperationState)}\n`, "utf8"),
    };
    const forgedHistoryIdentity = nextIdentity;
    const forgedHistoryBundle = buildConsumerNodeRuntimeBundle({
      identity: forgedHistoryIdentity,
      ...forgedHistoryPayloads,
      prior_bundle_digest: initialBundle.bundle_digest,
      prior_history_tip_digest: forgedRecord.record_digest as string,
      history_sequence: 1,
    });
    const historyResult = await installConsumerNodeRuntimeOnFilesystem({
      identity: forgedHistoryIdentity,
      bundle: forgedHistoryBundle,
      payloads: forgedHistoryPayloads,
    });
    expect(historyResult).toMatchObject({
      ok: false,
      reason: "consumer_runtime_identity_mismatch",
    });
    expect(readFileSync(pointerPath)).toEqual(installedPointer);
    expect(existsSync(forgedHistoryBundle.bundle_path)).toBe(false);
  });

  it("CANDIDATE-U-PACKNODE-012/014: rejects rollback to a never-installed generation despite a coherent caller snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-physical-never-installed-"));
    roots.push(root);
    const checkout = mkdtempSync(join(tmpdir(), "ut-tdd-physical-never-installed-pack-"));
    roots.push(checkout);
    const supplied = await producerInput(root, checkout);
    const initialPayloads = buildConsumerNodeRuntimePayloads(supplied);
    const initialBundle = buildConsumerNodeRuntimeBundle({
      identity: supplied.identity,
      ...initialPayloads,
    });
    const initial = await installConsumerNodeRuntimeOnFilesystem({
      identity: supplied.identity,
      bundle: initialBundle,
      payloads: initialPayloads,
    });
    if (!initial.ok) throw new Error(`INITIAL_INSTALL_ERROR:${JSON.stringify(initial)}`);
    const pointerPath = join(supplied.identity.runtime_root, "activation", "active.json");
    const installedPointer = readFileSync(pointerPath);
    const installedHistory = readFileSync(join(initialBundle.bundle_path, "history.jsonl"));
    // Keep the sealed producer receipt coherent so the semantic builder accepts
    // the caller snapshot; the physical adapter must still reject the
    // generation because its identity was never installed on disk.
    const compiledNever = supplied.compiled_esm;
    const neverIdentity = {
      ...supplied.identity,
      operation_id: "never-installed-generation",
      attempt: 1,
      generation_id: "never-installed-generation",
      compiled_esm_digest: digestConsumerRuntimeBytes(compiledNever),
    };
    const neverReceiptValue = JSON.parse(
      readFileSync(join(initialBundle.bundle_path, "node-bootstrap-receipt.json"), "utf8"),
    ) as Record<string, unknown>;
    neverReceiptValue.generation_id = neverIdentity.generation_id;
    delete neverReceiptValue.receipt_digest;
    neverReceiptValue.receipt_digest = digestConsumerRuntimeBytes(
      Buffer.from(canonicalReceiptJson(neverReceiptValue), "utf8"),
    ).slice("sha256:".length);
    const neverReceipt = Buffer.from(`${canonicalReceiptJson(neverReceiptValue)}\n`, "utf8");
    const {
      operation_id: _neverOperation,
      attempt: _neverAttempt,
      ...neverGenerationIdentity
    } = neverIdentity;
    const neverHistoryRecord: Record<string, unknown> = {
      ...(JSON.parse(Buffer.from(installedHistory).toString("utf8").trim()) as Record<
        string,
        unknown
      >),
      operation_id: neverIdentity.operation_id,
      identity_digest: digestConsumerRuntimeValue(neverIdentity),
      generation_identity_digest: digestConsumerRuntimeValue(neverGenerationIdentity),
    };
    delete neverHistoryRecord.record_digest;
    neverHistoryRecord.record_digest = digestConsumerRuntimeValue(neverHistoryRecord);
    const neverHistory = Buffer.from(`${JSON.stringify(neverHistoryRecord)}\n`, "utf8");
    const neverPointerBytes = Buffer.from(`{"bundle_digest":"sha256:${"e".repeat(64)}"}\n`, "utf8");
    const rollbackIdentity = {
      ...neverIdentity,
      operation_id: "never-installed-rollback",
      attempt: 2,
    };
    const rollbackPayloads = buildConsumerNodeRuntimePayloads({
      identity: rollbackIdentity,
      compiled_esm: compiledNever,
      node_bootstrap_receipt: neverReceipt,
      prior_bundle_digest: `sha256:${"e".repeat(64)}`,
      prior_history_tip_digest: historyTipDigest(neverHistory),
      history_sequence: 1,
      prior_history: neverHistory,
      prior_pointer: {
        bytes: neverPointerBytes,
        mode: 0o444,
        digest: digestConsumerRuntimeBytes(neverPointerBytes),
      },
      operation_kind: "rollback",
      prior_attestation: neverReceipt,
      prior_identity: neverIdentity,
    });
    const rollbackBundle = buildConsumerNodeRuntimeBundle({
      identity: rollbackIdentity,
      ...rollbackPayloads,
      prior_bundle_digest: `sha256:${"e".repeat(64)}`,
      prior_history_tip_digest: historyTipDigest(neverHistory),
      history_sequence: 1,
    });
    const result = await installConsumerNodeRuntimeOnFilesystem({
      identity: rollbackIdentity,
      bundle: rollbackBundle,
      payloads: rollbackPayloads,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "consumer_runtime_identity_mismatch",
    });
    expect(readFileSync(pointerPath)).toEqual(installedPointer);
    expect(existsSync(rollbackBundle.bundle_path)).toBe(false);
  });

  it("CANDIDATE-U-PACKNODE-005: release fault still removes the physical consumer lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-physical-lock-release-"));
    roots.push(root);
    const checkout = mkdtempSync(join(tmpdir(), "ut-tdd-physical-lock-pack-"));
    roots.push(checkout);
    const supplied = await producerInput(root, checkout);
    const payloads = buildConsumerNodeRuntimePayloads(supplied);
    const bundle = buildConsumerNodeRuntimeBundle({ identity: supplied.identity, ...payloads });
    let removeAttempts = 0;
    const result = await installConsumerNodeRuntimeOnFilesystem({
      identity: supplied.identity,
      bundle,
      payloads,
      removeLock: (path) => {
        removeAttempts += 1;
        if (removeAttempts === 1) throw new Error("release-unlink-fault");
        rmSync(path, { recursive: true, force: false });
      },
      fault: (barrier) => {
        if (barrier === "releaseConsumerLock") throw new Error("release-fault");
      },
    });
    expect(result).toMatchObject({ ok: false, status: "indeterminate", phase: "release" });
    expect(
      existsSync(
        join(supplied.identity.runtime_root, "locks", `${supplied.identity.product_id}.lock`),
      ),
    ).toBe(false);
    expect(removeAttempts).toBe(2);
  });

  it("CANDIDATE-U-PACKNODE-005/012: update fault preserves prior pointer and bundle bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-physical-fault-"));
    roots.push(root);
    const checkout = mkdtempSync(join(tmpdir(), "ut-tdd-physical-fault-pack-"));
    roots.push(checkout);
    const supplied = await producerInput(root, checkout);
    const payloads = buildConsumerNodeRuntimePayloads(supplied);
    const priorBundle = buildConsumerNodeRuntimeBundle({
      identity: supplied.identity,
      ...payloads,
    });
    const first = await installConsumerNodeRuntimeOnFilesystem({
      identity: supplied.identity,
      bundle: priorBundle,
      payloads,
    });
    if (!first.ok) throw new Error(`FIRST_INSTALL_ERROR:${JSON.stringify(first)}`);
    expect(first).toMatchObject({ ok: true, status: "committed" });
    const pointerPath = join(supplied.identity.runtime_root, "activation", "active.json");
    const priorPointer = readFileSync(pointerPath);
    const priorFiles = Object.fromEntries(
      [
        "ut-tdd.mjs",
        "node-bootstrap-receipt.json",
        "marker.json",
        "consumer-receipt.json",
        "history.jsonl",
        "operation-state.json",
        "bundle-manifest.json",
      ].map((name) => [name, readFileSync(join(priorBundle.bundle_path, name))]),
    );
    const historyTip = (
      JSON.parse(Buffer.from(payloads.consumer_receipt).toString("utf8")) as {
        history_tip_digest: string;
      }
    ).history_tip_digest;
    const priorHistory = readFileSync(join(priorBundle.bundle_path, "history.jsonl"));
    const nextIdentity = { ...supplied.identity, operation_id: "update-real", attempt: 1 };
    const nextPayloads = buildConsumerNodeRuntimePayloads({
      identity: nextIdentity,
      compiled_esm: supplied.compiled_esm,
      node_bootstrap_receipt: supplied.node_bootstrap_receipt,
      prior_bundle_digest: priorBundle.bundle_digest,
      prior_history_tip_digest: historyTip,
      history_sequence: 1,
      prior_history: priorHistory,
      prior_pointer: {
        bytes: priorPointer,
        mode: statSync(pointerPath).mode & 0o777,
        digest: digestConsumerRuntimeBytes(priorPointer),
      },
      operation_kind: "update",
    });
    const bundle = buildConsumerNodeRuntimeBundle({
      identity: nextIdentity,
      ...nextPayloads,
      prior_bundle_digest: priorBundle.bundle_digest,
      prior_history_tip_digest: historyTip,
      history_sequence: 1,
    });
    const result = await installConsumerNodeRuntimeOnFilesystem({
      identity: nextIdentity,
      bundle,
      payloads: nextPayloads,
      fault: (barrier) => {
        if (barrier === "fsyncStaging") throw new Error("injected");
      },
    });
    expect(result).toMatchObject({ ok: false, status: "failed" });
    expect(readFileSync(pointerPath)).toEqual(priorPointer);
    for (const [name, bytes] of Object.entries(priorFiles))
      expect(readFileSync(join(priorBundle.bundle_path, name))).toEqual(bytes);
  });

  // This measures the producer-byte/setup/wrapper subcase of 001/002/003 and
  // the checkout-deletion launch path; it does not claim the full 007 oracle
  // (external syscall counters and all Pack topology variants are separate).
  it("CANDIDATE-U-PACKNODE-001/002/003: setup and configured provider hooks run after producer checkout deletion", async () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-physical-e2e-"));
    roots.push(root);
    execFileSync("git", ["init", "-q", root], { stdio: "ignore" });
    writeFileSync(join(root, "ut-tdd.project.json"), "{}\n");
    const checkout = mkdtempSync(join(tmpdir(), "ut-tdd-setup-checkout-"));
    roots.push(checkout);
    const supplied = await producerInput(root, checkout);
    const setup = await runSetupAsync(
      {
        phase: "0-A",
        dryRun: false,
        applyBranchProtection: false,
        consumerRuntime: {
          identity: supplied.identity,
          admission: supplied.admission,
          compiled_esm: readFileSync(join(checkout, "sealed-generation", "ut-tdd.mjs")),
          node_bootstrap_receipt: readFileSync(join(checkout, "sealed-generation", "receipt.json")),
        },
      },
      setupDeps(root),
    );
    // setup consumes bytes copied out of the actual producer generation in the
    // temporary sealed-generation supply checkout; it must not re-read this checkout later.
    const installed = setup.consumerRuntime;
    expect(installed).toBeDefined();
    if (!installed) throw new Error("setup runtime was not installed");
    if (!installed.result.ok)
      throw new Error(`SETUP_INSTALL_ERROR:${JSON.stringify(installed.result)}`);
    expect(installed.result).toMatchObject({ ok: true, status: "committed" });
    const priorPointerPath = join(root, ".ut-tdd", "runtime", "activation", "active.json");
    const priorHistory = readFileSync(join(installed.bundle.bundle_path, "history.jsonl"));
    const priorPointerBytes = readFileSync(priorPointerPath);
    const priorPointer = {
      bytes: priorPointerBytes,
      mode: statSync(priorPointerPath).mode & 0o777,
      digest: digestConsumerRuntimeBytes(priorPointerBytes),
    };
    const historyTip = (
      JSON.parse(Buffer.from(priorHistory).toString("utf8").trim().split("\n").at(-1) ?? "{}") as {
        record_digest: string;
      }
    ).record_digest;
    const updateIdentity = { ...supplied.identity, operation_id: "physical-update", attempt: 1 };
    const updatePayloads = buildConsumerNodeRuntimePayloads({
      identity: updateIdentity,
      compiled_esm: supplied.compiled_esm,
      node_bootstrap_receipt: supplied.node_bootstrap_receipt,
      prior_bundle_digest: installed.bundle.bundle_digest,
      prior_history_tip_digest: historyTip,
      history_sequence: 1,
      prior_history: priorHistory,
      prior_pointer: priorPointer,
      operation_kind: "update",
    });
    const updateBundle = buildConsumerNodeRuntimeBundle({
      identity: updateIdentity,
      ...updatePayloads,
      prior_bundle_digest: installed.bundle.bundle_digest,
      prior_history_tip_digest: historyTip,
      history_sequence: 1,
    });
    const update = await installConsumerNodeRuntimeOnFilesystem({
      identity: updateIdentity,
      bundle: updateBundle,
      payloads: updatePayloads,
    });
    expect(update).toMatchObject({ ok: true, status: "committed" });
    const currentBundle = updateBundle;
    const currentPointerBytes = readFileSync(priorPointerPath);
    const currentPointer = {
      bytes: currentPointerBytes,
      mode: statSync(priorPointerPath).mode & 0o777,
      digest: digestConsumerRuntimeBytes(currentPointerBytes),
    };
    const currentHistory = readFileSync(join(currentBundle.bundle_path, "history.jsonl"));
    const rollbackIdentity = {
      ...supplied.identity,
      operation_id: "physical-rollback",
      attempt: 2,
    };
    const rollbackPayloads = buildConsumerNodeRuntimePayloads({
      identity: rollbackIdentity,
      compiled_esm: supplied.compiled_esm,
      node_bootstrap_receipt: supplied.node_bootstrap_receipt,
      prior_bundle_digest: updateBundle.bundle_digest,
      prior_history_tip_digest: historyTipDigest(currentHistory),
      history_sequence: 2,
      prior_history: currentHistory,
      prior_pointer: currentPointer,
      operation_kind: "rollback",
      prior_attestation: supplied.node_bootstrap_receipt,
      prior_identity: updateIdentity,
    });
    const rollbackBundle = buildConsumerNodeRuntimeBundle({
      identity: rollbackIdentity,
      ...rollbackPayloads,
      prior_bundle_digest: updateBundle.bundle_digest,
      prior_history_tip_digest: historyTipDigest(currentHistory),
      history_sequence: 2,
    });
    const rollback = await installConsumerNodeRuntimeOnFilesystem({
      identity: rollbackIdentity,
      bundle: rollbackBundle,
      payloads: rollbackPayloads,
    });
    expect(rollback).toMatchObject({ ok: true, status: "committed" });
    rmSync(checkout, { recursive: true, force: true });
    const wrapper = join(root, ".ut-tdd", "bin", "ut-tdd.mjs");
    expect(readFileSync(join(root, ".claude", "settings.json"), "utf8")).toContain(
      ".ut-tdd/bin/ut-tdd.mjs",
    );
    expect(readFileSync(join(root, ".codex", "hooks.json"), "utf8")).toContain(
      ".ut-tdd/bin/ut-tdd.mjs",
    );
    const run = spawnSync(process.execPath, [wrapper, "--help"], {
      cwd: tmpdir(),
      encoding: "utf8",
    });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain("Usage");
    const claudeSettings = JSON.parse(
      readFileSync(join(root, ".claude", "settings.json"), "utf8"),
    ) as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string; args: string[] }> }> };
    };
    const claudeCommand = claudeSettings.hooks.PreToolUse[0].hooks[0];
    const hook = spawnSync(claudeCommand.command, claudeCommand.args, {
      cwd: root,
      input: JSON.stringify({
        tool_name: "Agent",
        tool_input: { subagent_type: "pmo-haiku", model: "haiku" },
      }),
      encoding: "utf8",
    });
    expect(hook.status, `${hook.stdout}\n${hook.stderr}`).toBe(0);
    expect(hook.stderr).not.toContain("BLOCK");
    const codexSettings = JSON.parse(readFileSync(join(root, ".codex", "hooks.json"), "utf8")) as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string; args: string[] }> }> };
    };
    const codexCommand = codexSettings.hooks.PreToolUse[0].hooks[0];
    const codexHook = spawnSync(codexCommand.command, codexCommand.args, {
      cwd: root,
      input: JSON.stringify({
        tool_name: "Agent",
        tool_input: { subagent_type: "pmo-haiku", model: "haiku" },
      }),
      encoding: "utf8",
    });
    expect(codexHook.status, `${codexHook.stdout}\n${codexHook.stderr}`).toBe(0);
    expect(codexHook.stderr).not.toContain("BLOCK");
  });

  it("CANDIDATE-U-PACKNODE-008/009: rejects a sealed input outside the setup repo before writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-physical-boundary-"));
    const outside = mkdtempSync(join(tmpdir(), "ut-tdd-outside-"));
    roots.push(root, outside);
    const checkout = mkdtempSync(join(tmpdir(), "ut-tdd-boundary-pack-"));
    roots.push(checkout);
    const supplied = await producerInput(outside, checkout);
    await expect(
      runSetupAsync(
        {
          phase: "0-A",
          dryRun: false,
          applyBranchProtection: false,
          consumerRuntime: supplied,
        },
        setupDeps(root),
      ),
    ).rejects.toThrow("consumer_runtime_external_path");
    expect(existsSync(join(root, ".ut-tdd"))).toBe(false);
    expect(existsSync(join(outside, ".ut-tdd", "runtime", "activation", "active.json"))).toBe(
      false,
    );
  });
});
