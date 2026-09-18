import {
  appendFeedbackLifecycleBatch,
  type FeedbackLifecycleRecord,
  isTelemetryFeedback,
  loadFeedbackLifecycle,
  resolveFeedbackLifecycle,
} from "../shared/feedback-lifecycle.ts";
import type { HarnessDb } from "./index.ts";
import {
  analyzeRefactorCandidates,
  candidateRank,
  isRefactorCandidateDecisionState,
  loadRefactorCandidateInputs,
  REFACTOR_FEEDBACK_LIMIT,
  type RefactorCandidate,
  type RefactorCandidateLifecycleState,
  refactorCandidateKey,
} from "./refactor-candidates.ts";
import { detectorRouteCandidateAction } from "./route-candidate-review.ts";

interface FeedbackProjectionDeps {
  nowIso: () => string;
  stableId: (prefix: string, value: string) => string;
  telemetryTtlMs?: number;
  recordProjectionEvent: (
    db: HarnessDb,
    event: { table: string; id: string; row: Record<string, unknown> },
  ) => void;
}

export function projectFeedbackLifecycle(
  repoRoot: string,
  db: HarnessDb,
  deps: FeedbackProjectionDeps,
): void {
  for (const record of loadFeedbackLifecycle(repoRoot)) {
    const id = deps.stableId(
      "feedback-lifecycle",
      `${record.feedback_event_id}:${record.source_generation}:${record.occurred_at}:${record.state}`,
    );
    deps.recordProjectionEvent(db, {
      table: "feedback_lifecycle",
      id,
      row: { lifecycle_id: id, ...record },
    });
  }
}

export const FEEDBACK_TELEMETRY_TTL_MS = 24 * 60 * 60 * 1000;

function lifecycleKey(
  record: Pick<FeedbackLifecycleRecord, "feedback_event_id" | "source_generation">,
): string {
  return `${record.feedback_event_id}\u0000${record.source_generation}`;
}

function recordLifecycleTransitions(
  input: { repoRoot: string; db: HarnessDb; records: FeedbackLifecycleRecord[] },
  deps: FeedbackProjectionDeps,
): void {
  if (!appendFeedbackLifecycleBatch(input.repoRoot, input.records)) return;
  for (const record of input.records) {
    const id = deps.stableId(
      "feedback-lifecycle",
      `${record.feedback_event_id}:${record.source_generation}:${record.occurred_at}:${record.state}`,
    );
    deps.recordProjectionEvent(input.db, {
      table: "feedback_lifecycle",
      id,
      row: { lifecycle_id: id, ...record },
    });
  }
}

/**
 * Reconcile rebuildable source observations with the durable append-only lifecycle log.
 * The source generation is explicit: the same generation never reopens after ack/close,
 * while a changed source generation receives a new open transition.
 */
