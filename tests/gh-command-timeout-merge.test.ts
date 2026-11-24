import type { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runPrMerge } from "../src/feedback/review-merge-gate.ts";
import { createGhPrMergePorts } from "../src/feedback/review-merge-github.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const head = "a".repeat(40);
const otherHead = "b".repeat(40);
const now = "2026-11-18T00:00:00.000Z";
const prView = (headRefOid = head) =>
  JSON.stringify({
    headRefOid,
    state: "OPEN",
    statusCheckRollup: [{ name: "harness-check", conclusion: "SUCCESS" }],
  });

interface CapturedCall {
  command: string;
  args: string[];
  options: { timeout?: unknown; env?: Record<string, string | undefined> };
}

function spyExecFileSync(
  respond: (call: CapturedCall, index: number) => string | Buffer | undefined,
  calls: CapturedCall[],
): typeof execFileSync {
  return ((command: string, args: string[], options: CapturedCall["options"]) => {
    const call = { command, args: [...args], options: options ?? {} };
    calls.push(call);
    return respond(call, calls.length - 1);
  }) as typeof execFileSync;
}

function seedReview(root: string): void {
  const requests = join(root, ".ut-tdd", "review", "requests");
  const receipts = join(root, ".ut-tdd", "review", "receipts");
  mkdirSync(requests, { recursive: true });
  mkdirSync(receipts, { recursive: true });
  writeFileSync(
    join(requests, "request.json"),
    JSON.stringify({
      memoryId: "review:465:head:1",
      pr: 465,
      exactHead: head,
      reviewRevision: "review-r1",
      authorFamily: "claude",
      requestedAt: "2026-11-18T00:00:00.000Z",
    }),
    "utf8",
  );
  writeFileSync(
    join(receipts, "receipt.json"),
    JSON.stringify({
      memoryId: "review:465:head:1",
      pr: 465,
      head,
      reviewRevision: "review-r1",
      reviewerFamily: "codex",
      kind: "verdict",
      verdict: "PASS",
      blockingFindings: [],
      at: "2026-11-18T00:00:00.000Z",
    }),
    "utf8",
  );
}

