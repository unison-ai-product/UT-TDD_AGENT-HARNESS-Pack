/**
 * PR #201 が reviews=0 / comments=0 のまま merge され、verdict 無し merge が発生した。
 * また PR #202 では全 green・freeze 済みでも verdict 待ちが train 全体を止めた。
 * この検査は、同様の手順違反と待ち時間の見落としを dispatch 状態として機械的に検出する。
 * 関連する実測 incident は #189 (verdict 前 merge) である。
 */

export type ReviewDispatchState =
  | "requested"
  | "acknowledged"
  | "in_review"
  | "verdict"
  | "stale_head"
  | "merge_ready";

export type ReviewerFamily = "claude" | "codex";
export type ReviewVerdict = "PASS" | "PASS-WEAK" | "FLAG";
export type SlaBreach = "verdict";
export type ReviewReceiptKind = "acknowledged" | "in_review" | "verdict";

export interface ReviewRequest {
  memoryId: string;
  pr: number;
  exactHead: string;
  reviewRevision: string;
  authorFamily: ReviewerFamily;
  requestedAt: string;
}

export interface ReviewReceipt {
  memoryId: string;
  pr: number;
  head: string;
  reviewRevision: string;
  reviewerFamily: ReviewerFamily;
  kind: ReviewReceiptKind;
  verdict?: ReviewVerdict;
  blockingFindings?: string[];
  at: string;
}

export interface PrObservation {
  pr: number;
  headSha: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  checksGreen: boolean;
}

export interface ReviewDispatchSla {
  verdictMinutes: number;
}

export const DEFAULT_REVIEW_DISPATCH_SLA: ReviewDispatchSla = {
  verdictMinutes: 60,
};

export interface ReviewDispatchEntry {
  memoryId: string;
  pr: number;
  exactHead: string;
  reviewRevision: string;
  authorFamily: ReviewerFamily;
  reviewerFamily?: ReviewerFamily;
  verdict?: ReviewVerdict;
  state: ReviewDispatchState;
  breaches: SlaBreach[];
  ageMinutes: number | null;
  blocking: string[];
  reasons: string[];
  progressDiagnostics: string[];
}

export interface ReviewDispatchResult {
  entries: ReviewDispatchEntry[];
  diagnostics: string[];
  ok: boolean;
}

interface DispatchAnalysis {
  entry: ReviewDispatchEntry;
}

const REVIEWER_FAMILIES: ReviewerFamily[] = ["claude", "codex"];
const RECEIPT_KINDS: ReviewReceiptKind[] = ["acknowledged", "in_review", "verdict"];
const VERDICTS: ReviewVerdict[] = ["PASS", "PASS-WEAK", "FLAG"];
const PR_STATES: PrObservation["state"][] = ["OPEN", "MERGED", "CLOSED"];
const HEAD_PATTERN = /^[0-9a-f]{40}$/;
const EXPLICIT_ZONE_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

function isBlockingDiagnostic(diagnostic: string): boolean {
  return (
    diagnostic.startsWith("orphan_pr_observation:merged_without_request:") ||
    diagnostic.startsWith("orphan_pr_observation:merged_head_without_request:") ||
    diagnostic.startsWith("orphan_pr_observation:invalid_merged_observation:")
  );
}

/**
 * GitHub/API/PLAN の既存 producer が出す、timezone 明示済み ISO timestamp を読む。
 * timezone 無し文字列だけは runtime の local timezone で意味が変わるため拒否する。
 */
function parseExplicitZoneTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = EXPLICIT_ZONE_TIMESTAMP_PATTERN.exec(value);
  if (match == null) return undefined;
  const [, year, month, day, hour, minute, second, , zone] = match;
  const yearValue = Number(year);
  const monthValue = Number(month);
  const dayValue = Number(day);
  const daysInMonth = new Date(Date.UTC(yearValue, monthValue, 0)).getUTCDate();
  if (
    monthValue < 1 ||
    monthValue > 12 ||
    dayValue < 1 ||
    dayValue > daysInMonth ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  ) {
    return undefined;
  }
  if (zone !== "Z") {
    const [offsetHour, offsetMinute] = zone.slice(1).split(":").map(Number);
    if (offsetHour > 23 || offsetMinute > 59) return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRequests(left: ReviewRequest, right: ReviewRequest): number {
  return (
    left.pr - right.pr ||
    compareText(left.exactHead, right.exactHead) ||
    compareText(left.memoryId, right.memoryId) ||
    compareText(left.reviewRevision, right.reviewRevision) ||
    compareText(left.authorFamily, right.authorFamily) ||
    compareText(left.requestedAt, right.requestedAt)
  );
}

function compareReceipts(left: ReviewReceipt, right: ReviewReceipt): number {
  const leftAt = parseExplicitZoneTimestamp(left.at);
  const rightAt = parseExplicitZoneTimestamp(right.at);
  if (leftAt != null && rightAt != null && leftAt !== rightAt) {
    return leftAt - rightAt;
  }
  return (
    compareText(left.at, right.at) ||
    compareText(left.kind, right.kind) ||
    compareText(left.reviewerFamily, right.reviewerFamily) ||
    compareText(left.head, right.head) ||
    compareText(left.memoryId, right.memoryId) ||
    compareText(left.reviewRevision, right.reviewRevision) ||
    compareText(left.verdict ?? "", right.verdict ?? "") ||
    compareText(
      (left.blockingFindings ?? []).join("\u0000"),
      (right.blockingFindings ?? []).join("\u0000"),
    )
  );
}

function identityKey(value: {
  memoryId: string;
  pr: number;
  exactHead: string;
  reviewRevision: string;
}): string {
  return JSON.stringify([value.memoryId, value.pr, value.exactHead, value.reviewRevision]);
}

function timestampContentKey(value: string): string {
  const instant = parseExplicitZoneTimestamp(value);
  return instant == null ? `invalid:${value}` : `instant:${instant}`;
}

function requestContentKey(request: ReviewRequest): string {
  return JSON.stringify([
    request.memoryId,
    request.pr,
    request.exactHead,
    request.reviewRevision,
    request.authorFamily,
  ]);
}

function receiptContentKey(receipt: ReviewReceipt): string {
  return JSON.stringify([
    receipt.memoryId,
    receipt.pr,
    receipt.head,
    receipt.reviewRevision,
    receipt.reviewerFamily,
    receipt.kind,
    receipt.verdict ?? null,
    receipt.blockingFindings ?? null,
    timestampContentKey(receipt.at),
  ]);
}

function observationContentKey(observation: PrObservation): string {
  return JSON.stringify([
    observation.pr,
    observation.headSha,
    observation.state,
    observation.checksGreen,
  ]);
}

function uniqueRequests(
  requests: ReviewRequest[],
  nowMs: number,
): {
  requests: ReviewRequest[];
  conflictingIdentities: Set<string>;
} {
  const grouped = new Map<string, ReviewRequest[]>();
  const conflictingIdentities = new Set<string>();
  const result: ReviewRequest[] = [];
  for (const request of requests) {
    const key = identityKey(request);
    grouped.set(key, [...(grouped.get(key) ?? []), request]);
  }
  for (const [key, candidates] of grouped) {
    const canonical = [...candidates].sort(compareCanonicalRequests)[0];
    const canonicalContentKey = requestContentKey(canonical);
    if (
      candidates.some((candidate) => requestContentKey(candidate) !== canonicalContentKey) ||
      candidates.some((candidate) => isValidTimestamp(candidate.requestedAt, nowMs) != null)
    ) {
      conflictingIdentities.add(key);
    }
    result.push(canonical);
  }
  return { requests: result.sort(compareRequests), conflictingIdentities };
}

function compareCanonicalRequests(left: ReviewRequest, right: ReviewRequest): number {
  const leftTimestamp = parseExplicitZoneTimestamp(left.requestedAt);
  const rightTimestamp = parseExplicitZoneTimestamp(right.requestedAt);
  if (leftTimestamp == null && rightTimestamp != null) return -1;
  if (leftTimestamp != null && rightTimestamp == null) return 1;
  if (leftTimestamp != null && rightTimestamp != null && leftTimestamp !== rightTimestamp) {
    return leftTimestamp - rightTimestamp;
  }
  return compareRequests(left, right);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidHead(value: unknown): value is string {
  return typeof value === "string" && HEAD_PATTERN.test(value);
}

function isValidPr(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isValidTimestamp(value: unknown, nowMs: number): string | undefined {
  const timestamp = parseExplicitZoneTimestamp(value);
  if (timestamp == null) return "invalid_timestamp";
  if (Number.isFinite(nowMs) && timestamp > nowMs) return "future_timestamp";
  return undefined;
}

function hasOwn(value: object, property: string): boolean {
  return Object.hasOwn(value, property);
}

function validateRequest(request: ReviewRequest, nowMs: number): string[] {
  const reasons = new Set<string>();
  if (!isNonEmptyString(request.memoryId)) reasons.add("empty_identity");
  if (!isValidPr(request.pr)) reasons.add("invalid_request_fields");
  if (!isValidHead(request.exactHead)) reasons.add("invalid_head");
  if (!isNonEmptyString(request.reviewRevision)) reasons.add("empty_review_revision");
  if (!REVIEWER_FAMILIES.includes(request.authorFamily)) reasons.add("invalid_request_fields");
  const timestampReason = isValidTimestamp(request.requestedAt, nowMs);
  if (timestampReason) reasons.add(timestampReason);
  return [...reasons];
}

function validateReceipt(receipt: ReviewReceipt, nowMs: number): string[] {
  const reasons = new Set<string>();
  if (!isNonEmptyString(receipt.memoryId)) reasons.add("empty_identity");
  if (!isValidPr(receipt.pr)) reasons.add("invalid_receipt_fields");
  if (!isValidHead(receipt.head)) reasons.add("invalid_head");
  if (!isNonEmptyString(receipt.reviewRevision)) reasons.add("empty_review_revision");
  if (!REVIEWER_FAMILIES.includes(receipt.reviewerFamily)) reasons.add("invalid_receipt_fields");
  if (!RECEIPT_KINDS.includes(receipt.kind)) reasons.add("invalid_receipt_fields");
  const timestampReason = isValidTimestamp(receipt.at, nowMs);
  if (timestampReason) reasons.add(timestampReason);

  const hasVerdict = hasOwn(receipt, "verdict");
  const hasBlockingFindings = hasOwn(receipt, "blockingFindings");
  if (receipt.kind !== "verdict" && (hasVerdict || hasBlockingFindings)) {
    reasons.add("unexpected_verdict_fields");
  }
  if (receipt.kind === "verdict") {
    if (!hasVerdict || !VERDICTS.includes(receipt.verdict as ReviewVerdict)) {
      reasons.add("missing_verdict");
    } else if (receipt.verdict === "FLAG") {
      const findings = receipt.blockingFindings;
      if (
        !Array.isArray(findings) ||
        findings.length === 0 ||
        findings.some((finding) => !isNonEmptyString(finding))
      ) {
        reasons.add("flag_without_blocking_findings");
      }
    } else if (
      hasBlockingFindings &&
      (!Array.isArray(receipt.blockingFindings) || receipt.blockingFindings.length > 0)
    ) {
      reasons.add("blocking_findings_on_pass");
    }
  }
  return [...reasons];
}

function validateObservation(observation: PrObservation): boolean {
  return (
    isValidPr(observation.pr) &&
    isValidHead(observation.headSha) &&
    PR_STATES.includes(observation.state) &&
    typeof observation.checksGreen === "boolean"
  );
}

function validateSla(sla: ReviewDispatchSla): boolean {
  if (sla == null || typeof sla !== "object") return false;
  return (
    typeof sla.verdictMinutes === "number" &&
    Number.isFinite(sla.verdictMinutes) &&
    sla.verdictMinutes > 0
  );
}

function elapsedMinutes(requestedAt: string, nowMs: number): number | null {
  const requestedMs = parseExplicitZoneTimestamp(requestedAt);
  return requestedMs != null && Number.isFinite(nowMs) && requestedMs <= nowMs
    ? (nowMs - requestedMs) / 60_000
    : null;
}

function observationFor(request: ReviewRequest, prs: PrObservation[]): PrObservation | undefined {
  return [...prs]
    .filter((observation) => observation.pr === request.pr)
    .sort(
      (left, right) =>
        Number(right.headSha === request.exactHead) - Number(left.headSha === request.exactHead) ||
        compareText(left.headSha, right.headSha) ||
        compareText(left.state, right.state) ||
        Number(left.checksGreen) - Number(right.checksGreen),
    )[0];
}

/** 1 件の request を判定するための観測入力 (coding-rule max-source-params のため object にまとめる)。 */
interface DispatchObservationContext {
  receipts: ReviewReceipt[];
  prs: PrObservation[];
  nowMs: number;
  sla: ReviewDispatchSla;
  globalReasons: string[];
  duplicateRequestConflict: boolean;
}

function analyzeRequest(
  request: ReviewRequest,
  context: DispatchObservationContext,
): DispatchAnalysis {
  const { receipts, prs, nowMs, sla, globalReasons, duplicateRequestConflict } = context;
  const reasons = new Set([...globalReasons, ...validateRequest(request, nowMs)]);
  const progressDiagnostics = new Set<string>();
  if (duplicateRequestConflict) reasons.add("duplicate_request_conflict");
  const requestTimestamp = parseExplicitZoneTimestamp(request.requestedAt);
  const candidates = receipts.filter(
    (receipt) =>
      receipt.memoryId === request.memoryId &&
      receipt.pr === request.pr &&
      receipt.head === request.exactHead &&
      receipt.reviewRevision === request.reviewRevision,
  );
  for (const receipt of candidates) {
    for (const reason of validateReceipt(receipt, nowMs)) reasons.add(reason);
  }
  const relevantReceipts = candidates
    .filter((receipt) => validateReceipt(receipt, nowMs).length === 0)
    .sort(compareReceipts);

  const crossFamilyReceipts: ReviewReceipt[] = [];
  let sameFamilyVerdictObserved = false;
  for (const receipt of relevantReceipts) {
    if (receipt.reviewerFamily === request.authorFamily) {
      if (receipt.kind === "verdict") {
        sameFamilyVerdictObserved = true;
      } else {
        progressDiagnostics.add("same_family_progress_receipt");
      }
      continue;
    }
    crossFamilyReceipts.push(receipt);
  }

  const acceptedCandidates: ReviewReceipt[] = [];
  for (const receipt of crossFamilyReceipts) {
    const receiptAt = parseExplicitZoneTimestamp(receipt.at);
    if (receiptAt == null) {
      reasons.add("invalid_timestamp");
      continue;
    }
    if (requestTimestamp == null) {
      reasons.add("request_timestamp_unverifiable");
      continue;
    }
    if (receiptAt < requestTimestamp) {
      reasons.add("receipt_before_request");
      continue;
    }
    acceptedCandidates.push(receipt);
  }

  const receiptByKind = new Map<ReviewReceiptKind, ReviewReceipt>();
  for (const receipt of acceptedCandidates) {
    const previous = receiptByKind.get(receipt.kind);
    if (previous == null) {
      receiptByKind.set(receipt.kind, receipt);
      continue;
    }
    if (receiptContentKey(previous) !== receiptContentKey(receipt)) {
      reasons.add("duplicate_receipt_conflict");
    }
  }

  const acceptedByKind = new Map(
    [...receiptByKind.values()].map((receipt) => [receipt.kind, receipt] as const),
  );
  const verdictReceipt = acceptedByKind.get("verdict");
  const hasVerdict = verdictReceipt != null;
  const flagFindings = [
    ...new Set(
      acceptedCandidates
        .filter((receipt) => receipt.kind === "verdict" && receipt.verdict === "FLAG")
        .flatMap((receipt) => receipt.blockingFindings ?? []),
    ),
  ];
  const hasFlagVerdict = flagFindings.length > 0;
  if (sameFamilyVerdictObserved) {
    if (hasVerdict) {
      progressDiagnostics.add("same_family_verdict_ignored");
    } else {
      reasons.add("same_family_reviewer");
    }
  }
  const hasAcknowledged = acceptedByKind.has("acknowledged");
  const hasStarted = acceptedByKind.has("in_review");
  if (hasVerdict && !hasAcknowledged) progressDiagnostics.add("missing_acknowledged");
  if (hasVerdict && !hasStarted) progressDiagnostics.add("missing_in_review");

  const observationCandidates = prs.filter((observation) => observation.pr === request.pr);
  for (const candidate of observationCandidates) {
    if (!validateObservation(candidate)) reasons.add("invalid_pr_observation");
  }
  const observationsByContent = new Map<string, PrObservation>();
  for (const candidate of observationCandidates.filter(validateObservation)) {
    observationsByContent.set(observationContentKey(candidate), candidate);
  }
  if (observationsByContent.size > 1) reasons.add("duplicate_pr_observation_conflict");
  const observation = observationFor(request, [...observationsByContent.values()]);
  if (observation == null) reasons.add("pr_observation_missing");
  const hasObservationHeadMismatch =
    observation != null && observation.headSha !== request.exactHead;
  if (hasObservationHeadMismatch) progressDiagnostics.add("request_superseded");
  if (observation?.state === "CLOSED") progressDiagnostics.add("review_request_closed");
  if (observation?.state === "MERGED" && !hasObservationHeadMismatch && !hasVerdict) {
    reasons.add("merged_without_verdict");
  }

  const ageMinutes = elapsedMinutes(request.requestedAt, nowMs);
  const breaches: SlaBreach[] = [];
  const reviewIsTerminal =
    hasObservationHeadMismatch ||
    observation?.state === "CLOSED" ||
    observation?.state === "MERGED";
  if (!hasVerdict && !reviewIsTerminal && (ageMinutes == null || ageMinutes > sla.verdictMinutes)) {
    breaches.push("verdict");
  }

  const blocking = hasFlagVerdict ? flagFindings : [];
  if (hasFlagVerdict) reasons.add("flagged");

  let state: ReviewDispatchState = hasVerdict
    ? "verdict"
    : hasStarted
      ? "in_review"
      : hasAcknowledged
        ? "acknowledged"
        : "requested";
  if (hasObservationHeadMismatch) {
    state = "stale_head";
  } else if (
    reasons.size === 0 &&
    (verdictReceipt?.verdict === "PASS" || verdictReceipt?.verdict === "PASS-WEAK") &&
    observation?.headSha === request.exactHead &&
    observation.checksGreen &&
    observation.state === "OPEN"
  ) {
    state = "merge_ready";
  }

  return {
    entry: {
      memoryId: request.memoryId,
      pr: request.pr,
      exactHead: request.exactHead,
      reviewRevision: request.reviewRevision,
      authorFamily: request.authorFamily,
      reviewerFamily: verdictReceipt?.reviewerFamily ?? acceptedCandidates.at(-1)?.reviewerFamily,
      verdict: verdictReceipt?.verdict,
      state,
      breaches,
      ageMinutes,
      blocking,
      reasons: [...reasons].sort(compareText),
      progressDiagnostics: [...progressDiagnostics].sort(compareText),
    },
  };
}

export function analyzeReviewDispatch(input: {
  requests: ReviewRequest[];
  receipts: ReviewReceipt[];
  prs: PrObservation[];
  now: string;
  sla?: ReviewDispatchSla;
}): ReviewDispatchResult {
  const nowMs = parseExplicitZoneTimestamp(input.now);
  const sla = input.sla ?? DEFAULT_REVIEW_DISPATCH_SLA;
  const globalReasons = new Set<string>();
  const diagnostics = new Set<string>();
  if (nowMs == null) globalReasons.add("invalid_timestamp");
  if (input.sla === null || !validateSla(sla)) globalReasons.add("invalid_sla");
  const requestIdentities = new Set(input.requests.map(identityKey));
  const requestedPrs = new Set(input.requests.map((request) => request.pr));
  const requestedHeads = new Set(
    input.requests.map((request) => `${request.pr}@${request.exactHead}`),
  );
  for (const receipt of input.receipts) {
    const receiptIdentity = identityKey({
      memoryId: receipt.memoryId,
      pr: receipt.pr,
      exactHead: receipt.head,
      reviewRevision: receipt.reviewRevision,
    });
    if (!requestIdentities.has(receiptIdentity)) {
      const reasons = validateReceipt(receipt, nowMs ?? Number.NaN);
      const diagnosticIdentity = `${receipt.memoryId}@${receipt.pr}@${receipt.head}@${receipt.reviewRevision}`;
      if (reasons.length === 0) {
        diagnostics.add(`orphan_receipt:unmatched_identity:${diagnosticIdentity}`);
      } else {
        for (const reason of reasons) {
          diagnostics.add(`orphan_receipt:${reason}:${diagnosticIdentity}`);
        }
      }
    }
  }
  for (const observation of input.prs) {
    if (!requestedPrs.has(observation.pr)) {
      const valid = validateObservation(observation);
      diagnostics.add(
        valid && observation.state === "MERGED"
          ? `orphan_pr_observation:merged_without_request:${observation.pr}@${observation.headSha}`
          : observation.state === "MERGED"
            ? `orphan_pr_observation:invalid_merged_observation:${observation.pr}@${observation.headSha}`
            : valid
              ? `orphan_pr_observation:unmatched_pr:${observation.pr}@${observation.headSha}`
              : `orphan_pr_observation:invalid_pr_observation:${observation.pr}@${observation.headSha}`,
      );
    } else if (
      validateObservation(observation) &&
      observation.state === "MERGED" &&
      !requestedHeads.has(`${observation.pr}@${observation.headSha}`)
    ) {
      diagnostics.add(
        `orphan_pr_observation:merged_head_without_request:${observation.pr}@${observation.headSha}`,
      );
    }
  }

  const unique = uniqueRequests(input.requests, nowMs ?? Number.NaN);
  const analyses = unique.requests.map((request) =>
    analyzeRequest(request, {
      receipts: input.receipts,
      prs: input.prs,
      nowMs: nowMs ?? Number.NaN,
      sla,
      globalReasons: [...globalReasons],
      duplicateRequestConflict: unique.conflictingIdentities.has(identityKey(request)),
    }),
  );
  analyses.sort(
    (left, right) =>
      left.entry.pr - right.entry.pr ||
      compareText(left.entry.exactHead, right.entry.exactHead) ||
      compareText(left.entry.memoryId, right.entry.memoryId) ||
      compareText(left.entry.reviewRevision, right.entry.reviewRevision),
  );

  return {
    entries: analyses.map(({ entry }) => entry),
    diagnostics: [...diagnostics].sort(compareText),
    ok:
      globalReasons.size === 0 &&
      [...diagnostics].every((diagnostic) => !isBlockingDiagnostic(diagnostic)) &&
      analyses.every(({ entry }) => entry.breaches.length === 0 && entry.reasons.length === 0),
  };
}

export function reviewDispatchMessages(result: ReviewDispatchResult): string[] {
  const messages: string[] = [];
  for (const entry of result.entries) {
    for (const breach of entry.breaches) {
      messages.push(
        `review-dispatch — SLA超過: PR #${entry.pr} ${breach} (${entry.memoryId}@${entry.reviewRevision}#${entry.exactHead})`,
      );
    }
    for (const reason of entry.reasons) {
      const detail =
        reason === "same_family_reviewer"
          ? "同一 reviewer family の receipt は受理しない"
          : reason === "merged_without_verdict"
            ? "verdict 無しで PR が MERGED になった"
            : reason === "flagged"
              ? `FLAG verdict (${entry.blocking.join(", ") || "blocking finding なし"})`
              : reason;
      messages.push(
        `review-dispatch — 手順違反: PR #${entry.pr} ${detail} (${entry.memoryId}@${entry.reviewRevision}#${entry.exactHead})`,
      );
    }
    for (const diagnostic of entry.progressDiagnostics) {
      messages.push(
        `review-dispatch — 進捗診断: PR #${entry.pr} ${diagnostic} (${entry.memoryId}@${entry.reviewRevision}#${entry.exactHead})`,
      );
    }
  }
  for (const diagnostic of result.diagnostics) {
    messages.push(`review-dispatch — 未帰属診断: ${diagnostic}`);
  }
  const uniqueMessages = [...new Set(messages)];
  return uniqueMessages.length > 0 ? uniqueMessages : ["review-dispatch — OK"];
}
