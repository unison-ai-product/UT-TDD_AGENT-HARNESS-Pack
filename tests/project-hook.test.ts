import { describe, expect, it } from "vitest";
import { analyzeProjectHooks, REQUIRED } from "../src/lint/project-hook.ts";
import { BUILTIN_GITHUB_TEMPLATES } from "../src/setup/templates.ts";

const execHook = (script: string, ...args: string[]) => ({
  type: "command",
  command: "node",
  args: [script, ...args],
});

function teamStandardSettings(): { hooks: Record<string, unknown> } {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "Agent|Task",
          hooks: [
            {
              ...execHook(`\${CLAUDE_PROJECT_DIR}/.claude/hooks/agent-guard.ts`),
              blockOnFailure: true,
            },
          ],
        },
        {
          matcher: "Edit|Write|MultiEdit",
          hooks: [
            {
              ...execHook(`\${CLAUDE_PROJECT_DIR}/.claude/hooks/work-guard.ts`),
              blockOnFailure: true,
            },
          ],
        },
      ],
      SessionStart: [
        { hooks: [execHook(`\${CLAUDE_PROJECT_DIR}/src/cli.ts`, "session", "start")] },
      ],
      PostToolUse: [
        {
          matcher: "Edit|Write|MultiEdit|Bash|PowerShell",
          hooks: [execHook(`\${CLAUDE_PROJECT_DIR}/src/cli.ts`, "hook", "post-tool-use")],
        },
      ],
      Stop: [
        { hooks: [execHook(`\${CLAUDE_PROJECT_DIR}/src/cli.ts`, "session", "summary")] },
        {
          hooks: [
            {
              ...execHook(`\${CLAUDE_PROJECT_DIR}/src/cli.ts`, "hook", "claude-memory-wake"),
              asyncRewake: true,
            },
          ],
        },
      ],
      SubagentStop: [
        { hooks: [execHook(`\${CLAUDE_PROJECT_DIR}/src/cli.ts`, "hook", "subagent-stop")] },
      ],
    },
  };
}

