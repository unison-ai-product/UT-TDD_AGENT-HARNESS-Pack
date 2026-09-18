import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureDir } from "./fs.ts";

export type FeedbackLifecycleState = "open" | "ack" | "closed" | "superseded";

const TELEMETRY_SIGNAL_TYPES = new Set([
  "artifact_progress_yellow",
  "drive_firing_rate",
  "large-document-split",
  "memory_promotion_missed",
  "missing-test-oracle-id",
  "skill_acceptance_rate",
  "skill_firing_rate",
  "trouble_event_rate",
  "workflow_human_required_rate",
]);

export function isTelemetryFeedback(input: { severity: string; signal_type: string }): boolean {
  return input.severity.toLowerCase() === "info" || TELEMETRY_SIGNAL_TYPES.has(input.signal_type);
}

export interface FeedbackLifecycleRecord {
  feedback_event_id: string;
  source_generation: string;
  state: FeedbackLifecycleState;
  occurred_at: string;
  reason: string;
}

export function parseFeedbackLifecycle(raw: string): FeedbackLifecycleRecord[] {
  return raw.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const record = value as Record<string, unknown>;
      const validState = ["open", "ack", "closed", "superseded"].includes(
        String(record.state ?? ""),
      );
      const validTime =
        typeof record.occurred_at === "string" && Number.isFinite(Date.parse(record.occurred_at));
      return typeof record.feedback_event_id === "string" &&
        record.feedback_event_id.length > 0 &&
        typeof record.source_generation === "string" &&
        record.source_generation.length > 0 &&
        validState &&
        validTime &&
        typeof record.reason === "string"
        ? [record as unknown as FeedbackLifecycleRecord]
        : [];
    } catch {
      return [];
    }
  });
}

export function renderFeedbackLifecycle(record: FeedbackLifecycleRecord): string {
  return `${JSON.stringify(record)}\n`;
}

export function feedbackLifecyclePath(repoRoot: string): string {
  return join(repoRoot, ".ut-tdd", "logs", "feedback-lifecycle.jsonl");
}

export function loadFeedbackLifecycle(repoRoot: string): FeedbackLifecycleRecord[] {
  const path = feedbackLifecyclePath(repoRoot);
  try {
    return existsSync(path) ? parseFeedbackLifecycle(readFileSync(path, "utf8")) : [];
  } catch {
    return [];
  }
}

export function appendFeedbackLifecycleBatch(
  repoRoot: string,
  records: FeedbackLifecycleRecord[],
): boolean {
  if (records.length === 0) return true;
  try {
    const path = feedbackLifecyclePath(repoRoot);
    ensureDir(dirname(path), { recursive: true });
    appendFileSync(path, records.map(renderFeedbackLifecycle).join(""), "utf8");
    return true;
  } catch {
    // Lifecycle telemetry is fail-open.
    return false;
  }
}

export function appendFeedbackLifecycle(
  repoRoot: string,
  record: FeedbackLifecycleRecord,
): boolean {
  return appendFeedbackLifecycleBatch(repoRoot, [record]);
}

export function resolveFeedbackLifecycle(input: {
  previous?: FeedbackLifecycleRecord;
  source_present: boolean;
  is_telemetry: boolean;
  now: string;
  telemetry_ttl_ms: number;
}): FeedbackLifecycleRecord | undefined {
  const { previous, source_present, is_telemetry, now, telemetry_ttl_ms } = input;
  if (!source_present) {
    if (!previous || previous.state === "closed") return previous;
    return { ...previous, state: "closed", occurred_at: now, reason: "source_resolved" };
  }
  if (!previous) return undefined;
  if (!is_telemetry || previous.state !== "open") return previous;
  const elapsed = Date.parse(now) - Date.parse(previous.occurred_at);
  if (!Number.isFinite(elapsed) || elapsed < telemetry_ttl_ms) return previous;
  return { ...previous, state: "ack", occurred_at: now, reason: "telemetry_ttl" };
}
