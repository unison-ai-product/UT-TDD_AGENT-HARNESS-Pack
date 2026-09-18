import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { ensureDir } from "../shared/fs.ts";

export const REVIEW_REQUEST_SCHEMA_VERSION = "review-request/v1" as const;
export const REVIEW_VERDICT_SCHEMA_VERSION = "ut-tdd.review-verdict/v1" as const;

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const REVISION_PATTERN = /^rv1-([a-f0-9]{64})$/;
const PROVIDERS = ["codex", "claude"] as const;

export interface ReviewCustodyRequest {
  readonly memoryId: string;
  readonly pr: number;
  readonly exactHead: string;
  readonly reviewRevision: string;
  readonly authorFamily: "codex" | "claude";
  readonly invocationNonce?: string;
}

export interface ReviewVerdictEnvelope {
  readonly schemaVersion: typeof REVIEW_VERDICT_SCHEMA_VERSION;
  readonly requestDigest: string;
  readonly attempt: number;
  readonly pr: number;
  readonly exactHead: string;
  readonly reviewRevision: string;
  readonly reviewerProvider: "codex" | "claude";
  readonly reviewerModel: string;
  readonly invocationNonce: string;
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** RFC8785相当のキー順（locale依存を避けたUTF-16 code-unit順）でJSONを作る。 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareUtf16(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function reviewIdentityObject(request: ReviewCustodyRequest): {
  schemaVersion: typeof REVIEW_REQUEST_SCHEMA_VERSION;
  memoryId: string;
  pr: number;
  exactHead: string;
  authorFamily: "codex" | "claude";
} {
  return {
    schemaVersion: REVIEW_REQUEST_SCHEMA_VERSION,
    memoryId: request.memoryId,
    pr: request.pr,
    exactHead: request.exactHead,
    authorFamily: request.authorFamily,
  };
}

export function reviewIdentityDigest(request: ReviewCustodyRequest): string {
  return createHash("sha256")
    .update(canonicalJson(reviewIdentityObject(request)), "utf8")
    .digest("hex");
}

export function canonicalReviewRevision(request: ReviewCustodyRequest): string {
  return `rv1-${reviewIdentityDigest(request)}`;
}

export function isStrictReviewRequest(request: ReviewCustodyRequest): boolean {
  const match = REVISION_PATTERN.exec(request.reviewRevision);
  return Boolean(match && match[1] === reviewIdentityDigest(request));
}

export function reviewVerdictPath(repoRoot: string, requestDigest: string, attempt = 1): string {
  if (!DIGEST_PATTERN.test(requestDigest)) throw new Error("invalid_review_request_digest");
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("invalid_review_attempt");
  return join(
    resolve(repoRoot),
    ".ut-tdd",
    "review",
    "verdicts",
    requestDigest,
    "attempts",
    `attempt-${attempt}`,
    "verdict.txt",
  );
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${requireSeparator()}`) && !isAbsoluteLike(rel))
  );
}

function requireSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}

function isAbsoluteLike(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function hasUnsafeText(value: string): boolean {
  return value.includes("\0") || value.split(/[\\/]/).includes("..");
}

/** 既存の親を一つずつ確認し、symlink/junctionを含む経路を拒否する。 */
function assertSafeParents(repoRoot: string, candidate: string): void {
  const root = realpathSync(resolve(repoRoot));
  const absolute = resolve(candidate);
  if (!isContained(root, absolute)) throw new Error("verdict_path_outside_repo");
  const rel = relative(root, absolute);
  if (hasUnsafeText(rel)) throw new Error("verdict_path_invalid");
  const parts = rel.split(/[\\/]/).filter(Boolean);
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) continue;
    const info = lstatSync(cursor);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("verdict_path_escape");
  }
  if (existsSync(absolute)) {
    const info = lstatSync(absolute);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("verdict_path_escape");
  }
}

export function assertReviewVerdictPath(input: {
  repoRoot: string;
  requestDigest: string;
  attempt: number;
  verdictPath: string;
}): void {
  const expected = reviewVerdictPath(input.repoRoot, input.requestDigest, input.attempt);
  const supplied = resolve(input.verdictPath);
  if (supplied !== expected || hasUnsafeText(relative(resolve(input.repoRoot), supplied))) {
    throw new Error("verdict_path_identity_mismatch");
  }
  assertSafeParents(input.repoRoot, supplied);
}

function commonDir(repoRoot: string): string {
  const result = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (!result) throw new Error("review_custody_common_dir_required");
  return result;
}

export function reviewCustodyAuditPath(repoRoot: string): string {
  return join(commonDir(repoRoot), "ut-tdd-runtime", "review-custody", "review-custody.jsonl");
}

export interface ReviewCustodyAuditEvent {
  readonly kind:
    | "attempt_execution_failed"
    | "attempt_verdict_rejected"
    | "attempt_outcome_conflict"
    | "attempt_completed"
    | "superseded_attempt"
    | "cleanup_pending";
  readonly requestDigest: string;
  readonly attempt: number;
  readonly exactHead: string;
  readonly verdictPath: string;
  readonly recordedAt: string;
  readonly reason: string;
  readonly provider?: "codex" | "claude";
  readonly model?: string;
  readonly receiptDigest?: string;
  readonly exitCode?: number;
  readonly verdictDigest?: string;
  /** sha256 of the exact bytes committed to the review receipt path. */
  readonly receiptFileDigest?: string;
  readonly oldAttemptDigest?: string;
  readonly supersededAttempt?: number;
}

export function appendReviewCustodyAudit(repoRoot: string, event: ReviewCustodyAuditEvent): void {
  const path = reviewCustodyAuditPath(repoRoot);
  ensureDir(dirname(path), { recursive: true });
  // O_APPEND + 単一JSON行で、linked worktree間の監査イベントを混線させない。
  appendFileSync(path, `${canonicalJson(event)}\n`, { encoding: "utf8", mode: 0o600 });
}

/** A successful strict attempt is terminal only after this event and receipt agree. */
export function isAttemptCompletedEvent(value: ReviewCustodyAuditEvent): boolean {
  return (
    value.kind === "attempt_completed" &&
    // PLAN-L7-534 §3.2 (i): the receipt digest lives only in receiptFileDigest; a
    // receiptDigest field (request digest in cleanup_pending) is a schema violation.
    !("receiptDigest" in value) &&
    isReviewDigest(value.requestDigest) &&
    Number.isSafeInteger(value.attempt) &&
    value.attempt > 0 &&
    /^[0-9a-f]{40}$/.test(value.exactHead) &&
    typeof value.verdictPath === "string" &&
    value.verdictPath.length > 0 &&
    typeof value.recordedAt === "string" &&
    value.recordedAt.length > 0 &&
    isReviewProvider(value.provider ?? "") &&
    typeof value.model === "string" &&
    value.model.trim().length > 0 &&
    value.exitCode === 0 &&
    isReviewDigest(value.receiptFileDigest ?? "") &&
    // §3.2 互換節 / -019(b): the request digest is never the receipt file digest.
    value.receiptFileDigest !== value.requestDigest &&
    isReviewDigest(value.verdictDigest ?? "")
  );
}

function digestFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return undefined;
  }
}

function auditEventsFor(repoRoot: string, requestDigest: string): ReviewCustodyAuditEvent[] {
  return readReviewCustodyAudit(repoRoot).filter((event) => event.requestDigest === requestDigest);
}

function sameAttemptOutcome(
  left: ReviewCustodyAuditEvent,
  right: ReviewCustodyAuditEvent,
): boolean {
  const withoutTime = (
    event: ReviewCustodyAuditEvent,
  ): Omit<ReviewCustodyAuditEvent, "recordedAt"> => {
    const { recordedAt: _recordedAt, ...identity } = event;
    return identity;
  };
  return canonicalJson(withoutTime(left)) === canonicalJson(withoutTime(right));
}

function isAttemptFailureEvent(input: {
  repoRoot: string;
  event: ReviewCustodyAuditEvent;
  request: ReviewCustodyRequest;
  attempt: number;
}): boolean {
  const { repoRoot, event, request, attempt } = input;
  const expectedProvider = request.authorFamily === "codex" ? "claude" : "codex";
  return (
    (event.kind === "attempt_execution_failed" || event.kind === "attempt_verdict_rejected") &&
    event.requestDigest === reviewIdentityDigest(request) &&
    event.attempt === attempt &&
    event.exactHead === request.exactHead &&
    event.verdictPath === reviewVerdictPath(repoRoot, event.requestDigest, attempt) &&
    event.provider !== undefined &&
    isReviewProvider(event.provider) &&
    typeof event.model === "string" &&
    event.model.trim().length > 0 &&
    Number.isSafeInteger(event.exitCode) &&
    ((event.kind === "attempt_execution_failed" &&
      event.provider === expectedProvider &&
      (event.exitCode as number) !== 0) ||
      (event.kind === "attempt_verdict_rejected" && (event.exitCode as number) === 0)) &&
    typeof event.reason === "string" &&
    event.reason.trim().length > 0 &&
    (event.verdictDigest === undefined || DIGEST_PATTERN.test(event.verdictDigest)) &&
    digestFile(event.verdictPath) === event.verdictDigest
  );
}

function isRetryableAttemptEvent(input: {
  repoRoot: string;
  event: ReviewCustodyAuditEvent;
  request: ReviewCustodyRequest;
  attempt: number;
}): boolean {
  if (isAttemptFailureEvent(input)) return true;
  const { repoRoot, event, request, attempt } = input;
  if (!isAttemptCompletedEvent(event)) return false;
  if (
    event.requestDigest !== reviewIdentityDigest(request) ||
    event.attempt !== attempt ||
    event.exactHead !== request.exactHead ||
    event.verdictPath !== reviewVerdictPath(repoRoot, event.requestDigest, attempt)
  )
    return false;
  // Completion before hardlink is a recoverable crash window. Once the final
  // receipt exists, the same event is terminal and beginReviewAttempt rejects.
  return !existsSync(
    join(resolve(repoRoot), ".ut-tdd", "review", "receipts", `${event.requestDigest}.json`),
  );
}

export type ReviewAttemptOutcomeResult =
  | { readonly ok: true; readonly event: ReviewCustodyAuditEvent }
  | { readonly ok: false; readonly reason: string };

/**
 * Record a failed provider execution without promoting it to canonical receipt.
 * The event is content-addressed by request/attempt and replaying the same event
 * is idempotent; a mutation of an existing event fails closed.
 */
export function recordReviewAttemptFailure(input: {
  repoRoot: string;
  request: ReviewCustodyRequest;
  attempt: number;
  provider: "codex" | "claude";
  model: string;
  exitCode: number;
  verdictPath: string;
  reason?: string;
  now?: string;
}): ReviewAttemptOutcomeResult {
  return recordAttemptOutcome({ ...input, kind: "attempt_execution_failed" });
}

/**
 * Record a terminal verdict rejection after a provider exited successfully.
 *
 * A reviewer can exit 0 while producing a missing, malformed, or identity-
 * invalid verdict.  That is a terminal outcome for this attempt, not a
 * successful review and not an execution failure.  Keeping it as its own
 * append-only event lets the next attempt recover without allowing the
 * rejected verdict to become a canonical receipt.
 */
export function recordReviewAttemptVerdictRejection(input: {
  repoRoot: string;
  request: ReviewCustodyRequest;
  attempt: number;
  provider: "codex" | "claude";
  model: string;
  verdictPath: string;
  reason: string;
  now?: string;
}): ReviewAttemptOutcomeResult {
  return recordAttemptOutcome({ ...input, exitCode: 0, kind: "attempt_verdict_rejected" });
}

function recordAttemptOutcome(input: {
  repoRoot: string;
  request: ReviewCustodyRequest;
  attempt: number;
  provider: "codex" | "claude";
  model: string;
  exitCode: number;
  verdictPath: string;
  reason?: string;
  now?: string;
  kind: "attempt_execution_failed" | "attempt_verdict_rejected";
}): ReviewAttemptOutcomeResult {
  if (!isStrictReviewRequest(input.request))
    return { ok: false, reason: "invalid_review_revision" };
  if (
    !Number.isSafeInteger(input.attempt) ||
    input.attempt < 1 ||
    (input.kind === "attempt_execution_failed" && input.exitCode === 0) ||
    (input.kind === "attempt_verdict_rejected" && input.exitCode !== 0)
  )
    return { ok: false, reason: "invalid_attempt_outcome" };
  if (!isReviewProvider(input.provider) || typeof input.model !== "string" || !input.model.trim())
    return { ok: false, reason: "invalid_attempt_outcome" };
  if (typeof input.reason === "string" && !input.reason.trim())
    return { ok: false, reason: "invalid_attempt_outcome" };
  const expectedProvider = input.request.authorFamily === "codex" ? "claude" : "codex";
  if (input.kind === "attempt_execution_failed" && input.provider !== expectedProvider)
    return { ok: false, reason: "same_family_reviewer_denied" };
  const digest = reviewIdentityDigest(input.request);
  try {
    assertReviewVerdictPath({
      repoRoot: input.repoRoot,
      requestDigest: digest,
      attempt: input.attempt,
      verdictPath: input.verdictPath,
    });
  } catch {
    return { ok: false, reason: "verdict_path_identity_mismatch" };
  }
  const verdictDigest = digestFile(input.verdictPath);
  const event: ReviewCustodyAuditEvent = {
    kind: input.kind,
    requestDigest: digest,
    attempt: input.attempt,
    exactHead: input.request.exactHead,
    verdictPath: reviewVerdictPath(input.repoRoot, digest, input.attempt),
    recordedAt: input.now ?? new Date().toISOString(),
    reason:
      input.reason ??
      (input.kind === "attempt_execution_failed" ? "reviewer_exit_nonzero" : "verdict_rejected"),
    provider: input.provider,
    model: input.model,
    exitCode: input.exitCode,
    ...(verdictDigest ? { verdictDigest } : {}),
  };
  let requestEvents: ReviewCustodyAuditEvent[];
  try {
    requestEvents = auditEventsFor(input.repoRoot, digest);
  } catch {
    return { ok: false, reason: "attempt_outcome_indeterminate" };
  }
  const existing = requestEvents.filter(
    (candidate) =>
      (candidate.kind === "attempt_execution_failed" ||
        candidate.kind === "attempt_verdict_rejected") &&
      candidate.attempt === input.attempt,
  );
  if (existing.length > 1) return { ok: false, reason: "attempt_outcome_indeterminate" };
  if (existing.length === 1) {
    if (sameAttemptOutcome(existing[0], event)) return { ok: true, event: existing[0] };
    const conflictEvent: ReviewCustodyAuditEvent = {
      ...event,
      kind: "attempt_outcome_conflict",
      reason: "attempt_outcome_conflict",
      oldAttemptDigest: existing[0].verdictDigest ?? "verdict_absent",
    };
    const conflicts = requestEvents.filter(
      (candidate) =>
        candidate.kind === "attempt_outcome_conflict" && candidate.attempt === input.attempt,
    );
    if (conflicts.length > 1) return { ok: false, reason: "attempt_outcome_indeterminate" };
    if (conflicts.length === 1) {
      return sameAttemptOutcome(conflicts[0], conflictEvent)
        ? { ok: false, reason: "attempt_outcome_conflict" }
        : { ok: false, reason: "attempt_outcome_indeterminate" };
    }
    try {
      appendReviewCustodyAudit(input.repoRoot, conflictEvent);
    } catch {
      return { ok: false, reason: "attempt_outcome_indeterminate" };
    }
    return { ok: false, reason: "attempt_outcome_conflict" };
  }
  try {
    appendReviewCustodyAudit(input.repoRoot, event);
    return { ok: true, event };
  } catch {
    return { ok: false, reason: "attempt_outcome_indeterminate" };
  }
}

export const recordReviewAttemptOutcome = recordReviewAttemptFailure;

function attemptNumbers(repoRoot: string, requestDigest: string): number[] {
  const directory = join(
    resolve(repoRoot),
    ".ut-tdd",
    "review",
    "verdicts",
    requestDigest,
    "attempts",
  );
  if (!existsSync(directory)) return [];
  const values: number[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const match = /^attempt-([1-9][0-9]*)$/.exec(entry.name);
    if (match && entry.isDirectory() && Number.isSafeInteger(Number(match[1])))
      values.push(Number(match[1]));
  }
  return values.sort((left, right) => left - right);
}

export type ReviewAttemptResult =
  | { readonly ok: true; readonly attempt: number; readonly path: string }
  | { readonly ok: false; readonly reason: string };

export function beginReviewAttempt(input: {
  repoRoot: string;
  request: ReviewCustodyRequest;
  provider: "codex" | "claude";
  model: string;
  now?: string;
}): ReviewAttemptResult {
  if (!isStrictReviewRequest(input.request))
    return { ok: false, reason: "invalid_review_revision" };
  const expectedProvider = input.request.authorFamily === "codex" ? "claude" : "codex";
  if (input.provider !== expectedProvider)
    return { ok: false, reason: "same_family_reviewer_denied" };
  const digest = reviewIdentityDigest(input.request);
  const receiptPath = join(
    resolve(input.repoRoot),
    ".ut-tdd",
    "review",
    "receipts",
    `${digest}.json`,
  );
  let requestEvents: ReviewCustodyAuditEvent[];
  try {
    requestEvents = auditEventsFor(input.repoRoot, digest);
  } catch {
    return { ok: false, reason: "attempt_outcome_indeterminate" };
  }
  // PLAN-L7-534 §3.2: a receipt is terminal only with one fully valid
  // attempt_completed — (i) schema, (ii) identity, (iii) receiptFileDigest ==
  // sha256(receipt bytes), (iv) no superseded_attempt / attempt_outcome_conflict
  // for that attempt. Anything less is an orphan and a bounded retry may start.
  const receiptDigestNow = existsSync(receiptPath) ? digestFile(receiptPath) : undefined;
  const completed = requestEvents.filter(
    (event) =>
      isAttemptCompletedEvent(event) &&
      event.requestDigest === digest &&
      event.exactHead === input.request.exactHead &&
      event.verdictPath === reviewVerdictPath(input.repoRoot, digest, event.attempt) &&
      receiptDigestNow !== undefined &&
      event.receiptFileDigest === receiptDigestNow &&
      !requestEvents.some(
        (other) =>
          (other.kind === "superseded_attempt" && other.supersededAttempt === event.attempt) ||
          (other.kind === "attempt_outcome_conflict" && other.attempt === event.attempt),
      ),
  );
  if (receiptDigestNow !== undefined && completed.length === 1)
    return { ok: false, reason: "review_receipt_already_exists" };
  // A crash-window temp file is never a receipt: ignore and remove it at the
  // start of every attempt, whether or not a (orphan) receipt exists (§3.2, -018).
  try {
    const directory = dirname(receiptPath);
    if (existsSync(directory)) {
      for (const entry of readdirSync(directory)) {
        if (entry.startsWith(`.${digest}.json.tmp-`))
          rmSync(join(directory, entry), { force: true });
      }
    }
  } catch {
    return { ok: false, reason: "review_custody_audit_unavailable" };
  }
  const used = attemptNumbers(input.repoRoot, digest);
  const attempt = (used.at(-1) ?? 0) + 1;
  if (used.length > 0) {
    const previousAttempt = used.at(-1) as number;
    const outcomes = requestEvents.filter(
      (event) =>
        (event.kind === "attempt_execution_failed" || event.kind === "attempt_verdict_rejected") &&
        event.attempt === previousAttempt,
    );
    if (
      requestEvents.some(
        (event) => event.kind === "attempt_outcome_conflict" && event.attempt === previousAttempt,
      )
    ) {
      return { ok: false, reason: "attempt_outcome_indeterminate" };
    }
    const previousOutcome = outcomes[0];
    // Exactly one failure outcome is the PLAN-L7-520 retry path. Zero outcomes is
    // retryable only through PLAN-L7-534 §3.2: a crash window (one valid
    // attempt_completed, receipt absent) or an orphan receipt without a matching
    // event. Two or more outcomes stay indeterminate (U-RVATT-040 case D).
    const completedForPrevious = requestEvents.filter(
      (event) => event.kind === "attempt_completed" && event.attempt === previousAttempt,
    );
    const retryable =
      outcomes.length === 1
        ? isRetryableAttemptEvent({
            repoRoot: input.repoRoot,
            event: previousOutcome,
            request: input.request,
            attempt: previousAttempt,
          })
        : outcomes.length === 0 &&
          (receiptDigestNow !== undefined ||
            (completedForPrevious.length === 1 &&
              isRetryableAttemptEvent({
                repoRoot: input.repoRoot,
                event: completedForPrevious[0],
                request: input.request,
                attempt: previousAttempt,
              })));
    if (!retryable) return { ok: false, reason: "attempt_outcome_indeterminate" };
    const failureIndex = previousOutcome ? requestEvents.indexOf(previousOutcome) : -1;
    if (
      requestEvents
        .slice(0, failureIndex)
        .some(
          (event) =>
            event.kind === "superseded_attempt" &&
            (event.supersededAttempt === undefined || event.supersededAttempt >= previousAttempt),
        )
    ) {
      return { ok: false, reason: "attempt_outcome_indeterminate" };
    }
    const existingSupersession = requestEvents.filter(
      (event) => event.kind === "superseded_attempt" && event.attempt === attempt,
    );
    if (existingSupersession.length > 0) {
      return { ok: false, reason: "attempt_outcome_indeterminate" };
    }
    try {
      appendReviewCustodyAudit(input.repoRoot, {
        kind: "superseded_attempt",
        requestDigest: digest,
        attempt,
        exactHead: input.request.exactHead,
        verdictPath: reviewVerdictPath(input.repoRoot, digest, previousAttempt),
        recordedAt: input.now ?? new Date().toISOString(),
        reason: "retry",
        provider: input.provider,
        model: input.model,
        supersededAttempt: previousAttempt,
        oldAttemptDigest: previousOutcome?.verdictDigest ?? "verdict_absent",
        ...(previousOutcome?.verdictDigest ? { verdictDigest: previousOutcome.verdictDigest } : {}),
      });
    } catch {
      return { ok: false, reason: "review_custody_audit_unavailable" };
    }
  }
  const path = reviewVerdictPath(input.repoRoot, digest, attempt);
  try {
    assertReviewVerdictPath({
      repoRoot: input.repoRoot,
      requestDigest: digest,
      attempt,
      verdictPath: path,
    });
    mkdirSync(dirname(path), { recursive: true });
    assertReviewVerdictPath({
      repoRoot: input.repoRoot,
      requestDigest: digest,
      attempt,
      verdictPath: path,
    });
  } catch {
    return { ok: false, reason: "verdict_path_unavailable" };
  }
  return { ok: true, attempt, path };
}

export function cleanupReviewAttempt(input: {
  repoRoot: string;
  requestDigest: string;
  attempt: number;
  verdictPath: string;
  receiptDigest: string;
  exactHead: string;
  now?: string;
}): void {
  try {
    assertReviewVerdictPath(input);
    rmSync(dirname(input.verdictPath), { recursive: true, force: true });
  } catch (error) {
    appendReviewCustodyAudit(input.repoRoot, {
      kind: "cleanup_pending",
      requestDigest: input.requestDigest,
      attempt: input.attempt,
      exactHead: input.exactHead,
      verdictPath: input.verdictPath,
      recordedAt: input.now ?? new Date().toISOString(),
      reason: error instanceof Error ? error.message : String(error),
      receiptDigest: input.receiptDigest,
    });
  }
}

export function readReviewCustodyAudit(repoRoot: string): ReviewCustodyAuditEvent[] {
  const path = reviewCustodyAuditPath(repoRoot);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ReviewCustodyAuditEvent);
}

export function isReviewDigest(value: string): boolean {
  return DIGEST_PATTERN.test(value);
}

export function isReviewProvider(value: string): value is "codex" | "claude" {
  return PROVIDERS.includes(value as (typeof PROVIDERS)[number]);
}
