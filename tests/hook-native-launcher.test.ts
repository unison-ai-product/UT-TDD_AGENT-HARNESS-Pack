import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { gte, minVersion, validRange } from "semver";
import { afterEach, describe, expect, it } from "vitest";
import { CODEX_GIT_ROOT_PREFIX } from "../src/lint/hook-invocation.ts";
import { MISSING_RUNTIME_GUARD_BOOTSTRAP } from "../src/lint/project-hook.ts";
import { BUILTIN_GITHUB_TEMPLATES } from "../src/setup/templates.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const repoRoot = process.cwd();

type ClaudeSettingsForFailureParity = {
  hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>;
};
type ClaudeHookRow = {
  event: string;
  matcher: string;
  entryIndex: number;
  hookIndex: number;
  hook: Record<string, unknown>;
};

function loadClaudeFailureSettings() {
  return [
    {
      label: "source",
      settings: JSON.parse(
        readFileSync(join(repoRoot, ".claude", "settings.json"), "utf8"),
      ) as ClaudeSettingsForFailureParity,
    },
    {
      label: "Pack template",
      settings: JSON.parse(
        readFileSync(
          join(repoRoot, "docs", "templates", "adapter", ".claude", "settings.json"),
          "utf8",
        ),
      ) as ClaudeSettingsForFailureParity,
    },
    {
      label: "generator",
      settings: JSON.parse(
        BUILTIN_GITHUB_TEMPLATES["adapter/.claude/settings.json"],
      ) as ClaudeSettingsForFailureParity,
    },
  ];
}

function claudeHookRows(settings: ClaudeSettingsForFailureParity): ClaudeHookRow[] {
  return Object.entries(settings.hooks).flatMap(([event, entries]) =>
    entries.flatMap((entry, entryIndex) =>
      entry.hooks.map((hook, hookIndex) => ({
        event,
        matcher: entry.matcher ?? "",
        entryIndex,
        hookIndex,
        hook,
      })),
    ),
  );
}

function hookFailureState(rows: ClaudeHookRow[]) {
  return rows.map(({ event, matcher, entryIndex, hookIndex, hook }) => ({
    key: `${event}|${matcher}|${entryIndex}|${hookIndex}`,
    onFailure: Object.hasOwn(hook, "onFailure")
      ? { present: true, value: hook.onFailure }
      : { present: false },
    blockOnFailure: Object.hasOwn(hook, "blockOnFailure")
      ? { present: true, value: hook.blockOnFailure }
      : { present: false },
  }));
}

function meetsUnflaggedTypeScriptFloor(range: string): boolean {
  const valid = validRange(range);
  if (valid === null) return false;
  const minimum = minVersion(valid);
  return minimum !== null && gte(minimum, "22.18.0");
}
// PLAN-L7-522 S1-b: common/run-bun.ts is retired. The generated wrapper is
// launched directly by Node, so the execution contract is tested on it.
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "ut-tdd-hook-launcher-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    removeTestTree(directory);
  }
});

const WRAPPER_TEMPLATE = BUILTIN_GITHUB_TEMPLATES["common/ut-tdd.mjs"];

function materializeWrapper(cliBody: string | null): { root: string; wrapper: string } {
  const root = temporaryDirectory();
  const wrapper = join(root, "ut-tdd.mjs");
  const cli = join(root, "recorder.mjs");
  if (cliBody !== null) writeFileSync(cli, cliBody, "utf8");
  writeFileSync(
    wrapper,
    WRAPPER_TEMPLATE.replace("{{UT_TDD_SOURCE_CLI_JSON}}", JSON.stringify(cli)),
    "utf8",
  );
  return { root, wrapper };
}

const RECORDER = [
  'import { readFileSync, writeFileSync } from "node:fs";',
  "const [output, ...forwarded] = process.argv.slice(2);",
  'writeFileSync(output, JSON.stringify({ forwarded, stdin: readFileSync(0, "utf8") }));',
].join("\n");

