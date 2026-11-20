import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildConsumerNodeRuntimeBundle,
  buildConsumerNodeRuntimePayloads,
  type ConsumerNodeRuntimeBundle,
  type ConsumerNodeRuntimeIdentity,
  type ConsumerNodeRuntimePayloads,
  canonicalJson,
  digestConsumerRuntimeBytes,
  digestConsumerRuntimeValue,
  validateConsumerNodeRuntimeBundle,
} from "../../src/setup/consumer-node-runtime.ts";
import { verifyConsumerRuntimeReleaseAssets } from "../../src/setup/consumer-runtime-release.ts";
import {
  activeCompiledEsmPath,
  type ConsumerWorktreeRuntimeFixture,
  runConsumerWorktreeCommand,
  runtimeIdentity,
  WORKTREE_RUNTIME_TAG_B,
} from "./consumer-worktree-runtime.ts";
import { heavyAfterAll } from "./hook-bounds.ts";
import { removeFixtureTree } from "./pack-consumer-runtime.ts";

interface MalformedActiveFixture {
  readonly root: string;
  readonly main: string;
  readonly target: string;
  readonly cacheRoot: string;
  readonly releaseId: string;
  readonly identity: ConsumerNodeRuntimeIdentity;
  readonly payloads: ConsumerNodeRuntimePayloads;
  readonly validBundle: ConsumerNodeRuntimeBundle;
  readonly bundle: ConsumerNodeRuntimeBundle;
}

const malformedFixtures: MalformedActiveFixture[] = [];
const malformedFixtureRoots: string[] = [];

