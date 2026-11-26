import { dirname, resolve } from "node:path";
import {
  formatPostMergeBackstop,
  type PostMergeBackstopResult,
  scanPostMergeBackstop,
} from "../feedback/post-merge-backstop.ts";
import type { SurfacedFeedback, TakeoverFeedbackResult } from "../feedback/surface.ts";
import { selectTakeoverFeedback } from "../feedback/surface.ts";
import type { MemoryEntry } from "../memory/index.ts";
import type { ClaudeInboxBacklogSummary } from "../runtime/claude-memory-wake.ts";
import type { HarnessDb } from "../state-db/index.ts";

export const EXTERNAL_OBSERVATIONS_NOT_CHECKED = [
  "  inbox PR state: not checked (pending reviews retained)",
  "  post-merge backstop: not checked",
] as const;

export interface GateRunDigestRow {
  gate_id: string;
  status: string;
  checked_at: string;
}

export interface SessionStartDigest {
  gate_runs: GateRunDigestRow[];
  feedback: TakeoverFeedbackResult;
  head_commits: string[];
  memory: MemoryEntry[];
  escalation_lines: string[];
  external_observations_status?: "not_checked";
  post_merge_backstop?: PostMergeBackstopResult;
  unclaimed_inbox?: ClaudeInboxBacklogSummary;
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function timestampRank(value: unknown): number {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function selectLatestGateRuns(db: HarnessDb): GateRunDigestRow[] {
  const rows = db
    .prepare("SELECT gate_id, status, checked_at FROM gate_runs ORDER BY rowid ASC")
    .all() as Array<Record<string, unknown>>;
  const latest = new Map<string, GateRunDigestRow>();
  for (const row of rows) {
    const gate = {
      gate_id: text(row.gate_id),
      status: text(row.status),
      checked_at: text(row.checked_at),
    };
    if (!gate.gate_id) continue;
    const current = latest.get(gate.gate_id);
    if (!current || timestampRank(gate.checked_at) >= timestampRank(current.checked_at)) {
      latest.set(gate.gate_id, gate);
    }
  }
  return [...latest.values()].sort(
    (a, b) =>
      timestampRank(b.checked_at) - timestampRank(a.checked_at) ||
      a.gate_id.localeCompare(b.gate_id),
  );
}

/**
 * `memory` は呼び元 (MemoryService) が正本ファイルから読んで渡す (PLAN-L7-468)。
 * DB は body を持たない metadata index なので、digest は DB から本文を取らない。
 */
export function selectSessionStartDigest(
  db: HarnessDb,
  headCommits: string[],
  input: {
    escalationLines?: string[];
    externalObservationsStatus?: "not_checked";
    memory?: MemoryEntry[];
    postMergeBackstop?: PostMergeBackstopResult;
    unclaimedInbox?: ClaudeInboxBacklogSummary;
  } = {},
): SessionStartDigest {
  const escalationLines = input.escalationLines ?? [];
  const memory = input.memory ?? [];
  const postMergeBackstop =
    input.postMergeBackstop ??
    (db.path === ":memory:" || input.externalObservationsStatus === "not_checked"
      ? undefined
      : scanPostMergeBackstop({
          repoRoot: resolve(dirname(resolve(db.path)), ".."),
        }));
  db.exec("BEGIN");
  try {
    const gateRuns = selectLatestGateRuns(db);
    const digest = {
      gate_runs: gateRuns,
      feedback: selectTakeoverFeedback(db, { limit: 1000 }),
      head_commits: headCommits.slice(0, 5),
      memory,
      escalation_lines: escalationLines.filter(Boolean),
      external_observations_status: input.externalObservationsStatus,
      post_merge_backstop: postMergeBackstop,
      unclaimed_inbox: input.unclaimedInbox,
    };
    db.exec("COMMIT");
    return digest;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function feedbackLine(item: SurfacedFeedback): string {
  const plans = item.surface_plan_ids?.filter(Boolean) ?? (item.plan_id ? [item.plan_id] : []);
  const planText = plans.length > 0 ? ` [${plans.slice(0, 3).join(", ")}]` : "";
  return `  - (${item.severity}) ${item.signal_type}${planText}: count=${item.surface_count ?? 1}; ${item.next_action}`;
}

export function renderSessionStartDigest(digest: SessionStartDigest): string {
  const lines = ["session-start digest (source=harness.db + HEAD + HARNESS memory)"];
  lines.push("[1/4 runtime-signals]");
  if (digest.gate_runs.length === 0) lines.push("  gates: no projected gate runs");
  for (const gate of digest.gate_runs) {
    lines.push(`  gate: ${gate.gate_id}=${gate.status}`);
  }
  for (const line of digest.escalation_lines) lines.push(`  escalation: ${line}`);
  if (digest.external_observations_status === "not_checked") {
    lines.push(...EXTERNAL_OBSERVATIONS_NOT_CHECKED);
  }
  if (digest.post_merge_backstop) {
    lines.push(`  ${formatPostMergeBackstop(digest.post_merge_backstop)}`);
  }
  const gateFeedback = digest.feedback.items.filter((item) => item.bucket === "gate");
  for (const item of gateFeedback) lines.push(feedbackLine(item));

  if (digest.unclaimed_inbox) {
    const backlog = digest.unclaimed_inbox;
    if (backlog.pending <= 0) {
      lines.push("  inbox: no unclaimed Claude payload");
    } else {
      lines.push(
        `  inbox: pending=${backlog.pending} oldest=${backlog.oldestEntryId} at=${backlog.oldestCreatedAt} age_ms=${backlog.oldestAgeMs} target_mismatch=${backlog.targetMismatchPending ?? 0} sessions=${backlog.sessionStatus ?? "unknown"} hook=${backlog.hookConfigured === undefined ? "unknown" : backlog.hookConfigured ? "configured" : "missing"}`,
      );
    }
    if ((backlog.terminalized ?? 0) > 0) {
      lines.push(`  inbox: terminalized=${backlog.terminalized} (evidence retained)`);
    }
    for (const warning of backlog.warningCodes ?? []) {
      lines.push(`  inbox warning: ${warning}`);
    }
  }

  lines.push("[2/4 head]");
  if (digest.head_commits.length === 0) lines.push("  - unavailable");
  for (const commit of digest.head_commits) lines.push(`  - ${commit}`);

  lines.push("[3/4 actionable]");
  const actionable = digest.feedback.items
    .filter((item) => item.bucket === "actionable")
    .slice(0, 5);
  if (actionable.length === 0) lines.push("  - none");
  for (const item of actionable) lines.push(feedbackLine(item));
  const surfacedActionable = actionable.reduce((sum, item) => sum + (item.surface_count ?? 1), 0);
  const hidden = digest.feedback.byBucket.actionable - surfacedActionable;
  if (hidden > 0) lines.push(`  - (+${hidden} more actionable; use ut-tdd feedback list --json)`);
  if (digest.feedback.byBucket.telemetry > 0) {
    const summary = Object.entries(digest.feedback.telemetryBySignal)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([signal, count]) => `${signal}=${count}`)
      .join(" ");
    lines.push(`  telemetry summarized: ${summary}`);
  }

  lines.push("[4/4 memory]");
  if (digest.memory.length === 0) lines.push("  - none");
  for (const entry of digest.memory) {
    const body = entry.body.replace(/\s+/g, " ").slice(0, 160);
    lines.push(`  - ${entry.kind} ${entry.title}: ${body}`);
  }
  return `${lines.join("\n")}\n`;
}
