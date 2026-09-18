/**
 * 設計判断エリシテーション文脈 (PLAN-L7-428、governance 正本 =
 * docs/governance/design-decision-elicitation.md)。
 *
 * 工程表 projection (schedule_entries → selectScheduleLiveState) から現在ステージを
 * 自己認識し、skill decision_points (聞かずに既定で進められる判断) と typed-spec
 * 設計カバレッジ (spec_defs / spec_relations、checked-ZIP 由来設計資産の投影) を
 * 結合して「何を聞き、何を聞かずに進めるか」を 1 packet で返す。
 * 各入力は fail-open (欠けても文脈全体は返す)。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  type ScheduleLiveEntry,
  selectScheduleLiveState,
} from "../handover/session-start-digest.ts";
import { buildSkillInjectionSet, recommendSkillsForPlan } from "../skill-engine/recommend.ts";
import type { HarnessDb } from "../state-db/index.ts";

export interface ElicitationPlanInfo {
  plan_id: string;
  kind: string;
  layer: string;
  drive: string;
  status: string;
  route_mode: string;
}

export interface SkillDecisionDefault {
  skill_id: string;
  when: string;
  choose: string;
  over: string;
  because: string;
}

export interface DesignCoverageSummary {
  layer: string;
  spec_count: number;
  relation_count: number;
  /** lifecycle_status ごとの spec 件数 (例: active / draft)。 */
  by_lifecycle: Record<string, number>;
  /** 代表 spec (最大 10 件): spec_id + title。 */
  specs: Array<{ spec_id: string; title: string; lifecycle_status: string }>;
}

