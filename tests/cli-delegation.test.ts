import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adapterExecutionEnv,
  executeAdapterPlanForCli,
  registerDelegationCommands,
  safeLoadUntrackedAddedFiles,
} from "../src/cli/delegation.ts";
import { buildAdapterPlan } from "../src/runtime/adapter.ts";

// issue #721 finding 2: the untracked-added loader (used by the review-guard exemption at the
// delegation call site) must fail-close to "no exemption" when it throws, not silently exempt.
const untrackedLoader = vi.hoisted(() => ({
  fail: false,
  paths: [] as string[],
  changed: null as string[][] | null,
}));
vi.mock("../src/lint/change-impact.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lint/change-impact.ts")>();
  return {
    ...actual,
    loadWorkingTreeStatus: (repoRoot: string) => {
      const queue = untrackedLoader.changed;
      if (!queue) return actual.loadWorkingTreeStatus(repoRoot);
      const changed = queue.length > 1 ? (queue.shift() ?? []) : (queue[0] ?? []);
      return { changed, untrackedAdded: [] };
    },
    loadUntrackedAddedFiles: (repoRoot: string) => {
      if (untrackedLoader.fail) {
        throw new Error("simulated untracked-added loader failure (issue #721 finding 2)");
      }
      return untrackedLoader.paths.length > 0
        ? untrackedLoader.paths
        : actual.loadUntrackedAddedFiles(repoRoot);
    },
  };
});

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
  "UT_TDD_DISABLE_CLAUDE_MEMORY_WAKE",
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

  it("U-MEMWAKE-006: non-interactive Claude delegation disables the idle-session wake hook", () => {
    const claudeEnv = adapterExecutionEnv("claude", {
      UT_TDD_DISABLE_CLAUDE_MEMORY_WAKE: "0",
    });
    const codexEnv = adapterExecutionEnv("codex");

    expect(claudeEnv.UT_TDD_DISABLE_CLAUDE_MEMORY_WAKE).toBe("1");
    expect(codexEnv.UT_TDD_DISABLE_CLAUDE_MEMORY_WAKE).toBeUndefined();
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
        "--review-pr",
        "--review-head",
        "--review-revision",
        "--review-author-family",
        "--review-memory-id",
        "--execute",
        "--json",
      ]);
    }
  });

  it("U-ADAPTER-010: hides the delegated provider console window", () => {
    const sessionPrefix = `issue683-delegation-${Date.now()}`;
    const fixtureRoot = mkdtempSync(join(tmpdir(), "ut-tdd-cli-delegation-"));
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(fixtureRoot);
    let spawnOptions: { windowsHide?: boolean } | undefined;
    try {
      const plan = buildAdapterPlan(
        { provider: "codex", role: "se", task: "probe delegation", execute: true },
        "codex-only",
      );
      const result = executeAdapterPlanForCli(
        plan,
        { sessionPrefix, toolName: "codex" },
        {
          gitBranch: () => "test/issue683",
          gitHead: () => "deadbee",
          runSessionStartSideEffects: () => {},
          writeHandoverWarnings: () => {},
          spawnSync: (_command, _args, options) => {
            spawnOptions = options;
            return { status: 0, signal: null };
          },
        },
      );

      expect(result.exit_code).toBe(0);
      expect(spawnOptions?.windowsHide).toBe(true);
    } finally {
      cwd.mockRestore();
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});

describe("CLI delegation review-guard untracked-added exemption (issue #721 finding 2)", () => {
  it.each([
    { loaderFails: false, expected: [".ut-tdd/memory/concurrent.md"] },
    { loaderFails: true, expected: [] },
  ])("U-ADAPTER-012: loader fails=$loaderFails → untracked-added exemption set $expected (fail-close on loader error)", ({
    loaderFails,
    expected,
  }) => {
    untrackedLoader.fail = loaderFails;
    untrackedLoader.paths = [".ut-tdd/memory/concurrent.md"];
    try {
      // 失敗時に空集合 (= exemption なし) へ倒れることを固定する。空集合は review-guard 側で
      // 通常の violation 判定に戻る (U-RGUARD-015/016)。対照として正常時は loader の結果を
      // そのまま返し、失敗時の空集合が loader 失敗に起因することを示す。
      expect(safeLoadUntrackedAddedFiles("C:/unused-repo-root")).toEqual(expected);
    } finally {
      untrackedLoader.fail = false;
      untrackedLoader.paths = [];
    }
  });

  it.each([
    { loaderFails: false, violation: false },
    { loaderFails: true, violation: true },
  ])("U-ADAPTER-013: call site with loader fails=$loaderFails → concurrent memory addition violation=$violation", ({
    loaderFails,
    violation,
  }) => {
    // executeAdapterPlanForCli の read-only role 経路で、before=[] / after=[memory 追加] の同じ
    // 差分に対し、loader 正常時は exemption で警告なし、loader throw 時は exemption が外れて
    // assessReviewSession の violation が stderr に出ることを call site ごと固定する。
    const memoryPath = ".ut-tdd/memory/concurrent.md";
    untrackedLoader.fail = loaderFails;
    untrackedLoader.paths = [memoryPath];
    untrackedLoader.changed = [[], [memoryPath]];
    const fixtureRoot = mkdtempSync(join(tmpdir(), "ut-tdd-cli-delegation-guard-"));
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(fixtureRoot);
    const stderrChunks: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
        return true;
      });
    try {
      const plan = buildAdapterPlan(
        { provider: "codex", role: "blind-reviewer", task: "probe review-guard", execute: true },
        "codex-only",
      );
      const result = executeAdapterPlanForCli(
        plan,
        {
          sessionPrefix: `issue721-guard-${loaderFails ? "fail" : "ok"}`,
          toolName: "codex",
          reviewRole: "blind-reviewer",
        },
        {
          gitBranch: () => "test/issue721",
          gitHead: () => "deadbee",
          runSessionStartSideEffects: () => {},
          writeHandoverWarnings: () => {},
          spawnSync: () => ({ status: 0, signal: null }),
        },
      );
      expect(result.exit_code).toBe(0);
      const guardLines = stderrChunks
        .join("")
        .split("\n")
        .filter((line) => line.startsWith("review-guard"));
      if (violation) {
        expect(guardLines.join("\n")).toContain("review-guard - violation");
        expect(guardLines.join("\n")).toContain(memoryPath);
      } else {
        expect(guardLines.filter((line) => line.includes("violation"))).toEqual([]);
      }
    } finally {
      untrackedLoader.fail = false;
      untrackedLoader.paths = [];
      untrackedLoader.changed = null;
      stderrSpy.mockRestore();
      cwd.mockRestore();
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
