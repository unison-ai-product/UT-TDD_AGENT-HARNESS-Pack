/**
 * D3d trusted remote custody (PLAN-L7-465 §D3c freeze の実装、oracle `U-RVGHA-D3C-001`〜`018`)。
 *
 * D1 (`review-dispatch.ts`) が出した judgment を、GitHub が検証できる機械 envelope へ束縛する。
 * repository / PR 番号 / exact HEAD / workflow run / issuer / request digest / verdict digest を
 * 同一 subject へ縛り、forged receipt・cross-PR replay・wrong HEAD・cancelled / skipped / failure
 * を typed に拒否する。受理状態は `custody_admitted` ただ一つで、boolean も部分成功も返さない。
 *
 * **この module は merge 可否を判定しない。** CI 集約と merge eligibility は D1 `merge_ready` と
 * D2 の所有であり、`AdmittedCustody` は CI 由来の field を一切持たない (Check Run を第二 SSoT に
 * しないため)。
 *
 * 信頼根の限界も明示する: GitHub Artifact Attestation が証明するのは artifact digest と
 * repository / workflow / run / issuer の provenance、および発行後の非改竄だけである。
 * payload の `reviewerFamily` は自己申告であり、承認済み `VerifiedProviderIdentity` が
 * 無い限り `unverified_family` で fail-close する。
 */
import type {
  GitHubAttestationFacts,
  GitHubAttestationVerifierPort,
} from "./ports/github-attestation-verifier.ts";
import type { VerifiedProviderIdentity } from "./ports/provider-family-authority.ts";
import {
  canonicalize,
  computeReviewRevision,
  REVIEW_REVISION_PATTERN,
  type ReviewRequestIdentity,
  sha256Hex,
} from "./review-custody-canonical.ts";

export const REVIEW_CUSTODY_SCHEMA_VERSION = "review-custody/v1";
export const DEFAULT_CUSTODY_VERIFICATION_ATTEMPTS = 3;

export type ReviewCustodyReceiptKind = "pre_merge_review" | "post_merge_closure";
export type ReviewCustodyFamily = "claude" | "codex";
export type ReviewCustodyVerdict = "PASS" | "PASS-WEAK" | "FLAG";

export type CustodyFailureReason =
  | "missing"
  | "signature_unverified"
  | "signer_mismatch"
  | "identity_mismatch"
  | "receipt_corrupt"
  | "head_raced"
  | "provider_failed"
  | "verdict_flagged"
  | "unverified_family"
  | "audit_unavailable";

export interface ReviewCustodyReceipt {
  readonly schemaVersion: string;
  readonly receiptKind: ReviewCustodyReceiptKind;
  readonly repository: string;
  readonly prNumber: number;
  readonly baseRef: string;
  readonly headSha: string;
  readonly mergeSha?: string;
  readonly mergeMethod?: "merge" | "squash" | "rebase";
  readonly mergedAt?: string;
  readonly planId: string;
  readonly planRevision: string;
  readonly reviewRevision: string;
  readonly judgmentDigest: string;
  readonly receiptDigest: string;
  readonly workflowRef: string;
  readonly workflowSha: string;
  readonly runId: string;
  readonly runAttempt: number;
  readonly issuer: string;
  readonly providerEvidenceRef: string;
  readonly reviewerFamily: ReviewCustodyFamily;
  readonly authorFamily: ReviewCustodyFamily;
  readonly verdict: ReviewCustodyVerdict;
  readonly blockingFindingCount: number;
}

const LOWER_HEX_40 = /^[0-9a-f]{40}$/;
const LOWER_HEX_64 = /^[0-9a-f]{64}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const REF_PATTERN = /^[A-Za-z0-9._/-]{1,255}$/;
const PLAN_ID_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;
const WORKFLOW_REF_PATTERN =
  /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml@refs\/heads\/[A-Za-z0-9._/-]+$/;
const RUN_ID_PATTERN = /^[0-9]{1,20}$/;
const ISSUER_PATTERN = /^https:\/\/[A-Za-z0-9.-]+$/;
const PROVIDER_EVIDENCE_REF_PATTERN = /^d3b:[0-9a-f]{64}$/;
const EXPLICIT_ZONE_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

