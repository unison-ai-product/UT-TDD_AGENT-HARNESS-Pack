import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const cliPath = join(repoRoot, "src", "cli.ts");
const legacyEnvPrefix = ["HE", "LIX"].join("");

function runCli(cwd: string, args: string[], input?: unknown, env?: NodeJS.ProcessEnv) {
  const stdin = input === undefined ? undefined : JSON.stringify(input);
  if (process.platform === "win32") {
    // cmd.exe は PATH 探索でなく %SystemRoot% から canonical に解決する。
    // PATH 注入事故 (System32 欠落) でテストが環境誘発 fail しないため (A-128 F-7)。
    const cmdExe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
    return spawnSync(cmdExe, ["/d", "/c", "bun", cliPath, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...env },
      input: stdin,
    });
  }
  return spawnSync("bun", [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    input: stdin,
  });
}

function writeFakeCodex(binDir: string): string {
  mkdirSync(binDir, { recursive: true });
  const rawEnv = [legacyEnvPrefix, "ALLOW", "RAW", "CODEX"].join("_");
  const reasonEnv = [legacyEnvPrefix, "RAW", "CODEX", "REASON"].join("_");
  if (process.platform === "win32") {
    const path = join(binDir, "codex.cmd");
    writeFileSync(
      path,
      `@echo off\r\necho %* > codex-called.txt\r\nfindstr "^" > codex-stdin.txt\r\n(echo raw=%${rawEnv}%)> codex-env.txt\r\n(echo reason=%${reasonEnv}%)>> codex-env.txt\r\nexit /b 0\r\n`,
    );
    return path;
  }
  const path = join(binDir, "codex");
  writeFileSync(
    path,
    `#!/bin/sh\necho "$@" > codex-called.txt\ncat > codex-stdin.txt\nprintf "raw=%s\\nreason=%s\\n" "$${rawEnv}" "$${reasonEnv}" > codex-env.txt\nexit 0\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

function writeFakeClaude(binDir: string): string {
  mkdirSync(binDir, { recursive: true });
  const rawEnv = [legacyEnvPrefix, "ALLOW", "RAW", "CLAUDE"].join("_");
  const reasonEnv = [legacyEnvPrefix, "RAW", "CLAUDE", "REASON"].join("_");
  if (process.platform === "win32") {
    const path = join(binDir, "claude.cmd");
    writeFileSync(
      path,
      `@echo off\r\necho %* > claude-called.txt\r\nfindstr "^" > claude-stdin.txt\r\n(echo raw=%${rawEnv}%)> claude-env.txt\r\n(echo reason=%${reasonEnv}%)>> claude-env.txt\r\nexit /b 0\r\n`,
    );
    return path;
  }
  const path = join(binDir, "claude");
  writeFileSync(
    path,
    `#!/bin/sh\necho "$@" > claude-called.txt\ncat > claude-stdin.txt\nprintf "raw=%s\\nreason=%s\\n" "$${rawEnv}" "$${reasonEnv}" > claude-env.txt\nexit 0\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

describe("runtime hook entrypoints", () => {
  it("Claude settings route session-log hooks through the shared UT-TDD CLI", () => {
    const settings = JSON.parse(readFileSync(join(repoRoot, ".claude", "settings.json"), "utf8"));
    const hooks = settings.hooks;

    expect(hooks.SessionStart[0].hooks[0].command).toBe(
      'bun "$CLAUDE_PROJECT_DIR/src/cli.ts" session start',
    );
    expect(hooks.PostToolUse[0].hooks[0].command).toBe(
      'bun "$CLAUDE_PROJECT_DIR/src/cli.ts" hook post-tool-use',
    );
    expect(hooks.Stop[0].hooks[0].command).toBe(
      'bun "$CLAUDE_PROJECT_DIR/src/cli.ts" session summary',
    );
  });

  it("shared CLI session/hook commands record a PLAN digest in a temp repo", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ut-tdd-hook-"));
    try {
      const start = runCli(cwd, ["plan", "use", "PLAN-L4-13"]);
      expect(start.status).toBe(0);

      const sessionStart = runCli(cwd, ["session", "start"], {
        hook_event_name: "SessionStart",
        session_id: "s-cli",
      });
      expect(sessionStart.status).toBe(0);
      expect(sessionStart.stdout).toContain("session-log: start s-cli");

      const postToolUse = runCli(cwd, ["hook", "post-tool-use"], {
        hook_event_name: "PostToolUse",
        session_id: "s-cli",
        tool_name: "Edit",
        tool_input: { file_path: "src/cli.ts" },
        tool_response: { outcome: "ok" },
      });
      expect(postToolUse.status).toBe(0);
      expect(postToolUse.stdout).toContain("session-log: post-tool-use s-cli");

      const stop = runCli(cwd, ["session", "summary"], {
        hook_event_name: "Stop",
        session_id: "s-cli",
      });
      expect(stop.status).toBe(0);
      expect(stop.stdout).toContain("session-log: summary s-cli");

      const digest = JSON.parse(
        readFileSync(join(cwd, ".ut-tdd", "logs", "plan", "PLAN-L4-13.digest.json"), "utf8"),
      );
      expect(digest.plan_id).toBe("PLAN-L4-13");
      expect(digest.sessions).toEqual(["s-cli"]);
      expect(digest.files_touched).toEqual(["Edit src/cli.ts"]);
      expect(digest.event_counts.session_start).toBe(1);
      expect(digest.event_counts.tool_use).toBe(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("ut-tdd codex --execute records the same session lifecycle through the adapter wrapper", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ut-tdd-codex-wrapper-"));
    const binDir = join(cwd, "bin");
    try {
      const fakeCodex = writeFakeCodex(binDir);
      const env = {
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        UT_TDD_CODEX_BIN: fakeCodex,
      };

      expect(runCli(cwd, ["plan", "use", "PLAN-L4-13"]).status).toBe(0);
      const run = runCli(
        cwd,
        ["codex", "--role", "se", "--task", "implement parity", "--execute"],
        undefined,
        env,
      );
      expect(run.status).toBe(0);

      const digest = JSON.parse(
        readFileSync(join(cwd, ".ut-tdd", "logs", "plan", "PLAN-L4-13.digest.json"), "utf8"),
      );
      expect(digest.sessions).toHaveLength(1);
      expect(digest.sessions[0]).toMatch(/^codex-/);
      expect(digest.event_counts.session_start).toBe(1);
      expect(digest.event_counts.tool_use).toBe(1);
      expect(readFileSync(join(cwd, "codex-called.txt"), "utf8")).toContain("exec");
      const envText = readFileSync(join(cwd, "codex-env.txt"), "utf8");
      expect(envText).not.toContain("raw=1");
      expect(envText).not.toContain("reason=ut-tdd-runtime-adapter-wrapper");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("ut-tdd codex --task-file feeds file content through the same adapter wrapper", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ut-tdd-codex-task-file-"));
    const binDir = join(cwd, "bin");
    try {
      const fakeCodex = writeFakeCodex(binDir);
      writeFileSync(join(cwd, "task.md"), "implement from task file");
      const env = {
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        UT_TDD_CODEX_BIN: fakeCodex,
      };

      expect(runCli(cwd, ["plan", "use", "PLAN-L4-13"]).status).toBe(0);
      const run = runCli(
        cwd,
        ["codex", "--role", "se", "--task-file", "task.md", "--execute"],
        undefined,
        env,
      );
      expect(run.status).toBe(0);

      const digest = JSON.parse(
        readFileSync(join(cwd, ".ut-tdd", "logs", "plan", "PLAN-L4-13.digest.json"), "utf8"),
      );
      expect(digest.event_counts.session_start).toBe(1);
      expect(digest.event_counts.tool_use).toBe(1);
      const called = readFileSync(join(cwd, "codex-called.txt"), "utf8");
      expect(called).toContain("exec");
      // プロンプトは args でなく stdin で渡る (PLAN-L7-77、cmd.exe shell-wrap の改行切り詰め回避)。
      const stdinText = readFileSync(join(cwd, "codex-stdin.txt"), "utf8");
      expect(stdinText).toContain("implement from task file");
      const envText = readFileSync(join(cwd, "codex-env.txt"), "utf8");
      expect(envText).not.toContain("raw=1");
      expect(envText).not.toContain("reason=ut-tdd-runtime-adapter-wrapper");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("ut-tdd codex --plan records wrapper lifecycle without forwarding plan flags to Codex", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ut-tdd-codex-plan-"));
    const binDir = join(cwd, "bin");
    try {
      const fakeCodex = writeFakeCodex(binDir);
      const env = {
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        UT_TDD_CODEX_BIN: fakeCodex,
      };

      const run = runCli(
        cwd,
        [
          "codex",
          "--role",
          "se",
          "--task",
          "implement explicit plan",
          "--plan",
          "PLAN-L4-77-adapter",
          "--execute",
        ],
        undefined,
        env,
      );
      expect(run.status).toBe(0);

      const digest = JSON.parse(
        readFileSync(
          join(cwd, ".ut-tdd", "logs", "plan", "PLAN-L4-77-adapter.digest.json"),
          "utf8",
        ),
      );
      expect(digest.plan_id).toBe("PLAN-L4-77-adapter");
      expect(digest.event_counts.session_start).toBe(1);
      expect(digest.event_counts.tool_use).toBe(1);
      expect(digest.event_counts.session_end).toBe(1);
      const called = readFileSync(join(cwd, "codex-called.txt"), "utf8");
      expect(called).toContain("exec");
      expect(called).not.toContain("--plan-id");
      expect(called).not.toContain("PLAN-L4-77-adapter");
      const stdinText = readFileSync(join(cwd, "codex-stdin.txt"), "utf8");
      expect(stdinText).toContain("implement explicit plan");
      expect(stdinText).not.toContain("UT-TDD context injection");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("ut-tdd claude --execute records lifecycle without legacy raw-wrapper env", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ut-tdd-claude-wrapper-"));
    const binDir = join(cwd, "bin");
    try {
      const fakeClaude = writeFakeClaude(binDir);
      const env = {
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        UT_TDD_CLAUDE_BIN: fakeClaude,
      };

      const run = runCli(
        cwd,
        [
          "claude",
          "--role",
          "pmo-sonnet",
          "--task",
          "review explicit plan",
          "--plan",
          "PLAN-L4-78-adapter",
          "--execute",
        ],
        undefined,
        env,
      );
      expect(run.status).toBe(0);

      const digest = JSON.parse(
        readFileSync(
          join(cwd, ".ut-tdd", "logs", "plan", "PLAN-L4-78-adapter.digest.json"),
          "utf8",
        ),
      );
      expect(digest.plan_id).toBe("PLAN-L4-78-adapter");
      expect(digest.event_counts.session_start).toBe(1);
      expect(digest.event_counts.tool_use).toBe(1);
      expect(digest.event_counts.session_end).toBe(1);
      const called = readFileSync(join(cwd, "claude-called.txt"), "utf8");
      expect(called).toContain("--print");
      expect(called).toContain("--input-format");
      expect(called).toContain("text");
      expect(called).not.toMatch(/(^|\s)"?-p"?(\s|$)/);
      expect(called).not.toContain("review explicit plan");
      const stdinText = readFileSync(join(cwd, "claude-stdin.txt"), "utf8");
      expect(stdinText).toContain("review explicit plan");
      expect(called).not.toContain("--role");
      expect(called).not.toContain("--task");
      expect(called).not.toContain("--plan-id");
      expect(called).not.toContain("PLAN-L4-78-adapter");
      const envText = readFileSync(join(cwd, "claude-env.txt"), "utf8");
      expect(envText).not.toContain("raw=1");
      expect(envText).not.toContain("reason=ut-tdd-runtime-adapter-wrapper");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("ut-tdd team run --execute records lifecycle for each provider member", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ut-tdd-team-wrapper-"));
    const binDir = join(cwd, "bin");
    try {
      const fakeCodex = writeFakeCodex(binDir);
      const fakeClaude = writeFakeClaude(binDir);
      mkdirSync(join(cwd, ".ut-tdd", "teams"), { recursive: true });
      writeFileSync(
        join(cwd, ".ut-tdd", "teams", "speed.yaml"),
        [
          "name: speed",
          "strategy: sequential",
          "max_parallel: 2",
          "members:",
          "  - role: se",
          "    engine: codex-se",
          "    task: implement team lifecycle",
          "  - role: tl",
          "    engine: pmo-sonnet",
          "    task: review team lifecycle",
        ].join("\n"),
      );
      const env = {
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        UT_TDD_CODEX_BIN: fakeCodex,
        UT_TDD_CLAUDE_BIN: fakeClaude,
      };

      const run = runCli(
        cwd,
        [
          "team",
          "run",
          "--definition",
          ".ut-tdd/teams/speed.yaml",
          "--mode",
          "hybrid",
          "--execute",
          "--plan",
          "PLAN-L4-79-team-wrapper",
          "--json",
        ],
        undefined,
        env,
      );
      expect(run.status).toBe(0);

      const digest = JSON.parse(
        readFileSync(
          join(cwd, ".ut-tdd", "logs", "plan", "PLAN-L4-79-team-wrapper.digest.json"),
          "utf8",
        ),
      );
      expect(digest.plan_id).toBe("PLAN-L4-79-team-wrapper");
      expect(digest.sessions).toHaveLength(2);
      expect(digest.sessions).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^codex-team-/),
          expect.stringMatching(/^claude-team-/),
        ]),
      );
      expect(digest.event_counts.session_start).toBe(2);
      expect(digest.event_counts.tool_use).toBe(2);
      expect(digest.event_counts.session_end).toBe(2);
      expect(readFileSync(join(cwd, "codex-called.txt"), "utf8")).toContain("exec");
      expect(readFileSync(join(cwd, "claude-called.txt"), "utf8")).toContain("--print");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
