import { describe, expect, it } from "vitest";
import { analyzeProjectHooks } from "../src/lint/project-hook";

function teamStandardSettings(): { hooks: Record<string, unknown> } {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "Agent|Task",
          hooks: [
            {
              command: 'bun "$CLAUDE_PROJECT_DIR/.claude/hooks/agent-guard.ts"',
              blockOnFailure: true,
            },
          ],
        },
        {
          matcher: "Edit|Write|MultiEdit",
          hooks: [
            {
              command: 'bun "$CLAUDE_PROJECT_DIR/.claude/hooks/work-guard.ts"',
              blockOnFailure: true,
            },
          ],
        },
      ],
      SessionStart: [
        { hooks: [{ command: 'bun "$CLAUDE_PROJECT_DIR/src/cli.ts" session start' }] },
      ],
      PostToolUse: [
        {
          matcher: "Edit|Write|MultiEdit|Bash",
          hooks: [{ command: 'bun "$CLAUDE_PROJECT_DIR/src/cli.ts" hook post-tool-use' }],
        },
      ],
      Stop: [{ hooks: [{ command: 'bun "$CLAUDE_PROJECT_DIR/src/cli.ts" session summary' }] }],
      SubagentStop: [
        { hooks: [{ command: 'bun "$CLAUDE_PROJECT_DIR/src/cli.ts" hook subagent-stop' }] },
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
            command:
              'bun "$CLAUDE_PROJECT_DIR/src/cli.ts" session start --legacy C:\\Users\\alice\\legacy',
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
    settings.hooks.Notification = [{ hooks: [{ command: "node /Users/alice/private/hook.js" }] }];

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
    settings.hooks.Notification = [{ hooks: [{ command: `${legacyName} codex --role worker` }] }];

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
