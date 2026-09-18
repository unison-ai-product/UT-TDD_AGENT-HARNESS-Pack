import { describe, expect, it } from "vitest";
import {
  analyzeHookParity,
  analyzeRuleDrift,
  hookParityMessages,
  loadClaudeHookSettings,
  loadRuleAdapterDocs,
  type RuleAdapterDocs,
  ruleDriftMessages,
} from "../src/lint/rule-drift.ts";

const markers = [
  "ut-tdd status",
  "ut-tdd doctor",
  "ut-tdd handover",
  "ut-tdd codex --role <role> --task",
  "ut-tdd claude --role <role> --task",
  "ut-tdd team run --definition .ut-tdd/teams/<team>.yaml",
  "standalone",
  "claude-only",
  "codex-only",
  "hybrid",
  "route_signal",
  "generates",
].join("\n");

const completeDocs = (): RuleAdapterDocs => ({
  agents: `${markers}\nCLAUDE.md\n.claude/CLAUDE.md`,
  claudeProject: `${markers}\n.claude/CLAUDE.md\nAGENTS.md`,
  claudeRuntime: `${markers}\n../CLAUDE.md\n../AGENTS.md`,
});
const legacyRuntimeName = ["he", "lix"].join("");
const legacyRuntimeEnvPrefix = legacyRuntimeName.toUpperCase();

