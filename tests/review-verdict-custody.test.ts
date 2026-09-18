import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalizeReviewRequest,
  issueReviewRequest,
  projectReviewVerdict,
  type ReviewAttestation,
  type ReviewAttestationRequest,
} from "../src/feedback/review-attestation.ts";
import {
  appendReviewCustodyAudit,
  assertReviewVerdictPath,
  beginReviewAttempt,
  cleanupReviewAttempt,
  readReviewCustodyAudit,
  recordReviewAttemptFailure,
  reviewCustodyAuditPath,
  reviewIdentityDigest,
  reviewVerdictPath,
} from "../src/feedback/review-verdict-custody.ts";

const head = "a".repeat(40);

function gitRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ut-rv-custody-"));
  execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "ignore" });
  return root;
}

function request(): ReviewAttestationRequest {
  return canonicalizeReviewRequest({
    memoryId: "memory:rv-custody",
    pr: 328,
    exactHead: head,
    reviewRevision: "legacy-revision",
    authorFamily: "codex",
    requestedAt: "2026-08-19T00:00:00.000Z",
  });
}

function attestation(overrides: Partial<ReviewAttestation> = {}): ReviewAttestation {
  return {
    provider: "claude",
    role: "blind-reviewer",
    model: "claude-opus-5",
    pr: 328,
    head,
    reviewRevision: request().reviewRevision,
    startedAt: "2026-08-19T00:00:00.000Z",
    completedAt: "2026-08-19T00:01:00.000Z",
    exitCode: 0,
    attempt: 1,
    invocationNonce: request().invocationNonce,
    ...overrides,
  };
}

function envelope(input: {
  request: ReviewAttestationRequest;
  attempt: number;
  provider?: "codex" | "claude";
  model?: string;
  nonce?: string;
}): string {
  const { request: value, attempt, provider = "claude", model = "claude-opus-5", nonce } = input;
  return [
    "schema_version: ut-tdd.review-verdict/v1",
    `request_digest: ${reviewIdentityDigest(value)}`,
    `attempt: ${attempt}`,
    `pr: ${value.pr}`,
    `exact_head: ${value.exactHead}`,
    `review_revision: ${value.reviewRevision}`,
    `reviewer_provider: ${provider}`,
    `reviewer_model: ${model}`,
    `invocation_nonce: ${nonce ?? value.invocationNonce}`,
    "VERDICT: PASS",
  ].join("\n");
}

function issue(root: string): { request: ReviewAttestationRequest; digest: string } {
  const result = issueReviewRequest({ repoRoot: root, request: request(), strict: true });
  if (!result.ok) throw new Error(result.reason);
  return { request: result.request, digest: result.digest };
}

