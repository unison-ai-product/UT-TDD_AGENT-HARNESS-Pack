import {
  type SkillLearningSignals,
  scoreSkill as scoreSkillShared,
  shouldScoreSkillAsset,
} from "../skill-scoring/scoring.ts";
import type { HarnessDb } from "./index.ts";

// PLAN-L7-262: provenance 分離。
// - rebuild 由来の間接推定行は session 不明を明示する (空文字での偽装をやめる)。
// - firing/acceptance metrics は実 runtime 発火 (source が RUNTIME_SKILL_SOURCE_PREFIX)
//   のみから算出する。auto-projection 行は監査参照用に残るが metrics へ混ぜない。
export const REBUILD_INDIRECT_SESSION_ID = "rebuild:indirect";
export const RUNTIME_SKILL_SOURCE_PREFIX = "runtime-hook:";

export interface SkillProjectedPlan {
  planId: string;
  kind: string;
  layer: string;
  drive: string;
  status: string;
  updatedAt: string;
}

export interface SkillProjectionEvent {
  table: string;
  id: string;
  row: Record<string, unknown>;
}

export interface SkillProjectionDeps {
  nowIso: () => string;
  stableId: (prefix: string, value: string) => string;
  recordProjectionEvent: (db: HarnessDb, event: SkillProjectionEvent) => void;
  skillDriveModelForPlan: (planId: string) => string;
}

export { PLAN_SUCCESS_STATUSES } from "../projection/domain/plan-status.ts";

import { PLAN_SUCCESS_STATUSES } from "../projection/domain/plan-status.ts";

export function skillScore(input: {
  plan: SkillProjectedPlan;
  asset: Record<string, unknown>;
  deps: Pick<SkillProjectionDeps, "skillDriveModelForPlan">;
  learning?: SkillLearningSignals;
}): number {
  const { plan, asset, deps, learning } = input;
  const driveModel = deps.skillDriveModelForPlan(plan.planId);
  return scoreSkillShared(
    {
      reference: plan.planId,
      layer: plan.layer,
      drive: plan.drive,
      kind: plan.kind,
      workflowMode: driveModel,
    },
    asset,
    { learning },
  );
}

