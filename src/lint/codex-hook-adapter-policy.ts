import { REQUIRED as CLAUDE_REQUIRED, wrapperHookArgs } from "./project-hook.ts";

interface CodexRequiredHook {
  id: string;
  event: string;
  matcher?: string;
  commandParts: readonly string[];
  sourceArgs: readonly string[];
  wrapperArgs: readonly string[];
  blockOnFailure?: boolean;
}

interface CodexDeferredSurface {
  surface: string;
  claude_analog: string;
  reason: string;
}

const codexSourceArgs = (id: (typeof CLAUDE_REQUIRED)[number]["id"]): readonly string[] => {
  const required = CLAUDE_REQUIRED.find((entry) => entry.id === id);
  if (!required) throw new Error(`unknown required project hook id: ${id}`);
  return required.sourceArgs.map((arg) => arg.replace(/^\$\{CLAUDE_PROJECT_DIR\}\//, ""));
};

// wrapper 形式 (setup 生成 .codex/hooks.json の正規形) は Claude 側 project-hook の
// wrapper argv を構築時に共有する (単一定義源、PLAN-RECOVERY-06)。文字列複製ではなく
// import 参照なので Claude/Codex の wrapper 配線は定義上分岐できない。
export const CODEX_REQUIRED = [
  {
    id: "agent-guard",
    event: "PreToolUse",
    matcher: "spawn_agent|spawn_agents_on_csv",
    commandParts: [".claude/hooks/agent-guard.ts"],
    sourceArgs: codexSourceArgs("agent-guard"),
    wrapperArgs: wrapperHookArgs("agent-guard"),
    blockOnFailure: true,
  },
  {
    id: "work-guard",
    event: "PreToolUse",
    matcher: "apply_patch|write_file",
    commandParts: [".claude/hooks/work-guard.ts"],
    sourceArgs: codexSourceArgs("work-guard"),
    wrapperArgs: wrapperHookArgs("work-guard"),
    blockOnFailure: true,
  },
  {
    id: "session-start",
    event: "SessionStart",
    commandParts: ["src/cli.ts", "session start"],
    sourceArgs: codexSourceArgs("session-start"),
    wrapperArgs: wrapperHookArgs("session-start"),
  },
  {
    id: "post-tool-use",
    event: "PostToolUse",
    matcher: "apply_patch|write_file|exec_command|local_shell",
    commandParts: ["src/cli.ts", "hook post-tool-use"],
    sourceArgs: codexSourceArgs("post-tool-use"),
    wrapperArgs: wrapperHookArgs("post-tool-use"),
  },
  {
    id: "session-summary",
    event: "Stop",
    commandParts: ["src/cli.ts", "session summary"],
    sourceArgs: codexSourceArgs("session-summary"),
    wrapperArgs: wrapperHookArgs("session-summary"),
  },
] satisfies readonly CodexRequiredHook[];

export const CODEX_NOT_APPLICABLE = [
  {
    entrypoint: "src/cli.ts hook subagent-stop",
    reason:
      "Codex に SubagentStop event が無い (codex.exe 0.128.0 の hook event は PreToolUse/PostToolUse/SessionStart/Stop/UserPromptSubmit のみ)",
  },
] as const;

export const CODEX_DEFERRED_SURFACE: readonly CodexDeferredSurface[] = [];

/** `~/.codex/` 等 global Codex 設定への参照 (repo-relative 原則違反) を検出。 */
export const CODEX_GLOBAL_RE = /(?:^|[\s"'=])(?:~|\$HOME|%USERPROFILE%)?[\\/]?\.codex[\\/]/i;
