import type {
  ProviderEvidenceReadResult,
  ProviderFamily,
  ProviderJudgmentAttemptIdentity,
  ProviderJudgmentEvidencePort,
  ProviderJudgmentWriteResult,
} from "./ports/provider-judgment-evidence.ts";
import {
  type CanonicalValue,
  canonicalize,
  sha256Hex,
  sha256HexOfBytes,
} from "./review-custody-canonical.ts";

const HEAD = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const REVISION = /^rv1-[0-9a-f]{64}$/;
const REPOSITORY = /^[^/\s]+\/[^/\s]+$/;
const INPUT_KEYS = ["attempt", "port"] as const;
const EVIDENCE_KEYS = ["blocking_findings", "schema_version", "verdict"] as const;

type Verdict = "PASS" | "PASS-WEAK" | "FLAG";

interface ProviderEvidenceDocument {
  readonly schema_version: "provider-judgment-evidence/v1";
  readonly verdict: Verdict;
  readonly blocking_findings: readonly string[];
}

export interface ProviderJudgmentPayload {
  readonly schema_version: "d3b.v1";
  readonly kind: "provider_judgment";
  readonly repository: string;
  readonly pr_number: number;
  readonly head_sha: string;
  readonly request_memory_id: string;
  readonly request_digest: string;
  readonly review_revision: string;
  readonly attempt: number;
  readonly provider: ProviderFamily;
  readonly model: string;
  readonly author_family: ProviderFamily;
  readonly reviewer_family: ProviderFamily;
  readonly invocation_nonce: string;
  readonly verdict: Verdict;
  readonly blocking_findings: readonly string[];
  readonly evidence_digest: string;
}

export type ProviderJudgmentFailureReason =
  | "evidence_unavailable"
  | "evidence_superseded"
  | "provider_failure"
  | "identity_mismatch"
  | "same_family_reviewer"
  | "judgment_schema_invalid"
  | "judgment_write_failed"
  | "judgment_conflict";

export type ProviderJudgmentResult =
  | {
      readonly ok: true;
      readonly judgmentDigest: string;
      readonly providerEvidenceRef: `d3b:${string}`;
      readonly payload: ProviderJudgmentPayload;
      readonly artifactBytes: Uint8Array;
      readonly replay: boolean;
    }
  | { readonly ok: false; readonly reason: ProviderJudgmentFailureReason };

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function validIdentity(value: ProviderJudgmentAttemptIdentity): boolean {
  return (
    hasExactKeys(value, [
      "attempt",
      "authorFamily",
      "headSha",
      "invocationNonce",
      "prNumber",
      "repository",
      "requestDigest",
      "requestMemoryId",
      "reviewRevision",
    ]) &&
    REPOSITORY.test(value.repository) &&
    Number.isSafeInteger(value.prNumber) &&
    value.prNumber > 0 &&
    HEAD.test(value.headSha) &&
    isText(value.requestMemoryId) &&
    DIGEST.test(value.requestDigest) &&
    REVISION.test(value.reviewRevision) &&
    Number.isSafeInteger(value.attempt) &&
    value.attempt > 0 &&
    (value.authorFamily === "claude" || value.authorFamily === "codex") &&
    isText(value.invocationNonce)
  );
}

function sameIdentity(
  left: ProviderJudgmentAttemptIdentity,
  right: ProviderJudgmentAttemptIdentity,
): boolean {
  return (Object.keys(left) as (keyof ProviderJudgmentAttemptIdentity)[]).every(
    (key) => left[key] === right[key],
  );
}

function decodeEvidence(bytes: Uint8Array): ProviderEvidenceDocument | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (!hasExactKeys(value, EVIDENCE_KEYS)) return null;
  const record = value as Record<string, unknown>;
  if (record.schema_version !== "provider-judgment-evidence/v1") return null;
  if (record.verdict !== "PASS" && record.verdict !== "PASS-WEAK" && record.verdict !== "FLAG") {
    return null;
  }
  if (!Array.isArray(record.blocking_findings)) return null;
  const findings = record.blocking_findings;
  if (!findings.every(isText) || new Set(findings).size !== findings.length) return null;
  if (findings.some((entry, index) => index > 0 && findings[index - 1] >= entry)) return null;
  if (record.verdict === "FLAG" ? findings.length === 0 : findings.length !== 0) return null;
  return record as unknown as ProviderEvidenceDocument;
}

