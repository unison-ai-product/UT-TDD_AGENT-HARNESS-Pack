/**
 * outstanding-work surface — open な explicit-defer 数を status / handover が additive に出す
 * 純関数 + loader (IMP-139)。
 *
 * 本 surface は informational additive サーフェス (gate ではない、非 fail-close)。
 *
 * 集計軸 (IMP-139): open な spec-backfill placeholder_deps carry 数
 * (= placeholder-deps の specBackfillWaits、
 *      上位仕様確定待ちで対テスト設計を書けない正当な carry。threshold は descent-obligation が担当)。
 *
 * 公開契約は additive のみ (status --json は nextAction を additive 付加した A-138 ITEM-1 / PLAN-L7-84
 * の前例に倣う)。既存フィールドは不変。
 *
 * placeholder-deps / shared を再利用するため解析層 (src/lint) に置く (runtime→lint は coding-rules の
 * module-boundary 違反ゆえ、消費側 cli / handover が lint を import する形にする)。
 */
import { analyzePlaceholderDeps, loadPlaceholderDepsDocs } from "./placeholder-deps.ts";

export interface OutstandingWork {
  /** open な spec-backfill placeholder_deps carry 数 (IMP-139 b)。 */
  openDefers: number;
}

/** informational な open defer 数を組む純関数。 */
export function analyzeOutstandingWork(openDefers: number): OutstandingWork {
  return { openDefers: Math.max(0, openDefers) };
}

/** repo から outstanding work を集計する (I/O 失敗は fail-open でゼロ寄せ、informational surface)。 */
export function computeOutstandingWork(repoRoot: string): OutstandingWork {
  let openDefers = 0;
  try {
    openDefers = analyzePlaceholderDeps(loadPlaceholderDepsDocs(repoRoot)).specBackfillWaits;
  } catch {
    openDefers = 0;
  }
  return analyzeOutstandingWork(openDefers);
}

/** status text / doctor 向け 1 行サマリ。 */
export function outstandingSummaryLine(o: OutstandingWork): string {
  return `outstanding: open defers=${o.openDefers}`;
}
