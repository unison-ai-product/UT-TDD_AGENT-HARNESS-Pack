import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyConsumerRuntimeReleaseAssets } from "../src/setup/consumer-runtime-release.ts";
import { releaseArtifactFileNames } from "../src/setup/distribution.ts";
import { admitReleaseAggregate as admitAggregate } from "../src/setup/release-aggregate-admission.ts";
import {
  activeCompiledEsmPath,
  cleanupConsumerWorktreeRuntimeFixture,
  createConsumerWorktreeRuntimeFixture,
  runConsumerWorktreeCommand,
  runtimeIdentity,
  WORKTREE_RUNTIME_TAG,
  WORKTREE_RUNTIME_TAG_B,
} from "./support/consumer-worktree-runtime.ts";
import {
  registerConsumerWorktreeRuntime010Tests,
  snapshotTree,
} from "./support/consumer-worktree-runtime-010.ts";
import { heavyAfterAll, heavyBeforeAll } from "./support/hook-bounds.ts";

let fixture: Awaited<ReturnType<typeof createConsumerWorktreeRuntimeFixture>>;

function snapshotOptionalPath(path: string): string | null {
  if (!existsSync(path)) return null;
  return statSync(path).isDirectory() ? snapshotTree(path) : readFileSync(path).toString("hex");
}

