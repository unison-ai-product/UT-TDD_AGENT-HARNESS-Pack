/**
 * harness.db 物理サイズ管理 — rebuild 後の条件付き自動 VACUUM (PLAN-L7-457 Step 3, issue #118)。
 *
 * Stop hook ごとの `session db-refresh` full rebuild (PLAN-L7-365) は delete+reinsert churn を
 * 発生させるが、VACUUM がどの経路でも一度も走らないためファイルサイズが単調増加する
 * (実測: 3.07GB のうち 81% が freelist)。閾値超過時のみ VACUUM することで、Stop ごとの
 * 40 秒級コストを避けつつ肥大を再発させない。
 *
 * fail-open: VACUUM 失敗 (db busy/lock 等) は throw せず warning を返すのみ。VACUUM は
 * 物理サイズ最適化であり、rebuild が担う鮮度保証 (PLAN-L7-365) の一部ではないため。
 */
import { existsSync, statSync } from "node:fs";
import { defaultHarnessDbPath, type HarnessDb, openHarnessDb } from "./index.ts";

export interface MaybeVacuumOptions {
  /** VACUUM 発火閾値の絶対下限 (bytes)。既定 64MiB。 */
  minFreelistBytes?: number;
  /** VACUUM 発火閾値の DB 全体に対する比率。既定 0.25 (25%)。 */
  freelistRatio?: number;
  /** DB path のガード用 repoRoot (`openHarnessDb` へ委譲)。 */
  repoRoot?: string;
  /** 経過時間計測用 (test 注入用)。未指定は Date.now。 */
  now?: () => number;
}

export interface MaybeVacuumResult {
  ran: boolean;
  beforeBytes?: number;
  afterBytes?: number;
  durationMs?: number;
  /** fail-open: VACUUM を試みたが失敗した/判定不能だった理由。 */
  warning?: string;
}

export const DEFAULT_MIN_VACUUM_FREELIST_BYTES = 64 * 1024 * 1024;
export const DEFAULT_VACUUM_FREELIST_RATIO = 0.25;

function readPragmaInt(db: HarnessDb, pragma: string): number {
  const row = db.prepare(`PRAGMA ${pragma}`).get();
  if (!row) return 0;
  const value = Object.values(row)[0];
  return Number(value ?? 0);
}

/**
 * freelist (空きページ) が閾値を超えている場合のみ `VACUUM` を実行する。
 * 非発火時は no-op (`ran: false`)。DB が存在しない場合も no-op。
 * 失敗 (lock 等) は throw せず `warning` を返す (fail-open、rebuild 成果を壊さない)。
 */
export function maybeVacuumHarnessDb(
  dbPath: string = defaultHarnessDbPath(),
  options: MaybeVacuumOptions = {},
): MaybeVacuumResult {
  const minFreelistBytes = options.minFreelistBytes ?? DEFAULT_MIN_VACUUM_FREELIST_BYTES;
  const freelistRatio = options.freelistRatio ?? DEFAULT_VACUUM_FREELIST_RATIO;
  const now = options.now ?? Date.now;
  if (!existsSync(dbPath)) return { ran: false };

  let beforeBytes: number;
  try {
    beforeBytes = statSync(dbPath).size;
  } catch (error) {
    return {
      ran: false,
      warning: `vacuum skipped (stat failed): ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let db: HarnessDb | undefined;
  try {
    db = openHarnessDb(dbPath, { repoRoot: options.repoRoot });
    const pageSize = readPragmaInt(db, "page_size");
    const pageCount = readPragmaInt(db, "page_count");
    const freelistCount = readPragmaInt(db, "freelist_count");
    const totalBytes = pageSize * pageCount;
    const freelistBytes = pageSize * freelistCount;
    const threshold = Math.max(minFreelistBytes, totalBytes * freelistRatio);
    if (freelistBytes <= threshold) {
      return { ran: false };
    }

    const start = now();
    db.exec("VACUUM");
    const durationMs = now() - start;
    db.close();
    db = undefined;
    const afterBytes = statSync(dbPath).size;
    return { ran: true, beforeBytes, afterBytes, durationMs };
  } catch (error) {
    return {
      ran: false,
      warning: `vacuum failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    try {
      db?.close();
    } catch {
      // close 失敗はここでは無視 (fail-open、既に warning 経路で報告済み)。
    }
  }
}
