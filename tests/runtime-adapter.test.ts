import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAdapterPlan,
  buildProviderInvocation,
  isProviderCommandSpawnable,
  normalizeInvokeResult,
  normalizeProviderEffort,
  providerAvailable,
  resolveClaudeNativeCommand,
  resolveCodexNativeCommand,
} from "../src/runtime/adapter.ts";
import {
  ADAPTER_CONTEXT_HEADER,
  CLAUDE_EFFORT_ENV,
  CLAUDE_STDIN_ARGS,
  CODEX_MODEL_FLAG,
  CODEX_STDIN_ARGS,
  mapAdapterErrorPolicy,
  REQUIRED_SKILL_LABEL,
} from "../src/runtime/adapter-policy.ts";
import { modelOverrideSchema, reasoningEffortSchema } from "../src/schema/team.ts";

/** 指定パスの親ディレクトリまで作成し、空の実行ファイルを置く。 */
function touchBinary(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "");
}

describe("runtime adapter plan", () => {
  it("checks provider availability by execution mode", () => {
    expect(providerAvailable("codex", "codex-only")).toBe(true);
    expect(providerAvailable("codex", "claude-only")).toBe(false);
    expect(providerAvailable("claude", "hybrid")).toBe(true);
  });

  it("builds dry-run codex command plan", () => {
    const plan = buildAdapterPlan(
      {
        provider: "codex",
        role: "se",
        task: "implement",
        planId: "PLAN-L4-99-x",
        model: "gpt-5.3-codex",
        effort: "medium",
      },
      "hybrid",
    );
    expect(plan.available).toBe(true);
    expect(plan.dry_run).toBe(true);
    expect(plan.command).toBe("codex");
    expect(plan.args).toContain(CODEX_STDIN_ARGS[0]);
    expect(plan.args).toContain(CODEX_MODEL_FLAG);
    expect(plan.args).toContain("gpt-5.3-codex");
    expect(plan.args).not.toContain("--plan-id");
    expect(plan.model).toBe("gpt-5.3-codex");
    expect(plan.effort).toBe("medium");
    expect(plan.plan_id).toBe("PLAN-L4-99-x");
  });

  it("U-ADAPTER-SANDBOX-001: grants workspace-write exactly once to the six approved Codex workers", () => {
    const writers = ["se", "docs", "be-api", "be-logic", "db-schema", "devops-deploy"];
    for (const role of writers) {
      const plan = buildAdapterPlan(
        { provider: "codex", role, task: "implement", model: "gpt-6-luna", effort: "high" },
        "hybrid",
      );
      expect(plan.args.filter((arg) => arg === "--sandbox")).toHaveLength(1);
      expect(plan.args.filter((arg) => arg === "workspace-write")).toHaveLength(1);
      expect(plan.args).toEqual([
        CODEX_STDIN_ARGS[0],
        "--sandbox",
        "workspace-write",
        CODEX_MODEL_FLAG,
        "gpt-6-luna",
        "-c",
        "model_reasoning_effort=high",
        CODEX_STDIN_ARGS[1],
      ]);
      expect(plan.stdin).toBe("implement");
    }
  });

  it("U-ADAPTER-SANDBOX-002: preserves existing invocations without workspace-write for non-writers, advisor, aim, reviewer, and unknown direct-adapter roles", () => {
    const nonWriters = ["advisor", "aim", "qa", "blind-reviewer", "unknown-worker"];
    for (const role of nonWriters) {
      const plan = buildAdapterPlan(
        { provider: "codex", role, task: "inspect", model: "gpt-6.1-sol", effort: "low" },
        "hybrid",
      );
      expect(plan.command).toBe("codex");
      expect(plan.args).toEqual([
        CODEX_STDIN_ARGS[0],
        CODEX_MODEL_FLAG,
        "gpt-6.1-sol",
        "-c",
        "model_reasoning_effort=low",
        CODEX_STDIN_ARGS[1],
      ]);
      expect(plan.args).not.toContain("--sandbox");
      expect(plan.args).not.toContain("workspace-write");
    }
  });

  it("U-ADAPTER-SANDBOX-003: keeps Claude invocation unchanged even for a writer-named role", () => {
    const plan = buildAdapterPlan(
      {
        provider: "claude",
        role: "se",
        task: "implement",
        model: "claude-sonnet-5",
        effort: "middle",
      },
      "hybrid",
    );
    expect(plan.args).toEqual([
      ...CLAUDE_STDIN_ARGS,
      "--model",
      "claude-sonnet-5",
      "--effort",
      "medium",
    ]);
    expect(plan.env).toEqual({ [CLAUDE_EFFORT_ENV]: "medium" });
    expect(plan.stdin).toBe("implement");
    expect(plan.args).not.toContain("--sandbox");
  });

  it("marks unavailable provider as not available", () => {
    const plan = buildAdapterPlan({ provider: "claude", role: "tl", task: "review" }, "codex-only");
    expect(plan.available).toBe(false);
    expect(plan.messages[0]).toContain("not available");
  });

  it("injects scoped skill paths into provider stdin without moving task text to argv", () => {
    const plan = buildAdapterPlan(
      {
        provider: "codex",
        role: "se",
        task: "implement",
        contextInjection: {
          required_paths: ["docs/skills/refactoring.md"],
          optional_paths: ["docs/skills/review-checklist.yaml"],
        },
      },
      "hybrid",
    );

    expect(plan.stdin).toContain("implement");
    expect(plan.stdin).toContain(ADAPTER_CONTEXT_HEADER);
    expect(plan.stdin).toContain(`- ${REQUIRED_SKILL_LABEL}: docs/skills/refactoring.md`);
    expect(plan.stdin).toContain("- optional skill: docs/skills/review-checklist.yaml");
    expect(plan.context_injection).toEqual({
      required_paths: ["docs/skills/refactoring.md"],
      optional_paths: ["docs/skills/review-checklist.yaml"],
    });
    expect(plan.args).not.toContain("docs/skills/refactoring.md");
  });

  it("builds claude command plan with Claude Code print-mode stdin", () => {
    const plan = buildAdapterPlan(
      {
        provider: "claude",
        role: "pmo-sonnet",
        task: "review",
        planId: "PLAN-L4-99-x",
        model: "claude-sonnet-4-6",
        effort: "medium",
      },
      "hybrid",
    );
    expect(plan.available).toBe(true);
    expect(plan.command).toBe("claude");
    expect(plan.args).toEqual([
      ...CLAUDE_STDIN_ARGS,
      "--model",
      "claude-sonnet-4-6",
      "--effort",
      "medium",
    ]);
    expect(plan.stdin).toBe("review");
    expect(plan.model).toBe("claude-sonnet-4-6");
    expect(plan.effort).toBe("medium");
    expect(plan.env).toEqual({ [CLAUDE_EFFORT_ENV]: "medium" });
    expect(plan.args).not.toContain("--role");
    expect(plan.args).not.toContain("--task");
    expect(plan.args).not.toContain("PLAN-L4-99-x");
    expect(plan.plan_id).toBe("PLAN-L4-99-x");
  });

  it.fails("normalizes extended UT-TDD effort values at the Claude provider boundary", () => {
    expect(normalizeProviderEffort("claude", "middle")).toBe("medium");
    expect(normalizeProviderEffort("claude", "xhigh")).toBe("xhigh");
    expect(normalizeProviderEffort("codex", "xhigh")).toBe("xhigh");

    const plan = buildAdapterPlan(
      {
        provider: "claude",
        role: "pmo-sonnet",
        task: "review",
        model: "claude-sonnet-4-6",
        effort: "xhigh",
      },
      "hybrid",
    );

    expect(plan.args).toContain("--effort");
    expect(plan.args).toContain("xhigh");
    expect(plan.effort).toBe("xhigh");
    expect(plan.env).toEqual({ [CLAUDE_EFFORT_ENV]: "xhigh" });
  });

  it("U-ADAPTER-002: honors UT_TDD_CODEX_BIN before PATH lookup", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-adapter-codex-bin-"));
    try {
      const explicit = join(root, process.platform === "win32" ? "codex.cmd" : "codex");
      writeFileSync(explicit, "");

      expect(resolveCodexNativeCommand({ env: { UT_TDD_CODEX_BIN: explicit } })).toBe(explicit);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-ADAPTER-003: wraps Windows command scripts through canonical cmd.exe without shell:true", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-adapter-cmd-"));
    try {
      const explicit = join(root, "codex.cmd");
      writeFileSync(explicit, "");
      const invocation = buildProviderInvocation({
        provider: "codex",
        command: "codex",
        args: ["exec", "hello world"],
        opts: {
          platform: "win32",
          env: {
            SystemRoot: "C:\\Windows",
            UT_TDD_CODEX_BIN: explicit,
          },
        },
      });

      expect(invocation.command).toBe("C:\\Windows\\System32\\cmd.exe");
      expect(invocation.args).toEqual(["/d", "/s", "/c", `""${explicit}" "exec" "hello world""`]);
      expect(invocation.shell).toBe(false);
      expect(invocation.windowsVerbatimArguments).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-ADAPTER-009: probes Windows .cmd providers with spaces in the path", () => {
    if (process.platform !== "win32") return;
    const root = mkdtempSync(join(tmpdir(), "ut adapter cmd probe "));
    try {
      const explicit = join(root, "codex.cmd");
      const calledPath = join(root, "called.txt");
      writeFileSync(
        explicit,
        ["@echo off", `echo args=%* > "${calledPath}"`, "exit /b 0", ""].join("\r\n"),
      );

      const ok = isProviderCommandSpawnable("codex", {
        platform: "win32",
        env: {
          ...process.env,
          SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
          UT_TDD_CODEX_BIN: explicit,
        },
      });

      expect(ok).toBe(true);
      expect(readFileSync(calledPath, "utf8")).toContain("--version");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-ADAPTER-005: picks the semver-newest native Claude, not the lexicographic-largest (A-137 #6)", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-adapter-claude-ver-"));
    try {
      const codeRoot = join(root, "Claude", "claude-code");
      // 字句順では "1.9.0" > "1.10.0" だが、実際の最新は 1.10.0。
      touchBinary(join(codeRoot, "1.9.0", "claude.exe"));
      touchBinary(join(codeRoot, "1.10.0", "claude.exe"));
      touchBinary(join(codeRoot, "1.2.3", "claude.exe"));

      const resolved = resolveClaudeNativeCommand({
        platform: "win32",
        env: { APPDATA: root, USERPROFILE: root },
      });

      expect(resolved).toBe(join(codeRoot, "1.10.0", "claude.exe"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-ADAPTER-006: compares semver across mixed sources, ignoring path-prefix and platform suffix (A-137 #6)", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-adapter-claude-mixed-"));
    try {
      const codeRoot = join(root, "Claude", "claude-code");
      touchBinary(join(codeRoot, "1.0.0", "claude.exe"));
      const vscodeExt = join(
        root,
        ".vscode",
        "extensions",
        "anthropic.claude-code-1.2.0-win32-x64",
      );
      const vscodeBinary = join(vscodeExt, "resources", "native-binary", "claude.exe");
      touchBinary(vscodeBinary);

      const resolved = resolveClaudeNativeCommand({
        platform: "win32",
        env: { APPDATA: root, USERPROFILE: root },
      });

      // appData 1.0.0 < vscode 1.2.0 → mixed-source でも semver 最新 (vscode) を選ぶ。
      expect(resolved).toBe(vscodeBinary);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-ADAPTER-004: treats provider availability as a successful capability probe", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-adapter-probe-"));
    try {
      const explicit = join(root, process.platform === "win32" ? "codex.cmd" : "codex");
      writeFileSync(explicit, "");
      const seen: string[] = [];
      let probeOptions: { windowsHide: boolean } | undefined;
      const ok = isProviderCommandSpawnable("codex", {
        env: { UT_TDD_CODEX_BIN: explicit },
        platform: process.platform,
        runProbe: ({ command, args, options }) => {
          seen.push(`${command} ${args.join(" ")}`);
          probeOptions = options;
          return { status: 0 };
        },
      });

      expect(ok).toBe(true);
      expect(seen[0]).toContain("--version");
      expect(probeOptions?.windowsHide).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-ADAPTER-011: hides the Windows PATH lookup child process", () => {
    const seen: Array<{
      finder: string;
      args: string[];
      windowsHide: true;
    }> = [];
    const resolved = resolveCodexNativeCommand({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      runPathLookup: (finder, args, options) => {
        seen.push({ finder, args, windowsHide: options.windowsHide });
        return "C:\\tools\\codex.exe\r\n";
      },
    });

    expect(resolved).toBe("C:\\tools\\codex.exe");
    expect(seen).toEqual([
      {
        finder: "C:\\Windows\\System32\\where.exe",
        args: ["codex"],
        windowsHide: true,
      },
    ]);
  });

  it("U-ADAPTER-007: delivers the codex prompt via stdin so Windows .cmd shell-wrapping cannot truncate it", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-adapter-codex-stdin-"));
    try {
      const explicit = join(root, "codex.cmd");
      writeFileSync(explicit, "");
      // 改行 + cmd.exe メタ文字 (< > | ( )) を含む実プロンプトは、引数経由だと
      // shell:true の cmd.exe で 1 行目に切り詰められる。stdin 経由なら無傷。
      const multiline = "line one\nline two has <name> and | and (paren)";
      const plan = buildAdapterPlan(
        { provider: "codex", role: "qa", task: multiline, model: "gpt-5.5" },
        "hybrid",
      );

      // プロンプトは stdin で帯域外に運ぶ。positional 引数には載せない。
      expect(plan.stdin).toBe(multiline);
      expect(plan.args).not.toContain(multiline);
      expect(plan.args).toContain("exec");
      expect(plan.args).toContain("-"); // codex exec [PROMPT]: '-' = stdin から読む

      // .cmd shell ラップに乗らないプロンプトは cmd.exe が破壊しようがない。
      const invocation = buildProviderInvocation({
        provider: "codex",
        command: "codex",
        args: plan.args,
        opts: { platform: "win32", env: { SystemRoot: "C:\\Windows", UT_TDD_CODEX_BIN: explicit } },
      });
      expect(invocation.shell).toBe(false);
      expect(invocation.args.join(" ")).not.toContain("line two");
      expect(invocation.args.join(" ")).not.toContain("\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-ADAPTER-008: delivers the claude prompt via stdin so native tool markup cannot leak through argv", () => {
    const multiline =
      'review\n<invoke name="Bash"><parameter name="command">git status</parameter></invoke>';
    const plan = buildAdapterPlan(
      { provider: "claude", role: "tl", task: multiline, model: "claude-sonnet-4-6" },
      "hybrid",
    );
    expect(plan.stdin).toBe(multiline);
    expect(plan.args).toContain("--print");
    expect(plan.args).toContain("--input-format");
    expect(plan.args).toContain("text");
    expect(plan.args).not.toContain("-p");
    expect(plan.args).not.toContain(multiline);

    const invocation = buildProviderInvocation({
      provider: "claude",
      command: "claude",
      args: plan.args,
      opts: { platform: "win32", env: { SystemRoot: "C:\\Windows" } },
    });
    expect(invocation.command).not.toContain("<invoke");
    expect(invocation.command).not.toContain("\n");
  });

  it("IT-ADAPTER-01: normalizes a mock provider success into provider-independent InvokeResult", () => {
    const plan = buildAdapterPlan(
      {
        provider: "codex",
        role: "se",
        task: "implement adapter boundary",
        planId: "PLAN-L7-176-adapter-invoke-result-g8-evidence",
      },
      "hybrid",
    );

    const result = normalizeInvokeResult(plan, {
      status: 0,
      stdout: Buffer.from("done\n"),
      stderr: Buffer.from("note\n"),
    });

    expect(result).toMatchObject({
      ok: true,
      provider: "codex",
      plan_id: "PLAN-L7-176-adapter-invoke-result-g8-evidence",
      command: "codex",
      exit_code: 0,
      output: "done",
      stderr: "note\n",
    });
    if (result.ok) {
      expect(result.args).toEqual(plan.args);
    }
  });

  it("IT-ADAPTER-01: fails closed when a successful provider returns missing output", () => {
    const plan = buildAdapterPlan(
      { provider: "claude", role: "tl", task: "review", planId: "PLAN-L7-176" },
      "hybrid",
    );

    const result = normalizeInvokeResult(plan, { status: 0, stdout: "   \n", stderr: "" });

    expect(result).toMatchObject({
      ok: false,
      provider: "claude",
      plan_id: "PLAN-L7-176",
      exit_code: 0,
      error_class: "malformed_output",
      message: "provider returned success without output",
    });
  });

  it("IT-ADAPTER-01: carries provider launch errors as provider_error without throwing", () => {
    const plan = buildAdapterPlan({ provider: "codex", role: "se", task: "run" }, "hybrid");

    const result = normalizeInvokeResult(plan, {
      status: null,
      signal: null,
      error: new Error("ENOENT codex"),
      stderr: "missing binary",
    });

    expect(result).toMatchObject({
      ok: false,
      provider: "codex",
      exit_code: null,
      signal: null,
      error_class: "provider_error",
      message: "Error: ENOENT codex",
      stderr: "missing binary",
    });
  });

  it("IT-ADAPTER-02: degrades an absent provider only when fallback is allowed", () => {
    const degraded = mapAdapterErrorPolicy({
      kind: "absent",
      provider: "codex",
      retryable: false,
      message: "codex binary not found",
    });
    expect(degraded).toMatchObject({
      ok: true,
      action: "degrade",
      exit_code: 0,
      severity: "warn",
      next_action: expect.stringContaining("downgrade mode"),
    });

    const blocked = mapAdapterErrorPolicy(
      {
        kind: "absent",
        provider: "claude",
        retryable: false,
        message: "claude binary not found",
      },
      { degradationAllowed: false },
    );
    expect(blocked).toMatchObject({
      ok: false,
      action: "fail-close",
      exit_code: 1,
      severity: "error",
      next_action: expect.stringContaining("install or enable claude"),
    });
  });

  it("IT-ADAPTER-02: fails closed on authentication errors with provider login guidance", () => {
    const decision = mapAdapterErrorPolicy({
      kind: "auth",
      provider: "codex",
      retryable: false,
      message: "codex is not logged in",
    });

    expect(decision).toMatchObject({
      ok: false,
      action: "fail-close",
      exit_code: 1,
      severity: "error",
      next_action: "run codex login and retry",
    });
  });

  it("IT-ADAPTER-02: retries rate limits only until exhaustion", () => {
    const retry = mapAdapterErrorPolicy({
      kind: "rate-limit",
      provider: "claude",
      retryable: true,
      message: "plan limit reached",
    });
    expect(retry).toMatchObject({
      ok: false,
      action: "retry",
      exit_code: 75,
      severity: "warn",
    });

    const exhausted = mapAdapterErrorPolicy(
      {
        kind: "rate-limit",
        provider: "claude",
        retryable: true,
        message: "plan limit reached",
      },
      { retryExhausted: true },
    );
    expect(exhausted).toMatchObject({
      ok: false,
      action: "fail-close",
      exit_code: 1,
      severity: "error",
      next_action: expect.stringContaining("retry exhaustion"),
    });
  });

  it("IT-ADAPTER-02: skips timed-out items after the bounded retry budget", () => {
    const decision = mapAdapterErrorPolicy(
      {
        kind: "timeout",
        provider: "codex",
        retryable: true,
        message: "provider timed out",
      },
      { retryExhausted: true },
    );

    expect(decision).toMatchObject({
      ok: true,
      action: "skip",
      exit_code: 0,
      severity: "warn",
      next_action: expect.stringContaining("skip the affected item"),
    });
  });

  it("IT-ADAPTER-02: fails closed on unknown provider errors", () => {
    const decision = mapAdapterErrorPolicy({
      kind: "unknown",
      provider: "claude",
      retryable: false,
      message: "unexpected provider stderr",
    });

    expect(decision).toMatchObject({
      ok: false,
      action: "fail-close",
      exit_code: 1,
      severity: "error",
      next_action: expect.stringContaining("classify"),
    });
  });
});

describe("Issue #1261 M1 provider invocation input validation candidates", () => {
  const INVALID_MODEL_MESSAGE = "provider_model_invalid";
  const INVALID_EFFORT_MESSAGE = "provider_effort_invalid";
  const CMD_TOKEN_PERCENT_MESSAGE = "provider_cmd_token_percent_forbidden";

  function captureError(action: () => unknown): unknown {
    try {
      action();
    } catch (error) {
      return error;
    }
    return undefined;
  }

  function expectPercentTokenError(action: () => unknown, token: string): void {
    const error = captureError(action);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) return;
    expect(error.message).toBe(CMD_TOKEN_PERCENT_MESSAGE);
    expect(error.message).not.toContain(token);
  }

  it("U-CMDINPUT-003: keeps schema-approved models and aliases in adapter plans", () => {
    const task = "preserve the planned task";
    for (const model of ["gpt-5.4", "sonnet", "local"]) {
      expect(modelOverrideSchema.safeParse(model).success, model).toBe(true);
      const plan = buildAdapterPlan({ provider: "codex", role: "se", task, model }, "hybrid");
      expect(plan.available, model).toBe(true);
      expect(plan.args, model).toContain(model);
      expect(plan.stdin, model).toBe(task);
    }

    const omitted = buildAdapterPlan({ provider: "codex", role: "se", task }, "hybrid");
    expect(omitted.available).toBe(true);
    expect(omitted.args).not.toContain(CODEX_MODEL_FLAG);
  });

  ["gpt-5%", 'gpt-5"', "gpt 5", "", "gpt-5.4[1m]"].forEach((model, index) => {
    describe(`M1 invalid model fixture ${index + 1}`, () => {
      it("U-CMDINPUT-003: static invalid-model label", () => {
        expect(modelOverrideSchema.safeParse(model).success, model).toBe(false);
        const plan = buildAdapterPlan(
          { provider: "codex", role: "se", task: "keep task unchanged", model },
          "hybrid",
        );
        expect(plan.available, model).toBe(false);
        expect(plan.messages, model).toEqual([INVALID_MODEL_MESSAGE]);
      });
    });
  });

  it("U-CMDINPUT-004: preserves schema-approved effort values and provider normalization", () => {
    const cases = [
      { provider: "codex" as const, effort: "low", normalized: "low" },
      { provider: "codex" as const, effort: "medium", normalized: "medium" },
      { provider: "codex" as const, effort: "middle", normalized: "medium" },
      { provider: "codex" as const, effort: "high", normalized: "high" },
      { provider: "codex" as const, effort: "xhigh", normalized: "xhigh" },
      { provider: "claude" as const, effort: "low", normalized: "low" },
      { provider: "claude" as const, effort: "medium", normalized: "medium" },
      { provider: "claude" as const, effort: "middle", normalized: "medium" },
      { provider: "claude" as const, effort: "high", normalized: "high" },
    ];

    for (const { provider, effort, normalized } of cases) {
      expect(reasoningEffortSchema.safeParse(effort).success, `${provider}/${effort}`).toBe(true);
      const model = provider === "codex" ? "gpt-5.4" : "claude-sonnet-5-5";
      const plan = buildAdapterPlan(
        { provider, role: "se", task: "review", model, effort },
        "hybrid",
      );
      expect(plan.available, `${provider}/${effort}`).toBe(true);
      expect(plan.effort, `${provider}/${effort}`).toBe(normalized);
      if (provider === "codex") {
        expect(plan.args, `${provider}/${effort}`).toContain(
          `model_reasoning_effort=${normalized}`,
        );
        expect(plan.env, `${provider}/${effort}`).toBeUndefined();
      } else {
        expect(plan.args, `${provider}/${effort}`).toContain(normalized);
        expect(plan.env, `${provider}/${effort}`).toEqual({
          [CLAUDE_EFFORT_ENV]: normalized,
        });
      }
    }

    const omitted = buildAdapterPlan(
      { provider: "codex", role: "se", task: "review", model: "gpt-5.4" },
      "hybrid",
    );
    expect(omitted.effort).toBeUndefined();
  });

  ["extreme", ""].forEach((effort, index) => {
    describe(`M1 invalid effort fixture ${index + 1}`, () => {
      it("U-CMDINPUT-004: static invalid-effort label", () => {
        expect(reasoningEffortSchema.safeParse(effort).success, effort).toBe(false);
        const plan = buildAdapterPlan(
          {
            provider: "claude",
            role: "se",
            task: "keep task unchanged",
            model: "claude-sonnet-5-5",
            effort,
          },
          "hybrid",
        );
        expect(plan.available, effort).toBe(false);
        expect(plan.messages, effort).toEqual([INVALID_EFFORT_MESSAGE]);
      });
    });
  });

  it("U-CMDINPUT-005: invalid model fails the plan closed without rewriting task or provider", () => {
    const invalidModel = "gpt-5%raw-model";
    const task = "unchanged user task";
    const plan = buildAdapterPlan(
      { provider: "codex", role: "se", task, model: invalidModel, effort: "high" },
      "hybrid",
    );

    expect(plan.available).toBe(false);
    expect(plan.messages).toContain(INVALID_MODEL_MESSAGE);
    expect(plan.messages.join("\n")).not.toContain(invalidModel);
    expect(plan.args).toEqual([]);
    expect(plan.env).toBeUndefined();
    expect(plan.provider).toBe("codex");
    expect(plan.stdin).toBe(task);
  });

  it("U-CMDINPUT-006: invalid effort fails the plan closed", () => {
    const task = "unchanged user task";
    const validModel = "claude-sonnet-5-5";
    const invalidEffort = "extreme";
    const plan = buildAdapterPlan(
      { provider: "claude", role: "se", task, model: validModel, effort: invalidEffort },
      "hybrid",
    );

    expect(plan.available).toBe(false);
    expect(plan.messages).toContain(INVALID_EFFORT_MESSAGE);
    expect(plan.messages.join("\n")).not.toContain(invalidEffort);
    expect(plan.args).toEqual([]);
    expect(plan.env).toBeUndefined();
    expect(plan.model).toBe(validModel);
    expect(plan.provider).toBe("claude");
    expect(plan.stdin).toBe(task);
  });

  it("U-CMDINPUT-006: model diagnostic wins when both model and effort are invalid", () => {
    const task = "unchanged user task";
    const invalidEffort = "extreme";
    const bothInvalid = buildAdapterPlan(
      { provider: "claude", role: "se", task, model: "bad model", effort: invalidEffort },
      "hybrid",
    );
    expect(bothInvalid.messages).toContain(INVALID_MODEL_MESSAGE);
    expect(bothInvalid.messages).not.toContain(INVALID_EFFORT_MESSAGE);
  });

  ["cmd", "bat"].forEach((extension, index) => {
    describe(`M1 percent command extension fixture ${index + 1}`, () => {
      it("U-CMDINPUT-007: static command-path label", () => {
        const root = mkdtempSync(join(tmpdir(), "ut-adapter-percent-command-"));
        try {
          const token = join(root, `percent%path-${extension}`, `codex.${extension}`);
          touchBinary(token);
          expectPercentTokenError(
            () =>
              buildProviderInvocation({
                provider: "codex",
                command: "codex",
                args: ["exec"],
                opts: {
                  platform: "win32",
                  env: { SystemRoot: "C:\\Windows", UT_TDD_CODEX_BIN: token },
                },
              }),
            token,
          );
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    });
  });

  [
    ["percent%first", "middle", "last"],
    ["first", "percent%middle", "last"],
    ["first", "middle", "percent%last"],
  ].forEach((args, index) => {
    describe(`M1 percent argument fixture ${index + 1}`, () => {
      it("U-CMDINPUT-008: static percent-argument label", () => {
        const root = mkdtempSync(join(tmpdir(), "ut-adapter-percent-args-"));
        try {
          const explicit = join(root, "codex.cmd");
          touchBinary(explicit);
          const token = args.find((arg) => arg.includes("%")) as string;
          expectPercentTokenError(
            () =>
              buildProviderInvocation({
                provider: "codex",
                command: "codex",
                args,
                opts: {
                  platform: "win32",
                  env: { SystemRoot: "C:\\Windows", UT_TDD_CODEX_BIN: explicit },
                },
              }),
            token,
          );
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    });
  });

  it("U-CMDINPUT-009: preserves normal cmd quoting and direct native/non-Windows percent arguments", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-adapter-percent-preserve-"));
    try {
      const cmdPath = join(root, "codex.cmd");
      touchBinary(cmdPath);
      const cmdInvocation = buildProviderInvocation({
        provider: "codex",
        command: "codex",
        args: ["exec", "hello world", 'say"hi', ""],
        opts: {
          platform: "win32",
          env: { SystemRoot: "C:\\Windows", UT_TDD_CODEX_BIN: cmdPath },
        },
      });
      expect(cmdInvocation.command).toBe("C:\\Windows\\System32\\cmd.exe");
      expect(cmdInvocation.args).toEqual([
        "/d",
        "/s",
        "/c",
        `""${cmdPath}" "exec" "hello world" "say""hi" """`,
      ]);
      expect(cmdInvocation.shell).toBe(false);
      expect(cmdInvocation.windowsVerbatimArguments).toBe(true);

      const nativePath = join(root, "codex.exe");
      touchBinary(nativePath);
      expect(
        buildProviderInvocation({
          provider: "codex",
          command: "codex",
          args: ["percent%native"],
          opts: {
            platform: "win32",
            env: { SystemRoot: "C:\\Windows", UT_TDD_CODEX_BIN: nativePath },
          },
        }),
      ).toEqual({ command: nativePath, args: ["percent%native"], shell: false });

      const posixPath = join(root, "codex");
      touchBinary(posixPath);
      expect(
        buildProviderInvocation({
          provider: "codex",
          command: "codex",
          args: ["percent%posix"],
          opts: { platform: "linux", env: { UT_TDD_CODEX_BIN: posixPath } },
        }),
      ).toEqual({ command: posixPath, args: ["percent%posix"], shell: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-CMDINPUT-010: builder rejection makes the version probe false without invoking runProbe", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-adapter-percent-probe-"));
    try {
      const explicit = join(root, "percent%codex.cmd");
      touchBinary(explicit);
      let runProbeCalls = 0;
      let thrown: unknown;
      let result: boolean | undefined;
      try {
        result = isProviderCommandSpawnable("codex", {
          platform: "win32",
          env: { SystemRoot: "C:\\Windows", UT_TDD_CODEX_BIN: explicit },
          runProbe: () => {
            runProbeCalls += 1;
            return { status: 0 };
          },
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeUndefined();
      expect(result).toBe(false);
      expect(runProbeCalls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-CMDINPUT-011: keeps percent-bearing task text on stdin outside cmd tokens", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-adapter-percent-stdin-"));
    try {
      const explicit = join(root, "codex.cmd");
      touchBinary(explicit);
      const task = "inspect literal %PATH% and 100% without expanding it";
      const plan = buildAdapterPlan(
        { provider: "codex", role: "qa", task, model: "gpt-5.4", effort: "medium" },
        "hybrid",
      );
      expect(plan.available).toBe(true);
      expect(plan.messages).not.toContain("provider_model_invalid");
      expect(plan.messages).not.toContain("provider_effort_invalid");
      expect(plan.messages).not.toContain("provider_cmd_token_percent_forbidden");
      expect(plan.stdin).toBe(task);
      expect(plan.args).not.toContain(task);
      const invocation = buildProviderInvocation({
        provider: "codex",
        command: "codex",
        args: plan.args,
        opts: {
          platform: "win32",
          env: { SystemRoot: "C:\\Windows", UT_TDD_CODEX_BIN: explicit },
        },
      });
      expect(invocation.command).toBe("C:\\Windows\\System32\\cmd.exe");
      expect(invocation.args.join(" ")).not.toContain("%PATH%");
      expect(invocation.args.join(" ")).not.toContain("100%");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
