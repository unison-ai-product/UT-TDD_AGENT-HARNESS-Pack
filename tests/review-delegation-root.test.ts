import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeLiveReviewDelegation,
  resolveLiveReviewDelegationEntrypoint,
} from "../src/cli/review-live.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const originalClaudeBin = process.env.UT_TDD_CLAUDE_BIN;

afterEach(() => {
  if (originalClaudeBin === undefined) delete process.env.UT_TDD_CLAUDE_BIN;
  else process.env.UT_TDD_CLAUDE_BIN = originalClaudeBin;
});

describe("#779 Pack-only review delegation entrypoint", () => {
  it("CANDIDATE-U-RVPACK-001: source CLI re-enters the invoked source path", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-rvpack-source-"));
    try {
      const source = join(root, "src", "cli.ts");
      mkdirSync(join(root, "src"));
      writeFileSync(source, "// source CLI\n");
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "ut-tdd", utTdd: { artifactProfile: "source" } }),
      );
      expect(resolveLiveReviewDelegationEntrypoint(root, source)).toEqual({
        ok: true,
        path: source,
      });
      const externalCli = join(root, "external-cli.ts");
      writeFileSync(externalCli, "// launched from another source checkout\n");
      expect(resolveLiveReviewDelegationEntrypoint(root, externalCli)).toEqual({
        ok: true,
        path: source,
      });
    } finally {
      removeTestTree(root);
    }
  });

  it("CANDIDATE-U-RVPACK-002: sealed consumer re-enters through the validating wrapper", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-rvpack-sealed-"));
    try {
      const runtime = join(root, ".ut-tdd", "runtime");
      const entry = join(runtime, "bundles", "generation", "ut-tdd.mjs");
      const wrapper = join(root, ".ut-tdd", "bin", "ut-tdd.mjs");
      mkdirSync(join(runtime, "bundles", "generation"), { recursive: true });
      mkdirSync(join(runtime, "activation"), { recursive: true });
      mkdirSync(join(root, ".ut-tdd", "bin"), { recursive: true });
      writeFileSync(entry, "// sealed CLI\n");
      writeFileSync(wrapper, "// validating wrapper\n");
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "cli.ts"), "// unrelated product CLI\n");
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "canary-product" }));
      writeFileSync(
        join(runtime, "activation", "active.json"),
        JSON.stringify({ entry_path: entry }),
      );
      expect(resolveLiveReviewDelegationEntrypoint(root, entry)).toEqual({
        ok: true,
        path: realpathSync.native(wrapper),
      });
      const foreign = join(root, "foreign-cli.mjs");
      writeFileSync(foreign, "// wrong entry\n");
      expect(resolveLiveReviewDelegationEntrypoint(root, foreign)).toEqual({
        ok: false,
        reason: "consumer_runtime_identity_mismatch",
      });
      expect(resolveLiveReviewDelegationEntrypoint(root, undefined)).toEqual({
        ok: false,
        reason: "consumer_runtime_resolution_denied",
      });
      writeFileSync(
        join(runtime, "activation", "active.json"),
        JSON.stringify({ entry_path: foreign }),
      );
      expect(resolveLiveReviewDelegationEntrypoint(root, entry)).toEqual({
        ok: false,
        reason: "consumer_runtime_identity_mismatch",
      });
    } finally {
      removeTestTree(root);
    }
  });

  it("CANDIDATE-U-RVPACK-003: default delegation spawns the consumer wrapper and writes a receipt without source CLI", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-rvpack-default-"));
    const originalArgv1 = process.argv[1];
    try {
      const runtime = join(root, ".ut-tdd", "runtime");
      const entry = join(runtime, "bundles", "generation", "ut-tdd.mjs");
      const wrapper = join(root, ".ut-tdd", "bin", "ut-tdd.mjs");
      const receipt = join(root, ".ut-tdd", "review", "receipts", "fixture.json");
      mkdirSync(dirname(entry), { recursive: true });
      mkdirSync(dirname(wrapper), { recursive: true });
      mkdirSync(join(runtime, "activation"), { recursive: true });
      writeFileSync(entry, "// sealed consumer entry\n");
      writeFileSync(
        join(runtime, "activation", "active.json"),
        JSON.stringify({ entry_path: entry }),
      );
      writeFileSync(
        wrapper,
        [
          'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',
          'import { dirname, join } from "node:path";',
          "const root = process.cwd();",
          'const pointer = JSON.parse(readFileSync(join(root, ".ut-tdd/runtime/activation/active.json"), "utf8"));',
          'if (pointer.entry_path !== process.env.RVPACK_EXPECTED_ENTRY || process.argv[2] !== "claude") process.exit(3);',
          'const receipt = join(root, ".ut-tdd/review/receipts/fixture.json");',
          "mkdirSync(dirname(receipt), { recursive: true });",
          'writeFileSync(receipt, JSON.stringify({ verdict: "PASS" }));',
          'console.log(JSON.stringify({ review: { ok: true, receipt: { verdict: "PASS" }, path: receipt, digest: "fixture" } }));',
        ].join("\n"),
      );
      expect(existsSync(join(root, "src", "cli.ts"))).toBe(false);
      process.argv[1] = entry;
      process.env.RVPACK_EXPECTED_ENTRY = entry;
      const result = executeLiveReviewDelegation({ repoRoot: root, provider: "claude", args: [] });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.path).toBe(receipt);
      expect(existsSync(receipt)).toBe(true);
    } finally {
      process.argv[1] = originalArgv1;
      delete process.env.RVPACK_EXPECTED_ENTRY;
      removeTestTree(root);
    }
  });

  it("CANDIDATE-U-RVPACK-004: absent and mismatched runtime entries have distinct typed reasons", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-rvpack-reasons-"));
    try {
      const entry = join(root, "entry.mjs");
      writeFileSync(entry, "// invoked entry\n");
      expect(resolveLiveReviewDelegationEntrypoint(root, entry)).toEqual({
        ok: false,
        reason: "consumer_runtime_absent",
      });
      const originalArgv1 = process.argv[1];
      try {
        process.argv[1] = entry;
        expect(
          executeLiveReviewDelegation({ repoRoot: root, provider: "claude", args: [] }),
        ).toEqual({
          ok: false,
          reason: "consumer_runtime_absent",
        });
      } finally {
        process.argv[1] = originalArgv1;
      }
      const wrapper = join(root, ".ut-tdd", "bin", "ut-tdd.mjs");
      mkdirSync(dirname(wrapper), { recursive: true });
      writeFileSync(wrapper, "// wrapper\n");
      expect(resolveLiveReviewDelegationEntrypoint(root, entry)).toEqual({
        ok: false,
        reason: "consumer_runtime_absent",
      });
      const pointer = join(root, ".ut-tdd", "runtime", "activation", "active.json");
      mkdirSync(dirname(pointer), { recursive: true });
      writeFileSync(pointer, "{invalid json");
      expect(resolveLiveReviewDelegationEntrypoint(root, entry)).toEqual({
        ok: false,
        reason: "consumer_runtime_resolution_denied",
      });
      writeFileSync(pointer, JSON.stringify({ entry_path: join(root, "other.mjs") }));
      expect(resolveLiveReviewDelegationEntrypoint(root, entry)).toEqual({
        ok: false,
        reason: "consumer_runtime_absent",
      });
      const other = join(root, "other.mjs");
      writeFileSync(other, "// wrong entry\n");
      expect(resolveLiveReviewDelegationEntrypoint(root, entry)).toEqual({
        ok: false,
        reason: "consumer_runtime_identity_mismatch",
      });
    } finally {
      removeTestTree(root);
    }
  });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createClaudeStub(root: string): string {
  const helper = join(root, "claude-review-stub.mjs");
  writeFileSync(
    helper,
    [
      'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',
      'import { dirname } from "node:path";',
      'const input = readFileSync(0, "utf8");',
      'if (process.argv.includes("--version")) { console.log("claude-stub 1"); process.exit(0); }',
      "const verdictPath = process.env.UT_TDD_REVIEW_VERDICT_FILE;",
      "if (!verdictPath) process.exit(2);",
      'const fields = ["schema_version", "request_digest", "attempt", "pr", "exact_head", "review_revision", "reviewer_provider", "reviewer_model", "invocation_nonce"];',
      'const envelope = fields.map((field) => { const match = input.match(new RegExp("^" + field + ":\\\\s*(.+)$", "m")); return field + ": " + (match?.[1] ?? ""); }).join("\\n");',
      "mkdirSync(dirname(verdictPath), { recursive: true });",
      'writeFileSync(verdictPath, envelope + "\\nVERDICT: PASS\\n");',
      'console.log("VERDICT: PASS");',
    ].join("\n"),
    "utf8",
  );
  const command =
    process.platform === "win32" ? join(root, "claude-stub.cmd") : join(root, "claude-stub.sh");
  if (process.platform === "win32") {
    writeFileSync(command, `@echo off\r\n"${process.execPath}" "${helper}" %*\r\n`, "utf8");
  } else {
    writeFileSync(command, `#!/bin/sh\nexec "${process.execPath}" "${helper}" "$@"\n`, "utf8");
    chmodSync(command, 0o755);
  }
  return command;
}

