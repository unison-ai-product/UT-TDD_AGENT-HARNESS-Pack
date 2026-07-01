import type { HarnessDb } from "../state-db/index";

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
}

const BUCKET_RANK: Record<FeedbackSurfaceBucket, number> = { gate: 0, actionable: 1, telemetry: 2 };
const SEVERITY_RANK: Record<string, number> = { error: 0, fail: 0, warn: 1, info: 2 };

const TELEMETRY_SIGNAL_TYPES = new Set([
  "artifact_progress_yellow",
  "drive_firing_rate",
  "large-document-split",
  "missing-test-oracle-id",
  "skill_acceptance_rate",
  "skill_firing_rate",
  "trouble_event_rate",
  "workflow_human_required_rate",
]);

function severityRank(severity: string): number {
  return SEVERITY_RANK[severity] ?? SEVERITY_RANK.warn;
}

export function classifyFeedbackBucket(input: {
  severity: string;
  signal_type: string;
}): FeedbackSurfaceBucket {
  const severity = input.severity.toLowerCase();
  if (severity === "error" || severity === "fail") return "gate";
  if (severity === "info" || TELEMETRY_SIGNAL_TYPES.has(input.signal_type)) return "telemetry";
  return "actionable";
}

function feedbackId(prefix: string, subject: string): string {
  return `${prefix}:${subject}`.replace(/[^A-Za-z0-9._:-]+/g, "-");
}

function planIdOf(subject: string): string {
  return subject.startsWith("PLAN-") ? subject : "";
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
    group.count += 1;
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

  const openFindings = db
    .prepare("SELECT finding_id, kind, severity, subject_id FROM findings WHERE status = 'open'")
    .all() as Array<Record<string, unknown>>;
  for (const finding of openFindings) {
    const subject = String(finding.subject_id ?? finding.finding_id ?? "");
    items.push({
      feedback_event_id: feedbackId("feedback:finding", String(finding.finding_id ?? subject)),
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
    items.push({
      feedback_event_id: feedbackId("feedback:signal", String(signal.signal_id ?? subject)),
      signal_type: String(signal.metric ?? "quality_signal"),
      severity: String(signal.status ?? "warn") === "fail" ? "warn" : "info",
      plan_id: planIdOf(subject),
      next_action: `review quality signal ${signal.signal_id ?? subject}`,
      bucket: classifyFeedbackBucket({
        severity: String(signal.status ?? "warn") === "fail" ? "warn" : "info",
        signal_type: String(signal.metric ?? "quality_signal"),
      }),
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

  const surfaced = items.filter((item) => item.bucket !== "telemetry").slice(0, limit);
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
  const hiddenActionable = result.byBucket.gate + result.byBucket.actionable - result.items.length;
  if (hiddenActionable > 0) {
    lines.push(`  - (+${hiddenActionable} more actionable - ut-tdd feedback list --emit)`);
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
