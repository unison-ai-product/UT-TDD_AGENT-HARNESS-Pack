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
 *  0. X が P 自身 (core-id 一致) でないこと (issue #183)。自己参照は 1/2 を**無検査で満たす** —
 *     実在は自明、back-reference も自分の frontmatter の `plan_id` が必ず一致するため。
 *     結果 errata の双方向性 (誤りと判明した先行 PLAN が後継を指す) が担保されないまま gate を
 *     自明通過する。revision lineage の正本は `admission_receipt.origin.{plan_id, revision}` で
 *     あり自己 supersede は冗長。evidence 層 (`plan-asset/domain/evidence-record.ts`) が
 *     `supersedesEvidenceId === evidenceId` を無効入力として reject しているのと同じ規律。
 *  1. X が実在する plan_id であること (誤記/typo の supersede 先を弾く)。
 *  2. X の本文が P の core-id (`PLAN-<cat>-<n>`) を含むこと (= 原 PLAN に訂正 back-reference がある)。
 * いずれか欠落 → violation。`supersedes` 非宣言の PLAN は対象外 (誤記の有無は判定しない = prose 真偽は
 * 機械化しない)。宣言された errata リンクの整合のみを強制する。
 *
 * 純関数 (analyze) + I/O loader 分離 (scrum-reverse / backfill-pairing と同方針)。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fmValue } from "./shared.ts";

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
  /** supersede 先が自分自身 (core-id 一致)。errata ゲートを自明通過させる (issue #183)。 */
  selfSupersedes: { plan_id: string; target: string }[];
  /** baseline 宣言済みの自己 supersede (可視化のみ、ok には連動しない)。 */
  baselinedSelfSupersedes: { plan_id: string; target: string }[];
  /** baseline に載っているのに自己 supersede が消えている PLAN (baseline を縮小せよ)。 */
  staleSelfBaseline: string[];
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

/**
 * 自己 supersede の既知債務 (issue #183 で実測した 7 件、**縮小のみ可**)。
 *
 * これらは frontmatter の top-level `supersedes` と `admission_receipt.supersedes` の**双方**に
 * 自己参照を持つ。`src/schema/frontmatter.ts` が「top-level supersedes は receipt と完全一致必須」を
 * 強制するため、top-level だけ削ると `invalid_frontmatter` になる (PR #208 の CI で実測)。
 * receipt は `source_digest` / `decision_digest` / `receipt_digest` を持つ発行済み証明書であり、
 * 手編集は `plan-admission/diff-fence` の突合対象を壊す。正規の解消は PlanAsset の revision
 * authoring 経路で receipt を再発行することであり、本 lint の slice では扱わない (別 issue)。
 *
 * したがって本 baseline は「検出できない fail-open」を「宣言済みの可視債務」へ変えるためのもので、
 * **新規の自己 supersede は baseline 外なので fail-close する**。baseline は縮小のみ可
 * (`impl-plan-trace` / `oracle-test-trace` の baseline と同方針)。
 */
export const PLAN_SUPERSESSION_SELF_BASELINE: ReadonlySet<string> = new Set([
  "PLAN-L4-02-architecture",
  "PLAN-L4-32-resource-governed-execution-kernel",
  "PLAN-L5-03-internal-processing",
  "PLAN-L5-25-resource-kernel-physical-protocol",
  "PLAN-L6-01-function-spec",
  "PLAN-L6-92-resource-kernel-function-contracts",
  "PLAN-L7-466-resource-kernel-native-companion",
]);

export function analyzePlanSupersession(
  plans: ParsedSupersedePlan[],
  baseline: ReadonlySet<string> = PLAN_SUPERSESSION_SELF_BASELINE,
): PlanSupersessionResult {
  const byId = new Map(plans.map((p) => [p.plan_id, p]));
  const missingTargets: { plan_id: string; target: string }[] = [];
  const missingBackrefs: { plan_id: string; target: string }[] = [];
  const selfSupersedes: { plan_id: string; target: string }[] = [];
  const baselinedSelfSupersedes: { plan_id: string; target: string }[] = [];

  for (const p of plans) {
    const core = planCoreId(p.plan_id);
    const backref = new RegExp(`\\b${core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    for (const target of p.supersedes) {
      // 自己参照は 2 条件を無検査で満たす (実在は自明、back-reference は自分の frontmatter の
      // plan_id が必ず一致) ため、存在・back-reference の判定より前に弾く (issue #183)。
      if (planCoreId(target) === core) {
        if (baseline.has(p.plan_id)) baselinedSelfSupersedes.push({ plan_id: p.plan_id, target });
        else selfSupersedes.push({ plan_id: p.plan_id, target });
        continue;
      }
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

  // baseline は縮小のみ可。載っているのに自己 supersede が消えたら baseline を縮めさせる。
  const stillBaselined = new Set(baselinedSelfSupersedes.map((v) => v.plan_id));
  const staleSelfBaseline = [...baseline]
    .filter((planId) => byId.has(planId) && !stillBaselined.has(planId))
    .sort();

  return {
    missingTargets,
    missingBackrefs,
    selfSupersedes,
    baselinedSelfSupersedes,
    staleSelfBaseline,
    ok:
      missingTargets.length === 0 &&
      missingBackrefs.length === 0 &&
      selfSupersedes.length === 0 &&
      staleSelfBaseline.length === 0,
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
  if (r.staleSelfBaseline.length > 0) {
    msgs.push(
      `plan-supersession - violation: 自己 supersede baseline が実態より広い ${r.staleSelfBaseline.length} 件 (${r.staleSelfBaseline.join(", ")}): PLAN_SUPERSESSION_SELF_BASELINE から削除せよ (baseline は縮小のみ可)`,
    );
  }
  if (r.selfSupersedes.length > 0) {
    const refs = r.selfSupersedes.map((v) => `${v.plan_id}→${v.target}`).join(", ");
    msgs.push(
      `plan-supersession - violation: 自己 supersede は errata ゲートを自明通過するため禁止 (${refs}): revision lineage の正本は admission_receipt.origin であり、自己参照は冗長である`,
    );
  }
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
      `plan-supersession — OK (宣言された supersede は全て実在 + 双方向 back-reference 済、新規の自己参照 0、既知債務 ${r.baselinedSelfSupersedes.length} 件は baseline 宣言済)`,
    );
  }
  return msgs;
}