const FAMILIES: readonly ReviewCustodyFamily[] = ["claude", "codex"];
const VERDICTS: readonly ReviewCustodyVerdict[] = ["PASS", "PASS-WEAK", "FLAG"];
const MERGE_METHODS = ["merge", "squash", "rebase"] as const;

type FieldCheck = (value: unknown) => boolean;

const isText = (pattern: RegExp): FieldCheck => {
  return (value) => typeof value === "string" && pattern.test(value);
};

const isPositiveInteger: FieldCheck = (value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/**
 * 全 field を pattern / enum / 整数域で閉じる。自由文字列 field を残さないことが
 * secret hygiene の実体である (token / raw transcript / absolute path / 実行命令は
 * どの field にも構造的に入らない)。
 */
const BASE_FIELDS: Readonly<Record<string, FieldCheck>> = {
  schemaVersion: (value) => value === REVIEW_CUSTODY_SCHEMA_VERSION,
  receiptKind: (value) => value === "pre_merge_review" || value === "post_merge_closure",
  repository: isText(REPOSITORY_PATTERN),
  prNumber: isPositiveInteger,
  baseRef: isText(REF_PATTERN),
  headSha: isText(LOWER_HEX_40),
  planId: isText(PLAN_ID_PATTERN),
  planRevision: isText(LOWER_HEX_64),
  reviewRevision: isText(REVIEW_REVISION_PATTERN),
  judgmentDigest: isText(LOWER_HEX_64),
  receiptDigest: isText(LOWER_HEX_64),
  workflowRef: isText(WORKFLOW_REF_PATTERN),
  workflowSha: isText(LOWER_HEX_40),
  runId: isText(RUN_ID_PATTERN),
  runAttempt: isPositiveInteger,
  issuer: isText(ISSUER_PATTERN),
  providerEvidenceRef: isText(PROVIDER_EVIDENCE_REF_PATTERN),
  reviewerFamily: (value) => FAMILIES.includes(value as ReviewCustodyFamily),
  authorFamily: (value) => FAMILIES.includes(value as ReviewCustodyFamily),
  verdict: (value) => VERDICTS.includes(value as ReviewCustodyVerdict),
  blockingFindingCount: (value) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
};

const POST_MERGE_FIELDS: Readonly<Record<string, FieldCheck>> = {
  mergeSha: isText(LOWER_HEX_40),
  mergeMethod: (value) => MERGE_METHODS.includes(value as (typeof MERGE_METHODS)[number]),
  mergedAt: isText(EXPLICIT_ZONE_TIMESTAMP),
};

export type ReviewCustodyDecodeOutcome =
  | { ok: true; receipt: ReviewCustodyReceipt }
  | { ok: false; reason: "receipt_corrupt" | "identity_mismatch"; detail: string };

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function receiptPreimage(record: Record<string, unknown>): Record<string, unknown> {
  const preimage: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "receiptDigest") continue;
    preimage[key] = value;
  }
  return preimage;
}

/** receiptDigest を除く exact object から canonical digest を再計算する。 */
export function computeReceiptDigest(record: Record<string, unknown>): string | null {
  const canonical = canonicalize(receiptPreimage(record));
  return canonical.ok ? sha256Hex(canonical.value) : null;
}

/**
 * receipt を strict decode する。unknown field / 欠落 / 型違い / kind 不整合は
 * `receipt_corrupt`、形式は正しいが再計算と一致しない digest は `identity_mismatch`。
 */