describe("project-hook lint", () => {
  it("accepts team-standard project-local Claude hook settings", () => {
    const result = analyzeProjectHooks([
      { file: ".claude/settings.json", content: JSON.stringify(teamStandardSettings()) },
    ]);

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("rejects legacy Claude shell command strings", () => {
    const settings = teamStandardSettings() as { hooks: Record<string, unknown[]> };
    settings.hooks.SessionStart = [
      { hooks: [{ command: 'bun "$CLAUDE_PROJECT_DIR/src/cli.ts" session start' }] },
    ];

    const result = analyzeProjectHooks([
      { file: ".claude/settings.json", content: JSON.stringify(settings) },
    ]);

    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual({
      file: ".claude/settings.json",
      hook: "SessionStart",
      reason: "missing_hook",
    });
  });

  it("rejects argv spoofing and forbidden values even when command is bun", () => {
    const spoofed = teamStandardSettings() as { hooks: Record<string, unknown[]> };
    spoofed.hooks.SessionStart = [
      { hooks: [execHook(`\${CLAUDE_PROJECT_DIR}/src/cli.tsx`, "session", "start")] },
    ];
    const forbidden = teamStandardSettings() as { hooks: Record<string, unknown[]> };
    forbidden.hooks.SessionStart = [
      {
        hooks: [
          execHook(
            `\${CLAUDE_PROJECT_DIR}/src/cli.ts`,
            "session",
            "start",
            "C:\\Users\\alice\\private",
          ),
        ],
      },
    ];

    expect(
      analyzeProjectHooks([{ file: ".claude/settings.json", content: JSON.stringify(spoofed) }]).ok,
    ).toBe(false);
    expect(
      analyzeProjectHooks([{ file: ".claude/settings.json", content: JSON.stringify(forbidden) }])
        .violations,
    ).toContainEqual({
      file: ".claude/settings.json",
      hook: "SessionStart",
      reason: "forbidden_path",
    });
  });

  // PLAN-RECOVERY-06 (A-172 C-2): setup が consumer へ生成する settings.json (wrapper 配線) が
  // project-hook gate を通ることを実テンプレートで固定する。gate 要求と setup 生成物が
  // 再乖離したらこの test が赤になる (単一定義源の回帰フェンス)。
  it("accepts the setup-generated consumer settings.json wrapper wiring", () => {
    const generated = BUILTIN_GITHUB_TEMPLATES["adapter/.claude/settings.json"];
    expect(generated).toBeDefined();

    const result = analyzeProjectHooks([{ file: ".claude/settings.json", content: generated }]);

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("rejects wrapper-wired guard hooks that drop blockOnFailure", () => {
    const generated = JSON.parse(BUILTIN_GITHUB_TEMPLATES["adapter/.claude/settings.json"]) as {
      hooks: Record<string, { matcher?: string; hooks: { blockOnFailure?: boolean }[] }[]>;
    };
    for (const entry of generated.hooks.PreToolUse) {
      for (const hook of entry.hooks) {
        delete hook.blockOnFailure;
      }
    }

    const result = analyzeProjectHooks([
      { file: ".claude/settings.json", content: JSON.stringify(generated) },
    ]);

    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual({
      file: ".claude/settings.json",
      hook: "PreToolUse",
      reason: "missing_block_on_failure",
    });
  });

  it("rejects a Claude memory wake hook that drops asyncRewake", () => {
    const generated = JSON.parse(BUILTIN_GITHUB_TEMPLATES["adapter/.claude/settings.json"]) as {
      hooks: Record<string, { hooks: { args?: string[]; asyncRewake?: boolean }[] }[]>;
    };
    for (const entry of generated.hooks.Stop) {
      for (const hook of entry.hooks) {
        if (hook.args?.includes("claude-memory-wake")) delete hook.asyncRewake;
      }
    }

    const result = analyzeProjectHooks([
      { file: ".claude/settings.json", content: JSON.stringify(generated) },
    ]);

    expect(result.violations).toContainEqual({
      file: ".claude/settings.json",
      hook: "Stop",
      reason: "missing_async_rewake",
    });
  });

  it("rejects tracked Claude permissions because they are local runtime state", () => {
    const settings = {
      permissions: { allow: ["Bash(git add *)"] },
      ...teamStandardSettings(),
    };

    const result = analyzeProjectHooks([
      { file: ".claude/settings.json", content: JSON.stringify(settings) },
    ]);

    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual({
      file: ".claude/settings.json",
      reason: "tracked_permissions",
    });
  });

  // isWrapperForm は includes 部分一致のため、wrapperCommand 同士が prefix 関係になると
  // クロス判定 (別 hook での偽充足) が起きうる。エントリ追加時の回帰を構造で防ぐ。
  it("keeps required wrapper commands mutually non-substring", () => {
    for (const a of REQUIRED) {
      for (const b of REQUIRED) {
        if (a.id === b.id) continue;
        expect(a.wrapperCommand.includes(b.wrapperCommand)).toBe(false);
      }
    }
  });

  it("rejects missing team-standard project hook entries", () => {
    const settings = teamStandardSettings();
    delete settings.hooks.Stop;

    const result = analyzeProjectHooks([
      { file: ".claude/settings.json", content: JSON.stringify(settings) },
    ]);

    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual({
      file: ".claude/settings.json",
      hook: "Stop",
      reason: "missing_hook",
    });
  });

  it("rejects personal absolute paths in project hook commands", () => {
    const settings = teamStandardSettings();
    settings.hooks.SessionStart = [
      {
        hooks: [
          {
            ...execHook(
              `\${CLAUDE_PROJECT_DIR}/src/cli.ts`,
              "session",
              "start",
              "--legacy",
              "C:\\Users\\alice\\legacy",
            ),
          },
        ],
      },
    ];

    const result = analyzeProjectHooks([
      {
        file: ".claude/settings.json",
        content: JSON.stringify(settings),
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual({
      file: ".claude/settings.json",
      hook: "SessionStart",
      reason: "forbidden_path",
    });
  });

  it("rejects POSIX personal absolute paths in project hook commands", () => {
    const settings = teamStandardSettings();
    settings.hooks.Notification = [
      { hooks: [{ command: "node", args: ["/Users/alice/private/hook.js"] }] },
    ];

    const result = analyzeProjectHooks([
      { file: ".claude/settings.json", content: JSON.stringify(settings) },
    ]);

    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual({
      file: ".claude/settings.json",
      hook: "Notification",
      reason: "forbidden_path",
    });
  });

  it("rejects legacy runtime commands in any project hook command", () => {
    const settings = teamStandardSettings();
    const legacyName = ["he", "lix"].join("");
    settings.hooks.Notification = [
      { hooks: [{ command: legacyName, args: ["codex", "--role", "worker"] }] },
    ];

    const result = analyzeProjectHooks([
      { file: ".claude/settings.json", content: JSON.stringify(settings) },
    ]);

    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual({
      file: ".claude/settings.json",
      hook: "Notification",
      reason: "forbidden_path",
    });
  });
});
