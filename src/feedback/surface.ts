import { isTelemetryFeedback } from "../shared/feedback-lifecycle.ts";
import { stableId } from "../stable-id.ts";
import type { HarnessDb } from "../state-db/index.ts";

/**
 * Takeover feedback surface (PLAN-L7-110).
 *
 * Session takeover must receive actionable feedback from harness.db, not from a
 * stale prose handover or a transient shared working tree. This reader is
 * intentionally read-only so SessionStart can run while another runtime is
 * rebuilding the projection database.
 */

export interface SurfacedFeedback {
  feedback_event_id: string;
  signal_type: string;
  severity: string;
  plan_id: string;
  next_action: string;
  bucket: FeedbackSurfaceBucket;
  surface_count?: number;
  surface_plan_ids?: string[];
}

export interface TakeoverFeedbackResult {
  /** Total open feedback count before applying the display limit. */
  total: number;
  /** Count by normalized severity. */
  bySeverity: Record<string, number>;
  /** Count by display bucket. */
  byBucket: Record<FeedbackSurfaceBucket, number>;
  /** Count by signal type for telemetry items that are intentionally summarized. */
  telemetryBySignal: Record<string, number>;
  /** Stable bucket/severity/id ordered non-telemetry items after applying the display limit. */
  items: SurfacedFeedback[];
}

export type FeedbackSurfaceBucket = "gate" | "actionable" | "telemetry";

export interface FeedbackEventRowLike {
  feedback_event_id?: unknown;
  signal_type?: unknown;
  severity?: unknown;
  plan_id?: unknown;
  next_action?: unknown;
  finding_id?: unknown;
  source_table?: unknown;
  source_id?: unknown;
}

const BUCKET_RANK: Record<FeedbackSurfaceBucket, number> = { gate: 0, actionable: 1, telemetry: 2 };
const SEVERITY_RANK: Record<string, number> = { error: 0, fail: 0, warn: 1, info: 2 };

function severityRank(severity: string): number {
  return SEVERITY_RANK[severity] ?? SEVERITY_RANK.warn;
}

export function classifyFeedbackBucket(input: {
  severity: string;
  signal_type: string;
}): FeedbackSurfaceBucket {
  const severity = input.severity.toLowerCase();
  if (severity === "error" || severity === "fail") return "gate";
  if (isTelemetryFeedback(input)) return "telemetry";
  return "actionable";
}

function feedbackId(prefix: string, subject: string): string {
  return stableId(prefix, subject);
}

function planIdOf(subject: string): string {
  return subject.startsWith("PLAN-") ? subject : "";
}

function signalSeverity(status: unknown): string {
  const normalized = String(status ?? "warn").toLowerCase();
  if (normalized === "fail" || normalized === "error") return normalized;
  if (normalized === "warn") return "warn";
  return "info";
}

function findingFeedbackId(findingId: unknown, subject: string): string {
  return feedbackId("feedback:finding", String(findingId ?? subject));
}

function signalFeedbackId(signalId: unknown, subject: string): string {
  return feedbackId("feedback:signal", String(signalId ?? subject));
}

function sourceKey(sourceTable: unknown, sourceId: unknown): string {
  const table = String(sourceTable ?? "");
  const id = String(sourceId ?? "");
  return table && id ? `${table}:${id}` : "";
}

function renderGroupedItems(items: SurfacedFeedback[], indent = "    "): string[] {
  const groups = new Map<
    string,
    {
      bucket: FeedbackSurfaceBucket;
      severity: string;
      signalType: string;
      count: number;
      planIds: Set<string>;
      nextAction: string;
    }
  >();
  for (const item of items) {
    const key = `${item.bucket}:${item.severity}:${item.signal_type}`;
    const group = groups.get(key) ?? {
      bucket: item.bucket,
      severity: item.severity,
      signalType: item.signal_type,
      count: 0,
      planIds: new Set<string>(),
      nextAction: item.next_action,
    };
    group.count += item.surface_count ?? 1;
    for (const planId of item.surface_plan_ids ?? []) {
      if (planId) group.planIds.add(planId);
    }
    if (item.plan_id) group.planIds.add(item.plan_id);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort(
      (a, b) =>
        BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket] ||
        severityRank(a.severity) - severityRank(b.severity) ||
        b.count - a.count ||
        a.signalType.localeCompare(b.signalType),
    )
    .map((group) => {
      const plans = [...group.planIds].slice(0, 3);
      const planText =
        plans.length > 0
          ? ` [${plans.join(", ")}${group.planIds.size > plans.length ? ", ..." : ""}]`
          : "";
      return `${indent}- (${group.severity}) ${group.signalType}${planText}: count=${group.count}; ${group.nextAction}`;
    });
}

function feedbackGroupKey(item: SurfacedFeedback): string {
  return `${item.bucket}:${item.severity}:${item.signal_type}`;
}