export function decodeReviewCustodyReceipt(text: string): ReviewCustodyDecodeOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    // raw exception / stack は receipt 側へ出さない (fail-close 理由だけを残す)。
    const kind = error instanceof Error ? "json_syntax" : "json_unknown";
    return { ok: false, reason: "receipt_corrupt", detail: `receipt_not_json:${kind}` };
  }
  const record = plainRecord(parsed);
  if (!record) return { ok: false, reason: "receipt_corrupt", detail: "receipt_not_object" };

  const kind = record.receiptKind;
  if (kind !== "pre_merge_review" && kind !== "post_merge_closure") {
    return { ok: false, reason: "receipt_corrupt", detail: "receipt_kind_invalid" };
  }
  const spec: Record<string, FieldCheck> =
    kind === "post_merge_closure" ? { ...BASE_FIELDS, ...POST_MERGE_FIELDS } : { ...BASE_FIELDS };

  const expectedKeys = Object.keys(spec).sort();
  const actualKeys = Object.keys(record).sort();
  if (expectedKeys.length !== actualKeys.length) {
    return { ok: false, reason: "receipt_corrupt", detail: "receipt_field_set_mismatch" };
  }
  for (const [index, key] of expectedKeys.entries()) {
    if (actualKeys[index] !== key) {
      return { ok: false, reason: "receipt_corrupt", detail: "receipt_field_set_mismatch" };
    }
  }
  for (const key of expectedKeys) {
    if (!spec[key](record[key])) {
      return { ok: false, reason: "receipt_corrupt", detail: `receipt_field_invalid:${key}` };
    }
  }

  const recomputed = computeReceiptDigest(record);
  if (recomputed === null) {
    return { ok: false, reason: "receipt_corrupt", detail: "receipt_not_canonicalizable" };
  }
  if (recomputed !== record.receiptDigest) {
    return { ok: false, reason: "identity_mismatch", detail: "receipt_digest_mismatch" };
  }
  return { ok: true, receipt: record as unknown as ReviewCustodyReceipt };
}

export interface CustodyPullRequestFacts {
  readonly repository: string;
  readonly prNumber: number;
  readonly baseRef: string;
  readonly headSha: string;
  readonly state: "OPEN" | "MERGED" | "CLOSED";
  readonly mergeSha: string | null;
  /** GitHub の merged_at。post-merge receipt の subject を API facts へ束縛する。 */
  readonly mergedAt: string | null;
}

export interface CustodyWorkflowRunFacts {
  readonly repository: string;
  readonly runId: string;
  readonly runAttempt: number;
  readonly workflowRef: string;
  readonly workflowSha: string;
  readonly headSha: string;
  readonly status: "queued" | "in_progress" | "completed";
  readonly conclusion:
    | "success"
    | "failure"
    | "cancelled"
    | "skipped"
    | "timed_out"
    | "action_required"
    | "neutral"
    | "stale"
    | null;
}

export interface CustodyObservations {
  /** workflow の event payload。 */
  readonly eventPayload: CustodyPullRequestFacts;
  /** 開始時の API read。 */
  readonly apiRead1: CustodyPullRequestFacts;
  /** 発行直前の API read (TOCTOU 検出用)。 */
  readonly apiRead2: CustodyPullRequestFacts;
  readonly run: CustodyWorkflowRunFacts;
}

export type ObservationStability =
  | { ok: true; facts: CustodyPullRequestFacts }
  | { ok: false; reason: "head_raced"; detail: string };

/**
 * event payload / API read 1 / API read 2 の三者一致を検査する (発行側と検証側で共有)。
 * 一致しない場合は attestation を 0 件にするため、発行前にここで止める。
 */
export function verifyObservationStability(input: {
  eventPayload: CustodyPullRequestFacts;
  apiRead1: CustodyPullRequestFacts;
  apiRead2: CustodyPullRequestFacts;
}): ObservationStability {
  if (!samePullRequestFacts(input.eventPayload, input.apiRead1)) {
    return { ok: false, reason: "head_raced", detail: "event_payload_disagrees_with_api_read_1" };
  }
  if (!samePullRequestFacts(input.apiRead1, input.apiRead2)) {
    return { ok: false, reason: "head_raced", detail: "api_read_1_disagrees_with_api_read_2" };
  }
  return { ok: true, facts: input.apiRead2 };
}

