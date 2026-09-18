import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildConsumerNodeRuntimeBundle,
  buildConsumerNodeRuntimePayloads,
  bundlePathFor,
  type ConsumerNodeRuntimeBundle,
  type ConsumerNodeRuntimeIdentity,
  type ConsumerNodeRuntimePorts,
  digestConsumerRuntimeBytes,
  digestConsumerRuntimeValue,
  installConsumerNodeRuntime,
  renderConsumerNodeWrapper,
  stagingPathFor,
  validateConsumerNodeRuntimeBundle,
} from "../src/setup/consumer-node-runtime.ts";
import { buildConsumerReadinessPlan } from "../src/setup/distribution.ts";

const roots: string[] = [];
const PAYLOADS = {
  "ut-tdd.mjs": Buffer.from('process.stdout.write("consumer-local-ok")\n'),
  "node-bootstrap-receipt.json": Buffer.from("bootstrap"),
  "marker.json": Buffer.from("marker"),
  "consumer-receipt.json": Buffer.from("receipt"),
  "history.jsonl": Buffer.from("{}\n"),
  "operation-state.json": Buffer.from("committed"),
} as const;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function identity(root = "/tmp/consumer-node-runtime"): ConsumerNodeRuntimeIdentity {
  return {
    product_id: "ut-tdd",
    consumer_root: root,
    runtime_root: join(root, ".ut-tdd", "runtime"),
    operation_id: "install-001",
    attempt: 0,
    generation_id: "generation-001",
    subject_revision: "a".repeat(40),
    artifact_digest: `sha256:${"1".repeat(64)}`,
    node_executable_identity: `node-v24.13.0|sha256:${"2".repeat(64)}`,
    package_lock_digest: `sha256:${"3".repeat(64)}`,
    source_graph_digest: `sha256:${"4".repeat(64)}`,
    compiled_esm_digest: digestConsumerRuntimeBytes(PAYLOADS["ut-tdd.mjs"]),
    release_id: `rel-sha256:${"5".repeat(64)}`,
    materializer_version: "1",
    artifact_set_digest: `sha256:${"6".repeat(64)}`,
    control_manifest_digest: `sha256:${"7".repeat(64)}`,
    sealed_policy: "compiled-esm-only",
  };
}

function bundleFor(id = identity()): ConsumerNodeRuntimeBundle {
  return buildConsumerNodeRuntimeBundle({
    identity: id,
    compiled_esm: PAYLOADS["ut-tdd.mjs"],
    node_bootstrap_receipt: PAYLOADS["node-bootstrap-receipt.json"],
    marker: PAYLOADS["marker.json"],
    consumer_receipt: PAYLOADS["consumer-receipt.json"],
    history: PAYLOADS["history.jsonl"],
    operation_state: PAYLOADS["operation-state.json"],
  });
}

function wrapperBundleFor(root: string): {
  readonly bundle: ConsumerNodeRuntimeBundle;
  readonly payloads: ReturnType<typeof buildConsumerNodeRuntimePayloads>;
} {
  const id = identity(root);
  const compiled = PAYLOADS["ut-tdd.mjs"];
  const unsignedReceipt = { schema_version: 2, runtime: "node", generation_id: id.generation_id };
  const receipt = Buffer.from(
    JSON.stringify({
      ...unsignedReceipt,
      receipt_digest: digestConsumerRuntimeValue(unsignedReceipt).slice("sha256:".length),
    }),
  );
  const payloads = buildConsumerNodeRuntimePayloads({
    identity: id,
    compiled_esm: compiled,
    node_bootstrap_receipt: receipt,
  });
  return { bundle: buildConsumerNodeRuntimeBundle({ identity: id, ...payloads }), payloads };
}

