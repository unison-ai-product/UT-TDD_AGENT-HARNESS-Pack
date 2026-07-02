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
} from "../src/runtime/adapter";
import {
  ADAPTER_CONTEXT_HEADER,
  CLAUDE_EFFORT_ENV,
  CLAUDE_STDIN_ARGS,
  CODEX_MODEL_FLAG,
  CODEX_STDIN_ARGS,
  mapAdapterErrorPolicy,
  REQUIRED_SKILL_LABEL,
} from "../src/runtime/adapter-policy";

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

  it("normalizes extended UT-TDD effort values at the Claude provider boundary", () => {
    expect(normalizeProviderEffort("claude", "middle")).toBe("medium");
    expect(normalizeProviderEffort("claude", "xhigh")).toBe("high");
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
    expect(plan.args).toContain("high");
    expect(plan.args).not.toContain("xhigh");
    expect(plan.effort).toBe("high");
    expect(plan.env).toEqual({ [CLAUDE_EFFORT_ENV]: "high" });
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
      const ok = isProviderCommandSpawnable("codex", {
        env: { UT_TDD_CODEX_BIN: explicit },
        platform: process.platform,
        runProbe: (command, args) => {
          seen.push(`${command} ${args.join(" ")}`);
          return { status: 0 };
        },
      });

      expect(ok).toBe(true);
      expect(seen[0]).toContain("--version");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
