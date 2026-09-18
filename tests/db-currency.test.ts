import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzeDbCurrency, dbCurrencyMessages } from "../src/lint/db-currency.ts";
import type { DriveDbRegistrationStats } from "../src/lint/drive-db-registration.ts";
import { loadDriveDbRegistrationStats } from "../src/state-db/drive-registration.ts";
import { defaultHarnessDbPath } from "../src/state-db/index.ts";
import { rebuildHarnessDb } from "../src/state-db/projection-writer.ts";
import {
  isBunExecutable,
  refreshHarnessDbOnStop,
  refuseBunStopRefresh,
  runCoalescedStopRefresh,
  spawnDetachedStopRefresh,
} from "../src/state-db/stop-refresh.ts";
import {
  acquireStopRefreshLease,
  joinStopRefreshLease,
  markStopRefreshDirty,
  recordStopRefreshFailure,
  releaseStopRefreshLease,
  stopRefreshDirtyPath,
  transferStopRefreshLease,
} from "../src/state-db/stop-refresh-coordinator.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const currentStats: DriveDbRegistrationStats = {
  planCount: 10,
  expectedPlanCount: 10,
  planRegistryFingerprint: "sha256:1234567890abcdef",
  expectedPlanRegistryFingerprint: "sha256:1234567890abcdef",
  driveRuns: 10,
  plansWithoutDriveRun: 0,
  workflowRuns: 2,
  workflowOrphans: 0,
  modelRuns: 4,
  modelOrphans: 0,
  skillRecommendations: 10,
  skillRecommendationOrphans: 0,
  skillInvocations: 5,
  skillInvocationOrphans: 0,
  registeredHookEvents: 3,
  hookOrphans: 0,
  modes: ["Forward"],
};

const stopRefreshCoordinatorModuleUrl = pathToFileURL(
  join(process.cwd(), "src", "state-db", "stop-refresh-coordinator.ts"),
).href;

