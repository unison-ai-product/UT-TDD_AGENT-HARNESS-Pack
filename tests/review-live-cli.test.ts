import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeReviewVerdictEditRule } from "../src/cli/delegation.ts";
import {
  executeLiveReviewDelegation,
  registerLiveReviewCommands,
  validateLiveReviewSubject,
} from "../src/cli/review-live.ts";
import {
  issueReviewRequest,
  type ReviewVerdictProjectionResult,
} from "../src/feedback/review-attestation.ts";
import type { ClaudeReviewInboxEntry } from "../src/runtime/claude-memory-wake.ts";
import { resolveProjectMemoryRoot } from "../src/runtime/project-memory-root.ts";
import { ensureTrackedProjectIdentity } from "./support/project-identity-fixture.ts";

const head = "a".repeat(40);
const roots: string[] = [];

function fixture(): {
  root: string;
  envelopePath: string;
  memoryPath: string;
  envelope: ClaudeReviewInboxEntry;
} {
  const root = mkdtempSync(join(tmpdir(), "ut-review-live-cli-"));
  roots.push(root);
  ensureTrackedProjectIdentity(root, "fixture/review-live-cli");
  const memoryDirectory = join(root, ".ut-tdd", "memory");
  mkdirSync(memoryDirectory, { recursive: true });
  const memoryPath = join(memoryDirectory, "feedback-d3a.md");
  writeFileSync(
    memoryPath,
    [
      "---",
      "memory_id: memory:d3a",
      "kind: feedback",
      'title: "D3a"',
      "tags: []",
      "updated_at: 2026-08-14T00:00:00.000Z",
      "---",
      "review task",
    ].join("\n"),
    "utf8",
  );
  const request = {
    memoryId: "memory:d3a",
    pr: 319,
    exactHead: head,
    reviewRevision: "review-d3a-cli",
    authorFamily: "codex" as const,
    requestedAt: "2026-08-14T00:00:00.000Z",
  };
  const issued = issueReviewRequest({ repoRoot: root, request });
  if (!issued.ok) throw new Error("fixture request failed");
  const canonicalRequest = issued.request;
  const envelope: ClaudeReviewInboxEntry = {
    schemaVersion: "ut-tdd.claude-inbox/v3",
    purpose: "review",
    id: "memory:d3a:review",
    memoryId: canonicalRequest.memoryId,
    body: "identity must not be read from this prose",
    originRuntime: "codex",
    operationId: "review-d3a-cli",
    targetWorkspaceId: "b".repeat(64),
    createdAt: canonicalRequest.requestedAt,
    requestDigest: issued.digest,
    requestPath: relative(root, issued.path).replaceAll("\\", "/"),
    memoryPath: relative(root, memoryPath).replaceAll("\\", "/"),
    pr: canonicalRequest.pr,
    exactHead: canonicalRequest.exactHead,
    reviewRevision: canonicalRequest.reviewRevision,
    authorFamily: canonicalRequest.authorFamily,
  };
  const envelopePath = join(root, "envelope.json");
  writeFileSync(envelopePath, JSON.stringify(envelope), "utf8");
  return { root, envelopePath, memoryPath, envelope };
}