function testPorts(
  events: string[],
  fault?: string,
  state: "committed" | "uncommitted" | "unknown" | "partial" = "committed",
): ConsumerNodeRuntimePorts {
  const step = (name: string) => () => {
    events.push(name);
    if (fault === name) throw new Error(name);
  };
  return {
    readConsumerIdentity: step("readConsumerIdentity"),
    verifySealedAggregate: step("verifySealedAggregate"),
    verifyNodeGeneration: step("verifyNodeGeneration"),
    acquireConsumerLock: step("acquireConsumerLock"),
    snapshotPriorActivePointer: step("snapshotPriorActivePointer"),
    createPrivateStaging: (path) => {
      events.push(`createPrivateStaging:${path}`);
      if (fault === "createPrivateStaging") throw new Error(fault);
    },
    writeGenerationAndReceipt: (path) => {
      events.push(`writeGenerationAndReceipt:${path}`);
      if (fault === "writeGenerationAndReceipt") throw new Error(fault);
    },
    fsyncStaging: (path) => {
      events.push(`fsyncStaging:${path}`);
      if (fault === "fsyncStaging") throw new Error(fault);
    },
    sealActivationBundle: () => {
      events.push("sealActivationBundle");
      if (fault === "sealActivationBundle") throw new Error(fault);
    },
    atomicRenameActivePointerCAS: () => {
      events.push("atomicRenameActivePointerCAS");
      if (fault === "atomicRenameActivePointerCAS") throw new Error(fault);
    },
    verifyActiveBundle: () => {
      events.push("verifyActiveBundle");
      if (fault === "verifyActiveBundle") throw new Error(fault);
    },
    reconcileDurableOperation: () => {
      events.push("reconcileDurableOperation");
      if (fault === "reconcileDurableOperation") throw new Error(fault);
      return state;
    },
    releaseConsumerLock: step("releaseConsumerLock"),
    destroyPrivateStaging: (path) => {
      events.push(`destroyPrivateStaging:${path}`);
    },
  };
}

