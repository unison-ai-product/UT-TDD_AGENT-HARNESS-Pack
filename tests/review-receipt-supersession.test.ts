import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalizeReviewRequest,
  projectReviewVerdict,
  type ReviewAttestation,
  type ReviewAttestationRequest,
} from "../src/feedback/review-attestation.ts";
import {
  beginReviewAttempt,
  cleanupReviewAttempt,
  readReviewCustodyAudit,
  recordReviewAttemptFailure,
  reviewCustodyAuditPath,
  reviewIdentityDigest,
} from "../src/feedback/review-verdict-custody.ts";

const head = "a".repeat(40);
const otherHead = "b".repeat(40);

function fixture(): { root: string; request: ReviewAttestationRequest; digest: string } {
  const root = mkdtempSync(join(tmpdir(), "ut-rv-supersession-"));
  execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "ignore" });
  const request = canonicalizeReviewRequest({
    memoryId: "memory:rv-supersession",
    pr: 386,
    exactHead: head,
    reviewRevision: "legacy-revision",
    authorFamily: "codex",
    requestedAt: "2026-08-28T00:00:00.000Z",
  });
  return { root, request, digest: reviewIdentityDigest(request) };
}

function attestation(
  request: ReviewAttestationRequest,
  attempt: number,
  exitCode: number,
  model = "claude-opus-5",
): ReviewAttestation {
  return {
    provider: "claude",
    role: "blind-reviewer",
    model,
    pr: request.pr,
    head: request.exactHead,
    reviewRevision: request.reviewRevision,
    startedAt: "2026-08-28T00:00:00.000Z",
    completedAt: "2026-08-28T00:01:00.000Z",
    exitCode,
    attempt,
    invocationNonce: request.invocationNonce,
  };
}

