import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { loadProjectIdentityFromHead } from "../kernel/project-identity.ts";
import { FileProviderJudgmentEvidenceAdapter } from "./adapters/provider-judgment-evidence.ts";
import type { ProviderJudgmentAttemptIdentity } from "./ports/provider-judgment-evidence.ts";
import { type ProviderJudgmentResult, produceProviderJudgment } from "./provider-judgment.ts";
import {
  isValidReviewRequest,
  type ReviewAttestationRequest as PersistedReviewRequest,
} from "./review-attestation.ts";
import { type CanonicalValue, canonicalize, sha256Hex } from "./review-custody-canonical.ts";
import type { ReviewReceipt } from "./review-dispatch.ts";
import {
  isAttemptCompletedEvent,
  isReviewDigest,
  isReviewProvider,
  type ReviewCustodyAuditEvent,
  readReviewCustodyAudit,
  reviewIdentityDigest,
  reviewVerdictPath,
} from "./review-verdict-custody.ts";

const REQUEST_KEYS = [
  "authorFamily",
  "exactHead",
  "invocationNonce",
  "memoryId",
  "pr",
  "requestedAt",
  "reviewRevision",
] as const;
const RECEIPT_KEYS = [
  "at",
  "blockingFindings",
  "head",
  "kind",
  "memoryId",
  "pr",
  "reviewRevision",
  "reviewerFamily",
  "verdict",
] as const;
const COMPLETED_KEYS = [
  "attempt",
  "exactHead",
  "exitCode",
  "kind",
  "model",
  "provider",
  "reason",
  "receiptFileDigest",
  "recordedAt",
  "requestDigest",
  "verdictDigest",
  "verdictPath",
] as const;
const HEAD = /^[0-9a-f]{40}$/;

export interface ComposeProviderJudgmentRequest {
  readonly repoRoot: string;
  readonly requestDigest: string;
  readonly attempt: number;
}

export type ProviderJudgmentCompositionFailure =
  | "request_unavailable"
  | "receipt_unavailable"
  | "identity_mismatch"
  | "invocation_fact_unavailable"
  | "invocation_fact_ambiguous"
  | "invocation_fact_schema_invalid"
  | "evidence_superseded"
  | "receipt_mutated"
  | "evidence_schema_invalid"
  | "evidence_conflict"
  | "artifact_verification_failed"
  | "evidence_unavailable"
  | "provider_failure"
  | "same_family_reviewer"
  | "judgment_schema_invalid"
  | "judgment_write_failed"
  | "judgment_conflict";

export type ProviderJudgmentCompositionResult =
  | {
      readonly ok: true;
      readonly judgmentDigest: string;
      readonly providerEvidenceRef: `d3b:${string}`;
      readonly artifactPath: string;
      readonly replay: boolean;
    }
  | { readonly ok: false; readonly reason: ProviderJudgmentCompositionFailure };

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function opposite(family: "codex" | "claude"): "codex" | "claude" {
  return family === "codex" ? "claude" : "codex";
}

function requestPath(repoRoot: string, requestDigest: string): string {
  return join(resolve(repoRoot), ".ut-tdd", "review", "requests", `${requestDigest}.json`);
}

function receiptPath(repoRoot: string, requestDigest: string): string {
  return join(resolve(repoRoot), ".ut-tdd", "review", "receipts", `${requestDigest}.json`);
}

function evidencePath(repoRoot: string, requestDigest: string, attempt: number): string {
  return join(
    resolve(repoRoot),
    ".ut-tdd",
    "review",
    "evidence",
    requestDigest,
    "attempts",
    `attempt-${attempt}`,
    "evidence.json",
  );
}

function judgmentPath(repoRoot: string, judgmentDigest: string): string {
  return join(resolve(repoRoot), ".ut-tdd", "review", "judgments", `${judgmentDigest}.json`);
}

function readJson(path: string): unknown | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function validRequest(value: unknown, requestDigest: string): value is PersistedReviewRequest {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exactKeys(value, REQUEST_KEYS)
  )
    return false;
  const request = value as PersistedReviewRequest;
  return (
    isValidReviewRequest(request) &&
    isStrictRequest(request) &&
    requestDigest === reviewIdentityDigest(request) &&
    isReviewDigest(requestDigest) &&
    typeof request.invocationNonce === "string" &&
    request.invocationNonce.trim().length > 0
  );
}