function malformedReleaseIds(releaseId: string): readonly string[] {
  const hash = releaseId.slice("rel-sha256:".length);
  return [
    `bad-sha256:${hash}`,
    `rel-sha256:${hash.slice(0, -1)}`,
    `rel-sha256:A${hash.slice(1)}`,
    `rel-sha256:${hash.slice(0, 32)}/${hash.slice(33)}`,
  ];
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function rebindPayloadsToIdentity(
  payloads: ConsumerNodeRuntimePayloads,
  identity: ConsumerNodeRuntimeIdentity,
): ConsumerNodeRuntimePayloads {
  const identityDigest = digestConsumerRuntimeValue(identity);
  const { operation_id: _operationId, attempt: _attempt, ...generationIdentity } = identity;
  const generationIdentityDigest = digestConsumerRuntimeValue(generationIdentity);
  const marker = JSON.parse(Buffer.from(payloads.marker).toString("utf8")) as Record<
    string,
    unknown
  >;
  marker.identity_digest = identityDigest;
  const receipt = JSON.parse(Buffer.from(payloads.consumer_receipt).toString("utf8")) as Record<
    string,
    unknown
  >;
  const consumer = receipt.consumer as Record<string, unknown>;
  consumer.releaseId = identity.release_id;
  receipt.identity_digest = identityDigest;
  const record = JSON.parse(Buffer.from(payloads.history).toString("utf8")) as Record<
    string,
    unknown
  >;
  const { record_digest: _recordDigest, ...unsignedRecord } = record;
  const reboundRecord = {
    ...unsignedRecord,
    identity_digest: identityDigest,
    generation_identity_digest: generationIdentityDigest,
  };
  const historyTipDigest = digestConsumerRuntimeValue(reboundRecord);
  receipt.history_tip_digest = historyTipDigest;
  const history = Buffer.from(
    `${canonicalJson({ ...reboundRecord, record_digest: historyTipDigest })}\n`,
    "utf8",
  );
  const operation = JSON.parse(Buffer.from(payloads.operation_state).toString("utf8")) as Record<
    string,
    unknown
  >;
  operation.identity_digest = identityDigest;
  operation.history_tip_digest = historyTipDigest;
  return {
    ...payloads,
    marker: Buffer.from(`${canonicalJson(marker)}\n`, "utf8"),
    consumer_receipt: Buffer.from(`${canonicalJson(receipt)}\n`, "utf8"),
    history,
    operation_state: Buffer.from(`${canonicalJson(operation)}\n`, "utf8"),
  };
}

function buildMalformedBundle(
  identity: ConsumerNodeRuntimeIdentity,
  payloads: ConsumerNodeRuntimePayloads,
  validBundle: ConsumerNodeRuntimeBundle,
): ConsumerNodeRuntimeBundle {
  const files = {
    "ut-tdd.mjs": digestConsumerRuntimeBytes(payloads.compiled_esm),
    "node-bootstrap-receipt.json": digestConsumerRuntimeBytes(payloads.node_bootstrap_receipt),
    "marker.json": digestConsumerRuntimeBytes(payloads.marker),
    "consumer-receipt.json": digestConsumerRuntimeBytes(payloads.consumer_receipt),
    "history.jsonl": digestConsumerRuntimeBytes(payloads.history),
    "operation-state.json": digestConsumerRuntimeBytes(payloads.operation_state),
  };
  const digest = digestConsumerRuntimeValue({
    identity,
    files,
    history_sequence: validBundle.history_sequence,
    prior_bundle_digest: validBundle.prior_bundle_digest,
    prior_history_tip_digest: validBundle.prior_history_tip_digest,
  });
  const bundlePath = resolve(
    identity.runtime_root,
    "bundles",
    identity.operation_id,
    `attempt-${identity.attempt}-${digest.slice("sha256:".length)}`,
  );
  return {
    identity,
    bundle_digest: digest,
    bundle_path: bundlePath,
    files,
    history_sequence: validBundle.history_sequence,
    prior_bundle_digest: validBundle.prior_bundle_digest,
    prior_history_tip_digest: validBundle.prior_history_tip_digest,
  };
}

function createMalformedActiveFixture(
  seedIdentity: Record<string, string>,
  validReleaseId: string,
  releaseId: string,
  compiledEsm: Buffer,
  nodeBootstrapReceipt: Buffer,
): MalformedActiveFixture {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ut-tdd-cwtrt-010-invalid-id-")));
  malformedFixtureRoots.push(root);
  const main = join(root, "main");
  const target = join(root, "linked");
  mkdirSync(main, { recursive: true });
  git(root, ["init", "-q", "-b", "main", main]);
  git(main, ["config", "user.email", "test@example.invalid"]);
  git(main, ["config", "user.name", "UT-TDD malformed identity fixture"]);
  writeFileSync(join(main, "README.md"), "# malformed active identity fixture\n");
  writeFileSync(
    join(main, "ut-tdd.project.json"),
    readFileSync(join(seedIdentity.consumer_root, "ut-tdd.project.json")),
  );
  git(main, ["add", "README.md", "ut-tdd.project.json"]);
  git(main, ["commit", "-qm", "test: create malformed identity fixture"]);
  git(main, ["worktree", "add", "-q", "-b", "candidate-010-invalid-id", target, "HEAD"]);

  const runtimeRoot = join(main, ".ut-tdd", "runtime");
  const validIdentity = {
    ...seedIdentity,
    consumer_root: main,
    runtime_root: runtimeRoot,
    release_id: validReleaseId,
  } as ConsumerNodeRuntimeIdentity;
  const validPayloads = buildConsumerNodeRuntimePayloads({
    identity: validIdentity,
    compiled_esm: compiledEsm,
    node_bootstrap_receipt: nodeBootstrapReceipt,
  });
  const validBundle = buildConsumerNodeRuntimeBundle({
    identity: validIdentity,
    ...validPayloads,
  });
  const identity = { ...validIdentity, release_id: releaseId };
  const payloads = rebindPayloadsToIdentity(validPayloads, identity);
  const bundle = buildMalformedBundle(identity, payloads, validBundle);
  const bundlePath = bundle.bundle_path;
  const entryPath = join(bundlePath, "ut-tdd.mjs");
  // Unsealed by design: this isolates release_id schema rejection from sealed-runtime custody.
  mkdirSync(bundlePath, { recursive: true });
  for (const [name, bytes] of Object.entries(payloads))
    writeFileSync(join(bundlePath, name), bytes);
  writeFileSync(
    join(bundlePath, "bundle-manifest.json"),
    `${canonicalJson({
      ...bundle,
    })}\n`,
  );
  const pointerPath = join(runtimeRoot, "activation", "active.json");
  mkdirSync(dirname(pointerPath), { recursive: true });
  writeFileSync(
    pointerPath,
    `${canonicalJson({ bundle_digest: bundle.bundle_digest, bundle_path: bundlePath, entry_path: entryPath })}\n`,
  );
  const commonDir = resolve(main, git(main, ["rev-parse", "--git-common-dir"]));
  return {
    root,
    main,
    target,
    cacheRoot: join(commonDir, "ut-tdd", "runtime-cache"),
    releaseId,
    identity,
    payloads,
    validBundle,
    bundle,
  };
}

export function snapshotTree(path: string): string {
  return JSON.stringify(
    readdirSync(path, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) =>
        entry.isSymbolicLink()
          ? [entry.name, ["symlink", readlinkSync(join(path, entry.name))]]
          : entry.isDirectory()
            ? [entry.name, snapshotTree(join(path, entry.name))]
            : [entry.name, readFileSync(join(path, entry.name)).toString("hex")],
      ),
  );
}