describe("repo-local review verdict custody (U-RVATT-030..035)", () => {
  it("U-RVATT-030: digestは64桁で、attempt pathはrepo containmentを厳密に束縛する", () => {
    const root = gitRoot();
    try {
      const value = request();
      const digest = reviewIdentityDigest(value);
      expect(digest).toMatch(/^[a-f0-9]{64}$/);
      const path = reviewVerdictPath(root, digest, 1);
      expect(path.replaceAll("\\", "/")).toContain(
        `/verdicts/${digest}/attempts/attempt-1/verdict.txt`,
      );
      expect(() =>
        assertReviewVerdictPath({
          repoRoot: root,
          requestDigest: digest,
          attempt: 1,
          verdictPath: join(root, "..", "outside", "verdict.txt"),
        }),
      ).toThrow();
      expect(() => reviewVerdictPath(root, digest, 0)).toThrow();
      const escaped = join(root, ".ut-tdd", "review", "verdicts", digest, "attempts", "attempt-1");
      mkdirSync(join(root, ".ut-tdd", "review", "verdicts", digest, "attempts"), {
        recursive: true,
      });
      const outside = mkdtempSync(join(tmpdir(), "ut-rv-custody-outside-"));
      try {
        symlinkSync(outside, escaped, process.platform === "win32" ? "junction" : "dir");
        expect(() =>
          assertReviewVerdictPath({
            repoRoot: root,
            requestDigest: digest,
            attempt: 1,
            verdictPath: join(escaped, "verdict.txt"),
          }),
        ).toThrow();
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RVATT-031: constrained consumerはrepo-local writeを許可し、外部pathを拒否する", () => {
    const root = gitRoot();
    try {
      const issued = issue(root);
      const attempt = beginReviewAttempt({
        repoRoot: root,
        request: issued.request,
        provider: "claude",
        model: "claude-opus-5",
      });
      expect(attempt).toMatchObject({ ok: true, attempt: 1 });
      if (!attempt.ok) return;
      writeFileSync(attempt.path, envelope({ request: issued.request, attempt: 1 }), "utf8");
      expect(existsSync(attempt.path)).toBe(true);
      expect(() =>
        assertReviewVerdictPath({
          repoRoot: root,
          requestDigest: issued.digest,
          attempt: 1,
          verdictPath: join(tmpdir(), "outside-verdict.txt"),
        }),
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RVATT-032: envelope identity、nonce、provider mutationはreceiptを作らない", () => {
    const root = gitRoot();
    try {
      const issued = issue(root);
      const attempt = beginReviewAttempt({
        repoRoot: root,
        request: issued.request,
        provider: "claude",
        model: "claude-opus-5",
      });
      if (!attempt.ok) throw new Error(attempt.reason);
      const cases = [
        {
          name: "digest",
          text: envelope({ request: issued.request, attempt: 1 }).replace(
            issued.digest,
            "b".repeat(64),
          ),
        },
        { name: "attempt", text: envelope({ request: issued.request, attempt: 2 }) },
        {
          name: "provider",
          text: envelope({ request: issued.request, attempt: 1, provider: "codex" }),
        },
        { name: "nonce", text: envelope({ request: issued.request, attempt: 1, nonce: "wrong" }) },
      ];
      for (const value of cases) {
        writeFileSync(attempt.path, value.text, "utf8");
        const result = projectReviewVerdict({
          repoRoot: root,
          request: issued.request,
          attestation: attestation({ attempt: 1 }),
          verdictFile: attempt.path,
        });
        expect(result, value.name).toEqual({ ok: false, reason: "verdict_identity_mismatch" });
      }
      writeFileSync(attempt.path, envelope({ request: issued.request, attempt: 1 }), "utf8");
      const stale = projectReviewVerdict({
        repoRoot: root,
        request: issued.request,
        attestation: attestation({ head: "b".repeat(40) }),
        verdictFile: attempt.path,
      });
      expect(stale).toEqual({ ok: false, reason: "review_identity_mismatch" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RVATT-033: stale HEADと同族reviewerはfail-closeする", () => {
    const root = gitRoot();
    try {
      const issued = issue(root);
      const attempt = beginReviewAttempt({
        repoRoot: root,
        request: issued.request,
        provider: "claude",
        model: "claude-opus-5",
      });
      if (!attempt.ok) throw new Error(attempt.reason);
      writeFileSync(attempt.path, envelope({ request: issued.request, attempt: 1 }), "utf8");
      expect(
        projectReviewVerdict({
          repoRoot: root,
          request: issued.request,
          attestation: attestation({ head: "b".repeat(40) }),
          verdictFile: attempt.path,
        }),
      ).toEqual({ ok: false, reason: "review_identity_mismatch" });
      expect(
        beginReviewAttempt({
          repoRoot: root,
          request: issued.request,
          provider: "codex",
          model: "gpt-5.6-sol",
        }),
      ).toEqual({ ok: false, reason: "same_family_reviewer_denied" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RVATT-034: receipt前の再試行は同族・次attemptへ進み、receipt後は停止する", () => {
    const root = gitRoot();
    try {
      const issued = issue(root);
      const first = beginReviewAttempt({
        repoRoot: root,
        request: issued.request,
        provider: "claude",
        model: "claude-opus-5",
      });
      if (!first.ok) throw new Error(first.reason);
      expect(
        recordReviewAttemptFailure({
          repoRoot: root,
          request: issued.request,
          attempt: first.attempt,
          provider: "claude",
          model: "claude-opus-5",
          exitCode: 7,
          verdictPath: first.path,
        }),
      ).toMatchObject({ ok: true });
      const second = beginReviewAttempt({
        repoRoot: root,
        request: issued.request,
        provider: "claude",
        model: "claude-sonnet-5",
      });
      expect(first).toMatchObject({ ok: true, attempt: 1 });
      expect(second).toMatchObject({ ok: true, attempt: 2 });
      expect(readReviewCustodyAudit(root)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "superseded_attempt", attempt: 2 }),
        ]),
      );
      if (!second.ok) return;
      writeFileSync(
        second.path,
        envelope({ request: issued.request, attempt: 2, model: "claude-sonnet-5" }),
        "utf8",
      );
      const projected = projectReviewVerdict({
        repoRoot: root,
        request: issued.request,
        attestation: attestation({ attempt: 2, model: "claude-sonnet-5" }),
        verdictFile: second.path,
      });
      expect(projected).toMatchObject({ ok: true });
      const blocked = beginReviewAttempt({
        repoRoot: root,
        request: issued.request,
        provider: "claude",
        model: "claude-opus-5",
      });
      expect(blocked).toEqual({ ok: false, reason: "review_receipt_already_exists" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RVATT-035: receipt後cleanupはscratchを消し、失敗はcleanup_pendingへ記録する", () => {
    const root = gitRoot();
    try {
      const issued = issue(root);
      const attempt = beginReviewAttempt({
        repoRoot: root,
        request: issued.request,
        provider: "claude",
        model: "claude-opus-5",
      });
      if (!attempt.ok) throw new Error(attempt.reason);
      writeFileSync(attempt.path, envelope({ request: issued.request, attempt: 1 }), "utf8");
      const projected = projectReviewVerdict({
        repoRoot: root,
        request: issued.request,
        attestation: attestation(),
        verdictFile: attempt.path,
      });
      if (!projected.ok) throw new Error(projected.reason);
      cleanupReviewAttempt({
        repoRoot: root,
        requestDigest: issued.digest,
        attempt: 1,
        verdictPath: attempt.path,
        receiptDigest: projected.digest,
        exactHead: issued.request.exactHead,
      });
      expect(existsSync(attempt.path)).toBe(false);
      appendReviewCustodyAudit(root, {
        kind: "cleanup_pending",
        requestDigest: issued.digest,
        attempt: 1,
        exactHead: issued.request.exactHead,
        verdictPath: attempt.path,
        recordedAt: "2026-08-19T00:02:00.000Z",
        reason: "test-cleanup-failure",
        receiptDigest: projected.digest,
      });
      expect(readFileSync(reviewCustodyAuditPath(root), "utf8")).toContain("cleanup_pending");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