function isStrictRequest(request: PersistedReviewRequest): boolean {
  const revision = request.reviewRevision;
  return revision.startsWith("rv1-") && revision.slice(4) === reviewIdentityDigest(request);
}

function validReceipt(value: unknown): value is ReviewReceipt {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (!exactKeys(value, RECEIPT_KEYS)) return false;
  const receipt = value as ReviewReceipt;
  return (
    typeof receipt.memoryId === "string" &&
    Number.isSafeInteger(receipt.pr) &&
    receipt.pr > 0 &&
    HEAD.test(receipt.head) &&
    typeof receipt.reviewRevision === "string" &&
    isReviewProvider(receipt.reviewerFamily) &&
    receipt.kind === "verdict" &&
    (receipt.verdict === "PASS" || receipt.verdict === "PASS-WEAK" || receipt.verdict === "FLAG") &&
    Array.isArray(receipt.blockingFindings) &&
    // Finding shape (trim / duplicates) is judged by deriveReceiptFindings as
    // evidence_schema_invalid; here only the receipt document schema is checked.
    receipt.blockingFindings.every((finding) => typeof finding === "string") &&
    typeof receipt.at === "string"
  );
}

function completedEventStatus(input: {
  event: ReviewCustodyAuditEvent;
  repoRoot: string;
  requestDigest: string;
  request: PersistedReviewRequest;
  attempt: number;
}): "valid" | "schema" | "identity" {
  const { event, repoRoot, requestDigest, request, attempt } = input;
  if (event.kind !== "attempt_completed") return "identity";
  if (!exactKeys(event, COMPLETED_KEYS)) return "schema";
  if (!isAttemptCompletedEvent(event)) return "schema";
  if (
    event.requestDigest !== requestDigest ||
    event.attempt !== attempt ||
    event.exactHead !== request.exactHead ||
    event.verdictPath !== reviewVerdictPath(repoRoot, requestDigest, attempt)
  )
    return "identity";
  return "valid";
}

function mapProducerFailure(
  result: Extract<ProviderJudgmentResult, { ok: false }>,
): ProviderJudgmentCompositionResult {
  return result;
}

