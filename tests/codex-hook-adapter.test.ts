import { describe, expect, it } from "vitest";
import {
  analyzeCodexHookAdapter,
  CODEX_DEFERRED_SURFACE,
  CODEX_NOT_APPLICABLE,
  CODEX_REQUIRED,
  codexHookAdapterMessages,
  loadCodexHookAdapterInput,
} from "../src/lint/codex-hook-adapter";
import {
  CODEX_DEFERRED_SURFACE as CODEX_DEFERRED_SURFACE_POLICY,
  CODEX_NOT_APPLICABLE as CODEX_NOT_APPLICABLE_POLICY,
  CODEX_REQUIRED as CODEX_REQUIRED_POLICY,
} from "../src/lint/codex-hook-adapter-policy";
import { REQUIRED as CLAUDE_REQUIRED } from "../src/lint/project-hook";
import { analyzeReadability } from "../src/lint/readability";
import { evaluateAgentGuard } from "../src/runtime/agent-guard";
import { evaluateWorkGuard } from "../src/runtime/work-guard";
import { BUILTIN_GITHUB_TEMPLATES } from "../src/setup/templates";

/** .codex/hooks.json と同型の有効な Codex adapter fixture (mutate して fail-close を検証)。 */
function validCodexHooks(): Record<string, unknown> {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "apply_patch|write_file",
          hooks: [
            { type: "command", command: "bun .claude/hooks/work-guard.ts", blockOnFailure: true },
          ],
        },
        {
          matcher: "spawn_agent|spawn_agents_on_csv",
          hooks: [
            { type: "command", command: "bun .claude/hooks/agent-guard.ts", blockOnFailure: true },
          ],
        },
      ],
      SessionStart: [{ hooks: [{ type: "command", command: "bun src/cli.ts session start" }] }],
      PostToolUse: [
        {
          matcher: "apply_patch|write_file|exec_command|local_shell",
          hooks: [{ type: "command", command: "bun src/cli.ts hook post-tool-use" }],
        },
      ],
      Stop: [{ hooks: [{ type: "command", command: "bun src/cli.ts session summary" }] }],
    },
  };
}

const json = (o: unknown): string => JSON.stringify(o);

const assertExternalizedCodexRequiredPolicy = (): void => {
  expect(CODEX_REQUIRED_POLICY.map((hook) => hook.id)).toContain("work-guard");
  expect(CODEX_REQUIRED_POLICY).toEqual(CODEX_REQUIRED);
};