export interface CustodySubjectExpectation {
  readonly repository: string;
  readonly prNumber: number;
  readonly baseRef: string;
  readonly headSha: string;
  readonly receiptKind: ReviewCustodyReceiptKind;
  /** post-merge dispatch assertion。GitHub API の merge method facts ではない。 */
  readonly mergeMethod?: "merge" | "squash" | "rebase";
  readonly planId: string;
  readonly planRevision: string;
  readonly requestIdentity: ReviewRequestIdentity;
  readonly judgmentDigest: string;
  readonly workflowRef: string;
  readonly issuer: string;
}

export interface CustodyAuthorityInput {
  readonly attestationVerifier: GitHubAttestationVerifierPort;
  /**
   * 承認済み authority が発行した identity。本 repo に発行側の実装は無いため、
   * 実運用では現状 `null` であり、その場合 `unverified_family` で fail-close する。
   */
  readonly providerIdentity: VerifiedProviderIdentity | null;
  readonly maxVerificationAttempts?: number;
}

export interface CustodyAdmissionInput {
  /** 完成 receipt artifact の exact bytes (文字列)。artifact digest はここから導出する。 */
  readonly receiptText: string;
  /**
   * `receiptText` の出所となった artifact path。verifier port へそのまま渡す
   * (domain は読まない)。GitHub の verifier は subject を path でしか受け取らないため、
   * digest だけでは検証を発火できない。
   */
  readonly receiptPath: string;
  readonly expected: CustodySubjectExpectation;
  readonly observations: CustodyObservations;
  readonly authority: CustodyAuthorityInput;
}

/** 受理状態。CI / merge 由来の field を持たないことが D1・D2 との責務分離である。 */
export interface AdmittedCustody {
  readonly state: "custody_admitted";
  readonly repository: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly receiptKind: ReviewCustodyReceiptKind;
  readonly reviewRevision: string;
  readonly judgmentDigest: string;
  readonly receiptDigest: string;
  readonly artifactDigest: string;
  readonly workflowRef: string;
  readonly workflowSha: string;
  readonly runId: string;
  readonly runAttempt: number;
  readonly issuer: string;
  readonly reviewerFamily: ReviewCustodyFamily;
  readonly familyAuthority: string;
}

export interface RejectedCustody {
  readonly state: "custody_rejected";
  readonly reasons: readonly CustodyFailureReason[];
  readonly details: readonly string[];
}

export type CustodyDecision = AdmittedCustody | RejectedCustody;

function reject(reason: CustodyFailureReason, detail: string): RejectedCustody {
  return { state: "custody_rejected", reasons: [reason], details: [detail] };
}

function samePullRequestFacts(
  left: CustodyPullRequestFacts,
  right: CustodyPullRequestFacts,
): boolean {
  return (
    left.repository === right.repository &&
    left.prNumber === right.prNumber &&
    left.baseRef === right.baseRef &&
    left.headSha === right.headSha &&
    left.state === right.state &&
    left.mergeSha === right.mergeSha &&
    left.mergedAt === right.mergedAt
  );
}

interface SubjectMismatch {
  readonly field: string;
}

function subjectMismatches(input: {
  receipt: ReviewCustodyReceipt;
  expected: CustodySubjectExpectation;
  reviewRevision: string;
}): SubjectMismatch[] {
  const { receipt, expected } = input;
  const pairs: ReadonlyArray<readonly [string, unknown, unknown]> = [
    ["repository", receipt.repository, expected.repository],
    ["prNumber", receipt.prNumber, expected.prNumber],
    ["baseRef", receipt.baseRef, expected.baseRef],
    ["headSha", receipt.headSha, expected.headSha],
    ["receiptKind", receipt.receiptKind, expected.receiptKind],
    ["planId", receipt.planId, expected.planId],
    ["planRevision", receipt.planRevision, expected.planRevision],
    ["reviewRevision", receipt.reviewRevision, input.reviewRevision],
    ["judgmentDigest", receipt.judgmentDigest, expected.judgmentDigest],
    ["workflowRef", receipt.workflowRef, expected.workflowRef],
    ["issuer", receipt.issuer, expected.issuer],
    ...(receipt.receiptKind === "post_merge_closure"
      ? [["mergeMethod", receipt.mergeMethod, expected.mergeMethod] as const]
      : []),
  ];
  return pairs
    .filter(([, actual, wanted]) => actual !== wanted)
    .map(([field]) => ({ field: String(field) }));
}