describe("consumer worktree runtime setup entry Red (#1525)", () => {
  heavyBeforeAll(["git", 300_000], async () => {
    fixture = await createConsumerWorktreeRuntimeFixture();
  });

  heavyAfterAll("teardown", () => cleanupConsumerWorktreeRuntimeFixture());

  it("prerequisite: main and both Releases are valid; candidate worktrees are linked", async () => {
    expect(existsSync(join(fixture.main, ".ut-tdd", "runtime", "activation", "active.json"))).toBe(
      true,
    );
    const executingModulePath = activeCompiledEsmPath(fixture.main);
    const releaseA = verifyConsumerRuntimeReleaseAssets({
      releaseDirectory: fixture.release,
      tag: WORKTREE_RUNTIME_TAG,
      expectedConsumerDigest: fixture.anchor,
      executingModulePath,
    }).document;
    const releaseB = verifyConsumerRuntimeReleaseAssets({
      releaseDirectory: fixture.releaseB,
      tag: WORKTREE_RUNTIME_TAG_B,
      expectedConsumerDigest: fixture.anchorB,
      executingModulePath,
    }).document;
    expect(releaseA.release.tag).toBe(WORKTREE_RUNTIME_TAG);
    expect(releaseB.release.tag).toBe(WORKTREE_RUNTIME_TAG_B);
    const attestedA = releaseA.admission_input.aggregate_input.attestation.entries[0];
    const attestedB = releaseB.admission_input.aggregate_input.attestation.entries[0];
    if (!attestedA || !attestedB) throw new Error("small Release fixture attestation is missing");
    const attestationBytesA = Buffer.from(attestedA.content_base64, "base64");
    const attestationBytesB = Buffer.from(attestedB.content_base64, "base64");
    const compiledEsmBytes = readFileSync(
      join(fixture.release, releaseArtifactFileNames(WORKTREE_RUNTIME_TAG).compiledEsm),
    );
    expect(attestationBytesA.length).toBeLessThan(100);
    expect(attestationBytesB.length).toBeLessThan(100);
    expect(compiledEsmBytes.length).toBeGreaterThan(attestationBytesA.length);
    expect(compiledEsmBytes).toEqual(readFileSync(executingModulePath));
    for (const release of [releaseA, releaseB]) {
      const aggregateInput = release.admission_input.aggregate_input;
      const attestation = aggregateInput.attestation;
      const result = await admitAggregate(
        {
          repository: aggregateInput.repository,
          channel: aggregateInput.channel,
          finalTree: aggregateInput.final_tree,
        },
        {
          attestChannel: async () => ({
            status: "attested",
            releaseId: attestation.releaseId,
            artifactSourceCommit: attestation.artifactSourceCommit,
            expectedDigest: attestation.expectedDigest,
            actualDigest: attestation.actualDigest,
            entries: attestation.entries.map((entry) => ({
              path: entry.path,
              mode: entry.mode,
              content: Buffer.from(entry.content_base64, "base64"),
            })),
          }),
        },
      );
      expect(result.ok).toBe(true);
    }
    expect(runtimeIdentity(fixture.linked["005-existing"]).release_id).toBe(fixture.releaseIdB);
    expect(readdirSync(fixture.cacheB).sort()).toEqual(readdirSync(fixture.releaseB).sort());
    for (const id of [
      "001",
      "002",
      "002-empty",
      "002-anchor",
      "002-b",
      "002-network",
      "003",
      "004",
      "005",
      "005-existing",
    ]) {
      const worktree = fixture.linked[id];
      expect(statSync(join(worktree, ".git")).isFile()).toBe(true);
      if (id !== "005-existing")
        expect(existsSync(join(worktree, ".ut-tdd", "bin", "ut-tdd.mjs"))).toBe(false);
    }
    expect(existsSync(fixture.cache)).toBe(true);
    expect(existsSync(fixture.networkStub)).toBe(true);
    expect(existsSync(fixture.networkMarker)).toBe(false);
  }, 240000); // 93s measured, #1063

  it("prerequisite: cache-missing, invalid-anchor, and explicit version-B cases are distinct", () => {
    const names = readdirSync(fixture.cache).sort();
    expect(names).toEqual(readdirSync(fixture.release).sort());
    expect(fixture.anchor).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(fixture.anchorB).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(() =>
      verifyConsumerRuntimeReleaseAssets({
        releaseDirectory: fixture.release,
        tag: WORKTREE_RUNTIME_TAG,
        expectedConsumerDigest: `sha256:${"0".repeat(64)}`,
        executingModulePath: activeCompiledEsmPath(fixture.main),
      }),
    ).toThrow("consumer_runtime_anchor_mismatch");
    rmSync(fixture.cache, { recursive: true, force: true });
    expect(existsSync(fixture.cache)).toBe(false);
    mkdirSync(fixture.cache, { recursive: true });
    for (const name of names)
      writeFileSync(join(fixture.cache, name), readFileSync(join(fixture.release, name)));
    expect(readdirSync(fixture.cache).sort()).toEqual(names);
  });

  it("prerequisite: network interception records and denies a fetch attempt", () => {
    const nodeOptions = [
      process.env.NODE_OPTIONS,
      `--require=${JSON.stringify(fixture.networkStub)}`,
    ]
      .filter(Boolean)
      .join(" ");
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        "if (!globalThis.__utNetworkDenyInstalled) process.exit(44); fetch('http://127.0.0.1:1')",
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          NODE_OPTIONS: nodeOptions,
          UT_TDD_NETWORK_MARKER: fixture.networkMarker,
        },
      },
    );
    expect(result.status).not.toBe(0);
    expect(readFileSync(fixture.networkMarker, "utf8")).toContain("attempt");
    rmSync(fixture.networkMarker);
  });

  it("prerequisite: rollback snapshot paths exist and are readable", () => {
    const paths = [
      fixture.linked["002-empty"],
      fixture.linked["002-anchor"],
      fixture.linked["002-b"],
      fixture.linked["003"],
      fixture.linked["005-existing"],
      join(fixture.main, ".ut-tdd"),
      dirname(fixture.cache),
    ];
    for (const path of paths) expect(existsSync(path), path).toBe(true);
    const snapshots = paths.map((path) => snapshotTree(path));
    expect(snapshots).toHaveLength(paths.length);
    expect(snapshots.every((snapshot) => typeof snapshot === "string")).toBe(true);
  });

  it("U-CWTRT-001: installs main's pin and runs a guard through the worktree launcher", () => {
    const worktree = fixture.linked["001"];
    const targetRegularSetupPaths = [
      join(worktree, ".ut-tdd", "harness.db"),
      join(worktree, ".claude", "settings.json"),
      join(worktree, ".claude", "hooks"),
      join(worktree, ".codex", "hooks.json"),
    ];
    // These are absent in this clean linked-worktree fixture, not assumed from a
    // generic consumer layout. Keep the precondition explicit before checking
    // that runtime-only setup does not materialize ordinary setup state.
    for (const path of targetRegularSetupPaths) expect(existsSync(path), path).toBe(false);

    const mainSetupPaths = [
      join(fixture.main, ".ut-tdd"),
      join(fixture.main, ".claude"),
      join(fixture.main, ".codex"),
      join(fixture.main, "AGENTS.md"),
      join(fixture.main, "CLAUDE.md"),
      join(fixture.main, "ut-tdd.project.json"),
    ];
    const mainBefore = mainSetupPaths.map(snapshotOptionalPath);
    const cacheBefore = snapshotTree(dirname(fixture.cache));

    const result = runConsumerWorktreeCommand(fixture.main, ["setup", "--worktree", worktree]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(join(worktree, ".ut-tdd", "bin", "ut-tdd.mjs"))).toBe(true);
    for (const path of targetRegularSetupPaths) expect(existsSync(path), path).toBe(false);
    expect(mainSetupPaths.map(snapshotOptionalPath)).toEqual(mainBefore);
    expect(snapshotTree(dirname(fixture.cache))).toBe(cacheBefore);
    const mainIdentity = runtimeIdentity(fixture.main);
    const installedIdentity = runtimeIdentity(worktree);
    expect(installedIdentity.release_id).toBe(mainIdentity.release_id);
    expect(installedIdentity.artifact_set_digest).toBe(mainIdentity.artifact_set_digest);
    expect(installedIdentity.compiled_esm_digest).toBe(mainIdentity.compiled_esm_digest);
    const guard = runConsumerWorktreeCommand(worktree, ["hook", "agent-guard"], {
      input: `${JSON.stringify({ tool_name: "Agent", tool_input: { subagent_type: "general-purpose", model: "sonnet" } })}\n`,
    });
    expect(guard.status, `${guard.stdout}\n${guard.stderr}`).toBe(0);
  });

  it("U-CWTRT-002: cache A succeeds without making any network call", () => {
    rmSync(fixture.networkMarker, { force: true });
    const nodeOptions = [
      process.env.NODE_OPTIONS,
      `--require=${JSON.stringify(fixture.networkStub)}`,
    ]
      .filter(Boolean)
      .join(" ");
    const result = runConsumerWorktreeCommand(
      fixture.main,
      ["setup", "--worktree", fixture.linked["002-network"]],
      {
        env: {
          NODE_OPTIONS: nodeOptions,
          UT_TDD_NETWORK_MARKER: fixture.networkMarker,
        },
      },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(fixture.networkMarker)).toBe(false);
    expect(runtimeIdentity(fixture.linked["002-network"]).release_id).toBe(fixture.releaseId);
  });

  it("U-CWTRT-002: accepts the explicit pinned Release when cache is absent", () => {
    const mainPointer = readFileSync(
      join(fixture.main, ".ut-tdd", "runtime", "activation", "active.json"),
    );
    const otherPointer = readFileSync(
      join(fixture.linked["005-existing"], ".ut-tdd", "runtime", "activation", "active.json"),
    );
    rmSync(fixture.cache, { recursive: true, force: true });
    try {
      const result = runConsumerWorktreeCommand(fixture.main, [
        "setup",
        "--worktree",
        fixture.linked["002"],
        "--consumer-runtime-release",
        fixture.release,
        "--expected-consumer-digest",
        fixture.anchor,
      ]);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(existsSync(join(fixture.linked["002"], ".ut-tdd", "bin", "ut-tdd.mjs"))).toBe(true);
      const mainIdentity = runtimeIdentity(fixture.main);
      const worktreeIdentity = runtimeIdentity(fixture.linked["002"]);
      expect(worktreeIdentity.release_id).toBe(mainIdentity.release_id);
      expect(worktreeIdentity.artifact_set_digest).toBe(mainIdentity.artifact_set_digest);
      expect(worktreeIdentity.compiled_esm_digest).toBe(mainIdentity.compiled_esm_digest);
      expect(
        readFileSync(join(fixture.main, ".ut-tdd", "runtime", "activation", "active.json")),
      ).toEqual(mainPointer);
      expect(
        readFileSync(
          join(fixture.linked["005-existing"], ".ut-tdd", "runtime", "activation", "active.json"),
        ),
      ).toEqual(otherPointer);
      expect(existsSync(fixture.cache)).toBe(false);
    } finally {
      mkdirSync(fixture.cache, { recursive: true });
      for (const name of readdirSync(fixture.release))
        writeFileSync(join(fixture.cache, name), readFileSync(join(fixture.release, name)));
    }
  });

  it("U-CWTRT-002: missing cache without an explicit Release returns cache_missing", () => {
    const cacheRoot = dirname(fixture.cache);
    const cacheBefore = snapshotTree(cacheRoot);
    const target = fixture.linked["002-empty"];
    const targetBefore = snapshotTree(target);
    rmSync(fixture.cache, { recursive: true, force: true });
    const cacheDuring = snapshotTree(cacheRoot);
    try {
      const result = runConsumerWorktreeCommand(fixture.main, ["setup", "--worktree", target]);
      expect(`${result.stdout}\n${result.stderr}`).toContain("worktree_entry_cache_missing");
      expect(result.status).not.toBe(0);
      expect(snapshotTree(cacheRoot)).toBe(cacheDuring);
      expect(snapshotTree(target)).toBe(targetBefore);
      expect(existsSync(join(fixture.linked["002-empty"], ".ut-tdd", "bin", "ut-tdd.mjs"))).toBe(
        false,
      );
      expect(
        existsSync(
          join(fixture.linked["002-empty"], ".ut-tdd", "runtime", "activation", "active.json"),
        ),
      ).toBe(false);
    } finally {
      mkdirSync(fixture.cache, { recursive: true });
      for (const name of readdirSync(fixture.release))
        writeFileSync(join(fixture.cache, name), readFileSync(join(fixture.release, name)));
    }
    expect(snapshotTree(cacheRoot)).toBe(cacheBefore);
  });

  it("U-CWTRT-002: explicit Release with an invalid anchor is rejected", () => {
    const cacheRoot = dirname(fixture.cache);
    const cacheBefore = snapshotTree(cacheRoot);
    const target = fixture.linked["002-anchor"];
    const targetBefore = snapshotTree(target);
    const mainStateBefore = snapshotTree(join(fixture.main, ".ut-tdd"));
    const otherBefore = snapshotTree(fixture.linked["005-existing"]);
    rmSync(fixture.cache, { recursive: true, force: true });
    const cacheDuring = snapshotTree(cacheRoot);
    try {
      const result = runConsumerWorktreeCommand(fixture.main, [
        "setup",
        "--worktree",
        target,
        "--consumer-runtime-release",
        fixture.release,
        "--expected-consumer-digest",
        `sha256:${"0".repeat(64)}`,
      ]);
      expect(`${result.stdout}\n${result.stderr}`).toContain("consumer_runtime_anchor_mismatch");
      expect(result.status).not.toBe(0);
      expect(snapshotTree(cacheRoot)).toBe(cacheDuring);
      expect(snapshotTree(target)).toBe(targetBefore);
      expect(snapshotTree(join(fixture.main, ".ut-tdd"))).toBe(mainStateBefore);
      expect(snapshotTree(fixture.linked["005-existing"])).toBe(otherBefore);
      expect(existsSync(join(fixture.linked["002-anchor"], ".ut-tdd", "bin", "ut-tdd.mjs"))).toBe(
        false,
      );
      expect(
        existsSync(
          join(fixture.linked["002-anchor"], ".ut-tdd", "runtime", "activation", "active.json"),
        ),
      ).toBe(false);
    } finally {
      mkdirSync(fixture.cache, { recursive: true });
      for (const name of readdirSync(fixture.release))
        writeFileSync(join(fixture.cache, name), readFileSync(join(fixture.release, name)));
    }
    expect(snapshotTree(cacheRoot)).toBe(cacheBefore);
  });

  it("U-CWTRT-002: explicit valid Release B is rejected against main's pin A", () => {
    const cacheRoot = dirname(fixture.cache);
    const cacheBefore = snapshotTree(cacheRoot);
    const target = fixture.linked["002-b"];
    const targetBefore = snapshotTree(target);
    const mainStateBefore = snapshotTree(join(fixture.main, ".ut-tdd"));
    const otherBefore = snapshotTree(fixture.linked["005-existing"]);
    rmSync(fixture.cache, { recursive: true, force: true });
    const cacheDuring = snapshotTree(cacheRoot);
    try {
      const result = runConsumerWorktreeCommand(fixture.main, [
        "setup",
        "--worktree",
        target,
        "--consumer-runtime-release",
        fixture.releaseB,
        "--expected-consumer-digest",
        fixture.anchorB,
      ]);
      expect(`${result.stdout}\n${result.stderr}`).toContain("worktree_entry_pin_mismatch");
      expect(result.status).not.toBe(0);
      expect(snapshotTree(cacheRoot)).toBe(cacheDuring);
      expect(snapshotTree(target)).toBe(targetBefore);
      expect(snapshotTree(join(fixture.main, ".ut-tdd"))).toBe(mainStateBefore);
      expect(snapshotTree(fixture.linked["005-existing"])).toBe(otherBefore);
    } finally {
      mkdirSync(fixture.cache, { recursive: true });
      for (const name of readdirSync(fixture.release))
        writeFileSync(join(fixture.cache, name), readFileSync(join(fixture.release, name)));
    }
    expect(snapshotTree(cacheRoot)).toBe(cacheBefore);
  });

  it("U-CWTRT-003: rejects a tampered cached asset without partial runtime", () => {
    const target = join(fixture.cache, releaseArtifactFileNames(WORKTREE_RUNTIME_TAG).compiledEsm);
    const original = readFileSync(target);
    const worktree = fixture.linked["003"];
    const worktreeBefore = snapshotTree(worktree);
    writeFileSync(target, Buffer.concat([original, Buffer.from("tamper")]));
    try {
      const result = runConsumerWorktreeCommand(fixture.main, ["setup", "--worktree", worktree]);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(
        /consumer_runtime_|worktree_entry_pin_mismatch/,
      );
      expect(result.status).not.toBe(0);
      expect(snapshotTree(worktree)).toBe(worktreeBefore);
      expect(existsSync(join(worktree, ".ut-tdd", "bin", "ut-tdd.mjs"))).toBe(false);
      expect(existsSync(join(worktree, ".ut-tdd", "runtime", "activation", "active.json"))).toBe(
        false,
      );
    } finally {
      writeFileSync(target, original);
    }
  });

  it("U-CWTRT-004: refuses setup while main has no active runtime", () => {
    const active = join(fixture.main, ".ut-tdd", "runtime", "activation", "active.json");
    const saved = readFileSync(active);
    rmSync(active);
    try {
      const result = runConsumerWorktreeCommand(
        fixture.main,
        ["setup", "--worktree", fixture.linked["004"]],
        { sourceCli: true },
      );
      expect(`${result.stdout}\n${result.stderr}`).toContain("worktree_entry_main_not_activated");
      expect(result.status).not.toBe(0);
      const guidance = `${result.stdout}\n${result.stderr}`.toLowerCase();
      expect(guidance).toMatch(/main[^\r\n]{0,120}setup|setup[^\r\n]{0,120}main/);
      expect(existsSync(join(fixture.linked["004"], ".ut-tdd", "bin", "ut-tdd.mjs"))).toBe(false);
    } finally {
      writeFileSync(active, saved);
    }
  });

  it("U-CWTRT-005: cache A and B still install only main's pinned A", () => {
    const cacheBefore = snapshotTree(dirname(fixture.cache));
    const existingBefore = snapshotTree(fixture.linked["005-existing"]);
    const mainPointer = readFileSync(
      join(fixture.main, ".ut-tdd", "runtime", "activation", "active.json"),
    );
    const result = runConsumerWorktreeCommand(fixture.main, [
      "setup",
      "--worktree",
      fixture.linked["005"],
    ]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(runtimeIdentity(fixture.linked["005"]).release_id).toBe(fixture.releaseId);
    expect(runtimeIdentity(fixture.linked["005"]).release_id).not.toBe(fixture.releaseIdB);
    expect(
      readFileSync(join(fixture.main, ".ut-tdd", "runtime", "activation", "active.json")),
    ).toEqual(mainPointer);
    expect(snapshotTree(dirname(fixture.cache))).toBe(cacheBefore);
    expect(snapshotTree(fixture.linked["005-existing"])).toBe(existingBefore);
  });

  it("U-CWTRT-005: refuses to replace an existing worktree runtime pinned to B", () => {
    const existing = fixture.linked["005-existing"];
    const identityBefore = runtimeIdentity(existing);
    const existingBefore = snapshotTree(existing);
    const cacheBefore = snapshotTree(dirname(fixture.cache));
    const pointer = join(existing, ".ut-tdd", "runtime", "activation", "active.json");
    const pointerBefore = readFileSync(pointer);
    const result = runConsumerWorktreeCommand(fixture.main, ["setup", "--worktree", existing]);
    expect(`${result.stdout}\n${result.stderr}`).toContain("consumer_runtime_update_unsupported");
    expect(result.status).not.toBe(0);
    expect(snapshotTree(existing)).toBe(existingBefore);
    expect(snapshotTree(dirname(fixture.cache))).toBe(cacheBefore);
    expect(runtimeIdentity(existing)).toEqual(identityBefore);
    expect(readFileSync(pointer)).toEqual(pointerBefore);
  });

  it("U-CWTRT-006: rejects the main worktree without writing", () => {
    const before = readdirSync(fixture.main).sort();
    const mainStateBefore = snapshotTree(join(fixture.main, ".ut-tdd"));
    const cacheBefore = snapshotTree(dirname(fixture.cache));
    const result = runConsumerWorktreeCommand(fixture.main, ["setup", "--worktree", fixture.main]);
    expect(`${result.stdout}\n${result.stderr}`).toContain("worktree_entry_not_linked");
    expect(result.status).not.toBe(0);
    expect(readdirSync(fixture.main).sort()).toEqual(before);
    expect(snapshotTree(join(fixture.main, ".ut-tdd"))).toBe(mainStateBefore);
    expect(snapshotTree(dirname(fixture.cache))).toBe(cacheBefore);
  });

  it("U-CWTRT-006: rejects a non-git path without writing", () => {
    const unmanaged = fixture.linked.unmanaged;
    const before = readdirSync(unmanaged).sort();
    const result = runConsumerWorktreeCommand(fixture.main, ["setup", "--worktree", unmanaged]);
    expect(`${result.stdout}\n${result.stderr}`).toContain("worktree_entry_not_linked");
    expect(result.status).not.toBe(0);
    expect(readdirSync(unmanaged).sort()).toEqual(before);
  });

  registerConsumerWorktreeRuntime010Tests(() => fixture);
});
