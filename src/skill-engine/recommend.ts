import { workflowModeForPlan as catalogWorkflowModeForPlan } from "../schema/mode-catalog";
import type { HarnessDb } from "../state-db/index";
import { upsertRow } from "../state-db/index";
import { classifyTask } from "../task/classify";

export interface PlanSkillContext {
  plan_id: string;
  layer: string;
  drive: string;
  kind: string;
  status: string;
  route_mode?: string;
}

/**
 * scoreSkill / rankSkills が要求する正規化済みスコアリング文脈。PLAN 由来 (recommendSkillsForPlan) と
 * 自由文 由来 (recommendSkillsForText) の双方が同じ文脈型へ落ちることで、`--text` を flat ranked list の
 * まま additive に足せる (A-138 ITEM-2、cross_agent TL 裏取り済: flat-list 維持 / 3-bucket は PO 残課題)。
 */
interface SkillScoringContext {
  /** recommendation の plan_id 欄に入る参照子 (PLAN id か `text:<slug>` sentinel)。 */
  reference: string;
  layer: string;
  drive: string;
  kind: string;
  workflowMode: string;
  reason: string;
}

export interface SkillRecommendation {
  skill_recommendation_id: string;
  session_id: string;
  plan_id: string;
  skill_id: string;
  rank: number;
  score: number;
  reason: string;
  recommended_at: string;
}

/**
 * 3-bucket 出力 (A-138 ITEM-2 PO 残課題、TL 素案を PO 承認 = TL 結果に合わせる)。
 * flat ranked list の **additive view** (既存 flat 出力は不変、`--buckets` 時のみ再編成)。
 *  - `required`    : layer + drive_model 双方が強く一致 (gate/workflow 文脈に直結) = score ≥ 0.8
 *  - `recommended` : 品質・安全に強く寄与するが必須でない = 0.5 ≤ score < 0.8
 *  - `optional`    : 補助的・状況依存 = 0 < score < 0.5
 * 閾値は score band を正本とする (scoreSkill の layer+drive_model+review 加点設計に対応)。
 */
export interface SkillBuckets {
  required: SkillRecommendation[];
  recommended: SkillRecommendation[];
  optional: SkillRecommendation[];
}

export const SKILL_BUCKET_THRESHOLDS = { required: 0.8, recommended: 0.5 } as const;
export type SkillInjectionTier = keyof SkillBuckets;
export type SkillInjectionTiming = "before_work" | "on_demand";

export interface SkillInjectionEntry {
  skill_id: string;
  skill_path: string;
  tier: SkillInjectionTier;
  inject_at: SkillInjectionTiming;
  reason: string;
  rank: number;
  score: number;
}

export interface SkillInjectionSet {
  plan_id: string;
  generated_at: string;
  entries: SkillInjectionEntry[];
  required_paths: string[];
  optional_paths: string[];
  missing_skill_ids: string[];
}

export function bucketRecommendations(rows: SkillRecommendation[]): SkillBuckets {
  const buckets: SkillBuckets = { required: [], recommended: [], optional: [] };
  for (const row of rows) {
    if (row.score >= SKILL_BUCKET_THRESHOLDS.required) buckets.required.push(row);
    else if (row.score >= SKILL_BUCKET_THRESHOLDS.recommended) buckets.recommended.push(row);
    else buckets.optional.push(row);
  }
  return buckets;
}

function skillAssetPath(db: HarnessDb, skillId: string): string | undefined {
  const row = db
    .prepare("SELECT path FROM automation_assets WHERE asset_type = ? AND asset_id = ?")
    .get("skill", skillId) as { path?: string } | undefined;
  return row?.path ? String(row.path) : undefined;
}

export function buildSkillInjectionSet(
  db: HarnessDb,
  recommendations: SkillRecommendation[],
  options: { generatedAt?: string } = {},
): SkillInjectionSet {
  const buckets = bucketRecommendations(recommendations);
  const entries: SkillInjectionEntry[] = [];
  const missingSkillIds: string[] = [];
  const generatedAt = options.generatedAt ?? nowIso();
  const planId = recommendations[0]?.plan_id ?? "";

  for (const tier of ["required", "recommended", "optional"] as const) {
    for (const recommendation of buckets[tier]) {
      const skillPath = skillAssetPath(db, recommendation.skill_id);
      if (!skillPath) {
        missingSkillIds.push(recommendation.skill_id);
        continue;
      }
      entries.push({
        skill_id: recommendation.skill_id,
        skill_path: skillPath,
        tier,
        inject_at: tier === "optional" ? "on_demand" : "before_work",
        reason: recommendation.reason,
        rank: recommendation.rank,
        score: recommendation.score,
      });
    }
  }

  const requiredPaths = entries
    .filter((entry) => entry.inject_at === "before_work")
    .map((entry) => entry.skill_path);
  const optionalPaths = entries
    .filter((entry) => entry.inject_at === "on_demand")
    .map((entry) => entry.skill_path);

  return {
    plan_id: planId,
    generated_at: generatedAt,
    entries,
    required_paths: requiredPaths,
    optional_paths: optionalPaths,
    missing_skill_ids: missingSkillIds,
  };
}

