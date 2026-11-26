/**
 * issue #1604 Red tests。Workflow の agent のモデルを Haiku と Sonnet に限る guard の候補 oracle。
 * 契約: docs/design/harness/L6-function-design/workflow-model-guard.md
 * test-design: docs/test-design/harness/L7-workflow-model-guard-test-design.md
 *
 * 実装が無いので全件 `it.fails`。判定本体と hook は動的に読み、各テストが個別に失敗する。
 * 実装 PR で正式 ID へ昇格したうえで `it.fails` を `it` に戻して Green にする。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  analyzeHookParity,
  analyzeRuleDrift,
  loadClaudeHookSettings,
  loadRuleAdapterDocs,
} from "../src/lint/rule-drift.ts";
import { describe, expect, it } from "./support/hook-bounds.ts";

const root = process.cwd();

interface Decision {
  code: number;
  message?: string;
  reason?: string;
}
interface Scan {
  unreadable: boolean;
  aliased: boolean;
  nested: boolean;
  agentCalls: Array<{
    opts: string;
    agentTypeUsed: boolean;
    model: { kind: string; value?: string };
  }>;
  metaModels: Array<{ kind: string; value?: string }>;
}
interface GuardModule {
  evaluateWorkflowGuard(input: unknown): Decision;
  scanWorkflowScript(source: string): Scan;
}

async function mod(): Promise<GuardModule> {
  const target = pathToFileURL(join(root, "src", "runtime", "workflow-guard.ts")).href;
  return (await import(/* @vite-ignore */ target)) as GuardModule;
}

async function decide(script: string): Promise<Decision> {
  const m = await mod();
  return m.evaluateWorkflowGuard({ tool_name: "Workflow", tool_input: { script } });
}

async function decideInput(toolInput: Record<string, unknown>): Promise<Decision> {
  const m = await mod();
  return m.evaluateWorkflowGuard({ tool_name: "Workflow", tool_input: toolInput });
}

const meta = 'export const meta = { name: "t", phases: [] };\n';
const withMeta = (body: string, phaseModel?: string): string =>
  phaseModel === undefined
    ? `${meta}${body}`
    : `export const meta = { name: "t", phases: [{ title: "p", model: ${phaseModel} }] };\n${body}`;

const HOOK = join(root, ".claude", "hooks", "workflow-guard.ts");

function runHook(
  stdin: string,
  env: Record<string, string> = {},
  cwd: string = root,
): { status: number | null; stderr: string } {
  const base: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(base)) {
    if (key.startsWith("UT_TDD_ALLOW_") || key === "CLAUDE_CODE_SUBAGENT_MODEL") delete base[key];
  }
  const r = spawnSync(process.execPath, [HOOK], {
    input: stdin,
    encoding: "utf8",
    cwd,
    env: { ...base, CLAUDE_PROJECT_DIR: cwd, ...env },
    windowsHide: true,
  });
  return { status: r.status, stderr: r.stderr ?? "" };
}

const envelope = (script: string): string =>
  JSON.stringify({ tool_name: "Workflow", tool_input: { script } });