describe("review delegation repository-root custody", () => {
  it("U-RVROOT-001: writes the strict verdict and receipt at the Git toplevel when invoked from a nested worktree directory", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-review-root-"));
    try {
      mkdirSync(join(root, "nested", "task"), { recursive: true });
      writeFileSync(join(root, "README.md"), "fixture\n", "utf8");
      git(root, ["init", "--quiet"]);
      git(root, ["config", "user.email", "test@example.invalid"]);
      git(root, ["config", "user.name", "UT-TDD test"]);
      git(root, ["add", "README.md"]);
      git(root, ["commit", "--quiet", "-m", "fixture"]);

      const taskPath = join(root, ".ut-tdd", "memory", "review.md");
      mkdirSync(dirname(taskPath), { recursive: true });
      writeFileSync(taskPath, "Review the exact HEAD and emit the required verdict.\n", "utf8");
      const claudeBin = createClaudeStub(root);
      process.env.UT_TDD_CLAUDE_BIN = claudeBin;
      const head = git(root, ["rev-parse", "HEAD"]);
      const result = executeLiveReviewDelegation({
        repoRoot: join(root, "nested", "task"),
        provider: "claude",
        cliPath: resolve(process.cwd(), "src", "cli.ts"),
        args: [
          "--role",
          "blind-reviewer",
          "--task-file",
          taskPath,
          "--review-pr",
          "396",
          "--review-head",
          head,
          "--review-revision",
          "review-396",
          "--review-author-family",
          "codex",
          "--review-memory-id",
          "memory:review-396",
          "--execute",
          "--json",
        ],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const gitRoot = resolve(git(root, ["rev-parse", "--show-toplevel"]));
      expect(result.path).toBe(
        join(gitRoot, ".ut-tdd", "review", "receipts", `${result.digest}.json`),
      );
      expect(existsSync(result.path)).toBe(true);
      expect(existsSync(join(root, "nested", "task", ".ut-tdd", "review"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