function skillLearningSignals(db: HarnessDb, skillId: string): SkillLearningSignals | undefined {
  const row = db.prepare("SELECT * FROM skill_evaluations WHERE skill_id = ?").get(skillId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return undefined;
  return {
    skillRating: Number(row.skill_rating ?? 0),
    adoptionCount: Number(row.adoption_count ?? 0),
    successCount: Number(row.success_count ?? 0),
    unusedFlag: Number(row.unused_flag ?? 0),
  };
}

export function projectSkillTelemetry(input: {
  db: HarnessDb;
  plans: Map<string, SkillProjectedPlan>;
  deps: SkillProjectionDeps;
}): void {
  const { db, plans, deps } = input;
  const recordedAt = deps.nowIso();
  const assets = db
    .prepare("SELECT * FROM automation_assets WHERE asset_type = ? ORDER BY asset_id")
    .all("skill")
    .filter(shouldScoreSkillAsset);
  for (const plan of plans.values()) {
    const ranked = assets
      .map((asset) => {
        const skillId = String(asset.asset_id ?? "");
        return {
          asset,
          score: skillScore({
            plan,
            asset,
            deps,
            learning: skillLearningSignals(db, skillId),
          }),
        };
      })
      .filter((entry) => entry.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          String(a.asset.asset_id ?? "").localeCompare(String(b.asset.asset_id ?? "")),
      )
      .slice(0, 5);
    const review = db
      .prepare("SELECT has_evidence FROM review_evidence_registry WHERE plan_id = ?")
      .get(plan.planId) as { has_evidence?: number } | undefined;
    const accepted = Number(review?.has_evidence ?? 0) === 1 ? 1 : 0;
    ranked.forEach((entry, index) => {
      const skillId = String(entry.asset.asset_id ?? "");
      const recId = deps.stableId("skill-rec", `${plan.planId}:${skillId}`);
      deps.recordProjectionEvent(db, {
        table: "skill_recommendations",
        id: recId,
        row: {
          skill_recommendation_id: recId,
          session_id: REBUILD_INDIRECT_SESSION_ID,
          plan_id: plan.planId,
          skill_id: skillId,
          rank: index + 1,
          score: entry.score,
          reason: `layer=${plan.layer}; technical_drive=${plan.drive}; drive_model=${deps.skillDriveModelForPlan(plan.planId)}; kind=${plan.kind}`,
          recommended_at: recordedAt,
        },
      });
      if (accepted === 1) {
        const invId = deps.stableId("skill-inv", `${plan.planId}:${skillId}:review`);
        deps.recordProjectionEvent(db, {
          table: "skill_invocations",
          id: invId,
          row: {
            skill_invocation_id: invId,
            session_id: REBUILD_INDIRECT_SESSION_ID,
            plan_id: plan.planId,
            skill_id: skillId,
            layer: plan.layer,
            drive: plan.drive,
            fired_at: recordedAt,
            source: "auto-projection:review-evidence",
            accepted,
          },
        });
      }
    });
  }
}

export function projectSkillMetrics(input: {
  db: HarnessDb;
  deps: Pick<SkillProjectionDeps, "nowIso" | "stableId" | "recordProjectionEvent">;
}): void {
  const { db, deps } = input;
  const computedAt = deps.nowIso();
  const rows = db
    .prepare(
      `SELECT r.plan_id, r.skill_id,
              COUNT(DISTINCT r.skill_recommendation_id) AS rec,
              COUNT(DISTINCT i.skill_invocation_id) AS inv,
              SUM(CASE WHEN i.accepted = 1 THEN 1 ELSE 0 END) AS acc
       FROM skill_recommendations r
       LEFT JOIN skill_invocations i
         ON i.plan_id = r.plan_id AND i.skill_id = r.skill_id
        AND i.source LIKE ?
       GROUP BY r.plan_id, r.skill_id`,
    )
    .all(`${RUNTIME_SKILL_SOURCE_PREFIX}%`);
  for (const row of rows) {
    const rec = Number(row.rec ?? 0);
    const inv = Number(row.inv ?? 0);
    const acc = Number(row.acc ?? 0);
    const planId = String(row.plan_id ?? "");
    const skillId = String(row.skill_id ?? "");
    const firing = rec === 0 ? 0 : inv / rec;
    const acceptance = inv === 0 ? 0 : acc / inv;
    for (const metric of [
      { name: "skill_firing_rate", value: firing },
      { name: "skill_acceptance_rate", value: acceptance },
    ]) {
      const signalId = deps.stableId("skill-signal", `${planId}:${skillId}:${metric.name}`);
      deps.recordProjectionEvent(db, {
        table: "quality_signals",
        id: signalId,
        row: {
          signal_id: signalId,
          source: "skill-metrics:runtime",
          subject_id: `${planId}:${skillId}`,
          metric: metric.name,
          value: Number(metric.value.toFixed(4)),
          threshold: 1,
          status: metric.value < 1 ? "warn" : "pass",
          computed_at: computedAt,
        },
      });
    }
  }
}

export function projectSkillEvaluations(input: {
  db: HarnessDb;
  opts?: { asOf?: string };
  deps: Pick<SkillProjectionDeps, "nowIso" | "recordProjectionEvent">;
}): void {
  const { db, opts, deps } = input;
  const evaluatedAt = opts?.asOf ?? deps.nowIso();
  const cutoff = new Date(new Date(evaluatedAt).getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const adoptionRows = db
    .prepare(
      `SELECT i.skill_id,
              COUNT(DISTINCT i.plan_id) AS adoption_count,
              MAX(i.fired_at) AS last_fired_at
       FROM skill_invocations i
       WHERE i.accepted = 1
         AND i.source LIKE ?
       GROUP BY i.skill_id`,
    )
    .all(`${RUNTIME_SKILL_SOURCE_PREFIX}%`);

  if (adoptionRows.length === 0) return;

  const successStatusPlaceholders = PLAN_SUCCESS_STATUSES.map(() => "?").join(", ");

  for (const row of adoptionRows) {
    const skillId = String(row.skill_id ?? "");
    const adoptionCount = Number(row.adoption_count ?? 0);

    const successRow = db
      .prepare(
        `SELECT COUNT(DISTINCT i.plan_id) AS success_count
         FROM skill_invocations i
         JOIN plan_registry p ON p.plan_id = i.plan_id
         WHERE i.skill_id = ?
           AND i.accepted = 1
           AND i.source LIKE ?
           AND p.status IN (${successStatusPlaceholders})`,
      )
      .get(skillId, `${RUNTIME_SKILL_SOURCE_PREFIX}%`, ...PLAN_SUCCESS_STATUSES) as
      | { success_count: number }
      | undefined;

    const successCount = Number(successRow?.success_count ?? 0);
    const skillRating = adoptionCount === 0 ? 0 : Number((successCount / adoptionCount).toFixed(4));

    const recentRow = db
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM skill_invocations
         WHERE skill_id = ? AND source LIKE ? AND fired_at >= ?`,
      )
      .get(skillId, `${RUNTIME_SKILL_SOURCE_PREFIX}%`, cutoff) as { cnt: number } | undefined;

    const unusedFlag = Number(recentRow?.cnt ?? 0) === 0 ? 1 : 0;

    deps.recordProjectionEvent(db, {
      table: "skill_evaluations",
      id: skillId,
      row: {
        skill_id: skillId,
        skill_rating: skillRating,
        adoption_count: adoptionCount,
        success_count: successCount,
        unused_flag: unusedFlag,
        evaluated_at: evaluatedAt,
      },
    });
  }
}
