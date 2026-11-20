import type { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adapterExecutionEnv, executeAdapterPlanForCli } from "../src/cli/delegation.ts";
import { scanPostMergeBackstop } from "../src/feedback/post-merge-backstop.ts";
import { type AdapterPlan, isProviderCommandSpawnable } from "../src/runtime/adapter.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeTestTree(root);
  vi.restoreAllMocks();
});

function fixtureRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function runPostMergeBackstop(): Array<{
  command: string;
  args: readonly string[];
  options: Record<string, unknown>;
}> {
  const calls: Array<{
    command: string;
    args: readonly string[];
    options: Record<string, unknown>;
  }> = [];
  const run = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    if (command === "git") return "https://github.com/example/harness.git\n";
    return "[]";
  }) as unknown as typeof execFileSync;

  const result = scanPostMergeBackstop({
    repoRoot: fixtureRoot("ut-gh-timeout-post-merge-"),
    now: "2026-11-18T00:00:00.000Z",
    execFileSync: run,
  });
  expect(result).toMatchObject({ ok: true, detections: [], pagesScanned: 1 });
  return calls;
}

describe("gh timeout and prompt boundary exceptions", () => {
  it("U-CMDINPUT-024: delegation preserves adapter env without adding a timeout", () => {
    const root = fixtureRoot("ut-gh-timeout-delegation-");
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    const previousPromptDisabled = process.env.GH_PROMPT_DISABLED;
    delete process.env.GH_PROMPT_DISABLED;
    const plan: AdapterPlan = {
      provider: "codex",
      available: true,
      command: "codex",
      args: ["exec", "-"],
      stdin: "task input",
      env: { UT_TDD_TIMEOUT_BOUNDARY_SENTINEL: "preserved" },
      dry_run: false,
      messages: [],
    };
    let spawnOptions: { env?: NodeJS.ProcessEnv; timeout?: number } | undefined;

    try {
      const result = executeAdapterPlanForCli(
        plan,
        { sessionPrefix: "gh-timeout-boundary", toolName: "codex" },
        {
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
      expect(spawnOptions).toBeDefined();
      expect(Object.hasOwn(spawnOptions ?? {}, "timeout")).toBe(false);
      expect(isDeepStrictEqual(spawnOptions?.env, adapterExecutionEnv("codex", plan.env))).toBe(
        true,
      );
      expect(spawnOptions?.env?.UT_TDD_TIMEOUT_BOUNDARY_SENTINEL).toBe("preserved");
      expect(spawnOptions?.env?.GH_PROMPT_DISABLED).toBeUndefined();
    } finally {
      cwd.mockRestore();
      if (previousPromptDisabled === undefined) {
        delete process.env.GH_PROMPT_DISABLED;
      } else {
        process.env.GH_PROMPT_DISABLED = previousPromptDisabled;
      }
    }
  });

  it("U-CMDINPUT-024: provider capability probe has no timeout or prompt env", () => {
    const root = fixtureRoot("ut-gh-timeout-provider-probe-");
    const binary = join(root, process.platform === "win32" ? "codex.cmd" : "codex");
    writeFileSync(binary, "");
    const env = {
      PATH: process.env.PATH ?? "",
      UT_TDD_CODEX_BIN: binary,
      UT_TDD_TIMEOUT_BOUNDARY_SENTINEL: "preserved",
    };
    let probeOptions:
      | { env: NodeJS.ProcessEnv; timeout?: number; windowsHide: boolean }
      | undefined;

    const available = isProviderCommandSpawnable("codex", {
      env,
      platform: process.platform,
      runProbe: ({ options }) => {
        probeOptions = options;
        return { status: 0 };
      },
    });

    expect(available).toBe(true);
    expect(probeOptions).toBeDefined();
    expect(Object.hasOwn(probeOptions ?? {}, "timeout")).toBe(false);
    expect(probeOptions?.env === env).toBe(true);
    expect(probeOptions?.env.UT_TDD_TIMEOUT_BOUNDARY_SENTINEL).toBe("preserved");
    expect(probeOptions?.env.GH_PROMPT_DISABLED).toBeUndefined();
  });

  it("U-CMDINPUT-025: post-merge gh timeout remains exactly 10 seconds", () => {
    const calls = runPostMergeBackstop();
    const ghCall = calls.find((call) => call.command === "gh");

    expect(calls.map((call) => call.command)).toEqual(["git", "gh"]);
    expect(ghCall?.options.timeout).toBe(10_000);
  });

  it("U-CMDINPUT-025: post-merge gh adds prompt suppression while retaining its timeout", () => {
    const calls = runPostMergeBackstop();
    const ghCall = calls.find((call) => call.command === "gh");

    expect(ghCall?.options.timeout).toBe(10_000);
    expect((ghCall?.options.env as NodeJS.ProcessEnv | undefined)?.GH_PROMPT_DISABLED).toBe("1");
  });
});
