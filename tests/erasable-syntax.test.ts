// PLAN-L7-462 PR-B (AC-5 後半): node strip-only 実行可能性 gate。
// oracle は node:module stripTypeScriptTypes (hooks を動かす runtime と同一判定器)。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeErasableSyntax } from "../src/lint/erasable-syntax.ts";

function fixtureRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-erasable-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text, "utf8");
  }
  return root;
}

describe("analyzeErasableSyntax", () => {
  it("parameter property / enum / namespace は strip-only 違反として fail-close", () => {
    const root = fixtureRepo({
      "src/pp.ts": "class A { constructor(private readonly x: string) {} }\n",
      "src/en.ts": "enum E { A }\nexport const e = E.A;\n",
      "src/ok.ts": 'export const x: number = 1;\nimport "./pp.ts";\n',
    });
    const r = analyzeErasableSyntax(root);
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.path).sort()).toEqual(["src/en.ts", "src/pp.ts"]);
  });

  it("erasable のみの repo は green (型注釈・.ts 拡張子 import は許容)", () => {
    const root = fixtureRepo({
      "src/a.ts": 'import { b } from "./b.ts";\nexport const a: number = b;\n',
      "src/b.ts": "export const b: number = 2;\n",
    });
    const r = analyzeErasableSyntax(root);
    expect(r.violations).toEqual([]);
    expect(r.checked).toBe(2);
    expect(r.ok).toBe(true);
  });

  it("実 repo は node strip-only 違反 0 (parameter properties 49 箇所の erasable 化後、再流入 0 の回帰網)", () => {
    const r = analyzeErasableSyntax(process.cwd());
    expect(r.violations).toEqual([]);
    expect(r.checked).toBeGreaterThan(620);
  });
});
