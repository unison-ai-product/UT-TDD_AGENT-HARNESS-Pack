import { dirname, resolve } from "node:path";
import { stableId } from "../stable-id.ts";
import type { HarnessDb } from "../state-db/index.ts";
import { upsertRow } from "../state-db/index.ts";
import { detectorRouteCandidateAction } from "../state-db/route-candidate-review.ts";
import { RUNTIME_SKILL_SOURCE_PREFIX } from "../state-db/skill-projections.ts";
import {
  formatPostMergeBackstop,
  type PostMergeBackstopReason,
  type PostMergeBackstopResult,
  scanPostMergeBackstop,
} from "./post-merge-backstop.ts";

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
  source_table: string;
  source_id: string;
  source_generation: string;
  source_color: string;
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
  // PLAN-L7-262: metrics は実 runtime 発火のみを数える。auto-projection 由来の
  // 間接推定 invocation を firing/acceptance に混ぜない (A-178 G-8)。
  const invocations = db
    .prepare("SELECT * FROM skill_invocations WHERE source LIKE ?")
    .all(`${RUNTIME_SKILL_SOURCE_PREFIX}%`);
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
          source: "skill-metrics:runtime",
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
          source: "skill-metrics:runtime",
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
  return stableId(prefix, subject);
}

function signalSeverity(status: unknown): string {
  const normalized = String(status ?? "warn").toLowerCase();
  if (normalized === "fail" || normalized === "error") return normalized;
  if (normalized === "warn") return "warn";
  return "info";
}