export interface ElicitationContext {
  plan: ElicitationPlanInfo | null;
  /** plan に対応する工程表 live row (無ければ current 先頭)。 */
  stage: ScheduleLiveEntry | null;
  stage_source: "plan-match" | "schedule-current" | "none";
  /** skill decision_points 由来の「聞かずに既定で進められる判断」。 */
  decision_defaults: SkillDecisionDefault[];
  /** decision_points を読めなかった skill (fail-open の可視化)。 */
  unreadable_skills: string[];
  design_coverage: DesignCoverageSummary | null;
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function selectPlanInfo(db: HarnessDb, planId: string): ElicitationPlanInfo | null {
  const row = db
    .prepare(
      "SELECT plan_id, kind, layer, drive, status, route_mode FROM plan_registry WHERE plan_id = ?",
    )
    .get(planId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    plan_id: text(row.plan_id),
    kind: text(row.kind),
    layer: text(row.layer),
    drive: text(row.drive),
    status: text(row.status),
    route_mode: text(row.route_mode),
  };
}

function readSkillDecisionPoints(
  repoRoot: string,
  skillPath: string,
): SkillDecisionDefault[] | null {
  try {
    const raw = readFileSync(join(repoRoot, skillPath), "utf8");
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return [];
    const frontmatter = parseYaml(match[1]) as Record<string, unknown> | null;
    const points = frontmatter?.decision_points;
    if (!Array.isArray(points)) return [];
    const skillId = text(frontmatter?.name);
    return points
      .map((point) => {
        const record = (point ?? {}) as Record<string, unknown>;
        return {
          skill_id: skillId,
          when: text(record.when),
          choose: text(record.choose),
          over: text(record.over),
          because: text(record.because),
        };
      })
      .filter((point) => point.when && point.choose);
  } catch {
    return null;
  }
}

function selectDesignCoverage(db: HarnessDb, plan: ElicitationPlanInfo): DesignCoverageSummary {
  const specs = (
    db
      .prepare(
        "SELECT spec_id, title, lifecycle_status FROM spec_defs WHERE plan_id = ? OR layer = ? ORDER BY spec_id",
      )
      .all(plan.plan_id, plan.layer) as Array<Record<string, unknown>>
  ).map((row) => ({
    spec_id: text(row.spec_id),
    title: text(row.title),
    lifecycle_status: text(row.lifecycle_status),
  }));
  const specIds = new Set(specs.map((spec) => spec.spec_id));
  const relations = (
    db.prepare("SELECT from_spec_id, to_spec_id FROM spec_relations").all() as Array<
      Record<string, unknown>
    >
  ).filter((row) => specIds.has(text(row.from_spec_id)) || specIds.has(text(row.to_spec_id)));
  const byLifecycle: Record<string, number> = {};
  for (const spec of specs) {
    const key = spec.lifecycle_status || "(unset)";
    byLifecycle[key] = (byLifecycle[key] ?? 0) + 1;
  }
  return {
    layer: plan.layer,
    spec_count: specs.length,
    relation_count: relations.length,
    by_lifecycle: byLifecycle,
    specs: specs.slice(0, 10),
  };
}

export function selectElicitationContext(
  db: HarnessDb,
  options: { repoRoot: string; planId?: string },
): ElicitationContext {
  const schedule = selectScheduleLiveState(db);
  let stage: ScheduleLiveEntry | null = null;
  let stageSource: ElicitationContext["stage_source"] = "none";
  let planId = text(options.planId);
  if (planId) {
    stage = schedule.entries.find((entry) => entry.plan_id === planId) ?? null;
    if (stage) stageSource = "plan-match";
  } else if (schedule.current.length > 0) {
    stage = schedule.current[0];
    stageSource = "schedule-current";
    planId = stage.plan_id;
  }

  const plan = planId ? selectPlanInfo(db, planId) : null;

  const decisionDefaults: SkillDecisionDefault[] = [];
  const unreadableSkills: string[] = [];
  if (plan) {
    const recommendations = recommendSkillsForPlan(db, plan.plan_id, { limit: 8 });
    const injection = buildSkillInjectionSet(db, recommendations);
    // path 未解決 (asset 行はあるが実体 path が引けない) も unreadable として可視化する
    // (blind review FLAG: 推薦済み既定判断の静かな欠落を防ぐ)
    unreadableSkills.push(...injection.missing_skill_ids);
    for (const entry of injection.entries) {
      const points = readSkillDecisionPoints(options.repoRoot, entry.skill_path);
      if (points === null) {
        unreadableSkills.push(entry.skill_id);
        continue;
      }
      decisionDefaults.push(...points);
    }
  }

  return {
    plan,
    stage,
    stage_source: stageSource,
    decision_defaults: decisionDefaults,
    unreadable_skills: unreadableSkills,
    design_coverage: plan ? selectDesignCoverage(db, plan) : null,
  };
}

/** 設計判断依頼 packet を人間可読 (日本語) で描画する。 */
export function renderElicitationContext(ctx: ElicitationContext): string {
  const lines = ["elicitation context (source=schedule_entries + skills + spec_defs)"];
  lines.push("[1/4 stage]");
  if (ctx.stage) {
    lines.push(
      `  ${ctx.stage_source === "plan-match" ? "plan" : "current"}: ${ctx.stage.effective_rag} ${ctx.stage.plan_id} ${ctx.stage.current_location}`,
    );
    if (ctx.stage.blocked_reason) lines.push(`  blocked: ${ctx.stage.blocked_reason}`);
  } else if (ctx.plan) {
    lines.push(`  plan: ${ctx.plan.plan_id} (工程表 row なし)`);
  } else {
    lines.push("  - no ready schedule row / plan 未指定");
  }
  if (ctx.plan) {
    lines.push(
      `  registry: kind=${ctx.plan.kind} layer=${ctx.plan.layer} drive=${ctx.plan.drive} status=${ctx.plan.status}`,
    );
  }

  lines.push("[2/4 design-coverage]");
  if (ctx.design_coverage) {
    const lifecycle = Object.entries(ctx.design_coverage.by_lifecycle)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, count]) => `${key}=${count}`)
      .join(" ");
    lines.push(
      `  layer=${ctx.design_coverage.layer} specs=${ctx.design_coverage.spec_count} relations=${ctx.design_coverage.relation_count}${lifecycle ? ` (${lifecycle})` : ""}`,
    );
    for (const spec of ctx.design_coverage.specs) {
      lines.push(`  - ${spec.spec_id}: ${spec.title} [${spec.lifecycle_status || "unset"}]`);
    }
    if (ctx.design_coverage.spec_count > ctx.design_coverage.specs.length) {
      lines.push(
        `  - (+${ctx.design_coverage.spec_count - ctx.design_coverage.specs.length} more specs)`,
      );
    }
  } else {
    lines.push("  - none (plan 未解決)");
  }

  lines.push("[3/4 defaults] 聞かずに既定で進められる判断 (skill decision_points)");
  if (ctx.decision_defaults.length === 0) lines.push("  - none");
  for (const point of ctx.decision_defaults) {
    lines.push(`  - [${point.skill_id}] ${point.when} → ${point.choose} (over: ${point.over})`);
  }
  for (const skillId of ctx.unreadable_skills) {
    lines.push(`  - (unreadable skill asset: ${skillId})`);
  }

  lines.push("[4/4 template] 上記の defaults / coverage で確定しない trade-off のみ PO へ:");
  lines.push("  ## 設計判断依頼: <判断の種別>");
  lines.push(
    `  対象: ${ctx.plan?.plan_id ?? "<plan_id>"}${ctx.stage ? ` @ ${ctx.stage.current_location}` : ""}`,
  );
  lines.push("  前提: <2〜3 行>");
  lines.push("  | 案 | 内容 | 得るもの | 失うもの |");
  lines.push("  | A (推奨) | ... | ... | ... |");
  lines.push("  | B | ... | ... | ... |");
  lines.push("  推奨理由: <1 行> (選択肢は 2〜4 個、governance §共通ルール 1)");
  return `${lines.join("\n")}\n`;
}