describe("sealed self-contained consumer Node runtime", () => {
  it("CANDIDATE-U-PACKNODE-001: every identity mutation is rejected before ports", () => {
    const fields: (keyof ConsumerNodeRuntimeIdentity)[] = [
      "subject_revision",
      "artifact_digest",
      "node_executable_identity",
      "package_lock_digest",
      "source_graph_digest",
      "compiled_esm_digest",
      "release_id",
      "artifact_set_digest",
      "control_manifest_digest",
      "consumer_root",
      "runtime_root",
      "attempt",
    ];
    for (const field of fields) {
      const candidate = {
        ...identity(),
        [field]: field === "attempt" ? -1 : "mutated",
      } as ConsumerNodeRuntimeIdentity;
      expect(() => bundleFor(candidate), field).toThrow();
    }
  });

  it("CANDIDATE-U-PACKNODE-002/003/010: wrapper has one Node active-pointer path and no fallback", () => {
    const wrapper = renderConsumerNodeWrapper();
    expect(wrapper).toContain("active.json");
    expect(wrapper).toContain("process.execPath");
    expect(wrapper).not.toContain("src/cli.ts");
    expect(wrapper).not.toContain("node_modules");
    expect(wrapper).not.toMatch(/\bbun\b/i);
    expect(wrapper).not.toContain("process.env.PATH");
  });

  it("CANDIDATE-U-PACKNODE-004/013: normal order and release exactly once", async () => {
    const events: string[] = [];
    const result = await installConsumerNodeRuntime({
      identity: identity(),
      bundle: bundleFor(),
      ports: testPorts(events),
    });
    expect(result).toMatchObject({ ok: true, status: "committed" });
    expect(events.map((event) => event.split(":")[0])).toEqual([
      "readConsumerIdentity",
      "verifySealedAggregate",
      "verifyNodeGeneration",
      "acquireConsumerLock",
      "snapshotPriorActivePointer",
      "createPrivateStaging",
      "writeGenerationAndReceipt",
      "fsyncStaging",
      "sealActivationBundle",
      "atomicRenameActivePointerCAS",
      "verifyActiveBundle",
      "reconcileDurableOperation",
      "releaseConsumerLock",
    ]);
  });

  it("CANDIDATE-U-PACKNODE-005: pre-commit fault destroys staging and does not publish", async () => {
    const events: string[] = [];
    const result = await installConsumerNodeRuntime({
      identity: identity(),
      bundle: bundleFor(),
      ports: testPorts(events, "fsyncStaging"),
    });
    expect(result).toMatchObject({ ok: false, status: "failed" });
    expect(events.some((event) => event.startsWith("destroyPrivateStaging:"))).toBe(true);
    expect(events).not.toContain("atomicRenameActivePointerCAS");
    expect(events).toContain("releaseConsumerLock");
  });

  it("CANDIDATE-U-PACKNODE-006/015: consumer, operation, attempt, and digest bind paths", () => {
    const first = bundleFor();
    const retry = bundleFor({ ...identity(), attempt: 1 });
    const other = bundleFor(identity("/tmp/other-consumer"));
    expect(first.bundle_path).toBe(bundlePathFor(first.identity, first.bundle_digest));
    expect(first.bundle_path).not.toBe(retry.bundle_path);
    expect(first.bundle_path).not.toBe(other.bundle_path);
    expect(digestConsumerRuntimeValue(first.identity)).not.toBe(
      digestConsumerRuntimeValue(retry.identity),
    );
    expect(stagingPathFor(first.identity)).toContain("staging");
  });

  it("CANDIDATE-U-PACKNODE-007: wrapper runs compiled consumer entry after setup checkout deletion", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-consumer-"));
    roots.push(root);
    const checkout = mkdtempSync(join(tmpdir(), "ut-tdd-setup-"));
    roots.push(checkout);
    const { bundle, payloads } = wrapperBundleFor(root);
    const activation = join(root, ".ut-tdd", "runtime", "activation");
    mkdirSync(bundle.bundle_path, { recursive: true });
    const payloadFiles: Readonly<Record<string, Uint8Array>> = {
      "ut-tdd.mjs": payloads.compiled_esm,
      "node-bootstrap-receipt.json": payloads.node_bootstrap_receipt,
      "marker.json": payloads.marker,
      "consumer-receipt.json": payloads.consumer_receipt,
      "history.jsonl": payloads.history,
      "operation-state.json": payloads.operation_state,
    };
    for (const [name, bytes] of Object.entries(payloadFiles))
      writeFileSync(join(bundle.bundle_path, name), bytes);
    writeFileSync(join(bundle.bundle_path, "bundle-manifest.json"), JSON.stringify(bundle));
    mkdirSync(activation, { recursive: true });
    const entry = join(bundle.bundle_path, "ut-tdd.mjs");
    writeFileSync(
      join(activation, "active.json"),
      JSON.stringify({
        bundle_path: bundle.bundle_path,
        entry_path: entry,
        bundle_digest: bundle.bundle_digest,
      }),
    );
    writeFileSync(join(checkout, "src-cli-sentinel"), "must-not-run");
    rmSync(checkout, { recursive: true, force: true });
    const wrapper = join(root, ".ut-tdd", "bin", "ut-tdd.mjs");
    mkdirSync(resolve(wrapper, ".."), { recursive: true });
    writeFileSync(wrapper, renderConsumerNodeWrapper());
    const run = spawnSync(process.execPath, [wrapper], { cwd: tmpdir(), encoding: "utf8" });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toBe("consumer-local-ok");
  });

  it("CANDIDATE-U-PACKNODE-003/007: external active bundle is denied before process launch", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-consumer-external-"));
    roots.push(root);
    const external = mkdtempSync(join(tmpdir(), "ut-tdd-external-bundle-"));
    roots.push(external);
    const marker = join(external, "spawned");
    const entry = join(external, "ut-tdd.mjs");
    writeFileSync(entry, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "bad")\n`);
    const activation = join(root, ".ut-tdd", "runtime", "activation");
    mkdirSync(activation, { recursive: true });
    writeFileSync(
      join(activation, "active.json"),
      JSON.stringify({
        bundle_path: external,
        entry_path: entry,
        bundle_digest: `sha256:${"a".repeat(64)}`,
      }),
    );
    const wrapper = join(root, ".ut-tdd", "bin", "ut-tdd.mjs");
    mkdirSync(resolve(wrapper, ".."), { recursive: true });
    writeFileSync(wrapper, renderConsumerNodeWrapper());
    const run = spawnSync(process.execPath, [wrapper], { cwd: tmpdir(), encoding: "utf8" });
    expect(run.status).toBe(78);
    expect(existsSync(marker)).toBe(false);
  });

  it("CANDIDATE-U-PACKNODE-005/012: real Node filesystem producer seals one bundle and one pointer", async () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-runtime-producer-"));
    roots.push(root);
    const id = identity(root);
    const bundle = bundleFor(id);
    const entry = join(bundle.bundle_path, "ut-tdd.mjs");
    const events: string[] = [];
    const ports: ConsumerNodeRuntimePorts = {
      readConsumerIdentity: () => {
        events.push("identity");
      },
      verifySealedAggregate: () => {
        events.push("aggregate");
      },
      verifyNodeGeneration: () => {
        events.push("generation");
      },
      acquireConsumerLock: () => {
        events.push("lock");
      },
      snapshotPriorActivePointer: () => {
        events.push("snapshot");
      },
      createPrivateStaging: (path) => {
        events.push("stage");
        mkdirSync(path, { recursive: true });
      },
      writeGenerationAndReceipt: (path) => {
        events.push("write");
        mkdirSync(path, { recursive: true });
        for (const [name, bytes] of Object.entries(PAYLOADS))
          writeFileSync(join(path, name), bytes);
        writeFileSync(join(path, "bundle-manifest.json"), JSON.stringify(bundle));
      },
      fsyncStaging: () => {
        events.push("fsync");
      },
      sealActivationBundle: (path) => {
        events.push("seal");
        mkdirSync(resolve(bundle.bundle_path, ".."), { recursive: true });
        renameSync(path, bundle.bundle_path);
      },
      atomicRenameActivePointerCAS: () => {
        events.push("publish");
        const pointer = join(id.runtime_root, "activation", "active.json");
        mkdirSync(resolve(pointer, ".."), { recursive: true });
        writeFileSync(
          pointer,
          JSON.stringify({
            bundle_path: bundle.bundle_path,
            entry_path: entry,
            bundle_digest: bundle.bundle_digest,
          }),
        );
      },
      verifyActiveBundle: () => {
        events.push("verify");
        if (!existsSync(entry)) throw new Error("sealed entry absent");
      },
      reconcileDurableOperation: () => {
        events.push("reconcile");
        return "committed";
      },
      releaseConsumerLock: () => {
        events.push("release");
      },
      destroyPrivateStaging: (path) => {
        if (existsSync(path)) rmSync(path, { recursive: true, force: true });
      },
    };
    const result = await installConsumerNodeRuntime({ identity: id, bundle, ports });
    expect(result).toMatchObject({ ok: true, status: "committed" });
    expect(existsSync(bundle.bundle_path)).toBe(true);
    expect(existsSync(join(id.runtime_root, "activation", "active.json"))).toBe(true);
    expect(events).toEqual([
      "identity",
      "aggregate",
      "generation",
      "lock",
      "snapshot",
      "stage",
      "write",
      "fsync",
      "seal",
      "publish",
      "verify",
      "reconcile",
      "release",
    ]);
  });

  it("CANDIDATE-U-PACKNODE-008/009: spaces work while external runtime escapes fail", () => {
    const spaced = identity(join(tmpdir(), "consumer with spaces"));
    expect(() => stagingPathFor(spaced)).not.toThrow();
    expect(() =>
      stagingPathFor({ ...spaced, runtime_root: resolve(spaced.consumer_root, "..", "outside") }),
    ).toThrow();
  });

  it("CANDIDATE-U-PACKNODE-009: compiled ESM digest drift is rejected", () => {
    expect(() =>
      buildConsumerNodeRuntimeBundle({
        identity: identity(),
        compiled_esm: Buffer.from("different"),
        node_bootstrap_receipt: Buffer.from("b"),
        marker: Buffer.from("m"),
        consumer_receipt: Buffer.from("r"),
        history: Buffer.from("h"),
        operation_state: Buffer.from("o"),
      }),
    ).toThrow("compiled ESM digest mismatch");
  });

  it("CANDIDATE-U-PACKNODE-011: hasUtTddCli cannot bypass absent sealed runtime", () => {
    const plan = buildConsumerReadinessPlan({
      nodeVersion: "24.13.0",
      requiredNodeVersion: "24.13.0",
      hasGit: true,
      hasGh: false,
      hasUtTddCli: true,
      hasClaude: false,
      hasCodex: false,
      repoRoot: "/consumer",
      consumerRuntime: { status: "blocked", reason: "consumer_runtime_absent" },
    });
    expect(plan.ok).toBe(false);
    expect(plan.consumerRuntime).toEqual({ ok: false, reason: "consumer_runtime_absent" });
  });

  it("CANDIDATE-U-PACKNODE-011: valid sealed Node runtime is ready without Bun", () => {
    const id = identity("/consumer");
    const plan = buildConsumerReadinessPlan({
      nodeVersion: "24.13.0",
      requiredNodeVersion: "24.13.0",
      hasGit: true,
      hasGh: false,
      hasUtTddCli: false,
      hasClaude: false,
      hasCodex: true,
      repoRoot: "/consumer",
      consumerRuntime: { status: "ready", identity: id, bundle: bundleFor(id) },
    });
    expect(plan.ok).toBe(true);
    expect(plan.checks.some((check) => check.name.startsWith("bun"))).toBe(false);
    expect(plan.consumerRuntime).toEqual({ ok: true });
  });

  it("CANDIDATE-U-PACKNODE-001/010: manifest compiled entry digest cannot be re-declared", () => {
    const bundle = bundleFor();
    const files = { ...bundle.files, "ut-tdd.mjs": `sha256:${"f".repeat(64)}` };
    const forged = {
      ...bundle,
      files,
      bundle_digest: digestConsumerRuntimeValue({
        identity: bundle.identity,
        files,
        history_sequence: bundle.history_sequence,
        prior_bundle_digest: bundle.prior_bundle_digest,
        prior_history_tip_digest: bundle.prior_history_tip_digest,
      }),
    };
    expect(validateConsumerNodeRuntimeBundle(forged)).toBe("consumer_runtime_digest_mismatch");
  });

  it("CANDIDATE-U-PACKNODE-012/013: post-commit fault reconciles once and release remains once", async () => {
    const events: string[] = [];
    const result = await installConsumerNodeRuntime({
      identity: identity(),
      bundle: bundleFor(),
      ports: testPorts(events, "verifyActiveBundle", "committed"),
    });
    expect(result).toMatchObject({ ok: false, status: "indeterminate" });
    expect(events.filter((event) => event === "reconcileDurableOperation")).toHaveLength(1);
    expect(events.filter((event) => event === "releaseConsumerLock")).toHaveLength(1);
  });

  it("CANDIDATE-U-PACKNODE-014: genesis requires explicit genesis history identity", () => {
    expect(bundleFor().history_sequence).toBe(0);
    expect(() =>
      buildConsumerNodeRuntimeBundle({
        identity: identity(),
        compiled_esm: Buffer.from('process.stdout.write("consumer-local-ok")\n'),
        node_bootstrap_receipt: Buffer.from("b"),
        marker: Buffer.from("m"),
        consumer_receipt: Buffer.from("r"),
        history: Buffer.from("h"),
        operation_state: Buffer.from("o"),
        history_sequence: 1,
      }),
    ).toThrow();
  });

  it("CANDIDATE-P-PACKNODE-001: repeated derivation is stable with bounded calls", () => {
    const id = identity();
    const digests = Array.from({ length: 100 }, () => bundleFor(id).bundle_digest);
    expect(new Set(digests).size).toBe(1);
    expect(digests).toHaveLength(100);
  });

  it("release fault is typed indeterminate and preserves primary error", async () => {
    const events: string[] = [];
    const ports = testPorts(events);
    ports.releaseConsumerLock = vi.fn(() => {
      throw new Error("release");
    });
    const result = await installConsumerNodeRuntime({
      identity: identity(),
      bundle: bundleFor(),
      ports,
    });
    expect(result).toMatchObject({ ok: false, status: "indeterminate", phase: "release" });
  });
});
