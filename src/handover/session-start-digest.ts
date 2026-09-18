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

type Rag = "green" | "yellow" | "red";

interface ScheduleRow {
  plan_id: string;
  current_location: string;
  rag: string;
  status: string;
  blocked_reason: string;
  source_path: string;
  predecessor_plan_ids: string;
}

interface TestSignalRow {
  plan_id: string;
  exit_code: number;
  status: string;
  completed_at: string;
}

interface ReviewSignalRow {
  plan_id: string;
  verdict: string;
  status: string;
  reviewed_at: string;
}

export interface GateRunDigestRow {
  gate_id: string;
  plan_id: string;
  status: string;
  checked_at: string;
}

export interface ScheduleLiveEntry {
  plan_id: string;
  current_location: string;
  authoring_rag: Rag;
  effective_rag: Rag;
  status: string;
  blocked_reason: string;
  predecessor_plan_ids: string[];
  signal_state: "aligned" | "contradiction" | "unobserved";
  signal_reason: string;
}

export interface ScheduleLiveState {
  current: ScheduleLiveEntry[];
  next: ScheduleLiveEntry[];
  blocked: ScheduleLiveEntry[];
  entries: ScheduleLiveEntry[];
}

export interface SessionStartDigest {
  schedule: ScheduleLiveState;
  gate_runs: GateRunDigestRow[];
  feedback: TakeoverFeedbackResult;
  head_commits: string[];
  memory: MemoryEntry[];
  escalation_lines: string[];
  post_merge_backstop?: PostMergeBackstopResult;
  unclaimed_inbox?: ClaudeInboxBacklogSummary;
}

const AUTHORING_SCHEDULE = "docs/governance/vmodel-upgrade-schedule.md";
const RAG_RANK: Record<Rag, number> = { red: 0, yellow: 1, green: 2 };

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeRag(value: unknown): Rag {
  const normalized = text(value).toLowerCase();
  if (normalized === "green" || normalized === "red" || normalized === "yellow") {
    return normalized;
  }
  return "yellow";
}

function timestampRank(value: unknown): number {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function latestByPlan<T extends { plan_id: string }>(
  rows: T[],
  timestamp: (row: T) => string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const row of rows) {
    if (!row.plan_id) continue;
    const current = result.get(row.plan_id);
    if (!current || timestampRank(timestamp(row)) >= timestampRank(timestamp(current))) {
      result.set(row.plan_id, row);
    }
  }
  return result;
}

function waveRank(currentLocation: string): number {
  const match = currentLocation.match(/\bU(\d+)([a-z])?/i);
  if (!match) return -1;
  const suffix = match[2]?.toLowerCase().charCodeAt(0);
  return Number(match[1]) * 100 + (suffix ? suffix - 96 : 0);
}

function isFailure(value: string): boolean {
  return ["block", "blocked", "error", "fail", "failed", "rejected"].includes(value.toLowerCase());
}

function isReviewFailure(verdict: string, status: string): boolean {
  const result = (verdict || status).trim().toLowerCase();
  return /^(request[-_]?changes|changes[-_]?requested|reject(?:ed)?|fail(?:ed)?|blocked|revise|revision[-_]?required)$/.test(
    result,
  );
}

function liveEntry(
  row: ScheduleRow,
  signals: {
    test?: TestSignalRow;
    review?: ReviewSignalRow;
    gate?: GateRunDigestRow;
  },
): ScheduleLiveEntry {
  const { test, review, gate } = signals;
  const authoringRag = normalizeRag(row.rag);
  const failed: string[] = [];
  const observed: string[] = [];
  if (test) {
    observed.push(`test=${test.status || test.exit_code}`);
    if (Number(test.exit_code) !== 0 || isFailure(test.status)) failed.push("test");
  }
  if (review) {
    observed.push(`review=${review.verdict || review.status}`);
    if (isReviewFailure(review.verdict, review.status)) failed.push("review");
  }
  if (gate) {
    observed.push(`gate=${gate.gate_id}:${gate.status}`);
    if (isFailure(gate.status)) failed.push(`gate:${gate.gate_id}`);
  }
  const contradiction = authoringRag === "green" && failed.length > 0;
  return {
    plan_id: row.plan_id,
    current_location: row.current_location,
    authoring_rag: authoringRag,
    effective_rag: failed.length > 0 ? "red" : authoringRag,
    status: row.status,
    blocked_reason: row.blocked_reason,
    predecessor_plan_ids: row.predecessor_plan_ids
      .split(/[|,]/)
      .map((value) => value.trim())
      .filter(Boolean),
    signal_state: contradiction ? "contradiction" : observed.length > 0 ? "aligned" : "unobserved",
    signal_reason: contradiction
      ? `authoring green conflicts with ${failed.join(",")}`
      : observed.join("; "),
  };
}

function selectLatestGateRuns(db: HarnessDb): GateRunDigestRow[] {
  const rows = db
    .prepare("SELECT gate_id, plan_id, status, checked_at FROM gate_runs ORDER BY rowid ASC")
    .all() as Array<Record<string, unknown>>;
  const latest = new Map<string, GateRunDigestRow>();
  for (const row of rows) {
    const gate = {
      gate_id: text(row.gate_id),
      plan_id: text(row.plan_id),
      status: text(row.status),
      checked_at: text(row.checked_at),
    };
    const key = `${gate.gate_id}:${gate.plan_id}`;
    if (!gate.gate_id) continue;
    const current = latest.get(key);
    if (!current || timestampRank(gate.checked_at) >= timestampRank(current.checked_at)) {
      latest.set(key, gate);
    }
  }
  return [...latest.values()].sort(
    (a, b) =>
      timestampRank(b.checked_at) - timestampRank(a.checked_at) ||
      a.gate_id.localeCompare(b.gate_id) ||
      a.plan_id.localeCompare(b.plan_id),
  );
}