export interface SkillInvocation {
  skill_invocation_id: string;
  session_id: string;
  plan_id: string;
  skill_id: string;
  layer: string;
  drive: string;
  fired_at: string;
  source: string;
  accepted: number;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}:${value.replace(/[^A-Za-z0-9._:-]+/g, "-")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

// PLAN-L7-243: mode 導出は route_mode 正本 + legacy フォールバックの共有カタログ
// (src/schema/mode-catalog.ts) を使う。plan_id 文字列推測の独自分岐は廃止。

/** TaskKind → workflow drive model (自由文 suggest の drive_model 推定、A-138 ITEM-2)。 */
function workflowModeForKind(kind: string): string {
  switch (kind) {
    case "reverse":
      return "Reverse";
    case "poc":
      return "Discovery";
    case "refactor":
      return "Refactor";
    case "troubleshoot":
      return "Recovery";
    default:
      return "Forward"; // design / add-feature / unknown
  }
}

/** 自由文 → 安定参照子 (`text:<slug>`)。Date/random 不使用 (決定論)。 */
function textReference(text: string): string {
  const slug = text
    .slice(0, 48)
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `text:${slug || "task"}`;
}

/** L/駆動が空でも索引可能な category (skill-index.md §2.1)。skill-assignment と同一集合。 */
const SITUATION_CATEGORIES = new Set<string>(["domain", "project"]);

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

/**
 * ctx 由来 token と asset メタデータ token の重なり数に比例する graduated score (0..0.2)。
 * skill ごとに trigger/domain_tags/capability が異なるため score が分散し、score=1 飽和と
 * 同点アルファベット順退化を解消する (DISCOVERY-03 §5 実測限界 → skill-index.md §4 de-saturate)。
 * 決定論: Set の重なり数のみに依存し iteration 順に非依存。
 */
function metadataOverlap(ctx: SkillScoringContext, asset: Record<string, unknown>): number {
  const assetTokens = new Set(
    tokenize(
      [asset.trigger, asset.capability, asset.skill_type, asset.role, asset.category]
        .map((value) => String(value ?? ""))
        .join(" "),
    ),
  );
  const ctxTokens = new Set(
    tokenize([ctx.drive, ctx.kind, ctx.workflowMode, ctx.reference].join(" ")),
  );
  let matches = 0;
  for (const token of ctxTokens) {
    if (assetTokens.has(token)) matches += 1;
  }
  return Math.min(0.2, matches * 0.05);
}

function scoreSkill(ctx: SkillScoringContext, asset: Record<string, unknown>): number {
  const appliesLayers = String(asset.applies_layers ?? "")
    .split(",")
    .filter(Boolean);
  const appliesDriveModels = String(asset.applies_drive_models ?? "")
    .split(",")
    .filter(Boolean);
  const category = String(asset.category ?? "").trim();
  const reviewText = [asset.skill_type, asset.trigger, asset.capability, asset.role]
    .map((value) => String(value ?? ""))
    .join(" ")
    .toLowerCase();
  const overlap = metadataOverlap(ctx, asset); // graduated メタデータ軸 (de-saturator)
  let score = 0.15;
  if (ctx.layer && appliesLayers.includes(ctx.layer)) score += 0.3; // L 軸
  if (appliesDriveModels.includes(ctx.workflowMode)) score += 0.3; // 駆動軸
  score += overlap;
  if (/review|checklist|quality|test|lint/.test(reviewText)) score += 0.05;
  // domain/project skill は L 軸/駆動軸が 0 点ゆえ、task が domain_tags/industry に一致したとき
  // (overlap>0) に situation-pull で浮上させる (skill-index.md §4 の「シチュエーションで引く」経路)。
  if (SITUATION_CATEGORIES.has(category) && overlap > 0) score += 0.1;
  return Math.min(1, Number(score.toFixed(2)));
}

// PLAN-L7-262: session_id 貫通。hook 経由でない CLI 実行は UT_TDD_SESSION_ID env を
// 引き、無ければ明示の不明 marker を使う (空文字での偽装をやめる)。
export const UNKNOWN_RUNTIME_SESSION_ID = "cli:unknown-session";

export function resolveRuntimeSessionId(env: NodeJS.ProcessEnv = process.env): string {
  return env.UT_TDD_SESSION_ID?.trim() || UNKNOWN_RUNTIME_SESSION_ID;
}

/** 文脈非依存の共通ランキング: skill asset をスコアし top-N の SkillRecommendation を返す。 */
function rankSkills(
  db: HarnessDb,
  ctx: SkillScoringContext,
  options: { limit?: number; recordedAt?: string; sessionId?: string },
): SkillRecommendation[] {
  const assets = db
    .prepare("SELECT * FROM automation_assets WHERE asset_type = ? ORDER BY asset_id")
    .all("skill");
  const recommendedAt = options.recordedAt ?? nowIso();
  return assets
    .map((asset) => ({ asset, score: scoreSkill(ctx, asset) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        String(a.asset.asset_id ?? "").localeCompare(String(b.asset.asset_id ?? "")),
    )
    .slice(0, options.limit ?? 5)
    .map((entry, index) => {
      const skillId = String(entry.asset.asset_id ?? "");
      return {
        skill_recommendation_id: stableId("skill-rec", `${ctx.reference}:${skillId}`),
        session_id: options.sessionId ?? resolveRuntimeSessionId(),
        plan_id: ctx.reference,
        skill_id: skillId,
        rank: index + 1,
        score: entry.score,
        reason: ctx.reason,
        recommended_at: recommendedAt,
      };
    });
}

export function recommendSkillsForPlan(
  db: HarnessDb,
  planId: string,
  options: { limit?: number; recordedAt?: string } = {},
): SkillRecommendation[] {
  const plan = db
    .prepare(
      "SELECT plan_id, layer, drive, kind, status, route_mode FROM plan_registry WHERE plan_id = ?",
    )
    .get(planId) as PlanSkillContext | undefined;
  if (!plan) return [];
  const workflowMode = catalogWorkflowModeForPlan({
    planId: plan.plan_id,
    routeMode: plan.route_mode,
    kind: plan.kind,
  });
  return rankSkills(
    db,
    {
      reference: plan.plan_id,
      layer: plan.layer,
      drive: plan.drive,
      kind: plan.kind,
      workflowMode,
      reason: `layer=${plan.layer}; technical_drive=${plan.drive}; drive_model=${workflowMode}; kind=${plan.kind}`,
    },
    options,
  );
}

/**
 * 自由文タスクから skill を suggest する additive サーフェス (A-138 ITEM-2、`--text`)。`classifyTask` で
 * kind/drive/risk を導き synthetic 文脈へ落とす。PLAN registry を引かないので layer は空 (layer ボーナス無し)。
 * 出力は PLAN 版と同じ flat ranked list (3-bucket 化は PO 残課題)。未登録タスクなので DB record はしない。
 */
export function recommendSkillsForText(
  db: HarnessDb,
  taskText: string,
  options: { limit?: number; recordedAt?: string } = {},
): SkillRecommendation[] {
  const c = classifyTask({ text: taskText });
  const workflowMode = workflowModeForKind(c.kind);
  return rankSkills(
    db,
    {
      reference: textReference(taskText),
      layer: "",
      drive: c.drive,
      kind: c.kind,
      workflowMode,
      reason: `source=text; technical_drive=${c.drive}; drive_model=${workflowMode}; kind=${c.kind}; risk=${c.risk_flags.join("|") || "none"}`,
    },
    options,
  );
}

export function recordSkillRecommendations(
  db: HarnessDb,
  recommendations: SkillRecommendation[],
): void {
  for (const recommendation of recommendations) {
    upsertRow(db, {
      table: "skill_recommendations",
      primaryKey: "skill_recommendation_id",
      row: { ...recommendation },
    });
  }
}

export function inferSkillInvocations(
  db: HarnessDb,
  recommendations: SkillRecommendation[],
  options: { firedAt?: string } = {},
): SkillInvocation[] {
  const firedAt = options.firedAt ?? nowIso();
  const invocations: SkillInvocation[] = [];
  for (const rec of recommendations) {
    const plan = db
      .prepare("SELECT layer, drive FROM plan_registry WHERE plan_id = ?")
      .get(rec.plan_id) as { layer?: string; drive?: string } | undefined;
    const review = db
      .prepare("SELECT has_evidence FROM review_evidence_registry WHERE plan_id = ?")
      .get(rec.plan_id) as { has_evidence?: number } | undefined;
    const accepted = Number(review?.has_evidence ?? 0) === 1 ? 1 : 0;
    if (!accepted) continue;
    invocations.push({
      skill_invocation_id: stableId("skill-inv", `${rec.plan_id}:${rec.skill_id}:review`),
      session_id: rec.session_id,
      plan_id: rec.plan_id,
      skill_id: rec.skill_id,
      layer: String(plan?.layer ?? ""),
      drive: String(plan?.drive ?? ""),
      fired_at: firedAt,
      source: "auto-projection:review-evidence",
      accepted,
    });
  }
  return invocations;
}

export function recordSkillInvocations(db: HarnessDb, invocations: SkillInvocation[]): void {
  for (const invocation of invocations) {
    upsertRow(db, {
      table: "skill_invocations",
      primaryKey: "skill_invocation_id",
      row: { ...invocation },
    });
  }
}
