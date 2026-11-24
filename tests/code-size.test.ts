import { describe, expect, it } from "vitest";
import {
  analyzeCodeSize,
  CODE_SIZE_LIMITS,
  type CodeRename,
  type CodeSizeBaseline,
  type CodeSizeResult,
  type CodeSizeSource,
  classifyCodeFile,
  measureCodeFile,
  parseCodeSizeBaseline,
} from "../src/lint/code-size.ts";

const source = (path: string, text: string): CodeSizeSource => ({ path, text });
const lines = (count: number) => "const a = 1;\n".repeat(count);
const body = (count: number) => "x++;\n".repeat(count);
const fn = (name: string, bodyLines: number) => `function ${name}() {\n${body(bodyLines)}}\n`;
/** A file of `total` nonblank lines whose function overshoots the function limit by `excess`. */
function codeFile(path: string, total: number, excess = 0): CodeSizeSource {
  const functionLines = excess > 0 ? CODE_SIZE_LIMITS.src.functionLines + excess + 2 : 0;
  return source(
    path,
    lines(total - functionLines) + (excess > 0 ? fn("big", functionLines - 2) : ""),
  );
}
const row = (linesValue: number | null, functionExcess: number | null = null) => ({
  lines: linesValue,
  functionExcess,
});
const analyze = (
  sources: readonly CodeSizeSource[],
  baseline: CodeSizeBaseline = {},
  previousBaseline: CodeSizeBaseline | null = null,
  mergeBaseMeasures: CodeSizeBaseline | null = {},
  renames: readonly CodeRename[] = [],
) => analyzeCodeSize({ sources, baseline, previousBaseline, mergeBaseMeasures, renames });
const reasons = (result: CodeSizeResult, kind: string) =>
  result.findings.filter((finding) => finding.kind === kind).map((finding) => finding.reason);
const kindsOf = (result: CodeSizeResult) => result.findings.map((finding) => finding.kind);

