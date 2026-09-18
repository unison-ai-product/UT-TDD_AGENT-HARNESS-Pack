import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  type MaybeVacuumOptions,
  type MaybeVacuumResult,
  maybeVacuumHarnessDb,
} from "./db-maintenance.ts";
import { defaultHarnessDbPath, openHarnessDb } from "./index.ts";
import { migrate } from "./migration.ts";
import {
  projectModelEvaluations,
  projectTokenUsage,
  rebuildHarnessDb,
} from "./projection-writer.ts";
import {
  acquireStopRefreshLease,
  claimStopRefreshDemand,
  completeStopRefreshDemand,
  joinStopRefreshLease,
  markStopRefreshDirty,
  recordStopRefreshFailure,
  recordStopRefreshFailureOnce,
  releaseStopRefreshLease,
  retryStopRefreshDemand,
  transferStopRefreshLease,
} from "./stop-refresh-coordinator.ts";
import { loadRuntimeSessionUsage } from "./token-tracker.ts";

export interface StopRefreshResult {
  ok: boolean;
  rebuilt: boolean;
  tokenRunsIngested: number;
  /** ok=false のときの skip 理由 (fail-open: 例外は握って理由へ落とす)。 */
  skippedReason?: string;
  /** rebuild 完走後の条件付き VACUUM 結果 (PLAN-L7-457)。rebuild 未完走なら undefined。 */
  vacuum?: MaybeVacuumResult;
}

export interface StopRefreshOptions {
  repoRoot: string;
  /** token ingest の走査対象 (test 注入用)。未指定は telemetry scan と同じ OS default。 */
  claudeSessionsDir?: string;
  codexSessionsDir?: string;
  /** token ingest 自体を止める (rebuild のみ)。 */
  skipTokenIngest?: boolean;
  /** test 注入用。未指定は maybeVacuumHarnessDb (PLAN-L7-457)。 */
  vacuum?: (dbPath: string, options?: MaybeVacuumOptions) => MaybeVacuumResult;
}

/**
 * Stop hook 駆動の on-disk harness.db currency 維持 (PLAN-L7-365 Step 2、issue #78)。
 *
 * - persisted harness.db を決定的に full rebuild し、他ランタイム merge 由来の
 *   plan registry stale (db-currency violation) を session 境界で自動収束させる。
 * - token/cost ingest (`telemetry scan` 相当) を統合し、別コマンド依存を解消する。
 * - fail-open: rebuild/ingest のどんな失敗 (DB lock 含む) も session 終了を妨げない。
 *   doctor は read-only のまま (自動修復は doctor でなく Stop 境界に置く設計判断)。
 */