function selectDisplayGroups(items: SurfacedFeedback[], limit: number): SurfacedFeedback[] {
  const groups = new Map<string, SurfacedFeedback[]>();
  for (const item of items) {
    if (item.bucket === "telemetry") continue;
    const key = feedbackGroupKey(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  const selectedGroups = [...groups.values()]
    .sort((a, b) => {
      const aHead = a[0];
      const bHead = b[0];
      if (!aHead || !bHead) return 0;
      return (
        BUCKET_RANK[aHead.bucket] - BUCKET_RANK[bHead.bucket] ||
        severityRank(aHead.severity) - severityRank(bHead.severity) ||
        b.length - a.length ||
        aHead.feedback_event_id.localeCompare(bHead.feedback_event_id)
      );
    })
    .slice(0, limit);

  return selectedGroups.map((group) => {
    const sorted = [...group].sort((a, b) =>
      a.feedback_event_id.localeCompare(b.feedback_event_id),
    );
    const representative = sorted[0];
    if (!representative) {
      throw new Error("empty feedback surface group");
    }
    return {
      ...representative,
      surface_count: group.length,
      surface_plan_ids: [...new Set(group.map((item) => item.plan_id).filter(Boolean))],
    };
  });
}

/**
 * Read takeover feedback directly from harness.db projection tables.
 *
 * This mirrors the feedback source used by emitFeedbackEvents without writing to
 * feedback_events. It keeps SessionStart fail-open and avoids write-lock
 * contention with parallel database rebuilds.
 */
export function selectTakeoverFeedback(
  db: HarnessDb,
  opts: { limit?: number } = {},
): TakeoverFeedbackResult {
  const limit = opts.limit ?? 10;
  const items: SurfacedFeedback[] = [];
  const representedFeedbackIds = new Set<string>();
  const representedSources = new Set<string>();

  const feedbackEventRows = db
    .prepare(
      `SELECT feedback_events.feedback_event_id, finding_id, plan_id, source_table, source_id,
              signal_type, severity, next_action, source_generation,
              (SELECT lifecycle.state
               FROM feedback_lifecycle lifecycle
               WHERE lifecycle.feedback_event_id = feedback_events.feedback_event_id
                 AND lifecycle.source_generation = feedback_events.source_generation
               ORDER BY lifecycle.occurred_at DESC, lifecycle.lifecycle_id DESC
               LIMIT 1) AS latest_lifecycle_state
       FROM feedback_events
       WHERE status = 'open'`,
    )
    .all() as Array<Record<string, unknown>>;
  for (const event of feedbackEventRows) {
    const signalType = String(event.signal_type ?? "feedback");
    const severity = String(event.severity ?? "warn").toLowerCase();
    const feedbackEventId = String(event.feedback_event_id ?? "");
    if (feedbackEventId) representedFeedbackIds.add(feedbackEventId);
    const key = sourceKey(event.source_table, event.source_id);
    if (key) representedSources.add(key);
    const findingId = String(event.finding_id ?? "");
    if (findingId) representedSources.add(sourceKey("findings", findingId));
    if (["ack", "closed", "superseded"].includes(String(event.latest_lifecycle_state ?? ""))) {
      continue;
    }
    items.push({
      feedback_event_id: feedbackEventId,
      signal_type: signalType,
      severity,
      plan_id: String(event.plan_id ?? ""),
      next_action: String(event.next_action ?? ""),
      bucket: classifyFeedbackBucket({ severity, signal_type: signalType }),
    });
  }

  const openFindings = db
    .prepare("SELECT finding_id, kind, severity, subject_id FROM findings WHERE status = 'open'")
    .all() as Array<Record<string, unknown>>;
  for (const finding of openFindings) {
    const subject = String(finding.subject_id ?? finding.finding_id ?? "");
    const feedbackEventId = findingFeedbackId(finding.finding_id, subject);
    const key = sourceKey("findings", finding.finding_id ?? subject);
    if (representedFeedbackIds.has(feedbackEventId) || representedSources.has(key)) continue;
    items.push({
      feedback_event_id: feedbackEventId,
      signal_type: String(finding.kind ?? "finding"),
      severity: String(finding.severity ?? "warn"),
      plan_id: planIdOf(subject),
      next_action: `review finding ${finding.finding_id ?? subject}`,
      bucket: classifyFeedbackBucket({
        severity: String(finding.severity ?? "warn"),
        signal_type: String(finding.kind ?? "finding"),
      }),
    });
  }

  const failedSignals = db
    .prepare(
      "SELECT signal_id, metric, status, subject_id FROM quality_signals WHERE status IN ('fail', 'warn')",
    )
    .all() as Array<Record<string, unknown>>;
  for (const signal of failedSignals) {
    const subject = String(signal.subject_id ?? signal.signal_id ?? "");
    const feedbackEventId = signalFeedbackId(signal.signal_id, subject);
    const key = sourceKey("quality_signals", signal.signal_id ?? subject);
    if (representedFeedbackIds.has(feedbackEventId) || representedSources.has(key)) continue;
    const severity = signalSeverity(signal.status);
    const signalType = String(signal.metric ?? "quality_signal");
    items.push({
      feedback_event_id: feedbackEventId,
      signal_type: signalType,
      severity,
      plan_id: planIdOf(subject),
      next_action: `review quality signal ${signal.signal_id ?? subject}`,
      bucket: classifyFeedbackBucket({ severity, signal_type: signalType }),
    });
  }

  items.sort(
    (a, b) =>
      BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket] ||
      severityRank(a.severity) - severityRank(b.severity) ||
      a.feedback_event_id.localeCompare(b.feedback_event_id),
  );

  const bySeverity: Record<string, number> = {};
  for (const item of items) {
    bySeverity[item.severity] = (bySeverity[item.severity] ?? 0) + 1;
  }

  const byBucket: Record<FeedbackSurfaceBucket, number> = {
    gate: 0,
    actionable: 0,
    telemetry: 0,
  };
  const telemetryBySignal: Record<string, number> = {};
  for (const item of items) {
    byBucket[item.bucket] += 1;
    if (item.bucket === "telemetry") {
      telemetryBySignal[item.signal_type] = (telemetryBySignal[item.signal_type] ?? 0) + 1;
    }
  }

  const surfaced = selectDisplayGroups(items, limit);
  return { total: items.length, bySeverity, byBucket, telemetryBySignal, items: surfaced };
}

export function renderTakeoverFeedback(result: TakeoverFeedbackResult): string {
  if (result.total === 0) return "";
  const counts = ["fail", "warn", "info"]
    .filter((sev) => (result.bySeverity[sev] ?? 0) > 0)
    .map((sev) => `${sev}=${result.bySeverity[sev]}`)
    .join(" ");
  const lines = [
    `harness.db feedback (open=${result.total}; gate=${result.byBucket.gate} actionable=${result.byBucket.actionable} telemetry=${result.byBucket.telemetry}; ${counts}) - source=DB, not prose handover`,
  ];
  const gateItems = result.items.filter((item) => item.bucket === "gate");
  const actionableItems = result.items.filter((item) => item.bucket === "actionable");
  if (gateItems.length > 0) lines.push("  gate:");
  lines.push(...renderGroupedItems(gateItems));
  if (actionableItems.length > 0) lines.push("  actionable:");
  lines.push(...renderGroupedItems(actionableItems));
  const surfacedActionable = result.items.reduce((sum, item) => sum + (item.surface_count ?? 1), 0);
  const hiddenActionable = result.byBucket.gate + result.byBucket.actionable - surfacedActionable;
  if (hiddenActionable > 0) {
    lines.push(`  - (+${hiddenActionable} more actionable - ut-tdd feedback list --json)`);
  }
  if (result.byBucket.telemetry > 0) {
    const topTelemetry = Object.entries(result.telemetryBySignal)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([signal, count]) => `${signal}=${count}`)
      .join(" ");
    lines.push(`  telemetry summarized: ${topTelemetry}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderFeedbackEventRows(rows: FeedbackEventRowLike[], limit = 20): string {
  const items = rows.map((row) => {
    const severity = String(row.severity ?? "warn");
    const signalType = String(row.signal_type ?? "feedback");
    return {
      feedback_event_id: String(row.feedback_event_id ?? ""),
      signal_type: signalType,
      severity,
      plan_id: String(row.plan_id ?? ""),
      next_action: String(row.next_action ?? ""),
      bucket: classifyFeedbackBucket({ severity, signal_type: signalType }),
    } satisfies SurfacedFeedback;
  });
  const byBucket: Record<FeedbackSurfaceBucket, number> = { gate: 0, actionable: 0, telemetry: 0 };
  const telemetryBySignal: Record<string, number> = {};
  for (const item of items) {
    byBucket[item.bucket] += 1;
    if (item.bucket === "telemetry") {
      telemetryBySignal[item.signal_type] = (telemetryBySignal[item.signal_type] ?? 0) + 1;
    }
  }
  const nonTelemetry = items
    .filter((item) => item.bucket !== "telemetry")
    .sort(
      (a, b) =>
        BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket] ||
        severityRank(a.severity) - severityRank(b.severity) ||
        a.feedback_event_id.localeCompare(b.feedback_event_id),
    );
  const lines = [
    `feedback events: total=${items.length} gate=${byBucket.gate} actionable=${byBucket.actionable} telemetry=${byBucket.telemetry}`,
  ];
  const grouped = renderGroupedItems(nonTelemetry, "  ");
  lines.push(...grouped.slice(0, limit));
  const hiddenGroups = grouped.length - limit;
  if (hiddenGroups > 0) {
    lines.push(`  - (+${hiddenGroups} more actionable signal groups; use --json for raw rows)`);
  }
  if (byBucket.telemetry > 0) {
    const topTelemetry = Object.entries(telemetryBySignal)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([signal, count]) => `${signal}=${count}`)
      .join(" ");
    lines.push(`  telemetry summarized: ${topTelemetry}`);
  }
  return `${lines.join("\n")}\n`;
}