function replaceCacheWithRelease(cache: string, release: string): void {
  rmSync(cache, { recursive: true, force: true });
  mkdirSync(cache, { recursive: true });
  for (const name of readdirSync(release))
    writeFileSync(join(cache, name), readFileSync(join(release, name)));
}

export function registerConsumerWorktreeRuntime010Tests(
  getFixture: () => ConsumerWorktreeRuntimeFixture,
): void {
  heavyAfterAll("teardown", () => {
    for (const root of malformedFixtureRoots.splice(0)) removeFixtureTree(root);
    malformedFixtures.splice(0);
  });

  it("prerequisite: cache A/B, Windows-safe key path, and six independent targets are valid", () => {
    const fixture = getFixture();
    const commonDirResult = spawnSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: fixture.main,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    expect(commonDirResult.status, commonDirResult.stderr).toBe(0);
    const commonDir = resolve(fixture.main, commonDirResult.stdout.trim());
    expect(fixture.cache).toBe(
      join(commonDir, "ut-tdd", "runtime-cache", fixture.releaseId.slice("rel-sha256:".length)),
    );
    expect(basename(fixture.cache)).toMatch(/^[0-9a-f]{64}$/);
    expect(basename(fixture.cache)).not.toContain(":");
    expect(snapshotTree(fixture.cache)).toBe(snapshotTree(fixture.release));
    expect(snapshotTree(fixture.cacheB)).toBe(snapshotTree(fixture.releaseB));
    expect(fixture.releaseId).not.toBe(fixture.releaseIdB);
    for (const id of ["010-a", "010-prefix", "010-length", "010-upper", "010-separator", "010-b"])
      expect(statSync(join(fixture.linked[id], ".git")).isFile()).toBe(true);

    const [prefix, length, uppercase, separator] = malformedReleaseIds(fixture.releaseId);
    expect(new Set(malformedReleaseIds(fixture.releaseId)).size).toBe(4);
    expect(prefix).toMatch(/^bad-sha256:[0-9a-f]{64}$/);
    expect(length).toMatch(/^rel-sha256:[0-9a-f]{63}$/);
    expect(uppercase).toMatch(/^rel-sha256:A[0-9a-f]{63}$/);
    expect(separator).toMatch(/^rel-sha256:[0-9a-f]{32}\/[0-9a-f]{31}$/);
  });

  it("prerequisite: malformed release IDs start active in isolated unsealed repos", () => {
    const fixture = getFixture();
    const releaseIds = malformedReleaseIds(fixture.releaseId);
    expect(new Set(releaseIds).size).toBe(4);
    expect(malformedFixtures).toHaveLength(0);
    const seedPointer = JSON.parse(
      readFileSync(join(fixture.main, ".ut-tdd", "runtime", "activation", "active.json"), "utf8"),
    ) as { bundle_path: string };
    const compiledEsm = readFileSync(activeCompiledEsmPath(fixture.main));
    const nodeBootstrapReceipt = readFileSync(
      join(seedPointer.bundle_path, "node-bootstrap-receipt.json"),
    );
    for (const releaseId of releaseIds) {
      if (!releaseId) throw new Error("malformed release ID fixture is missing");
      const malformed = createMalformedActiveFixture(
        runtimeIdentity(fixture.main),
        fixture.releaseId,
        releaseId,
        compiledEsm,
        nodeBootstrapReceipt,
      );
      malformedFixtures.push(malformed);
      const pointerPath = join(malformed.main, ".ut-tdd", "runtime", "activation", "active.json");
      const pointer = JSON.parse(readFileSync(pointerPath, "utf8")) as Record<string, unknown>;
      const manifestPath = join(String(pointer.bundle_path), "bundle-manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      expect((manifest.identity as Record<string, unknown>).release_id).toBe(releaseId);
      expect(validateConsumerNodeRuntimeBundle(malformed.validBundle)).toBeNull();
      expect(validateConsumerNodeRuntimeBundle(malformed.bundle)).toBe(
        "consumer_runtime_identity_mismatch",
      );
      expect({ ...malformed.identity, release_id: fixture.releaseId }).toEqual(
        malformed.validBundle.identity,
      );
      expect(pointer.entry_path).toBe(join(String(pointer.bundle_path), "ut-tdd.mjs"));
      expect(manifest.bundle_path).toBe(pointer.bundle_path);
      expect(manifest.bundle_digest).toBe(pointer.bundle_digest);
      expect(manifest.bundle_digest).toBe(
        digestConsumerRuntimeValue({
          identity: manifest.identity,
          files: manifest.files,
          history_sequence: manifest.history_sequence,
          prior_bundle_digest: manifest.prior_bundle_digest,
          prior_history_tip_digest: manifest.prior_history_tip_digest,
        }),
      );
      const identityDigest = digestConsumerRuntimeValue(malformed.identity);
      const marker = JSON.parse(Buffer.from(malformed.payloads.marker).toString("utf8")) as Record<
        string,
        unknown
      >;
      const consumerReceipt = JSON.parse(
        Buffer.from(malformed.payloads.consumer_receipt).toString("utf8"),
      ) as Record<string, unknown>;
      const consumer = consumerReceipt.consumer as Record<string, unknown>;
      const historyRecord = JSON.parse(
        Buffer.from(malformed.payloads.history).toString("utf8"),
      ) as Record<string, unknown>;
      const operationState = JSON.parse(
        Buffer.from(malformed.payloads.operation_state).toString("utf8"),
      ) as Record<string, unknown>;
      const {
        operation_id: _operationId,
        attempt: _attempt,
        ...generationIdentity
      } = malformed.identity;
      const { record_digest: _recordDigest, ...unsignedRecord } = historyRecord;
      expect(marker.identity_digest).toBe(identityDigest);
      expect(consumerReceipt.identity_digest).toBe(identityDigest);
      expect(consumer.releaseId).toBe(releaseId);
      expect(consumer.consumerRoot).toBe(malformed.identity.consumer_root);
      expect(consumer.runtimeRoot).toBe(malformed.identity.runtime_root);
      expect(historyRecord.identity_digest).toBe(identityDigest);
      expect(historyRecord.generation_identity_digest).toBe(
        digestConsumerRuntimeValue(generationIdentity),
      );
      expect(historyRecord.record_digest).toBe(digestConsumerRuntimeValue(unsignedRecord));
      expect(consumerReceipt.history_tip_digest).toBe(historyRecord.record_digest);
      expect(operationState.identity_digest).toBe(identityDigest);
      expect(operationState.history_tip_digest).toBe(historyRecord.record_digest);
      expect(existsSync(malformed.cacheRoot)).toBe(false);
      expect(statSync(join(malformed.target, ".git")).isFile()).toBe(true);
      expect(existsSync(join(malformed.target, ".ut-tdd"))).toBe(false);
      for (const [name, digest] of Object.entries(malformed.bundle.files)) {
        const payload = {
          "ut-tdd.mjs": malformed.payloads.compiled_esm,
          "node-bootstrap-receipt.json": malformed.payloads.node_bootstrap_receipt,
          "marker.json": malformed.payloads.marker,
          "consumer-receipt.json": malformed.payloads.consumer_receipt,
          "history.jsonl": malformed.payloads.history,
          "operation-state.json": malformed.payloads.operation_state,
        }[name];
        if (!payload) throw new Error(`bundle payload is missing: ${name}`);
        expect(digestConsumerRuntimeBytes(payload)).toBe(digest);
      }
    }
  });

  it("U-CWTRT-010: installs A through its lowercase hex cache key", () => {
    const fixture = getFixture();
    const target = fixture.linked["010-a"];
    const cacheBefore = snapshotTree(dirname(fixture.cache));
    const targetBefore = snapshotTree(target);
    const result = runConsumerWorktreeCommand(fixture.main, ["setup", "--worktree", target]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(basename(fixture.cache)).toBe(fixture.releaseId.slice("rel-sha256:".length));
    expect(basename(fixture.cache)).not.toContain(":");
    expect(runtimeIdentity(target).release_id).toBe(fixture.releaseId);
    expect(snapshotTree(dirname(fixture.cache))).toBe(cacheBefore);
    expect(snapshotTree(target)).not.toBe(targetBefore);
  });

  for (const [targetId, malformedIndex] of [
    ["010-prefix", 0],
    ["010-length", 1],
    ["010-upper", 2],
    ["010-separator", 3],
  ] as const) {
    describe(targetId, () => {
      it("U-CWTRT-010: rejects malformed main release_id without cache aliasing", () => {
        const malformed = malformedFixtures[malformedIndex];
        if (!malformed) throw new Error("malformed active fixture is missing");
        const cacheRoot = malformed.cacheRoot;
        expect(existsSync(cacheRoot)).toBe(false);
        const target = malformed.target;
        const targetBefore = snapshotTree(target);
        const result = runConsumerWorktreeCommand(malformed.main, ["setup", "--worktree", target], {
          sourceCli: true,
        });
        expect(`${result.stdout}\n${result.stderr}`).toContain("worktree_entry_main_not_activated");
        expect(result.status).not.toBe(0);
        expect(existsSync(cacheRoot)).toBe(false);
        expect(snapshotTree(target)).toBe(targetBefore);
        expect(existsSync(join(target, ".ut-tdd", "bin", "ut-tdd.mjs"))).toBe(false);
        expect(existsSync(join(target, ".ut-tdd", "runtime", "activation", "active.json"))).toBe(
          false,
        );
      });
    });
  }

  it("U-CWTRT-010: rejects B under A's cache key and rolls back", () => {
    const fixture = getFixture();
    const bVerification = verifyConsumerRuntimeReleaseAssets({
      releaseDirectory: fixture.releaseB,
      tag: WORKTREE_RUNTIME_TAG_B,
      expectedConsumerDigest: fixture.anchorB,
      executingModulePath: activeCompiledEsmPath(fixture.main),
    });
    expect(bVerification.document.release.tag).toBe(WORKTREE_RUNTIME_TAG_B);
    expect(fixture.releaseIdB).not.toBe(fixture.releaseId);
    const cacheRoot = dirname(fixture.cache);
    const cacheBefore = snapshotTree(cacheRoot);
    const target = fixture.linked["010-b"];
    const targetBefore = snapshotTree(target);
    replaceCacheWithRelease(fixture.cache, fixture.releaseB);
    try {
      expect(snapshotTree(fixture.cache)).toBe(snapshotTree(fixture.releaseB));
      expect(snapshotTree(fixture.cacheB)).toBe(snapshotTree(fixture.releaseB));
      const result = runConsumerWorktreeCommand(fixture.main, ["setup", "--worktree", target]);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(
        /consumer_runtime_[a-z_]+|worktree_entry_pin_mismatch/,
      );
      expect(result.status).not.toBe(0);
      expect(snapshotTree(target)).toBe(targetBefore);
      expect(existsSync(join(target, ".ut-tdd", "bin", "ut-tdd.mjs"))).toBe(false);
      expect(existsSync(join(target, ".ut-tdd", "runtime", "activation", "active.json"))).toBe(
        false,
      );
    } finally {
      replaceCacheWithRelease(fixture.cache, fixture.release);
    }
    expect(snapshotTree(cacheRoot)).toBe(cacheBefore);
  });
}