describe("code size gate candidate oracles", () => {
  it("U-CODESIZE-001: counts nonblank lines after newline normalization", () => {
    const cases = [
      ["", 0],
      ["a;\n\n  \nb;\n", 2],
      ["a;\r\n\r\nb;", 2],
      ["// c\n/* d */\na;\n", 3],
    ] as const;
    for (const [text, expected] of cases) {
      expect(measureCodeFile(source("src/x.ts", text)).lines).toBe(expected);
    }
  });

  it("U-CODESIZE-002: classifies normalized paths", () => {
    const expected: Array<[string, "src" | "tests" | null]> = [
      ["src/x.ts", "src"],
      ["src/a/b.tsx", "src"],
      ["src/a/c.mts", "src"],
      ["tests/x.test.ts", "tests"],
      ["tests/support/h.ts", "tests"],
      ["tests/fixtures/f.ts", null],
      ["src/types.d.ts", null],
      ["scripts/x.ts", null],
      ["src/x.js", null],
      ["src\\a\\b.ts", "src"],
      ["src/node_modules/m.ts", null],
      ["src/dist/d.ts", null],
    ];
    for (const [path, codeClass] of expected) {
      expect(classifyCodeFile(path), path).toBe(codeClass);
    }
  });

  it("U-CODESIZE-003: measures every function line count and the per-file excess", () => {
    const blockWithNoise = `function f() {\n${body(130)}\n  \n\n\n\n${"// c\n".repeat(5)}}\n`;
    const methodClass = `class C {\n  m() {\n${body(125)}  }\n}\n`;
    const arrowBlock = `const f = () => {\n${body(120)}};\n`;
    const arrowExpression = "const f = (x: number) =>\n  x +\n  1 +\n  2;\n";
    const nested = `function outer() {\n${body(100)}  const cb = () => {\n${body(30)}  };\n}\n`;
    const constructorAndGetter = `class C {\n  constructor() {\n${body(121)}  }\n  get g() {\n${body(10)}  }\n}\n`;
    // [text, functions[].lines in order of appearance, functionExcess, overFunctions[].lines]
    const cases: Array<[string, number[], number, number[]]> = [
      [blockWithNoise, [130], 10, [130]],
      [methodClass, [125], 5, [125]],
      [arrowBlock, [120], 0, []],
      [arrowExpression, [3], 0, []],
      [nested, [132, 30], 12, [132]],
      [constructorAndGetter, [121, 10], 1, [121]],
    ];
    for (const [text, functionLines, excess, overLines] of cases) {
      const measured = measureCodeFile(source("src/x.ts", text));
      expect(measured.functions.map((item) => item.lines)).toEqual(functionLines);
      expect(measured.functionExcess).toBe(excess);
      expect(measured.overFunctions.map((item) => item.lines)).toEqual(overLines);
    }
    const inTests = measureCodeFile(source("tests/x.test.ts", blockWithNoise));
    expect(inTests.functionExcess).toBeNull();
    expect(inTests.functions).toEqual([]);
    expect(inTests.overFunctions).toEqual([]);
  });

  it("U-CODESIZE-004: enforces file line limits at the boundary", () => {
    for (const path of ["src/x.ts", "tests/x.test.ts"]) {
      expect(analyze([source(path, lines(500))]).findings, `${path} 500`).toHaveLength(0);
      const over = analyze([source(path, lines(501))]);
      expect
        .soft(reasons(over, "code-size-required"), `${path} 501`)
        .toContain("new-file-over-limit");
      expect(over.ok).toBe(false);
    }
  });

  it("U-CODESIZE-005: applies the function limit to src only", () => {
    expect(analyze([source("src/x.ts", fn("f", 120))]).findings).toHaveLength(0);
    const over = analyze([source("src/x.ts", fn("f", 121))]);
    expect(reasons(over, "code-size-required")).toContain("new-file-over-limit");
    const callback = `it("x", () => {\n${body(300)}});\n`;
    expect(analyze([source("tests/x.test.ts", callback)]).findings).toHaveLength(0);
  });

  it("U-CODESIZE-006: lets baseline rows cap growth and requires shrink updates", () => {
    const baseline = { "src/big.ts": row(1300) };
    const run = (file: CodeSizeSource) => analyze([file], baseline, baseline);
    expect.soft(run(codeFile("src/big.ts", 1300)).findings).toHaveLength(0);
    expect(reasons(run(codeFile("src/big.ts", 1301)), "code-size-required")).toContain(
      "exceeds-baseline",
    );
    expect(reasons(run(codeFile("src/big.ts", 1299)), "code-size-stale-baseline")).toContain(
      "shrunk",
    );
    expect(reasons(run(codeFile("src/big.ts", 300)), "code-size-stale-baseline")).toContain(
      "within-limit",
    );
    expect(reasons(run(codeFile("src/big.ts", 1300, 1)), "code-size-required")).toContain(
      "exceeds-baseline",
    );
  });

  it("U-CODESIZE-007: keeps function-only baseline rows from freezing the file size", () => {
    const limit = CODE_SIZE_LIMITS.src.lines;
    const baseline = { "src/mid.ts": row(null, 30) };
    const run = (file: CodeSizeSource) => analyze([file], baseline, baseline);
    expect.soft(run(codeFile("src/mid.ts", limit, 30)).findings).toHaveLength(0);
    expect(reasons(run(codeFile("src/mid.ts", limit + 1, 30)), "code-size-required")).toContain(
      "exceeds-baseline",
    );
    expect(reasons(run(codeFile("src/mid.ts", 300, 31)), "code-size-required")).toContain(
      "exceeds-baseline",
    );
    expect(reasons(run(codeFile("src/mid.ts", 300, 29)), "code-size-stale-baseline")).toContain(
      "shrunk",
    );
    expect(reasons(run(codeFile("src/mid.ts", 300)), "code-size-stale-baseline")).toContain(
      "within-limit",
    );
  });

  it("U-CODESIZE-008: rejects a baseline row whose file is gone and keeps evaluating", () => {
    const result = analyze([codeFile("src/other.ts", 501)], { "src/gone.ts": row(900) });
    expect(reasons(result, "code-size-stale-baseline")).toContain("missing-file");
    expect(reasons(result, "code-size-required")).toContain("new-file-over-limit");
    expect(result.ok).toBe(false);
  });

  it("U-CODESIZE-009: forbids baseline growth but allows function excess moves", () => {
    const grown = (result: CodeSizeResult) => reasons(result, "code-size-baseline-grown");
    const a = (lineCount: number, excess = 0) => codeFile("src/a.ts", lineCount, excess);
    const b = (excess: number) => codeFile("src/b.ts", 300, excess);
    // (a) unchanged
    expect
      .soft(grown(analyze([a(1300)], { "src/a.ts": row(1300) }, { "src/a.ts": row(1300) })))
      .toHaveLength(0);
    // (b) lines grown on a path
    expect(
      grown(analyze([a(1310)], { "src/a.ts": row(1310) }, { "src/a.ts": row(1300) })).length,
    ).toBeGreaterThan(0);
    // (c) a non-null lines value on a path absent from the previous baseline
    expect(grown(analyze([a(1300)], { "src/a.ts": row(1300) }, {})).length).toBeGreaterThan(0);
    // (d) function excess moved from A to B with an unchanged total
    expect
      .soft(
        grown(
          analyze([a(300), b(30)], { "src/b.ts": row(null, 30) }, { "src/a.ts": row(null, 30) }),
        ),
      )
      .toHaveLength(0);
    // (e) total grew from 30 to 35
    expect(
      grown(
        analyze(
          [a(300, 10), b(25)],
          { "src/a.ts": row(null, 10), "src/b.ts": row(null, 25) },
          { "src/a.ts": row(null, 30) },
        ),
      ).length,
    ).toBeGreaterThan(0);
    // (f) one path grew while another shrank by the same amount
    expect
      .soft(
        grown(
          analyze(
            [a(300, 40), codeFile("src/c.ts", 300, 10)],
            { "src/a.ts": row(null, 40), "src/c.ts": row(null, 10) },
            { "src/a.ts": row(null, 30), "src/c.ts": row(null, 20) },
          ),
        ),
      )
      .toHaveLength(0);
    // (g) shrunk
    expect
      .soft(
        grown(analyze([a(300, 10)], { "src/a.ts": row(null, 10) }, { "src/a.ts": row(null, 30) })),
      )
      .toHaveLength(0);
  });

  it("U-CODESIZE-010: carries rows over same-class renames and rejects class changes", () => {
    const previous = { "src/big.ts": row(1300) };
    const rename = (to: string): CodeRename[] => [{ from: "src/big.ts", to }];
    const moved = analyze(
      [codeFile("src/sub/big.ts", 1300)],
      { "src/sub/big.ts": row(1300) },
      previous,
      null,
      rename("src/sub/big.ts"),
    );
    expect.soft(moved.findings).toHaveLength(0);
    const grew = analyze(
      [codeFile("src/sub/big.ts", 1301)],
      { "src/sub/big.ts": row(1301) },
      previous,
      null,
      rename("src/sub/big.ts"),
    );
    expect(reasons(grew, "code-size-baseline-grown").length).toBeGreaterThan(0);
    const kept = analyze(
      [codeFile("src/sub/big.ts", 1300)],
      { "src/sub/big.ts": row(1300), "src/big.ts": row(1300) },
      previous,
      null,
      rename("src/sub/big.ts"),
    );
    expect(reasons(kept, "code-size-stale-baseline")).toContain("missing-file");
    for (const [from, to] of [
      ["src/big.ts", "tests/big.ts"],
      ["src/big.ts", "scripts/big.ts"],
      ["tests/a.test.ts", "tests/fixtures/a.ts"],
    ] as const) {
      const changed = analyze([], {}, { [from]: row(1300) }, null, [{ from, to }]);
      expect(
        changed.findings.filter((f) => f.kind === "code-size-class-changed").map((f) => f.path),
      ).toEqual([to]);
    }
    const imported = analyze([codeFile("src/x.ts", 300)], {}, {}, null, [
      { from: "scripts/x.ts", to: "src/x.ts" },
    ]);
    expect.soft(imported.findings).toHaveLength(0);
  });

  it("U-CODESIZE-011: checks an initial baseline against the merge-base measurement", () => {
    const initial = (
      sources: CodeSizeSource[],
      baseline: CodeSizeBaseline,
      mergeBase: CodeSizeBaseline | null,
    ) => analyze(sources, baseline, null, mergeBase);
    // (a) grown by the recording PR itself
    expect(
      kindsOf(
        initial([codeFile("src/a.ts", 1350)], { "src/a.ts": row(1350) }, { "src/a.ts": row(1300) }),
      ),
    ).toContain("code-size-initial-baseline-grown");
    // (b) absent from the merge-base
    expect(kindsOf(initial([codeFile("src/n.ts", 1300)], { "src/n.ts": row(1300) }, {}))).toContain(
      "code-size-initial-baseline-new-entry",
    );
    // (c) under the limit at the merge-base (the recorded form has no row)
    expect(kindsOf(initial([codeFile("src/c.ts", 600)], { "src/c.ts": row(600) }, {}))).toContain(
      "code-size-initial-baseline-new-entry",
    );
    // (d) unchanged
    expect
      .soft(
        kindsOf(
          initial(
            [codeFile("src/a.ts", 1300)],
            { "src/a.ts": row(1300) },
            { "src/a.ts": row(1300) },
          ),
        ),
      )
      .toHaveLength(0);
    // (e) function excess grown
    expect(
      kindsOf(
        initial(
          [codeFile("src/a.ts", 300, 25)],
          { "src/a.ts": row(null, 25) },
          { "src/a.ts": row(null, 20) },
        ),
      ),
    ).toContain("code-size-initial-baseline-grown");
    // (g) lines recorded above the null (= class limit) merge-base form
    expect(
      kindsOf(
        initial(
          [codeFile("src/a.ts", 1300, 20)],
          { "src/a.ts": row(1300, 20) },
          { "src/a.ts": row(null, 20) },
        ),
      ),
    ).toContain("code-size-initial-baseline-grown");
    // (h) null lines is matched by the null merge-base form
    expect
      .soft(
        kindsOf(
          initial(
            [codeFile("src/a.ts", 300, 20)],
            { "src/a.ts": row(null, 20) },
            { "src/a.ts": row(null, 20) },
          ),
        ),
      )
      .toHaveLength(0);
    // (f) an unresolvable merge-base fails closed
    const unreadable = initial([codeFile("src/a.ts", 1300)], { "src/a.ts": row(1300) }, null);
    expect(kindsOf(unreadable)).toContain("code-size-baseline-base-unreadable");
    expect(unreadable.ok).toBe(false);
  });

  it("U-CODESIZE-011(f): an empty baseline with an unresolved merge-base still fails closed", () => {
    const result = analyze([codeFile("src/small.ts", 10)], {}, null, null);
    expect(kindsOf(result)).toContain("code-size-baseline-base-unreadable");
    expect(result.ok).toBe(false);
  });

  it("U-CODESIZE-013: treats unreadable input as a failure and stays pure", () => {
    const empty = analyze([]);
    expect(kindsOf(empty)).toContain("code-size-input-unreadable");
    expect(empty.ok).toBe(false);
    const sources = [
      codeFile("src/b.ts", 501),
      codeFile("src/a.ts", 501),
      codeFile("src/ok.ts", 10),
    ];
    const baseline = { "src/z.ts": row(900), "src/gone.ts": row(900) };
    const first = analyze(sources, baseline);
    const second = analyze(
      [...sources].reverse(),
      Object.fromEntries(Object.entries(baseline).reverse()),
    );
    expect(first.findings.length).toBeGreaterThan(0);
    expect(second.findings).toEqual(first.findings);
    expect(second.summary).toEqual(first.summary);
    const order = first.findings.map((f) => `${f.path}\u0000${f.kind}\u0000${f.reason}`);
    expect(order).toEqual([...order].sort());
    const snapshot = structuredClone({ sources, baseline });
    analyze(sources, baseline);
    expect({ sources, baseline }).toEqual(snapshot);
    const mixed = analyze([
      source("docs/x.md", lines(5000)),
      source("scripts/x.ts", lines(5000)),
      source("src/ok.ts", lines(3)),
    ]);
    expect(mixed.findings).toHaveLength(0);
    expect(mixed.summary).toEqual({ checked: 1, over: 0, stale: 0, baseline: 0 });
  });

  it("U-CODESIZE-014: parses valid baselines and rejects broken ones", () => {
    const valid = JSON.stringify({
      "src/a.ts": { lines: 900, functionExcess: null },
      "src/b.ts": { lines: null, functionExcess: 30 },
    });
    expect(parseCodeSizeBaseline(valid)).toEqual({
      "src/a.ts": { lines: 900, functionExcess: null },
      "src/b.ts": { lines: null, functionExcess: 30 },
    });
    expect(parseCodeSizeBaseline("{}")).toEqual({});
    const invalid = [
      '{"src/a.ts":{"lines":"x","functionExcess":null}}',
      '{"src/a.ts":{"lines":null,"functionExcess":"x"}}',
      '{"src/a.ts":{"lines":-1,"functionExcess":null}}',
      '{"src/a.ts":{"lines":900',
    ];
    for (const text of invalid) expect(parseCodeSizeBaseline(text), text).toBeNull();
  });
});