describe("rule-drift lint", () => {
  it("passes when Codex and Claude adapter docs share required command/mode markers", () => {
    const result = analyzeRuleDrift(completeDocs());
    expect(result.ok).toBe(true);
    expect(result.forbiddenMarkers).toEqual([]);
    expect(result.missingMarkers).toEqual([]);
  });

  it("reports missing adapter markers", () => {
    const docs = completeDocs();
    docs.agents = docs.agents.replace("ut-tdd doctor", "");
    const result = analyzeRuleDrift(docs);
    expect(result.ok).toBe(false);
    expect(result.forbiddenMarkers).toEqual([]);
    expect(result.missingMarkers).toEqual([{ file: "AGENTS.md", marker: "ut-tdd doctor" }]);
    expect(ruleDriftMessages(result)[0]).toContain("rule-drift");
  });

  // 2026-07-28: PLAN filing discipline (route certificate / draft generates) lived only
  // in .claude/CLAUDE.md, so the Codex adapter never received it and produced PLANs that
  // tripped the governance gates. An adapter dropping these terms must fail closed.
  it("reports a PLAN filing rule dropped from one adapter", () => {
    for (const marker of ["route_signal", "generates"]) {
      const docs = completeDocs();
      docs.agents = docs.agents.replace(marker, "");
      const result = analyzeRuleDrift(docs);
      expect(result.ok, `dropping ${marker} from AGENTS.md must fail closed`).toBe(false);
      expect(result.missingMarkers).toEqual([{ file: "AGENTS.md", marker }]);
    }
  });

  it("U-RDRIFT-004: reports forbidden legacy runtime markers from adapter docs", () => {
    const docs = completeDocs();
    docs.agents += `\nRun ${legacyRuntimeName} codex`;
    docs.claudeProject += `\n${legacyRuntimeEnvPrefix}_CODEX_BIN`;
    docs.claudeRuntime += `\nRead .${legacyRuntimeName}/state`;

    const result = analyzeRuleDrift(docs);

    expect(result.ok).toBe(false);
    expect(result.missingMarkers).toEqual([]);
    expect(result.forbiddenMarkers).toEqual([
      { file: "AGENTS.md", marker: "legacy runtime command routing" },
      { file: "CLAUDE.md", marker: "legacy runtime env prefix" },
      { file: ".claude/CLAUDE.md", marker: "legacy runtime local state path" },
    ]);
    expect(ruleDriftMessages(result)[0]).toContain("forbidden adapter legacy marker");
  });

  it("U-RDRIFT-005: reports Bun execution forms instructed by adapter docs", () => {
    // #134 で Bun は permanent ban。それでも adapter doc が実行形を指示し続け、指示どおりの
    // 実行が廃止ランタイム固有の失敗を生んで存在しない欠陥の起票 (#321) に至った (2026-08-14)。
    const docs = completeDocs();
    docs.agents += '\nRun `bun -e "console.log(1)"` for the spot-check';
    docs.claudeProject +=
      '\n- `SessionStart`: `bun "$CLAUDE_PROJECT_DIR/src/cli.ts" session start`';
    docs.claudeRuntime += "\nbun src/cli.ts doctor";

    const result = analyzeRuleDrift(docs);

    expect(result.ok).toBe(false);
    expect(result.missingMarkers).toEqual([]);
    expect(result.forbiddenMarkers).toEqual([
      { file: "AGENTS.md", marker: "bun execution form" },
      { file: "CLAUDE.md", marker: "bun execution form" },
      { file: ".claude/CLAUDE.md", marker: "bun execution form" },
    ]);
  });

  it("U-RDRIFT-006: keeps historical Bun incident prose out of the execution-form marker", () => {
    // 過去 incident の記録 (CLAUDE.md の「bun runaway ×2」) は実行指示ではない。
    // これを拾うと、事実の記録を消す方向へ圧力が掛かる。
    // 直前の文字に依存せず散文が素通りすることを見る。旧版は「、bun」の読点に助けられて
    // 通っていただけで、空白区切りの散文 (`use bun runtime`) を forbidden にしていた
    // (cross-review 2026-08-14 blocking 2)。
    for (const prose of [
      "doctor 16 並行、bun runaway ×2、手書き memory PR #167",
      "doctor 16 並行 bun runaway ×2",
      "use bun runtime only for Pack acceptance fixtures",
      "Bun は legacy_migration_debt であり bunAuthority を宣言している",
      "bun runaway が 2 回起きた",
      "engines.bun は #134 の残存宣言として任意",
    ]) {
      const docs = completeDocs();
      docs.claudeProject += `\n${prose}`;
      const result = analyzeRuleDrift(docs);
      expect(result.forbiddenMarkers, `must not flag prose: ${prose}`).toEqual([]);
      expect(result.ok).toBe(true);
    }
  });

  it("U-RDRIFT-008: catches code-span / argument / .cmd / .exe / bunx execution instructions", () => {
    // 「bun + 空白 + 限定 token」だけでは bun.cmd / bun.exe / code span 形や命令 token test/install/build を取りこぼす
    // (cross-review 2026-08-14 blocking 2)。実行語として書かれた形は取りこぼさない。
    for (const line of [
      "bun.cmd src/cli.ts doctor",
      'bun.exe -e "1"',
      "`bun`",
      "`bun run test`",
      "bunx vitest run",
      "bun test",
      "bun install",
      "bun build",
      "bun src/cli.ts status",
      "bun src\\cli.ts status",
      "bun cli.ts",
      "bun index.js",
      "bun C:\\repo\\src\\cli.ts",
      "bun C:/repo/src/cli.ts",
      "BUN src/cli.ts",
      "| bun src/cli.ts status",
      'bun -e "console.log(1)"',
      "bun ./scripts/x.ts",
      `bun ${"$"}{CLAUDE_PROJECT_DIR}/src/cli.ts session start`,
    ]) {
      const docs = completeDocs();
      docs.claudeRuntime += `\n${line}`;
      const result = analyzeRuleDrift(docs);
      expect(result.forbiddenMarkers, `must flag: ${line}`).toEqual([
        { file: ".claude/CLAUDE.md", marker: "bun execution form" },
      ]);
    }
  });

  it("U-RDRIFT-009: applies the Bun execution-form detector to every instruction surface", () => {
    const docs = completeDocs();
    docs.instructionSurfaces = {
      ".claude/commands/test.md": "Run `bun run test` before review.",
      ".github/PULL_REQUEST_TEMPLATE.md": "bun src/cli.ts github pr validate --body-file <body.md>",
    };

    const result = analyzeRuleDrift(docs);

    expect(result.ok).toBe(false);
    expect(result.forbiddenMarkers).toEqual([
      { file: ".claude/commands/test.md", marker: "bun execution form" },
      { file: ".github/PULL_REQUEST_TEMPLATE.md", marker: "bun execution form" },
    ]);
  });

  it("U-RDRIFT-010: loads the real command and PR-template surfaces and keeps them Bun-free", () => {
    const docs = loadRuleAdapterDocs(process.cwd());
    const surfaces = docs.instructionSurfaces ?? {};
    expect(Object.keys(surfaces)).toEqual(
      expect.arrayContaining([
        ".claude/commands/build.md",
        ".claude/commands/code-simplify.md",
        ".claude/commands/test.md",
        ".claude/commands/ut-tdd-test.md",
        ".github/PULL_REQUEST_TEMPLATE.md",
      ]),
    );
    expect(Object.keys(surfaces).length).toBeGreaterThanOrEqual(5);
    const result = analyzeRuleDrift(docs);
    expect(result.forbiddenMarkers).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("U-RDRIFT-007: .claude/CLAUDE.md の Hooks 節は settings.json の実 command/args と一致する", () => {
    // 文字列 marker の禁止だけでは「node と書いてあるが引数や event が実体と違う」drift を
    // 拾えない。実体との等価性そのものを検査対象にする (Issue #322 AC)。
    const root = process.cwd();
    const docs = loadRuleAdapterDocs(root);
    const settingsJson = loadClaudeHookSettings(root);
    const real = analyzeHookParity({ claudeRuntimeDoc: docs.claudeRuntime, settingsJson });
    expect(real.parseError).toBeNull();
    expect(real.documentedOnly).toEqual([]);
    expect(real.configuredOnly).toEqual([]);
    expect(real.ok).toBe(true);
    expect(hookParityMessages(real)[0]).toContain("OK");

    // 片側だけの改変は fail-close する (引数の欠落 / event の取り違え / doc 行の削除)。
    const dropArg = analyzeHookParity({
      claudeRuntimeDoc: docs.claudeRuntime.replace(
        "src/cli.ts session start",
        "src/cli.ts session",
      ),
      settingsJson,
    });
    expect(dropArg.ok).toBe(false);
    expect(dropArg.documentedOnly).toHaveLength(1);
    expect(dropArg.configuredOnly).toHaveLength(1);

    const wrongEvent = analyzeHookParity({
      claudeRuntimeDoc: docs.claudeRuntime.replace("- `SubagentStop`:", "- `Stop`:"),
      settingsJson,
    });
    expect(wrongEvent.ok).toBe(false);

    const droppedLine = analyzeHookParity({
      claudeRuntimeDoc: docs.claudeRuntime.replace(
        /^- `Stop`: `node \$\{CLAUDE_PROJECT_DIR\}\/src\/cli\.ts hook claude-memory-wake`$/m,
        "",
      ),
      settingsJson,
    });
    expect(droppedLine.ok).toBe(false);
    expect(droppedLine.configuredOnly).toHaveLength(1);

    // 壊れた settings.json は判定不能を green へ丸めず fail-close する。
    const broken = analyzeHookParity({ claudeRuntimeDoc: docs.claudeRuntime, settingsJson: "{" });
    expect(broken.ok).toBe(false);
    expect(broken.parseError).not.toBeNull();
    expect(hookParityMessages(broken)[0]).toContain("parse failed");
  });

  it("guards the real repo adapter docs against rule marker drift", () => {
    const result = analyzeRuleDrift(loadRuleAdapterDocs(process.cwd()));
    expect(result.missingMarkers).toEqual([]);
    expect(result.forbiddenMarkers).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("guards the real Claude/Codex adapter docs against legacy runtime command routing", () => {
    const result = analyzeRuleDrift(loadRuleAdapterDocs(process.cwd()));
    expect(result.forbiddenMarkers).toEqual([]);
  });
});