export function reconcileFeedbackLifecycle(
  repoRoot: string,
  db: HarnessDb,
  deps: FeedbackProjectionDeps,
): void {
  const now = deps.nowIso();
  const telemetryTtlMs = deps.telemetryTtlMs ?? FEEDBACK_TELEMETRY_TTL_MS;
  const records = loadFeedbackLifecycle(repoRoot);
  const transitions: FeedbackLifecycleRecord[] = [];
  const latest = new Map<string, FeedbackLifecycleRecord>();
  for (const record of records) latest.set(lifecycleKey(record), record);

  const currentRows = db
    .prepare(
      `SELECT feedback_event_id, source_generation, signal_type, severity
       FROM feedback_events
       WHERE status = 'open'
       ORDER BY feedback_event_id`,
    )
    .all();
  const currentByEvent = new Map<string, string>();
  for (const row of currentRows) {
    const feedbackEventId = String(row.feedback_event_id ?? "");
    let sourceGeneration = String(row.source_generation ?? "");
    if (!feedbackEventId || !sourceGeneration) continue;
    let key = lifecycleKey({
      feedback_event_id: feedbackEventId,
      source_generation: sourceGeneration,
    });
    let previous = latest.get(key);
    while (previous?.state === "closed" || previous?.state === "superseded") {
      sourceGeneration = deps.stableId(
        "feedback-generation-recurrence",
        `${sourceGeneration}:${previous.state}:${previous.occurred_at}`,
      );
      key = lifecycleKey({
        feedback_event_id: feedbackEventId,
        source_generation: sourceGeneration,
      });
      previous = latest.get(key);
    }
    if (sourceGeneration !== String(row.source_generation ?? "")) {
      db.prepare(
        "UPDATE feedback_events SET source_generation = ? WHERE feedback_event_id = ?",
      ).run(sourceGeneration, feedbackEventId);
    }
    currentByEvent.set(feedbackEventId, sourceGeneration);
    if (!previous) {
      const opened: FeedbackLifecycleRecord = {
        feedback_event_id: feedbackEventId,
        source_generation: sourceGeneration,
        state: "open",
        occurred_at: now,
        reason: "source_observed",
      };
      transitions.push(opened);
      latest.set(key, opened);
      continue;
    }
    const isTelemetry = isTelemetryFeedback({
      severity: String(row.severity ?? "warn"),
      signal_type: String(row.signal_type ?? "feedback"),
    });
    const next = resolveFeedbackLifecycle({
      previous,
      source_present: true,
      is_telemetry: isTelemetry,
      now,
      telemetry_ttl_ms: telemetryTtlMs,
    });
    if (next && (next.state !== previous.state || next.occurred_at !== previous.occurred_at)) {
      transitions.push(next);
      latest.set(key, next);
    }
  }

  for (const [key, previous] of latest) {
    if (previous.state === "closed" || previous.state === "superseded") continue;
    const currentGeneration = currentByEvent.get(previous.feedback_event_id);
    if (currentGeneration === previous.source_generation) continue;
    const next: FeedbackLifecycleRecord = {
      ...previous,
      state: currentGeneration ? "superseded" : "closed",
      occurred_at: now,
      reason: currentGeneration ? "source_generation_changed" : "source_resolved",
    };
    transitions.push(next);
    latest.set(key, next);
  }
  recordLifecycleTransitions({ repoRoot, db, records: transitions }, deps);
}

const refactorCandidateCache = new Map<string, RefactorCandidate[]>();

interface RefactorCandidateLifecycleRecord {
  state: RefactorCandidateLifecycleState;
  linked_plan_id: string;
  first_seen_at: string;
  decided_at: string;
}

const RIGHT_LUNG_TEST_DESIGN_PATHS = new Set([
  "docs/test-design/harness/L8-integration-test-design.md",
  "docs/test-design/harness/L9-system-test-design.md",
  "docs/test-design/harness/L10-ux-validation-test-design.md",
  "docs/test-design/harness/L12-acceptance-test-design.md",
  "docs/test-design/harness/L14-operational-test-design.md",
]);

const REFACTOR_DEFECT_ROUTING_TERMS = [
  "refactor",
  "structural",
  "structure",
  "integration-structure",
  "code-smell",
  "smell",
  "maintainability",
  "modularity",
] as const;

function signalSeverity(status: unknown): string {
  const normalized = String(status ?? "warn").toLowerCase();
  if (normalized === "fail" || normalized === "error") return normalized;
  if (normalized === "warn") return "warn";
  return "info";
}

function canReadLifecycle(db: HarnessDb): boolean {
  return typeof (db as { prepare?: unknown }).prepare === "function";
}

function isRightLungTestDesignEvidence(path: string): boolean {
  return RIGHT_LUNG_TEST_DESIGN_PATHS.has(path.replace(/\\/g, "/"));
}

function hasRefactorDefectRoutingTerm(value: string): boolean {
  const normalized = value.toLowerCase();
  return REFACTOR_DEFECT_ROUTING_TERMS.some((term) => normalized.includes(term));
}

function verificationFindingScore(severity: string): number {
  if (severity === "fail" || severity === "error") return 3;
  if (severity === "warn") return 2;
  return 1;
}

function verificationFindingConfidence(severity: string): "high" | "medium" {
  return severity === "fail" || severity === "error" || severity === "warn" ? "high" : "medium";
}

