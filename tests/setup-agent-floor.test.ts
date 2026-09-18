/**
 * PLAN-L7-425: setup が emit する quality-check / gate reviewer の model floor 整合。
 *
 * PLAN-L7-399 (agent-guard quality-check tier floor) は code-reviewer / qa-test /
 * security-audit / ut-tdd-tl に opus floor を要求する。ソース repo の
 * `.claude/agents/*.md` は opus floor だが、配布テンプレ (builtin + disk) が Sonnet の
 * まま drift した実績 (2026-07-10 設定監査 I-1) があるため、self と配布物のポリシー
 * 一致をここで固定する。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadTemplates } from "../src/setup/index.ts";
import { BUILTIN_GITHUB_TEMPLATES } from "../src/setup/templates.ts";
import { MODEL_IDS } from "../src/team/model-policy.ts";

const GATE_REVIEWERS = ["code-reviewer", "qa-test", "security-audit", "ut-tdd-tl"] as const;
const OPUS = MODEL_IDS.claude.opus;

function modelOf(content: string): string | null {
  const m = content.match(/^model:\s*(\S+)\s*$/m);
  return m ? m[1] : null;
}

describe("U-SETUPFLOOR-001: gate reviewer templates declare opus floor", () => {
  it("builtin agent templates use opus for all gate reviewers", () => {
    for (const name of GATE_REVIEWERS) {
      const content = BUILTIN_GITHUB_TEMPLATES[`adapter/.claude/agents/${name}.md`];
      expect(content, `builtin template missing: ${name}`).toBeTruthy();
      expect(modelOf(content as string), `builtin ${name} model floor`).toBe(OPUS);
    }
  });

  it("disk adapter templates (docs/templates) use opus for all gate reviewers", () => {
    const templates = loadTemplates(process.cwd());
    for (const name of GATE_REVIEWERS) {
      const content = templates[`adapter/.claude/agents/${name}.md`];
      expect(content, `disk template missing: ${name}`).toBeTruthy();
      expect(modelOf(content as string), `disk ${name} model floor`).toBe(OPUS);
    }
  });

  it("source repo .claude/agents and templates agree on the gate floor", () => {
    for (const name of GATE_REVIEWERS) {
      const source = readFileSync(join(process.cwd(), ".claude", "agents", `${name}.md`), "utf8");
      expect(modelOf(source), `source .claude/agents/${name}.md model floor`).toBe(OPUS);
    }
  });
});

describe("U-SETUPFLOOR-002: setup emits UTF-8/LF normalization pair", () => {
  it("builtin templates contain .editorconfig and .gitattributes with LF/UTF-8 markers", () => {
    const editorconfig = BUILTIN_GITHUB_TEMPLATES["common/.editorconfig"];
    const gitattributes = BUILTIN_GITHUB_TEMPLATES["common/.gitattributes"];
    expect(editorconfig).toContain("charset = utf-8");
    expect(editorconfig).toContain("end_of_line = lf");
    expect(gitattributes).toContain("* text=auto eol=lf");
  });
});
