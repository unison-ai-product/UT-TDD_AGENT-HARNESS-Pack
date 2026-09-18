import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_GITHUB_TEMPLATES } from "../src/setup/templates.ts";

const repoRoot = process.cwd();
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
    rmSync(directory, { recursive: true, force: true });
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

    expect(result.status, result.stderr).toBe(78);
    expect(result.stderr).toContain("consumer_runtime_absent");
    expect(() => readFileSync(output, "utf8")).toThrow();
  });

  it("U-HOOKEXEC-008: fails closed when no project-local entrypoint can be resolved", () => {
    const { root, wrapper } = materializeWrapper(null);
    const result = spawnSync(process.execPath, [wrapper, "should-not-run"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });

    expect(result.status).toBe(78);
    expect(result.stderr).toContain("consumer_runtime_absent");
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
    // F0a pins engines.node to an exact version (toolchain-pin lint); the
    // unflagged-TS floor stays 22.18, so ranges and pins below it must fail.
    const pinned = manifest.engines?.node ?? "";
    const exact = /^(\d+)\.(\d+)\.\d+$/.exec(pinned);
    expect(exact).not.toBeNull();
    const major = Number(exact?.[1]);
    const minor = Number(exact?.[2]);
    expect(major > 22 || (major === 22 && minor >= 18)).toBe(true);
  });

  it("U-HOOKEXEC-010: keeps Windows process-tree custody open until the Rust kernel owns it", () => {
    const plan = readFileSync(
      join(repoRoot, "docs", "plans", "PLAN-L7-139-codex-hook-adapter.md"),
      "utf8",
    );
    expect(plan).toContain("Issue #134");
    expect(plan).toContain("Windows Job Object");
    expect(plan).toContain("未解消");
  });

  it("U-HOOKEXEC-002/U-HOOKEXEC-003/U-HOOKEXEC-004/U-HOOKEXEC-007: routes all Claude hooks as exact argv and preserves policy", () => {
    const settings = JSON.parse(
      readFileSync(join(repoRoot, ".claude", "settings.json"), "utf8"),
    ) as {
      hooks: Record<
        string,
        { hooks: { command: string; args?: string[]; blockOnFailure?: boolean }[] }[]
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
        hooks: { command: string; args?: string[]; blockOnFailure?: boolean }[];
      }[]
    ).flatMap((entry) => entry.hooks);
    expect(preToolHooks.every((hook) => hook.blockOnFailure === true)).toBe(true);
    for (const event of ["SessionStart", "PostToolUse", "Stop", "SubagentStop"]) {
      expect(
        settings.hooks[event]
          .flatMap((entry) => entry.hooks)
          .every((hook) => hook.blockOnFailure !== true),
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
        ["node", ".ut-tdd/bin/ut-tdd.mjs", "hook", "agent-guard"],
        ["node", ".ut-tdd/bin/ut-tdd.mjs", "hook", "work-guard"],
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
      hooks: Record<string, { hooks: { command: string; args?: string[] }[] }[]>;
    };
    const codexCommands = Object.values(codexHooks.hooks).flatMap((entries) =>
      entries.flatMap((entry) => entry.hooks),
    );
    expect(
      codexCommands.every(
        (hook) => hook.command === "node" && hook.args?.[0] === ".ut-tdd/bin/ut-tdd.mjs",
      ),
    ).toBe(true);
    expect(wrapper).toContain("spawnSync(process.execPath");
    expect(wrapper).toContain("windowsHide: true");
    expect(wrapper).not.toContain("shell:");
    expect(wrapper).not.toContain("ut-tdd.cmd");
  });
});
