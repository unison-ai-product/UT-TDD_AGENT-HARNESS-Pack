/**
 * outstanding-work surface — 「未了の正の集計シグナル」を status / handover が additive に出すための
 * 純関数 + loader (IMP-139)。
 *
 * 動機 (PO 指摘 2026-06-19 self-audit): `ut-tdd status` (mode + next のみ) も handover digest
 * (commits/files/failures のみ) も CURRENT.json も「層内の非終端 (draft 等) PLAN 数 / open な
 * explicit-defer 数」を出さない。結果「doctor green = 完了」と誤読され得る (PLAN 完了 ≠ 層完了)。
 * merged-plan-status ([[plan-merged-plan-status]]) / plan-completion-drift ([[plan-completion-drift]]) は
 * drift を fail-close 検出するが、それは「異常」の検出であって「未了の総量」を可視化しない。本 surface は
 * 「完了主張」を機械照合可能にする informational additive サーフェス (gate ではない、非 fail-close)。
 *
 * 集計 2 軸 (IMP-139 a/b):
 *  (a) 非終端 (terminal/archived 以外) PLAN を layer 別に集計。
 *  (b) open な spec-backfill placeholder_deps carry 数 (= placeholder-deps の specBackfillWaits、
 *      上位仕様確定待ちで対テスト設計を書けない正当な carry。threshold は descent-obligation が担当)。
 *
 * 公開契約は additive のみ (status --json は nextAction を additive 付加した A-138 ITEM-1 / PLAN-L7-84
 * の前例に倣う)。既存フィールドは不変。
 *
 * placeholder-deps / shared を再利用するため解析層 (src/lint) に置く (runtime→lint は coding-rules の
 * module-boundary 違反ゆえ、消費側 cli / handover が lint を import する形にする)。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzePlaceholderDeps, loadPlaceholderDepsDocs } from "./placeholder-deps";
import { fmValue } from "./shared";

/** 終端 (= 完了とみなす) status。これ以外 (archived を除く) が非終端 = 未了。 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["confirmed", "completed", "accepted"]);

export interface OutstandingWork {
  /** 非終端 PLAN を layer 別に集計 (key 昇順、IMP-139 a)。 */
  nonTerminalPlansByLayer: Record<string, number>;
  /** 非終端 PLAN 総数。 */
  nonTerminalPlansTotal: number;
  /** 非終端のうち version-up parked (version_target 付き draft) 数 (PLAN-DISCOVERY-09)。
   *  「将来版へ保全」を active draft (WIP) と分離して surface する (green に埋めない)。 */
  versionUpParked: number;
  /** active draft (= 非終端 − version-up parked)。WIP の実数。 */
  activeDraftTotal: number;
  /** open な spec-backfill placeholder_deps carry 数 (IMP-139 b)。 */
  openDefers: number;
}

export interface OutstandingPlanRow {
  layer: string;
  status: string;
  /** version-up parked マーカー (PLAN-DISCOVERY-09)。null = 通常。 */
  versionTarget?: string | null;
}

/**
 * 非終端 PLAN の layer 別集計 + version-up parked 分離 + open defer 数を組む純関数。
 * archived と終端 status は未了から除外する。version-up parked は非終端に含めるが別途分離計上する。
 */
export function analyzeOutstandingWork(
  plans: OutstandingPlanRow[],
  openDefers: number,
): OutstandingWork {
  const byLayer: Record<string, number> = {};
  let versionUpParked = 0;
  for (const p of plans) {
    const s = p.status.toLowerCase();
    if (s === "archived" || TERMINAL_STATUSES.has(s)) continue;
    const layer = p.layer.trim() || "unknown";
    byLayer[layer] = (byLayer[layer] ?? 0) + 1;
    // version-up parked = draft + version_target (landed には schema が付与を禁ずる)。
    if (s === "draft" && (p.versionTarget ?? "").trim().length > 0) versionUpParked++;
  }
  // 決定論順 (layer key 昇順) で再構築する (出力安定性)。
  const ordered: Record<string, number> = {};
  for (const key of Object.keys(byLayer).sort()) ordered[key] = byLayer[key];
  const total = Object.values(ordered).reduce((acc, n) => acc + n, 0);
  return {
    nonTerminalPlansByLayer: ordered,
    nonTerminalPlansTotal: total,
    versionUpParked,
    activeDraftTotal: Math.max(0, total - versionUpParked),
    openDefers: Math.max(0, openDefers),
  };
}

/** docs/plans/*.md の layer / status を frontmatter から読む (PLAN registry を介さず最新値)。 */
export function loadOutstandingPlanRows(repoRoot: string): OutstandingPlanRow[] {
  const dir = join(repoRoot, "docs", "plans");
  if (!existsSync(dir)) return [];
  const rows: OutstandingPlanRow[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    let content = "";
    try {
      content = readFileSync(join(dir, f), "utf8");
    } catch {
      continue;
    }
    rows.push({
      layer: fmValue(content, "layer") ?? "unknown",
      status: fmValue(content, "status") ?? "unknown",
      versionTarget: fmValue(content, "version_target") ?? null,
    });
  }
  return rows;
}

/** repo から outstanding work を集計する (I/O 失敗は fail-open でゼロ寄せ、informational surface)。 */
export function computeOutstandingWork(repoRoot: string): OutstandingWork {
  const plans = loadOutstandingPlanRows(repoRoot);
  let openDefers = 0;
  try {
    openDefers = analyzePlaceholderDeps(loadPlaceholderDepsDocs(repoRoot)).specBackfillWaits;
  } catch {
    openDefers = 0;
  }
  return analyzeOutstandingWork(plans, openDefers);
}

/** status text / doctor 向け 1 行サマリ。 */
export function outstandingSummaryLine(o: OutstandingWork): string {
  const byLayer =
    Object.entries(o.nonTerminalPlansByLayer)
      .map(([layer, n]) => `${layer}:${n}`)
      .join(", ") || "none";
  const versionUp =
    o.versionUpParked > 0
      ? `; version-up parked=${o.versionUpParked} (active draft=${o.activeDraftTotal})`
      : "";
  return `outstanding: non-terminal PLANs=${o.nonTerminalPlansTotal} (${byLayer})${versionUp}; open defers=${o.openDefers}`;
}