function loadRefactorCandidateLifecycle(
  db: HarnessDb,
): Map<string, RefactorCandidateLifecycleRecord> {
  if (!canReadLifecycle(db)) return new Map();
  const rows = db
    .prepare(
      `SELECT candidate_key, state, linked_plan_id, first_seen_at, decided_at
       FROM refactor_candidates`,
    )
    .all();
  return new Map(
    rows.map((row) => [
      String(row.candidate_key ?? ""),
      {
        state: String(row.state ?? "open") as RefactorCandidateLifecycleState,
        linked_plan_id: String(row.linked_plan_id ?? ""),
        first_seen_at: String(row.first_seen_at ?? ""),
        decided_at: String(row.decided_at ?? ""),
      },
    ]),
  );
}

export function decideRefactorCandidate(
  db: HarnessDb,
  input: {
    candidate_key: string;
    state: Exclude<RefactorCandidateLifecycleState, "open">;
    decided_at: string;
    linked_plan_id?: string;
  },
): { ok: boolean; findings: string[] } {
  const findings: string[] = [];
  if (!input.candidate_key) findings.push("candidate_key is required");
  if (input.state !== "rejected" && !input.linked_plan_id) {
    findings.push("linked_plan_id is required for accepted or implemented candidates");
  }
  if (!input.decided_at) findings.push("decided_at is required");
  if (findings.length > 0) return { ok: false, findings };
  db.prepare(
    `UPDATE refactor_candidates
     SET state = ?, linked_plan_id = ?, decided_at = ?
     WHERE candidate_key = ?`,
  ).run(input.state, input.linked_plan_id ?? "", input.decided_at, input.candidate_key);
  const updated = db
    .prepare("SELECT candidate_key FROM refactor_candidates WHERE candidate_key = ? AND state = ?")
    .get(input.candidate_key, input.state);
  if (!updated) return { ok: false, findings: ["candidate not found"] };
  return { ok: true, findings: [] };
}

export function projectRefactorCandidateSignals(
  repoRoot: string,
  db: HarnessDb,
  deps: FeedbackProjectionDeps,
): void {
  const computedAt = deps.nowIso();
  const cached = refactorCandidateCache.get(repoRoot);
  const candidates = cached ?? analyzeRefactorCandidates(loadRefactorCandidateInputs(repoRoot));
  refactorCandidateCache.set(repoRoot, candidates);
  const lifecycle = loadRefactorCandidateLifecycle(db);
  const feedbackSubjects = new Set(
    candidates
      .filter((candidate) => candidate.confidence === "high")
      .sort((a, b) => candidateRank(b) - candidateRank(a))
      .slice(0, REFACTOR_FEEDBACK_LIMIT)
      .map((candidate) => `${candidate.kind}:${candidate.subject}`),
  );
  for (const candidate of candidates) {
    const candidateKey = refactorCandidateKey(candidate);
    const existing = lifecycle.get(candidateKey);
    const state =
      existing && isRefactorCandidateDecisionState(existing.state) ? existing.state : "open";
    const linkedPlanId = existing?.linked_plan_id ?? "";
    deps.recordProjectionEvent(db, {
      table: "refactor_candidates",
      id: candidateKey,
      row: {
        candidate_key: candidateKey,
        kind: candidate.kind,
        path: candidate.path,
        subject: candidate.subject,
        confidence: candidate.confidence,
        score: candidate.score,
        threshold: candidate.threshold,
        state,
        linked_plan_id: linkedPlanId,
        reason: candidate.reason,
        first_seen_at: existing?.first_seen_at || computedAt,
        last_seen_at: computedAt,
        decided_at: existing?.decided_at ?? "",
      },
    });
    const signalId = deps.stableId(
      "refactor-candidate",
      `${candidate.kind}:${candidate.subject}:${candidate.reason}`,
    );
    const shouldFeedback =
      state === "open" && feedbackSubjects.has(`${candidate.kind}:${candidate.subject}`);
    deps.recordProjectionEvent(db, {
      table: "quality_signals",
      id: signalId,
      row: {
        signal_id: signalId,
        source: "refactor-candidate-detector",
        subject_id: candidate.subject,
        metric: `refactor_candidate:${candidate.kind}`,
        value: candidate.score,
        threshold: candidate.threshold,
        status: shouldFeedback ? "warn" : "pass",
        computed_at: computedAt,
      },
    });
  }
}

