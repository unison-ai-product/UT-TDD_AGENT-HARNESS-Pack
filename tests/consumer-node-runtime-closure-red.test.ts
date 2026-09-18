import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  deriveArtifactInventoryDigest,
  deriveReleaseId,
  deriveReleaseRecordDigest,
} from "../src/schema/release-manifest.ts";
import {
  admitConsumerLocalRuntime,
  type ConsumerLocalRuntimeAdmissionInput,
} from "../src/setup/consumer-local-runtime-admission.ts";
import {
  buildConsumerNodeRuntimePayloads,
  digestConsumerRuntimeBytes,
  digestConsumerRuntimeValue,
} from "../src/setup/consumer-node-runtime.ts";
import {
  runSetupAsync,
  type SetupConsumerRuntimeInput,
  type SetupDeps,
} from "../src/setup/index.ts";
import {
  derivePackPublicationAssets,
  type SealedPublicationEntry,
} from "../src/setup/pack-publication-assets.ts";
import { buildPackPublicationStagingPlan } from "../src/setup/pack-publication-staging.ts";
import { admitReleaseAggregate } from "../src/setup/release-aggregate-admission.ts";
import { digestMaterializedReleaseEntries } from "../src/setup/release-materializer.ts";

const roots: string[] = [];
const revision = "a".repeat(40);
const hex = (value: string) => value.repeat(64);

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
const historyTipDigest = (history: Uint8Array): string => {
  const records = Buffer.from(history)
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as { record_digest: string });
  return records.at(-1)?.record_digest ?? "";
};
function snapshotTree(root: string): string {
  const rows: string[] = [];
  const visit = (path: string, prefix: string): void => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      const relativePath = join(prefix, name);
      const stat = statSync(child);
      if (stat.isDirectory()) {
        rows.push(`${relativePath}/:${stat.mode & 0o777}`);
        visit(child, relativePath);
      } else
        rows.push(`${relativePath}:${stat.mode & 0o777}:${readFileSync(child).toString("hex")}`);
    }
  };
  visit(root, "");
  return rows.join("\n");
}
type RedPayloadInput = Parameters<typeof buildConsumerNodeRuntimePayloads>[0] & {
  readonly prior_history: Uint8Array;
  readonly prior_pointer: {
    readonly bytes: Uint8Array;
    readonly mode: number;
    readonly digest: string;
  };
  readonly operation_kind: "install" | "update" | "rollback";
  readonly prior_attestation?: Uint8Array;
};

