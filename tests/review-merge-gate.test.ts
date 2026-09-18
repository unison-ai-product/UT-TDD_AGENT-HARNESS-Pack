import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerPrMergeCommands } from "../src/cli/pr-merge.ts";
import { analyzeReviewDispatch } from "../src/feedback/review-dispatch.ts";
import {
  createGhPrMergePorts,
  evaluateMergeGate,
  type GhPrMergePorts,
  type MergeGateFacts,
  runPrMerge,
} from "../src/feedback/review-merge-gate.ts";

const head = "a".repeat(40);
const otherHead = "b".repeat(40);
const now = "2026-08-07T01:00:00.000Z";

function facts(overrides: Partial<MergeGateFacts> = {}): MergeGateFacts {
  return {
    pr: 465,
    headSha: head,
    evaluatedHeadSha: head,
    state: "OPEN",
    checksGreen: true,
    ...overrides,
  };
}

function seedReview(root: string, verdict?: "PASS" | "FLAG", reviewHead = head): void {
  const requests = join(root, ".ut-tdd", "review", "requests");
  const receipts = join(root, ".ut-tdd", "review", "receipts");
  mkdirSync(requests, { recursive: true });
  mkdirSync(receipts, { recursive: true });
  writeFileSync(
    join(requests, "request.json"),
    JSON.stringify({
      memoryId: "review:465:head:1",
      pr: 465,
      exactHead: reviewHead,
      reviewRevision: "review-r1",
      authorFamily: "claude",
      requestedAt: "2026-08-07T00:30:00.000Z",
    }),
    { encoding: "utf8", flag: "w" },
  );
  if (verdict) {
    writeFileSync(
      join(receipts, "receipt.json"),
      JSON.stringify({
        memoryId: "review:465:head:1",
        pr: 465,
        head: reviewHead,
        reviewRevision: "review-r1",
        reviewerFamily: "codex",
        kind: "verdict",
        verdict,
        blockingFindings: verdict === "FLAG" ? ["finding"] : [],
        at: "2026-08-07T00:45:00.000Z",
      }),
      { encoding: "utf8", flag: "w" },
    );
  }
}

function writeRequest(
  root: string,
  input: {
    file: string;
    memoryId: string;
    reviewRevision: string;
    exactHead?: string;
    authorFamily?: "claude" | "codex";
  },
): void {
  const requests = join(root, ".ut-tdd", "review", "requests");
  mkdirSync(requests, { recursive: true });
  writeFileSync(
    join(requests, input.file),
    JSON.stringify({
      memoryId: input.memoryId,
      pr: 465,
      exactHead: input.exactHead ?? head,
      reviewRevision: input.reviewRevision,
      authorFamily: input.authorFamily ?? "claude",
      requestedAt: "2026-08-07T00:30:00.000Z",
    }),
    "utf8",
  );
}

function writeVerdict(
  root: string,
  input: {
    file: string;
    memoryId: string;
    reviewRevision: string;
    verdict: "PASS" | "FLAG";
    head?: string;
    reviewerFamily?: "claude" | "codex";
  },
): void {
  const receipts = join(root, ".ut-tdd", "review", "receipts");
  mkdirSync(receipts, { recursive: true });
  writeFileSync(
    join(receipts, input.file),
    JSON.stringify({
      memoryId: input.memoryId,
      pr: 465,
      head: input.head ?? head,
      reviewRevision: input.reviewRevision,
      reviewerFamily: input.reviewerFamily ?? "codex",
      kind: "verdict",
      verdict: input.verdict,
      blockingFindings: input.verdict === "FLAG" ? ["finding"] : [],
      at: "2026-08-07T00:45:00.000Z",
    }),
    "utf8",
  );
}

function seedHistoricalReview(root: string): void {
  writeRequest(root, {
    file: "old-request.json",
    memoryId: "review:465:old-head",
    exactHead: otherHead,
    reviewRevision: "review-old",
  });
  writeRequest(root, {
    file: "current-request.json",
    memoryId: "review:465:current-head",
    exactHead: head,
    reviewRevision: "review-current",
  });
  writeVerdict(root, {
    file: "old-flag.json",
    memoryId: "review:465:old-head",
    reviewRevision: "review-old",
    head: otherHead,
    verdict: "FLAG",
  });
  writeVerdict(root, {
    file: "current-pass.json",
    memoryId: "review:465:current-head",
    reviewRevision: "review-current",
    verdict: "PASS",
  });
}

