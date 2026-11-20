import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Command } from "commander";
import { expect, it, vi } from "vitest";
import { registerLiveReviewCommands } from "../src/cli/review-live.ts";
import {
  issueReviewRequest,
  type ReviewVerdictProjectionResult,
} from "../src/feedback/review-attestation.ts";
import type { ClaudeReviewInboxEntry } from "../src/runtime/claude-memory-wake.ts";
import { ensureTrackedProjectIdentity } from "./support/project-identity-fixture.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const gh = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    execFileSync: (...args: Parameters<typeof original.execFileSync>) =>
      args[0] === "gh" ? gh(...args) : Reflect.apply(original.execFileSync, undefined, args),
  };
});

function writeReviewFixture(root: string) {
  ensureTrackedProjectIdentity(root, "fixture/gh-comment-timeout");
  const memoryDirectory = join(root, ".ut-tdd", "memory");
  mkdirSync(memoryDirectory, { recursive: true });
  const memoryPath = join(memoryDirectory, "feedback-review-task.md");
  const request = {
    memoryId: "memory:review-task",
    pr: 319,
    exactHead: "a".repeat(40),
    reviewRevision: "review-publish-timeout",
    authorFamily: "codex" as const,
    requestedAt: "2026-08-14T00:00:00.000Z",
  };
  writeFileSync(
    memoryPath,
    [
      "---",
      "memory_id: memory:review-task",
      "kind: feedback",
      'title: "Review task"',
      "tags: []",
      "updated_at: 2026-08-14T00:00:00.000Z",
      "---",
      "Review task",
    ].join("\n"),
  );
  const issued = issueReviewRequest({ repoRoot: root, request });
  if (!issued.ok) throw new Error("review request fixture could not be issued");
  const envelope: ClaudeReviewInboxEntry = {
    schemaVersion: "ut-tdd.claude-inbox/v3",
    purpose: "review",
    id: "memory:review-task:review",
    memoryId: request.memoryId,
    body: "Review task",
    originRuntime: "codex",
    operationId: request.reviewRevision,
    targetWorkspaceId: "b".repeat(64),
    createdAt: request.requestedAt,
    requestDigest: issued.digest,
    requestPath: relative(root, issued.path).replaceAll("\\", "/"),
    memoryPath: relative(root, memoryPath).replaceAll("\\", "/"),
    pr: request.pr,
    exactHead: request.exactHead,
    reviewRevision: request.reviewRevision,
    authorFamily: request.authorFamily,
  };
  const envelopePath = join(root, "envelope.json");
  writeFileSync(envelopePath, JSON.stringify(envelope));
  const projection: Extract<ReviewVerdictProjectionResult, { ok: true }> = {
    ok: true,
    path: join(root, ".ut-tdd", "review", "receipts", "receipt.json"),
    digest: "test-receipt",
    receipt: {
      memoryId: request.memoryId,
      pr: request.pr,
      head: request.exactHead,
      reviewRevision: request.reviewRevision,
      reviewerFamily: "claude",
      kind: "verdict",
      verdict: "PASS",
      blockingFindings: [],
      at: "2026-08-14T00:01:00.000Z",
    },
  };
  return { envelopePath, projection };
}

it("U-CMDINPUT-028: live-consume reports a timed-out publish without retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "ut-gh-comment-timeout-"));
  const originalExitCode = process.exitCode;
  try {
    const { envelopePath, projection } = writeReviewFixture(root);
    gh.mockImplementation(() => {
      throw Object.assign(new Error("gh comment timed out"), {
        code: "ETIMEDOUT",
        stdout: '{"url":"https://example.invalid/comment"}',
      });
    });
    const program = new Command().exitOverride();
    registerLiveReviewCommands(program.command("review"), {
      repoRoot: () => root,
      providerAvailable: () => true,
      runReview: () => projection,
    });

    let output = "";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await program.parseAsync([
        "node",
        "ut-tdd",
        "review",
        "live-consume",
        "--envelope",
        envelopePath,
        "--json",
      ]);
    } finally {
      stdout.mockRestore();
    }

    expect(gh).toHaveBeenCalledTimes(1);
    const [command, args, options] = gh.mock.calls[0];
    expect(command).toBe("gh");
    expect(args).toEqual([
      "pr",
      "comment",
      "319",
      "--body",
      expect.stringContaining("receiptDigest=test-receipt"),
    ]);
    expect(options?.stdio).toEqual(["ignore", "ignore", "pipe"]);
    expect(JSON.parse(output)).toEqual({ ok: false, reason: "derived_verdict_publish_failed" });
    expect(process.exitCode).toBe(1);
  } finally {
    gh.mockReset();
    process.exitCode = originalExitCode;
    removeTestTree(root);
  }
});
