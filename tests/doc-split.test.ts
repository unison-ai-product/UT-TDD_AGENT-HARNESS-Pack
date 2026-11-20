import { describe, expect, it } from "vitest";
import {
  analyzeDocSplit,
  classifyDoc,
  type DocRename,
  type DocSplitBaseline,
  type DocSplitSource,
  measureDoc,
  parseDocSplitBaseline,
} from "../src/lint/doc-split.ts";

const L6 = "docs/design/harness/L6-function-design/";
const L7 = "docs/test-design/harness/";
const l6 = (name: string) => `${L6}${name}.md`;
const l7 = (name: string) => `${L7}L7-${name}-test-design.md`;
const source = (path: string, text: string): DocSplitSource => ({ path, text });
const lineText = (n: number) => "x\n".repeat(n);
const headings = (n: number, level = 2) =>
  Array.from({ length: n }, (_, index) => `${"#".repeat(level)} H${index + 1}`).join("\n");
const documentText = (lines: number, headingCount: number, level = 2) =>
  [
    ...Array.from({ length: Math.max(0, lines - headingCount) }, () => "x"),
    ...headings(headingCount, level).split("\n"),
  ].join("\n");
const families = (names: string[]) =>
  [
    "| ID | Description |",
    "| --- | --- |",
    ...names.map((name) => `| U-${name}-001 | case |`),
  ].join("\n");
const analyze = (
  sources: readonly DocSplitSource[],
  baseline: DocSplitBaseline = {},
  previousBaseline: DocSplitBaseline | null = null,
  mergeBaseMeasures: DocSplitBaseline | null = null,
  renames: readonly DocRename[] = [],
) => analyzeDocSplit({ sources, baseline, previousBaseline, mergeBaseMeasures, renames });
const reasons = (result: ReturnType<typeof analyzeDocSplit>, kind: string) =>
  result.findings.filter((finding) => finding.kind === kind).map((finding) => finding.reason);
const findingMessage = (result: ReturnType<typeof analyzeDocSplit>) =>
  (result.findings[0] as ((typeof result.findings)[number] & { message?: string }) | undefined)
    ?.message ?? "";