function ports(
  input: { getFacts?: () => MergeGateFacts; merge?: () => void } = {},
): GhPrMergePorts {
  return {
    getPullRequest: input.getFacts ?? (() => facts()),
    mergePullRequest: input.merge ?? (() => undefined),
  };
}

function receipt(root: string): Record<string, unknown> {
  const log = readdirSync(join(root, ".ut-tdd", "logs")).find((name) => name.endsWith(".jsonl"));
  if (!log) throw new Error("merge receipt not written");
  const lines = readFileSync(join(root, ".ut-tdd", "logs", log), "utf8")
    .trim()
    .split("\n");
  return JSON.parse(lines.at(-1) ?? "") as Record<string, unknown>;
}

describe("D2-B PR merge gate", () => {
  it("U-RVHEAD-001: old HEAD FLAG は現 HEAD PASSを妨げず、監査entryは保持する", () => {
    const oldRequest = {
      memoryId: "review:465:old-head",
      pr: 465,
      exactHead: otherHead,
      reviewRevision: "review-old",
      authorFamily: "claude" as const,
      requestedAt: "2026-08-07T00:30:00.000Z",
    };
    const currentRequest = {
      memoryId: "review:465:current-head",
      pr: 465,
      exactHead: head,
      reviewRevision: "review-current",
      authorFamily: "claude" as const,
      requestedAt: "2026-08-07T00:40:00.000Z",
    };
    const oldFlag = {
      ...oldRequest,
      head: otherHead,
      reviewerFamily: "codex" as const,
      kind: "verdict" as const,
      verdict: "FLAG" as const,
      blockingFindings: ["old finding"],
      at: "2026-08-07T00:45:00.000Z",
    };
    const currentPass = {
      ...currentRequest,
      head: head,
      reviewerFamily: "codex" as const,
      kind: "verdict" as const,
      verdict: "PASS" as const,
      at: "2026-08-07T00:50:00.000Z",
    };
    const currentFacts = facts();
    const decision = evaluateMergeGate({
      pr: 465,
      requests: [oldRequest, currentRequest],
      receipts: [oldFlag, currentPass],
      facts: currentFacts,
      now,
    });
    const audit = analyzeReviewDispatch({
      requests: [oldRequest, currentRequest],
      receipts: [oldFlag, currentPass],
      prs: [currentFacts],
      now,
    });

    expect(decision.ok).toBe(true);
    expect(audit.entries).toHaveLength(2);
    expect(audit.entries.find((entry) => entry.exactHead === otherHead)).toMatchObject({
      verdict: "FLAG",
      blocking: ["old finding"],
      state: "stale_head",
    });
  });

  it("U-RVHEAD-002: same HEAD FLAG はPASS併存でもblockingを維持する", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-rvmg-"));
    try {
      writeRequest(root, {
        file: "current-request.json",
        memoryId: "review:465:current-head",
        exactHead: head,
        reviewRevision: "review-current",
      });
      writeVerdict(root, {
        file: "current-flag.json",
        memoryId: "review:465:current-head",
        reviewRevision: "review-current",
        verdict: "FLAG",
      });
      writeVerdict(root, {
        file: "current-pass.json",
        memoryId: "review:465:current-head",
        reviewRevision: "review-current",
        verdict: "PASS",
      });
      const result = runPrMerge({ repoRoot: root, pr: 465, now: () => now, ports: ports() });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("flagged");
      expect(result.decision).toBe("deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RVHEAD-003: HEAD変更後にcurrent receiptが無ければold evidenceだけでは許可しない", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-rvmg-"));
    try {
      writeRequest(root, {
        file: "old-request.json",
        memoryId: "review:465:old-head",
        exactHead: otherHead,
        reviewRevision: "review-old",
      });
      writeVerdict(root, {
        file: "old-pass.json",
        memoryId: "review:465:old-head",
        reviewRevision: "review-old",
        head: otherHead,
        verdict: "PASS",
      });
      const result = runPrMerge({ repoRoot: root, pr: 465, now: () => now, ports: ports() });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("no_request_for_current_head");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RVHEAD-004: repository root/worktree配置は同一evidenceの判定を変えない", () => {
    const roots = [
      mkdtempSync(join(tmpdir(), "ut-tdd-rvmg-root-")),
      mkdtempSync(join(tmpdir(), "ut-tdd-rvmg-worktree-")),
    ];
    try {
      const results = roots.map((root) => {
        seedHistoricalReview(root);
        return runPrMerge({ repoRoot: root, pr: 465, now: () => now, ports: ports() });
      });
      expect(results[0]).toMatchObject({ ok: true, decision: "merge", verdict: "PASS" });
      expect({ ...results[0], receiptPath: null }).toEqual({ ...results[1], receiptPath: null });
    } finally {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RVHEAD-005/U-RVHEAD-006: linked worktreeとnested checkoutのreview evidenceは配置に依存せず共有される", () => {
    const repository = mkdtempSync(join(tmpdir(), "ut-tdd-rvmg-git-"));
    const linkedWorktree = mkdtempSync(join(tmpdir(), "ut-tdd-rvmg-linked-"));
    try {
      writeFileSync(join(repository, "README.md"), "fixture\n", "utf8");
      execFileSync("git", ["-C", repository, "init", "-q"]);
      execFileSync("git", ["-C", repository, "config", "user.email", "fixture@example.test"]);
      execFileSync("git", ["-C", repository, "config", "user.name", "fixture"]);
      execFileSync("git", ["-C", repository, "add", "README.md"]);
      execFileSync("git", ["-C", repository, "commit", "-q", "-m", "fixture"]);
      rmSync(linkedWorktree, { recursive: true, force: true });
      execFileSync(
        "git",
        ["-C", repository, "worktree", "add", "--detach", linkedWorktree, "HEAD"],
        {
          stdio: "ignore",
        },
      );

      // The review request/receipt are produced in one checkout, while the
      // merge command is intentionally run from its sibling checkout.
      seedReview(repository, "PASS");
      const result = runPrMerge({
        repoRoot: linkedWorktree,
        pr: 465,
        now: () => now,
        ports: ports(),
      });
      expect(result).toMatchObject({ ok: true, decision: "merge", verdict: "PASS" });

      // A same-head FLAG in the other checkout must remain blocking even
      // when a PASS receipt exists in the first checkout.
      writeVerdict(linkedWorktree, {
        file: "same-head-flag.json",
        memoryId: "review:465:head:1",
        reviewRevision: "review-r1",
        verdict: "FLAG",
      });
      const flagged = runPrMerge({
        repoRoot: linkedWorktree,
        pr: 465,
        now: () => now,
        ports: ports(),
      });
      expect(flagged).toMatchObject({ ok: false, decision: "deny", verdict: "FLAG" });
      expect(flagged.reason).toContain("flagged");

      // A caller may invoke the gate from a nested checkout directory. The
      // same root evidence must still be visible and the result receipt must
      // stay at the Git toplevel rather than under the nested path.
      const nested = join(linkedWorktree, "nested");
      mkdirSync(nested);
      const fromNested = runPrMerge({
        repoRoot: nested,
        pr: 465,
        now: () => now,
        ports: ports(),
      });
      expect(fromNested).toMatchObject({ ok: false, decision: "deny", verdict: "FLAG" });
      expect(existsSync(join(linkedWorktree, ".ut-tdd", "logs", "review-merge-gate.jsonl"))).toBe(
        true,
      );
    } finally {
      try {
        execFileSync("git", ["-C", repository, "worktree", "remove", "--force", linkedWorktree], {
          stdio: "ignore",
        });
      } catch {
        // Cleanup below still removes the isolated fixture if Git already did.
      }
      rmSync(linkedWorktree, { recursive: true, force: true });
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it("U-RVMG-001: merge_ready の exact HEAD だけを merge し receipt を残す", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-rvmg-"));
    let merged = false;
    try {
      seedReview(root, "PASS");
      const result = runPrMerge({
        repoRoot: root,
        pr: 465,
        now: () => now,
        ports: ports({
          merge: () => {
            merged = true;
          },
        }),
      });
      expect(result.ok).toBe(true);
      expect(merged).toBe(true);
      expect(receipt(root)).toMatchObject({
        pr: 465,
        headSha: head,
        verdict: "PASS",
        decision: "merge",
        reason: "merge_ready",
        timestamp: now,
        receiptKind: "merge_result",
        authorizedEntry: {
          memoryId: "review:465:head:1",
          reviewRevision: "review-r1",
          reviewerFamily: "codex",
        },
      });

      const receipts = readFileSync(
        join(root, ".ut-tdd", "logs", "review-merge-gate.jsonl"),
        "utf8",
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(receipts.map((item) => item.receiptKind)).toEqual(["merge_intent", "merge_result"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RVMG-002: FLAG は fail-close で判定 entry の verdict を receipt に束縛する", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-rvmg-"));
    let merged = false;
    try {
      writeRequest(root, {
        file: "request-a.json",
        memoryId: "review:465:head:a",
        reviewRevision: "review-ra",
      });
      writeRequest(root, {
        file: "request-b.json",
        memoryId: "review:465:head:b",
        reviewRevision: "review-rb",
      });
      writeVerdict(root, {
        file: "a-flag.json",
        memoryId: "review:465:head:b",
        reviewRevision: "review-rb",
        verdict: "FLAG",
      });
      writeVerdict(root, {
        file: "z-pass.json",
        memoryId: "review:465:head:a",
        reviewRevision: "review-ra",
        verdict: "PASS",
      });
      const result = runPrMerge({
        repoRoot: root,
        pr: 465,
        now: () => now,
        ports: ports({
          merge: () => {
            merged = true;
          },
        }),
      });
      expect(result.ok).toBe(false);
      expect(merged).toBe(false);
      expect(result.verdict).toBe("FLAG");
      expect(receipt(root)).toMatchObject({
        pr: 465,
        headSha: head,
        verdict: "FLAG",
        decision: "deny",
        authorizedEntry: {
          memoryId: "review:465:head:b",
          reviewRevision: "review-rb",
          reviewerFamily: "codex",
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RVMG-014: deny receipt は候補の順序・入力形に依存せず未確定なら束縛しない", () => {
    const cases = ["review:465:head:a", "review:465:head:b"] as const;
    const receipts = cases.map((flagMemoryId) => {
      const root = mkdtempSync(join(tmpdir(), "ut-tdd-rvmg-"));
      try {
        for (const memoryId of cases) {
          writeRequest(root, {
            file: `${memoryId.endsWith(":a") ? "a" : "b"}-request.json`,
            memoryId,
            reviewRevision: `review-r${memoryId.endsWith(":a") ? "a" : "b"}`,
          });
        }
        writeVerdict(root, {
          file: "verdict.json",
          memoryId: flagMemoryId,
          reviewRevision: `review-r${flagMemoryId.endsWith(":a") ? "a" : "b"}`,
          verdict: "FLAG",
        });
        const result = runPrMerge({ repoRoot: root, pr: 465, now: () => now, ports: ports() });
        expect(result.ok).toBe(false);
        return receipt(root);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    expect(receipts[0]).toEqual(receipts[1]);
    expect(receipts[0]).toMatchObject({
      verdict: null,
      decision: "deny",
      authorizedEntry: null,
    });

    const passPendingRoot = mkdtempSync(join(tmpdir(), "ut-tdd-rvmg-"));
    try {
      writeRequest(passPendingRoot, {
        file: "a-request.json",
        memoryId: "review:465:head:a",
        reviewRevision: "review-ra",
      });
      writeRequest(passPendingRoot, {
        file: "b-request.json",
        memoryId: "review:465:head:b",
        reviewRevision: "review-rb",
      });
      writeVerdict(passPendingRoot, {
        file: "a-pass.json",
        memoryId: "review:465:head:a",
        reviewRevision: "review-ra",
        verdict: "PASS",
      });
      const result = runPrMerge({
        repoRoot: passPendingRoot,
        pr: 465,
        now: () => now,
        ports: ports(),
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("pending_request_for_head");
      expect(result.verdict).toBeNull();
      expect(receipt(passPendingRoot)).toMatchObject({
        verdict: null,
        decision: "deny",
        authorizedEntry: null,
      });
    } finally {
      rmSync(passPendingRoot, { recursive: true, force: true });
    }

    const multipleVerdictRoot = mkdtempSync(join(tmpdir(), "ut-tdd-rvmg-"));
    try {
      for (const memoryId of cases) {
        writeRequest(multipleVerdictRoot, {
          file: `${memoryId.endsWith(":a") ? "a" : "b"}-request.json`,
          memoryId,
          reviewRevision: `review-r${memoryId.endsWith(":a") ? "a" : "b"}`,
        });
        writeVerdict(multipleVerdictRoot, {
          file: `${memoryId.endsWith(":a") ? "a" : "b"}-pass.json`,
          memoryId,
          reviewRevision: `review-r${memoryId.endsWith(":a") ? "a" : "b"}`,
          verdict: "PASS",
        });
      }
      const result = runPrMerge({
        repoRoot: multipleVerdictRoot,
        pr: 465,
        now: () => now,
        ports: ports({ getFacts: () => facts({ checksGreen: false }) }),
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("state:verdict");
      expect(result.verdict).toBeNull();
      expect(receipt(multipleVerdictRoot)).toMatchObject({
        verdict: null,
        decision: "deny",
        authorizedEntry: null,
      });
    } finally {
      rmSync(multipleVerdictRoot, { recursive: true, force: true });
    }

    const orphanReceiptRoot = mkdtempSync(join(tmpdir(), "ut-tdd-rvmg-"));
    try {
      seedReview(orphanReceiptRoot, "PASS");
      writeVerdict(orphanReceiptRoot, {
        file: "orphan-pass.json",
        memoryId: "review:465:head:orphan",
        reviewRevision: "review-ro",
        verdict: "PASS",
      });
      const result = runPrMerge({
        repoRoot: orphanReceiptRoot,
        pr: 465,
        now: () => now,
        ports: ports(),
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("orphan_receipt");
      expect(result.verdict).toBeNull();
      expect(receipt(orphanReceiptRoot)).toMatchObject({
        verdict: null,
        decision: "deny",
        authorizedEntry: null,
      });
    } finally {
      rmSync(orphanReceiptRoot, { recursive: true, force: true });
    }
  });

  it("U-RVMG-003: verdict 無しは fail-close で receipt を残す", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-rvmg-"));
    try {
      seedReview(root);
      const result = runPrMerge({ repoRoot: root, pr: 465, now: () => now, ports: ports() });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("verdict");
      expect(receipt(root)).toMatchObject({
        pr: 465,
        headSha: head,
        verdict: null,
        decision: "deny",
        authorizedEntry: null,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RVMG-004: HEAD mismatch は breach 側へ倒し merge しない", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-rvmg-"));
    try {
      seedReview(root, "PASS");
      const result = runPrMerge({
        repoRoot: root,
        pr: 465,
        now: () => now,
        ports: ports({ getFacts: () => facts({ evaluatedHeadSha: otherHead }) }),
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("head_mismatch");
      expect(receipt(root)).toMatchObject({ headSha: head, decision: "deny" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RVMG-005: gh の PR 取得失敗は fail-close で receipt を残す", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-rvmg-"));
    try {
      const result = runPrMerge({
        repoRoot: root,
        pr: 465,
        now: () => now,
        ports: ports({
          getFacts: () => {
            throw new Error("gh unavailable");
          },
        }),
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("gh");
      expect(receipt(root)).toMatchObject({ pr: 465, headSha: null, decision: "deny" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RVMG-006: merge 失敗でも wrapper receipt を残す", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-rvmg-"));
    try {
      seedReview(root, "PASS");
      const result = runPrMerge({
        repoRoot: root,
        pr: 465,
        now: () => now,
        ports: ports({
          merge: () => {
            throw new Error("merge rejected");
          },
        }),
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("merge");
      expect(receipt(root)).toMatchObject({
        pr: 465,
        headSha: head,
        verdict: "PASS",
        decision: "merge_failed",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RVMG-007: 同一 exact HEAD の pending request は SLA 経過に関係なく merge を拒否する", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-rvmg-"));
    try {
      seedReview(root, "PASS");
      writeRequest(root, {
        file: "request-pending.json",
        memoryId: "review:465:head:2",
        reviewRevision: "review-r2",
      });
      const atThirtyMinutes = runPrMerge({
        repoRoot: root,
        pr: 465,
        now: () => "2026-08-07T01:00:00.000Z",
        ports: ports(),
      });
      const atTwoHours = runPrMerge({
        repoRoot: root,
        pr: 465,
        now: () => "2026-08-07T02:30:00.000Z",
        ports: ports(),
      });

      expect(atThirtyMinutes.ok).toBe(false);
      expect(atTwoHours.ok).toBe(false);
      expect(atThirtyMinutes.reason).toContain("pending_request_for_head");
      expect(atTwoHours.reason).toContain("pending_request_for_head");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RVMG-008: CLI の非数値 PR は invalid_pr と exit 1 で拒否する", async () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-rvmg-cli-"));
    const previousExitCode = process.exitCode;
    try {
      const program = new Command();
      let output = "";
      const write = process.stdout.write;
      process.stdout.write = ((chunk: string) => {
        output += chunk;
        return true;
      }) as typeof process.stdout.write;
      process.exitCode = 0;
      try {
        registerPrMergeCommands(program, { ports: ports(), repoRoot: root });
        await program.parseAsync(["node", "ut-tdd", "pr", "merge", "--pr", "abc", "--json"]);
      } finally {
        process.stdout.write = write;
      }
      expect(process.exitCode).toBe(1);
      expect(JSON.parse(output)).toMatchObject({ ok: false, reason: "invalid_pr" });
    } finally {
      process.exitCode = previousExitCode;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RVMG-009: CLI の deny は exit 1 を返す", async () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-rvmg-cli-"));
    const previousExitCode = process.exitCode;
    try {
      const program = new Command();
      registerPrMergeCommands(program, { ports: ports(), repoRoot: root });
      process.exitCode = 0;
      await program.parseAsync(["node", "ut-tdd", "pr", "merge", "--pr", "465", "--json"]);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RVMG-010: 空または conclusion 欠落の statusCheckRollup は checksGreen=false とする", () => {
    const outputs = [
      JSON.stringify({ headRefOid: head, state: "OPEN", statusCheckRollup: [] }),
      JSON.stringify({
        headRefOid: head,
        state: "OPEN",
        statusCheckRollup: [{ status: "COMPLETED" }],
      }),
    ];
    for (const output of outputs) {
      const exec = ((..._args: unknown[]) => {
        return output;
      }) as never;
      const result = createGhPrMergePorts({ execFileSync: exec }).getPullRequest(465);
      expect(result.checksGreen).toBe(false);
    }
  });

  it("U-RVMG-011: adapter の第二観測と gh merge は exact HEAD に束縛される", () => {
    const snapshots = [
      JSON.stringify({ headRefOid: head, state: "OPEN", statusCheckRollup: [] }),
      JSON.stringify({ headRefOid: otherHead, state: "OPEN", statusCheckRollup: [] }),
    ];
    let observed = 0;
    const exec = ((..._args: unknown[]) => snapshots[observed++]) as never;
    const result = createGhPrMergePorts({ execFileSync: exec }).getPullRequest(465);
    expect(observed).toBe(2);
    expect(result.headSha).toBe(head);
    expect(result.evaluatedHeadSha).toBe(otherHead);
    const calls: unknown[][] = [];
    const mergeExec = ((...args: unknown[]) => {
      calls.push(args);
      return "";
    }) as never;
    createGhPrMergePorts({ execFileSync: mergeExec }).mergePullRequest(465, head);
    expect(calls).toEqual([
      ["gh", ["pr", "merge", "465", "--merge", "--match-head-commit", head], { stdio: "inherit" }],
    ]);
  });

  it("U-RVMG-012: intent receipt が書けない場合は merge せず fail-close する", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-rvmg-"));
    let merged = false;
    try {
      mkdirSync(join(root, ".ut-tdd"), { recursive: true });
      writeFileSync(join(root, ".ut-tdd", "logs"), "not a directory", "utf8");
      seedReview(root, "PASS");
      const result = runPrMerge({
        repoRoot: root,
        pr: 465,
        now: () => now,
        ports: ports({
          merge: () => {
            merged = true;
          },
        }),
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("intent_receipt_write_failed");
      expect(merged).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RVMG-013: result receipt が書けない場合は警告付きで exit failure 相当になる", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-rvmg-"));
    try {
      seedReview(root, "PASS");
      const result = runPrMerge({
        repoRoot: root,
        pr: 465,
        now: () => now,
        ports: ports({
          merge: () => {
            const resultPath = join(root, ".ut-tdd", "logs", "review-merge-gate.jsonl");
            rmSync(resultPath);
            mkdirSync(resultPath);
          },
        }),
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("result_receipt_write_failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
