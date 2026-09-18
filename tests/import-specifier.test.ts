// PLAN-L7-462 PR-A (AC-5 前半): 相対 import 指定子の拡張子必須 gate。
// 拡張子なし / .js 指定子 / 実在しない .ts target を fail-close し、fixture 文字列・
// コメント・regex literal 内の import 記述を誤検出しない (TS AST 抽出)。
import { describe, expect, it } from "vitest";
import {
  analyzeImportSpecifiers,
  extractImportSpecifiers,
  loadImportSpecifierInput,
} from "../src/lint/import-specifier.ts";

const FILES = new Set(["src/a.ts", "src/b/index.ts", "src/util.json"]);

function analyze(path: string, text: string) {
  return analyzeImportSpecifiers({ docs: [{ path, text }], files: FILES });
}

describe("extractImportSpecifiers (scanner)", () => {
  it("static / dynamic / require / side-effect / export-from を code 位置でだけ拾う", () => {
    const text = [
      'import { a } from "./a.ts";',
      'export { b } from "../b/index.ts";',
      'import "./side-effect";',
      'const m = await import("./dyn");',
      'const r = require("./req");',
      'vi.mock("./mocked");',
    ].join("\n");
    expect(extractImportSpecifiers(text).map((s) => s.specifier)).toEqual([
      "./a.ts",
      "../b/index.ts",
      "./side-effect",
      "./dyn",
      "./req",
      "./mocked",
    ]);
  });

  it("文字列リテラル・template・コメント内の import 記述は code として読まない", () => {
    const text = [
      "const fixture = 'import { x } from \"../lint/dead\";';",
      "const tpl = `",
      'import { y } from "./embedded";',
      "`;",
      '// import { z } from "./commented";',
      '/* import { w } from "./block"; */',
      "expect(src).toContain('} from \"./runner\"');",
    ].join("\n");
    expect(extractImportSpecifiers(text)).toEqual([]);
  });

  it("regex literal (引用符含む) の後の import も検出する (blind review BL-1 回帰)", () => {
    // 初版 mini-scanner は /"/ を文字列開始と誤認し、以降ファイル末尾まで盲域になった
    // (src/lint/relation-graph.ts:563 の実在パターン)。
    const text = [
      'const esc = (label: string) => label.replace(/\\\\/g, "\\\\\\\\").replace(/"/g, \'\\\\"\');',
      'export * from "./after-regex";',
    ].join("\n");
    expect(extractImportSpecifiers(text).map((s) => s.specifier)).toEqual(["./after-regex"]);
  });

  it("複数行 import / 文字列連結・キーワード風識別子の非検出 (mn-1〜3 回帰)", () => {
    const text = [
      "const m = await import(",
      '  "./multi-line"',
      ");",
      "import {",
      "  a,",
      '} from "./multi-decl";',
      'const s = myfrom("./not-import");',
      'const t = xrequire("./not-require");',
    ].join("\n");
    expect(extractImportSpecifiers(text).map((s) => s.specifier)).toEqual([
      "./multi-line",
      "./multi-decl",
    ]);
  });
});

describe("analyzeImportSpecifiers", () => {
  it("拡張子なし相対 import は missing-extension で fail-close", () => {
    const r = analyze("src/x.ts", 'import { a } from "./a";');
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].rule).toBe("missing-extension");
    expect(r.ok).toBe(false);
  });

  it("相対 .js 指定子は js-specifier で fail-close (bun では不可視の node blocker)", () => {
    const r = analyze("src/x.ts", 'import { a } from "./a.js";');
    expect(r.violations[0].rule).toBe("js-specifier");
  });

  it("実在しない .ts target は unresolved-ts-target", () => {
    const r = analyze("src/x.ts", 'import { c } from "./missing.ts";');
    expect(r.violations[0].rule).toBe("unresolved-ts-target");
  });

  it("実在 .ts / .json / 非相対 (bare specifier) は違反にしない", () => {
    const r = analyze(
      "src/x.ts",
      [
        'import { a } from "./a.ts";',
        'import { b } from "./b/index.ts";',
        'import u from "./util.json";',
        'import { join } from "node:path";',
        'import { z } from "zod";',
      ].join("\n"),
    );
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe("real repo regression", () => {
  it("実 repo の相対指定子は全件 実在 .ts 拡張子付き (再流入 0、fail-close 回帰網)", () => {
    const r = analyzeImportSpecifiers(loadImportSpecifierInput(process.cwd()));
    expect(r.violations).toEqual([]);
    expect(r.checked).toBeGreaterThan(620);
    expect(r.specifiers).toBeGreaterThan(1500);
  });

  it("canary 注入: 実 repo 全ファイルの末尾に違反を差し込むと全件検出される (盲点 0 の実証)", () => {
    // blind review BL-1 の検出手法をそのまま回帰化: gate の「見えていないファイル」を許さない。
    // 手書き scanner は 26/634 ファイルで canary を見落としていた (regex literal desync)。
    const input = loadImportSpecifierInput(process.cwd());
    const blind = input.docs.filter((doc) => {
      const canaried = `${doc.text}\nimport { canary } from "./CANARY_NO_EXT";\n`;
      const r = analyzeImportSpecifiers({
        docs: [{ path: doc.path, text: canaried }],
        files: input.files,
      });
      return !r.violations.some((v) => v.specifier === "./CANARY_NO_EXT");
    });
    expect(blind.map((d) => d.path)).toEqual([]);
  });
});
