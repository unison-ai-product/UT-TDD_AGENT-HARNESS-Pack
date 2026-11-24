import type { HarnessDb } from "./index.ts";

// Only direct runtime invocations contribute to skill metrics and evaluations.
export const RUNTIME_SKILL_SOURCE_PREFIX = "runtime-hook:";

export interface SkillProjectionEvent {
  table: string;
  id: string;
  row: Record<string, unknown>;
}

export interface SkillProjectionDeps {
  nowIso: () => string;
  stableId: (prefix: string, value: string) => string;
  recordProjectionEvent: (db: HarnessDb, event: SkillProjectionEvent) => void;
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
       WHERE r.skill_id <> ''
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
              MAX(i.fired_at) AS last_fired_at
       FROM skill_invocations i
       WHERE i.accepted = 1
         AND i.source LIKE ?
         AND i.skill_id <> ''
       GROUP BY i.skill_id`,
    )
    .all(`${RUNTIME_SKILL_SOURCE_PREFIX}%`);

  if (adoptionRows.length === 0) return;

  for (const row of adoptionRows) {
    const skillId = String(row.skill_id ?? "");

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
        unused_flag: unusedFlag,
        evaluated_at: evaluatedAt,
      },
    });
  }
}