function kindCoherenceDetail(input: {
  receipt: ReviewCustodyReceipt;
  facts: CustodyPullRequestFacts;
}): string | null {
  const { receipt, facts } = input;
  if (receipt.receiptKind === "pre_merge_review") {
    if (facts.state !== "OPEN") return "pre_merge_requires_open_pull_request";
    if (facts.mergeSha !== null) return "pre_merge_carries_merge_fact";
    return null;
  }
  if (facts.state !== "MERGED") return "post_merge_requires_merged_pull_request";
  if (
    receipt.mergeSha === undefined ||
    receipt.mergeMethod === undefined ||
    receipt.mergedAt === undefined
  ) {
    return "post_merge_missing_merge_fields";
  }
  if (facts.mergeSha !== receipt.mergeSha) return "post_merge_sha_mismatch";
  if (facts.mergedAt !== receipt.mergedAt) return "post_merge_timestamp_mismatch";
  return null;
}

function runFactsDetail(input: {
  receipt: ReviewCustodyReceipt;
  run: CustodyWorkflowRunFacts;
}): { reason: CustodyFailureReason; detail: string } | null {
  const { receipt, run } = input;
  if (
    run.repository !== receipt.repository ||
    run.runId !== receipt.runId ||
    run.runAttempt !== receipt.runAttempt ||
    run.workflowRef !== receipt.workflowRef ||
    run.workflowSha !== receipt.workflowSha
  ) {
    return { reason: "identity_mismatch", detail: "workflow_run_identity_mismatch" };
  }
  if (run.headSha !== receipt.headSha) {
    return { reason: "identity_mismatch", detail: "workflow_run_head_mismatch" };
  }
  if (run.status !== "completed" || run.conclusion !== "success") {
    return {
      reason: "provider_failed",
      detail: `workflow_run_not_successful:${run.status}:${run.conclusion ?? "none"}`,
    };
  }
  return null;
}

function attestationFactsMatch(input: {
  facts: GitHubAttestationFacts;
  receipt: ReviewCustodyReceipt;
  artifactDigest: string;
}): boolean {
  const { facts, receipt } = input;
  return (
    facts.repository === receipt.repository &&
    facts.workflowRef === receipt.workflowRef &&
    facts.workflowSha === receipt.workflowSha &&
    facts.runId === receipt.runId &&
    facts.runAttempt === receipt.runAttempt &&
    facts.issuer === receipt.issuer &&
    // 検証済み statement が対象 artifact を被覆していること。adapter 側でも選別しているが、
    // 「どの artifact に対する attestation か」の判定は domain が持つ (port を差し替えられても
    // 別 artifact の attestation が流用できない)。
    facts.subjectDigests.includes(input.artifactDigest)
  );
}

/**
 * `audit_unavailable` に限って有界 retry する。無限 retry を作らず、
 * 上限到達は成功へ丸めずに `audit_unavailable` のまま返す。
 */
async function verifyWithBoundedRetry(input: {
  verifier: GitHubAttestationVerifierPort;
  query: Parameters<GitHubAttestationVerifierPort["verify"]>[0];
  maxAttempts: number;
}): Promise<Awaited<ReturnType<GitHubAttestationVerifierPort["verify"]>>> {
  const attempts = Math.max(1, Math.trunc(input.maxAttempts));
  let last: Awaited<ReturnType<GitHubAttestationVerifierPort["verify"]>> = {
    ok: false,
    reason: "audit_unavailable",
  };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await input.verifier.verify(input.query);
    if (last.ok || last.reason !== "audit_unavailable") return last;
  }
  return last;
}

/**
 * receipt / GitHub facts / attestation / family authority の AND を評価し、
 * すべて成立したときだけ `custody_admitted` を返す。
 */
