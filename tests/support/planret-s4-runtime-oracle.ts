import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ensureTrackedProjectIdentity } from "./project-identity-fixture.ts";

type SessionEvent = Record<string, unknown>;
type SessionCli = (
  cwd: string,
  args: string[],
  input?: unknown,
) => {
  status: number | null;
  stdout: string | null;
};
type SessionReader = (root: string, sessionId: string) => SessionEvent[];

export function writeFakeClaude(binDir: string, envPrefix: string): string {
  mkdirSync(binDir, { recursive: true });
  const rawEnv = [envPrefix, "ALLOW", "RAW", "CLAUDE"].join("_");
  const reasonEnv = [envPrefix, "RAW", "CLAUDE", "REASON"].join("_");
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

export function registerPlanret014LifecycleOracle(input: {
  runCli: SessionCli;
  readSessionStartEvents: SessionReader;
}): void {
  it("ut-tdd codex records wrapper lifecycle without resolving a current PLAN", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ut-tdd-planret-s4-session-"));
    try {
      ensureTrackedProjectIdentity(cwd, "fixture/planret-s4-session");
      const priorLog = join(cwd, ".ut-tdd", "logs", "session", "interrupted-session.jsonl");
      mkdirSync(join(cwd, ".ut-tdd", "logs", "session"), { recursive: true });
      writeFileSync(
        priorLog,
        JSON.stringify({
          ts: "2026-11-10T00:00:00.000Z",
          session_id: "interrupted-session",
          plan_id: null,
          event_type: "tool_use",
        }) + "\n",
        "utf8",
      );
      const start = input.runCli(cwd, ["session", "start"], {
        hook_event_name: "SessionStart",
        session_id: "current-session",
      });
      expect(start.status).toBe(0);
      expect(start.stdout).toContain("session-log: start current-session");
      expect(input.readSessionStartEvents(cwd, "interrupted-session")).toContainEqual(
        expect.objectContaining({ event_type: "forced_stop", plan_id: null }),
      );
      const post = input.runCli(cwd, ["hook", "post-tool-use"], {
        hook_event_name: "PostToolUse",
        session_id: "current-session",
        tool_name: "Edit",
        tool_input: { file_path: "src/cli.ts" },
        tool_response: { outcome: "ok" },
      });
      expect(post.status).toBe(0);
      expect(post.stdout).toContain("session-log: post-tool-use current-session");
      const summary = input.runCli(cwd, ["session", "summary"], {
        hook_event_name: "Stop",
        session_id: "current-session",
      });
      expect(summary.status).toBe(0);
      expect(summary.stdout).toContain("session-log: summary current-session");
      const handover = input.runCli(cwd, ["handover", "--dry-run"]);
      expect(handover.status).toBe(0);
      expect(handover.stdout).toContain("handover: active=-");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
