import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import {
  deriveArtifactInventoryDigest,
  deriveReleaseId,
  deriveReleaseRecordDigest,
} from "../src/schema/release-manifest.ts";
import {
  admitConsumerLocalRuntime,
  applyConsumerLocalRuntime,
  type ConsumerLocalRuntimeAdmissionInput,
  installConsumerLocalRuntime,
} from "../src/setup/consumer-local-runtime-admission.ts";
import { derivePackPublicationAssets } from "../src/setup/pack-publication-assets.ts";

const roots: string[] = [];
const children: ChildProcess[] = [];

function digest(entries: readonly { path: string; mode: string; content: Uint8Array }[]): string {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const path = Buffer.from(entry.path, "utf8");
    const mode = Buffer.from(entry.mode, "ascii");
    const pathLength = Buffer.alloc(4);
    const modeLength = Buffer.alloc(4);
    const contentLength = Buffer.alloc(8);
    pathLength.writeUInt32BE(path.length);
    modeLength.writeUInt32BE(mode.length);
    contentLength.writeBigUInt64BE(BigInt(entry.content.length));
    chunks.push(pathLength, path, modeLength, mode, contentLength, Buffer.from(entry.content));
  }
  return `sha256:${createHash("sha256").update(Buffer.concat(chunks)).digest("hex")}`;
}

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once("exit", () => resolve());
          child.kill();
        }),
    ),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  productId: string,
  version = "1",
): Promise<ConsumerLocalRuntimeAdmissionInput> {
  const root = await mkdtemp(join(tmpdir(), `ut-tdd-packiso-${productId}-`));
  roots.push(root);
  const entries = [
    { path: "bin/runtime.js", mode: "100644" as const, content: new TextEncoder().encode(version) },
  ];
  const artifactDigest = digest(entries);
  const contentDigest = `sha256:${createHash("sha256").update(entries[0].content).digest("hex")}`;
  const sourceRevision = version === "v2" ? "b".repeat(40) : "a".repeat(40);
  const releaseId = deriveReleaseId("1", sourceRevision, artifactDigest);
  const plan = {
    kind: "release-aggregate" as const,
    channel: "stable",
    releaseId,
    sourceRevision,
    destinationPath: "bin",
    expectedDigest: artifactDigest,
    actualDigest: artifactDigest,
    entries,
  };
  const publicationEntry = {
    sourcePath: "releases/stable/runtime.js",
    destinationPath: entries[0].path,
    mode: entries[0].mode,
    size: entries[0].content.length,
    contentDigest,
    content: entries[0].content,
  };
  const publicationBase = {
    materializerVersion: "1",
    artifactSourceCommit: sourceRevision,
    artifactSetDigest: artifactDigest,
    artifactInventoryDigest: deriveArtifactInventoryDigest([
      {
        sourcePath: publicationEntry.sourcePath,
        destinationPath: publicationEntry.destinationPath,
        mode: publicationEntry.mode,
        size: publicationEntry.size,
        contentDigest: publicationEntry.contentDigest,
      },
    ]),
    releaseAssetInventoryDigest: `sha256:${"0".repeat(64)}`,
    releaseRecordDigest: `sha256:${"0".repeat(64)}`,
    artifacts: [
      {
        sourcePath: publicationEntry.sourcePath,
        destinationPath: publicationEntry.destinationPath,
        mode: publicationEntry.mode,
        size: publicationEntry.size,
        contentDigest: publicationEntry.contentDigest,
      },
    ],
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
  return {
    productId,
    consumerRoot: root,
    runtimeRoot: join(root, ".ut-tdd"),
    plan,
    manifest: {
      materializerVersion: "1",
      releaseId: plan.releaseId,
      sourceRevision: plan.sourceRevision,
      artifactSetDigest: plan.actualDigest,
    },
    receipt: {
      productId,
      consumerRoot: root,
      runtimeRoot: join(root, ".ut-tdd"),
      materializerVersion: "1",
      releaseId: plan.releaseId,
      sourceRevision: plan.sourceRevision,
      artifactSetDigest: plan.actualDigest,
    },
    controlManifestBytes: Buffer.from(stringify(publicationManifest), "utf8"),
  };
}

async function tree(root: string): Promise<string> {
  const rows: string[] = [];
  async function visit(path: string, prefix = ""): Promise<void> {
    for (const entry of (await readdir(path)).sort()) {
      const child = join(path, entry);
      const rel = `${prefix}${entry}`;
      const stat = await lstat(child);
      if (stat.isDirectory()) {
        rows.push(`dir:${rel}:${stat.mode & 0o777}`);
        await visit(child, `${rel}/`);
      } else {
        rows.push(`file:${rel}:${stat.mode & 0o777}:${(await readFile(child)).toString("hex")}`);
      }
    }
  }
  await visit(root);
  return rows.join("\n");
}

async function seedRuntime(root: string, version: string, history = version): Promise<void> {
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(join(root, "bin", "runtime.js"), version, "utf8");
  await mkdir(join(root, ".ut-tdd", "history"), { recursive: true });
  await writeFile(join(root, ".ut-tdd", "history", "releases"), history, "utf8");
}

describe("consumer-local runtime admission", () => {
  it("U-PACKISO-001: sealed artifactだけでsource不在のfresh consumerをadmitできる", async () => {
    const [a, b] = await Promise.all([fixture("product-a", "v1"), fixture("product-b", "v2")]);
    const writes: string[] = [];
    const install = (input: ConsumerLocalRuntimeAdmissionInput) =>
      installConsumerLocalRuntime(input, {
        snapshotDestination: async () => [],
        writeStaging: async () => ({}),
        applyDestination: async () => {
          writes.push(input.consumerRoot);
          await mkdir(join(input.consumerRoot, "bin"), { recursive: true });
          await writeFile(
            join(input.consumerRoot, "bin", "runtime.js"),
            input.plan.entries[0].content,
            "utf8",
          );
          await mkdir(join(input.runtimeRoot, "history"), { recursive: true });
          await writeFile(join(input.runtimeRoot, "config.json"), input.productId, "utf8");
        },
        discardStaging: async () => undefined,
        restoreDestination: async () => undefined,
      });
    const [aResult, bResult] = await Promise.all([install(a), install(b)]);
    expect(aResult.ok).toBe(true);
    expect(bResult.ok).toBe(true);
    expect(writes).toEqual(expect.arrayContaining([a.consumerRoot, b.consumerRoot]));
    expect(new Set(writes).size).toBe(2);
    expect(aResult.ok && bResult.ok ? aResult.admission.runtimeRoot : null).not.toBe(
      bResult.ok && aResult.ok ? bResult.admission.runtimeRoot : null,
    );
    expect(children).toHaveLength(0);
    for (const input of [a, b]) {
      await expect(lstat(join(input.consumerRoot, "source-repo"))).rejects.toThrow();
      await expect(lstat(join(input.consumerRoot, "source-worktree"))).rejects.toThrow();
      await expect(lstat(join(input.consumerRoot, "local-pack-checkout"))).rejects.toThrow();
      expect(await tree(input.consumerRoot)).not.toContain("source-repo");
      expect(await readFile(join(input.consumerRoot, "bin", "runtime.js"), "utf8")).toBe(
        input.productId === "product-a" ? "v1" : "v2",
      );
    }
    if (aResult.ok) {
      const before = aResult.admission.plan.entries[0].content;
      before[0] ^= 0xff;
      expect(aResult.admission.plan.entries[0].content).not.toEqual(before);
      expect(new TextDecoder().decode(aResult.admission.plan.entries[0].content)).toBe("v1");
    }
  });

  it("U-PACKISO-002: consumer/runtime root外への参照を拒否する", async () => {
    const input = await fixture("product-a");
    const result = admitConsumerLocalRuntime({
      ...input,
      runtimeRoot: join(input.consumerRoot, "..", "outside"),
    });
    expect(result).toMatchObject({ ok: false, error: "namespace_escape" });
  });

  it("U-PACKISO-002: runtime component layoutをproduct root内へ固定する", async () => {
    const input = await fixture("product-a");
    const result = admitConsumerLocalRuntime(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = Object.values(result.admission.layout);
    expect(Object.isFrozen(result.admission.layout)).toBe(true);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.every((path) => path.startsWith(result.admission.runtimeRoot))).toBe(true);
    expect(paths.every((path) => path.startsWith(result.admission.consumerRoot))).toBe(true);
    expect(() => {
      (result.admission.layout as { database: string }).database = join(
        input.consumerRoot,
        "other",
      );
    }).toThrow();
  });

  it("U-PACKISO-002: existing parent symlink/junction escapeを拒否する", async () => {
    const input = await fixture("product-a");
    const outside = await mkdtemp(join(tmpdir(), "ut-tdd-packiso-outside-"));
    roots.push(outside);
    const link = join(input.consumerRoot, "runtime-link");
    try {
      await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      throw new Error(`symlink/junction fixture unavailable: ${String(error)}`);
    }
    const result = admitConsumerLocalRuntime({ ...input, runtimeRoot: join(link, "state") });
    expect(result).toMatchObject({ ok: false, error: "namespace_escape" });
  });

  it("U-PACKISO-002: symlink aliasはphysical canonical rootへ正規化する", async () => {
    const input = await fixture("product-a");
    const aliasParent = await mkdtemp(join(tmpdir(), "ut-tdd-packiso-alias-"));
    roots.push(aliasParent);
    const alias = join(aliasParent, "product-a-alias");
    try {
      await symlink(input.consumerRoot, alias, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      throw new Error(`symlink/junction alias fixture unavailable: ${String(error)}`);
    }
    const result = admitConsumerLocalRuntime({
      ...input,
      consumerRoot: alias,
      runtimeRoot: join(alias, ".ut-tdd"),
      receipt: { ...input.receipt, consumerRoot: alias, runtimeRoot: join(alias, ".ut-tdd") },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const physicalRoot = realpathSync.native(input.consumerRoot);
      expect(result.admission.consumerRoot).toBe(physicalRoot);
      expect(result.admission.runtimeRoot).toBe(join(physicalRoot, ".ut-tdd"));
    }
  });

  it("U-PACKISO-002: Windows 8.3 short-name aliasもphysical canonical rootへ正規化する", async ({
    skip,
  }) => {
    const input = await fixture("product-a");
    if (process.platform !== "win32") {
      expect(admitConsumerLocalRuntime(input).ok).toBe(true);
      return;
    }
    const shortRoot = execFileSync(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/c", `for %I in (${input.consumerRoot}) do @echo %~sI`],
      { encoding: "utf8" },
    ).trim();
    expect(shortRoot.length).toBeGreaterThan(0);
    expect(isAbsolute(shortRoot)).toBe(true);
    const physicalRoot = realpathSync.native(input.consumerRoot);
    if (shortRoot.toLowerCase() === physicalRoot.toLowerCase()) skip();
    const result = admitConsumerLocalRuntime({
      ...input,
      consumerRoot: shortRoot,
      runtimeRoot: join(shortRoot, ".ut-tdd"),
      receipt: {
        ...input.receipt,
        consumerRoot: shortRoot,
        runtimeRoot: join(shortRoot, ".ut-tdd"),
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.admission.consumerRoot).toBe(physicalRoot);
  });

  it("U-PACKISO-003: A/Bのartifact identityとreceiptを独立に束縛する", async () => {
    const a = await fixture("product-a", "v1");
    const b = await fixture("product-b", "v2");
    const aResult = admitConsumerLocalRuntime(a);
    const bResult = admitConsumerLocalRuntime(b);
    expect(aResult.ok).toBe(true);
    expect(bResult.ok).toBe(true);
    expect(a.plan.releaseId).not.toBe(b.plan.releaseId);
    expect(a.plan.sourceRevision).not.toBe(b.plan.sourceRevision);
    expect(a.plan.actualDigest).not.toBe(b.plan.actualDigest);
  });

  it.each([
    [
      "materializer version",
      (input: ConsumerLocalRuntimeAdmissionInput) => ({
        ...input,
        manifest: { ...input.manifest, materializerVersion: "2" },
      }),
      "unknown_version",
    ],
    [
      "artifact digest",
      (input: ConsumerLocalRuntimeAdmissionInput) => ({
        ...input,
        manifest: { ...input.manifest, artifactSetDigest: `sha256:${"e".repeat(64)}` },
      }),
      "identity_mismatch",
    ],
    [
      "source revision",
      (input: ConsumerLocalRuntimeAdmissionInput) => ({
        ...input,
        manifest: { ...input.manifest, sourceRevision: "c".repeat(40) },
      }),
      "identity_mismatch",
    ],
    [
      "release id only",
      (input: ConsumerLocalRuntimeAdmissionInput) => ({
        ...input,
        plan: { ...input.plan, releaseId: `rel-sha256:${"f".repeat(64)}` },
        manifest: { ...input.manifest, releaseId: `rel-sha256:${"f".repeat(64)}` },
        receipt: { ...input.receipt, releaseId: `rel-sha256:${"f".repeat(64)}` },
      }),
      "identity_mismatch",
    ],
    [
      "coherent fake digest identity",
      (input: ConsumerLocalRuntimeAdmissionInput) => {
        const fakeDigest = `sha256:${"f".repeat(64)}`;
        const fakeSource = "c".repeat(40);
        const fakeRelease = deriveReleaseId("1", fakeSource, fakeDigest);
        return {
          ...input,
          plan: {
            ...input.plan,
            releaseId: fakeRelease,
            sourceRevision: fakeSource,
            expectedDigest: fakeDigest,
            actualDigest: fakeDigest,
          },
          manifest: {
            ...input.manifest,
            releaseId: fakeRelease,
            sourceRevision: fakeSource,
            artifactSetDigest: fakeDigest,
          },
          receipt: {
            ...input.receipt,
            releaseId: fakeRelease,
            sourceRevision: fakeSource,
            artifactSetDigest: fakeDigest,
          },
        };
      },
      "identity_mismatch",
    ],
    [
      "receipt reuse",
      (input: ConsumerLocalRuntimeAdmissionInput) => ({
        ...input,
        receipt: {
          ...input.receipt,
          productId: "product-b",
          consumerRoot: "C:\\outside-b",
          runtimeRoot: "C:\\outside-b\\.ut-tdd",
        },
      }),
      "identity_mismatch",
    ],
  ])("U-PACKISO-003: %s単独mutationを拒否する", async (_name, mutate, error) => {
    const input = await fixture("product-a", "v1");
    expect(admitConsumerLocalRuntime(mutate(input))).toMatchObject({ ok: false, error });
  });

  it("U-PACKISO-004: Aのupgrade中もBのruntime process identityを変更しない", async () => {
    const input = await fixture("product-a", "v2");
    await seedRuntime(input.consumerRoot, "v1");
    const aBefore = await tree(input.consumerRoot);
    const bInput = await fixture("product-b", "v1");
    await mkdir(join(bInput.runtimeRoot, "state"), { recursive: true });
    await writeFile(join(bInput.runtimeRoot, "state", "receipt"), "b-v1", "utf8");
    const bBefore = await tree(bInput.consumerRoot);
    const b = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: bInput.consumerRoot,
      stdio: "ignore",
    });
    await once(b, "spawn");
    children.push(b);
    const pid = b.pid;
    const admitted = admitConsumerLocalRuntime(input);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    const applied = await applyConsumerLocalRuntime(admitted.admission, {
      snapshotDestination: async () => [],
      writeStaging: async (plan) => ({ root: input.runtimeRoot, plan }),
      applyDestination: async () => {
        await mkdir(input.runtimeRoot, { recursive: true });
        await writeFile(join(input.consumerRoot, "bin", "runtime.js"), "v2", "utf8");
      },
      discardStaging: async () => undefined,
      restoreDestination: async () => undefined,
    });
    expect(applied).toMatchObject({ ok: true, applied: 1 });
    expect(b.pid).toBe(pid);
    expect(b.exitCode).toBeNull();
    expect(pid).toBeDefined();
    expect(() => process.kill(pid as number, 0)).not.toThrow();
    expect(await tree(bInput.consumerRoot)).toBe(bBefore);
    expect(await tree(input.consumerRoot)).not.toBe(aBefore);
    expect(await readFile(join(input.consumerRoot, "bin", "runtime.js"), "utf8")).toBe("v2");
  });

  it("U-PACKISO-005: Aのrollback中もBを停止・再起動しない", async () => {
    const input = await fixture("product-a", "v1");
    await seedRuntime(input.consumerRoot, "v2", "v2");
    const aBefore = await tree(input.consumerRoot);
    const bInput = await fixture("product-b", "v2");
    await mkdir(join(bInput.runtimeRoot, "state"), { recursive: true });
    await writeFile(join(bInput.runtimeRoot, "state", "receipt"), "b-v2", "utf8");
    const bBefore = await tree(bInput.consumerRoot);
    const b = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: bInput.consumerRoot,
      stdio: "ignore",
    });
    await once(b, "spawn");
    children.push(b);
    const pid = b.pid;
    const admitted = admitConsumerLocalRuntime(input);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    const result = await applyConsumerLocalRuntime(admitted.admission, {
      snapshotDestination: async () => [],
      writeStaging: async () => ({ root: input.runtimeRoot }),
      applyDestination: async () => {
        await writeFile(join(input.consumerRoot, "bin", "runtime.js"), "v1", "utf8");
        await writeFile(
          join(input.consumerRoot, ".ut-tdd", "history", "releases"),
          "v2\nrollback->v1",
          "utf8",
        );
      },
      discardStaging: async () => undefined,
      restoreDestination: async () => undefined,
    });
    expect(result).toMatchObject({ ok: true, applied: 1 });
    expect(b.pid).toBe(pid);
    expect(b.exitCode).toBeNull();
    expect(pid).toBeDefined();
    expect(() => process.kill(pid as number, 0)).not.toThrow();
    expect(await tree(bInput.consumerRoot)).toBe(bBefore);
    expect(await tree(input.consumerRoot)).not.toBe(aBefore);
    expect(await readFile(join(input.consumerRoot, "bin", "runtime.js"), "utf8")).toBe("v1");
    expect(
      await readFile(join(input.consumerRoot, ".ut-tdd", "history", "releases"), "utf8"),
    ).toContain("rollback->v1");
  });

  it.each([
    ["writeStaging", { ok: false, error: "unavailable", applied: 0 }],
    ["applyDestination", { ok: false, error: "unavailable", applied: 0 }],
    ["discardStaging", { ok: false, error: "unavailable", applied: 0 }],
    ["restoreDestination", { ok: false, error: "rollback_failed", applied: "indeterminate" }],
  ])("U-PACKISO-004/005: %s faultでもBのprocess/treeを変更しない", async (fault, expected) => {
    const input = await fixture("product-a", "fault");
    await seedRuntime(input.consumerRoot, "v1");
    const aBefore = await tree(input.consumerRoot);
    const bInput = await fixture("product-b", "stable");
    await mkdir(join(bInput.runtimeRoot, "state"), { recursive: true });
    await writeFile(join(bInput.runtimeRoot, "state", "history"), "stable", "utf8");
    const bBefore = await tree(bInput.consumerRoot);
    const b = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: bInput.consumerRoot,
      stdio: "ignore",
    });
    await once(b, "spawn");
    children.push(b);
    const admitted = admitConsumerLocalRuntime(input);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    const applied = await applyConsumerLocalRuntime(admitted.admission, {
      snapshotDestination: async () => [],
      writeStaging: async () => {
        if (fault === "writeStaging") throw new Error("fault");
        return {};
      },
      applyDestination: async () => {
        if (fault === "applyDestination" || fault === "restoreDestination")
          await writeFile(join(input.consumerRoot, "bin", "runtime.js"), "v2", "utf8");
        if (fault === "applyDestination" || fault === "restoreDestination")
          throw new Error("fault");
      },
      discardStaging: async () => {
        if (fault === "discardStaging") throw new Error("fault");
      },
      restoreDestination: async () => {
        if (fault === "restoreDestination") throw new Error("fault");
        await writeFile(join(input.consumerRoot, "bin", "runtime.js"), "v1", "utf8");
      },
    });
    expect(applied).toMatchObject(expected);
    expect(() => process.kill(b.pid as number, 0)).not.toThrow();
    expect(await tree(bInput.consumerRoot)).toBe(bBefore);
    if (fault === "restoreDestination") {
      expect(await tree(input.consumerRoot)).not.toBe(aBefore);
    } else {
      expect(await tree(input.consumerRoot)).toBe(aBefore);
    }
  });

  it.each([
    [
      "artifact unavailable",
      (input: ConsumerLocalRuntimeAdmissionInput) => ({
        ...input,
        plan: { ...input.plan, entries: [] },
      }),
      "artifact_unavailable",
    ],
    [
      "artifact digest mismatch",
      (input: ConsumerLocalRuntimeAdmissionInput) => ({
        ...input,
        plan: { ...input.plan, actualDigest: `sha256:${"c".repeat(64)}` },
      }),
      "identity_mismatch",
    ],
    [
      "manifest receipt digest spoof",
      (input: ConsumerLocalRuntimeAdmissionInput) => ({
        ...input,
        plan: {
          ...input.plan,
          expectedDigest: `sha256:${"d".repeat(64)}`,
          actualDigest: `sha256:${"d".repeat(64)}`,
        },
        manifest: { ...input.manifest, artifactSetDigest: `sha256:${"d".repeat(64)}` },
        receipt: { ...input.receipt, artifactSetDigest: `sha256:${"d".repeat(64)}` },
      }),
      "identity_mismatch",
    ],
    [
      "unknown materializer",
      (input: ConsumerLocalRuntimeAdmissionInput) => ({
        ...input,
        manifest: { ...input.manifest, materializerVersion: "unknown" },
      }),
      "unknown_version",
    ],
    [
      "symlink escape",
      (input: ConsumerLocalRuntimeAdmissionInput) => ({
        ...input,
        plan: {
          ...input.plan,
          entries: [
            {
              path: "escape",
              mode: "120000" as const,
              content: new TextEncoder().encode("../../outside"),
            },
          ],
        },
      }),
      "namespace_escape",
    ],
    [
      "receipt mismatch",
      (input: ConsumerLocalRuntimeAdmissionInput) => ({
        ...input,
        receipt: { ...input.receipt, runtimeRoot: join(input.consumerRoot, "other-runtime") },
      }),
      "receipt_mismatch",
    ],
  ])("U-PACKISO-006: %sは導入前にfail-closeしwrite 0", async (_name, mutate, error) => {
    const input = mutate(await fixture("product-a"));
    const ports = {
      snapshotDestination: vi.fn(async () => []),
      writeStaging: vi.fn(async () => 0),
      applyDestination: vi.fn(async () => undefined),
      discardStaging: vi.fn(async () => undefined),
      restoreDestination: vi.fn(async () => undefined),
    };
    const result = await installConsumerLocalRuntime(input, ports);
    expect(result).toMatchObject({ ok: false, error });
    expect(ports.snapshotDestination).toHaveBeenCalledTimes(0);
    expect(ports.writeStaging).toHaveBeenCalledTimes(0);
    expect(ports.applyDestination).toHaveBeenCalledTimes(0);
    expect(ports.discardStaging).toHaveBeenCalledTimes(0);
    expect(ports.restoreDestination).toHaveBeenCalledTimes(0);
  });

  it.each([
    [
      "namespace escape",
      (input: ConsumerLocalRuntimeAdmissionInput) => ({
        ...input,
        runtimeRoot: join(input.consumerRoot, "..", "outside"),
      }),
      "namespace_escape",
    ],
    [
      "release identity mismatch",
      (input: ConsumerLocalRuntimeAdmissionInput) => ({
        ...input,
        plan: { ...input.plan, releaseId: `rel-sha256:${"f".repeat(64)}` },
      }),
      "identity_mismatch",
    ],
    [
      "artifact identity mismatch",
      (input: ConsumerLocalRuntimeAdmissionInput) => ({
        ...input,
        manifest: { ...input.manifest, artifactSetDigest: `sha256:${"e".repeat(64)}` },
      }),
      "identity_mismatch",
    ],
    [
      "receipt identity mismatch",
      (input: ConsumerLocalRuntimeAdmissionInput) => ({
        ...input,
        receipt: { ...input.receipt, sourceRevision: "b".repeat(40) },
      }),
      "identity_mismatch",
    ],
    [
      "independently recomputed digest mismatch",
      (input: ConsumerLocalRuntimeAdmissionInput) => ({
        ...input,
        plan: {
          ...input.plan,
          entries: [
            {
              ...input.plan.entries[0],
              content: new TextEncoder().encode("mutated-artifact"),
            },
          ],
        },
      }),
      "identity_mismatch",
    ],
    [
      "artifact unavailable",
      (input: ConsumerLocalRuntimeAdmissionInput) => ({
        ...input,
        plan: { ...input.plan, entries: [] },
      }),
      "artifact_unavailable",
    ],
    [
      "unknown version",
      (input: ConsumerLocalRuntimeAdmissionInput) => ({
        ...input,
        manifest: { ...input.manifest, materializerVersion: "2" },
      }),
      "unknown_version",
    ],
    [
      "invalid input",
      () => ({ productId: "product-a", consumerRoot: null, runtimeRoot: null }),
      "invalid_artifact",
    ],
  ])("U-PACKISO-007: %sはdeny branchで全composition portを0回にする", async (_name, mutate, error) => {
    const input = await fixture("product-a", "v1");
    await seedRuntime(input.consumerRoot, "prior-v1", "prior-v1");
    const before = await tree(input.consumerRoot);
    const ports = {
      snapshotDestination: vi.fn(async () => []),
      writeStaging: vi.fn(async () => ({})),
      applyDestination: vi.fn(async () => undefined),
      discardStaging: vi.fn(async () => undefined),
      restoreDestination: vi.fn(async () => undefined),
    };
    const result = await installConsumerLocalRuntime(
      mutate(input) as ConsumerLocalRuntimeAdmissionInput,
      ports,
    );

    expect(result).toMatchObject({ ok: false, phase: "admission", error });
    expect(ports.snapshotDestination).toHaveBeenCalledTimes(0);
    expect(ports.writeStaging).toHaveBeenCalledTimes(0);
    expect(ports.applyDestination).toHaveBeenCalledTimes(0);
    expect(ports.discardStaging).toHaveBeenCalledTimes(0);
    expect(ports.restoreDestination).toHaveBeenCalledTimes(0);
    expect(await tree(input.consumerRoot)).toBe(before);
  });

  it("U-PACKISO-007: non-string receipt roots are typed identity mismatches before composition", async () => {
    for (const key of ["consumerRoot", "runtimeRoot"] as const) {
      const input = await fixture("product-a", "v1");
      await seedRuntime(input.consumerRoot, "prior-v1", "prior-v1");
      const before = await tree(input.consumerRoot);
      const ports = {
        snapshotDestination: vi.fn(async () => []),
        writeStaging: vi.fn(async () => ({})),
        applyDestination: vi.fn(async () => undefined),
        discardStaging: vi.fn(async () => undefined),
        restoreDestination: vi.fn(async () => undefined),
      };
      const candidate = {
        ...input,
        receipt: { ...input.receipt, [key]: null },
      } as unknown as ConsumerLocalRuntimeAdmissionInput;
      const result = await installConsumerLocalRuntime(candidate, ports);
      expect(result).toMatchObject({ ok: false, phase: "admission", error: "identity_mismatch" });
      expect(ports.snapshotDestination).toHaveBeenCalledTimes(0);
      expect(ports.writeStaging).toHaveBeenCalledTimes(0);
      expect(ports.applyDestination).toHaveBeenCalledTimes(0);
      expect(ports.discardStaging).toHaveBeenCalledTimes(0);
      expect(ports.restoreDestination).toHaveBeenCalledTimes(0);
      expect(await tree(input.consumerRoot)).toBe(before);
    }
  });

  it("U-PACKISO-004/005: PF5 apply failureはtop-level fail-closeへflattenする", async () => {
    const input = await fixture("product-a");
    const result = await installConsumerLocalRuntime(input, {
      snapshotDestination: async () => [],
      writeStaging: async () => {
        throw new Error("fault");
      },
      applyDestination: async () => undefined,
      discardStaging: async () => undefined,
      restoreDestination: async () => undefined,
    });
    expect(result).toMatchObject({ ok: false, phase: "apply", error: "unavailable", applied: 0 });
  });
});