export function projectVerificationDefectRoutingRefactorCandidates(
  db: HarnessDb,
  deps: FeedbackProjectionDeps,
): void {
  const computedAt = deps.nowIso();
  const lifecycle = loadRefactorCandidateLifecycle(db);
  const rows = db
    .prepare(
      `SELECT finding_id, kind, severity, subject_id, source, status, evidence_path
       FROM findings
       WHERE status = 'open'
       ORDER BY finding_id`,
    )
    .all();

  for (const row of rows) {
    const findingId = String(row.finding_id ?? "");
    const findingKind = String(row.kind ?? "");
    const severity = signalSeverity(row.severity);
    const subject = String(row.subject_id ?? findingId);
    const source = String(row.source ?? "");
    const evidencePath = String(row.evidence_path ?? "");
    const routingText = `${findingKind} ${subject} ${evidencePath}`;
    const fromVerification =
      source === "verification-evidence" || isRightLungTestDesignEvidence(evidencePath);
    if (!fromVerification || !hasRefactorDefectRoutingTerm(routingText)) continue;

    const candidate: RefactorCandidate = {
      kind: "verification-defect-routing",
      path: evidencePath || source || "verification-evidence",
      subject,
      score: verificationFindingScore(severity),
      threshold: 1,
      confidence: verificationFindingConfidence(severity),
      reason: `verification defect_routing selected Refactor for ${findingKind || findingId}`,
    };
    const candidateKey = refactorCandidateKey(candidate);
    const existing = lifecycle.get(candidateKey);
    const state =
      existing && isRefactorCandidateDecisionState(existing.state) ? existing.state : "open";
    const linkedPlanId = existing?.linked_plan_id ?? "";
    deps.recordProjectionEvent(db, {
      table: "refactor_candidates",
      id: candidateKey,
      row: {
        candidate_key: candidateKey,
        kind: candidate.kind,
        path: candidate.path,
        subject: candidate.subject,
        confidence: candidate.confidence,
        score: candidate.score,
        threshold: candidate.threshold,
        state,
        linked_plan_id: linkedPlanId,
        reason: candidate.reason,
        first_seen_at: existing?.first_seen_at || computedAt,
        last_seen_at: computedAt,
        decided_at: existing?.decided_at ?? "",
      },
    });
    const signalId = deps.stableId("verification-defect-routing", findingId || subject);
    deps.recordProjectionEvent(db, {
      table: "quality_signals",
      id: signalId,
      row: {
        signal_id: signalId,
        source: "verification-defect-routing",
        subject_id: subject,
        metric: "refactor_candidate:verification-defect-routing",
        value: candidate.score,
        threshold: candidate.threshold,
        status: state === "open" ? "warn" : "pass",
        computed_at: computedAt,
      },
    });
  }
}