function wakeInboxRoot(root: string): string {
  const project = resolveProjectMemoryRoot(root);
  if (!project.ok) throw new Error(project.reason);
  return join(project.runtimeBusRoot, "claude-memory-wake", "inbox");
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe("review live CLI composition", () => {
  it("U-RVATT-042 validates a real commit and exact PR HEAD before dispatch", () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const run = (command: string, args: readonly string[]) => {
      calls.push({ command, args });
      if (command === "git") return { status: 0, stdout: "" };
      return { status: 0, stdout: `${head}\n` };
    };

    expect(validateLiveReviewSubject({ repoRoot: "repo", pr: 319, head, run })).toEqual({
      ok: true,
    });
    expect(calls).toEqual([
      { command: "git", args: ["cat-file", "-e", `${head}^{commit}`] },
      { command: "gh", args: ["pr", "view", "319", "--json", "headRefOid", "--jq", ".headRefOid"] },
    ]);
  });

  it.each([
    [{ status: 1, stdout: "" }, { status: 0, stdout: `${head}\n` }, "exact_head_not_found"],
    [{ status: 0, stdout: "" }, { status: 1, stdout: "" }, "pull_request_head_unavailable"],
    [
      { status: 0, stdout: "" },
      { status: 0, stdout: "not-a-sha\n" },
      "pull_request_head_unavailable",
    ],
    [
      { status: 0, stdout: "" },
      { status: 0, stdout: `${"b".repeat(40)}\n` },
      "pull_request_head_mismatch",
    ],
  ] as const)("U-RVATT-042 fails closed as %s", (gitResult, ghResult, reason) => {
    const run = vi.fn().mockReturnValueOnce(gitResult).mockReturnValueOnce(ghResult);
    expect(validateLiveReviewSubject({ repoRoot: "repo", pr: 319, head, run })).toEqual({
      ok: false,
      reason,
    });
  });

  it("U-MEMWAKE-007: routes the derived wake to the live workspace while preserving request identity", async () => {
    const { root, memoryPath } = fixture();
    execFileSync("git", ["init", "-q"], { cwd: root });
    const targetWorkspaceId = "f".repeat(64);
    const program = new Command().exitOverride();
    registerLiveReviewCommands(program.command("review"), {
      repoRoot: () => root,
      providerAvailable: () => true,
      validateReviewSubject: () => ({ ok: true }),
      resolveWakeTarget: () => ({
        ok: true,
        workspaceId: targetWorkspaceId,
        sessionId: "claude-session",
      }),
    });
    const originalWrite = process.stdout.write;
    const originalExitCode = process.exitCode;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await program.parseAsync([
        "node",
        "ut-tdd",
        "review",
        "live-dispatch",
        "--memory-id",
        "memory:d3a",
        "--memory-path",
        relative(root, memoryPath).replaceAll("\\", "/"),
        "--pr",
        "319",
        "--head",
        head,
        "--revision",
        "review-d3a-routing",
        "--author-family",
        "codex",
        "--json",
      ]);
    } finally {
      process.stdout.write = originalWrite;
      process.exitCode = originalExitCode;
    }
    const inbox = wakeInboxRoot(root);
    const files = readdirSync(inbox).filter((name) => name.endsWith(".json"));
    expect(files).toHaveLength(1);
    const envelope = JSON.parse(readFileSync(join(inbox, files[0]), "utf8")) as Record<
      string,
      unknown
    >;
    const requestFiles = readdirSync(join(root, ".ut-tdd", "review", "requests"));
    expect(requestFiles).toHaveLength(1);
    const requestPath = join(root, ".ut-tdd", "review", "requests", requestFiles[0]);
    const request = JSON.parse(readFileSync(requestPath, "utf8")) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      targetWorkspaceId,
      exactHead: head,
      pr: 319,
      reviewRevision: request.reviewRevision,
    });
    const envelopeIdentity = statSync(envelope.requestPath as string, { bigint: true });
    const requestIdentity = statSync(requestPath, { bigint: true });
    expect({ dev: envelopeIdentity.dev, ino: envelopeIdentity.ino }).toEqual({
      dev: requestIdentity.dev,
      ino: requestIdentity.ino,
    });
  });

  it("U-MEMWAKE-007: keeps the canonical request as backlog when no live target exists", async () => {
    const { root, memoryPath } = fixture();
    execFileSync("git", ["init", "-q"], { cwd: root });
    const program = new Command().exitOverride();
    registerLiveReviewCommands(program.command("review"), {
      repoRoot: () => root,
      providerAvailable: () => true,
      validateReviewSubject: () => ({ ok: true }),
      resolveWakeTarget: () => ({ ok: false, reason: "no_live_claude_workspace" }),
    });
    const originalWrite = process.stdout.write;
    const originalExitCode = process.exitCode;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await program.parseAsync([
        "node",
        "ut-tdd",
        "review",
        "live-dispatch",
        "--memory-id",
        "memory:d3a",
        "--memory-path",
        relative(root, memoryPath).replaceAll("\\", "/"),
        "--pr",
        "319",
        "--head",
        head,
        "--revision",
        "review-d3a-no-target",
        "--author-family",
        "codex",
        "--json",
      ]);
    } finally {
      process.stdout.write = originalWrite;
      process.exitCode = originalExitCode;
    }
    const requests = readdirSync(join(root, ".ut-tdd", "review", "requests"));
    expect(requests).toHaveLength(1);
    expect(() => readdirSync(wakeInboxRoot(root))).toThrow();
  });

  it("U-RVATT-024: does not resolve Claude workspace for a Codex reviewer", async () => {
    const { root, memoryPath } = fixture();
    execFileSync("git", ["init", "-q"], { cwd: root });
    const resolveWakeTarget = vi.fn(() => ({
      ok: true as const,
      workspaceId: "f".repeat(64),
      sessionId: "claude-session",
    }));
    const program = new Command().exitOverride();
    registerLiveReviewCommands(program.command("review"), {
      repoRoot: () => root,
      providerAvailable: () => true,
      validateReviewSubject: () => ({ ok: true }),
      resolveWakeTarget,
    });
    const originalWrite = process.stdout.write;
    const originalExitCode = process.exitCode;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await program.parseAsync([
        "node",
        "ut-tdd",
        "review",
        "live-dispatch",
        "--memory-id",
        "memory:d3a",
        "--memory-path",
        relative(root, memoryPath).replaceAll("\\", "/"),
        "--pr",
        "319",
        "--head",
        head,
        "--revision",
        "review-d3a-codex-target",
        "--author-family",
        "claude",
        "--json",
      ]);
    } finally {
      process.stdout.write = originalWrite;
      process.exitCode = originalExitCode;
    }
    expect(resolveWakeTarget).not.toHaveBeenCalled();
    expect(() => readdirSync(wakeInboxRoot(root))).toThrow();
    const requests = readdirSync(join(root, ".ut-tdd", "review", "requests"));
    expect(requests).toHaveLength(2);
    expect(
      requests.filter((name) => {
        const request = JSON.parse(
          readFileSync(join(root, ".ut-tdd", "review", "requests", name), "utf8"),
        ) as { authorFamily?: string };
        return request.authorFamily === "claude";
      }),
    ).toHaveLength(1);
  });

  it("U-RVATT-024: uses an injected Codex wake surface without touching Claude workspace", async () => {
    const { root, memoryPath } = fixture();
    execFileSync("git", ["init", "-q"], { cwd: root });
    const resolveWakeTarget = vi.fn(() => ({
      ok: true as const,
      workspaceId: "f".repeat(64),
      sessionId: "claude-session",
    }));
    const publishCodexReviewWake = vi.fn();
    const program = new Command().exitOverride();
    registerLiveReviewCommands(program.command("review"), {
      repoRoot: () => root,
      providerAvailable: () => true,
      validateReviewSubject: () => ({ ok: true }),
      resolveWakeTarget,
      publishCodexReviewWake,
    });
    const originalWrite = process.stdout.write;
    const originalExitCode = process.exitCode;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await program.parseAsync([
        "node",
        "ut-tdd",
        "review",
        "live-dispatch",
        "--memory-id",
        "memory:d3a",
        "--memory-path",
        relative(root, memoryPath).replaceAll("\\", "/"),
        "--pr",
        "319",
        "--head",
        head,
        "--revision",
        "review-d3a-codex-surface",
        "--author-family",
        "claude",
        "--json",
      ]);
    } finally {
      process.stdout.write = originalWrite;
      process.exitCode = originalExitCode;
    }
    expect(resolveWakeTarget).not.toHaveBeenCalled();
    expect(publishCodexReviewWake).toHaveBeenCalledWith(
      realpathSync.native(root),
      expect.objectContaining({ purpose: "review", reviewer: "codex" }),
    );
    expect(() => readdirSync(wakeInboxRoot(root))).toThrow();
  });

  it("U-RVATT-031 grants Claude only the consumer-derived exact verdict path", () => {
    const root = join(tmpdir(), "ut-review-permission-root");
    const digest = "c".repeat(64);
    const verdict = join(
      root,
      ".ut-tdd",
      "review",
      "verdicts",
      digest,
      "attempts",
      "attempt-2",
      "verdict.txt",
    );

    expect(claudeReviewVerdictEditRule(root, verdict)).toBe(
      `Edit(.ut-tdd/review/verdicts/${digest}/attempts/attempt-2/verdict.txt)`,
    );
    expect(claudeReviewVerdictEditRule(root, join(root, "src", "cli.ts"))).toBeUndefined();
    expect(claudeReviewVerdictEditRule(root, join(root, "..", "verdict.txt"))).toBeUndefined();
  });

  it("U-RVATT-027 executes canonical task resolution and delegated-review argv before publishing", async () => {
    const { root, envelopePath, memoryPath, envelope } = fixture();
    const projection: Extract<ReviewVerdictProjectionResult, { ok: true }> = {
      ok: true,
      path: join(root, ".ut-tdd", "review", "receipts", "receipt.json"),
      digest: "receipt-digest",
      receipt: {
        memoryId: "memory:d3a",
        pr: 319,
        head,
        reviewRevision: envelope.reviewRevision,
        reviewerFamily: "claude",
        kind: "verdict",
        verdict: "PASS",
        blockingFindings: [],
        at: "2026-08-14T00:01:00.000Z",
      },
    };
    const runReview = vi.fn(
      (_input: { repoRoot: string; provider: "codex" | "claude"; args: readonly string[] }) =>
        projection,
    );
    const publishReceipt = vi.fn();
    const program = new Command().exitOverride();
    registerLiveReviewCommands(program.command("review"), {
      repoRoot: () => root,
      providerAvailable: () => true,
      runReview,
      publishReceipt,
    });
    const originalWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
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
      process.stdout.write = originalWrite;
    }
    expect(runReview).toHaveBeenCalledTimes(1);
    const call = runReview.mock.calls[0]?.[0];
    expect(call).toEqual({
      repoRoot: expect.any(String),
      provider: "claude",
      args: expect.arrayContaining([
        "--review-head",
        head,
        "--review-author-family",
        "codex",
        "--execute",
      ]),
    });
    expect(realpathSync.native(call?.repoRoot as string)).toBe(realpathSync.native(root));
    const taskFileIndex = call?.args.indexOf("--task-file") ?? -1;
    expect(taskFileIndex).toBeGreaterThanOrEqual(0);
    expect(realpathSync.native(call?.args[taskFileIndex + 1] as string)).toBe(
      realpathSync.native(memoryPath),
    );
    expect(publishReceipt).toHaveBeenCalledWith(call?.repoRoot, projection);
  });

  it("U-RVATT-036 obtains receipt provider/model/role/time/exit facts through the real delegation CLI", () => {
    const { root, memoryPath } = fixture();
    const binRoot = mkdtempSync(join(tmpdir(), "ut-review-provider-"));
    roots.push(binRoot);
    const helper = join(binRoot, "write-verdict.cjs");
    writeFileSync(
      helper,
      String.raw`const fs = require("node:fs");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const fields = [
    "schema_version", "request_digest", "attempt", "pr", "exact_head",
    "review_revision", "reviewer_provider", "reviewer_model", "invocation_nonce",
  ].map((key) => {
    const match = prompt.match(new RegExp("^" + key + ":\\s*(.*)$", "m"));
    return key + ": " + (match ? match[1].trim() : "");
  }).join("\n");
  fs.writeFileSync(process.env.UT_TDD_REVIEW_VERDICT_FILE, fields + "\nVERDICT: PASS\n", "utf8");
  process.stdout.write("VERDICT: PASS\n");
});
`,
      "utf8",
    );
    const stub = join(binRoot, process.platform === "win32" ? "claude.cmd" : "claude");
    writeFileSync(
      stub,
      process.platform === "win32"
        ? `@echo off\r\nif "%~1"=="--version" (echo claude 0.0.0-stub& exit /b 0)\r\nnode "${helper}"\r\nexit /b 0\r\n`
        : `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "claude 0.0.0-stub"; exit 0; fi\nexec node "${helper}"\n`,
      "utf8",
    );
    if (process.platform !== "win32") chmodSync(stub, 0o755);
    const previous = process.env.UT_TDD_CLAUDE_BIN;
    process.env.UT_TDD_CLAUDE_BIN = stub;
    try {
      const result = executeLiveReviewDelegation({
        repoRoot: root,
        cliPath: join(process.cwd(), "src", "cli.ts"),
        provider: "claude",
        args: [
          "--role",
          "blind-reviewer",
          "--task-file",
          memoryPath,
          "--review-pr",
          "319",
          "--review-head",
          head,
          "--review-revision",
          "review-d3a-cli",
          "--review-author-family",
          "codex",
          "--review-memory-id",
          "memory:d3a",
          "--execute",
          "--json",
        ],
      });
      expect(result, JSON.stringify(result)).toMatchObject({
        ok: true,
        receipt: {
          memoryId: "memory:d3a",
          pr: 319,
          head,
          reviewRevision: expect.stringMatching(/^rv1-[a-f0-9]{64}$/),
          reviewerFamily: "claude",
          verdict: "PASS",
        },
      });
    } finally {
      if (previous === undefined) delete process.env.UT_TDD_CLAUDE_BIN;
      else process.env.UT_TDD_CLAUDE_BIN = previous;
    }
  }, 30_000);

  it("U-RVATT-029 lets a reviewer that never reads env write the verdict file from the injected literal path", () => {
    // 2026-08-14 実測: delegated Claude が `VERDICT: PASS` を stdout へ返しながら
    // UT_TDD_REVIEW_VERDICT_FILE の値を解決できず (permission が env / printenv / echo $VAR を
    // 拒否)、verdict file 0 → receipt 0 → wrapper deny という恒久 fail が起きた。
    // この stub は env を一切参照せず、契約本文へ埋め込まれた literal path だけで書く。
    // 契約が env 名しか渡さない実装へ戻ると path を抽出できず receipt が立たない (RED)。
    const { root, memoryPath } = fixture();
    const binRoot = mkdtempSync(join(tmpdir(), "ut-review-provider-noenv-"));
    roots.push(binRoot);
    const helper = join(binRoot, "write-verdict.cjs");
    writeFileSync(
      helper,
      String.raw`const fs = require("node:fs");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  // 環境変数は一切参照しない。契約本文に埋め込まれた literal path だけを使う。
  const match = prompt.match(/([A-Za-z]:[\\/][^\s"'()]*verdict\.txt|\/[^\s"'()]*verdict\.txt)/);
  if (!match) {
    process.stdout.write("no literal verdict path in contract\n");
    process.exit(0);
  }
  const fields = [
    "schema_version", "request_digest", "attempt", "pr", "exact_head",
    "review_revision", "reviewer_provider", "reviewer_model", "invocation_nonce",
  ].map((key) => {
    const field = prompt.match(new RegExp("^" + key + ":\\s*(.*)$", "m"));
    return key + ": " + (field ? field[1].trim() : "");
  }).join("\n");
  fs.writeFileSync(match[1], fields + "\nVERDICT: PASS\n", "utf8");
  process.stdout.write("VERDICT: PASS\n");
});
`,
      "utf8",
    );
    const stub = join(binRoot, process.platform === "win32" ? "claude.cmd" : "claude");
    writeFileSync(
      stub,
      process.platform === "win32"
        ? `@echo off\r\nif "%~1"=="--version" (echo claude 0.0.0-stub& exit /b 0)\r\nnode "${helper}"\r\nexit /b 0\r\n`
        : `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "claude 0.0.0-stub"; exit 0; fi\nexec node "${helper}"\n`,
      "utf8",
    );
    if (process.platform !== "win32") chmodSync(stub, 0o755);
    const previous = process.env.UT_TDD_CLAUDE_BIN;
    process.env.UT_TDD_CLAUDE_BIN = stub;
    try {
      const result = executeLiveReviewDelegation({
        repoRoot: root,
        cliPath: join(process.cwd(), "src", "cli.ts"),
        provider: "claude",
        args: [
          "--role",
          "blind-reviewer",
          "--task-file",
          memoryPath,
          "--review-pr",
          "319",
          "--review-head",
          head,
          "--review-revision",
          "review-d3a-noenv",
          "--review-author-family",
          "codex",
          "--review-memory-id",
          "memory:d3a",
          "--execute",
          "--json",
        ],
      });
      expect(result, JSON.stringify(result)).toMatchObject({
        ok: true,
        receipt: { pr: 319, head, reviewerFamily: "claude", verdict: "PASS" },
      });
    } finally {
      if (previous === undefined) delete process.env.UT_TDD_CLAUDE_BIN;
      else process.env.UT_TDD_CLAUDE_BIN = previous;
    }
  }, 30_000);
});