function setupDeps(repoRoot: string): SetupDeps {
  return {
    repoRoot,
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

async function aggregateFor(root: string) {
  const entry = Object.freeze({
    path: "src/entry.ts",
    mode: "100644" as const,
    content: new Uint8Array([1, 2, 3]),
  });
  const artifactSetDigest = digestMaterializedReleaseEntries([entry]);
  const releaseId = deriveReleaseId("1", revision, artifactSetDigest);
  const publicationEntry: SealedPublicationEntry = {
    sourcePath: "releases/stable/entry.ts",
    destinationPath: entry.path,
    mode: entry.mode,
    size: entry.content.length,
    contentDigest: digestConsumerRuntimeBytes(entry.content),
    content: Buffer.from(entry.content),
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
  const artifactInventoryDigest = deriveArtifactInventoryDigest(publicationArtifacts);
  const provisionalPublicationRelease = {
    materializerVersion: "1",
    artifactSourceCommit: revision,
    artifactSetDigest,
    artifactInventoryDigest,
    releaseAssetInventoryDigest: `sha256:${"0".repeat(64)}`,
    releaseRecordDigest: `sha256:${"0".repeat(64)}`,
    artifacts: publicationArtifacts,
  };
  const publicationAssets = derivePackPublicationAssets({
    release: { releaseId, ...provisionalPublicationRelease },
    entries: [publicationEntry],
  });
  if (!publicationAssets.ok) throw new Error(publicationAssets.error);
  const publicationRelease = {
    ...provisionalPublicationRelease,
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
  const finalTree = {
    manifestEntries: [
      {
        path: "release/manifest.yaml",
        value: publicationManifest,
      },
    ],
    sourcePaths: ["releases/stable/entry.ts"],
    cleanPackAllowlist: ["release/manifest.yaml", entry.path],
    channelMappings: [
      {
        channel: "stable",
        releaseId,
        sourceRevision: revision,
        sourcePath: "releases/stable/entry.ts",
        destinationPath: entry.path,
      },
    ],
  };
  const aggregate = await admitReleaseAggregate(
    { repository: "fixture-repository", channel: "stable", finalTree },
    {
      attestChannel: async () => ({
        status: "attested" as const,
        releaseId,
        artifactSourceCommit: revision,
        expectedDigest: artifactSetDigest,
        actualDigest: artifactSetDigest,
        entries: [entry],
      }),
    },
  );
  if (!aggregate.ok) throw new Error(aggregate.error);
  const consumerInput = {
    productId: "ut-tdd",
    consumerRoot: root,
    runtimeRoot: join(root, ".ut-tdd", "runtime"),
    plan: aggregate.plan,
    manifest: {
      materializerVersion: "1",
      releaseId,
      sourceRevision: revision,
      artifactSetDigest,
    },
    receipt: {
      materializerVersion: "1",
      releaseId,
      sourceRevision: revision,
      artifactSetDigest,
      productId: "ut-tdd",
      consumerRoot: root,
      runtimeRoot: join(root, ".ut-tdd", "runtime"),
    },
    controlManifestBytes,
  };
  const admission = admitConsumerLocalRuntime(consumerInput);
  if (!admission.ok) throw new Error(admission.error);
  return {
    input: consumerInput,
    admission: admission.admission,
    controlManifestBytes,
    controlManifestSnapshotDigest: admission.admission.controlManifestSnapshotDigest,
  };
}

async function runtimeFor(root: string) {
  const compiled = Buffer.from("process.exit(0)\n");
  const unsigned = {
    schema_version: 2,
    generation_id: "generation-red",
    subject_revision: revision,
    runtime: "node",
    node: { path: process.execPath, version: process.version, sha256: hex("b") },
    npm: { cli_path: "npm-cli.js", version: "11.6.2", sha256: hex("c") },
    toolchain_provenance_sha256: hex("d"),
    package_lock_sha256: hex("e"),
    tsconfig_node: { path: "tsconfig.node.json", sha256: hex("f") },
    builder: { path: "build-node.mjs", policy: "compiled-esm-only", sha256: hex("1") },
    compiled_cli: {
      path: "ut-tdd.mjs",
      sha256: digestConsumerRuntimeBytes(compiled).slice(7),
      local_version: "1",
    },
    source_graph_sha256: hex("2"),
    source_files: [],
    external_dependencies: [],
    external_dependency_closure_sha256: hex("3"),
  };
  const receipt = Buffer.from(
    `${JSON.stringify({ ...unsigned, receipt_digest: digestConsumerRuntimeValue(unsigned).slice(7) })}\n`,
  );
  const aggregate = await aggregateFor(root);
  const identity = {
    product_id: aggregate.input.productId,
    consumer_root: root,
    runtime_root: aggregate.input.runtimeRoot,
    operation_id: "red-admission",
    attempt: 0,
    generation_id: unsigned.generation_id,
    subject_revision: revision,
    artifact_digest: `sha256:${hex("4")}`,
    node_executable_identity: `node-${process.version}|sha256:${hex("b")}`,
    package_lock_digest: `sha256:${unsigned.package_lock_sha256}`,
    source_graph_digest: `sha256:${unsigned.source_graph_sha256}`,
    compiled_esm_digest: digestConsumerRuntimeBytes(compiled),
    release_id: aggregate.input.manifest.releaseId,
    materializer_version: aggregate.input.manifest.materializerVersion,
    artifact_set_digest: aggregate.input.manifest.artifactSetDigest,
    control_manifest_digest: aggregate.controlManifestSnapshotDigest,
    sealed_policy: "compiled-esm-only" as const,
  };
  return {
    identity,
    compiled_esm: compiled,
    node_bootstrap_receipt: receipt,
    admission: aggregate.admission,
    admissionInput: aggregate.input,
    controlManifestSnapshotDigest: aggregate.controlManifestSnapshotDigest,
  };
}

function receiptFor(base: Uint8Array, generationId: string, compiledEsm: Uint8Array): Uint8Array {
  const parsed = JSON.parse(Buffer.from(base).toString("utf8")) as Record<string, unknown>;
  const compiledCli = parsed.compiled_cli as Record<string, unknown>;
  const unsigned = {
    ...parsed,
    generation_id: generationId,
    compiled_cli: {
      ...compiledCli,
      sha256: digestConsumerRuntimeBytes(compiledEsm).slice(7),
    },
  };
  delete (unsigned as { receipt_digest?: unknown }).receipt_digest;
  return Buffer.from(
    `${JSON.stringify({ ...unsigned, receipt_digest: digestConsumerRuntimeValue(unsigned).slice(7) })}\n`,
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) removeTestTree(root);
});

describe("Issue #420 closure Red oracles: aggregate authority and durable history", () => {
  it("CANDIDATE-U-PACKNODE-007: baseline is an actual admitReleaseAggregate→admitConsumerLocalRuntime output", async () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-red-admission-baseline-"));
    roots.push(root);
    const runtime = await runtimeFor(root);
    expect(runtime.admission).toMatchObject({
      productId: "ut-tdd",
      consumerRoot: realpathSync.native(root),
      runtimeRoot: join(realpathSync.native(root), ".ut-tdd", "runtime"),
    });
    expect(runtime.admission.plan.kind).toBe("release-aggregate");
    expect(runtime.admissionInput.plan).toStrictEqual(runtime.admission.plan);
    expect(runtime.identity.control_manifest_digest).toBe(runtime.controlManifestSnapshotDigest);
  });

  type AggregateMutation = readonly [
    string,
    (input: ConsumerLocalRuntimeAdmissionInput) => ConsumerLocalRuntimeAdmissionInput,
  ];
  const aggregateMutations: readonly AggregateMutation[] = [
    [
      "manifest releaseId",
      (input) => ({
        ...input,
        manifest: { ...input.manifest, releaseId: `rel-sha256:${hex("9")}` },
      }),
    ],
    [
      "manifest sourceRevision",
      (input) => ({ ...input, manifest: { ...input.manifest, sourceRevision: "b".repeat(40) } }),
    ],
    [
      "manifest materializerVersion",
      (input) => ({ ...input, manifest: { ...input.manifest, materializerVersion: "2" } }),
    ],
    [
      "manifest artifactSetDigest",
      (input) => ({
        ...input,
        manifest: { ...input.manifest, artifactSetDigest: `sha256:${hex("9")}` },
      }),
    ],
    [
      "receipt releaseId",
      (input) => ({ ...input, receipt: { ...input.receipt, releaseId: `rel-sha256:${hex("9")}` } }),
    ],
    [
      "receipt sourceRevision",
      (input) => ({ ...input, receipt: { ...input.receipt, sourceRevision: "b".repeat(40) } }),
    ],
    [
      "receipt materializerVersion",
      (input) => ({ ...input, receipt: { ...input.receipt, materializerVersion: "2" } }),
    ],
    [
      "receipt artifactSetDigest",
      (input) => ({
        ...input,
        receipt: { ...input.receipt, artifactSetDigest: `sha256:${hex("9")}` },
      }),
    ],
    [
      "consumerRoot",
      (input) => ({ ...input, consumerRoot: join(input.consumerRoot, "..", "outside-consumer") }),
    ],
    [
      "runtimeRoot",
      (input) => ({ ...input, runtimeRoot: join(input.consumerRoot, "..", "outside-runtime") }),
    ],
    ["productId", (input) => ({ ...input, productId: "" })],
    [
      "control manifest sidecar",
      (input) => ({
        ...input,
        controlManifestBytes: Buffer.from(
          Buffer.from(input.controlManifestBytes)
            .toString("utf8")
            .replace(/releaseRecordDigest: sha256:[0-9a-f]/, "releaseRecordDigest: sha256:0"),
          "utf8",
        ),
      }),
    ],
    [
      "plan entry path",
      (input) => ({
        ...input,
        plan: {
          ...input.plan,
          entries: [{ ...input.plan.entries[0], path: "../escape.ts" }],
        },
      }),
    ],
    [
      "plan entry mode",
      (input) => ({
        ...input,
        plan: {
          ...input.plan,
          entries: [{ ...input.plan.entries[0], mode: "100755" }],
        },
      }),
    ],
    [
      "plan entry content",
      (input) => ({
        ...input,
        plan: {
          ...input.plan,
          entries: [{ ...input.plan.entries[0], content: new Uint8Array([9, 9, 9]) }],
        },
      }),
    ],
  ];

  it.each(
    aggregateMutations,
  )("CANDIDATE-U-PACKNODE-007/008/009: admission rejects actual aggregate output mutation before setup", async (_label, mutate) => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-red-admission-"));
    roots.push(root);
    const runtime = await runtimeFor(root);
    expect(admitConsumerLocalRuntime(mutate(runtime.admissionInput))).toMatchObject({
      ok: false,
    });
    expect(existsSync(join(root, ".ut-tdd"))).toBe(false);
  });

  it("CANDIDATE-U-PACKNODE-007/008/009: setup rejects raw finalTree/manifest/receipt instead of accepting an unbranded object", async () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-red-admission-raw-"));
    roots.push(root);
    const runtime = await runtimeFor(root);
    const input = { ...runtime, admission: runtime.admissionInput };
    await expect(
      runSetupAsync(
        {
          phase: "0-A",
          dryRun: false,
          applyBranchProtection: false,
          consumerRuntime: input as unknown as SetupConsumerRuntimeInput,
        },
        setupDeps(root),
      ),
    ).rejects.toThrow(/consumer_runtime_(aggregate|identity|digest)/);
    expect(existsSync(join(root, ".ut-tdd"))).toBe(false);
  });

  it("CANDIDATE-U-PACKNODE-007: setup accepts the same-process admitted capability", async () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-red-admission-positive-"));
    roots.push(root);
    const runtime = await runtimeFor(root);
    const result = await runSetupAsync(
      { phase: "0-A", dryRun: false, applyBranchProtection: false, consumerRuntime: runtime },
      setupDeps(root),
    );
    expect(result.consumerRuntime?.result).toMatchObject({ ok: true, status: "committed" });
  });

  it("CANDIDATE-U-PACKNODE-005: setup rejects an install failure before writing setup artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-red-setup-install-failure-"));
    roots.push(root);
    const runtime = await runtimeFor(root);
    const deps = setupDeps(root);
    let setupWrites = 0;
    deps.writeText = () => {
      setupWrites += 1;
    };
    await expect(
      runSetupAsync(
        {
          phase: "0-A",
          dryRun: false,
          applyBranchProtection: false,
          consumerRuntime: {
            ...runtime,
            fault: (barrier) => {
              if (barrier === "writeGenerationAndReceipt")
                throw new Error("consumer_runtime_permission");
            },
          },
        },
        deps,
      ),
    ).rejects.toThrow("consumer_runtime_permission");
    expect(setupWrites).toBe(0);
  });

  it("CANDIDATE-U-PACKNODE-005/012: downstream setup fault restores prior runtime and setup bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-red-setup-rollback-"));
    roots.push(root);
    const runtime = await runtimeFor(root);
    const first = await runSetupAsync(
      { phase: "0-A", dryRun: false, applyBranchProtection: false, consumerRuntime: runtime },
      setupDeps(root),
    );
    const installed = first.consumerRuntime;
    if (!installed?.result.ok) throw new Error("initial setup install failed");
    const before = snapshotTree(root);
    const pointerPath = join(root, ".ut-tdd", "runtime", "activation", "active.json");
    const priorPointerBytes = readFileSync(pointerPath);
    const priorPointer = {
      bytes: priorPointerBytes,
      mode: statSync(pointerPath).mode & 0o777,
      digest: digestConsumerRuntimeBytes(priorPointerBytes),
    };
    const priorHistory = readFileSync(join(installed.bundle.bundle_path, "history.jsonl"));
    const nextRuntime = {
      ...runtime,
      identity: { ...runtime.identity, operation_id: "red-admission-update", attempt: 1 },
      prior_bundle_digest: installed.bundle.bundle_digest,
      prior_history_tip_digest: historyTipDigest(priorHistory),
      history_sequence: 1,
      prior_history: priorHistory,
      prior_pointer: priorPointer,
      operation_kind: "update" as const,
    };
    const deps = setupDeps(root);
    deps.isInteractive = true;
    deps.confirm = () => true;
    let writes = 0;
    deps.writeText = (path, content) => {
      writes += 1;
      if (writes === 2) throw new Error("setup-downstream-fault");
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, content);
    };
    await expect(
      runSetupAsync(
        { phase: "0-A", dryRun: false, applyBranchProtection: false, consumerRuntime: nextRuntime },
        deps,
      ),
    ).rejects.toThrow("setup-downstream-fault");
    expect(snapshotTree(root)).toBe(before);
  });

  it("CANDIDATE-U-PACKNODE-012/014: update payload is prior-history prefix with raw prior pointer", async () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-red-history-"));
    roots.push(root);
    const runtime = await runtimeFor(root);
    const genesis = buildConsumerNodeRuntimePayloads(runtime);
    const priorPointer = Buffer.from(`{"bundle_digest":"sha256:${"a".repeat(64)}"}\n`);
    const nextInput: RedPayloadInput = {
      ...runtime,
      prior_bundle_digest: `sha256:${hex("a")}`,
      prior_history_tip_digest: historyTipDigest(genesis.history),
      history_sequence: 1,
      prior_history: genesis.history,
      prior_pointer: {
        bytes: priorPointer,
        mode: 0o444,
        digest: digestConsumerRuntimeBytes(priorPointer),
      },
      operation_kind: "update",
    };
    const next = buildConsumerNodeRuntimePayloads(nextInput);
    const priorRecords = Buffer.from(genesis.history)
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const nextRecords = Buffer.from(next.history)
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(nextRecords.length).toBe(priorRecords.length + 1);
    expect(nextRecords.slice(0, priorRecords.length)).toEqual(priorRecords);
    expect(nextRecords.at(-1)).toMatchObject({ operation_kind: "update", history_sequence: 1 });
    const operation = JSON.parse(Buffer.from(next.operation_state).toString("utf8")) as Record<
      string,
      unknown
    >;
    expect(operation.prior_pointer).toEqual({
      bytes_base64: priorPointer.toString("base64"),
      mode: 0o444,
      digest: digestConsumerRuntimeBytes(priorPointer),
    });
  });

  const historyMutations: readonly [string, Partial<RedPayloadInput>][] = [
    ["prefix", { prior_history: Buffer.from("truncated\n") }],
    ["sequence gap", { history_sequence: 2 }],
    ["tip drift", { prior_history_tip_digest: `sha256:${hex("f")}` }],
    ["prior bundle digest", { prior_bundle_digest: `sha256:${hex("f")}` }],
    [
      "prior pointer bytes",
      {
        prior_pointer: {
          bytes: Buffer.from(`{"bundle_digest":"sha256:${"c".repeat(64)}"}\n`),
          mode: 0o444,
          digest: digestConsumerRuntimeBytes(
            Buffer.from(`{"bundle_digest":"sha256:${"c".repeat(64)}"}\n`),
          ),
        },
      },
    ],
    [
      "prior pointer mode",
      {
        prior_pointer: {
          bytes: Buffer.from("prior\n"),
          mode: 0o644,
          digest: digestConsumerRuntimeBytes(Buffer.from("prior\n")),
        },
      },
    ],
    ["operation kind", { operation_kind: "install" }],
    ["rollback prior attestation missing", { operation_kind: "rollback" }],
    [
      "rollback prior attestation invalid",
      { operation_kind: "rollback", prior_attestation: Buffer.from("unattested\n") },
    ],
  ];

  it.each(
    historyMutations,
  )("CANDIDATE-U-PACKNODE-012/014: rejects %s history mutation before publication", async (_label, mutation) => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-red-history-mutation-"));
    roots.push(root);
    const runtime = await runtimeFor(root);
    const genesis = buildConsumerNodeRuntimePayloads(runtime);
    const mutationInput: RedPayloadInput = {
      ...runtime,
      prior_bundle_digest: `sha256:${hex("a")}`,
      prior_history_tip_digest: historyTipDigest(genesis.history),
      history_sequence: 1,
      prior_history: genesis.history,
      prior_pointer: {
        bytes: Buffer.from(`{"bundle_digest":"sha256:${"a".repeat(64)}"}\n`),
        mode: 0o444,
        digest: digestConsumerRuntimeBytes(
          Buffer.from(`{"bundle_digest":"sha256:${"a".repeat(64)}"}\n`),
        ),
      },
      operation_kind: "update",
      ...mutation,
    } as unknown as RedPayloadInput;
    expect(() => buildConsumerNodeRuntimePayloads(mutationInput)).toThrow();
  });

  it("CANDIDATE-U-PACKNODE-005/012/013: exposes read-only restart reconcile and rollback operation kind", async () => {
    const api = await import("../src/setup/consumer-node-runtime.ts");
    expect(typeof (api as Record<string, unknown>).reconcileConsumerNodeRuntimeOnFilesystem).toBe(
      "function",
    );
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-red-reconcile-"));
    roots.push(root);
    const runtime = await runtimeFor(root);
    const genesis = buildConsumerNodeRuntimePayloads(runtime);
    const nextInput: RedPayloadInput = {
      ...runtime,
      prior_bundle_digest: `sha256:${hex("a")}`,
      prior_history_tip_digest: historyTipDigest(genesis.history),
      history_sequence: 1,
      prior_history: genesis.history,
      prior_pointer: {
        bytes: Buffer.from(`{"bundle_digest":"sha256:${"a".repeat(64)}"}\n`),
        mode: 0o444,
        digest: digestConsumerRuntimeBytes(
          Buffer.from(`{"bundle_digest":"sha256:${"a".repeat(64)}"}\n`),
        ),
      },
      operation_kind: "rollback",
      prior_attestation: runtime.node_bootstrap_receipt,
      prior_identity: runtime.identity,
    };
    const next = buildConsumerNodeRuntimePayloads(nextInput);
    const records = Buffer.from(next.history)
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { operation_kind?: string });
    expect(records.at(-1)?.operation_kind).toBe("rollback");
  });

  it("CANDIDATE-U-PACKNODE-012/014: rejects rollback attestation not bound to the prior history identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-red-rollback-attestation-"));
    roots.push(root);
    const runtime = await runtimeFor(root);
    const priorIdentity = {
      ...runtime.identity,
      generation_id: "generation-prior",
      operation_id: "prior-generation",
      attempt: 0,
    };
    const prior = buildConsumerNodeRuntimePayloads({
      identity: priorIdentity,
      compiled_esm: runtime.compiled_esm,
      node_bootstrap_receipt: runtime.node_bootstrap_receipt,
    });
    const priorPointerBytes = Buffer.from(`{"bundle_digest":"sha256:${"a".repeat(64)}"}\n`);
    expect(() =>
      buildConsumerNodeRuntimePayloads({
        ...runtime,
        prior_bundle_digest: `sha256:${"a".repeat(64)}`,
        prior_history_tip_digest: historyTipDigest(prior.history),
        history_sequence: 1,
        prior_history: prior.history,
        prior_pointer: {
          bytes: priorPointerBytes,
          mode: 0o444,
          digest: digestConsumerRuntimeBytes(priorPointerBytes),
        },
        operation_kind: "rollback",
        prior_attestation: runtime.node_bootstrap_receipt,
        prior_identity: runtime.identity,
      }),
    ).toThrow(/rollback (attestation|prior)/);
  });

  it("CANDIDATE-U-PACKNODE-012/014: accepts A→B→A rollback only for a recorded generation with its receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-red-rollback-history-target-"));
    roots.push(root);
    const a = await runtimeFor(root);
    const compiledB = Buffer.from("process.exit(1)\n");
    const identityB = {
      ...a.identity,
      operation_id: "rollback-history-b",
      attempt: 1,
      generation_id: "generation-blue",
      compiled_esm_digest: digestConsumerRuntimeBytes(compiledB),
    };
    const receiptB = receiptFor(a.node_bootstrap_receipt, identityB.generation_id, compiledB);
    const genesis = buildConsumerNodeRuntimePayloads(a);
    const pointerABytes = Buffer.from(`{"bundle_digest":"sha256:${"a".repeat(64)}"}\n`);
    const pointerA = {
      bytes: pointerABytes,
      mode: 0o444,
      digest: digestConsumerRuntimeBytes(pointerABytes),
    };
    const update = buildConsumerNodeRuntimePayloads({
      identity: identityB,
      compiled_esm: compiledB,
      node_bootstrap_receipt: receiptB,
      prior_bundle_digest: `sha256:${"a".repeat(64)}`,
      prior_history_tip_digest: historyTipDigest(genesis.history),
      history_sequence: 1,
      prior_history: genesis.history,
      prior_pointer: pointerA,
      operation_kind: "update",
    });
    const updateRecord = JSON.parse(
      Buffer.from(update.history).toString("utf8").trimEnd().split("\n").at(-1) ?? "{}",
    ) as { identity_digest?: string };
    expect(updateRecord.identity_digest).toBe(digestConsumerRuntimeValue(identityB));
    const rollbackIdentity = {
      ...a.identity,
      operation_id: "rollback-history-a",
      attempt: 2,
    };
    const pointerBBytes = Buffer.from(`{"bundle_digest":"sha256:${"b".repeat(64)}"}\n`);
    const pointerB = {
      bytes: pointerBBytes,
      mode: 0o444,
      digest: digestConsumerRuntimeBytes(pointerBBytes),
    };
    expect(() =>
      buildConsumerNodeRuntimePayloads({
        identity: rollbackIdentity,
        compiled_esm: a.compiled_esm,
        node_bootstrap_receipt: a.node_bootstrap_receipt,
        prior_bundle_digest: `sha256:${"b".repeat(64)}`,
        prior_history_tip_digest: historyTipDigest(update.history),
        history_sequence: 2,
        prior_history: update.history,
        prior_pointer: pointerB,
        operation_kind: "rollback",
        prior_attestation: a.node_bootstrap_receipt,
        prior_identity: a.identity,
      }),
    ).not.toThrow();
  });

  it("CANDIDATE-U-PACKNODE-012/014: denies rollback to an unrecorded generation", async () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-red-rollback-unrecorded-"));
    roots.push(root);
    const a = await runtimeFor(root);
    const genesis = buildConsumerNodeRuntimePayloads(a);
    const compiledUnrecorded = Buffer.from("process.exit(2)\n");
    const identityUnrecorded = {
      ...a.identity,
      operation_id: "rollback-history-missing",
      attempt: 2,
      generation_id: "generation-missing",
      compiled_esm_digest: digestConsumerRuntimeBytes(compiledUnrecorded),
    };
    const receiptUnrecorded = receiptFor(
      a.node_bootstrap_receipt,
      identityUnrecorded.generation_id,
      compiledUnrecorded,
    );
    const pointerBytes = Buffer.from(`{"bundle_digest":"sha256:${"a".repeat(64)}"}\n`);
    expect(() =>
      buildConsumerNodeRuntimePayloads({
        identity: identityUnrecorded,
        compiled_esm: compiledUnrecorded,
        node_bootstrap_receipt: receiptUnrecorded,
        prior_bundle_digest: `sha256:${"a".repeat(64)}`,
        prior_history_tip_digest: historyTipDigest(genesis.history),
        history_sequence: 1,
        prior_history: genesis.history,
        prior_pointer: {
          bytes: pointerBytes,
          mode: 0o444,
          digest: digestConsumerRuntimeBytes(pointerBytes),
        },
        operation_kind: "rollback",
        prior_attestation: receiptUnrecorded,
        prior_identity: identityUnrecorded,
      }),
    ).toThrow(/rollback prior identity/);
  });

  it("CANDIDATE-U-PACKNODE-012/014: denies rollback when the new operation tuple differs from its target generation", async () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-red-rollback-operation-tuple-"));
    roots.push(root);
    const a = await runtimeFor(root);
    const genesis = buildConsumerNodeRuntimePayloads(a);
    expect(() =>
      buildConsumerNodeRuntimePayloads({
        ...a,
        identity: {
          ...a.identity,
          operation_id: "rollback-tuple-mismatch",
          attempt: 1,
          artifact_digest: `sha256:${"9".repeat(64)}`,
        },
        prior_bundle_digest: `sha256:${"a".repeat(64)}`,
        prior_history_tip_digest: historyTipDigest(genesis.history),
        history_sequence: 1,
        prior_history: genesis.history,
        prior_pointer: {
          bytes: Buffer.from(`{"bundle_digest":"sha256:${"a".repeat(64)}"}\n`),
          mode: 0o444,
          digest: digestConsumerRuntimeBytes(
            Buffer.from(`{"bundle_digest":"sha256:${"a".repeat(64)}"}\n`),
          ),
        },
        operation_kind: "rollback",
        prior_attestation: a.node_bootstrap_receipt,
        prior_identity: a.identity,
      }),
    ).toThrow(/rollback prior identity mismatch/);
  });

  it("CANDIDATE-U-PACKNODE-012/014: denies a validly re-digested history splice with a broken prior-tip link", async () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-red-history-splice-"));
    roots.push(root);
    const a = await runtimeFor(root);
    const genesis = buildConsumerNodeRuntimePayloads(a);
    const b = buildConsumerNodeRuntimePayloads({
      ...a,
      identity: { ...a.identity, operation_id: "history-splice-b", attempt: 1 },
      prior_bundle_digest: `sha256:${"a".repeat(64)}`,
      prior_history_tip_digest: historyTipDigest(genesis.history),
      history_sequence: 1,
      prior_history: genesis.history,
      prior_pointer: {
        bytes: Buffer.from(`{"bundle_digest":"sha256:${"a".repeat(64)}"}\n`),
        mode: 0o444,
        digest: digestConsumerRuntimeBytes(
          Buffer.from(`{"bundle_digest":"sha256:${"a".repeat(64)}"}\n`),
        ),
      },
      operation_kind: "update",
    });
    const records = Buffer.from(b.history)
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const middle: Record<string, unknown> = {
      ...records[1],
      prior_history_tip_digest: `sha256:${"f".repeat(64)}`,
    };
    delete middle.record_digest;
    records[1] = {
      ...middle,
      record_digest: digestConsumerRuntimeValue(middle),
    };
    const splicedHistory = Buffer.from(
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    expect(() =>
      buildConsumerNodeRuntimePayloads({
        ...a,
        identity: { ...a.identity, operation_id: "history-splice-c", attempt: 2 },
        prior_bundle_digest: `sha256:${"b".repeat(64)}`,
        prior_history_tip_digest: historyTipDigest(splicedHistory),
        history_sequence: 2,
        prior_history: splicedHistory,
        prior_pointer: {
          bytes: Buffer.from(`{"bundle_digest":"sha256:${"b".repeat(64)}"}\n`),
          mode: 0o444,
          digest: digestConsumerRuntimeBytes(
            Buffer.from(`{"bundle_digest":"sha256:${"b".repeat(64)}"}\n`),
          ),
        },
        operation_kind: "update",
      }),
    ).toThrow(/invalid (prior )?history/);
  });
});
