import { describe, expect, it } from "vitest";
import { analyzeCodeSize, CODE_SIZE_LIMITS, measureCodeFile } from "../src/lint/code-size.ts";
import { REFACTOR_CANDIDATE_THRESHOLDS } from "../src/state-db/refactor-candidate-policy.ts";
import { analyzeRefactorCandidates } from "../src/state-db/refactor-candidates.ts";

const PATH = "src/x.ts";
const body = (count: number) => "x++;\n".repeat(count);
const candidates = (content: string, kind: string) =>
  analyzeRefactorCandidates([{ path: PATH, content }]).filter((item) => item.kind === kind);
const extractScores = (content: string) =>
  candidates(content, "extract-helper")
    .map((item) => item.score)
    .sort((a, b) => a - b);
const gateFunctionLines = (text: string) =>
  measureCodeFile({ path: PATH, text }).functions.map((item) => item.lines);
const moduleText = (nonblank: number) =>
  `export const v = 1;\n${"const a = 1;\n".repeat(nonblank - 1)}`;

describe("code size gate and refactor candidate alignment candidates", () => {
  it("U-CODESIZE-018(a): keeps each candidate threshold at or below its gate limit", () => {
    expect(CODE_SIZE_LIMITS.src.lines).toBeGreaterThanOrEqual(
      REFACTOR_CANDIDATE_THRESHOLDS.splitModuleLines,
    );
    expect(CODE_SIZE_LIMITS.src.functionLines).toBeGreaterThanOrEqual(
      REFACTOR_CANDIDATE_THRESHOLDS.extractHelperLines,
    );
  });

  it("U-CODESIZE-018(b): fixes the candidate and gate values", () => {
    expect(REFACTOR_CANDIDATE_THRESHOLDS.splitModuleLines).toBe(400);
    expect(REFACTOR_CANDIDATE_THRESHOLDS.extractHelperLines).toBe(120);
    expect(CODE_SIZE_LIMITS.src.lines).toBe(500);
  });

  it("U-CODESIZE-018(c): emits a split candidate from 400 lines while the gate waits for 501", () => {
    const outcome = [399, 400, 401].map((nonblank) => ({
      nonblank,
      candidate: candidates(moduleText(nonblank), "split-module").length,
      findings: analyzeCodeSize({
        sources: [{ path: PATH, text: moduleText(nonblank) }],
        baseline: {},
        previousBaseline: null,
        mergeBaseMeasures: {},
        renames: [],
      }).findings.length,
    }));
    expect(outcome).toEqual([
      { nonblank: 399, candidate: 0, findings: 0 },
      { nonblank: 400, candidate: 1, findings: 0 },
      { nonblank: 401, candidate: 1, findings: 0 },
    ]);
  });

  it("U-CODESIZE-019(a): counts comment-split lines the same way at exactly 120 lines", () => {
    const text = `function f() {\n${"x++; /* c\n*/ x++;\n".repeat(60)}}\n`;
    expect(extractScores(text)).toEqual([120]);
    expect(measureCodeFile({ path: PATH, text }).functionExcess).toBe(0);
    expect(gateFunctionLines(text)).toEqual([120]);
  });

  it("U-CODESIZE-019(b): counts comment-split lines the same way at 122 lines", () => {
    const text = `function f() {\n${"x++; /* c\n*/ x++;\n".repeat(61)}}\n`;
    expect(extractScores(text)).toEqual([122]);
    expect(measureCodeFile({ path: PATH, text }).functionExcess).toBe(2);
    expect(gateFunctionLines(text)).toEqual([122]);
  });

  it("U-CODESIZE-019(c): picks up method, constructor and getter bodies on both sides", () => {
    const text = `class C {\n  m() {\n${body(125)}  }\n  constructor() {\n${body(125)}  }\n  get g() {\n${body(125)}  }\n}\n`;
    expect(extractScores(text)).toEqual([125, 125, 125]);
    expect(measureCodeFile({ path: PATH, text }).functionExcess).toBe(15);
    expect(gateFunctionLines(text)).toEqual([125, 125, 125]);
  });

  it("U-CODESIZE-019(d): picks up an expression-bodied arrow function on both sides", () => {
    const text = `const f = () => [\n${"1,\n".repeat(123)}];\n`;
    expect(extractScores(text)).toEqual([125]);
    expect(measureCodeFile({ path: PATH, text }).functionExcess).toBe(5);
    expect(gateFunctionLines(text)).toEqual([125]);
  });

  it("U-CODESIZE-019(e): counts nested callbacks inside the outer function on both sides", () => {
    const text = `function outer() {\n${body(100)}  const cb = () => {\n${body(30)}  };\n}\n`;
    expect(extractScores(text)).toEqual([132]);
    expect(measureCodeFile({ path: PATH, text }).functionExcess).toBe(12);
    expect(gateFunctionLines(text)).toEqual([132, 30]);
  });
});
