import type { HarnessDb } from "../state-db/index";
import { upsertRow } from "../state-db/index";

export interface SkillMetric {
  plan_id: string;
  skill_id: string;
  firing_rate: number;
  acceptance_rate: number;
}

export interface FeedbackEvent {
  feedback_event_id: string;
  finding_id: string;
  plan_id: string;
  signal_type: string;
  severity: string;
  status: string;
  next_action: string;
  created_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function metricKey(planId: string, skillId: string, metric: string): string {
  return `skill:${planId}:${skillId}:${metric}`;
}

function toBool(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

export function computeSkillMetrics(db: HarnessDb): SkillMetric[] {
  const recommendations = db.prepare("SELECT * FROM skill_recommendations").all();
  const invocations = db.prepare("SELECT * FROM skill_invocations").all();
  const groups = new Map<
    string,
    { planId: string; skillId: string; rec: number; inv: number; acc: number }
  >();

  for (const rec of recommendations) {
    const planId = String(rec.plan_id ?? "");
    const skillId = String(rec.skill_id ?? "");
    if (!planId || !skillId) continue;
    const key = `${planId}:${skillId}`;
    const group = groups.get(key) ?? { planId, skillId, rec: 0, inv: 0, acc: 0 };
    group.rec += 1;
    groups.set(key, group);
  }
  for (const inv of invocations) {
    const planId = String(inv.plan_id ?? "");
    const skillId = String(inv.skill_id ?? "");
    if (!planId || !skillId) continue;
    const key = `${planId}:${skillId}`;
    const group = groups.get(key) ?? { planId, skillId, rec: 0, inv: 0, acc: 0 };
    group.inv += 1;
    if (toBool(inv.accepted)) group.acc += 1;
    groups.set(key, group);
  }

  const computedAt = nowIso();
  const metrics = [...groups.values()]
    .sort((a, b) => a.planId.localeCompare(b.planId) || a.skillId.localeCompare(b.skillId))
    .map((group) => {
      const firing = group.rec === 0 ? 0 : group.inv / group.rec;
      const acceptance = group.inv === 0 ? 0 : group.acc / group.inv;
      upsertRow(db, {
        table: "quality_signals",
        primaryKey: "signal_id",
        row: {
          signal_id: metricKey(group.planId, group.skillId, "firing_rate"),
          source: "skill-metrics",
          subject_id: `${group.planId}:${group.skillId}`,
          metric: "skill_firing_rate",
          value: firing,
          threshold: 1,
          status: firing < 1 ? "warn" : "pass",
          computed_at: computedAt,
        },
      });
      upsertRow(db, {
        table: "quality_signals",
        primaryKey: "signal_id",
        row: {
          signal_id: metricKey(group.planId, group.skillId, "acceptance_rate"),
          source: "skill-metrics",
          subject_id: `${group.planId}:${group.skillId}`,
          metric: "skill_acceptance_rate",
          value: acceptance,
          threshold: 1,
          status: acceptance < 1 ? "warn" : "pass",
          computed_at: computedAt,
        },
      });
      if (group.rec === 0 && group.inv > 0) {
        upsertRow(db, {
          table: "findings",
          primaryKey: "finding_id",
          row: {
            finding_id: `finding:skill-missing-recommendation:${group.planId}:${group.skillId}`,
            kind: "missing-skill-recommendation",
            severity: "warn",
            subject_id: `${group.planId}:${group.skillId}`,
            source: "feedback-engine",
            status: "open",
            evidence_path: "",
          },
        });
      }
      return {
        plan_id: group.planId,
        skill_id: group.skillId,
        firing_rate: firing,
        acceptance_rate: acceptance,
      } satisfies SkillMetric;
    });
  return metrics;
}

function feedbackId(prefix: string, subject: string): string {
  return `${prefix}:${subject}`.replace(/[^A-Za-z0-9._:-]+/g, "-");
}

export function emitFeedbackEvents(db: HarnessDb): FeedbackEvent[] {
  const openFindings = db.prepare("SELECT * FROM findings WHERE status = 'open'").all();
  const failedSignals = db
    .prepare("SELECT * FROM quality_signals WHERE status IN ('fail', 'warn')")
    .all();
  const createdAt = nowIso();
  const events: FeedbackEvent[] = [];

  for (const finding of openFindings) {
    const subject = String(finding.subject_id ?? finding.finding_id ?? "");
    const event: FeedbackEvent = {
      feedback_event_id: feedbackId("feedback:finding", String(finding.finding_id ?? subject)),
      finding_id: String(finding.finding_id ?? ""),
      plan_id: subject.startsWith("PLAN-") ? subject : "",
      signal_type: String(finding.kind ?? "finding"),
      severity: String(finding.severity ?? "warn"),
      status: "open",
      next_action: `review finding ${finding.finding_id ?? subject}`,
      created_at: createdAt,
    };
    upsertRow(db, { table: "feedback_events", primaryKey: "feedback_event_id", row: { ...event } });
    events.push(event);
  }

  for (const signal of failedSignals) {
    const subject = String(signal.subject_id ?? signal.signal_id ?? "");
    const event: FeedbackEvent = {
      feedback_event_id: feedbackId("feedback:signal", String(signal.signal_id ?? subject)),
      finding_id: "",
      plan_id: subject.startsWith("PLAN-") ? subject : "",
      signal_type: String(signal.metric ?? "quality_signal"),
      severity: String(signal.status ?? "warn") === "fail" ? "warn" : "info",
      status: "open",
      next_action: `review quality signal ${signal.signal_id ?? subject}`,
      created_at: createdAt,
    };
    upsertRow(db, { table: "feedback_events", primaryKey: "feedback_event_id", row: { ...event } });
    events.push(event);
  }
  return events.sort((a, b) => a.feedback_event_id.localeCompare(b.feedback_event_id));
}