export function projectFeedbackEvents(db: HarnessDb, deps: FeedbackProjectionDeps): void {
  const createdAt = deps.nowIso();
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
  for (const finding of db.prepare("SELECT * FROM findings WHERE status = 'open'").all()) {
    const findingId = String(finding.finding_id ?? "");
    if (detectorCandidateFindingIds.has(findingId)) continue;
    const subject = String(finding.subject_id ?? findingId);
    const id = deps.stableId("feedback:finding", findingId || subject);
    deps.recordProjectionEvent(db, {
      table: "feedback_events",
      id,
      row: {
        feedback_event_id: id,
        finding_id: findingId,
        plan_id: subject.startsWith("PLAN-") ? subject : "",
        source_table: "findings",
        source_id: findingId || subject,
        source_generation: deps.stableId(
          "feedback-generation",
          `findings:${findingId || subject}:${String(finding.kind ?? "finding")}:${String(finding.severity ?? "warn")}:${subject}:${String(finding.source ?? "")}:${String(finding.evidence_path ?? "")}`,
        ),
        source_color: "",
        signal_type: String(finding.kind ?? "finding"),
        severity: String(finding.severity ?? "warn"),
        status: "open",
        next_action: `review finding ${findingId || subject}`,
        created_at: createdAt,
      },
    });
  }
  for (const candidate of detectorCandidates) {
    const candidateId = String(candidate.route_candidate_id ?? "");
    const subject = String(candidate.subject_id ?? candidateId);
    const findingKind = String(candidate.finding_kind ?? "detector-route-candidate");
    const severity = signalSeverity(candidate.severity);
    const id = deps.stableId("feedback:detector-route-candidate", candidateId || subject);
    deps.recordProjectionEvent(db, {
      table: "feedback_events",
      id,
      row: {
        feedback_event_id: id,
        finding_id: "",
        plan_id: subject.startsWith("PLAN-") ? subject : "",
        source_table: "detector_route_candidates",
        source_id: candidateId || subject,
        source_generation: deps.stableId(
          "feedback-generation",
          `detector_route_candidates:${candidateId || subject}:${String(candidate.candidate_status ?? "non_ready")}:${findingKind}:${severity}:${subject}:${String(candidate.filing_target_id ?? "")}:${String(candidate.target_layer ?? "")}:${String(candidate.target_sub_doc ?? "")}:${String(candidate.reason ?? "")}`,
        ),
        source_color: String(candidate.candidate_status ?? "non_ready"),
        signal_type: `detector_route_candidate:${findingKind}`,
        severity,
        status: "open",
        next_action: detectorRouteCandidateAction(candidate),
        created_at: createdAt,
      },
    });
  }
  for (const signal of db
    .prepare("SELECT * FROM quality_signals WHERE status IN ('fail', 'warn')")
    .all()) {
    const signalId = String(signal.signal_id ?? "");
    const subject = String(signal.subject_id ?? signalId);
    const id = deps.stableId("feedback:signal", signalId || subject);
    deps.recordProjectionEvent(db, {
      table: "feedback_events",
      id,
      row: {
        feedback_event_id: id,
        finding_id: "",
        plan_id: subject.startsWith("PLAN-") ? subject : "",
        source_table: "quality_signals",
        source_id: signalId || subject,
        source_generation: deps.stableId(
          "feedback-generation",
          `quality_signals:${signalId || subject}:${String(signal.source ?? "")}:${subject}:${String(signal.metric ?? "quality_signal")}:${String(signal.status ?? "warn")}:${String(signal.value ?? "")}:${String(signal.threshold ?? "")}`,
        ),
        source_color: "",
        signal_type: String(signal.metric ?? "quality_signal"),
        severity: signalSeverity(signal.status),
        status: "open",
        next_action: `review quality signal ${signalId || subject}`,
        created_at: createdAt,
      },
    });
  }
  for (const event of db
    .prepare(
      "SELECT event_id, session_id, plan_id, occurred_at FROM hook_events WHERE event_type = 'memory_promotion_missed' ORDER BY event_id",
    )
    .all()) {
    const eventId = String(event.event_id ?? "");
    const sessionId = String(event.session_id ?? "");
    const id = deps.stableId("feedback:memory-promotion", eventId || sessionId);
    deps.recordProjectionEvent(db, {
      table: "feedback_events",
      id,
      row: {
        feedback_event_id: id,
        finding_id: "",
        plan_id: String(event.plan_id ?? ""),
        source_table: "hook_events",
        source_id: eventId || sessionId,
        source_generation: deps.stableId(
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
      },
    });
  }
  for (const progress of db
    .prepare(
      `SELECT artifact_path, color, state, reason, recovery_plan_ids
       FROM artifact_progress
       WHERE color IN ('red', 'yellow')
       ORDER BY CASE color WHEN 'red' THEN 0 ELSE 1 END, artifact_path`,
    )
    .all()) {
    const artifactPath = String(progress.artifact_path ?? "");
    const color = String(progress.color ?? "");
    const state = String(progress.state ?? "");
    const reason = String(progress.reason ?? "");
    const recoveryPlanIds = String(progress.recovery_plan_ids ?? "");
    const id = deps.stableId("feedback:artifact-progress", `${artifactPath}:${color}:${state}`);
    const action =
      color === "red"
        ? `trigger dependency/reverse recovery for ${artifactPath}: ${reason}`
        : recoveryPlanIds
          ? `continue recovery workflow for ${artifactPath}: ${recoveryPlanIds}`
          : `run linked tests or add test evidence for ${artifactPath}: ${reason}`;
    deps.recordProjectionEvent(db, {
      table: "feedback_events",
      id,
      row: {
        feedback_event_id: id,
        finding_id: "",
        plan_id: "",
        source_table: "artifact_progress",
        source_id: artifactPath,
        source_generation: deps.stableId(
          "feedback-generation",
          `artifact_progress:${artifactPath}:${color}:${state}:${reason}:${recoveryPlanIds}`,
        ),
        source_color: color,
        signal_type: `artifact_progress_${color}`,
        severity: color === "red" ? "warn" : "info",
        status: "open",
        next_action: action,
        created_at: createdAt,
      },
    });
  }
}

export function projectTroubleEvents(db: HarnessDb, deps: FeedbackProjectionDeps): void {
  const createdAt = deps.nowIso();
  const hookRows = db
    .prepare(
      `SELECT event_id, plan_id, event_type, digest
       FROM hook_events
       WHERE event_type IN ('forced_stop', 'error', 'failed')
          OR digest LIKE '%fail%'
          OR digest LIKE '%error%'
       ORDER BY occurred_at, event_id`,
    )
    .all();
  for (const row of hookRows) {
    const sourceEventId = String(row.event_id ?? "");
    const category = String(row.event_type ?? "").includes("forced")
      ? "forced_stop"
      : "hook_failure";
    const id = deps.stableId("trouble", sourceEventId);
    deps.recordProjectionEvent(db, {
      table: "trouble_events",
      id,
      row: {
        trouble_event_id: id,
        source_event_id: sourceEventId,
        plan_id: String(row.plan_id ?? ""),
        category,
        severity: "warn",
        summary: String(row.digest ?? category).slice(0, 240),
        status: "open",
        created_at: createdAt,
      },
    });
  }

  for (const signal of db
    .prepare("SELECT * FROM quality_signals WHERE metric = ? AND status IN ('warn', 'fail')")
    .all("trouble_event_rate")) {
    const signalId = String(signal.signal_id ?? "");
    const id = deps.stableId("trouble", signalId);
    deps.recordProjectionEvent(db, {
      table: "trouble_events",
      id,
      row: {
        trouble_event_id: id,
        source_event_id: signalId,
        plan_id: "",
        category: "trouble_rate",
        severity: String(signal.status ?? "warn") === "fail" ? "error" : "warn",
        summary: `trouble_event_rate=${signal.value ?? ""}`,
        status: "open",
        created_at: createdAt,
      },
    });
  }
}

export function projectRetryEvents(db: HarnessDb, deps: FeedbackProjectionDeps): void {
  const createdAt = deps.nowIso();
  const rows = db
    .prepare(
      `SELECT plan_id, workflow, phase, COUNT(*) AS attempt_count
       FROM workflow_runs
       GROUP BY plan_id, workflow, phase
       HAVING COUNT(*) > 1
       ORDER BY plan_id, workflow, phase`,
    )
    .all();
  for (const row of rows) {
    const planId = String(row.plan_id ?? "");
    const workflow = String(row.workflow ?? "");
    const phase = String(row.phase ?? "");
    const id = deps.stableId("retry", `${planId}:${workflow}:${phase}`);
    deps.recordProjectionEvent(db, {
      table: "retry_events",
      id,
      row: {
        retry_event_id: id,
        plan_id: planId,
        workflow,
        phase,
        attempt_count: Number(row.attempt_count ?? 0),
        status: "open",
        created_at: createdAt,
      },
    });
  }
}

export function projectIssueQueue(db: HarnessDb, deps: FeedbackProjectionDeps): void {
  const createdAt = deps.nowIso();
  const issueSignals = new Set([
    "detector_route_candidate",
    "trouble_event_rate",
    "workflow_human_required_rate",
    "workflow_retry_groups",
    "workflow_blocked_rate",
  ]);
  const rows = db
    .prepare(
      `SELECT feedback_event_id, plan_id, signal_type, severity, next_action
       FROM feedback_events
       WHERE signal_type IN ('trouble_event_rate', 'workflow_human_required_rate', 'workflow_retry_groups', 'workflow_blocked_rate')
          OR signal_type LIKE 'detector_route_candidate:%'
       ORDER BY feedback_event_id`,
    )
    .all();
  for (const row of rows) {
    const signalType = String(row.signal_type ?? "");
    const normalizedSignal = signalType.startsWith("detector_route_candidate:")
      ? "detector_route_candidate"
      : signalType;
    if (!issueSignals.has(normalizedSignal)) continue;
    const sourceEventId = String(row.feedback_event_id ?? "");
    const id = deps.stableId("issue-queue", sourceEventId);
    const isDetectorCandidate = normalizedSignal === "detector_route_candidate";
    deps.recordProjectionEvent(db, {
      table: "issue_queue",
      id,
      row: {
        issue_queue_id: id,
        source_event_id: sourceEventId,
        plan_id: String(row.plan_id ?? ""),
        target: "github",
        title: isDetectorCandidate
          ? `[ut-tdd detector candidate] ${signalType}`
          : `[ut-tdd telemetry] ${signalType}`,
        body: isDetectorCandidate
          ? `Dry-run filing candidate from detector route feedback ${sourceEventId}. Human approval is required before external issue creation; routeFiling SSoT evaluation is recorded in the feedback event: ${row.next_action ?? ""}`
          : `Dry-run issue candidate from feedback event ${sourceEventId}: ${row.next_action ?? ""}`,
        status: "queued_dry_run",
        human_approval_required: 1,
        approved_by: "",
        approved_at: "",
        external_issue_id: "",
        external_issue_url: "",
        created_at: createdAt,
      },
    });
  }
}

export function projectIssueApprovalGuardrails(db: HarnessDb, deps: FeedbackProjectionDeps): void {
  const decidedAt = deps.nowIso();
  const rows = db
    .prepare("SELECT * FROM issue_queue WHERE human_approval_required = 1 ORDER BY issue_queue_id")
    .all();
  for (const row of rows) {
    const id = deps.stableId("guardrail", `issue-approval:${row.issue_queue_id ?? ""}`);
    deps.recordProjectionEvent(db, {
      table: "guardrail_decisions",
      id,
      row: {
        guardrail_decision_id: id,
        plan_id: String(row.plan_id ?? ""),
        session_id: "",
        guardrail: "external-github-issue-approval",
        decision: String(row.external_issue_url ?? "")
          ? "approved-created"
          : "requires-human-approval",
        mode: "manual-approval",
        human_signoff_required: String(row.external_issue_url ?? "") ? 0 : 1,
        evidence_path: String(row.issue_queue_id ?? ""),
        decided_at: decidedAt,
      },
    });
  }
}

export function projectImprovementLog(db: HarnessDb, deps: FeedbackProjectionDeps): void {
  const createdAt = deps.nowIso();
  const issueRows = db.prepare("SELECT * FROM issue_queue ORDER BY issue_queue_id").all();
  for (const row of issueRows) {
    const sourceEventId = String(row.source_event_id ?? "");
    const id = deps.stableId("improvement", sourceEventId || String(row.issue_queue_id ?? ""));
    deps.recordProjectionEvent(db, {
      table: "improvement_log",
      id,
      row: {
        improvement_log_id: id,
        source_event_id: sourceEventId,
        plan_id: String(row.plan_id ?? ""),
        category: "issue_queue",
        summary: String(row.title ?? ""),
        next_action: `review queued issue ${row.issue_queue_id ?? ""}`,
        status: "open",
        created_at: createdAt,
      },
    });
  }

  const retryRows = db.prepare("SELECT * FROM retry_events ORDER BY retry_event_id").all();
  for (const row of retryRows) {
    const id = deps.stableId("improvement", String(row.retry_event_id ?? ""));
    deps.recordProjectionEvent(db, {
      table: "improvement_log",
      id,
      row: {
        improvement_log_id: id,
        source_event_id: String(row.retry_event_id ?? ""),
        plan_id: String(row.plan_id ?? ""),
        category: "retry",
        summary: `${row.workflow ?? ""}/${row.phase ?? ""} attempts=${row.attempt_count ?? ""}`,
        next_action: "review retry/bottleneck pattern",
        status: "open",
        created_at: createdAt,
      },
    });
  }
}