function writeEvidenceEnvelope(input: {
  path: string;
  identity: ProviderJudgmentAttemptIdentity;
  provider: "codex" | "claude";
  model: string;
  receipt: ReviewReceipt;
  findings: readonly string[];
}): { ok: true; created: boolean } | { ok: false; reason: ProviderJudgmentCompositionFailure } {
  const { path, identity, provider, model, receipt, findings } = input;
  const envelope = {
    schema_version: "d3b-provider-evidence-envelope/v1",
    identity,
    provider,
    model,
    evidence_base64: Buffer.from(
      `${JSON.stringify({
        schema_version: "provider-judgment-evidence/v1",
        verdict: receipt.verdict,
        // Sorted ascending by deriveReceiptFindings (§3.1); duplicates were denied there.
        blocking_findings: [...findings],
      })}\n`,
      "utf8",
    ).toString("base64"),
  };
  const bytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  try {
    mkdirSync(dirname(path), { recursive: true });
    const existing = existsSync(path) ? readFileSync(path) : undefined;
    if (existing)
      return existing.equals(bytes)
        ? { ok: true, created: false }
        : { ok: false, reason: "evidence_conflict" };
    writeFileSync(path, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return { ok: true, created: true };
  } catch {
    try {
      const existing = readFileSync(path);
      return existing.equals(bytes)
        ? { ok: true, created: false }
        : { ok: false, reason: "evidence_conflict" };
    } catch {
      return { ok: false, reason: "judgment_write_failed" };
    }
  }
}

/**
 * PLAN-L7-534 §3.1: the evidence document is derived from the receipt only. Findings
 * are sorted ascending; a duplicate or malformed finding is `evidence_schema_invalid`
 * (never silently deduplicated). Verdict / findings consistency is the producer's
 * check and its `judgment_schema_invalid` passes through unchanged (-008).
 */
function deriveReceiptFindings(
  receipt: ReviewReceipt,
): { ok: true; findings: string[] } | { ok: false; reason: "evidence_schema_invalid" } {
  const findings = receipt.blockingFindings ?? [];
  if (!findings.every((finding) => typeof finding === "string" && finding.trim() === finding))
    return { ok: false, reason: "evidence_schema_invalid" };
  if (new Set(findings).size !== findings.length)
    return { ok: false, reason: "evidence_schema_invalid" };
  return { ok: true, findings: [...findings].sort() };
}

function verifyJudgmentArtifact(input: {
  artifactPath: string;
  produced: Extract<ProviderJudgmentResult, { ok: true }>;
  identity: ProviderJudgmentAttemptIdentity;
  provider: "codex" | "claude";
  model: string;
  expectedProvider: "codex" | "claude";
}): boolean {
  const { artifactPath, produced, identity, provider, model, expectedProvider } = input;
  let artifactBytes: Buffer;
  try {
    artifactBytes = readFileSync(artifactPath);
  } catch {
    return false;
  }
  const payload = produced.payload;
  const canonical = canonicalize(payload as unknown as CanonicalValue);
  if (!canonical.ok) return false;
  const recomputedDigest = sha256Hex(canonical.value);
  return (
    recomputedDigest === produced.judgmentDigest &&
    basename(artifactPath) === `${recomputedDigest}.json` &&
    produced.providerEvidenceRef === `d3b:${recomputedDigest}` &&
    Buffer.from(`${canonical.value}\n`, "utf8").equals(artifactBytes) &&
    Buffer.from(produced.artifactBytes).equals(artifactBytes) &&
    payload.repository === identity.repository &&
    payload.pr_number === identity.prNumber &&
    payload.head_sha === identity.headSha &&
    payload.request_memory_id === identity.requestMemoryId &&
    payload.request_digest === identity.requestDigest &&
    payload.review_revision === identity.reviewRevision &&
    payload.attempt === identity.attempt &&
    payload.author_family === identity.authorFamily &&
    payload.reviewer_family === expectedProvider &&
    payload.invocation_nonce === identity.invocationNonce &&
    payload.provider === provider &&
    payload.model === model
  );
}

/** Compose only from custody files and the verified invocation event. */
export async function composeProviderJudgment(
  input: ComposeProviderJudgmentRequest,
): Promise<ProviderJudgmentCompositionResult> {
  if (
    !input ||
    typeof input !== "object" ||
    !exactKeys(input, ["attempt", "repoRoot", "requestDigest"]) ||
    typeof input.repoRoot !== "string" ||
    !isReviewDigest(input.requestDigest) ||
    !Number.isSafeInteger(input.attempt) ||
    input.attempt < 1
  )
    return { ok: false, reason: "identity_mismatch" };
  const requestValue = readJson(requestPath(input.repoRoot, input.requestDigest));
  if (!validRequest(requestValue, input.requestDigest))
    return { ok: false, reason: "request_unavailable" };
  const request = requestValue;
  const project = loadProjectIdentityFromHead({ repoRoot: input.repoRoot });
  if (!project.ok) return { ok: false, reason: "request_unavailable" };
  // Read the receipt bytes exactly once: the same Buffer is hash-checked against
  // attempt_completed.receiptFileDigest below and parsed into the evidence document,
  // so a swap between two reads cannot compose from unverified content.
  let receiptBytes: Buffer;
  try {
    receiptBytes = readFileSync(receiptPath(input.repoRoot, input.requestDigest));
  } catch {
    return { ok: false, reason: "receipt_unavailable" };
  }
  let rawReceipt: unknown;
  try {
    rawReceipt = JSON.parse(receiptBytes.toString("utf8")) as unknown;
  } catch {
    return { ok: false, reason: "receipt_unavailable" };
  }
  if (!validReceipt(rawReceipt)) return { ok: false, reason: "receipt_unavailable" };
  const receipt = rawReceipt;
  if (
    receipt.memoryId !== request.memoryId ||
    receipt.pr !== request.pr ||
    receipt.head !== request.exactHead ||
    receipt.reviewRevision !== request.reviewRevision
  )
    return { ok: false, reason: "identity_mismatch" };
  const derived = deriveReceiptFindings(receipt);
  if (!derived.ok) return { ok: false, reason: derived.reason };
  let events: ReviewCustodyAuditEvent[];
  try {
    // Keep every event of the request: a superseded_attempt that targets this
    // attempt is recorded under the *next* attempt number (§3.2 (iv)).
    events = readReviewCustodyAudit(input.repoRoot).filter(
      (event) =>
        event.requestDigest === input.requestDigest &&
        (event.attempt === input.attempt ||
          // -021(c): an attempt_completed whose attempt field drifted away from the
          // verdictPath it names still belongs to this attempt's identity check.
          (event.kind === "attempt_completed" &&
            event.verdictPath ===
              reviewVerdictPath(input.repoRoot, input.requestDigest, input.attempt)) ||
          (event.kind === "superseded_attempt" && event.supersededAttempt === input.attempt)),
    );
  } catch {
    return { ok: false, reason: "invocation_fact_unavailable" };
  }
  const completed = events.filter((event) => event.kind === "attempt_completed");
  const statuses = completed.map((event) =>
    completedEventStatus({
      event,
      repoRoot: input.repoRoot,
      requestDigest: input.requestDigest,
      request,
      attempt: input.attempt,
    }),
  );
  if (statuses.some((status) => status === "schema"))
    return { ok: false, reason: "invocation_fact_schema_invalid" };
  if (statuses.some((status) => status === "identity"))
    return { ok: false, reason: "identity_mismatch" };
  if (completed.length === 0) return { ok: false, reason: "invocation_fact_unavailable" };
  if (completed.length !== 1) return { ok: false, reason: "invocation_fact_ambiguous" };
  const event = completed[0];
  if (
    events.some(
      (candidate) =>
        (candidate.kind === "superseded_attempt" &&
          candidate.supersededAttempt === input.attempt) ||
        (candidate.kind === "attempt_outcome_conflict" && candidate.attempt === input.attempt),
    )
  )
    return { ok: false, reason: "evidence_superseded" };
  if (digest(receiptBytes) !== event.receiptFileDigest)
    return { ok: false, reason: "receipt_mutated" };
  const provider = event.provider as "codex" | "claude";
  const expectedProvider = opposite(request.authorFamily);
  if (provider === request.authorFamily) return { ok: false, reason: "same_family_reviewer" };
  if (provider !== expectedProvider) return { ok: false, reason: "identity_mismatch" };
  const identity: ProviderJudgmentAttemptIdentity = {
    repository: project.value.repositoryIdentity,
    prNumber: request.pr,
    headSha: request.exactHead,
    requestMemoryId: request.memoryId,
    requestDigest: input.requestDigest,
    reviewRevision: request.reviewRevision,
    attempt: input.attempt,
    authorFamily: request.authorFamily,
    invocationNonce: request.invocationNonce as string,
  };
  const evidence = evidencePath(input.repoRoot, input.requestDigest, input.attempt);
  const envelope = writeEvidenceEnvelope({
    path: evidence,
    identity,
    provider,
    model: event.model as string,
    receipt,
    findings: derived.findings,
  });
  if (!envelope.ok) return envelope;
  let produced: ProviderJudgmentResult;
  try {
    produced = await produceProviderJudgment({
      attempt: identity,
      port: new FileProviderJudgmentEvidenceAdapter({
        evidenceRoot: join(resolve(input.repoRoot), ".ut-tdd", "review", "evidence"),
        judgmentsRoot: join(resolve(input.repoRoot), ".ut-tdd", "review", "judgments"),
        verifiedInvocation: { ...identity, provider, model: event.model as string },
      }),
    });
  } catch {
    if (envelope.created) rmSync(evidence, { force: true });
    return { ok: false, reason: "provider_failure" };
  }
  if (!produced.ok) {
    if (envelope.created) rmSync(evidence, { force: true });
    return mapProducerFailure(produced);
  }
  const artifactPath = judgmentPath(input.repoRoot, produced.judgmentDigest);
  // §3.3: re-read the artifact and verify it against values the composition derived
  // itself — JCS recomputation of the payload digest (PLAN-L7-562 rule), the file
  // name, canonical bytes, and the full identity including attempt, nonce, provider
  // and model (the identity digest alone omits those four). A failure leaves no
  // artifact behind (-009).
  const verified = verifyJudgmentArtifact({
    artifactPath,
    produced,
    identity,
    provider,
    model: event.model as string,
    expectedProvider,
  });
  if (!verified) {
    rmSync(artifactPath, { force: true });
    if (envelope.created) rmSync(evidence, { force: true });
    return { ok: false, reason: "artifact_verification_failed" };
  }
  return {
    ok: true,
    judgmentDigest: produced.judgmentDigest,
    providerEvidenceRef: produced.providerEvidenceRef,
    artifactPath,
    replay: produced.replay,
  };
}
