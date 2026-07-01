/**
 * scrum-reverse lint — PoC (Discovery/Scrum) confirmed と Reverse 合流の整合検証 (IMP-064)。
 *
 * 背景: requirements §1.2「`decision_outcome=confirmed` の poc → reverse kind PLAN を新規起票」/
 * §3.3 scrum_reverse_lint。本 harness 開発で「DISCOVERY-01 を confirmed にし concept §2.5 を
 * inline promote しただけで対応 Reverse を起こさず §1.2 違反」を犯した (IMP-064)。agent 記憶依存では漏れる。
 *
 * 2 方向を検査する:
 *  1. pocOrphans  — confirmed poc で promotion_strategy が redesign 以外 (= 成果を Forward/governance へ
 *     Reverse 経由で運ぶ) なのに、それを requires/references する reverse PLAN が無い。
 *     redesign は spike 破棄→Forward 再実装のため Reverse 不要 (concept §10.2、例 DISCOVERY-02)。
 *  2. badReverseRefs — reverse PLAN が指す poc が rejected/pivot (confirmed でない)。§1.2 line 139/809。
 *
 * 純関数 (analyze) + I/O loader 分離 (backfill-pairing / fr-registry-audit と同方針)。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fmValue } from "./shared";

/** promotion_strategy が redesign のとき Reverse 不要 (throwaway 再設計 → Forward 再実装)。 */
export const REVERSE_EXEMPT_PROMOTION = new Set(["redesign"]);

export interface ParsedSrPlan {
  file: string;
  plan_id: string;
  kind: string;
  status: string;
  decision_outcome: string | null;
  promotion_strategy: string | null;
  /** requires + references の path 群 (reverse が poc を指す向きを辿る、§1.2「requires または references」)。 */
  links: string[];
}

export interface ScrumReverseResult {
  /** confirmed poc (promotion_strategy≠redesign) なのに requires/references する reverse が無い。 */
  pocOrphans: { plan_id: string; promotion_strategy: string | null }[];
  /** reverse が指す poc が confirmed でない (rejected/pivot/未確定)。 */
  badReverseRefs: { reverse_id: string; poc_id: string; outcome: string | null }[];
  ok: boolean;
}

/** dependencies.requires / references の YAML list を抽出 (両方を 1 集合へ)。 */
export function parseLinks(content: string): string[] {
  const links: string[] = [];
  for (const key of ["requires", "references"]) {
    const m = content.match(new RegExp(`^\\s*${key}:\\s*\\n((?:\\s+-\\s+.+\\n?)*)`, "m"));
    if (!m) continue;
    for (const x of m[1].matchAll(/-\s+(.+?)\s*$/gm)) {
      if (x[1] && x[1] !== "[]") links.push(x[1]);
    }
  }
  return links;
}

export function parseSrPlan(file: string, content: string): ParsedSrPlan {
  return {
    file,
    plan_id: fmValue(content, "plan_id") ?? file.replace(/\.md$/, ""),
    kind: fmValue(content, "kind") ?? "unknown",
    status: fmValue(content, "status") ?? "unknown",
    decision_outcome: fmValue(content, "decision_outcome") ?? null,
    promotion_strategy: fmValue(content, "promotion_strategy") ?? null,
    links: parseLinks(content),
  };
}

/** ある PLAN を指す reverse が存在するか (path 末尾 `/id.md` or 完全一致で固定、別 id の suffix 誤マッチ防止)。 */
function isReferencedByReverse(planId: string, reversePlans: ParsedSrPlan[]): boolean {
  return reversePlans.some((rev) =>
    rev.links.some((l) => l.endsWith(`/${planId}.md`) || l === `${planId}.md` || l === planId),
  );
}

export function analyzeScrumReverse(plans: ParsedSrPlan[]): ScrumReverseResult {
  const active = plans.filter((p) => p.status !== "archived");
  const reverses = active.filter((p) => p.kind === "reverse");
  const byId = new Map(active.map((p) => [p.plan_id, p]));

  // 1. confirmed poc (promotion_strategy≠redesign) で reverse 合流が無い。
  const pocOrphans: { plan_id: string; promotion_strategy: string | null }[] = [];
  for (const p of active) {
    if (p.kind !== "poc" || p.decision_outcome !== "confirmed") continue;
    if (p.promotion_strategy && REVERSE_EXEMPT_PROMOTION.has(p.promotion_strategy)) continue;
    if (isReferencedByReverse(p.plan_id, reverses)) continue;
    pocOrphans.push({ plan_id: p.plan_id, promotion_strategy: p.promotion_strategy });
  }

  // 2. reverse が指す poc が confirmed でない (§1.2 line 139/809)。
  const badReverseRefs: { reverse_id: string; poc_id: string; outcome: string | null }[] = [];
  for (const rev of reverses) {
    for (const l of rev.links) {
      const id = l.replace(/^.*\//, "").replace(/\.md$/, "");
      const target = byId.get(id);
      if (!target || target.kind !== "poc") continue;
      if (target.decision_outcome !== "confirmed") {
        badReverseRefs.push({
          reverse_id: rev.plan_id,
          poc_id: target.plan_id,
          outcome: target.decision_outcome,
        });
      }
    }
  }

  return {
    pocOrphans,
    badReverseRefs,
    ok: pocOrphans.length === 0 && badReverseRefs.length === 0,
  };
}

/** docs/plans/*.md (archive/template 除く) を読み込む。 */
export function loadSrPlans(repoRoot: string = process.cwd()): ParsedSrPlan[] {
  const plansDir = join(repoRoot, "docs", "plans");
  const plans: ParsedSrPlan[] = [];
  for (const f of readdirSync(plansDir)) {
    if (!f.endsWith(".md")) continue;
    plans.push(parseSrPlan(f, readFileSync(join(plansDir, f), "utf8")));
  }
  return plans;
}

/** doctor / CLI 向けの 1 行サマリ群 (fail-close、ok は呼び出し側で参照)。 */
export function scrumReverseMessages(result: ScrumReverseResult): string[] {
  const msgs: string[] = [];
  if (result.pocOrphans.length > 0) {
    const ids = result.pocOrphans.map((o) => o.plan_id).join(", ");
    msgs.push(
      `scrum-reverse — ⚠ confirmed poc に Reverse 合流が無い ${result.pocOrphans.length} 件 (${ids}): §1.2 = confirmed poc は reverse PLAN を起こす (redesign を除く、IMP-064)`,
    );
  }
  if (result.badReverseRefs.length > 0) {
    const refs = result.badReverseRefs
      .map((b) => `${b.reverse_id}→${b.poc_id}(${b.outcome})`)
      .join(", ");
    msgs.push(
      `scrum-reverse — ⚠ reverse が confirmed でない poc を参照 ${result.badReverseRefs.length} 件 (${refs}): rejected/pivot への接続は不可 (§1.2 line 139)`,
    );
  }
  if (msgs.length === 0)
    msgs.push(
      "scrum-reverse — OK (confirmed poc は Reverse 合流済 / reverse 参照は confirmed のみ)",
    );
  return msgs;
}
