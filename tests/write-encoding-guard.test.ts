import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectWriteEncodingGuardTargets,
  runWriteEncodingGuard,
} from "../src/lint/write-encoding-guard.ts";
import { extractEditTargets } from "../src/shared/edit-targets.ts";

const repoRoot = process.cwd();
const cliPath = join(repoRoot, "src", "cli.ts");

function runCli(cwd: string, args: string[], input?: unknown) {
  const stdin = input === undefined ? undefined : JSON.stringify(input);
  // PLAN-L7-462 step 2: CLI 実発火 oracle は node 直 spawn (cmd.exe/bun 経由なし)。
  return spawnSync("node", [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    env: process.env,
    input: stdin,
    windowsHide: true,
  });
}

describe("write encoding guard (PLAN-L7-317)", () => {
  it("U-WENC-001: warns and logs when PostToolUse wrote a UTF-16LE markdown file", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ut-tdd-encoding-guard-"));
    try {
      writeFileSync(join(cwd, "bad.md"), Buffer.from([0xff, 0xfe, 0x23, 0x00, 0x20, 0x00]));

      const run = runCli(cwd, ["hook", "post-tool-use"], {
        hook_event_name: "PostToolUse",
        session_id: "s-encoding",
        tool_name: "Write",
        tool_input: { file_path: "bad.md" },
        tool_response: { outcome: "ok" },
      });

      expect(run.status).toBe(0);
      expect(run.stdout).toContain("session-log: post-tool-use s-encoding");
      expect(run.stderr).toContain("write-encoding-guard");
      expect(run.stderr).toContain("bad.md:1:utf16le-bom");
      const log = readFileSync(join(cwd, ".ut-tdd", "logs", "encoding-violations.jsonl"), "utf8");
      expect(log).toContain("utf16le-bom");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("U-WENC-002: stays silent for clean UTF-8 no-BOM writes", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ut-tdd-encoding-clean-"));
    try {
      writeFileSync(join(cwd, "clean.md"), "# 監査\n工程表は直列で実行する。\n", "utf8");

      const run = runCli(cwd, ["hook", "post-tool-use"], {
        hook_event_name: "PostToolUse",
        session_id: "s-clean",
        tool_name: "Write",
        tool_input: { file_path: "clean.md" },
        tool_response: { outcome: "ok" },
      });

      expect(run.status).toBe(0);
      expect(run.stderr).not.toContain("write-encoding-guard");
      expect(existsSync(join(cwd, ".ut-tdd", "logs", "encoding-violations.jsonl"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("U-WENC-003: uses changed files as the shell-command fallback target set", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ut-tdd-encoding-shell-"));
    try {
      writeFileSync(join(cwd, "bad.md"), Buffer.from([0xef, 0xbb, 0xbf, 0x23, 0x20]));
      const result = runWriteEncodingGuard(
        {
          session_id: "s-shell",
          tool_name: "Bash",
          tool_input: { command: "powershell -Command Set-Content bad.md" },
        },
        {
          repoRoot: cwd,
          changedFiles: () => ["bad.md"],
          now: () => "2026-07-08T00:00:00.000Z",
        },
      );

      expect(result.messages[0]).toContain("bad.md:1:utf8-bom");
      const log = readFileSync(join(cwd, ".ut-tdd", "logs", "encoding-violations.jsonl"), "utf8");
      expect(log).toContain('"tool_name":"Bash"');
      expect(log).toContain("utf8-bom");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("U-WENC-004: extracts apply_patch targets and filters binary files", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: docs/a.md",
      "@@",
      "+text",
      "*** Update File: image.png",
      "@@",
      "*** End Patch",
    ].join("\n");
    expect(
      collectWriteEncodingGuardTargets(
        { tool_name: "apply_patch", tool_input: { input: patch } },
        repoRoot,
      ),
    ).toEqual(["docs/a.md"]);
    expect(extractEditTargets({ input: patch })).toEqual(["docs/a.md", "image.png"]);
  });
});
