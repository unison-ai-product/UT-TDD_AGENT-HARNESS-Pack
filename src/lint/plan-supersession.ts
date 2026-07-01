/**
 * plan-supersession lint — PLAN errata の双方向整合検証 (PLAN-L7-89、hard、doctor.ok 連動)。
 *
 * 背景: confirmed PLAN の `review_evidence` / AC は自由記述ゆえ、断定的だが誤った主張
 * (例 PLAN-L7-86「kind filter は false-positive を出さない / blast radius 0」= 実際は
 * false-negative の盲点) が書けてしまい、機械は真偽を検証しない (coding ≠ substance)。
 * prose の真偽は一般に機械検証できないが、**誤記が後継 PLAN で訂正されたなら、その訂正リンクが
 * 双方向に記録されている** ことは機械検証できる。これにより「誤記の silent 放置」(後継が直したのに
 * 原 PLAN が誤った主張のまま残る) を fail-close する (CLAUDE.md「誤った残渣は明確に supersede せよ」)。
 *
 * 検出規則: PLAN P が frontmatter `supersedes: [X, ...]` を宣言したら、各 X について
 *  1. X が実在する plan_id であること (誤記/typo の supersede 先を弾く)。
 *  2. X の本文が P の core-id (`PLAN-<cat>-<n>`) を含むこと (= 原 PLAN に訂正 back-reference がある)。
 * いずれか欠落 → violation。`supersedes` 非宣言の PLAN は対象外 (誤記の有無は判定しない = prose 真偽は
 * 機械化しない)。宣言された errata リンクの整合のみを強制する。
 *
 * 純関数 (analyze) + I/O loader 分離 (scrum-reverse / backfill-pairing と同方針)。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fmValue } from "./shared";

export interface ParsedSupersedePlan {
  plan_id: string;
  /** frontmatter supersedes の plan_id 群 (path / .md は loader で正規化済)。 */
  supersedes: string[];
  /** 本文全体 (back-reference 走査用)。 */
  content: string;
}

export interface PlanSupersessionResult {
  /** supersede 先が実在しない (誤記/typo)。 */
  missingTargets: { plan_id: string; target: string }[];
  /** supersede 先が宣言元への back-reference 訂正注記を持たない (片肺 errata)。 */
  missingBackrefs: { plan_id: string; target: string }[];
  ok: boolean;
}

/** plan_id の core 形 (`PLAN-L7-87-slug` → `PLAN-L7-87`)。back-reference は bare 表記も許容するため。 */
export function planCoreId(planId: string): string {
  return planId.match(/^(PLAN-[A-Z0-9]+-\d+)/)?.[1] ?? planId;
}

/** path / .md 付き表記を bare plan_id へ正規化 (`docs/plans/PLAN-X.md` → `PLAN-X`)。 */
function normalizeTarget(raw: string): string {
  return raw.trim().replace(/^.*\//, "").replace(/\.md$/, "");
}

/** frontmatter の `supersedes:` YAML list を抽出 (top-level key、各行 `  - <id>`)。 */
export function parseSupersedes(content: string): string[] {
  const m = content.match(/^supersedes:\s*\n((?:\s+-\s+.+\n?)*)/m);
  if (!m) return [];
  const out: string[] = [];
  for (const x of m[1].matchAll(/-\s+(.+?)\s*$/gm)) {
    if (x[1] && x[1] !== "[]") out.push(normalizeTarget(x[1]));
  }
  return out;
}

export function parseSupersedePlan(file: string, content: string): ParsedSupersedePlan {
  return {
    plan_id: fmValue(content, "plan_id") ?? file.replace(/\.md$/, ""),
    supersedes: parseSupersedes(content),
    content,
  };
}

export function analyzePlanSupersession(plans: ParsedSupersedePlan[]): PlanSupersessionResult {
  const byId = new Map(plans.map((p) => [p.plan_id, p]));
  const missingTargets: { plan_id: string; target: string }[] = [];
  const missingBackrefs: { plan_id: string; target: string }[] = [];

  for (const p of plans) {
    const core = planCoreId(p.plan_id);
    const backref = new RegExp(`\\b${core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    for (const target of p.supersedes) {
      const t = byId.get(target);
      if (!t) {
        missingTargets.push({ plan_id: p.plan_id, target });
        continue;
      }
      // 原 PLAN は後継の core-id を訂正注記として持つこと (双方向 errata、片肺禁止)。
      if (!backref.test(t.content)) {
        missingBackrefs.push({ plan_id: p.plan_id, target });
      }
    }
  }

  return {
    missingTargets,
    missingBackrefs,
    ok: missingTargets.length === 0 && missingBackrefs.length === 0,
  };
}

/** docs/plans/*.md を読み込む (archive/template は plan_id frontmatter が無いので自然に skip)。 */
export function loadSupersedePlans(repoRoot: string = process.cwd()): ParsedSupersedePlan[] {
  const plansDir = join(repoRoot, "docs", "plans");
  const plans: ParsedSupersedePlan[] = [];
  for (const f of readdirSync(plansDir)) {
    if (!f.endsWith(".md")) continue;
    plans.push(parseSupersedePlan(f, readFileSync(join(plansDir, f), "utf8")));
  }
  return plans;
}

export function planSupersessionMessages(r: PlanSupersessionResult): string[] {
  const msgs: string[] = [];
  if (r.missingTargets.length > 0) {
    const refs = r.missingTargets.map((v) => `${v.plan_id}→${v.target}`).join(", ");
    msgs.push(
      `plan-supersession - violation: supersede 先が実在しない ${r.missingTargets.length} 件 (${refs}): plan_id を確認せよ`,
    );
  }
  if (r.missingBackrefs.length > 0) {
    const refs = r.missingBackrefs.map((v) => `${v.plan_id}→${v.target}`).join(", ");
    msgs.push(
      `plan-supersession - violation: supersede 先に訂正 back-reference が無い ${r.missingBackrefs.length} 件 (${refs}): 原 PLAN に「${"<後継 plan_id>"} が訂正」注記を追記し errata を双方向化せよ`,
    );
  }
  if (msgs.length === 0) {
    msgs.push(
      "plan-supersession — OK (宣言された supersede は全て実在 + 双方向 back-reference 済)",
    );
  }
  return msgs;
}
