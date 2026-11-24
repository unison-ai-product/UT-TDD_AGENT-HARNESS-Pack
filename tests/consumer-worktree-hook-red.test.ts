import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_GITHUB_TEMPLATES } from "../src/setup/templates.ts";
import { gitTextTrimmed as git } from "./support/git.ts";
import { heavyAfterEach } from "./support/hook-bounds.ts";
import { removeFixtureTree } from "./support/pack-consumer-runtime.ts";

type ClaudeHook = {
  command: string;
  args: string[];
  matcher?: string;
};

type ClaudeSettings = {
  hooks: Record<string, Array<{ matcher?: string; hooks: ClaudeHook[] }>>;
};

type HookFixture = {
  readonly mainRoot: string;
  readonly worktreeRoot: string;
  readonly launcherPath: string;
  readonly settings: ClaudeSettings;
  readonly agentGuard: ClaudeHook;
  readonly workGuard: ClaudeHook;
};

const fixtureRootsForThisFile: string[] = [];

function createHookFixture(): HookFixture {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "ut-tdd cwtrt hook red "));
  fixtureRootsForThisFile.push(fixtureRoot);

  const mainRoot = join(fixtureRoot, "main");
  const worktreeRoot = join(fixtureRoot, "linked-worktree");
  mkdirSync(mainRoot, { recursive: true });
  git(mainRoot, ["init", "-q", "-b", "main"]);
  git(mainRoot, ["config", "user.email", "test@example.invalid"]);
  git(mainRoot, ["config", "user.name", "UT-TDD consumer worktree hook test"]);
  git(mainRoot, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(mainRoot, "README.md"), "# isolated consumer\n");
  git(mainRoot, ["add", "README.md"]);
  git(mainRoot, ["commit", "-qm", "test: initialize isolated consumer"]);
  git(mainRoot, ["worktree", "add", "-q", "-b", "test/linked-worktree", worktreeRoot, "HEAD"]);

  // Materialize the canonical Pack setup template bytes in an isolated linked
  // worktree, then invoke the exact hook argv recorded in the generated file.
  // This exercises template output, not the Pack setup CLI application path.
  const targetSettingsPath = join(worktreeRoot, ".claude", "settings.json");
  const launcherPath = join(worktreeRoot, ".ut-tdd", "bin", "ut-tdd.mjs");
  mkdirSync(dirname(targetSettingsPath), { recursive: true });
  mkdirSync(dirname(launcherPath), { recursive: true });
  writeFileSync(targetSettingsPath, BUILTIN_GITHUB_TEMPLATES["adapter/.claude/settings.json"]);
  writeFileSync(launcherPath, BUILTIN_GITHUB_TEMPLATES["common/ut-tdd.mjs"]);

  const settings = JSON.parse(readFileSync(targetSettingsPath, "utf8")) as ClaudeSettings;
  const preToolUse = settings.hooks.PreToolUse.flatMap((entry) =>
    entry.hooks.map((hook) => ({ ...hook, matcher: entry.matcher })),
  );
  const agentGuard = preToolUse.find((hook) => hook.matcher === "Agent|Task");
  const workGuard = preToolUse.find((hook) => hook.matcher === "Edit|Write|MultiEdit");
  if (!agentGuard || !workGuard) throw new Error("generated consumer guard hooks are missing");

  return { mainRoot, worktreeRoot, launcherPath, settings, agentGuard, workGuard };
}

function runGeneratedHook(
  fixture: HookFixture,
  hook: ClaudeHook,
  input: unknown = { tool_name: "Edit", tool_input: { file_path: "README.md" } },
) {
  return spawnSync(hook.command, hook.args, {
    cwd: fixture.worktreeRoot,
    encoding: "utf8",
    input: `${JSON.stringify(input)}\n`,
    timeout: 15_000,
    windowsHide: true,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: fixture.worktreeRoot,
      UT_TDD_PROJECT_DIR: fixture.worktreeRoot,
      UT_TDD_SKIP_UPDATE_CHECK: "1",
    },
  });
}

function expectMissingRuntimeGuidance(output: string, fixture: HookFixture): void {
  const normalizedOutput = output.toLowerCase().replaceAll("\\", "/");
  expect(normalizedOutput).toContain("setup --worktree");
  expect(normalizedOutput).toContain(
    realpathSync.native(fixture.mainRoot).toLowerCase().replaceAll("\\", "/"),
  );
  expect(normalizedOutput).toContain(
    realpathSync.native(fixture.worktreeRoot).toLowerCase().replaceAll("\\", "/"),
  );
}

heavyAfterEach("teardown", () => {
  for (const root of fixtureRootsForThisFile.splice(0)) removeFixtureTree(root);
});