describe("gh command timeout and prompt controls for PR merge ports", () => {
  it("control: valid get observations and merge call reach the injected gh entry", () => {
    const calls: CapturedCall[] = [];
    const exec = spyExecFileSync((call, index) => {
      if (call.args[1] === "view") return prView(index === 0 ? head : otherHead);
      return undefined;
    }, calls);
    const ports = createGhPrMergePorts({ execFileSync: exec });

    const facts = ports.getPullRequest(465);
    ports.mergePullRequest(465, head);

    expect(facts).toMatchObject({
      pr: 465,
      headSha: head,
      evaluatedHeadSha: otherHead,
      checksGreen: true,
    });
    expect(calls.map(({ command, args }) => [command, ...args])).toEqual([
      ["gh", "pr", "view", "465", "--json", "headRefOid,state,statusCheckRollup"],
      ["gh", "pr", "view", "465", "--json", "headRefOid,state,statusCheckRollup"],
      ["gh", "pr", "merge", "465", "--merge", "--match-head-commit", head],
    ]);
  });

  it("U-CMDINPUT-018: getPullRequest は二つの観測に30秒timeoutを設定する", () => {
    const calls: CapturedCall[] = [];
    const exec = spyExecFileSync(() => prView(), calls);
    const facts = createGhPrMergePorts({ execFileSync: exec }).getPullRequest(465);

    expect(facts).toMatchObject({ pr: 465, headSha: head, evaluatedHeadSha: head });
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.options.timeout)).toEqual([30_000, 30_000]);
  });

  it("U-CMDINPUT-019: getPullRequest は両観測でprompt抑止envを保つ", () => {
    const priorPrompt = process.env.GH_PROMPT_DISABLED;
    const priorSentinel = process.env.UT_TDD_GH_TIMEOUT_SENTINEL;
    process.env.GH_PROMPT_DISABLED = "0";
    process.env.UT_TDD_GH_TIMEOUT_SENTINEL = "kept";
    try {
      const calls: CapturedCall[] = [];
      const exec = spyExecFileSync(() => prView(), calls);
      const facts = createGhPrMergePorts({ execFileSync: exec }).getPullRequest(465);

      expect(facts).toMatchObject({ pr: 465, headSha: head, evaluatedHeadSha: head });
      expect(calls).toHaveLength(2);
      expect(calls.map((call) => call.options.env?.GH_PROMPT_DISABLED)).toEqual(["1", "1"]);
      expect(calls.map((call) => call.options.env?.UT_TDD_GH_TIMEOUT_SENTINEL)).toEqual([
        "kept",
        "kept",
      ]);
    } finally {
      if (priorPrompt === undefined) delete process.env.GH_PROMPT_DISABLED;
      else process.env.GH_PROMPT_DISABLED = priorPrompt;
      if (priorSentinel === undefined) delete process.env.UT_TDD_GH_TIMEOUT_SENTINEL;
      else process.env.UT_TDD_GH_TIMEOUT_SENTINEL = priorSentinel;
    }
  });

  it("U-CMDINPUT-018: mergePullRequest は30秒timeoutを設定する", () => {
    const calls: CapturedCall[] = [];
    const exec = spyExecFileSync(() => undefined, calls);
    createGhPrMergePorts({ execFileSync: exec }).mergePullRequest(465, head);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["pr", "merge", "465", "--merge", "--match-head-commit", head]);
    expect(calls[0]?.options.timeout).toBe(30_000);
  });

  it("U-CMDINPUT-019: mergePullRequest はprompt抑止envを保つ", () => {
    const priorPrompt = process.env.GH_PROMPT_DISABLED;
    const priorSentinel = process.env.UT_TDD_GH_TIMEOUT_SENTINEL;
    process.env.GH_PROMPT_DISABLED = "0";
    process.env.UT_TDD_GH_TIMEOUT_SENTINEL = "kept";
    try {
      const calls: CapturedCall[] = [];
      const exec = spyExecFileSync(() => undefined, calls);
      createGhPrMergePorts({ execFileSync: exec }).mergePullRequest(465, head);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.args).toEqual([
        "pr",
        "merge",
        "465",
        "--merge",
        "--match-head-commit",
        head,
      ]);
      expect(calls[0]?.options.env?.GH_PROMPT_DISABLED).toBe("1");
      expect(calls[0]?.options.env?.UT_TDD_GH_TIMEOUT_SENTINEL).toBe("kept");
    } finally {
      if (priorPrompt === undefined) delete process.env.GH_PROMPT_DISABLED;
      else process.env.GH_PROMPT_DISABLED = priorPrompt;
      if (priorSentinel === undefined) delete process.env.UT_TDD_GH_TIMEOUT_SENTINEL;
      else process.env.UT_TDD_GH_TIMEOUT_SENTINEL = priorSentinel;
    }
  });

  it("U-CMDINPUT-022: PR read ETIMEDOUT はmerge前にfail-closeする", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-gh-timeout-read-"));
    try {
      const calls: CapturedCall[] = [];
      const exec = spyExecFileSync(() => {
        throw Object.assign(new Error("gh read timed out"), {
          code: "ETIMEDOUT",
          stdout: Buffer.from(prView()),
        });
      }, calls);
      const result = runPrMerge({
        repoRoot: root,
        pr: 465,
        now: () => now,
        ports: {
          ...createGhPrMergePorts({ execFileSync: exec }),
          checkBaselineConflict: () => null,
        },
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("gh_fetch_failed");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.args[1]).toBe("view");
      expect(calls.some((call) => call.args[1] === "merge")).toBe(false);
    } finally {
      removeTestTree(root);
    }
  });

  it("U-CMDINPUT-023: merge mutation ETIMEDOUT は一度だけ呼びmerge_failedを返す", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-gh-timeout-merge-"));
    try {
      seedReview(root);
      const calls: CapturedCall[] = [];
      const exec = spyExecFileSync((call) => {
        if (call.args[1] === "view") return prView();
        throw Object.assign(new Error("gh merge timed out"), {
          code: "ETIMEDOUT",
          stdout: Buffer.from("Successfully merged PR #465\n"),
        });
      }, calls);
      const result = runPrMerge({
        repoRoot: root,
        pr: 465,
        now: () => now,
        ports: {
          ...createGhPrMergePorts({ execFileSync: exec }),
          checkBaselineConflict: () => null,
        },
      });

      expect(result.ok).toBe(false);
      expect(result.decision).toBe("merge_failed");
      expect(result.reason).toMatch(/^gh_merge_failed:/);
      expect(calls.filter((call) => call.args[1] === "view")).toHaveLength(2);
      expect(calls.filter((call) => call.args[1] === "merge")).toHaveLength(1);
    } finally {
      removeTestTree(root);
    }
  });
});