export function emitFeedbackEvents(
  db: HarnessDb,
  options: { postMergeBackstop?: PostMergeBackstopResult } = {},
): FeedbackEvent[] {
  const detectorCandidates = db
    .prepare(
      `SELECT route_candidate_id, source_table, source_id, finding_kind, severity, subject_id,
              filing_target_id, target_layer, target_sub_doc, candidate_status, reason
       FROM detector_route_candidates
       WHERE candidate_status IN ('non_ready', 'ready', 'open')
       ORDER BY route_candidate_id`,
    )
    .all();
  const detectorCandidateFindingIds = new Set(
    detectorCandidates
      .filter((candidate) => String(candidate.source_table ?? "") === "findings")
      .map((candidate) => String(candidate.source_id ?? ""))
      .filter(Boolean),
  );
  const openFindings = db.prepare("SELECT * FROM findings WHERE status = 'open'").all();
  const failedSignals = db
    .prepare("SELECT * FROM quality_signals WHERE status IN ('fail', 'warn')")
    .all();
  const createdAt = nowIso();
  const events: FeedbackEvent[] = [];

  const postMergeBackstop =
    options.postMergeBackstop ??
    (db.path === ":memory:"
      ? undefined
      : scanPostMergeBackstop({
          repoRoot: resolve(dirname(resolve(db.path)), ".."),
        }));

  for (const finding of openFindings) {
    const findingId = String(finding.finding_id ?? "");
    if (detectorCandidateFindingIds.has(findingId)) continue;
    const subject = String(finding.subject_id ?? finding.finding_id ?? "");
    const event: FeedbackEvent = {
      feedback_event_id: feedbackId("feedback:finding", String(findingId || subject)),
      finding_id: findingId,
      plan_id: subject.startsWith("PLAN-") ? subject : "",
      source_table: "findings",
      source_id: findingId || subject,
      source_generation: feedbackId(
        "feedback-generation",
        `findings:${findingId || subject}:${String(finding.kind ?? "finding")}:${String(finding.severity ?? "warn")}:${subject}:${String(finding.source ?? "")}:${String(finding.evidence_path ?? "")}`,
      ),
      source_color: "",
      signal_type: String(finding.kind ?? "finding"),
      severity: String(finding.severity ?? "warn"),
      status: "open",
      next_action: `review finding ${finding.finding_id ?? subject}`,
      created_at: createdAt,
    };
    upsertRow(db, { table: "feedback_events", primaryKey: "feedback_event_id", row: { ...event } });
    events.push(event);
  }

  for (const candidate of detectorCandidates) {
    const candidateId = String(candidate.route_candidate_id ?? "");
    const subject = String(candidate.subject_id ?? candidateId);
    const findingKind = String(candidate.finding_kind ?? "detector-route-candidate");
    const event: FeedbackEvent = {
      feedback_event_id: feedbackId("feedback:detector-route-candidate", candidateId || subject),
      finding_id: "",
      plan_id: subject.startsWith("PLAN-") ? subject : "",
      source_table: "detector_route_candidates",
      source_id: candidateId || subject,
      source_generation: feedbackId(
        "feedback-generation",
        `detector_route_candidates:${candidateId || subject}:${String(candidate.candidate_status ?? "non_ready")}:${findingKind}:${signalSeverity(candidate.severity)}:${subject}:${String(candidate.filing_target_id ?? "")}:${String(candidate.target_layer ?? "")}:${String(candidate.target_sub_doc ?? "")}:${String(candidate.reason ?? "")}`,
      ),
      source_color: String(candidate.candidate_status ?? "non_ready"),
      signal_type: `detector_route_candidate:${findingKind}`,
      severity: signalSeverity(candidate.severity),
      status: "open",
      next_action: detectorRouteCandidateAction(candidate),
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
      source_table: "quality_signals",
      source_id: String(signal.signal_id ?? subject),
      source_generation: feedbackId(
        "feedback-generation",
        `quality_signals:${String(signal.signal_id ?? subject)}:${String(signal.source ?? "")}:${subject}:${String(signal.metric ?? "quality_signal")}:${String(signal.status ?? "warn")}:${String(signal.value ?? "")}:${String(signal.threshold ?? "")}`,
      ),
      source_color: "",
      signal_type: String(signal.metric ?? "quality_signal"),
      severity: signalSeverity(signal.status),
      status: "open",
      next_action: `review quality signal ${signal.signal_id ?? subject}`,
      created_at: createdAt,
    };
    upsertRow(db, { table: "feedback_events", primaryKey: "feedback_event_id", row: { ...event } });
    events.push(event);
  }
  for (const hook of db
    .prepare(
      "SELECT event_id, session_id, plan_id, occurred_at FROM hook_events WHERE event_type = 'memory_promotion_missed' ORDER BY event_id",
    )
    .all()) {
    const eventId = String(hook.event_id ?? "");
    const sessionId = String(hook.session_id ?? "");
    const event: FeedbackEvent = {
      feedback_event_id: feedbackId("feedback:memory-promotion", eventId || sessionId),
      finding_id: "",
      plan_id: String(hook.plan_id ?? ""),
      source_table: "hook_events",
      source_id: eventId || sessionId,
      source_generation: feedbackId(
        "feedback-generation",
        `hook_events:${eventId || sessionId}:memory_promotion_missed`,
      ),
      source_color: "",
      signal_type: "memory_promotion_missed",
      severity: "info",
      status: "open",
      next_action:
        "review session changes and promote durable knowledge to HARNESS memory when warranted",
      created_at: createdAt,
    };
    upsertRow(db, { table: "feedback_events", primaryKey: "feedback_event_id", row: { ...event } });
    events.push(event);
  }

  if (postMergeBackstop) {
    const reasons: PostMergeBackstopReason[] = ["bypass_merge", "merged_without_verdict"];
    for (const reason of reasons) {
      const findings = postMergeBackstop.detections.filter((finding) => finding.reason === reason);
      if (findings.length === 0) continue;
      const event: FeedbackEvent = {
        feedback_event_id: feedbackId("feedback:post-merge-backstop", reason),
        finding_id: "",
        plan_id: "",
        source_table: "post_merge_backstop",
        source_id: reason,
        source_generation: feedbackId(
          "feedback-generation",
          `${reason}:${findings.map((finding) => `${finding.pr}:${finding.headSha}`).join(",")}`,
        ),
        source_color: postMergeBackstop.ok ? "" : "detection_unavailable",
        signal_type: `post_merge_backstop:${reason}`,
        severity: "warn",
        status: "open",
        next_action: formatPostMergeBackstop(postMergeBackstop),
        created_at: createdAt,
      };
      upsertRow(db, {
        table: "feedback_events",
        primaryKey: "feedback_event_id",
        row: { ...event },
      });
      events.push(event);
    }
    if (!postMergeBackstop.ok) {
      const event: FeedbackEvent = {
        feedback_event_id: feedbackId("feedback:post-merge-backstop", "detection-unavailable"),
        finding_id: "",
        plan_id: "",
        source_table: "post_merge_backstop",
        source_id: "detection-unavailable",
        source_generation: feedbackId(
          "feedback-generation",
          `detection-unavailable:${postMergeBackstop.unavailableReason ?? "unknown"}:${postMergeBackstop.detections.map((finding) => `${finding.reason}:${finding.pr}`).join(",")}`,
        ),
        source_color: "detection_unavailable",
        signal_type: "post_merge_backstop:detection_unavailable",
        severity: "warn",
        status: "open",
        next_action: formatPostMergeBackstop(postMergeBackstop),
        created_at: createdAt,
      };
      upsertRow(db, {
        table: "feedback_events",
        primaryKey: "feedback_event_id",
        row: { ...event },
      });
      events.push(event);
    }
  }
  return events.sort((a, b) => a.feedback_event_id.localeCompare(b.feedback_event_id));
}