describe("issue #1525 consumer worktree missing-runtime guard guidance", () => {
  it("generated Pack hooks and launcher are executable preconditions", () => {
    const fixture = createHookFixture();

    expect(git(fixture.worktreeRoot, ["rev-parse", "--git-common-dir"]).toLowerCase()).not.toBe(
      git(fixture.worktreeRoot, ["rev-parse", "--git-dir"]).toLowerCase(),
    );
    expect(existsSync(fixture.launcherPath)).toBe(true);
    expect(
      existsSync(join(fixture.worktreeRoot, ".ut-tdd", "runtime", "activation", "active.json")),
    ).toBe(false);

    const result = runGeneratedHook(fixture, fixture.agentGuard, {
      tool_name: "Agent",
      tool_input: { subagent_type: "general-purpose", model: "claude-sonnet-5-5" },
    });

    // The positive control proves that the generated Pack argv reaches the
    // present launcher rather than failing in Node's module resolver. Its
    // missing-runtime result is the exact boundary exercised by U-CWTRT-007.
    expect(result.status).not.toBe(1);
    expect(`${result.stderr}\n${result.stdout}`).not.toContain("MODULE_NOT_FOUND");
    expect(result.stderr).toContain("consumer_runtime_absent");
  });

  it("U-CWTRT-007: a present launcher gives setup guidance only for absent runtime", () => {
    const fixture = createHookFixture();
    expect(existsSync(fixture.launcherPath)).toBe(true);
    expect(
      existsSync(join(fixture.worktreeRoot, ".ut-tdd", "runtime", "activation", "active.json")),
    ).toBe(false);

    const absent = runGeneratedHook(fixture, fixture.agentGuard, {
      tool_name: "Agent",
      tool_input: { subagent_type: "general-purpose", model: "claude-sonnet-5-5" },
    });

    expect(absent.status).toBe(2);
    expect(absent.stderr).toContain("consumer_runtime_absent");
    expectMissingRuntimeGuidance(absent.stderr, fixture);
    expect(absent.stdout).toBe("");
  });

  it("non-absent launcher deny remains the existing code-only exit 78 control", () => {
    const fixture = createHookFixture();
    const pointerPath = join(
      fixture.worktreeRoot,
      ".ut-tdd",
      "runtime",
      "activation",
      "active.json",
    );
    mkdirSync(dirname(pointerPath), { recursive: true });
    writeFileSync(
      pointerPath,
      `${JSON.stringify({ bundle_path: "bad", entry_path: "bad", bundle_digest: "bad", extra: true })}\n`,
    );

    const result = runGeneratedHook(fixture, fixture.agentGuard, {
      tool_name: "Agent",
      tool_input: { subagent_type: "general-purpose", model: "claude-sonnet-5-5" },
    });

    expect(result.status).toBe(78);
    expect(result.stderr.trim()).toBe("consumer_runtime_resolution_denied");
    expect(result.stderr).not.toContain("setup --worktree");
    expect(result.stdout).toBe("");
  });

  it("U-CWTRT-008: absent launcher is handled before Node module resolution", () => {
    const fixture = createHookFixture();
    rmSync(fixture.launcherPath);
    expect(existsSync(fixture.launcherPath)).toBe(false);

    const result = runGeneratedHook(fixture, fixture.agentGuard, {
      tool_name: "Agent",
      tool_input: { subagent_type: "general-purpose", model: "claude-sonnet-5-5" },
    });

    expect(result.status).toBe(2);
    expectMissingRuntimeGuidance(result.stderr, fixture);
    expect(result.stderr).not.toContain("MODULE_NOT_FOUND");
    expect(result.stderr.trim().split(/\r?\n/)).toHaveLength(1);
    expect(result.stdout).toBe("");
  });

  it("U-CWTRT-008: absent launcher is handled for the work guard", () => {
    const fixture = createHookFixture();
    rmSync(fixture.launcherPath);
    expect(existsSync(fixture.launcherPath)).toBe(false);

    const result = runGeneratedHook(fixture, fixture.workGuard);

    expect(result.status).toBe(2);
    expectMissingRuntimeGuidance(result.stderr, fixture);
    expect(result.stderr).not.toContain("MODULE_NOT_FOUND");
    expect(result.stderr.trim().split(/\r?\n/)).toHaveLength(1);
    expect(result.stdout).toBe("");
  });

  it("present launcher is still invoked by the generated hook when present", () => {
    const fixture = createHookFixture();
    const result = runGeneratedHook(fixture, fixture.agentGuard, {
      tool_name: "Agent",
      tool_input: { subagent_type: "general-purpose", model: "claude-sonnet-5-5" },
    });

    expect(result.status).not.toBe(1);
    expect(`${result.stderr}\n${result.stdout}`).not.toContain("MODULE_NOT_FOUND");
    expect(result.stderr).toContain("consumer_runtime_absent");
  });

  it("U-CWTRT-009: missing-runtime guidance is a single stderr block reason", () => {
    const fixture = createHookFixture();
    const result = runGeneratedHook(fixture, fixture.workGuard, {
      tool_name: "Edit",
      tool_input: { file_path: "README.md" },
    });
    const guidanceLines = result.stderr
      .split(/\r?\n/)
      .filter((line) => line.includes("setup --worktree"));

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(guidanceLines).toHaveLength(1);
    expectMissingRuntimeGuidance(guidanceLines[0] ?? "", fixture);
    expect(result.stderr).not.toContain("MODULE_NOT_FOUND");
  });

  it("record/session hook argv is not replaced by the missing-runtime bootstrap", () => {
    const fixture = createHookFixture();
    const sessionStart = fixture.settings.hooks.SessionStart.flatMap((entry) => entry.hooks)[0];
    const postToolUse = fixture.settings.hooks.PostToolUse.flatMap((entry) => entry.hooks)[0];

    expect(sessionStart.args).toEqual([".ut-tdd/bin/ut-tdd.mjs", "session", "start"]);
    expect(postToolUse.args).toEqual([".ut-tdd/bin/ut-tdd.mjs", "hook", "post-tool-use"]);
  });
});