describe("db-currency lint", () => {
  it("U-DBCURRENCY-001: accepts persisted harness.db when plan count and fingerprint match docs", () => {
    const result = analyzeDbCurrency(currentStats);

    expect(result.ok).toBe(true);
    expect(dbCurrencyMessages(result)[0]).toBe(
      "db-currency - OK (plans=10, fingerprint=1234567890ab)",
    );
  });

  it("U-DBCURRENCY-002: fails closed when on-disk harness.db is missing", () => {
    const result = analyzeDbCurrency(null);

    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([{ reason: "missing_db" }]);
    expect(dbCurrencyMessages(result)[0]).toContain("missing_db");
  });

  it("U-DBCURRENCY-003: detects stale plan count and stale content fingerprint separately", () => {
    const result = analyzeDbCurrency({
      ...currentStats,
      planCount: 9,
      expectedPlanCount: 10,
      planRegistryFingerprint: "sha256:old",
      expectedPlanRegistryFingerprint: "sha256:new",
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      { reason: "stale_plan_registry", count: -1 },
      { reason: "stale_plan_registry_fingerprint" },
    ]);
    expect(dbCurrencyMessages(result)[0]).toContain("stale_plan_registry=-1");
    expect(dbCurrencyMessages(result)[0]).toContain("stale_plan_registry_fingerprint");
  });

  it("U-DBCURRENCY-004: rebuilt on-disk harness.db is current against its PLAN docs", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-db-currency-"));
    try {
      const planDir = join(root, "docs", "plans");
      mkdirSync(planDir, { recursive: true });
      writeFileSync(
        join(planDir, "PLAN-TEST-db-currency.md"),
        [
          "---",
          "plan_id: PLAN-TEST-db-currency",
          "kind: impl",
          "layer: L7",
          "drive: db",
          "status: draft",
          "updated: 2026-07-07",
          "---",
          "",
          "## Body",
          "",
        ].join("\n"),
        "utf8",
      );

      rebuildHarnessDb({ repoRoot: root });
      const stats = loadDriveDbRegistrationStats(root);
      const result = analyzeDbCurrency(stats);

      expect(stats).not.toBeNull();
      expect(result.ok).toBe(true);
    } finally {
      removeTestTree(root);
    }
  });

  it("U-DBCURRENCY-005: Stop-hook refresh converges a stale persisted registry without manual rebuild (PLAN-L7-365 Step 2, issue #78)", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-stop-refresh-"));
    const emptySessions = mkdtempSync(join(tmpdir(), "ut-tdd-stop-refresh-sessions-"));
    try {
      const planDir = join(root, "docs", "plans");
      mkdirSync(planDir, { recursive: true });
      const planDoc = (id: string) =>
        [
          "---",
          `plan_id: ${id}`,
          "kind: impl",
          "layer: L7",
          "drive: db",
          "status: draft",
          "updated: 2026-07-07",
          "---",
          "",
          "## Body",
          "",
        ].join("\n");
      writeFileSync(
        join(planDir, "PLAN-TEST-refresh-a.md"),
        planDoc("PLAN-TEST-refresh-a"),
        "utf8",
      );
      rebuildHarnessDb({ repoRoot: root });

      // 他ランタイム merge 相当: docs/plans に PLAN が増え persisted registry が stale 化する。
      writeFileSync(
        join(planDir, "PLAN-TEST-refresh-b.md"),
        planDoc("PLAN-TEST-refresh-b"),
        "utf8",
      );
      const staleResult = analyzeDbCurrency(loadDriveDbRegistrationStats(root));
      expect(staleResult.ok).toBe(false);
      expect(staleResult.violations.map((v) => v.reason)).toContain("stale_plan_registry");

      const refresh = refreshHarnessDbOnStop({
        repoRoot: root,
        claudeSessionsDir: emptySessions,
        codexSessionsDir: emptySessions,
      });
      expect(refresh.ok).toBe(true);
      expect(refresh.rebuilt).toBe(true);

      const result = analyzeDbCurrency(loadDriveDbRegistrationStats(root));
      expect(result.ok).toBe(true);
    } finally {
      removeTestTree(root);
      removeTestTree(emptySessions);
    }
  });

  it("U-DBCURRENCY-006: Stop-hook refresh fails open (returns a reason instead of throwing) when rebuild is impossible", () => {
    // .ut-tdd の位置に通常ファイルを置き、harness.db の親ディレクトリを作成不能にする
    // (DB open 不能の代表ケース。lock 等の他の失敗も同じ catch 境界に落ちる)。
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-stop-refresh-broken-"));
    try {
      writeFileSync(join(root, ".ut-tdd"), "not a directory", "utf8");

      const refresh = refreshHarnessDbOnStop({ repoRoot: root, skipTokenIngest: true });

      expect(refresh.ok).toBe(false);
      expect(refresh.skippedReason).toBeTruthy();
    } finally {
      removeTestTree(root);
    }
  });

  it("U-DBCURRENCY-007: Stop hook refuses a Bun refresh worker and preserves retry evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-stop-launch-"));
    let spawns = 0;

    const result = spawnDetachedStopRefresh({
      repoRoot: root,
      execPath: "/usr/bin/bun",
      scriptPath: "/repo/src/cli.ts",
      spawnImpl: () => {
        spawns += 1;
        return { pid: 7001, unref: () => {} };
      },
    });

    expect(result).toMatchObject({ launched: false, reason: "bun-runtime-refused" });
    expect(spawns).toBe(0);
    expect(existsSync(stopRefreshDirtyPath(root))).toBe(true);
    expect(readdirSync(join(root, ".ut-tdd", "state", "stop-refresh", "failures"))).toHaveLength(1);
    const retry = acquireStopRefreshLease(root, { generation: () => "retry" });
    expect(retry.acquired).toBe(true);
    if (retry.acquired) releaseStopRefreshLease(root, retry.owner.generation);

    const repeated = spawnDetachedStopRefresh({
      repoRoot: root,
      execPath: "/usr/bin/bun",
      scriptPath: "/repo/src/cli.ts",
      spawnImpl: () => {
        spawns += 1;
        return { pid: 7002, unref: () => {} };
      },
    });
    expect(repeated).toMatchObject({ launched: false, reason: "bun-runtime-refused" });
    expect(spawns).toBe(0);
    expect(readdirSync(join(root, ".ut-tdd", "state", "stop-refresh", "failures"))).toHaveLength(1);
    removeTestTree(root);
  });

  it("U-DBCURRENCY-028: only an explicit Node-compatible executable launches detached", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-stop-node-launch-"));
    const calls: Array<{ command: string; args: string[]; unrefCalled: boolean }> = [];
    const result = spawnDetachedStopRefresh({
      repoRoot: root,
      execPath: "/usr/bin/node",
      scriptPath: "/repo/dist/cli.js",
      runtimeBunVersion: null,
      spawnImpl: (command, args) => {
        const call = { command, args, unrefCalled: false };
        calls.push(call);
        return {
          pid: 7001,
          unref: () => {
            call.unrefCalled = true;
          },
        };
      },
    });

    expect(result.launched).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("/usr/bin/node");
    expect(calls[0]?.args.slice(0, 3)).toEqual(["/repo/dist/cli.js", "session", "db-refresh"]);
    expect(calls[0]?.unrefCalled).toBe(true);
    removeTestTree(root);
  });

  it("U-DBCURRENCY-029: Bun executable detection is path- and case-safe", () => {
    expect(isBunExecutable("bun", null)).toBe(true);
    expect(isBunExecutable("BUN.EXE", null)).toBe(true);
    expect(isBunExecutable("C:\\tools\\bun.cmd", null)).toBe(true);
    expect(isBunExecutable("/opt/bun/bin/bun", null)).toBe(true);
    expect(isBunExecutable("/usr/bin/node", "1.3.14")).toBe(true);
    expect(isBunExecutable("/usr/bin/node", null)).toBe(false);
    expect(isBunExecutable("bun-wrapper", null)).toBe(false);
  });

  it("U-DBCURRENCY-030: direct Bun worker refusal releases ownership and records failure", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-stop-direct-bun-"));
    try {
      expect(markStopRefreshDirty(root)).toBe(true);
      const lease = acquireStopRefreshLease(root, { generation: () => "direct-bun" });
      expect(lease.acquired).toBe(true);

      expect(
        refuseBunStopRefresh({
          repoRoot: root,
          generation: "direct-bun",
          execPath: "C:\\tools\\renamed.exe",
          runtimeBunVersion: "1.3.14",
        }),
      ).toBe(true);
      expect(existsSync(stopRefreshDirtyPath(root))).toBe(true);
      expect(readdirSync(join(root, ".ut-tdd", "state", "stop-refresh", "failures"))).toHaveLength(
        1,
      );
      expect(acquireStopRefreshLease(root, { generation: () => "retry" }).acquired).toBe(true);
    } finally {
      removeTestTree(root);
    }
  });

  it("U-DBCURRENCY-031: detached refresh rejects non-Node and TypeScript entrypoints", () => {
    for (const [execPath, scriptPath] of [
      ["python", "cli.js"],
      ["node", "cli.ts"],
      ["powershell.exe", "cli.mjs"],
    ]) {
      const root = mkdtempSync(join(tmpdir(), "ut-tdd-stop-entry-refuse-"));
      let spawns = 0;
      const options = {
        repoRoot: root,
        execPath,
        scriptPath,
        runtimeBunVersion: null,
        spawnImpl: () => {
          spawns += 1;
          return { pid: 7002, unref: () => {} };
        },
      };
      const result = spawnDetachedStopRefresh(options);
      expect(result).toMatchObject({
        launched: false,
        reason: "unsupported-refresh-entrypoint",
      });
      expect(spawns).toBe(0);
      expect(existsSync(stopRefreshDirtyPath(root))).toBe(true);
      expect(spawnDetachedStopRefresh(options)).toMatchObject({
        launched: false,
        reason: "unsupported-refresh-entrypoint",
      });
      expect(spawns).toBe(0);
      expect(readdirSync(join(root, ".ut-tdd", "state", "stop-refresh", "failures"))).toHaveLength(
        1,
      );
      removeTestTree(root);
    }
  });

  it("U-DBCURRENCY-008: detached launch fails open (returns a reason instead of throwing)", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-stop-launch-fail-"));
    const result = spawnDetachedStopRefresh({
      repoRoot: root,
      execPath: "/usr/bin/node",
      scriptPath: "/repo/dist/cli.js",
      runtimeBunVersion: null,
      spawnImpl: () => {
        throw new Error("spawn EPERM");
      },
    });

    expect(result.launched).toBe(false);
    expect(result.reason).toContain("spawn EPERM");
    expect(existsSync(stopRefreshDirtyPath(root))).toBe(true);
    removeTestTree(root);
  });

  it("U-DBCURRENCY-009: a real async spawn failure (ENOENT) is handled and does not crash the caller", async () => {
    // spawnImpl 非注入 = real node:child_process.spawn。存在しない executable の起動失敗は
    // 同期 throw でなく error event で届く。listener 未登録なら process ごと落ちる (real oracle)。
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-stop-async-fail-"));
    const result = spawnDetachedStopRefresh({
      repoRoot: root,
      execPath: join(tmpdir(), "node.exe"),
      scriptPath: "irrelevant.js",
      runtimeBunVersion: null,
    });

    // PIDを得られないspawnはownership handoff未成立として同期fail-openする。
    expect(result.launched).toBe(false);
    expect(result.reason).toBe("ownership-handoff-failed");
    // error event が発火しきるまで待つ。listener が無ければここで unhandled error になり fail する。
    await new Promise((resolve) => setTimeout(resolve, 500));
    removeTestTree(root);
  });

  it("U-DBCURRENCY-010: 100 concurrent Stops coalesce behind one owner and one dirty marker", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-stop-coalesce-"));
    try {
      let spawns = 0;
      const spawnImpl = () => {
        spawns += 1;
        return { pid: 7002, unref: () => {} };
      };
      const results = Array.from({ length: 100 }, () =>
        spawnDetachedStopRefresh({
          repoRoot: root,
          execPath: "node",
          scriptPath: "cli.js",
          runtimeBunVersion: null,
          spawnImpl,
        }),
      );
      expect(spawns).toBe(1);
      expect(results.filter((result) => result.coalesced)).toHaveLength(99);
      const state = join(root, ".ut-tdd", "state", "stop-refresh");
      expect(existsSync(join(state, "active"))).toBe(true);
      expect(existsSync(join(state, "dirty"))).toBe(true);
      expect(readdirSync(join(state, "generations"))).toHaveLength(1);
    } finally {
      removeTestTree(root);
    }
  });

  it("U-DBCURRENCY-011: a live owner is never reclaimed by elapsed time and release is generation-specific", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-stop-live-owner-"));
    try {
      const first = acquireStopRefreshLease(root, {
        pid: 41,
        host: "machine",
        now: () => 0,
        generation: () => "generation-a",
        isPidAlive: () => true,
      });
      expect(first.acquired).toBe(true);
      const afterYears = acquireStopRefreshLease(root, {
        pid: 42,
        host: "machine",
        now: () => 100 * 365 * 24 * 60 * 60 * 1000,
        generation: () => "generation-b",
        isPidAlive: () => true,
      });
      expect(afterYears).toMatchObject({ acquired: false, reason: "active" });
      releaseStopRefreshLease(root, "generation-b");
      expect(
        acquireStopRefreshLease(root, {
          pid: 43,
          host: "machine",
          generation: () => "generation-c",
          isPidAlive: () => true,
        }).acquired,
      ).toBe(false);
    } finally {
      removeTestTree(root);
    }
  });

  it("U-DBCURRENCY-012: completion performs at most one rerun and preserves later demand", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-stop-rerun-"));
    try {
      expect(markStopRefreshDirty(root)).toBe(true);
      const lease = acquireStopRefreshLease(root, {
        generation: () => "generation-rerun",
      });
      expect(lease.acquired).toBe(true);
      let calls = 0;
      const result = runCoalescedStopRefresh({
        repoRoot: root,
        generation: "generation-rerun",
        skipTokenIngest: true,
        refresh: () => {
          calls += 1;
          // Stop arrives during both runs. First causes exactly one rerun; second remains durable.
          markStopRefreshDirty(root);
          return { ok: true, rebuilt: true, tokenRunsIngested: 0 };
        },
      });
      expect(result.owned).toBe(true);
      expect(calls).toBe(2);
      expect(existsSync(stopRefreshDirtyPath(root))).toBe(true);

      const next = acquireStopRefreshLease(root, { generation: () => "generation-next" });
      expect(next.acquired).toBe(true);
      const consumed = runCoalescedStopRefresh({
        repoRoot: root,
        generation: "generation-next",
        refresh: () => ({ ok: true, rebuilt: true, tokenRunsIngested: 0 }),
      });
      expect(consumed.runs).toHaveLength(1);
      expect(existsSync(stopRefreshDirtyPath(root))).toBe(false);
    } finally {
      removeTestTree(root);
    }
  });

  it("U-DBCURRENCY-013: async spawn failure leaves durable retry demand and releases its owner", async () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-stop-async-oracle-"));
    try {
      const result = spawnDetachedStopRefresh({
        repoRoot: root,
        execPath: "node",
        scriptPath: "cli.js",
        runtimeBunVersion: null,
        spawnImpl: () => ({
          pid: 7003,
          unref: () => {},
          on: (_event, listener) => queueMicrotask(() => listener(new Error("ENOENT"))),
        }),
      });
      expect(result.launched).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(existsSync(stopRefreshDirtyPath(root))).toBe(true);
      const retry = acquireStopRefreshLease(root, { generation: () => "retry-generation" });
      expect(retry.acquired).toBe(true);
    } finally {
      removeTestTree(root);
    }
  });

  it("U-DBCURRENCY-014: rebuild failure restores durable demand before releasing the lease", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-stop-rebuild-fail-"));
    try {
      markStopRefreshDirty(root);
      const lease = acquireStopRefreshLease(root, { generation: () => "failed-run" });
      expect(lease.acquired).toBe(true);
      const result = runCoalescedStopRefresh({
        repoRoot: root,
        generation: "failed-run",
        refresh: () => ({
          ok: false,
          rebuilt: false,
          tokenRunsIngested: 0,
          skippedReason: "rebuild-failed",
        }),
      });
      expect(result.runs).toHaveLength(1);
      expect(existsSync(stopRefreshDirtyPath(root))).toBe(true);
      expect(readdirSync(join(root, ".ut-tdd", "state", "stop-refresh", "failures"))).toHaveLength(
        1,
      );
      expect(acquireStopRefreshLease(root, { generation: () => "retry" }).acquired).toBe(true);
    } finally {
      removeTestTree(root);
    }
  });

  it("U-DBCURRENCY-015: detached ownership transfers to the live child before parent exit", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-stop-child-owner-"));
    try {
      const launched = spawnDetachedStopRefresh({
        repoRoot: root,
        execPath: "node",
        scriptPath: "cli.js",
        runtimeBunVersion: null,
        spawnImpl: () => ({ pid: 9001, unref: () => {}, on: () => {} }),
      });
      expect(launched.launched).toBe(true);
      const contender = acquireStopRefreshLease(root, {
        pid: 9002,
        generation: () => "must-not-win",
        isPidAlive: (pid) => pid === 9001,
      });
      expect(contender).toMatchObject({ acquired: false, reason: "active" });
    } finally {
      removeTestTree(root);
    }
  });

  it("U-DBCURRENCY-016: separate worker processes race to exactly one generation owner", async () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-stop-process-race-"));
    const gate = join(root, "gate");
    const ready = join(root, "ready");
    mkdirSync(ready);
    writeFileSync(gate, "wait", "utf8");
    const worker = join(root, "worker.ts");
    writeFileSync(
      worker,
      `import { existsSync, writeFileSync } from "node:fs";\nimport { acquireStopRefreshLease } from ${JSON.stringify(stopRefreshCoordinatorModuleUrl)};\nwriteFileSync(${JSON.stringify(ready)} + "/" + process.pid, "ready");\nwhile (existsSync(${JSON.stringify(gate)})) await new Promise((resolve) => setTimeout(resolve, 2));\nconst lease = acquireStopRefreshLease(${JSON.stringify(root)});\nconsole.log(lease.acquired ? "won" : "lost");\nif (lease.acquired) while (!existsSync(${JSON.stringify(join(root, "release-winner"))})) await new Promise((resolve) => setTimeout(resolve, 2));\n`,
      "utf8",
    );
    let releaseFallback: ReturnType<typeof setTimeout> | undefined;
    const children = Array.from({ length: 12 }, () =>
      spawn(process.execPath, [worker], { cwd: root, stdio: ["ignore", "pipe", "pipe"] }),
    );
    try {
      const deadline = Date.now() + 10_000;
      while (readdirSync(ready).length < children.length && Date.now() < deadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }
      expect(readdirSync(ready)).toHaveLength(children.length);
      rmSync(gate);
      releaseFallback = setTimeout(
        () => writeFileSync(join(root, "release-winner"), "release\n", "utf8"),
        10_000,
      );
      const verdictPromises = children.map(
        (child) =>
          new Promise<string>((resolvePromise, reject) => {
            let stdout = "";
            child.stdout.on("data", (chunk) => (stdout += String(chunk)));
            child.on("error", reject);
            child.on("exit", (code) =>
              code === 0 ? resolvePromise(stdout.trim()) : reject(new Error(`worker exit ${code}`)),
            );
          }),
      );
      const loserVerdicts: string[] = [];
      for (const verdict of verdictPromises) {
        void verdict.then((value) => {
          if (value === "lost") loserVerdicts.push(value);
          if (loserVerdicts.length === children.length - 1)
            writeFileSync(join(root, "release-winner"), "release\n", "utf8");
        });
      }
      const verdicts = await Promise.all(verdictPromises);
      clearTimeout(releaseFallback);
      releaseFallback = undefined;
      expect(verdicts.filter((value) => value === "won")).toHaveLength(1);
      expect(verdicts.filter((value) => value === "lost")).toHaveLength(11);
      const state = join(root, ".ut-tdd", "state", "stop-refresh");
      expect(readdirSync(join(state, "generations"))).toHaveLength(1);
    } finally {
      if (releaseFallback) clearTimeout(releaseFallback);
      for (const child of children) child.kill();
      removeTestTree(root);
    }
  });

  it("U-DBCURRENCY-017: state root junction escape and active-record tamper fail closed", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-stop-path-tamper-"));
    const outside = mkdtempSync(join(tmpdir(), "ut-tdd-stop-path-outside-"));
    try {
      mkdirSync(join(root, ".ut-tdd", "state"), { recursive: true });
      symlinkSync(
        outside,
        join(root, ".ut-tdd", "state", "stop-refresh"),
        process.platform === "win32" ? "junction" : "dir",
      );
      expect(markStopRefreshDirty(root)).toBe(false);
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      removeTestTree(root);
      removeTestTree(outside);
    }
  });

  it("U-DBCURRENCY-018: child claim is acknowledged before the parent claim is retired", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-stop-handoff-ack-"));
    try {
      const parentPid = process.pid;
      const childPid = process.pid + 100_000;
      const lease = acquireStopRefreshLease(root, {
        pid: parentPid,
        generation: () => "handoff-generation",
      });
      expect(lease.acquired).toBe(true);
      expect(
        transferStopRefreshLease({
          repoRoot: root,
          generation: "handoff-generation",
          fromPid: parentPid,
          toPid: childPid,
        }),
      ).toBe(true);
      const generation = join(
        root,
        ".ut-tdd",
        "state",
        "stop-refresh",
        "generations",
        "handoff-generation",
      );
      expect(existsSync(join(generation, `claim-${parentPid}.json`))).toBe(true);
      expect(joinStopRefreshLease(root, "handoff-generation", childPid)).toBe(true);
      expect(existsSync(join(generation, `ack-${childPid}.json`))).toBe(true);
      expect(existsSync(join(generation, `claim-${childPid}.json`))).toBe(false);
      expect(existsSync(join(generation, `claim-${parentPid}.json`))).toBe(false);
    } finally {
      removeTestTree(root);
    }
  });

  it("U-DBCURRENCY-019: foreign-host unverifiable owner is quarantined only after bounded TTL", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-stop-foreign-owner-"));
    try {
      expect(
        acquireStopRefreshLease(root, {
          pid: 51,
          host: "old-machine",
          now: () => 0,
          generation: () => "foreign-old",
          isPidAlive: () => true,
        }).acquired,
      ).toBe(true);
      expect(
        acquireStopRefreshLease(root, {
          pid: 52,
          host: "new-machine",
          now: () => 60_001,
          ttlMs: 60_000,
          generation: () => "foreign-new",
          isPidAlive: () => true,
        }).acquired,
      ).toBe(true);
    } finally {
      removeTestTree(root);
    }
  });

  it("U-DBCURRENCY-020: active record digest tamper cannot release or acquire a generation", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-stop-owner-tamper-"));
    try {
      expect(acquireStopRefreshLease(root, { generation: () => "tamper-owner" }).acquired).toBe(
        true,
      );
      const active = join(root, ".ut-tdd", "state", "stop-refresh", "active");
      const record = JSON.parse(readFileSync(active, "utf8")) as Record<string, unknown>;
      writeFileSync(active, `${JSON.stringify({ ...record, pid: 999_999 })}\n`, "utf8");
      releaseStopRefreshLease(root, "tamper-owner");
      expect(existsSync(active)).toBe(true);
      expect(acquireStopRefreshLease(root, { generation: () => "must-not-acquire" })).toMatchObject(
        { acquired: false, reason: "active" },
      );
    } finally {
      removeTestTree(root);
    }
  });

  it("U-DBCURRENCY-021: a live joined child remains owner beyond TTL", async () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-stop-live-child-"));
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });
    try {
      await new Promise<void>((resolvePromise, reject) => {
        child.once("spawn", resolvePromise);
        child.once("error", reject);
      });
      if (!child.pid) throw new Error("child pid unavailable");
      const startedAt = Date.now();
      const lease = acquireStopRefreshLease(root, {
        pid: process.pid,
        now: () => startedAt,
        generation: () => "live-child-generation",
      });
      expect(lease.acquired).toBe(true);
      expect(
        transferStopRefreshLease({
          repoRoot: root,
          generation: "live-child-generation",
          fromPid: process.pid,
          toPid: child.pid,
        }),
      ).toBe(true);
      expect(joinStopRefreshLease(root, "live-child-generation", child.pid)).toBe(true);
      const contender = acquireStopRefreshLease(root, {
        now: () => startedAt + 60_001,
        ttlMs: 60_000,
        generation: () => "must-not-reclaim-live-child",
      });
      expect(contender).toMatchObject({ acquired: false, reason: "active" });
    } finally {
      child.kill();
      removeTestTree(root);
    }
  });

  it("U-DBCURRENCY-022: a same-host worker crash before join is reclaimed without TTL delay", async () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-stop-prejoin-crash-"));
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    try {
      await new Promise<void>((resolvePromise, reject) => {
        child.once("spawn", resolvePromise);
        child.once("error", reject);
      });
      if (!child.pid) throw new Error("child pid unavailable");
      const lease = acquireStopRefreshLease(root, {
        pid: process.pid,
        generation: () => "prejoin-crash-generation",
      });
      expect(lease.acquired).toBe(true);
      expect(
        transferStopRefreshLease({
          repoRoot: root,
          generation: "prejoin-crash-generation",
          fromPid: process.pid,
          toPid: child.pid,
        }),
      ).toBe(true);
      await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
      // Model the detached parent having exited too: both recorded owners are now confirmed dead.
      const reclaimed = acquireStopRefreshLease(root, {
        isPidAlive: () => false,
        generation: () => "post-crash-generation",
      });
      expect(reclaimed.acquired).toBe(true);
    } finally {
      child.kill();
      removeTestTree(root);
    }
  });

  it("U-DBCURRENCY-023: failure receipts retain safe codes without persisting exception details", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-stop-failure-redaction-"));
    try {
      expect(recordStopRefreshFailure(root, "generation-safe", "rebuild-failed")).toBe(true);
      expect(
        recordStopRefreshFailure(root, "generation-secret", "refresh-threw: token=secret-value"),
      ).toBe(true);
      const failureDir = join(root, ".ut-tdd", "state", "stop-refresh", "failures");
      const reasons = readdirSync(failureDir).map((name) =>
        JSON.parse(readFileSync(join(failureDir, name), "utf8")),
      );
      expect(reasons.map((receipt) => receipt.reason).sort()).toEqual([
        "rebuild-failed",
        "redacted",
      ]);
      expect(JSON.stringify(reasons)).not.toContain("secret-value");
    } finally {
      removeTestTree(root);
    }
  });

  it("U-DBCURRENCY-024: child self-join upgrades identity and a reused PID cannot inherit ownership", async () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-stop-child-self-join-"));
    const go = join(root, "join-go");
    const joined = join(root, "joined");
    const release = join(root, "release-child");
    const worker = join(root, "worker.ts");
    writeFileSync(
      worker,
      `import { existsSync, writeFileSync } from "node:fs";\nimport { joinStopRefreshLease } from ${JSON.stringify(stopRefreshCoordinatorModuleUrl)};\nwhile (!existsSync(${JSON.stringify(go)})) await new Promise((resolve) => setTimeout(resolve, 2));\nwriteFileSync(${JSON.stringify(joined)}, joinStopRefreshLease(${JSON.stringify(root)}, "self-join-generation") ? "joined" : "failed");\nwhile (!existsSync(${JSON.stringify(release)})) await new Promise((resolve) => setTimeout(resolve, 2));\n`,
      "utf8",
    );
    const child = spawn(process.execPath, [worker], { cwd: root, stdio: "ignore" });
    const childExit = new Promise<void>((resolvePromise) =>
      child.once("exit", () => resolvePromise()),
    );
    try {
      await new Promise<void>((resolvePromise, reject) => {
        child.once("spawn", resolvePromise);
        child.once("error", reject);
      });
      if (!child.pid) throw new Error("child pid unavailable");
      expect(
        acquireStopRefreshLease(root, { generation: () => "self-join-generation" }).acquired,
      ).toBe(true);
      expect(
        transferStopRefreshLease({
          repoRoot: root,
          generation: "self-join-generation",
          fromPid: process.pid,
          toPid: child.pid,
        }),
      ).toBe(true);
      writeFileSync(go, "go\n", "utf8");
      const deadline = Date.now() + 10_000;
      while (!existsSync(joined) && Date.now() < deadline)
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      expect(readFileSync(joined, "utf8")).toBe("joined");
      const generation = join(
        root,
        ".ut-tdd",
        "state",
        "stop-refresh",
        "generations",
        "self-join-generation",
      );
      const acknowledged = JSON.parse(
        readFileSync(join(generation, `ack-${child.pid}.json`), "utf8"),
      ) as { process_birth: string };
      expect(acknowledged.process_birth.startsWith("unverified-")).toBe(false);
      writeFileSync(release, "release\n", "utf8");
      await childExit;

      const replacement = acquireStopRefreshLease(root, {
        pid: process.pid + 200_000,
        generation: () => "replacement-generation",
        isPidAlive: (pid) => pid === child.pid,
        processBirth: () => "same-pid-new-process-birth",
      });
      expect(replacement.acquired).toBe(true);
    } finally {
      if (!existsSync(release)) writeFileSync(release, "release\n", "utf8");
      child.kill();
      removeTestTree(root);
    }
  });

  it("U-DBCURRENCY-025: join rejects a verified claim from another process incarnation", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-stop-verified-join-mismatch-"));
    try {
      expect(
        acquireStopRefreshLease(root, {
          generation: () => "verified-join-generation",
          processBirth: () => "verified-birth-a",
        }).acquired,
      ).toBe(true);
      expect(
        joinStopRefreshLease({
          repoRoot: root,
          generation: "verified-join-generation",
          pid: process.pid,
          processBirth: () => "verified-birth-b",
        }),
      ).toBe(false);
      const generation = join(
        root,
        ".ut-tdd",
        "state",
        "stop-refresh",
        "generations",
        "verified-join-generation",
      );
      expect(existsSync(join(generation, `ack-${process.pid}.json`))).toBe(false);
    } finally {
      removeTestTree(root);
    }
  });

  it("U-DBCURRENCY-026: Stop-hook refresh calls maybeVacuumHarnessDb once, after a successful rebuild (PLAN-L7-457, issue #118)", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-stop-vacuum-"));
    const emptySessions = mkdtempSync(join(tmpdir(), "ut-tdd-stop-vacuum-sessions-"));
    try {
      const calls: Array<{ dbPath: string; repoRoot?: string }> = [];
      const refresh = refreshHarnessDbOnStop({
        repoRoot: root,
        claudeSessionsDir: emptySessions,
        codexSessionsDir: emptySessions,
        vacuum: (dbPath, options) => {
          calls.push({ dbPath, repoRoot: options?.repoRoot });
          return { ran: false };
        },
      });

      expect(refresh.ok).toBe(true);
      expect(refresh.rebuilt).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.dbPath).toBe(defaultHarnessDbPath(root));
      expect(calls[0]?.repoRoot).toBe(root);
      expect(refresh.vacuum).toEqual({ ran: false });
    } finally {
      removeTestTree(root);
      removeTestTree(emptySessions);
    }
  });

  it("U-DBCURRENCY-027: Stop-hook refresh does not call maybeVacuum when rebuild fails", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-stop-vacuum-skip-"));
    try {
      writeFileSync(join(root, ".ut-tdd"), "not a directory", "utf8");
      let calls = 0;
      const refresh = refreshHarnessDbOnStop({
        repoRoot: root,
        skipTokenIngest: true,
        vacuum: () => {
          calls += 1;
          return { ran: false };
        },
      });

      expect(refresh.ok).toBe(false);
      expect(calls).toBe(0);
      expect(refresh.vacuum).toBeUndefined();
    } finally {
      removeTestTree(root);
    }
  });
});