export function selectScheduleLiveState(
  db: HarnessDb,
  latestGateRuns: GateRunDigestRow[] = selectLatestGateRuns(db),
): ScheduleLiveState {
  const scheduleRows = db
    .prepare(
      "SELECT plan_id, current_location, rag, status, blocked_reason, source_path, predecessor_plan_ids FROM schedule_entries",
    )
    .all()
    .map((row) => ({
      plan_id: text(row.plan_id),
      current_location: text(row.current_location),
      rag: text(row.rag),
      status: text(row.status),
      blocked_reason: text(row.blocked_reason),
      source_path: text(row.source_path).replaceAll("\\", "/"),
      predecessor_plan_ids: text(row.predecessor_plan_ids),
    }));
  const authored = scheduleRows.filter((row) => row.source_path === AUTHORING_SCHEDULE);
  const selectedRows = authored.length > 0 ? authored : scheduleRows;

  const tests = latestByPlan(
    (
      db
        .prepare(
          "SELECT plan_id, exit_code, status, completed_at FROM test_runs ORDER BY rowid ASC",
        )
        .all() as Array<Record<string, unknown>>
    ).map((row) => ({
      plan_id: text(row.plan_id),
      exit_code: Number(row.exit_code ?? 1),
      status: text(row.status),
      completed_at: text(row.completed_at),
    })),
    (row) => row.completed_at,
  );
  const reviews = latestByPlan(
    (
      db
        .prepare(
          "SELECT plan_id, verdict, status, reviewed_at FROM review_evidence_registry WHERE has_evidence = 1 ORDER BY rowid ASC",
        )
        .all() as Array<Record<string, unknown>>
    ).map((row) => ({
      plan_id: text(row.plan_id),
      verdict: text(row.verdict),
      status: text(row.status),
      reviewed_at: text(row.reviewed_at),
    })),
    (row) => row.reviewed_at,
  );
  const gates = new Map<string, GateRunDigestRow>();
  for (const gate of latestGateRuns) {
    const current = gates.get(gate.plan_id);
    if (!current || (isFailure(gate.status) && !isFailure(current.status))) {
      gates.set(gate.plan_id, gate);
    }
  }
  const entries = selectedRows.map((row) =>
    liveEntry(row, {
      test: tests.get(row.plan_id),
      review: reviews.get(row.plan_id),
      gate: gates.get(row.plan_id),
    }),
  );
  const unresolved = entries
    .filter(
      (entry) =>
        entry.effective_rag !== "green" ||
        entry.status === "draft" ||
        Boolean(entry.blocked_reason),
    )
    .sort(
      (a, b) =>
        RAG_RANK[a.effective_rag] - RAG_RANK[b.effective_rag] ||
        waveRank(a.current_location) - waveRank(b.current_location) ||
        a.plan_id.localeCompare(b.plan_id),
    );
  const unresolvedIds = new Set(unresolved.map((entry) => entry.plan_id));
  const unblocked = unresolved.filter((entry) => !entry.blocked_reason);
  const current = unblocked.filter((entry) =>
    entry.predecessor_plan_ids.every((planId) => !unresolvedIds.has(planId)),
  );
  const currentIds = new Set(current.map((entry) => entry.plan_id));
  return {
    current,
    next: unblocked.filter((entry) => !currentIds.has(entry.plan_id)),
    blocked: unresolved.filter((entry) => Boolean(entry.blocked_reason)),
    entries,
  };
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
    memory?: MemoryEntry[];
    postMergeBackstop?: PostMergeBackstopResult;
    unclaimedInbox?: ClaudeInboxBacklogSummary;
  } = {},
): SessionStartDigest {
  const escalationLines = input.escalationLines ?? [];
  const memory = input.memory ?? [];
  const postMergeBackstop =
    input.postMergeBackstop ??
    (db.path === ":memory:"
      ? undefined
      : scanPostMergeBackstop({
          repoRoot: resolve(dirname(resolve(db.path)), ".."),
        }));
  db.exec("BEGIN");
  try {
    const gateRuns = selectLatestGateRuns(db);
    const digest = {
      schedule: selectScheduleLiveState(db, gateRuns),
      gate_runs: gateRuns,
      feedback: selectTakeoverFeedback(db, { limit: 1000 }),
      head_commits: headCommits.slice(0, 5),
      memory,
      escalation_lines: escalationLines.filter(Boolean),
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

function scheduleLine(entry: ScheduleLiveEntry): string {
  const signal = entry.signal_reason ? `; ${entry.signal_reason}` : "";
  return `${entry.effective_rag} ${entry.plan_id} ${entry.current_location}${signal}`;
}

export function renderSessionStartDigest(digest: SessionStartDigest): string {
  const lines = ["session-start digest (source=harness.db + HEAD + HARNESS memory)"];
  lines.push("[1/4 state-and-gates]");
  if (digest.schedule.current.length === 0) lines.push("  current: no ready schedule row");
  for (const entry of digest.schedule.current) lines.push(`  current: ${scheduleLine(entry)}`);
  for (const entry of digest.schedule.next) lines.push(`  next: ${scheduleLine(entry)}`);
  for (const entry of digest.schedule.blocked) {
    lines.push(`  blocked: ${entry.plan_id}: ${entry.blocked_reason}`);
  }
  if (digest.gate_runs.length === 0) lines.push("  gates: no projected gate runs");
  for (const gate of digest.gate_runs) {
    const plan = gate.plan_id ? ` plan=${gate.plan_id}` : "";
    lines.push(`  gate: ${gate.gate_id}=${gate.status}${plan}`);
  }
  for (const line of digest.escalation_lines) lines.push(`  escalation: ${line}`);
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
