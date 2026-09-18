import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveLiveReviewTaskFile } from "../src/cli/review-live.ts";
import {
  consumeLiveReview,
  dispatchLiveReview,
  type LiveReviewProjectionPorts,
  type LiveReviewRequestInput,
  type LiveReviewVerdictPorts,
  oppositeReviewProvider,
  publishLiveReviewVerdict,
} from "../src/feedback/live-review-projection.ts";
import { scanPostMergeBackstop } from "../src/feedback/post-merge-backstop.ts";
import type {
  ReviewAttestation,
  ReviewAttestationRequest,
  ReviewRequestResult,
  ReviewVerdictProjectionResult,
} from "../src/feedback/review-attestation.ts";
import { issueReviewRequest, projectReviewVerdict } from "../src/feedback/review-attestation.ts";
import { runPrMerge } from "../src/feedback/review-merge-gate.ts";
import type { ClaudeReviewInboxEntry } from "../src/runtime/claude-memory-wake.ts";
import { ensureTrackedProjectIdentity } from "./support/project-identity-fixture.ts";

const head = "a".repeat(40);
const canonicalRequest: ReviewAttestationRequest = {
  memoryId: "memory:d3a",
  pr: 218,
  exactHead: head,
  reviewRevision: "review-d3a-1",
  authorFamily: "codex",
  requestedAt: "2026-08-14T00:00:00.000Z",
};
const liveRequest: LiveReviewRequestInput = {
  ...canonicalRequest,
  memoryPath: ".ut-tdd/memory/feedback-d3a.md",
};
const issued: Extract<ReviewRequestResult, { ok: true }> = {
  ok: true,
  request: canonicalRequest,
  path: ".ut-tdd/review/requests/d3a.json",
  digest: "d3a-request",
};
const attestation: ReviewAttestation = {
  provider: "claude",
  role: "blind-reviewer",
  model: "claude-opus-5",
  pr: 218,
  head,
  reviewRevision: "review-d3a-1",
  startedAt: "2026-08-14T00:01:00.000Z",
  completedAt: "2026-08-14T00:02:00.000Z",
  exitCode: 0,
};
const projection: Extract<ReviewVerdictProjectionResult, { ok: true }> = {
  ok: true,
  path: ".ut-tdd/review/receipts/d3a.json",
  digest: "d3a-receipt",
  receipt: {
    memoryId: "memory:d3a",
    pr: 218,
    head,
    reviewRevision: "review-d3a-1",
    reviewerFamily: "claude",
    kind: "verdict",
    verdict: "PASS",
    blockingFindings: [],
    at: "2026-08-14T00:02:00.000Z",
  },
};

function requestPorts(
  overrides: Partial<LiveReviewProjectionPorts> = {},
): LiveReviewProjectionPorts {
  return {
    validateSubject: vi.fn(() => ({ ok: true as const })),
    issueRequest: vi.fn(() => issued),
    publishReviewWake: vi.fn(),
    providerAvailable: vi.fn(() => true),
    ...overrides,
  };
}

function verdictPorts(overrides: Partial<LiveReviewVerdictPorts> = {}): LiveReviewVerdictPorts {
  return {
    projectVerdict: vi.fn(() => projection),
    publishPrComment: vi.fn(),
    publishFeedbackMemory: vi.fn(),
    ...overrides,
  };
}

