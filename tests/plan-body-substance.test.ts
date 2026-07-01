import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkPlanBodySubstance } from "../src/doctor/index";
import {
  analyzePlanBodySubstance,
  countSubstantiveBodyLines,
  loadPlanBodySubstanceInput,
} from "../src/lint/plan-body-substance";

// PLAN-L7-92: concept AP-13「本文 0 行・declare のみの PLAN は無効」を機械強制する gate の回帰。

const FM = ["---", "plan_id: PLAN-X", "status: confirmed", "kind: impl", "---"].join("\n");

describe("countSubstantiveBodyLines", () => {
  it("frontmatter + タイトル + 本文 → 本文行を数える (>0)", () => {
    expect(countSubstantiveBodyLines(`${FM}\n\n# PLAN-X\n\n## §0\n本文がある。\n`)).toBe(2);
  });

  it("frontmatter + タイトルのみ → 0 (declare-only hollow)", () => {
    expect(countSubstantiveBodyLines(`${FM}\n\n# PLAN-X\n`)).toBe(0);
  });

  it("frontmatter + タイトル + HTML コメントのみ → 0 (コメントは実体でない)", () => {
    expect(countSubstantiveBodyLines(`${FM}\n\n# PLAN-X\n\n<!-- TODO -->\n`)).toBe(0);
  });

  it("本文が完全に空 → 0", () => {
    expect(countSubstantiveBodyLines(`${FM}\n\n`)).toBe(0);
  });

  it("CRLF frontmatter + 本文 → 正しく数える", () => {
    const crlf = [
      "---",
      "plan_id: PLAN-X",
      "status: confirmed",
      "kind: impl",
      "---",
      "",
      "# PLAN-X",
      "",
      "## §1 本文",
      "",
    ].join("\r\n");
    expect(countSubstantiveBodyLines(crlf)).toBe(1);
  });

  it("先頭 h1 のみ skip (2 個目以降の見出しは実体に数える)", () => {
    expect(countSubstantiveBodyLines(`${FM}\n\n# PLAN-X\n# また h1\n`)).toBe(1);
  });
});

describe("analyzePlanBodySubstance", () => {
  it("本文実体行 0 → violation / >0 → ok", () => {
    const r = analyzePlanBodySubstance([
      { planId: "PLAN-HOLLOW", substantiveLines: 0 },
      { planId: "PLAN-REAL", substantiveLines: 5 },
    ]);
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.planId)).toEqual(["PLAN-HOLLOW"]);
  });

  it("全 PLAN が本文を持てば ok", () => {
    const r = analyzePlanBodySubstance([{ planId: "PLAN-A", substantiveLines: 1 }]);
    expect(r.ok).toBe(true);
  });
});

describe("loadPlanBodySubstanceInput + checkPlanBodySubstance", () => {
  function writePlan(root: string, name: string, body: string): void {
    writeFileSync(
      join(root, "docs", "plans", name),
      [
        "---",
        `plan_id: ${name.replace(/\.md$/, "")}`,
        "status: confirmed",
        "kind: impl",
        "---",
        "",
        body,
        "",
      ].join("\n"),
      "utf8",
    );
  }

  it("declare-only な hollow PLAN を flag し、本文を持つ PLAN は通す", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-plan-body-"));
    try {
      mkdirSync(join(root, "docs", "plans"), { recursive: true });
      writePlan(root, "PLAN-TEST-92-real.md", "# PLAN-TEST-92-real\n\n## §0\n進め方を書く。");
      writePlan(root, "PLAN-TEST-92-hollow.md", "# PLAN-TEST-92-hollow");

      const result = checkPlanBodySubstance(root);
      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("PLAN-TEST-92-hollow");
      expect(result.messages.join("\n")).not.toContain("PLAN-TEST-92-real");

      const rows = loadPlanBodySubstanceInput(root);
      expect(rows.find((r) => r.planId === "PLAN-TEST-92-hollow")?.substantiveLines).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when repo root cannot be read", () => {
    expect(checkPlanBodySubstance(join(tmpdir(), "ut-tdd-plan-body-nope-zzz")).ok).toBe(false);
  });
});
