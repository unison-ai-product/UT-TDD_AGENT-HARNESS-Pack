import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";
import type {
  ClaudeProviderReviewInboxEntry,
  ClaudeReviewInboxEntry,
} from "../runtime/claude-memory-wake.ts";

type ClaudeReviewEnvelopeEntry = ClaudeReviewInboxEntry | ClaudeProviderReviewInboxEntry;

import type {
  ReviewAttestation,
  ReviewAttestationRequest,
  ReviewRequestResult,
  ReviewVerdictProjectionResult,
} from "./review-attestation.ts";
import { isValidReviewRequest, reviewRequestDigest } from "./review-attestation.ts";

export type ReviewProvider = "codex" | "claude";

export type LiveReviewWakeRoutingFailure =
  | "no_live_claude_workspace"
  | "ambiguous_live_claude_workspace"
  | "stale_claude_workspace"
  | "incompatible_claude_workspace_schema"
  | "codex_review_wake_unavailable";

export class LiveReviewWakeError extends Error {
  readonly reason: LiveReviewWakeRoutingFailure;

  constructor(reason: LiveReviewWakeRoutingFailure) {
    super(reason);
    this.name = "LiveReviewWakeError";
    this.reason = reason;
  }
}

export interface LiveReviewRequestInput extends ReviewAttestationRequest {
  readonly memoryPath: string;
}

export interface CanonicalReviewWake {
  readonly purpose: "review";
  readonly reviewer: ReviewProvider;
  readonly requestDigest: string;
  readonly requestPath: string;
  readonly request: ReviewAttestationRequest;
  readonly memoryPath: string;
}

export interface LiveReviewProjectionPorts {
  readonly validateSubject: (input: { repoRoot: string; pr: number; exactHead: string }) =>
    | { readonly ok: true }
    | {
        readonly ok: false;
        readonly reason:
          | "exact_head_not_found"
          | "pull_request_head_unavailable"
          | "pull_request_head_mismatch";
      };
  readonly issueRequest: (input: {
    repoRoot: string;
    request: ReviewAttestationRequest;
    strict?: boolean;
  }) => ReviewRequestResult;
  readonly publishReviewWake: (wake: CanonicalReviewWake) => void;
  readonly providerAvailable: (provider: ReviewProvider) => boolean;
}

export type LiveReviewDispatchResult =
  | {
      readonly ok: true;
      readonly reviewer: ReviewProvider;
      readonly request: Extract<ReviewRequestResult, { ok: true }>;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly backlog?: {
        readonly requestDigest: string;
        readonly requestPath: string;
      };
    };

export interface LiveReviewVerdictPorts {
  readonly projectVerdict: (input: {
    repoRoot: string;
    request: ReviewAttestationRequest;
    attestation: ReviewAttestation;
    verdictFile: string;
  }) => ReviewVerdictProjectionResult;
  readonly publishPrComment: (
    receipt: Extract<ReviewVerdictProjectionResult, { ok: true }>,
  ) => void;
  readonly publishFeedbackMemory: (
    receipt: Extract<ReviewVerdictProjectionResult, { ok: true }>,
  ) => void;
}

export type LiveReviewVerdictResult =
  | {
      readonly ok: true;
      readonly projection: Extract<ReviewVerdictProjectionResult, { ok: true }>;
    }
  | { readonly ok: false; readonly reason: string };

export interface LiveReviewConsumerPorts {
  readonly providerAvailable: (provider: ReviewProvider) => boolean;
  readonly resolveTaskFile: (input: { memoryId: string; memoryPath: string }) => string | null;
  readonly runReview: (input: {
    provider: ReviewProvider;
    args: readonly string[];
  }) => ReviewVerdictProjectionResult;
  readonly publishReceipt: (receipt: Extract<ReviewVerdictProjectionResult, { ok: true }>) => void;
}

