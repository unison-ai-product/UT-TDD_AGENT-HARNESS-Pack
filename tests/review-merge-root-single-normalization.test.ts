import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type MergeGateFacts, runPrMerge } from "../src/feedback/review-merge-gate.ts";

const head = "a".repeat(40);

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function facts(): MergeGateFacts {
  return {
    pr: 397,
    headSha: head,
    evaluatedHeadSha: head,
    state: "OPEN",
    checksGreen: true,
  };
}

function seedPass(root: string): void {
  const reviewRoot = join(root, ".ut-tdd", "review");
  mkdirSync(join(reviewRoot, "requests"), { recursive: true });
  mkdirSync(join(reviewRoot, "receipts"), { recursive: true });
  writeFileSync(
    join(reviewRoot, "requests", "request.json"),
    JSON.stringify({
      memoryId: "memory:review-397",
      pr: 397,
      exactHead: head,
      reviewRevision: "review-r1",
      authorFamily: "claude",
      requestedAt: "2026-08-25T03:00:00.000Z",
    }),
    "utf8",
  );
  writeFileSync(
    join(reviewRoot, "receipts", "receipt.json"),
    JSON.stringify({
      memoryId: "memory:review-397",
      pr: 397,
      head,
      reviewRevision: "review-r1",
      reviewerFamily: "codex",
      kind: "verdict",
      verdict: "PASS",
      blockingFindings: [],
      at: "2026-08-25T03:05:00.000Z",
    }),
    "utf8",
  );
}

describe("review merge custody root normalization", () => {
  it("U-RVROOT-MERGE-001: nested invocation reads root evidence and writes the gate receipt at the Git toplevel", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-rvmg-root-"));
    try {
      writeFileSync(join(root, "README.md"), "fixture\n", "utf8");
      git(root, ["init", "--quiet"]);
      git(root, ["config", "user.email", "fixture@example.invalid"]);
      git(root, ["config", "user.name", "UT-TDD fixture"]);
      git(root, ["add", "README.md"]);
      git(root, ["commit", "--quiet", "-m", "fixture"]);
      seedPass(root);
      const nested = join(root, "nested", "cwd");
      mkdirSync(nested, { recursive: true });
      const result = runPrMerge({
        repoRoot: nested,
        pr: 397,
        now: () => "2026-08-25T03:10:00.000Z",
        ports: {
          getPullRequest: () => facts(),
          mergePullRequest: () => undefined,
        },
      });

      expect(result).toMatchObject({ ok: true, decision: "merge", verdict: "PASS" });
      expect(result.receiptPath).toContain(join(realpathSync.native(root), ".ut-tdd", "logs"));
      expect(existsSync(join(nested, ".ut-tdd", "logs"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