function opposite(family: ProviderFamily): ProviderFamily {
  return family === "codex" ? "claude" : "codex";
}

export function providerJudgmentIdentityDigest(payload: ProviderJudgmentPayload): string | null {
  const identity = canonicalize({
    schema_version: payload.schema_version,
    kind: payload.kind,
    repository: payload.repository,
    pr_number: payload.pr_number,
    head_sha: payload.head_sha,
    request_memory_id: payload.request_memory_id,
    request_digest: payload.request_digest,
    review_revision: payload.review_revision,
    author_family: payload.author_family,
    reviewer_family: payload.reviewer_family,
  });
  return identity.ok ? sha256Hex(identity.value) : null;
}

export async function produceProviderJudgment(input: {
  readonly attempt: ProviderJudgmentAttemptIdentity;
  readonly port: ProviderJudgmentEvidencePort;
}): Promise<ProviderJudgmentResult> {
  if (!hasExactKeys(input, INPUT_KEYS) || !validIdentity(input.attempt)) {
    return { ok: false, reason: "identity_mismatch" };
  }
  let read: ProviderEvidenceReadResult;
  try {
    read = await input.port.read(input.attempt);
  } catch {
    return { ok: false, reason: "provider_failure" };
  }
  if (read.status === "missing") return { ok: false, reason: "evidence_unavailable" };
  if (read.status === "superseded") return { ok: false, reason: "evidence_superseded" };
  if (read.status === "provider_failure") return { ok: false, reason: "provider_failure" };
  if (read.status !== "available") return { ok: false, reason: "provider_failure" };
  if (!validIdentity(read.identity) || !sameIdentity(input.attempt, read.identity)) {
    return { ok: false, reason: "identity_mismatch" };
  }
  const reviewerFamily = opposite(input.attempt.authorFamily);
  if (read.provider === input.attempt.authorFamily) {
    return { ok: false, reason: "same_family_reviewer" };
  }
  if (read.provider !== reviewerFamily || !isText(read.model)) {
    return { ok: false, reason: "identity_mismatch" };
  }
  const evidence = decodeEvidence(read.bytes);
  if (evidence === null) return { ok: false, reason: "judgment_schema_invalid" };
  const payload: ProviderJudgmentPayload = {
    schema_version: "d3b.v1",
    kind: "provider_judgment",
    repository: input.attempt.repository,
    pr_number: input.attempt.prNumber,
    head_sha: input.attempt.headSha,
    request_memory_id: input.attempt.requestMemoryId,
    request_digest: input.attempt.requestDigest,
    review_revision: input.attempt.reviewRevision,
    attempt: input.attempt.attempt,
    provider: read.provider,
    model: read.model,
    author_family: input.attempt.authorFamily,
    reviewer_family: reviewerFamily,
    invocation_nonce: input.attempt.invocationNonce,
    verdict: evidence.verdict,
    blocking_findings: evidence.blocking_findings,
    evidence_digest: sha256HexOfBytes(read.bytes),
  };
  const canonical = canonicalize(payload as unknown as CanonicalValue);
  const identityDigest = providerJudgmentIdentityDigest(payload);
  if (!canonical.ok || identityDigest === null) {
    return { ok: false, reason: "judgment_schema_invalid" };
  }
  const judgmentDigest = sha256Hex(canonical.value);
  const artifactBytes = new TextEncoder().encode(`${canonical.value}\n`);
  let write: ProviderJudgmentWriteResult;
  try {
    write = await input.port.write({ identityDigest, judgmentDigest, bytes: artifactBytes });
  } catch {
    return { ok: false, reason: "judgment_write_failed" };
  }
  if (write.status === "conflict") return { ok: false, reason: "judgment_conflict" };
  if (write.status === "failed") return { ok: false, reason: "judgment_write_failed" };
  return {
    ok: true,
    judgmentDigest,
    providerEvidenceRef: `d3b:${judgmentDigest}`,
    payload,
    artifactBytes,
    replay: write.status === "replay",
  };
}
