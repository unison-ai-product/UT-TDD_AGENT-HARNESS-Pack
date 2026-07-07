import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkSetupSmoke,
  collectHookCommands,
  type SetupSmokeDeps,
} from "../src/doctor/setup-smoke";

const requiredCommands = [
  "bun .ut-tdd/bin/ut-tdd.mjs hook agent-guard",
  "bun .ut-tdd/bin/ut-tdd.mjs hook work-guard",
  "bun .ut-tdd/bin/ut-tdd.mjs session start",
  "bun .ut-tdd/bin/ut-tdd.mjs hook post-tool-use",
  "bun .ut-tdd/bin/ut-tdd.mjs session summary",
] as const;

function hooksJson(commands: readonly string[]) {
  return JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: commands.map((command) => ({ command })) }],
    },
  });
}

function setupSmokeDeps(overrides: Record<string, string | null> = {}): SetupSmokeDeps {
  const root = "/repo";
  const files = new Map<string, string>(
    Object.entries({
      ".ut-tdd/bin/ut-tdd.mjs": "#!/usr/bin/env bun\nconsole.log('ut-tdd');\n",
      "AGENTS.md": "# Agents\n",
      "CLAUDE.md": "# Claude\n",
      ".claude/CLAUDE.md": "# Claude runtime\n",
      ".claude/settings.json": hooksJson([
        ...requiredCommands,
        "bun .ut-tdd/bin/ut-tdd.mjs hook subagent-stop",
      ]),
      ".codex/config.toml": "[features]\nhooks = true\n",
      ".codex/hooks.json": hooksJson(requiredCommands),
    }).map(([relativePath, text]) => [join(root, relativePath), text]),
  );
  for (const [relativePath, text] of Object.entries(overrides)) {
    const path = join(root, relativePath);
    if (text === null) {
      files.delete(path);
    } else {
      files.set(path, text);
    }
  }
  return {
    repoRoot: root,
    readText: (path) => files.get(path) ?? null,
  };
}

describe("doctor setup-smoke direct checks", () => {
  it("collects hook commands from nested adapter hook JSON", () => {
    const commands = collectHookCommands(
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ command: "bun .ut-tdd/bin/ut-tdd.mjs session start" }] }],
          Stop: [
            {
              hooks: [
                { command: "" },
                {},
                { command: "bun .ut-tdd/bin/ut-tdd.mjs session summary" },
              ],
            },
          ],
        },
      }),
    );

    expect(commands).toEqual([
      "bun .ut-tdd/bin/ut-tdd.mjs session start",
      "bun .ut-tdd/bin/ut-tdd.mjs session summary",
    ]);
  });

  it("fails closed on invalid hook JSON instead of silently accepting setup smoke", () => {
    expect(collectHookCommands("{not-json")).toBeNull();

    const result = checkSetupSmoke(
      setupSmokeDeps({
        ".claude/settings.json": "{not-json",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.messages.join("\n")).toContain("missing claude-hooks-json");
  });

  it("accepts a complete project-local setup smoke fixture", () => {
    const result = checkSetupSmoke(setupSmokeDeps());

    expect(result.ok).toBe(true);
    expect(result.messages).toEqual(["doctor: setup-smoke - OK (checked=22, failed=0)"]);
  });

  it("rejects template placeholder residue in the project-local wrapper", () => {
    const result = checkSetupSmoke(
      setupSmokeDeps({
        ".ut-tdd/bin/ut-tdd.mjs": "const source = '__UT_TDD_SOURCE_CLI_JSON__';\n",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.messages.join("\n")).toContain("missing wrapper-placeholder-free");
  });
});