function src(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

describe("workflow-model-guard 候補 oracle (Red)", () => {
  // 3.1 通す例
  it.fails("CANDIDATE-U-WFGUARD-001: model を明示した haiku は環境変数に依存せず通す", async () => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL;
    expect((await decide(withMeta('agent("p", { model: "haiku" })'))).code).toBe(0);
  });

  it.fails("CANDIDATE-U-WFGUARD-002: sonnet の明示は通す", async () => {
    expect((await decide(withMeta('agent("p", { model: "sonnet" })'))).code).toBe(0);
  });

  it.fails("CANDIDATE-U-WFGUARD-004: meta.phases[].model が許可値なら通す", async () => {
    const s = withMeta('agent("p", { model: "sonnet" })', '"haiku"');
    expect((await decide(s)).code).toBe(0);
  });

  it.fails("CANDIDATE-U-WFGUARD-005: 全名と前後空白・大文字は normalizeModelFamily に従って通す", async () => {
    for (const v of ['"claude-haiku-5-5"', '"claude-sonnet-5-5"', '" Haiku "']) {
      expect((await decide(withMeta(`agent("p", { model: ${v} })`))).code, v).toBe(0);
    }
  });

  it.fails("CANDIDATE-U-WFGUARD-006: Workflow 以外の tool_name は tool_input を見ずに通す", async () => {
    const m = await mod();
    expect(
      m.evaluateWorkflowGuard({ tool_name: "Bash", tool_input: { command: "echo ok" } }).code,
    ).toBe(0);
    expect(m.evaluateWorkflowGuard({ tool_name: 1 }).code).toBe(2);
  });

  it.fails("CANDIDATE-U-WFGUARD-007: 通る呼び出しは exit 0 で stderr が空", () => {
    const r = runHook(envelope(withMeta('agent("p", { model: "haiku" })')));
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  // 3.2 拒否する例
  it.fails("CANDIDATE-U-WFGUARD-008: haiku / sonnet 以外の model は workflow_model_not_allowed", async () => {
    const cases = [
      '{ model: "opus" }',
      '{ model: "fable" }',
      '{ model: "claude-opus-5-5" }',
      '{ model: "claude-fable-5-1" }',
      '{ "model": "opus" }',
      "{ 'model': \"opus\" }",
    ];
    for (const c of cases) {
      const d = await decide(withMeta(`agent("p", ${c})`));
      expect(d.code, c).toBe(2);
      expect(d.reason, c).toBe("workflow_model_not_allowed");
    }
  });

  it.fails("CANDIDATE-U-WFGUARD-009: meta.phases[].model の opus は workflow_model_not_allowed", async () => {
    const d = await decide(withMeta('agent("p", { model: "haiku" })', '"opus"'));
    expect(d.code).toBe(2);
    expect(d.reason).toBe("workflow_model_not_allowed");
  });

  it.fails("CANDIDATE-U-WFGUARD-010: 変数・shorthand・式・三項は workflow_model_not_literal", async () => {
    const scripts = [
      'const m = "opus"; agent("p", { model: m })',
      'agent("p", { model })',
      'agent("p", { model: pick() })',
      'agent("p", { model: "ha" + "iku" })',
      'agent("p", { model: cond ? "haiku" : "sonnet" })',
    ];
    for (const s of scripts) {
      const d = await decide(withMeta(s));
      expect(d.code, s).toBe(2);
      expect(d.reason, s).toBe("workflow_model_not_literal");
    }
  });

  it.fails("CANDIDATE-U-WFGUARD-011: 置換ありの template は拒否、置換なしの逆引用符は通す", async () => {
    const placeholder = ["$", "{x}"].join("");
    const bad = await decide(withMeta(`agent("p", { model: \`${placeholder}\` })`));
    expect(bad.code).toBe(2);
    expect(bad.reason).toBe("workflow_model_not_literal");
    expect((await decide(withMeta('agent("p", { model: `haiku` })'))).code).toBe(0);
  });

  it.fails("CANDIDATE-U-WFGUARD-014: name だけの呼び出しは workflow_script_unreadable", async () => {
    for (const extra of [{}, { args: {} }, { resumeFromRunId: "r" }]) {
      const d = await decideInput({ name: "saved-workflow", ...extra });
      expect(d.code).toBe(2);
      expect(d.reason).toBe("workflow_script_unreadable");
    }
  });

  it.fails("CANDIDATE-U-WFGUARD-018: workflow() の直接呼び出しは workflow_nested_not_scannable", async () => {
    for (const s of ['workflow("other", args)', 'workflow({ scriptPath: "x.js" })']) {
      const d = await decide(withMeta(s));
      expect(d.code, s).toBe(2);
      expect(d.reason, s).toBe("workflow_nested_not_scannable");
    }
  });

  it.fails("CANDIDATE-U-WFGUARD-019: 最上位の agentType は拒否、文字列の中は通す", async () => {
    const d = await decide(withMeta('agent("p", { agentType: "code-reviewer", model: "haiku" })'));
    expect(d.code).toBe(2);
    expect(d.reason).toBe("workflow_agent_type_not_allowed");
    expect(
      (await decide(withMeta('agent("p", { model: "haiku", label: "agentType" })'))).code,
    ).toBe(0);
  });

  it.fails("CANDIDATE-U-WFGUARD-020: 閉じていない文字列・template・comment・括弧は workflow_script_unreadable", async () => {
    const scripts = [
      'agent("p", { model: "haiku" })\nconst s = "abc',
      'agent("p", { model: "haiku" })\nconst t = `abc',
      'agent("p", { model: "haiku" })\n/* abc',
      'agent("p", { model: "haiku" ',
      'agent("p", { model: "haiku" }))',
    ];
    for (const s of scripts) {
      const d = await decide(s);
      expect(d.code, s).toBe(2);
      expect(d.reason, s).toBe("workflow_script_unreadable");
    }
  });

  it.fails("CANDIDATE-U-WFGUARD-030: scriptPath のみ・両方・どちらも無いは workflow_script_unreadable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wfguard-030-"));
    try {
      const file = join(dir, "ok.js");
      const script = withMeta('agent("p", { model: "haiku" })');
      writeFileSync(file, script);
      const cases: Array<Record<string, unknown>> = [
        { scriptPath: file },
        { script, scriptPath: file },
        {},
      ];
      for (const c of cases) {
        const d = await decideInput(c);
        expect(d.code, JSON.stringify(c)).toBe(2);
        expect(d.reason, JSON.stringify(c)).toBe("workflow_script_unreadable");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.fails("CANDIDATE-U-WFGUARD-031: model の省略は環境変数が許可値でも workflow_model_missing", async () => {
    for (const s of ['agent("p", { label: "x" })', 'agent("p", {})', 'agent("p")']) {
      const d = await decide(withMeta(s));
      expect(d.code, s).toBe(2);
      expect(d.reason, s).toBe("workflow_model_missing");
      const r = runHook(envelope(withMeta(s)), { CLAUDE_CODE_SUBAGENT_MODEL: "haiku" });
      expect(r.status, s).toBe(2);
      expect(r.stderr, s).toContain("workflow_model_missing");
    }
  });

  it.fails("CANDIDATE-U-WFGUARD-032: model は各呼び出し自身の第 2 引数の最上位だけを見る", async () => {
    const scripts = [
      'agent(JSON.stringify({ model: "haiku" }))',
      'agent("model: haiku", { label: "x" })',
      'agent("p", { label: f({ model: "haiku" }) })',
      'agent("p", { meta: { model: "haiku" } })',
    ];
    for (const s of scripts) {
      const d = await decide(withMeta(s));
      expect(d.code, s).toBe(2);
      expect(d.reason, s).toBe("workflow_model_missing");
    }
  });

  it.fails("CANDIDATE-U-WFGUARD-033: 別名化と間接呼び出しは workflow_identifier_aliased、比較は通す", async () => {
    const bad = [
      'const run = agent; run("p")',
      "const run = workflow;",
      "[agent]",
      "f(agent)",
      'x.agent("p", { model: "haiku" })',
      'agent?.("p", { model: "haiku" })',
    ];
    for (const s of bad) {
      const d = await decide(withMeta(s));
      expect(d.code, s).toBe(2);
      expect(d.reason, s).toBe("workflow_identifier_aliased");
    }
    const ok = '// agent を使う\nconst w = "workflow";\nagent("p", { model: "haiku" })';
    expect((await decide(withMeta(ok))).code).toBe(0);
  });

  it.fails("CANDIDATE-U-WFGUARD-034: opts の形が崩れていれば workflow_agent_opts_invalid", async () => {
    const scripts = [
      'agent("p", opts)',
      'agent("p", { ...opts })',
      'agent("p", { model: "haiku", ...opts })',
      'agent("p", { ["model"]: "haiku" })',
      'agent("p", pick())',
      'agent("p", { model: "haiku", model: "opus" })',
    ];
    for (const s of scripts) {
      const d = await decide(withMeta(s));
      expect(d.code, s).toBe(2);
      expect(d.reason, s).toBe("workflow_agent_opts_invalid");
    }
  });

  it.fails("CANDIDATE-U-WFGUARD-035: comment と文字列の中の model は数えない", async () => {
    const a = '// model: "opus"\nagent("p", { model: "haiku" })';
    const b = 'agent("run with model: opus", { model: "haiku" })';
    expect((await decide(withMeta(a))).code).toBe(0);
    expect((await decide(withMeta(b))).code).toBe(0);
  });

  it.fails("CANDIDATE-U-WFGUARD-036: scanWorkflowScript の返り値", async () => {
    const m = await mod();
    const s = withMeta(
      'agent("a", { model: "haiku" })\nagent("b", { model: "sonnet" })\nagent("c")',
      '"haiku"',
    );
    const r = m.scanWorkflowScript(s);
    expect(r.agentCalls).toHaveLength(3);
    expect(r.agentCalls.map((c) => c.model.kind)).toEqual(["literal", "literal", "absent"]);
    expect(r.metaModels).toHaveLength(1);
    expect(r.aliased).toBe(false);
    expect(r.nested).toBe(false);
  });

  // 3.3 入力の検証と bypass の不在
  it.fails("CANDIDATE-U-WFGUARD-023: 空・壊れた JSON・tool_name 無し・文字列でない tool_name は exit 2", () => {
    for (const stdin of ["", "{not json", "{}", '{"tool_name": 1}']) {
      const r = runHook(stdin);
      expect(r.status, stdin).toBe(2);
      expect(r.stderr, stdin).toContain("workflow_guard_input_invalid");
    }
  });

  it.fails("CANDIDATE-U-WFGUARD-024: bypass の環境変数と marker があっても opus は exit 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "wfguard-024-"));
    try {
      mkdirSync(join(dir, ".ut-tdd", "state"), { recursive: true });
      writeFileSync(join(dir, ".ut-tdd", "state", "foreign-edit-override"), "reason");
      const stdin = envelope(withMeta('agent("p", { model: "opus" })'));
      const envs: Array<Record<string, string>> = [
        { UT_TDD_ALLOW_RAW_AGENT: "1" },
        { UT_TDD_ALLOW_FOREIGN_EDIT: "1" },
        {},
      ];
      for (const env of envs) {
        const r = runHook(stdin, env, dir);
        expect(r.status, JSON.stringify(env)).toBe(2);
        expect(r.stderr).toContain("workflow_model_not_allowed");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.fails("CANDIDATE-U-WFGUARD-025: 拒否の stderr は 1 行で reason と直し方 (L6 §7) を含む", () => {
    const hasFixes = (out: string, fixes: RegExp[]): boolean => fixes.every((f) => f.test(out));
    const allowedFix = [/haiku か sonnet/, /Agent tool/, /委譲経路/];
    const unreadableFix = [/script を直接渡す/];
    // 反例 (直し方が空・片方だけ) を、この検査自身が拒否できること。
    expect(hasFixes("[ut-tdd-guard] BLOCK: workflow_script_unreadable:", unreadableFix)).toBe(
      false,
    );
    expect(
      hasFixes("BLOCK: workflow_model_not_allowed: haiku か sonnet。Agent tool", allowedFix),
    ).toBe(false);
    expect(
      hasFixes("BLOCK: workflow_model_not_allowed: haiku か sonnet。委譲経路", allowedFix),
    ).toBe(false);
    const rows: Array<[string, string, RegExp[]]> = [
      [withMeta('agent("p", { model: "opus" })'), "workflow_model_not_allowed", allowedFix],
      [
        withMeta('agent("p", { model })'),
        "workflow_model_not_literal",
        [/文字列 literal で直接書く/],
      ],
      [
        withMeta('agent("p")'),
        "workflow_model_missing",
        [/全ての agent\(\) の第 2 引数に model を/, /明示する/],
      ],
      [withMeta('agent("p", opts)'), "workflow_agent_opts_invalid", [/object literal で直接書き/]],
      [withMeta("const r = agent;"), "workflow_identifier_aliased", [/直接呼び/]],
    ];
    const check = (stdin: string, reason: string, fixes: RegExp[]): void => {
      const out = runHook(stdin).stderr.trimEnd();
      expect(out.split(/\r?\n/), reason).toHaveLength(1);
      expect(out.startsWith(`[ut-tdd-guard] BLOCK: ${reason}:`), reason).toBe(true);
      expect(hasFixes(out, fixes), `${reason}: ${out}`).toBe(true);
    };
    for (const [script, reason, fixes] of rows) check(envelope(script), reason, fixes);
    const byInput = [
      JSON.stringify({ tool_name: "Workflow", tool_input: { name: "x" } }),
      JSON.stringify({ tool_name: "Workflow", tool_input: { scriptPath: "x.js" } }),
    ];
    for (const stdin of byInput) check(stdin, "workflow_script_unreadable", unreadableFix);
  });

  it.fails("CANDIDATE-U-WFGUARD-026: 判定本体と hook は bypass も実行も持たず normalizeModelFamily を共有する", () => {
    const core = src("src/runtime/workflow-guard.ts");
    const hook = src(".claude/hooks/workflow-guard.ts");
    for (const text of [core, hook]) {
      expect(text).not.toContain("evaluateAgentGuard");
      expect(text).not.toMatch(/UT_TDD_ALLOW_/);
      expect(text).not.toMatch(/\beval\s*\(|Function\s*\(|node:vm|\bvm\./);
      if (/child_process/.test(text)) expect(text).toMatch(/windowsHide:\s*true/);
    }
    const firstImport = hook.match(/^import\s+[^;]*;/m)?.[0] ?? "";
    expect(firstImport).toContain("windows-hide.ts");
    expect(core).toContain("normalizeModelFamily");
    expect(core).not.toMatch(/["']haiku["']\s*,\s*["']sonnet["']\s*\]/);
  });

  // 3.4 hook 一覧との照合
  it.fails("CANDIDATE-U-WFGUARD-027: settings.json の PreToolUse に Workflow の entry がある", () => {
    const settings = JSON.parse(src(".claude/settings.json")) as {
      env?: Record<string, string>;
      availableModels?: unknown;
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<Record<string, unknown>> }> };
    };
    const entry = settings.hooks.PreToolUse.find((e) => e.matcher === "Workflow");
    expect(entry).toBeDefined();
    const h = entry?.hooks[0] ?? {};
    expect(h.command).toBe("node");
    expect(h.args).toEqual(["$" + "{CLAUDE_PROJECT_DIR}/.claude/hooks/workflow-guard.ts"]);
    expect(h.onFailure).toBe("block");
    expect(settings.env?.CLAUDE_CODE_SUBAGENT_MODEL_FORCE).toBeUndefined();
    expect(settings.availableModels).toBeUndefined();
  });

  it.fails("CANDIDATE-U-WFGUARD-028: §Hooks の PreToolUse(Workflow) 行と settings が照合される", () => {
    const docs = loadRuleAdapterDocs(root);
    const settingsJson = loadClaudeHookSettings(root);
    expect(docs.claudeRuntime).toMatch(/^- `PreToolUse\(Workflow\)`/m);
    const real = analyzeHookParity({ claudeRuntimeDoc: docs.claudeRuntime, settingsJson });
    expect(real.documentedOnly).toEqual([]);
    expect(real.configuredOnly).toEqual([]);
    expect(real.ok).toBe(true);

    const docDropped = analyzeHookParity({
      claudeRuntimeDoc: docs.claudeRuntime.replace(/^- `PreToolUse\(Workflow\)`.*$/m, ""),
      settingsJson,
    });
    expect(docDropped.ok).toBe(false);

    const parsed = JSON.parse(settingsJson) as {
      hooks: { PreToolUse: Array<{ matcher: string }> };
    };
    parsed.hooks.PreToolUse = parsed.hooks.PreToolUse.filter((e) => e.matcher !== "Workflow");
    const settingsDropped = analyzeHookParity({
      claudeRuntimeDoc: docs.claudeRuntime,
      settingsJson: JSON.stringify(parsed),
    });
    expect(settingsDropped.ok).toBe(false);
  });

  it.fails("CANDIDATE-U-WFGUARD-029: モデルの規律の文は L6 §11.4 の文言そのままで .claude/CLAUDE.md の 1 か所だけにある", () => {
    // L6 §11.4 が定める規律の文 (契約の文言そのもの)。部分一致の述語は使わない。
    const contract =
      "workflow の agent は全て model を明示し、Haiku が既定で、条件が複雑な段だけ Sonnet。上位モデルの検証は Agent tool か委譲経路で行う";
    const norm = (t: string): string => t.replace(/\s+/g, "");
    // 契約文の直後は句点か行末に限る (「…で行うことは禁止する」のような続きを許さない)。
    const count = (text: string): number =>
      text
        .split(/\r?\n/)
        .map(norm)
        .reduce((n, line) => {
          let hits = 0;
          for (
            let i = line.indexOf(norm(contract));
            i !== -1;
            i = line.indexOf(norm(contract), i + 1)
          ) {
            const next = line[i + norm(contract).length];
            if (next === undefined || next === "。") hits += 1;
          }
          return n + hits;
        }, 0);
    // 反例 (否定形への置換・逆の文) を、この検査自身が拒否できること。契約文そのものは通ること。
    const mutants = [
      contract.replace("Haiku が既定で", "Haiku が既定ではなく"),
      contract.replace("条件が複雑な段だけ Sonnet", "条件が複雑な段だけ Sonnet に限る必要はない"),
      contract.replace("で行う", "で行うことは禁止する"),
      "Workflow の model は明示しなくてよい。Haiku より Sonnet を常に使う。Agent tool と委譲経路。",
    ];
    for (const m of mutants) expect(count(m), m).toBe(0);
    expect(count(contract)).toBe(1);
    const claude = src(".claude/CLAUDE.md");
    expect(count(claude)).toBe(1);
    expect(count(src("CLAUDE.md"))).toBe(0);
    expect(count(src("AGENTS.md"))).toBe(0);
    expect(claude).toContain("## UT-TDD Adapter Rule Markers");
    expect(analyzeRuleDrift(loadRuleAdapterDocs(root)).ok).toBe(true);
  });
});
