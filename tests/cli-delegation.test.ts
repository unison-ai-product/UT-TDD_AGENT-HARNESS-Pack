import { afterEach, describe, expect, it } from "vitest";
import { Command } from "commander";
import { adapterExecutionEnv, registerDelegationCommands } from "../src/cli/delegation";

const legacyPrefix = ["HE", "LIX"].join("");
const touchedKeys = [
  [legacyPrefix, "ALLOW", "RAW", "CLAUDE"].join("_"),
  [legacyPrefix, "RAW", "CLAUDE", "REASON"].join("_"),
  [legacyPrefix, "ALLOW", "RAW", "CODEX"].join("_"),
  [legacyPrefix, "RAW", "CODEX", "REASON"].join("_"),
  [legacyPrefix, "CLAUDE", "BIN"].join("_"),
  [legacyPrefix, "CODEX", "BIN"].join("_"),
  "UT_TDD_CODEX_BIN",
  "UT_TDD_CLAUDE_BIN",
];

const originalValues = new Map(touchedKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of touchedKeys) {
    const original = originalValues.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

describe("CLI delegation adapter execution env", () => {
  it("strips legacy raw-provider env while preserving UT-TDD provider overrides", () => {
    for (const key of touchedKeys.filter((key) => key.startsWith(legacyPrefix))) {
      process.env[key] = "legacy";
    }
    process.env.UT_TDD_CODEX_BIN = "C:/tools/codex.cmd";
    process.env.UT_TDD_CLAUDE_BIN = "C:/tools/claude.exe";

    const env = adapterExecutionEnv("codex", { EXTRA_FLAG: "1" });

    for (const key of touchedKeys.filter((key) => key.startsWith(legacyPrefix))) {
      expect(env[key], key).toBeUndefined();
    }
    expect(env.UT_TDD_CODEX_BIN).toBe("C:/tools/codex.cmd");
    expect(env.UT_TDD_CLAUDE_BIN).toBe("C:/tools/claude.exe");
    expect(env.EXTRA_FLAG).toBe("1");
    expect(env).not.toBe(process.env);
    expect(process.env[[legacyPrefix, "ALLOW", "RAW", "CODEX"].join("_")]).toBe("legacy");
  });
});

describe("CLI delegation command registration", () => {
  it("registers codex and claude runtime adapter commands with governed overrides", () => {
    const program = new Command();
    registerDelegationCommands(program, {
      gitBranch: () => "work/test",
      gitHead: () => "abc1234",
      resolveTaskText: (opts) => opts.task ?? null,
      resolveSkillContextInjection: () => undefined,
      runSessionStartSideEffects: () => {},
      taskFileOptionDescription: "read task text from file",
      writeHandoverWarnings: () => {},
    });

    for (const provider of ["codex", "claude"]) {
      const command = program.commands.find((candidate) => candidate.name() === provider);
      expect(command, provider).toBeDefined();
      expect(command?.description()).toBe(`${provider} runtime adapter command`);
      expect(command?.options.map((option) => option.long)).toEqual([
        "--role",
        "--task",
        "--task-file",
        "--plan",
        "--model",
        "--effort",
        "--execute",
        "--json",
      ]);
    }
  });
});