function verdictText(
  request: ReviewAttestationRequest,
  attempt: number,
  model = "claude-opus-5",
  provider: "codex" | "claude" = "claude",
) {
  return [
    "schema_version: ut-tdd.review-verdict/v1",
    `request_digest: ${reviewIdentityDigest(request)}`,
    `attempt: ${attempt}`,
    `pr: ${request.pr}`,
    `exact_head: ${request.exactHead}`,
    `review_revision: ${request.reviewRevision}`,
    `reviewer_provider: ${provider}`,
    `reviewer_model: ${model}`,
    `invocation_nonce: ${request.invocationNonce}`,
    "VERDICT: PASS",
  ].join("\n");
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

describe("PLAN-L7-520 append-only receipt supersession", () => {
  it("CANDIDATE-U-RVATT-040 composition / case C preserves failed attempt and creates one receipt", () => {
    const { root, request, digest } = fixture();
    try {
      const first = beginReviewAttempt({
        repoRoot: root,
        request,
        provider: "claude",
        model: "claude-opus-5",
      });
      expect(first).toMatchObject({ ok: true, attempt: 1 });
      if (!first.ok) return;
      writeFileSync(first.path, verdictText(request, 1), "utf8");
      expect(
        projectReviewVerdict({
          repoRoot: root,
          request,
          attestation: attestation(request, 1, 7),
          verdictFile: first.path,
        }),
      ).toEqual({ ok: false, reason: "reviewer_exit_nonzero" });
      expect(readReviewCustodyAudit(root)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "attempt_execution_failed", attempt: 1, exitCode: 7 }),
        ]),
      );
      const firstFailure = readReviewCustodyAudit(root).find(
        (event) => event.kind === "attempt_execution_failed" && event.attempt === 1,
      );
      if (!firstFailure) throw new Error("missing first failure event");

      const second = beginReviewAttempt({
        repoRoot: root,
        request,
        provider: "claude",
        model: "claude-sonnet-5",
      });
      expect(second).toMatchObject({ ok: true, attempt: 2 });
      if (!second.ok) return;
      writeFileSync(second.path, verdictText(request, 2, "claude-sonnet-5"), "utf8");
      const projected = projectReviewVerdict({
        repoRoot: root,
        request,
        attestation: attestation(request, 2, 0, "claude-sonnet-5"),
        verdictFile: second.path,
      });
      expect(projected).toMatchObject({ ok: true });
      expect(readReviewCustodyAudit(root)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "superseded_attempt",
            attempt: 2,
            supersededAttempt: 1,
            oldAttemptDigest: expect.any(String),
          }),
        ]),
      );
      expect(existsSync(first.path)).toBe(true);
      expect(existsSync(join(root, ".ut-tdd", "review", "receipts", `${digest}.json`))).toBe(true);
      cleanupReviewAttempt({
        repoRoot: root,
        requestDigest: digest,
        attempt: 2,
        verdictPath: second.path,
        receiptDigest: projected.ok ? projected.digest : "",
        exactHead: request.exactHead,
      });
      expect(existsSync(first.path)).toBe(true);
      expect(existsSync(second.path)).toBe(false);
      expect(readReviewCustodyAudit(root)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "attempt_execution_failed",
            attempt: 1,
            requestDigest: digest,
            exactHead: request.exactHead,
            verdictPath: first.path,
            verdictDigest: firstFailure.verdictDigest,
          }),
          expect.objectContaining({
            kind: "superseded_attempt",
            attempt: 2,
            supersededAttempt: 1,
            requestDigest: digest,
            exactHead: request.exactHead,
            verdictPath: first.path,
            oldAttemptDigest: firstFailure.verdictDigest,
          }),
        ]),
      );
    } finally {
      cleanup(root);
    }
  });

  it("CANDIDATE-U-RVATT-040: multiple retry chain keeps prior supersession history valid", () => {
    const { root, request } = fixture();
    try {
      const first = beginReviewAttempt({
        repoRoot: root,
        request,
        provider: "claude",
        model: "claude-opus-5",
      });
      if (!first.ok) throw new Error(first.reason);
      writeFileSync(first.path, verdictText(request, 1), "utf8");
      expect(
        projectReviewVerdict({
          repoRoot: root,
          request,
          attestation: attestation(request, 1, 7),
          verdictFile: first.path,
        }),
      ).toEqual({ ok: false, reason: "reviewer_exit_nonzero" });

      const second = beginReviewAttempt({
        repoRoot: root,
        request,
        provider: "claude",
        model: "claude-sonnet-5",
      });
      if (!second.ok) throw new Error(second.reason);
      writeFileSync(second.path, verdictText(request, 2, "claude-sonnet-5"), "utf8");
      expect(
        projectReviewVerdict({
          repoRoot: root,
          request,
          attestation: attestation(request, 2, 8, "claude-sonnet-5"),
          verdictFile: second.path,
        }),
      ).toEqual({ ok: false, reason: "reviewer_exit_nonzero" });

      const third = beginReviewAttempt({
        repoRoot: root,
        request,
        provider: "claude",
        model: "claude-opus-5",
      });
      expect(third).toMatchObject({ ok: true, attempt: 3 });
      if (!third.ok) return;
      writeFileSync(third.path, verdictText(request, 3), "utf8");
      expect(
        projectReviewVerdict({
          repoRoot: root,
          request,
          attestation: attestation(request, 3, 0),
          verdictFile: third.path,
        }),
      ).toMatchObject({ ok: true });
    } finally {
      cleanup(root);
    }
  });

  for (const testCase of [
    { name: "missing verdict", reason: "verdict_file_missing" },
    { name: "missing custody envelope", reason: "verdict_identity_mismatch" },
    { name: "identity mismatch", reason: "review_identity_mismatch" },
    { name: "invalid attestation", reason: "invalid_review_attestation" },
    { name: "same-family reviewer", reason: "same_family_reviewer_denied" },
  ] as const) {
    it(`CANDIDATE-U-RVATT-046: exit 0 ${testCase.name} records a retryable terminal outcome`, () => {
      const { root, request: baseRequest } = fixture();
      const request =
        testCase.reason === "same_family_reviewer_denied"
          ? canonicalizeReviewRequest({
              ...baseRequest,
              authorFamily: "claude",
              reviewRevision: "legacy-revision",
            })
          : baseRequest;
      const expectedProvider = request.authorFamily === "codex" ? "claude" : "codex";
      try {
        const first = beginReviewAttempt({
          repoRoot: root,
          request,
          provider: testCase.reason === "same_family_reviewer_denied" ? expectedProvider : "claude",
          model: "claude-opus-5",
        });
        if (!first.ok) throw new Error(first.reason);
        if (testCase.name === "missing custody envelope") {
          writeFileSync(first.path, "VERDICT: PASS\n", "utf8");
        } else if (testCase.reason !== "verdict_file_missing") {
          writeFileSync(first.path, verdictText(request, 1, "claude-opus-5", "claude"), "utf8");
        }
        const firstAttestation = attestation(request, 1, 0, "claude-opus-5");
        if (testCase.reason === "review_identity_mismatch") firstAttestation.head = otherHead;
        if (testCase.reason === "invalid_review_attestation") firstAttestation.role = "";
        if (testCase.reason === "same_family_reviewer_denied") firstAttestation.provider = "claude";
        const rejected = projectReviewVerdict({
          repoRoot: root,
          request,
          attestation: firstAttestation,
          verdictFile: first.path,
        });
        expect(rejected).toEqual({ ok: false, reason: testCase.reason });
        expect(readReviewCustodyAudit(root)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "attempt_verdict_rejected",
              attempt: 1,
              exitCode: 0,
              reason: testCase.reason,
            }),
          ]),
        );

        const second = beginReviewAttempt({
          repoRoot: root,
          request,
          provider: expectedProvider,
          model: "claude-sonnet-5",
        });
        expect(second).toMatchObject({ ok: true, attempt: 2 });
        if (!second.ok) return;
        writeFileSync(
          second.path,
          verdictText(request, 2, "claude-sonnet-5", expectedProvider),
          "utf8",
        );
        const secondAttestation = attestation(request, 2, 0, "claude-sonnet-5");
        secondAttestation.provider = expectedProvider;
        expect(
          projectReviewVerdict({
            repoRoot: root,
            request,
            attestation: secondAttestation,
            verdictFile: second.path,
          }),
        ).toMatchObject({ ok: true });
      } finally {
        cleanup(root);
      }
    });
  }

  it("CANDIDATE-U-RVATT-046: malformed attestation keeps its typed reason when custody cannot record it", () => {
    const { root, request } = fixture();
    try {
      const first = beginReviewAttempt({
        repoRoot: root,
        request,
        provider: "claude",
        model: "claude-opus-5",
      });
      if (!first.ok) throw new Error(first.reason);
      writeFileSync(first.path, verdictText(request, 1), "utf8");
      const rejected = projectReviewVerdict({
        repoRoot: root,
        request,
        attestation: attestation(request, 1, 0, ""),
        verdictFile: first.path,
      });
      expect(rejected).toEqual({ ok: false, reason: "invalid_review_attestation" });
      expect(readReviewCustodyAudit(root)).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "attempt_verdict_rejected", attempt: 1 }),
        ]),
      );
    } finally {
      cleanup(root);
    }
  });

  it("CANDIDATE-U-RVATT-040 case A: missing failure outcome blocks retry", () => {
    const { root, request } = fixture();
    try {
      const first = beginReviewAttempt({
        repoRoot: root,
        request,
        provider: "claude",
        model: "claude-opus-5",
      });
      if (!first.ok) throw new Error(first.reason);
      writeFileSync(first.path, verdictText(request, 1), "utf8");
      const recorded = recordReviewAttemptFailure({
        repoRoot: root,
        request,
        attempt: 1,
        provider: "claude",
        model: "claude-opus-5",
        exitCode: 7,
        verdictPath: first.path,
        now: "2026-08-28T00:01:00.000Z",
      });
      expect(recorded.ok).toBe(true);
      const auditPath = reviewCustodyAuditPath(root);
      const lines = readFileSync(auditPath, "utf8").trim().split("\n");
      writeFileSync(
        auditPath,
        `${lines.filter((line) => !line.includes('"kind":"attempt_execution_failed"')).join("\n")}\n`,
        "utf8",
      );
      expect(
        beginReviewAttempt({
          repoRoot: root,
          request,
          provider: "claude",
          model: "claude-sonnet-5",
        }),
      ).toEqual({
        ok: false,
        reason: "attempt_outcome_indeterminate",
      });
    } finally {
      cleanup(root);
    }
  });

  it("CANDIDATE-U-RVATT-040 case D: duplicated failure outcome blocks retry", () => {
    const { root, request } = fixture();
    try {
      const first = beginReviewAttempt({
        repoRoot: root,
        request,
        provider: "claude",
        model: "claude-opus-5",
      });
      if (!first.ok) throw new Error(first.reason);
      const recorded = recordReviewAttemptFailure({
        repoRoot: root,
        request,
        attempt: 1,
        provider: "claude",
        model: "claude-opus-5",
        exitCode: 7,
        verdictPath: first.path,
        now: "2026-08-28T00:01:00.000Z",
      });
      expect(recorded.ok).toBe(true);
      const event = readReviewCustodyAudit(root).find(
        (entry) => entry.kind === "attempt_execution_failed",
      );
      if (!event) throw new Error("missing event");
      const auditPath = reviewCustodyAuditPath(root);
      writeFileSync(
        auditPath,
        `${readFileSync(auditPath, "utf8")}${JSON.stringify(event)}\n`,
        "utf8",
      );
      expect(
        beginReviewAttempt({
          repoRoot: root,
          request,
          provider: "claude",
          model: "claude-sonnet-5",
        }),
      ).toEqual({
        ok: false,
        reason: "attempt_outcome_indeterminate",
      });
    } finally {
      cleanup(root);
    }
  });

  it("CANDIDATE-U-RVATT-040: outcome conflict is typed and blocks a new attempt", () => {
    const { root, request } = fixture();
    try {
      const first = beginReviewAttempt({
        repoRoot: root,
        request,
        provider: "claude",
        model: "claude-opus-5",
      });
      if (!first.ok) throw new Error(first.reason);
      writeFileSync(first.path, verdictText(request, 1), "utf8");
      expect(
        projectReviewVerdict({
          repoRoot: root,
          request,
          attestation: attestation(request, 1, 7),
          verdictFile: first.path,
        }),
      ).toEqual({ ok: false, reason: "reviewer_exit_nonzero" });
      const auditPath = reviewCustodyAuditPath(root);
      const firstFailure = readReviewCustodyAudit(root).find(
        (event) => event.kind === "attempt_execution_failed" && event.attempt === 1,
      );
      if (!firstFailure?.verdictDigest) throw new Error("missing first failure digest");
      writeFileSync(first.path, `${verdictText(request, 1)}\nmutated-after-failure`, "utf8");
      const mutatedVerdictDigest = createHash("sha256")
        .update(readFileSync(first.path))
        .digest("hex");

      const conflict = projectReviewVerdict({
        repoRoot: root,
        request,
        attestation: attestation(request, 1, 9),
        verdictFile: first.path,
      });
      expect(conflict).toEqual({ ok: false, reason: "attempt_outcome_conflict" });
      const auditAfterConflict = readReviewCustodyAudit(root);
      const conflictEvent = auditAfterConflict.find(
        (event) => event.kind === "attempt_outcome_conflict" && event.attempt === 1,
      );
      if (!conflictEvent?.verdictDigest) throw new Error("missing conflict digest");
      expect(firstFailure).toMatchObject({
        kind: "attempt_execution_failed",
        requestDigest: reviewIdentityDigest(request),
        attempt: 1,
        exactHead: request.exactHead,
        verdictPath: first.path,
        provider: "claude",
        model: "claude-opus-5",
        exitCode: 7,
        reason: "reviewer_exit_nonzero",
      });
      expect(conflictEvent).toMatchObject({
        kind: "attempt_outcome_conflict",
        requestDigest: reviewIdentityDigest(request),
        attempt: 1,
        exactHead: request.exactHead,
        verdictPath: first.path,
        provider: "claude",
        model: "claude-opus-5",
        exitCode: 9,
        reason: "attempt_outcome_conflict",
        oldAttemptDigest: firstFailure.verdictDigest,
        verdictDigest: mutatedVerdictDigest,
      });
      expect(conflictEvent.verdictDigest).not.toBe(firstFailure.verdictDigest);
      const auditAfterConflictBytes = readFileSync(auditPath);
      const replay = projectReviewVerdict({
        repoRoot: root,
        request,
        attestation: attestation(request, 1, 9),
        verdictFile: first.path,
      });
      expect(replay).toEqual(conflict);
      expect(readFileSync(auditPath)).toEqual(auditAfterConflictBytes);
      expect(
        readReviewCustodyAudit(root).filter(
          (event) => event.kind === "attempt_outcome_conflict" && event.attempt === 1,
        ),
      ).toHaveLength(1);
      const auditBeforeBegin = readFileSync(auditPath);
      const eventCountBeforeBegin = readReviewCustodyAudit(root).length;
      expect(existsSync(join(root, ".ut-tdd", "review", "receipts"))).toBe(false);
      const blocked = beginReviewAttempt({
        repoRoot: root,
        request,
        provider: "claude",
        model: "claude-sonnet-5",
      });
      expect(blocked).toEqual({ ok: false, reason: "attempt_outcome_indeterminate" });
      expect(readFileSync(auditPath)).toEqual(auditBeforeBegin);
      expect(readReviewCustodyAudit(root)).toHaveLength(eventCountBeforeBegin);
      expect(
        readReviewCustodyAudit(root).filter((event) => event.kind === "superseded_attempt"),
      ).toHaveLength(0);
      expect(
        existsSync(
          join(
            root,
            ".ut-tdd",
            "review",
            "verdicts",
            reviewIdentityDigest(request),
            "attempts",
            "attempt-2",
          ),
        ),
      ).toBe(false);
    } finally {
      cleanup(root);
    }
  });

  it("CANDIDATE-U-RVATT-044: mutated attempt outcome identity blocks retry", () => {
    const { root, request } = fixture();
    try {
      const first = beginReviewAttempt({
        repoRoot: root,
        request,
        provider: "claude",
        model: "claude-opus-5",
      });
      if (!first.ok) throw new Error(first.reason);
      const recorded = recordReviewAttemptFailure({
        repoRoot: root,
        request,
        attempt: 1,
        provider: "claude",
        model: "claude-opus-5",
        exitCode: 7,
        verdictPath: first.path,
        now: "2026-08-28T00:01:00.000Z",
      });
      expect(recorded.ok).toBe(true);
      const auditPath = reviewCustodyAuditPath(root);
      const event = readReviewCustodyAudit(root).find(
        (entry) => entry.kind === "attempt_execution_failed",
      );
      if (!event) throw new Error("missing event");
      writeFileSync(
        auditPath,
        `${JSON.stringify({ ...event, exactHead: "b".repeat(40) })}\n`,
        "utf8",
      );
      expect(
        beginReviewAttempt({
          repoRoot: root,
          request,
          provider: "claude",
          model: "claude-sonnet-5",
        }),
      ).toEqual({ ok: false, reason: "attempt_outcome_indeterminate" });
    } finally {
      cleanup(root);
    }
  });

  it("CANDIDATE-U-RVATT-040 case B / negative 043/045: canonical receipt is create-exclusive (retry after mutation re-specified by PLAN-L7-534 §3.2 / CANDIDATE-U-D3BCOMP-020(b))", () => {
    const { root, request, digest } = fixture();
    try {
      const first = beginReviewAttempt({
        repoRoot: root,
        request,
        provider: "claude",
        model: "claude-opus-5",
      });
      if (!first.ok) throw new Error(first.reason);
      writeFileSync(first.path, verdictText(request, 1), "utf8");
      const initial = projectReviewVerdict({
        repoRoot: root,
        request,
        attestation: attestation(request, 1, 0),
        verdictFile: first.path,
      });
      if (!initial.ok) throw new Error(initial.reason);
      const receiptPath = join(root, ".ut-tdd", "review", "receipts", `${digest}.json`);
      const before = readFileSync(receiptPath);
      writeFileSync(receiptPath, `${JSON.stringify({ changed: true })}\n`, "utf8");
      const mutated = readFileSync(receiptPath);
      const conflict = projectReviewVerdict({
        repoRoot: root,
        request,
        attestation: attestation(request, 1, 0),
        verdictFile: first.path,
      });
      expect(conflict).toEqual({ ok: false, reason: "verdict_identity_conflict" });
      expect(readFileSync(receiptPath)).toEqual(mutated);
      expect(readFileSync(receiptPath)).not.toEqual(before);
      // PLAN-L7-534 §3.2: the mutated receipt no longer has a matching
      // attempt_completed (receiptFileDigest != sha256 of the bytes), so it is an
      // orphan and a bounded retry may start. The retry regenerates the original
      // bytes, hits EEXIST against the foreign bytes and fail-closes with a typed
      // conflict — never overwriting the existing file (create-exclusive kept).
      const retry = beginReviewAttempt({
        repoRoot: root,
        request,
        provider: "claude",
        model: "claude-opus-5",
      });
      expect(retry).toMatchObject({ ok: true, attempt: 2 });
      if (!retry.ok) throw new Error(retry.reason);
      writeFileSync(retry.path, verdictText(request, 2), "utf8");
      const replayed = projectReviewVerdict({
        repoRoot: root,
        request,
        attestation: attestation(request, 2, 0),
        verdictFile: retry.path,
      });
      expect(replayed).toEqual({ ok: false, reason: "verdict_identity_conflict" });
      expect(readFileSync(receiptPath)).toEqual(mutated);
      expect(
        readReviewCustodyAudit(root).filter(
          (event) => event.kind === "attempt_outcome_conflict" && event.attempt === 2,
        ),
      ).toHaveLength(1);
      expect(
        beginReviewAttempt({ repoRoot: root, request, provider: "claude", model: "claude-opus-5" }),
      ).toEqual({ ok: false, reason: "attempt_outcome_indeterminate" });
    } finally {
      cleanup(root);
    }
  });
});