export function oppositeReviewProvider(authorFamily: unknown): ReviewProvider | null {
  if (authorFamily === "codex") return "claude";
  if (authorFamily === "claude") return "codex";
  return null;
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/** Load only the canonical request named by the v3 envelope; never infer identity from task prose. */
export function loadCanonicalLiveReviewRequest(input: {
  repoRoot: string;
  envelope: ClaudeReviewEnvelopeEntry;
}): ReviewAttestationRequest | null {
  const canonical = resolve(
    input.repoRoot,
    ".ut-tdd",
    "review",
    "requests",
    `${input.envelope.requestDigest}.json`,
  );
  const supplied = isAbsolute(input.envelope.requestPath)
    ? resolve(input.envelope.requestPath)
    : resolve(input.repoRoot, input.envelope.requestPath);
  if (normalize(supplied) !== normalize(canonical)) return null;
  try {
    const requestFile = lstatSync(canonical);
    if (!requestFile.isFile() || requestFile.isSymbolicLink()) return null;
    const parsed = JSON.parse(readFileSync(canonical, "utf8")) as Record<string, unknown>;
    if (
      !parsed ||
      Array.isArray(parsed) ||
      !exactKeys(parsed, [
        "memoryId",
        "pr",
        "exactHead",
        "reviewRevision",
        "authorFamily",
        "requestedAt",
        "invocationNonce",
      ])
    )
      return null;
    const request = parsed as unknown as ReviewAttestationRequest;
    if (!isValidReviewRequest(request) || !request.invocationNonce) return null;
    if (reviewRequestDigest(request) !== input.envelope.requestDigest) return null;
    if (
      request.memoryId !== input.envelope.memoryId ||
      request.pr !== input.envelope.pr ||
      request.exactHead !== input.envelope.exactHead ||
      request.reviewRevision !== input.envelope.reviewRevision ||
      request.authorFamily !== input.envelope.authorFamily
    )
      return null;
    return request;
  } catch {
    return null;
  }
}

export function consumeLiveReview(input: {
  repoRoot: string;
  envelope: ClaudeReviewEnvelopeEntry;
  ports: LiveReviewConsumerPorts;
}): LiveReviewVerdictResult {
  const request = loadCanonicalLiveReviewRequest(input);
  if (!request) return { ok: false, reason: "invalid_review_envelope" };
  const reviewer = oppositeReviewProvider(request.authorFamily);
  if (!reviewer) return { ok: false, reason: "unknown_author_family" };
  if (!input.ports.providerAvailable(reviewer)) {
    return { ok: false, reason: "opposite_provider_unavailable" };
  }
  const memoryPath = input.ports.resolveTaskFile({
    memoryId: request.memoryId,
    memoryPath: input.envelope.memoryPath,
  });
  if (!memoryPath) return { ok: false, reason: "invalid_review_envelope" };
  const projection = input.ports.runReview({
    provider: reviewer,
    args: [
      "--role",
      "blind-reviewer",
      "--task-file",
      memoryPath,
      "--review-pr",
      String(request.pr),
      "--review-head",
      request.exactHead,
      "--review-revision",
      request.reviewRevision,
      "--review-author-family",
      request.authorFamily,
      "--review-memory-id",
      request.memoryId,
      "--execute",
      "--json",
    ],
  });
  if (!projection.ok) return projection;
  if (
    projection.receipt.memoryId !== request.memoryId ||
    projection.receipt.pr !== request.pr ||
    projection.receipt.head !== request.exactHead ||
    projection.receipt.reviewRevision !== request.reviewRevision ||
    projection.receipt.reviewerFamily !== reviewer
  )
    return { ok: false, reason: "review_identity_mismatch" };
  try {
    input.ports.publishReceipt(projection);
  } catch {
    return { ok: false, reason: "derived_verdict_publish_failed" };
  }
  return { ok: true, projection };
}

/** Canonical request is persisted before its typed, derived wake is published. */
export function dispatchLiveReview(input: {
  readonly repoRoot: string;
  readonly request: LiveReviewRequestInput;
  readonly ports: LiveReviewProjectionPorts;
}): LiveReviewDispatchResult {
  const reviewer = oppositeReviewProvider(input.request.authorFamily);
  if (!reviewer) return { ok: false, reason: "unknown_author_family" };
  if (!input.ports.providerAvailable(reviewer)) {
    return { ok: false, reason: "opposite_provider_unavailable" };
  }

  const subject = input.ports.validateSubject({
    repoRoot: input.repoRoot,
    pr: input.request.pr,
    exactHead: input.request.exactHead,
  });
  if (!subject.ok) return subject;

  const { memoryPath, ...request } = input.request;
  const issued = input.ports.issueRequest({ repoRoot: input.repoRoot, request, strict: true });
  if (!issued.ok) return issued;

  try {
    input.ports.publishReviewWake({
      purpose: "review",
      reviewer,
      requestDigest: issued.digest,
      requestPath: issued.path,
      request: issued.request,
      memoryPath,
    });
  } catch (error) {
    if (error instanceof LiveReviewWakeError) {
      return {
        ok: false,
        reason: error.reason,
        backlog: {
          requestDigest: issued.digest,
          requestPath: issued.path,
        },
      };
    }
    return { ok: false, reason: "review_wake_publish_failed" };
  }
  return { ok: true, reviewer, request: issued };
}

/** Canonical receipt is persisted before any human-facing projection is published. */
export function publishLiveReviewVerdict(input: {
  readonly repoRoot: string;
  readonly request: ReviewAttestationRequest;
  readonly attestation: ReviewAttestation;
  readonly verdictFile: string;
  readonly ports: LiveReviewVerdictPorts;
}): LiveReviewVerdictResult {
  const expectedReviewer = oppositeReviewProvider(input.request.authorFamily);
  if (!expectedReviewer) return { ok: false, reason: "unknown_author_family" };
  if (input.attestation.provider !== expectedReviewer) {
    return { ok: false, reason: "same_family_reviewer_denied" };
  }

  const projected = input.ports.projectVerdict({
    repoRoot: input.repoRoot,
    request: input.request,
    attestation: input.attestation,
    verdictFile: input.verdictFile,
  });
  if (!projected.ok) return projected;

  try {
    input.ports.publishPrComment(projected);
    input.ports.publishFeedbackMemory(projected);
  } catch {
    return { ok: false, reason: "derived_verdict_publish_failed" };
  }
  return { ok: true, projection: projected };
}