describe("Claude hook wrapper execution contract (issue #123 / PLAN-L7-522 S1-b)", () => {
  it("U-HOOKEXEC-001/008: absent-runtime fixtures reach the wrapper and do not record", () => {
    const recorderOutput = join(temporaryDirectory(), "recorded.json");
    const withRecorder = materializeWrapper(RECORDER);
    const recorderResult = spawnSync(process.execPath, [withRecorder.wrapper, recorderOutput], {
      cwd: withRecorder.root,
      encoding: "utf8",
      windowsHide: true,
    });

    expect(recorderResult.error).toBeUndefined();
    expect(typeof recorderResult.status).toBe("number");
    expect(recorderResult.stderr).toContain("consumer_runtime_absent");
    expect(() => readFileSync(recorderOutput, "utf8")).toThrow();

    const recorderOutputWithoutEntrypoint = join(
      temporaryDirectory(),
      "recorded-without-entrypoint.json",
    );
    const withoutEntrypoint = materializeWrapper(null);
    const missingEntrypointResult = spawnSync(
      process.execPath,
      [withoutEntrypoint.wrapper, recorderOutputWithoutEntrypoint],
      {
        cwd: withoutEntrypoint.root,
        encoding: "utf8",
        windowsHide: true,
      },
    );

    expect(missingEntrypointResult.error).toBeUndefined();
    expect(typeof missingEntrypointResult.status).toBe("number");
    expect(missingEntrypointResult.stderr).toContain("consumer_runtime_absent");
    expect(() => readFileSync(recorderOutputWithoutEntrypoint, "utf8")).toThrow();
  });

  it("U-HOOKEXEC-001: refuses to launch without the consumer-local sealed runtime", () => {
    const output = join(temporaryDirectory(), "result.json");
    const { root, wrapper } = materializeWrapper(RECORDER);
    const forwarded = ["plain", "contains spaces", 'quote"inside', "a&b", "日本語"];
    const stdin = '{"hook_event_name":"SessionStart","value":"a & b"}';

    const result = spawnSync(process.execPath, [wrapper, output, ...forwarded], {
      cwd: root,
      input: stdin,
      encoding: "utf8",
      windowsHide: true,
    });

    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain("consumer_runtime_absent");
    expect(result.stderr).toContain("setup --worktree");
    expect(() => readFileSync(output, "utf8")).toThrow();
  });

  it("U-HOOKEXEC-008: fails closed when no project-local entrypoint can be resolved", () => {
    const { root, wrapper } = materializeWrapper(null);
    const result = spawnSync(process.execPath, [wrapper, "should-not-run"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("consumer_runtime_absent");
    expect(result.stderr).toContain("setup --worktree");
  });

  it("U-HOOKEXEC-008: uses direct executable spawning and never delegates to a shell host", () => {
    expect(WRAPPER_TEMPLATE).toContain(
      "spawnSync(process.execPath, [entry, ...process.argv.slice(2)]",
    );
    expect(WRAPPER_TEMPLATE).toContain("windowsHide: true");
    expect(WRAPPER_TEMPLATE).not.toMatch(
      /\b(?:cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh|sh(?:\.exe)?)\b/i,
    );
    expect(WRAPPER_TEMPLATE).not.toContain("shell: true");
  });

  it("U-HOOKEXEC-009: requires the first Node release line with unflagged TypeScript execution", () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      engines?: { node?: string };
    };
    // Every version admitted by the range must meet the unflagged-TS floor.
    const pinned = manifest.engines?.node ?? "";
    expect(meetsUnflaggedTypeScriptFloor(pinned)).toBe(true);
  });

  it("U-HOOKEXEC-009: rejects below-floor alternatives and invalid ranges", () => {
    expect(meetsUnflaggedTypeScriptFloor(">=22.18.0 <25")).toBe(true);
    expect(meetsUnflaggedTypeScriptFloor(">=22.18.0 || <22.18.0")).toBe(false);
    expect(meetsUnflaggedTypeScriptFloor("22.x")).toBe(false);
    expect(meetsUnflaggedTypeScriptFloor("not-a-range")).toBe(false);
  });

  describe("U-HOOKEXEC-014: source, Pack template, and generator failure-policy parity", () => {
    it("precondition: all three settings contain both guards and the five record/session hooks", () => {
      for (const { label, settings } of loadClaudeFailureSettings()) {
        const rows = claudeHookRows(settings);
        const guards = rows.filter((row) => row.event === "PreToolUse");
        expect(guards, label).toHaveLength(2);
        expect(guards.map((row) => row.matcher).sort(), label).toEqual(
          ["Agent|Task", "Edit|Write|MultiEdit"].sort(),
        );
        const guardByMatcher = new Map(guards.map((row) => [row.matcher, row.hook]));
        expect(JSON.stringify(guardByMatcher.get("Agent|Task")), label).toContain("agent-guard");
        expect(JSON.stringify(guardByMatcher.get("Edit|Write|MultiEdit")), label).toContain(
          "work-guard",
        );
        expect(
          ["SessionStart", "PostToolUse", "Stop", "SubagentStop"].map(
            (event) => rows.filter((row) => row.event === event).length,
          ),
          label,
        ).toEqual([1, 1, 2, 1]);
      }
    });

    it("U-HOOKEXEC-014: keeps record/session hooks fail-open in all three settings", () => {
      for (const { label, settings } of loadClaudeFailureSettings()) {
        const recordHooks = claudeHookRows(settings).filter((row) =>
          ["SessionStart", "PostToolUse", "Stop", "SubagentStop"].includes(row.event),
        );
        expect(
          recordHooks.every((row) => !Object.hasOwn(row.hook, "onFailure")),
          label,
        ).toBe(true);
      }
    });

    it("U-HOOKEXEC-014: requires both guards to use onFailure block", () => {
      for (const { label, settings } of loadClaudeFailureSettings()) {
        const guards = claudeHookRows(settings).filter((row) => row.event === "PreToolUse");
        expect(
          Object.fromEntries(guards.map((row) => [row.matcher, row.hook.onFailure])),
          label,
        ).toEqual({
          "Agent|Task": "block",
          "Edit|Write|MultiEdit": "block",
        });
      }
    });

    it("U-HOOKEXEC-014: rejects the obsolete blockOnFailure key everywhere", () => {
      for (const { label, settings } of loadClaudeFailureSettings()) {
        const legacyRows = claudeHookRows(settings).filter((row) =>
          Object.hasOwn(row.hook, "blockOnFailure"),
        );
        expect(legacyRows, label).toEqual([]);
      }
    });

    it("U-HOOKEXEC-014: keeps hook-specific failure fields aligned across all three settings", () => {
      const [source, pack, generator] = loadClaudeFailureSettings().map(({ settings }) =>
        hookFailureState(claudeHookRows(settings)),
      );
      expect(pack).toEqual(source);
      expect(generator).toEqual(source);
    });
  });

  it("U-HOOKEXEC-002/U-HOOKEXEC-003/U-HOOKEXEC-004/U-HOOKEXEC-007: routes all Claude hooks as exact argv and preserves policy", () => {
    const settings = JSON.parse(
      readFileSync(join(repoRoot, ".claude", "settings.json"), "utf8"),
    ) as {
      hooks: Record<
        string,
        { hooks: { command: string; args?: string[]; onFailure?: string }[] }[]
      >;
    };
    const hooks = Object.values(settings.hooks).flatMap((entries) =>
      entries.flatMap((entry) => entry.hooks),
    );

    expect(hooks).toHaveLength(7);
    for (const hook of hooks) {
      expect(hook.command).toBe("node");
      // PR-C: launcher shim を廃し node 直起動 (第一引数は実 hook script / cli)。
      expect(hook.args?.[0]).toMatch(
        /^\$\{CLAUDE_PROJECT_DIR\}\/(?:\.claude\/hooks\/[a-z-]+\.ts|src\/cli\.ts)$/,
      );
      expect(hook.args?.some((token) => token.includes("run-bun"))).toBe(false);
      expect(hook.args?.slice(1).every((token) => token.length > 0)).toBe(true);
      expect(
        hook.args?.some((token) => /(?:cmd|powershell|pwsh|sh)(?:\.exe)?/i.test(basename(token))),
      ).toBe(false);
    }
    const preToolHooks = (
      settings.hooks.PreToolUse as {
        hooks: { command: string; args?: string[]; onFailure?: string }[];
      }[]
    ).flatMap((entry) => entry.hooks);
    expect(preToolHooks.every((hook) => hook.onFailure === "block")).toBe(true);
    for (const event of ["SessionStart", "PostToolUse", "Stop", "SubagentStop"]) {
      expect(
        settings.hooks[event]
          .flatMap((entry) => entry.hooks)
          .every((hook) => hook.onFailure === undefined),
      ).toBe(true);
    }
  });

  it("U-HOOKEXEC-005/U-HOOKEXEC-006: keeps Codex separation and exact Pack launcher argv", () => {
    const settings = JSON.parse(BUILTIN_GITHUB_TEMPLATES["adapter/.claude/settings.json"]) as {
      hooks: Record<string, { hooks: { command: string; args?: string[] }[] }[]>;
    };
    const actual = Object.fromEntries(
      Object.entries(settings.hooks).map(([event, entries]) => [
        event,
        entries.flatMap((entry) => entry.hooks.map((hook) => [hook.command, ...(hook.args ?? [])])),
      ]),
    );

    expect(actual).toEqual({
      PreToolUse: [
        [
          "node",
          "-e",
          MISSING_RUNTIME_GUARD_BOOTSTRAP,
          ".ut-tdd/bin/ut-tdd.mjs",
          "hook",
          "agent-guard",
        ],
        [
          "node",
          "-e",
          MISSING_RUNTIME_GUARD_BOOTSTRAP,
          ".ut-tdd/bin/ut-tdd.mjs",
          "hook",
          "work-guard",
        ],
      ],
      SessionStart: [["node", ".ut-tdd/bin/ut-tdd.mjs", "session", "start"]],
      PostToolUse: [["node", ".ut-tdd/bin/ut-tdd.mjs", "hook", "post-tool-use"]],
      Stop: [
        ["node", ".ut-tdd/bin/ut-tdd.mjs", "session", "summary"],
        ["node", ".ut-tdd/bin/ut-tdd.mjs", "hook", "claude-memory-wake"],
      ],
      SubagentStop: [["node", ".ut-tdd/bin/ut-tdd.mjs", "hook", "subagent-stop"]],
    });
    const wrapper = BUILTIN_GITHUB_TEMPLATES["common/ut-tdd.mjs"];
    const codexHooks = JSON.parse(BUILTIN_GITHUB_TEMPLATES["adapter/.codex/hooks.json"]) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    const codexCommands = Object.values(codexHooks.hooks).flatMap((entries) =>
      entries.flatMap((entry) => entry.hooks),
    );
    // PLAN-L7-668 §3: Codex は command+args ではなく、git root 解決の固定前置部分を持つ 1 文字列。
    expect(
      codexCommands.every((hook) =>
        hook.command.startsWith(`node "${CODEX_GIT_ROOT_PREFIX}.ut-tdd/bin/ut-tdd.mjs"`),
      ),
    ).toBe(true);
    expect(wrapper).toContain("spawnSync(process.execPath");
    expect(wrapper).toContain("windowsHide: true");
    expect(wrapper).not.toContain("shell:");
    expect(wrapper).not.toContain("ut-tdd.cmd");
  });
});
