import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkSetupSmoke,
  collectHookCommands,
  type SetupSmokeDeps,
} from "../src/doctor/setup-smoke.ts";

const codexCommands = [
  "node .ut-tdd/bin/ut-tdd.mjs hook agent-guard",
  "node .ut-tdd/bin/ut-tdd.mjs hook work-guard",
  "node .ut-tdd/bin/ut-tdd.mjs session start",
  "node .ut-tdd/bin/ut-tdd.mjs hook post-tool-use",
  "node .ut-tdd/bin/ut-tdd.mjs session summary",
] as const;

const claudeCommands = [
  "node .ut-tdd/bin/ut-tdd.mjs hook agent-guard",
  "node .ut-tdd/bin/ut-tdd.mjs hook work-guard",
  "node .ut-tdd/bin/ut-tdd.mjs session start",
  "node .ut-tdd/bin/ut-tdd.mjs hook post-tool-use",
  "node .ut-tdd/bin/ut-tdd.mjs session summary",
  "node .ut-tdd/bin/ut-tdd.mjs hook subagent-stop",
] as const;

function hooksJson(commands: readonly string[]) {
  return JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: commands.map((command) => ({ command })) }],
    },
  });
}

function claudeHooksJson(commands: readonly string[]) {
  return JSON.stringify({
    hooks: {
      SessionStart: [
        {
          hooks: commands.map((serialized) => {
            const [command, ...args] = serialized.split(" ");
            return { command, args };
          }),
        },
      ],
    },
  });
}

function setupSmokeDeps(overrides: Record<string, string | null> = {}): SetupSmokeDeps {
  const root = "/repo";
  const files = new Map<string, string>(
    Object.entries({
      ".ut-tdd/bin/ut-tdd.mjs": "#!/usr/bin/env node\nspawnSync(process.execPath, args);\n",
      "AGENTS.md": "# Agents\n",
      "CLAUDE.md": "# Claude\n",
      ".claude/CLAUDE.md": "# Claude runtime\n",
      ".claude/settings.json": claudeHooksJson(claudeCommands),
      ".codex/config.toml": "[features]\nhooks = true\n",
      ".codex/hooks.json": claudeHooksJson(codexCommands),
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

  it("preserves Claude native-launcher and Codex serializer semantics separately", () => {
    const claude = collectHookCommands(
      claudeHooksJson(["node .ut-tdd/bin/ut-tdd.mjs session start"]),
    );
    const codex = collectHookCommands(hooksJson(["bun .ut-tdd/bin/ut-tdd.mjs session start"]));

    expect(claude).toEqual(["node .ut-tdd/bin/ut-tdd.mjs session start"]);
    expect(codex).toEqual(["bun .ut-tdd/bin/ut-tdd.mjs session start"]);
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
    expect(result.messages[0]).toMatch(/doctor: setup-smoke - OK/);
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

  it("rejects shell-serialized hooks even when their token text matches the native contract", () => {
    const result = checkSetupSmoke(
      setupSmokeDeps({
        ".codex/hooks.json": hooksJson(codexCommands),
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.messages.join("\n")).toContain("missing codex-hook:node");
  });
});