describe("live review projection (U-RVATT-023..026)", () => {
  it("U-RVATT-024 resolves only an identity-matched regular file in canonical memory storage", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-live-review-task-"));
    const outside = mkdtempSync(join(tmpdir(), "ut-live-review-outside-"));
    try {
      ensureTrackedProjectIdentity(root, "fixture/live-review-projection");
      const memoryDirectory = join(root, ".ut-tdd", "memory");
      mkdirSync(memoryDirectory, { recursive: true });
      const sourcePath = ".ut-tdd/memory/feedback-d3a.md";
      const content = [
        "---",
        "memory_id: memory:d3a",
        "kind: feedback",
        'title: "D3a"',
        "tags: []",
        "updated_at: 2026-08-14T00:00:00.000Z",
        "---",
        "review task",
      ].join("\n");
      writeFileSync(join(root, sourcePath), content, "utf8");
      const resolved = resolveLiveReviewTaskFile(root, {
        memoryId: "memory:d3a",
        memoryPath: sourcePath,
      });
      expect(resolved).not.toBeNull();
      expect(realpathSync.native(resolved as string)).toBe(
        realpathSync.native(join(root, sourcePath)),
      );
      expect(
        resolveLiveReviewTaskFile(root, { memoryId: "memory:wrong", memoryPath: sourcePath }),
      ).toBeNull();
      const outsidePath = join(outside, "outside.md");
      writeFileSync(outsidePath, content, "utf8");
      expect(
        resolveLiveReviewTaskFile(root, { memoryId: "memory:d3a", memoryPath: outsidePath }),
      ).toBeNull();

      rmSync(memoryDirectory, { recursive: true, force: true });
      symlinkSync(outside, memoryDirectory, process.platform === "win32" ? "junction" : "dir");
      expect(() =>
        resolveLiveReviewTaskFile(root, { memoryId: "memory:d3a", memoryPath: sourcePath }),
      ).toThrow("project_memory_root_authored_memory_root_escape");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
  it("U-RVATT-023 persists the canonical request before publishing one typed wake", () => {
    const order: string[] = [];
    const ports = requestPorts({
      issueRequest: vi.fn(() => {
        order.push("request");
        return issued;
      }),
      publishReviewWake: vi.fn((wake) => {
        order.push("wake");
        expect(wake).toEqual({
          purpose: "review",
          reviewer: "claude",
          requestDigest: issued.digest,
          requestPath: issued.path,
          request: canonicalRequest,
          memoryPath: liveRequest.memoryPath,
        });
      }),
    });

    expect(dispatchLiveReview({ repoRoot: "repo", request: liveRequest, ports })).toMatchObject({
      ok: true,
      reviewer: "claude",
    });
    expect(order).toEqual(["request", "wake"]);
  });

  it("U-RVATT-023 never wakes when canonical persistence fails", () => {
    const ports = requestPorts({
      issueRequest: vi.fn(() => ({ ok: false as const, reason: "invalid_review_request" })),
    });
    expect(dispatchLiveReview({ repoRoot: "repo", request: liveRequest, ports })).toEqual({
      ok: false,
      reason: "invalid_review_request",
    });
    expect(ports.publishReviewWake).not.toHaveBeenCalled();
  });

  it.each([
    "exact_head_not_found",
    "pull_request_head_unavailable",
    "pull_request_head_mismatch",
  ] as const)("U-RVATT-042 denies %s before canonical persistence", (reason) => {
    const ports = requestPorts({
      validateSubject: vi.fn(() => ({ ok: false as const, reason })),
    });

    expect(dispatchLiveReview({ repoRoot: "repo", request: liveRequest, ports })).toEqual({
      ok: false,
      reason,
    });
    expect(ports.issueRequest).not.toHaveBeenCalled();
    expect(ports.publishReviewWake).not.toHaveBeenCalled();
  });

  it.each([
    ["codex", "claude"],
    ["claude", "codex"],
    ["other", null],
  ] as const)("U-RVATT-024 routes author %s to reviewer %s", (author, reviewer) => {
    expect(oppositeReviewProvider(author)).toBe(reviewer);
  });

  it("U-RVATT-024 denies unknown and unavailable opposite providers without writing", () => {
    const unavailable = requestPorts({ providerAvailable: vi.fn(() => false) });
    expect(
      dispatchLiveReview({ repoRoot: "repo", request: liveRequest, ports: unavailable }),
    ).toEqual({
      ok: false,
      reason: "opposite_provider_unavailable",
    });
    expect(unavailable.issueRequest).not.toHaveBeenCalled();

    const unknown = requestPorts();
    expect(
      dispatchLiveReview({
        repoRoot: "repo",
        request: { ...liveRequest, authorFamily: "unknown" as "codex" },
        ports: unknown,
      }),
    ).toEqual({ ok: false, reason: "unknown_author_family" });
    expect(unknown.issueRequest).not.toHaveBeenCalled();
  });

  it("U-RVATT-024 carries the opposite reviewer into wake routing", () => {
    const request = { ...liveRequest, authorFamily: "claude" as const };
    const publishReviewWake = vi.fn();
    const ports = requestPorts({ publishReviewWake });

    expect(dispatchLiveReview({ repoRoot: "repo", request, ports })).toMatchObject({
      ok: true,
      reviewer: "codex",
    });
    expect(publishReviewWake).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "review", reviewer: "codex" }),
    );
  });

  it("U-RVATT-024 consumes strict canonical identity through the opposite provider CLI", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-live-review-"));
    try {
      const memoryPath = join(root, ".ut-tdd", "memory", "feedback-d3a.md");
      mkdirSync(join(root, ".ut-tdd", "memory"), { recursive: true });
      writeFileSync(memoryPath, "review task", { encoding: "utf8", flag: "wx" });
      const canonical = issueReviewRequest({ repoRoot: root, request: canonicalRequest });
      expect(canonical.ok).toBe(true);
      if (!canonical.ok) return;
      const envelope: ClaudeReviewInboxEntry = {
        schemaVersion: "ut-tdd.claude-inbox/v3",
        purpose: "review",
        id: "memory:d3a:review",
        memoryId: canonicalRequest.memoryId,
        body: "untrusted prose must not provide identity",
        originRuntime: "codex",
        operationId: "review-d3a",
        targetWorkspaceId: "a".repeat(64),
        createdAt: "2026-08-14T00:00:00.000Z",
        requestDigest: canonical.digest,
        requestPath: relative(root, canonical.path),
        memoryPath: relative(root, memoryPath),
        pr: canonicalRequest.pr,
        exactHead: canonicalRequest.exactHead,
        reviewRevision: canonicalRequest.reviewRevision,
        authorFamily: canonicalRequest.authorFamily,
      };
      const order: string[] = [];
      const runReview = vi.fn(() => {
        order.push("receipt");
        return projection;
      });
      expect(
        consumeLiveReview({
          repoRoot: root,
          envelope,
          ports: {
            providerAvailable: vi.fn(() => true),
            resolveTaskFile: vi.fn(() => memoryPath),
            runReview,
            publishReceipt: vi.fn(() => order.push("publish")),
          },
        }),
      ).toEqual({ ok: true, projection });
      expect(runReview).toHaveBeenCalledWith({
        provider: "claude",
        args: [
          "--role",
          "blind-reviewer",
          "--task-file",
          memoryPath,
          "--review-pr",
          "218",
          "--review-head",
          head,
          "--review-revision",
          "review-d3a-1",
          "--review-author-family",
          "codex",
          "--review-memory-id",
          "memory:d3a",
          "--execute",
          "--json",
        ],
      });
      expect(order).toEqual(["receipt", "publish"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RVATT-026 rejects tampered, unavailable, same-family, and missing receipt paths", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-live-review-deny-"));
    try {
      const memoryPath = join(root, ".ut-tdd", "memory", "feedback-d3a.md");
      mkdirSync(join(root, ".ut-tdd", "memory"), { recursive: true });
      writeFileSync(memoryPath, "review task", { encoding: "utf8", flag: "wx" });
      const canonical = issueReviewRequest({ repoRoot: root, request: canonicalRequest });
      if (!canonical.ok) throw new Error("fixture");
      const envelope: ClaudeReviewInboxEntry = {
        schemaVersion: "ut-tdd.claude-inbox/v3",
        purpose: "review",
        id: "memory:d3a:review",
        memoryId: canonicalRequest.memoryId,
        body: "task",
        originRuntime: "codex",
        operationId: "review-d3a",
        targetWorkspaceId: "a".repeat(64),
        createdAt: canonicalRequest.requestedAt,
        requestDigest: canonical.digest,
        requestPath: relative(root, canonical.path),
        memoryPath: relative(root, memoryPath),
        pr: 218,
        exactHead: head,
        reviewRevision: "review-d3a-1",
        authorFamily: "codex",
      };
      const runReview = vi.fn(() => projection);
      const publishReceipt = vi.fn();
      expect(
        consumeLiveReview({
          repoRoot: root,
          envelope: { ...envelope, pr: 219 },
          ports: {
            providerAvailable: () => true,
            resolveTaskFile: () => memoryPath,
            runReview,
            publishReceipt,
          },
        }),
      ).toEqual({ ok: false, reason: "invalid_review_envelope" });
      expect(runReview).not.toHaveBeenCalled();
      expect(
        consumeLiveReview({
          repoRoot: root,
          envelope,
          ports: {
            providerAvailable: () => true,
            resolveTaskFile: () => null,
            runReview,
            publishReceipt,
          },
        }),
      ).toEqual({ ok: false, reason: "invalid_review_envelope" });
      expect(
        consumeLiveReview({
          repoRoot: root,
          envelope,
          ports: {
            providerAvailable: () => false,
            resolveTaskFile: () => memoryPath,
            runReview,
            publishReceipt,
          },
        }),
      ).toEqual({ ok: false, reason: "opposite_provider_unavailable" });
      expect(
        consumeLiveReview({
          repoRoot: root,
          envelope,
          ports: {
            providerAvailable: () => true,
            resolveTaskFile: () => memoryPath,
            runReview: () => ({
              ...projection,
              receipt: { ...projection.receipt, reviewerFamily: "codex" },
            }),
            publishReceipt,
          },
        }),
      ).toEqual({ ok: false, reason: "review_identity_mismatch" });
      expect(
        consumeLiveReview({
          repoRoot: root,
          envelope,
          ports: {
            providerAvailable: () => true,
            resolveTaskFile: () => memoryPath,
            runReview: () => ({
              ...projection,
              receipt: { ...projection.receipt, head: "b".repeat(40) },
            }),
            publishReceipt,
          },
        }),
      ).toEqual({ ok: false, reason: "review_identity_mismatch" });
      expect(
        consumeLiveReview({
          repoRoot: root,
          envelope,
          ports: {
            providerAvailable: () => true,
            resolveTaskFile: () => memoryPath,
            runReview: () => ({ ok: false, reason: "review_receipt_missing" }),
            publishReceipt,
          },
        }),
      ).toEqual({ ok: false, reason: "review_receipt_missing" });
      expect(publishReceipt).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RVATT-025 persists the receipt before derived publishers", () => {
    const order: string[] = [];
    const ports = verdictPorts({
      projectVerdict: vi.fn(() => {
        order.push("receipt");
        return projection;
      }),
      publishPrComment: vi.fn(() => {
        order.push("comment");
      }),
      publishFeedbackMemory: vi.fn(() => {
        order.push("memory");
      }),
    });
    expect(
      publishLiveReviewVerdict({
        repoRoot: "repo",
        request: canonicalRequest,
        attestation,
        verdictFile: "verdict.json",
        ports,
      }),
    ).toEqual({ ok: true, projection });
    expect(order).toEqual(["receipt", "comment", "memory"]);
  });

  it("U-RVATT-025 denies same-family facts and projection failure before derived output", () => {
    const sameFamily = verdictPorts();
    expect(
      publishLiveReviewVerdict({
        repoRoot: "repo",
        request: canonicalRequest,
        attestation: { ...attestation, provider: "codex" },
        verdictFile: "verdict.json",
        ports: sameFamily,
      }),
    ).toEqual({ ok: false, reason: "same_family_reviewer_denied" });
    expect(sameFamily.projectVerdict).not.toHaveBeenCalled();

    const failed = verdictPorts({
      projectVerdict: vi.fn(() => ({ ok: false as const, reason: "verdict_invalid" })),
    });
    expect(
      publishLiveReviewVerdict({
        repoRoot: "repo",
        request: canonicalRequest,
        attestation,
        verdictFile: "verdict.json",
        ports: failed,
      }),
    ).toEqual({ ok: false, reason: "verdict_invalid" });
    expect(failed.publishPrComment).not.toHaveBeenCalled();
    expect(failed.publishFeedbackMemory).not.toHaveBeenCalled();
  });

  it("U-RVATT-025 delegates retry convergence to canonical content identities", () => {
    const ports = requestPorts();
    dispatchLiveReview({ repoRoot: "repo", request: liveRequest, ports });
    dispatchLiveReview({ repoRoot: "repo", request: liveRequest, ports });
    expect(ports.issueRequest).toHaveBeenNthCalledWith(1, {
      repoRoot: "repo",
      request: canonicalRequest,
      strict: true,
    });
    expect(ports.issueRequest).toHaveBeenNthCalledWith(2, {
      repoRoot: "repo",
      request: canonicalRequest,
      strict: true,
    });
    expect(ports.publishReviewWake).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        requestDigest: issued.digest,
        requestPath: issued.path,
      }),
    );
    expect(ports.publishReviewWake).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        requestDigest: issued.digest,
        requestPath: issued.path,
      }),
    );

    const receiptPorts = verdictPorts();
    publishLiveReviewVerdict({
      repoRoot: "repo",
      request: canonicalRequest,
      attestation,
      verdictFile: "verdict.json",
      ports: receiptPorts,
    });
    publishLiveReviewVerdict({
      repoRoot: "repo",
      request: canonicalRequest,
      attestation,
      verdictFile: "verdict.json",
      ports: receiptPorts,
    });
    expect(receiptPorts.projectVerdict).toHaveBeenCalledTimes(2);
    expect(receiptPorts.publishPrComment).toHaveBeenNthCalledWith(1, projection);
    expect(receiptPorts.publishPrComment).toHaveBeenNthCalledWith(2, projection);
    expect(receiptPorts.publishFeedbackMemory).toHaveBeenNthCalledWith(1, projection);
    expect(receiptPorts.publishFeedbackMemory).toHaveBeenNthCalledWith(2, projection);
  });

  it("U-RVATT-027 closes dispatch through wrapper admission and post-merge backstop", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-live-review-lifecycle-"));
    try {
      const memoryPath = join(root, liveRequest.memoryPath);
      mkdirSync(join(root, ".ut-tdd", "memory"), { recursive: true });
      writeFileSync(memoryPath, "review task", "utf8");
      const dispatch = dispatchLiveReview({
        repoRoot: root,
        request: liveRequest,
        ports: {
          validateSubject: () => ({ ok: true }),
          issueRequest: (input) =>
            issueReviewRequest({ repoRoot: input.repoRoot, request: input.request }),
          providerAvailable: () => true,
          publishReviewWake: vi.fn(),
        },
      });
      expect(dispatch.ok).toBe(true);

      const verdictFile = join(root, "verdict.txt");
      writeFileSync(verdictFile, "VERDICT: PASS\n", "utf8");
      expect(
        publishLiveReviewVerdict({
          repoRoot: root,
          request: canonicalRequest,
          attestation,
          verdictFile,
          ports: {
            projectVerdict: projectReviewVerdict,
            publishPrComment: vi.fn(),
            publishFeedbackMemory: vi.fn(),
          },
        }).ok,
      ).toBe(true);

      const mergePullRequest = vi.fn();
      const merge = runPrMerge({
        repoRoot: root,
        pr: canonicalRequest.pr,
        now: () => "2026-08-14T02:00:00.000Z",
        ports: {
          getPullRequest: () => ({
            pr: canonicalRequest.pr,
            headSha: head,
            evaluatedHeadSha: head,
            state: "OPEN",
            checksGreen: true,
          }),
          mergePullRequest,
        },
      });
      expect(merge).toMatchObject({ ok: true, decision: "merge", headSha: head });
      expect(mergePullRequest).toHaveBeenCalledWith(canonicalRequest.pr, head);

      const backstop = scanPostMergeBackstop({
        repoRoot: root,
        now: "2026-08-14T03:00:00.000Z",
        fetchMergedPrPage: (page) =>
          page === 1
            ? [
                {
                  number: canonicalRequest.pr,
                  merged_at: "2026-08-14T02:30:00.000Z",
                  merge_commit_sha: "b".repeat(40),
                  head: { sha: head },
                },
              ]
            : [],
      });
      expect(backstop).toMatchObject({ ok: true, detections: [] });

      for (const variant of ["request_missing", "receipt_missing", "stale_head"] as const) {
        const deniedRoot = mkdtempSync(join(tmpdir(), `ut-live-review-${variant}-`));
        try {
          if (variant !== "request_missing") {
            issueReviewRequest({ repoRoot: deniedRoot, request: canonicalRequest });
          }
          const deniedMerge = vi.fn();
          const denied = runPrMerge({
            repoRoot: variant === "stale_head" ? root : deniedRoot,
            pr: canonicalRequest.pr,
            now: () => "2026-08-14T02:00:00.000Z",
            ports: {
              getPullRequest: () => ({
                pr: canonicalRequest.pr,
                headSha: variant === "stale_head" ? "c".repeat(40) : head,
                evaluatedHeadSha: variant === "stale_head" ? "c".repeat(40) : head,
                state: "OPEN",
                checksGreen: true,
              }),
              mergePullRequest: deniedMerge,
            },
          });
          expect(denied).toMatchObject({ ok: false, decision: "deny" });
          expect(deniedMerge).not.toHaveBeenCalled();
        } finally {
          rmSync(deniedRoot, { recursive: true, force: true });
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
