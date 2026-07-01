import { describe, expect, it } from "vitest";
import {
  analyzeRuleDrift,
  loadRuleAdapterDocs,
  type RuleAdapterDocs,
  ruleDriftMessages,
} from "../src/lint/rule-drift";

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