describe("codex-hook-adapter — Codex hooks.json parity (PLAN-L7-139)", () => {
  it("U-CXHOOK-001: 実 repo の .codex/hooks.json は Claude ガードと parity (real-repo 回帰ガード)", () => {
    const r = analyzeCodexHookAdapter(loadCodexHookAdapterInput(process.cwd()));
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
    expect(r.apiToolPathEnforced).toBe(false);
    expect(codexHookAdapterMessages(r)[0]).toContain(".codex/hooks.json shares");
    expect(codexHookAdapterMessages(r).join("\n")).toContain(
      "hosted API/developer apply_patch tools do not execute through the Codex hook engine",
    );
  });

  it("U-CXHOOK-002: 有効な adapter fixture は ok", () => {
    assertExternalizedCodexRequiredPolicy();
    expect(analyzeCodexHookAdapter({ codexHooksJson: json(validCodexHooks()) }).ok).toBe(true);
  });

  // PLAN-RECOVERY-06 (A-172 C-2): setup が consumer へ生成する .codex/hooks.json (wrapper 配線)
  // が codex-hook-adapter gate を通ることを実テンプレートで固定する (単一定義源の回帰フェンス)。
  it("U-CXHOOK-002c: setup 生成 consumer hooks.json (wrapper 配線) は ok", () => {
    const generated = BUILTIN_GITHUB_TEMPLATES["adapter/.codex/hooks.json"];
    expect(generated).toBeDefined();

    const r = analyzeCodexHookAdapter({ codexHooksJson: generated });
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("U-CXHOOK-002d: Claude/Codex の wrapper 配線は定義上同一 (entrypoint 分岐防止)", () => {
    const claudeWrapperById = new Map(
      CLAUDE_REQUIRED.map((hook) => [hook.id, hook.wrapperCommand]),
    );
    for (const required of CODEX_REQUIRED) {
      expect(required.wrapperCommand).toBe(claudeWrapperById.get(required.id));
    }
  });

  it("U-CXHOOK-002b: policy prose is mojibake-free", () => {
    const policyText = [
      ...CODEX_NOT_APPLICABLE_POLICY.map((item) => item.reason),
      ...CODEX_DEFERRED_SURFACE_POLICY.map((item) => item.reason),
    ].join("\n");
    expect(
      analyzeReadability([{ path: "src/lint/codex-hook-adapter-policy.ts", text: policyText }])
        .violations,
    ).toEqual([]);
  });

  it("U-CXHOOK-003: hooks.json 不在は fail-close (missing_hooks_json)", () => {
    const r = analyzeCodexHookAdapter({ codexHooksJson: null });
    expect(r.ok).toBe(false);
    expect(r.violations[0].reason).toBe("missing_hooks_json");
  });

  it("U-CXHOOK-004: 壊れた JSON は fail-close (malformed_json)", () => {
    const r = analyzeCodexHookAdapter({ codexHooksJson: "{ not json" });
    expect(r.ok).toBe(false);
    expect(r.violations[0].reason).toBe("malformed_json");
  });

  it("U-CXHOOK-005: work-guard ガードを欠くと fail-close (missing_hook)", () => {
    const broken = validCodexHooks() as { hooks: Record<string, unknown> };
    broken.hooks.PreToolUse = [];
    const r = analyzeCodexHookAdapter({ codexHooksJson: json(broken) });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.hook === "work-guard" && v.reason === "missing_hook")).toBe(
      true,
    );
  });

  it("U-CXHOOK-006: Codex の編集 matcher が Claude 字面のままだと発火しない = fail-close", () => {
    const broken = validCodexHooks() as { hooks: { PreToolUse: { matcher: string }[] } };
    // 字面コピー (Edit|Write|MultiEdit) は Codex tool 名と一致せず発火しない偽パリティ。
    broken.hooks.PreToolUse[0].matcher = "Edit|Write|MultiEdit";
    const r = analyzeCodexHookAdapter({ codexHooksJson: json(broken) });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.hook === "work-guard" && v.reason === "missing_hook")).toBe(
      true,
    );
  });

  it("U-CXHOOK-007: work-guard の blockOnFailure 欠落は fail-close", () => {
    const broken = validCodexHooks() as {
      hooks: { PreToolUse: { hooks: { blockOnFailure?: boolean }[] }[] };
    };
    broken.hooks.PreToolUse[0].hooks[0].blockOnFailure = undefined;
    const r = analyzeCodexHookAdapter({ codexHooksJson: json(broken) });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.reason === "missing_block_on_failure")).toBe(true);
  });

  it("U-CXHOOK-008: Codex command が $CLAUDE_PROJECT_DIR 依存だと fail-close (repo-relative 原則)", () => {
    const broken = validCodexHooks() as {
      hooks: { PreToolUse: { hooks: { command: string }[] }[] };
    };
    broken.hooks.PreToolUse[0].hooks[0].command =
      'bun "$CLAUDE_PROJECT_DIR/.claude/hooks/work-guard.ts"';
    const r = analyzeCodexHookAdapter({ codexHooksJson: json(broken) });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.reason === "claude_project_dir_in_codex")).toBe(true);
  });

  it("U-CXHOOK-009: global ~/.codex/ 参照は fail-close (no global writes)", () => {
    const broken = validCodexHooks() as {
      hooks: { SessionStart: { hooks: { command: string }[] }[] };
    };
    broken.hooks.SessionStart[0].hooks[0].command = "bun ~/.codex/hooks/start.ts";
    const r = analyzeCodexHookAdapter({ codexHooksJson: json(broken) });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.reason === "global_codex_path")).toBe(true);
  });

  it("U-CXHOOK-010: Codex の各 entrypoint は Claude REQUIRED にも存在する (双方向、no silent fork)", () => {
    const claudeEntrypoints = new Set(CLAUDE_REQUIRED.map((r) => r.commandParts.join(" ")));
    for (const guard of CODEX_REQUIRED) {
      expect(claudeEntrypoints.has(guard.commandParts.join(" "))).toBe(true);
    }
  });

  it("U-CXHOOK-011: subagent-stop stays N/A while Codex spawn_agent is guarded", () => {
    const naEntrypoints = CODEX_NOT_APPLICABLE.map((n) => n.entrypoint);
    expect(naEntrypoints).toContain("src/cli.ts hook subagent-stop");
    for (const n of CODEX_NOT_APPLICABLE) expect(n.reason.length).toBeGreaterThan(0);
    expect(CODEX_DEFERRED_SURFACE).toEqual([]);
    expect(CODEX_REQUIRED.find((hook) => hook.id === "agent-guard")).toMatchObject({
      event: "PreToolUse",
      matcher: "spawn_agent|spawn_agents_on_csv",
      blockOnFailure: true,
    });
    expect(analyzeCodexHookAdapter({ codexHooksJson: json(validCodexHooks()) }).ok).toBe(true);
  });

  it("U-CXHOOK-012: 共有 guard ロジックは runtime 非依存 — Codex 発火時も同じ判定になる", () => {
    // work-guard: foreign uncommitted file は block (Codex の apply_patch|write_file 経由でも同一純関数)。
    expect(
      evaluateWorkGuard({
        targetPath: "src/plan/lint.ts",
        uncommittedFiles: ["src/plan/lint.ts"],
        sessionTouchedFiles: [],
        bypass: false,
      }).decision,
    ).toBe("block");
    // agent-guard allowlist ロジックは共有。Codex は spawn_agent 面を実際に持つので、agent-guard 相当を
    // 配線すれば同 entrypoint・同判定になる (配線自体は deferred follow-up)。
    expect(
      evaluateAgentGuard(
        { tool_name: "Agent", tool_input: { subagent_type: "be-logic", model: "sonnet" } },
        { allowRaw: false, resolveAgentFamily: () => "missing" },
      ).code,
    ).toBe(2);
  });

  it("U-CXHOOK-013: 非 command type の hook では guard 充足とみなさない (type==='command' 必須)", () => {
    const broken = validCodexHooks() as {
      hooks: { PreToolUse: { hooks: { type: string }[] }[] };
    };
    broken.hooks.PreToolUse[0].hooks[0].type = "notification";
    const r = analyzeCodexHookAdapter({ codexHooksJson: json(broken) });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.hook === "work-guard" && v.reason === "missing_hook")).toBe(
      true,
    );
  });

  it("U-CXHOOK-014: script path が別 token の部分文字列に紛れるだけでは guard 充足にしない (token 厳格化)", () => {
    const broken = validCodexHooks() as {
      hooks: { Stop: { hooks: { command: string }[] }[] };
    };
    // 'src/cli.tsx' は 'src/cli.ts' を部分文字列に含むが別ファイル。token 完全一致なら弾ける。
    broken.hooks.Stop[0].hooks[0].command = "bun src/cli.tsx session summary";
    const r = analyzeCodexHookAdapter({ codexHooksJson: json(broken) });
    expect(r.ok).toBe(false);
    expect(
      r.violations.some((v) => v.hook === "session-summary" && v.reason === "missing_hook"),
    ).toBe(true);
  });
});
