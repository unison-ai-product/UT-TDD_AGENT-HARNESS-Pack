import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  hasTerminalReviewReceipt,
  type ReviewCustodyAuditEvent,
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

function reviewListing(root: string): string[] {
  const base = join(root, ".ut-tdd", "review");
  const entries: string[] = [];
  const walk = (directory: string, prefix = "") => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}${entry.isDirectory() ? "/" : ""}`;
      entries.push(relative);
      if (entry.isDirectory()) walk(join(directory, entry.name), relative);
    }
  };
  walk(base);
  return entries.sort();
}

describe("repo-local review verdict custody (U-RVATT-030..035)", () => {
  it("U-RVATT-037: terminal receipt後のretryはrequest metadataを書き換えず拒否する", () => {
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
      writeFileSync(
        attempt.path,
        envelope({ request: issued.request, attempt: attempt.attempt }),
        "utf8",
      );
      const projected = projectReviewVerdict({
        repoRoot: root,
        request: issued.request,
        attestation: attestation({ attempt: attempt.attempt }),
        verdictFile: attempt.path,
      });
      expect(projected).toMatchObject({ ok: true });
      expect(hasTerminalReviewReceipt(root, issued.request)).toBe(true);

      const retry = issueReviewRequest({
        repoRoot: root,
        request: {
          ...issued.request,
          requestedAt: "2026-08-19T00:05:00.000Z",
        },
        strict: true,
      });
      expect(retry).toEqual({ ok: false, reason: "review_receipt_already_exists" });
      const requestPath = join(root, ".ut-tdd", "review", "requests", `${issued.digest}.json`);
      expect(JSON.parse(readFileSync(requestPath, "utf8")).requestedAt).toBe(
        issued.request.requestedAt,
      );

      const requestBytes = readFileSync(requestPath);
      const auditPath = reviewCustodyAuditPath(root);
      const auditBytes = readFileSync(auditPath);
      const reviewTree = reviewListing(root);
      const retryAgain = issueReviewRequest({
        repoRoot: root,
        request: {
          ...issued.request,
          requestedAt: "2026-08-19T00:06:00.000Z",
        },
        strict: true,
      });
      expect(retryAgain).toEqual({ ok: false, reason: "review_receipt_already_exists" });
      expect(readFileSync(requestPath)).toEqual(requestBytes);
      expect(readFileSync(auditPath)).toEqual(auditBytes);
      expect(reviewListing(root)).toEqual(reviewTree);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("orphan receipt は retry を terminal 扱いしない (U-RVATT-037)", () => {
    const root = gitRoot();
    try {
      const issued = issue(root);
      const receiptPath = join(root, ".ut-tdd", "review", "receipts", `${issued.digest}.json`);
      mkdirSync(join(root, ".ut-tdd", "review", "receipts"), { recursive: true });
      writeFileSync(receiptPath, '{"verdict":"PASS"}\n', "utf8");
      const receiptBytes = readFileSync(receiptPath);
      const verdictTreeBeforeOrphanRetry = reviewListing(root).filter((entry) =>
        entry.startsWith("verdicts/"),
      );

      const orphanRetry = issueReviewRequest({
        repoRoot: root,
        request: { ...issued.request, requestedAt: "2026-08-19T00:05:00.000Z" },
        strict: true,
      });
      expect(orphanRetry).toMatchObject({ ok: true });
      expect(readFileSync(receiptPath)).toEqual(receiptBytes);
      expect(reviewListing(root).filter((entry) => entry.startsWith("verdicts/"))).toEqual(
        verdictTreeBeforeOrphanRetry,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["exactHead", (event: ReviewCustodyAuditEvent) => ({ ...event, exactHead: "b".repeat(40) })],
    [
      "verdictPath",
      (event: ReviewCustodyAuditEvent) => ({
        ...event,
        verdictPath: `${event.verdictPath}.foreign`,
      }),
    ],
    [
      "receiptFileDigest",
      (event: ReviewCustodyAuditEvent) => ({ ...event, receiptFileDigest: "f".repeat(64) }),
    ],
    ["provider", (event: ReviewCustodyAuditEvent) => ({ ...event, provider: "codex" as const })],
    ["model", (event: ReviewCustodyAuditEvent) => ({ ...event, model: "" })],
    ["exitCode", (event: ReviewCustodyAuditEvent) => ({ ...event, exitCode: 1 })],
    ["verdictDigest", (event: ReviewCustodyAuditEvent) => ({ ...event, verdictDigest: "invalid" })],
  ] as const)("U-RVATT-037 rejects a single %s drift in terminal audit identity", (_axis, mutate) => {
    const root = gitRoot();
    try {
      const issued = issue(root);
      const receiptPath = join(root, ".ut-tdd", "review", "receipts", `${issued.digest}.json`);
      const receiptBytes = Buffer.from('{"verdict":"PASS"}\n', "utf8");
      mkdirSync(dirname(receiptPath), { recursive: true });
      writeFileSync(receiptPath, receiptBytes);
      const valid: ReviewCustodyAuditEvent = {
        kind: "attempt_completed",
        requestDigest: issued.digest,
        attempt: 1,
        exactHead: issued.request.exactHead,
        verdictPath: reviewVerdictPath(root, issued.digest, 1),
        recordedAt: "2026-08-19T00:06:00.000Z",
        reason: "review_completed",
        provider: "claude",
        model: "claude-opus-5",
        exitCode: 0,
        receiptFileDigest: createHash("sha256").update(receiptBytes).digest("hex"),
        verdictDigest: "1".repeat(64),
      };
      appendReviewCustodyAudit(root, mutate(valid));
      expect(hasTerminalReviewReceipt(root, issued.request)).toBe(false);
      const auditBytes = readFileSync(reviewCustodyAuditPath(root));
      const retry = issueReviewRequest({
        repoRoot: root,
        request: { ...issued.request, requestedAt: "2026-08-19T00:07:00.000Z" },
        strict: true,
      });
      expect(retry).toMatchObject({ ok: true });
      expect(readFileSync(receiptPath)).toEqual(receiptBytes);
      expect(readFileSync(reviewCustodyAuditPath(root))).toEqual(auditBytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["claude", true],
    ["codex", false],
  ] as const)("U-RVATT-037 crash-window completion provider %s is retryable=%s", (provider, retryable) => {
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
      appendReviewCustodyAudit(root, {
        kind: "attempt_completed",
        requestDigest: issued.digest,
        attempt: first.attempt,
        exactHead: issued.request.exactHead,
        verdictPath: first.path,
        recordedAt: "2026-08-19T00:06:00.000Z",
        reason: "review_completed",
        provider,
        model: "claude-opus-5",
        exitCode: 0,
        receiptFileDigest: "1".repeat(64),
        verdictDigest: "2".repeat(64),
      });
      const auditBytes = readFileSync(reviewCustodyAuditPath(root));
      const second = beginReviewAttempt({
        repoRoot: root,
        request: issued.request,
        provider: "claude",
        model: "claude-opus-5",
      });
      if (retryable) {
        expect(second).toMatchObject({ ok: true, attempt: 2 });
      } else {
        expect(second).toEqual({ ok: false, reason: "attempt_outcome_indeterminate" });
        expect(readFileSync(reviewCustodyAuditPath(root))).toEqual(auditBytes);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RVATT-038: 壊れた監査JSONLはtyped indeterminateで停止する", () => {
    const root = gitRoot();
    try {
      const digest = reviewIdentityDigest(request());
      const receiptPath = join(root, ".ut-tdd", "review", "receipts", `${digest}.json`);
      mkdirSync(dirname(receiptPath), { recursive: true });
      writeFileSync(receiptPath, '{"verdict":"PASS"}\n', "utf8");
      const auditPath = reviewCustodyAuditPath(root);
      mkdirSync(dirname(auditPath), { recursive: true });
      writeFileSync(auditPath, '{"broken":\n', "utf8");
      const result = issueReviewRequest({ repoRoot: root, request: request(), strict: true });
      expect(result).toEqual({ ok: false, reason: "attempt_outcome_indeterminate" });
      expect(existsSync(join(root, ".ut-tdd", "review", "requests"))).toBe(false);
      expect(readFileSync(receiptPath, "utf8")).toBe('{"verdict":"PASS"}\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