export async function admitReviewCustody(input: CustodyAdmissionInput): Promise<CustodyDecision> {
  const decoded = decodeReviewCustodyReceipt(input.receiptText);
  if (!decoded.ok) return reject(decoded.reason, decoded.detail);
  const receipt = decoded.receipt;

  const revision = computeReviewRevision(input.expected.requestIdentity);
  if (!revision.ok) return reject("identity_mismatch", "review_revision_not_canonicalizable");

  const mismatches = subjectMismatches({
    receipt,
    expected: input.expected,
    reviewRevision: revision.value,
  });
  if (mismatches.length > 0) {
    return {
      state: "custody_rejected",
      reasons: ["identity_mismatch"],
      details: mismatches.map((entry) => `subject_field_mismatch:${entry.field}`),
    };
  }

  const { eventPayload, apiRead1, apiRead2, run } = input.observations;
  const stability = verifyObservationStability({ eventPayload, apiRead1, apiRead2 });
  if (!stability.ok) return reject(stability.reason, stability.detail);
  if (
    apiRead2.repository !== receipt.repository ||
    apiRead2.prNumber !== receipt.prNumber ||
    apiRead2.baseRef !== receipt.baseRef ||
    apiRead2.headSha !== receipt.headSha
  ) {
    return reject("identity_mismatch", "pull_request_facts_disagree_with_receipt");
  }
  const kindDetail = kindCoherenceDetail({ receipt, facts: apiRead2 });
  if (kindDetail !== null) return reject("identity_mismatch", kindDetail);

  const runFailure = runFactsDetail({ receipt, run });
  if (runFailure !== null) return reject(runFailure.reason, runFailure.detail);

  if (receipt.verdict === "FLAG") {
    return reject("verdict_flagged", "judgment_verdict_flagged");
  }

  const artifactDigest = sha256Hex(input.receiptText);
  const verification = await verifyWithBoundedRetry({
    verifier: input.authority.attestationVerifier,
    query: {
      artifactDigest,
      artifactPath: input.receiptPath,
      repository: receipt.repository,
      expectedWorkflowRef: receipt.workflowRef,
      expectedIssuer: receipt.issuer,
    },
    maxAttempts: input.authority.maxVerificationAttempts ?? DEFAULT_CUSTODY_VERIFICATION_ATTEMPTS,
  });
  if (!verification.ok) return reject(verification.reason, `attestation_${verification.reason}`);
  if (!attestationFactsMatch({ facts: verification.facts, receipt, artifactDigest })) {
    return reject("signer_mismatch", "attestation_facts_disagree_with_receipt");
  }

  const identity = input.authority.providerIdentity;
  if (identity === null) {
    return reject("unverified_family", "provider_family_authority_absent");
  }
  if (
    identity.kind !== "verified_provider_identity" ||
    identity.family !== receipt.reviewerFamily ||
    identity.repository !== receipt.repository ||
    identity.prNumber !== receipt.prNumber ||
    identity.headSha !== receipt.headSha
  ) {
    return reject("unverified_family", "provider_family_identity_not_bound_to_subject");
  }

  return {
    state: "custody_admitted",
    repository: receipt.repository,
    prNumber: receipt.prNumber,
    headSha: receipt.headSha,
    receiptKind: receipt.receiptKind,
    reviewRevision: receipt.reviewRevision,
    judgmentDigest: receipt.judgmentDigest,
    receiptDigest: receipt.receiptDigest,
    artifactDigest,
    workflowRef: receipt.workflowRef,
    workflowSha: receipt.workflowSha,
    runId: receipt.runId,
    runAttempt: receipt.runAttempt,
    issuer: receipt.issuer,
    reviewerFamily: receipt.reviewerFamily,
    familyAuthority: identity.authority,
  };
}