export function refreshHarnessDbOnStop(options: StopRefreshOptions): StopRefreshResult {
  const { repoRoot } = options;
  let rebuilt = false;
  let tokenRunsIngested = 0;
  let vacuum: MaybeVacuumResult | undefined;
  try {
    const rebuild = rebuildHarnessDb({ repoRoot });
    rebuilt = rebuild.ok;
    if (!rebuild.ok) {
      return { ok: false, rebuilt, tokenRunsIngested, skippedReason: "rebuild-failed" };
    }
    // rebuild 完走後の条件付き自動 VACUUM (肥大再発防止、PLAN-L7-457)。fail-open:
    // maybeVacuumHarnessDb 自体が失敗を throw せず warning へ落とすため、rebuild 成果は壊れない。
    vacuum = (options.vacuum ?? maybeVacuumHarnessDb)(defaultHarnessDbPath(repoRoot), { repoRoot });
  } catch (error) {
    return {
      ok: false,
      rebuilt,
      tokenRunsIngested,
      vacuum,
      skippedReason: `rebuild-error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (options.skipTokenIngest === true) {
    return { ok: true, rebuilt, tokenRunsIngested, vacuum };
  }

  try {
    const claudeDir =
      options.claudeSessionsDir ??
      process.env.UT_TDD_CLAUDE_SESSIONS_DIR ??
      join(homedir(), ".claude", "projects");
    const codexDir =
      options.codexSessionsDir ??
      process.env.UT_TDD_CODEX_SESSIONS_DIR ??
      join(homedir(), ".codex", "sessions");
    const usages = loadRuntimeSessionUsage({ claudeDirs: [claudeDir], codexDirs: [codexDir] });
    const db = openHarnessDb(defaultHarnessDbPath(repoRoot), { repoRoot });
    try {
      migrate(db);
      projectTokenUsage(db, usages);
      projectModelEvaluations(db, repoRoot);
    } finally {
      db.close();
    }
    tokenRunsIngested = usages.length;
  } catch (error) {
    // rebuild は成功済みなので currency は回復している。ingest 失敗のみ理由付きで報告。
    return {
      ok: false,
      rebuilt,
      tokenRunsIngested,
      vacuum,
      skippedReason: `token-ingest-error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return { ok: true, rebuilt, tokenRunsIngested, vacuum };
}

export interface DetachedSpawnHandle {
  pid?: number;
  unref(): void;
  /** node:child_process の error event (非同期起動失敗、例: ENOENT)。未処理だと process が落ちる。 */
  on?(event: "error", listener: (error: Error) => void): unknown;
}

export type DetachedSpawnImpl = (
  command: string,
  args: string[],
  options: { cwd: string; detached: boolean; stdio: "ignore"; windowsHide: boolean },
) => DetachedSpawnHandle;

export interface SpawnStopRefreshOptions {
  repoRoot: string;
  /** 再入用エントリ (通常 process.execPath = bun と process.argv[1] = CLI script)。 */
  execPath?: string;
  scriptPath?: string;
  /** test注入用。undefinedは現在runtime、nullはBunでないruntimeを表す。 */
  runtimeBunVersion?: string | null;
  /** test 注入用。未指定は node:child_process.spawn。 */
  spawnImpl?: DetachedSpawnImpl;
}

export interface SpawnStopRefreshResult {
  launched: boolean;
  reason?: string;
  coalesced?: boolean;
}

function portableBasename(path: string): string {
  return basename(path.replaceAll("\\", "/"));
}

/** Bun から重い refresh worker を再帰起動しないための fail-close 判定。 */
export function isBunExecutable(
  execPath: string | undefined,
  runtimeBunVersion?: string | null,
): boolean {
  const observedBunVersion =
    runtimeBunVersion === undefined
      ? (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun
      : runtimeBunVersion;
  if (observedBunVersion) return true;
  if (!execPath) return false;
  return (
    portableBasename(execPath)
      .toLowerCase()
      .replace(/\.(?:cmd|exe)$/u, "") === "bun"
  );
}

function isNodeWorkerEntrypoint(execPath: string, scriptPath: string): boolean {
  const executable = portableBasename(execPath)
    .toLowerCase()
    .replace(/\.exe$/u, "");
  return executable === "node" && /\.(?:c|m)?js$/iu.test(scriptPath);
}

/** 直接起動されたBun workerを証跡付きで停止し、次回再試行を可能にする。 */
export function refuseBunStopRefresh(
  options: Pick<SpawnStopRefreshOptions, "repoRoot" | "runtimeBunVersion"> & {
    generation: string;
    execPath: string | undefined;
  },
): boolean {
  if (!isBunExecutable(options.execPath, options.runtimeBunVersion)) return false;
  if (joinStopRefreshLease(options.repoRoot, options.generation)) {
    recordStopRefreshFailureOnce({
      repoRoot: options.repoRoot,
      generation: options.generation,
      reason: "bun-runtime-refused",
      key: "bun-runtime-refused",
    });
    releaseStopRefreshLease(options.repoRoot, options.generation);
  }
  return true;
}

/**
 * Stop hook の timeout 予算 (Claude 側 5s) から DB refresh を切り離す detached 起動
 * (blind review 2026-07-17 の FLAG 対応: 同期 full rebuild は hook の外部 kill で
 * 収束保証が無い)。`ut-tdd session db-refresh` を fire-and-forget で起動し、
 * hook 自体は即 return する。fail-open: 起動失敗は理由を返すだけで hook を落とさない。
 */
export function spawnDetachedStopRefresh(options: SpawnStopRefreshOptions): SpawnStopRefreshResult {
  if (!markStopRefreshDirty(options.repoRoot)) {
    return { launched: false, reason: "dirty-marker-unavailable" };
  }
  const lease = acquireStopRefreshLease(options.repoRoot);
  if (!lease.acquired) {
    return lease.reason === "active"
      ? { launched: false, coalesced: true, reason: "active-owner" }
      : { launched: false, reason: "coordinator-unavailable" };
  }
  const generation = lease.owner.generation;
  try {
    const execPath = options.execPath ?? process.execPath;
    const scriptPath = options.scriptPath ?? process.argv[1];
    if (!execPath || !scriptPath) {
      releaseStopRefreshLease(options.repoRoot, generation);
      return { launched: false, reason: "missing-entrypoint" };
    }
    if (isBunExecutable(execPath, options.runtimeBunVersion)) {
      recordStopRefreshFailureOnce({
        repoRoot: options.repoRoot,
        generation,
        reason: "bun-runtime-refused",
        key: "bun-runtime-refused",
      });
      releaseStopRefreshLease(options.repoRoot, generation);
      return { launched: false, reason: "bun-runtime-refused" };
    }
    if (!isNodeWorkerEntrypoint(execPath, scriptPath)) {
      recordStopRefreshFailureOnce({
        repoRoot: options.repoRoot,
        generation,
        reason: "unsupported-refresh-entrypoint",
        key: "unsupported-refresh-entrypoint",
      });
      releaseStopRefreshLease(options.repoRoot, generation);
      return { launched: false, reason: "unsupported-refresh-entrypoint" };
    }
    const spawnImpl: DetachedSpawnImpl =
      options.spawnImpl ??
      ((command, args, opts) => spawn(command, args, opts) as unknown as DetachedSpawnHandle);
    const child = spawnImpl(
      execPath,
      [scriptPath, "session", "db-refresh", "--generation", generation],
      {
        cwd: options.repoRoot,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    // 非同期起動失敗 (ENOENT 等) は error event で届く。未処理のままだと親 process が
    // 落ちて fail-open 契約を破るため、必ず握りつぶす (blind review 2nd round の FLAG 対応)。
    child.on?.("error", () => {
      // dirty remains durable. Releasing only our generation lets the next Stop retry.
      releaseStopRefreshLease(options.repoRoot, generation);
    });
    if (
      typeof child.pid !== "number" ||
      child.pid <= 0 ||
      !transferStopRefreshLease(options.repoRoot, generation, process.pid, child.pid)
    ) {
      releaseStopRefreshLease(options.repoRoot, generation);
      child.unref();
      return { launched: false, reason: "ownership-handoff-failed" };
    }
    child.unref();
    return { launched: true };
  } catch (error) {
    releaseStopRefreshLease(options.repoRoot, generation);
    return {
      launched: false,
      reason: `spawn-error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Worker side: one initial run plus at most one coalesced rerun. */
export function runCoalescedStopRefresh(
  options: StopRefreshOptions & {
    generation: string;
    /** deterministic unit oracle; production uses refreshHarnessDbOnStop. */
    refresh?: (options: StopRefreshOptions) => StopRefreshResult;
  },
): {
  runs: StopRefreshResult[];
  owned: boolean;
} {
  const runs: StopRefreshResult[] = [];
  let releasable = true;
  // Idempotently complete ownership handoff even if the parent exited immediately after spawn.
  if (!joinStopRefreshLease(options.repoRoot, options.generation)) {
    return { runs, owned: false };
  }
  if (!claimStopRefreshDemand(options.repoRoot, options.generation)) {
    releaseStopRefreshLease(options.repoRoot, options.generation);
    return { runs, owned: false };
  }
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let result: StopRefreshResult;
      try {
        result = (options.refresh ?? refreshHarnessDbOnStop)(options);
      } catch (error) {
        const reason = `refresh-threw: ${error instanceof Error ? error.message : String(error)}`;
        const recorded = recordStopRefreshFailure(options.repoRoot, options.generation, reason);
        const retried = retryStopRefreshDemand(options.repoRoot, options.generation);
        releasable = recorded && retried;
        break;
      }
      runs.push(result);
      if (!result.ok) {
        const recorded = recordStopRefreshFailure(
          options.repoRoot,
          options.generation,
          result.skippedReason ?? "refresh-failed",
        );
        const retried = retryStopRefreshDemand(options.repoRoot, options.generation);
        releasable = recorded && retried;
        break;
      }
      completeStopRefreshDemand(options.repoRoot, options.generation);
      if (attempt === 1 || !claimStopRefreshDemand(options.repoRoot, options.generation)) break;
    }
  } finally {
    if (releasable) releaseStopRefreshLease(options.repoRoot, options.generation);
  }
  return { runs, owned: true };
}