describe("doc split gate candidate oracles", () => {
  it("U-DOCSPLIT-001: counts lines after newline normalization", () => {
    const cases = [
      ["", 0],
      ["a\nb\n", 2],
      ["a\nb", 2],
      ["a\r\nb\r\n", 2],
      ["\n", 1],
    ] as const;
    for (const [text, expected] of cases) {
      expect(measureDoc(source(l6("lines"), text)).lines).toBe(expected);
    }
  });

  it("U-DOCSPLIT-002: counts fenced lines but excludes fenced headings and IDs", () => {
    const text = ["## Real", "```md", "## Fake", "| U-FAKE-001 | example |", "```"].join("\n");
    const measured = measureDoc(source(l6("fences"), text));
    expect(measured.lines).toBe(5);
    expect(measured.responsibilities).toBe(1);
    expect(measured.names).toEqual(["Real"]);
    const unclosed = measureDoc(source(l6("unclosed"), "## Real\n```\n## Fake"));
    expect(unclosed.names).toEqual(["Real"]);
    const l7Text = [
      "| ID | Description |",
      "| --- | --- |",
      "| U-REAL-001 | visible |",
      "```md",
      "| U-FAKE-001 | fenced |",
      "```",
    ].join("\n");
    const l7Measured = measureDoc(source(l7("fenced"), l7Text));
    expect(l7Measured.lines).toBe(6);
    expect(l7Measured.responsibilities).toBe(1);
    expect(l7Measured.names).toEqual(["REAL"]);
    const unclosedL7 = measureDoc(
      source(l7("unclosed"), l7Text.split("\n").slice(0, -1).join("\n")),
    );
    expect(unclosedL7.names).toEqual(["REAL"]);
  });

  it("U-DOCSPLIT-003: counts all L6 heading levels in order", () => {
    const measured = measureDoc(
      source(
        l6("headings"),
        "# Title\n## A\n### A-1\n## B\n#### Deep\n###### Last\n####### Not a heading",
      ),
    );
    expect(measured.responsibilities).toBe(5);
    expect(measured.names).toEqual(["A", "A-1", "B", "Deep", "Last"]);
  });

  it("U-DOCSPLIT-004: counts unique L7 oracle families from table cells", () => {
    const text = [
      "| ID | Description |",
      "| --- | --- |",
      "| CANDIDATE-U-DOCSPLIT-001 | first |",
      "| `CANDIDATE-U-WHIDE-004` | second |",
      // Fixture input, not an implementation citation; assemble these IDs so the static collector ignores them.
      `| ${["U", "FR", "L1", "21", "01"].join("-")} | third |`,
      `| ${["U", "RIGHT", "ARM", "ENGINE", "002"].join("-")} | fourth |`,
      "| CANDIDATE-U-DOCSPLIT-002 | repeated family |",
      "| U-ID (candidate) | header |",
      "| U-BAD-X | bad suffix |",
      "Outside U-OTHER-001",
    ].join("\n");
    const measured = measureDoc(source(l7("families"), text));
    expect(measured.responsibilities).toBe(4);
    expect(measured.names).toEqual(["DOCSPLIT", "WHIDE", "FR", "RIGHT"]);
  });

  it("U-DOCSPLIT-005: classifies normalized paths recursively", () => {
    expect(classifyDoc(l6("x"))).toBe("l6-topic");
    expect(classifyDoc(`${L6}sub/deep/x.md`)).toBe("l6-topic");
    expect(classifyDoc(`${L7}L7-x-test-design.md`)).toBe("l7-topic");
    expect(classifyDoc(`${L7}sub/L7-x-test-design.md`)).toBe("l7-topic");
    expect(classifyDoc(`${L7}L8-integration-test-design.md`)).toBe("layer-doc");
    expect(classifyDoc(`${L7}sub/x-test-design.md`)).toBe("layer-doc");
    expect(classifyDoc("docs/design/harness/L5-detailed-design/internal.md")).toBe("layer-doc");
    expect(classifyDoc("docs/plans/PLAN-1.md")).toBeNull();
    expect(classifyDoc("docs/design/harness/L6-function-design/x.txt")).toBeNull();
    expect(classifyDoc("docs\\design\\harness\\L6-function-design\\x.md")).toBe("l6-topic");
  });

  it("U-DOCSPLIT-006: enforces class-specific line limits at the boundary", () => {
    for (const [path, limit] of [
      [l6("l6"), 400],
      [l7("l7"), 400],
      ["docs/design/harness/L5/x.md", 1200],
    ] as const) {
      expect(analyze([source(path, lineText(limit))]).findings).toHaveLength(0);
      const over = analyze([source(path, lineText(limit + 1))]);
      expect(reasons(over, "doc-split-required")).toContain("new-doc-over-limit");
      expect(over.ok).toBe(false);
    }
  });

  it("U-DOCSPLIT-007: enforces responsibility limits only for topic docs", () => {
    expect(analyze([source(l6("sixteen"), headings(16))]).findings).toHaveLength(0);
    expect(
      reasons(analyze([source(l6("seventeen"), headings(17))]), "doc-split-required"),
    ).toContain("new-doc-over-limit");
    expect(analyze([source(l7("four"), families(["A", "B", "C", "D"]))]).findings).toHaveLength(0);
    const five = analyze([source(l7("five"), families(["A", "B", "C", "D", "E"]))]);
    expect(reasons(five, "doc-split-required")).toContain("new-doc-over-limit");
    expect(findingMessage(five)).toContain("5/4");
    expect(analyze([source("docs/design/harness/L5/x.md", headings(100))]).findings).toHaveLength(
      0,
    );
  });

  it("U-DOCSPLIT-008: allows baseline contents and rejects growth", () => {
    const path = l6("baseline");
    const baseline = { [path]: { lines: 500, responsibilities: 20 } };
    expect(analyze([source(path, documentText(500, 20))], baseline).findings).toHaveLength(0);
    for (const text of [documentText(501, 20), documentText(500, 21)]) {
      const result = analyze([source(path, text)], baseline);
      expect(reasons(result, "doc-split-required")).toContain("exceeds-baseline");
    }
  });

  it("U-DOCSPLIT-009: requires baseline updates for shrinkage", () => {
    const path = l6("baseline");
    const baseline = { [path]: { lines: 500, responsibilities: 20 } };
    for (const text of [documentText(499, 20), documentText(500, 19), documentText(499, 19)]) {
      const result = analyze([source(path, text)], baseline);
      expect(reasons(result, "doc-split-stale-baseline")).toContain("shrunk");
    }
  });

  it("U-DOCSPLIT-010: retires baselines that reach the limit", () => {
    const path = l6("baseline");
    const baseline = { [path]: { lines: 500, responsibilities: 20 } };
    for (const text of [documentText(400, 16), documentText(100, 3)]) {
      const result = analyze([source(path, text)], baseline);
      expect(reasons(result, "doc-split-stale-baseline")).toContain("within-limit");
    }
  });

  it("U-DOCSPLIT-011: rejects a baseline entry with no source file", () => {
    const result = analyze([source(l6("present"), documentText(401, 1))], {
      [l6("gone")]: { lines: 500, responsibilities: 20 },
    });
    expect(reasons(result, "doc-split-stale-baseline")).toContain("missing-file");
    expect(reasons(result, "doc-split-required")).toContain("new-doc-over-limit");
  });

  it("U-DOCSPLIT-012: ignores layer-doc responsibility changes", () => {
    const path = "docs/design/harness/L5/catalog.md";
    const baseline = { [path]: { lines: 1300, responsibilities: null } };
    expect(analyze([source(path, documentText(1300, 2))], baseline).findings).toHaveLength(0);
    expect(
      reasons(analyze([source(path, documentText(1301, 2))], baseline), "doc-split-required"),
    ).toContain("exceeds-baseline");
    expect(
      reasons(analyze([source(path, documentText(1299, 2))], baseline), "doc-split-stale-baseline"),
    ).toContain("shrunk");
    expect(analyze([source(path, documentText(1300, 100))], baseline).findings).toHaveLength(0);
  });

  it("U-DOCSPLIT-013: prevents baseline growth and entry swaps", () => {
    const a = l6("a");
    const b = l6("b");
    const aPrevious = { [a]: { lines: 500, responsibilities: 20 } };
    const bothPrevious = { ...aPrevious, [b]: { lines: 500, responsibilities: 20 } };
    const cases = [
      {
        baseline: aPrevious,
        previous: aPrevious,
        docs: [source(a, documentText(500, 20))],
        reason: false,
      },
      {
        baseline: { [a]: { lines: 501, responsibilities: 20 } },
        previous: aPrevious,
        docs: [source(a, documentText(501, 20))],
        reason: true,
      },
      {
        baseline: { [a]: { lines: 500, responsibilities: 21 } },
        previous: aPrevious,
        docs: [source(a, documentText(500, 21))],
        reason: true,
      },
      {
        baseline: { ...aPrevious, [b]: { lines: 500, responsibilities: 20 } },
        previous: aPrevious,
        docs: [source(a, documentText(500, 20)), source(b, documentText(500, 20))],
        reason: true,
      },
      {
        baseline: {
          [a]: { lines: 499, responsibilities: 20 },
          [b]: { lines: 501, responsibilities: 20 },
        },
        previous: bothPrevious,
        docs: [source(a, documentText(499, 20)), source(b, documentText(501, 20))],
        reason: true,
      },
      {
        baseline: {
          [a]: { lines: 400, responsibilities: 16 },
          [b]: { lines: 500, responsibilities: 20 },
        },
        previous: bothPrevious,
        docs: [source(a, documentText(400, 16)), source(b, documentText(500, 20))],
        reason: false,
      },
    ];
    for (const testCase of cases) {
      const growth = reasons(
        analyze(testCase.docs, testCase.baseline, testCase.previous),
        "doc-split-baseline-grown",
      );
      expect(growth.length > 0).toBe(testCase.reason);
    }
  });

  it("U-DOCSPLIT-015: treats empty sources as unreadable input", () => {
    const result = analyze([]);
    expect(result.ok).toBe(false);
    expect(reasons(result, "doc-split-input-unreadable")).not.toHaveLength(0);
  });

  it("U-DOCSPLIT-016: reports trailing responsibility names and correct target paths", () => {
    const many = analyze([source(l6("many"), headings(20))]);
    expect(findingMessage(many)).toContain("H17, H18, H19, H20");
    const linesOnly = analyze([source(l6("lines-only"), documentText(401, 5))]);
    expect(findingMessage(linesOnly)).toContain("H5");
    const baselinePath = l6("baseline");
    const baseline = { [baselinePath]: { lines: 500, responsibilities: 20 } };
    const baselineGrowth = analyze([source(baselinePath, documentText(501, 20))], baseline);
    expect(findingMessage(baselineGrowth)).toContain("H20");
    const l7Result = analyze([source(l7("many"), families(["A", "B", "C", "D", "E", "F"]))]);
    expect(findingMessage(l7Result)).toContain("docs/test-design/harness/L7-");
    expect(findingMessage(l7Result)).not.toContain("docs/design/harness/L6-function-design/");
    const layerResult = analyze([source("docs/design/harness/L5/catalog.md", lineText(1201))]);
    expect(findingMessage(layerResult)).toContain("責務ごとの文書に分ける");
    expect(findingMessage(layerResult)).not.toContain("<topic>");
  });

  it("U-DOCSPLIT-017: preserves deterministic shape and purity for identical inputs", () => {
    const sources = [source(l6("z"), documentText(501, 2)), source(l6("a"), documentText(501, 2))];
    const baseline = {
      [l6("z")]: { lines: 500, responsibilities: 20 },
      [l6("a")]: { lines: 500, responsibilities: 20 },
    };
    const before = JSON.stringify({ sources, baseline });
    const first = analyze(sources, baseline);
    const second = analyze(
      [...sources].reverse(),
      Object.fromEntries(Object.entries(baseline).reverse()),
    );
    expect(first.findings).toEqual(second.findings);
    expect(first.summary).toEqual(second.summary);
    expect(analyze(sources, baseline)).toEqual(first);
    expect(JSON.stringify({ sources, baseline })).toBe(before);
    expect(first.findings.map((item) => item.path)).toEqual(
      [...first.findings.map((item) => item.path)].sort(),
    );
  });

  it("U-DOCSPLIT-018: ignores sources outside the target trees", () => {
    const result = analyze([
      source("docs/plans/PLAN-1.md", lineText(2000)),
      source("src/huge.ts", lineText(2000)),
      source(l6("target"), "## Target"),
    ]);
    expect(result.summary.checked).toBe(1);
    expect(result.findings).toHaveLength(0);
  });

  it("U-DOCSPLIT-019: parses valid and invalid baseline JSON distinctly", () => {
    expect(
      parseDocSplitBaseline(
        JSON.stringify({
          [l6("x")]: { lines: 401, responsibilities: 17 },
          "docs/design/harness/L5/x.md": { lines: 1201, responsibilities: null },
        }),
      ),
    ).toEqual({
      [l6("x")]: { lines: 401, responsibilities: 17 },
      "docs/design/harness/L5/x.md": { lines: 1201, responsibilities: null },
    });
    expect(parseDocSplitBaseline("{}")).toEqual({});
    expect(parseDocSplitBaseline('{"x":{"lines":"bad","responsibilities":1}}')).toBeNull();
    expect(parseDocSplitBaseline("{")).toBeNull();
  });

  it("U-DOCSPLIT-019: rejects null responsibilities for topic baseline entries", () => {
    for (const path of [l6("x"), l7("x")]) {
      expect(
        parseDocSplitBaseline(JSON.stringify({ [path]: { lines: 500, responsibilities: null } })),
      ).toBeNull();
    }
    const layer = { "docs/design/harness/L5/x.md": { lines: 1201, responsibilities: null } };
    expect(parseDocSplitBaseline(JSON.stringify(layer))).toEqual(layer);
  });

  it("U-DOCSPLIT-013: rejects loosening topic baseline responsibilities to null", () => {
    const path = l6("big");
    const previous = { [path]: { lines: 500, responsibilities: 20 } };
    const loosened = { [path]: { lines: 500, responsibilities: null } };
    const grown = analyze([source(path, documentText(500, 30))], loosened, previous);
    expect(grown.ok).toBe(false);
    expect(reasons(grown, "doc-split-baseline-grown")).not.toHaveLength(0);
    const newPath = `${L6}sub/big.md`;
    const carried = analyze(
      [source(newPath, documentText(500, 20))],
      { [newPath]: { lines: 500, responsibilities: null } },
      previous,
      null,
      [{ from: path, to: newPath }],
    );
    expect(reasons(carried, "doc-split-baseline-grown")).not.toHaveLength(0);
    const initial = analyze([source(path, documentText(500, 20))], loosened, null, previous);
    expect(reasons(initial, "doc-split-initial-baseline-grown")).not.toHaveLength(0);
  });

  it("U-DOCSPLIT-022: does not allow formatting to hide responsibilities", () => {
    for (const text of [headings(17, 3), headings(17, 4), `${headings(9, 2)}\n${headings(8, 3)}`]) {
      const result = analyze([source(l6("format"), text)]);
      expect(measureDoc(source(l6("format"), text)).responsibilities).toBe(17);
      expect(reasons(result, "doc-split-required")).toContain("new-doc-over-limit");
    }
    const eighteen = `${headings(1, 2)}\n${headings(17, 3)}`;
    expect(measureDoc(source(l6("format"), eighteen)).responsibilities).toBe(18);
    expect(reasons(analyze([source(l6("format"), eighteen)]), "doc-split-required")).toContain(
      "new-doc-over-limit",
    );
    expect(analyze([source(l6("at-limit"), headings(16, 3))]).findings).toHaveLength(0);
    const movedIds = families(["A", "B", "C", "D", "E"]).replace(
      /\| U-([A-E])-001 \| case \|/g,
      "| note | U-$1-001 |",
    );
    expect(measureDoc(source(l7("format"), movedIds)).responsibilities).toBe(5);
    for (const text of [
      movedIds,
      "| ID | Description |\n| --- | --- |\n| U-A-001, U-B-001, U-C-001, U-D-001, U-E-001 | cases |",
      families(["A", "B", "C", "D", "E"]).replaceAll("U-", "`U-").replaceAll("-001", "-001`"),
    ]) {
      expect(reasons(analyze([source(l7("format"), text)]), "doc-split-required")).toContain(
        "new-doc-over-limit",
      );
    }
    expect(
      analyze([source(l7("duplicate"), families(["A", "B", "C", "D", "D"]))]).findings,
    ).toHaveLength(0);
  });

  it("U-DOCSPLIT-023: carries baseline over safe renames and rejects class changes", () => {
    const oldPath = l6("big");
    const newPath = `${L6}sub/big.md`;
    const previous = { [oldPath]: { lines: 500, responsibilities: 20 } };
    const carried = { [newPath]: { lines: 500, responsibilities: 20 } };
    expect(
      analyze([source(newPath, documentText(500, 20))], carried, previous, null, [
        { from: oldPath, to: newPath },
      ]).findings,
    ).toHaveLength(0);
    expect(
      reasons(
        analyze(
          [source(newPath, documentText(501, 20))],
          { [newPath]: { lines: 501, responsibilities: 20 } },
          previous,
          null,
          [{ from: oldPath, to: newPath }],
        ),
        "doc-split-baseline-grown",
      ),
    ).not.toHaveLength(0);
    expect(
      reasons(
        analyze(
          [source(newPath, documentText(500, 20))],
          { ...carried, [oldPath]: previous[oldPath] },
          previous,
          null,
          [{ from: oldPath, to: newPath }],
        ),
        "doc-split-stale-baseline",
      ),
    ).toContain("missing-file");
    for (const rename of [
      { from: oldPath, to: "docs/design/harness/L5-detailed-design/big.md" },
      { from: `${L7}L7-x-test-design.md`, to: `${L7}x-test-design.md` },
      { from: `${L7}L7-x-test-design.md`, to: "docs/archive/x.md" },
    ])
      expect(
        reasons(
          analyze([source(newPath, "## small")], {}, null, null, [rename]),
          "doc-split-class-changed",
        ),
      ).not.toHaveLength(0);
    expect(
      analyze([source(l6("imported"), "## small")], {}, null, null, [
        { from: "docs/archive/x.md", to: l6("imported") },
      ]).findings,
    ).toHaveLength(0);
    expect(
      reasons(
        analyze(
          [source(newPath, "## small")],
          { [newPath]: { lines: 1, responsibilities: 1 } },
          {},
          null,
        ),
        "doc-split-baseline-grown",
      ),
    ).not.toHaveLength(0);
  });
});
