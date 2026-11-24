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
              onFailure: "block",
            },
          ],
        },
        {
          matcher: "Edit|Write|MultiEdit",
          hooks: [
            {
              ...execHook(`\${CLAUDE_PROJECT_DIR}/.claude/hooks/work-guard.ts`),
              onFailure: "block",
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

function hookAt(
  settings: ReturnType<typeof teamStandardSettings>,
  event: string,
  entryIndex: number,
  hookIndex = 0,
): Record<string, unknown> {
  const entries = settings.hooks[event] as Array<{ hooks?: Array<Record<string, unknown>> }>;
  const hook = entries?.[entryIndex]?.hooks?.[hookIndex];
  if (!hook) throw new Error(`missing test fixture hook ${event}[${entryIndex}][${hookIndex}]`);
  return hook;
}

function analyzeSettings(settings: ReturnType<typeof teamStandardSettings>) {
  return analyzeProjectHooks([
    { file: ".claude/settings.json", content: JSON.stringify(settings) },
  ]);
}

describe("project-hook lint", () => {
  it("CANDIDATE-U-HOOKEXEC Red fixtures target valid guard and record hooks", () => {
    const settings = teamStandardSettings();
    const result = analyzeSettings(settings);

    expect(result).toMatchObject({ checked: 1, ok: true, violations: [] });
    expect(hookAt(settings, "PreToolUse", 0)).toMatchObject({
      onFailure: "block",
      type: "command",
    });
    expect(hookAt(settings, "PreToolUse", 1)).toMatchObject({
      onFailure: "block",
      type: "command",
    });
    for (const event of ["SessionStart", "PostToolUse", "Stop", "SubagentStop"]) {
      const entries = settings.hooks[event] as Array<{ hooks?: Array<Record<string, unknown>> }>;
      expect(entries?.flatMap((entry) => entry.hooks ?? []).length).toBeGreaterThan(0);
      expect(
        entries?.flatMap((entry) => entry.hooks ?? []).every((hook) => !("onFailure" in hook)),
      ).toBe(true);
    }
  });

  it("U-HOOKEXEC-011: rejects the legacy guard flag when onFailure is absent", () => {
    const settings = teamStandardSettings();
    const hook = hookAt(settings, "PreToolUse", 0);
    hook.blockOnFailure = true;
    delete hook.onFailure;
    const result = analyzeSettings(settings);

    expect(result.violations).toContainEqual({
      file: ".claude/settings.json",
      hook: "PreToolUse",
      reason: "missing_on_failure_block",
    });
  });

  it("U-HOOKEXEC-011: rejects onFailure continue for a guard hook", () => {
    const settings = teamStandardSettings();
    hookAt(settings, "PreToolUse", 0).onFailure = "continue";
    const result = analyzeSettings(settings);

    expect(result.violations).toContainEqual({
      file: ".claude/settings.json",
      hook: "PreToolUse",
      reason: "missing_on_failure_block",
    });
  });

  it("U-HOOKEXEC-011: rejects a guard hook without either failure key", () => {
    const settings = teamStandardSettings();
    const hook = hookAt(settings, "PreToolUse", 1);
    delete hook.blockOnFailure;
    delete hook.onFailure;
    const result = analyzeSettings(settings);

    expect(result.violations).toContainEqual({
      file: ".claude/settings.json",
      hook: "PreToolUse",
      reason: "missing_on_failure_block",
    });
  });

  it("U-HOOKEXEC-011: accepts both guards with onFailure block and no legacy key", () => {
    const settings = teamStandardSettings();
    for (const entryIndex of [0, 1]) {
      const hook = hookAt(settings, "PreToolUse", entryIndex);
      hook.onFailure = "block";
      delete hook.blockOnFailure;
    }
    const result = analyzeSettings(settings);

    expect(result.violations).toEqual([]);
  });

  it("U-HOOKEXEC-012: rejects blockOnFailure true beside a valid guard onFailure", () => {
    const settings = teamStandardSettings();
    const hook = hookAt(settings, "PreToolUse", 0);
    hook.blockOnFailure = true;
    hook.onFailure = "block";
    const result = analyzeSettings(settings);

    expect(result.violations).toContainEqual({
      file: ".claude/settings.json",
      hook: "PreToolUse",
      reason: "legacy_block_on_failure",
    });
  });

  it("U-HOOKEXEC-012: rejects blockOnFailure false on a guard hook", () => {
    const settings = teamStandardSettings();
    const hook = hookAt(settings, "PreToolUse", 1);
    hook.onFailure = "block";
    hook.blockOnFailure = false;
    const result = analyzeSettings(settings);

    expect(result.violations).toContainEqual({
      file: ".claude/settings.json",
      hook: "PreToolUse",
      reason: "legacy_block_on_failure",
    });
  });

  it("U-HOOKEXEC-012: rejects blockOnFailure true on a SessionStart record hook", () => {
    const settings = teamStandardSettings();
    hookAt(settings, "SessionStart", 0).blockOnFailure = true;
    const result = analyzeSettings(settings);

    expect(result.violations).toContainEqual({
      file: ".claude/settings.json",
      hook: "SessionStart",
      reason: "legacy_block_on_failure",
    });
  });

  it("U-HOOKEXEC-012: rejects blockOnFailure false on a PostToolUse record hook", () => {
    const settings = teamStandardSettings();
    hookAt(settings, "PostToolUse", 0).blockOnFailure = false;
    const result = analyzeSettings(settings);

    expect(result.violations).toContainEqual({
      file: ".claude/settings.json",
      hook: "PostToolUse",
      reason: "legacy_block_on_failure",
    });
  });

  it("CANDIDATE-U-HOOKEXEC-013: permits record and session hooks without onFailure", () => {
    const settings = teamStandardSettings();
    const result = analyzeSettings(settings);
    const recordEvents = new Set(["SessionStart", "PostToolUse", "Stop", "SubagentStop"]);

    expect(result.violations.filter((violation) => recordEvents.has(violation.hook ?? ""))).toEqual(
      [],
    );
  });

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

  it("rejects wrapper-wired guard hooks that drop onFailure block", () => {
    const generated = JSON.parse(BUILTIN_GITHUB_TEMPLATES["adapter/.claude/settings.json"]) as {
      hooks: Record<string, { matcher?: string; hooks: { onFailure?: string }[] }[]>;
    };
    for (const entry of generated.hooks.PreToolUse) {
      for (const hook of entry.hooks) {
        delete hook.onFailure;
      }
    }

    const result = analyzeProjectHooks([
      { file: ".claude/settings.json", content: JSON.stringify(generated) },
    ]);

    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual({
      file: ".claude/settings.json",
      hook: "PreToolUse",
      reason: "missing_on_failure_block",
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