export interface CustodyReceiptDraft {
  readonly receiptKind: ReviewCustodyReceiptKind;
  readonly repository: string;
  readonly prNumber: number;
  readonly baseRef: string;
  readonly headSha: string;
  readonly mergeSha?: string;
  readonly mergeMethod?: "merge" | "squash" | "rebase";
  readonly mergedAt?: string;
  readonly planId: string;
  readonly planRevision: string;
  readonly requestIdentity: ReviewRequestIdentity;
  readonly judgmentDigest: string;
  readonly workflowRef: string;
  readonly workflowSha: string;
  readonly runId: string;
  readonly runAttempt: number;
  readonly issuer: string;
  readonly providerEvidenceRef: string | null;
  readonly reviewerFamily: ReviewCustodyFamily;
  readonly authorFamily: ReviewCustodyFamily;
  readonly verdict: ReviewCustodyVerdict;
  readonly blockingFindingCount: number;
}

export type CustodyReceiptBuildOutcome =
  | { ok: true; receipt: ReviewCustodyReceipt; text: string; artifactDigest: string }
  | { ok: false; reason: CustodyFailureReason; detail: string; attempts: number };

/**
 * receipt を発行する。provider evidence が有界 attempt 内に得られなかった場合は
 * receipt を 0 件にし、typed `provider_failed` を返す (判定不能を PASS へ寄せない)。
 */
export function buildReviewCustodyReceipt(input: {
  draft: CustodyReceiptDraft;
  attempts: number;
}): CustodyReceiptBuildOutcome {
  const attempts = Math.max(1, Math.trunc(input.attempts));
  if (input.draft.providerEvidenceRef === null) {
    return {
      ok: false,
      reason: "provider_failed",
      detail: "provider_evidence_absent_after_bounded_attempts",
      attempts,
    };
  }
  const revision = computeReviewRevision(input.draft.requestIdentity);
  if (!revision.ok) {
    return {
      ok: false,
      reason: "identity_mismatch",
      detail: "review_revision_not_canonicalizable",
      attempts,
    };
  }
  const base: Record<string, unknown> = {
    schemaVersion: REVIEW_CUSTODY_SCHEMA_VERSION,
    receiptKind: input.draft.receiptKind,
    repository: input.draft.repository,
    prNumber: input.draft.prNumber,
    baseRef: input.draft.baseRef,
    headSha: input.draft.headSha,
    planId: input.draft.planId,
    planRevision: input.draft.planRevision,
    reviewRevision: revision.value,
    judgmentDigest: input.draft.judgmentDigest,
    workflowRef: input.draft.workflowRef,
    workflowSha: input.draft.workflowSha,
    runId: input.draft.runId,
    runAttempt: input.draft.runAttempt,
    issuer: input.draft.issuer,
    providerEvidenceRef: input.draft.providerEvidenceRef,
    reviewerFamily: input.draft.reviewerFamily,
    authorFamily: input.draft.authorFamily,
    verdict: input.draft.verdict,
    blockingFindingCount: input.draft.blockingFindingCount,
  };
  if (input.draft.receiptKind === "post_merge_closure") {
    // undefined を key ごと落とすことで、欠落は canonicalize ではなく strict decode の
    // `receipt_field_set_mismatch` として typed に露出する。
    if (input.draft.mergeSha !== undefined) base.mergeSha = input.draft.mergeSha;
    if (input.draft.mergeMethod !== undefined) base.mergeMethod = input.draft.mergeMethod;
    if (input.draft.mergedAt !== undefined) base.mergedAt = input.draft.mergedAt;
  }
  const receiptDigest = computeReceiptDigest(base);
  if (receiptDigest === null) {
    return {
      ok: false,
      reason: "receipt_corrupt",
      detail: "receipt_not_canonicalizable",
      attempts,
    };
  }
  const complete = { ...base, receiptDigest };
  const canonical = canonicalize(complete);
  if (!canonical.ok) {
    return {
      ok: false,
      reason: "receipt_corrupt",
      detail: "receipt_not_canonicalizable",
      attempts,
    };
  }
  const decoded = decodeReviewCustodyReceipt(canonical.value);
  if (!decoded.ok) {
    return { ok: false, reason: decoded.reason, detail: decoded.detail, attempts };
  }
  return {
    ok: true,
    receipt: decoded.receipt,
    text: canonical.value,
    artifactDigest: sha256Hex(canonical.value),
  };
}
