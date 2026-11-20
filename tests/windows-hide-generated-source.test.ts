/**
 * issue #1607 生成される source の windowsHide 静的検査。
 * Contract: docs/design/harness/L6-function-design/windows-hide-default.md §3
 * Test design: docs/test-design/harness/L7-windows-hide-default-test-design.md
 */
import { describe, expect, it } from "vitest";
import { MISSING_RUNTIME_GUARD_BOOTSTRAP } from "../src/lint/project-hook.ts";
import { renderConsumerNodeWrapper } from "../src/setup/consumer-node-runtime.ts";
import { CONSUMER_RUNTIME_ABSENT_WRAPPER_SOURCE } from "../src/setup/consumer-runtime-absent-guidance.ts";

type ChildProcessCall = { name: string; args: string };
type GeneratedSourceScan = { calls: number; violations: ChildProcessCall[] };

const CALL = /\b(execFileSync|execSync|spawnSync|spawn|execFile|exec)\s*\(/g;
const HIDE_TRUE_PROPERTY = /^\s*(?:windowsHide|"windowsHide"|'windowsHide')\s*:\s*true\s*$/;
const OPEN = "([{";
const CLOSE = ")]}";

/** 文字列 literal の終わりの位置を返す。 */
function skipString(source: string, start: number): number {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length && source[index] !== quote) index += source[index] === "\\" ? 2 : 1;
  return index;
}

/** コメントを同じ長さの空白に置き換える。文字列 literal の中は変えない。 */
function maskComments(source: string): string {
  let out = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      const end = skipString(source, index);
      out += source.slice(index, end + 1);
      index = end;
    } else if (char === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index);
      const stop = end < 0 ? source.length : end;
      out += " ".repeat(stop - index);
      index = stop - 1;
    } else if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end < 0 ? source.length : end + 2;
      out += source.slice(index, stop).replace(/[^\n]/g, " ");
      index = stop - 1;
    } else {
      out += char;
    }
  }
  return out;
}

/**
 * `open` の位置の開き括弧から対応する閉じ括弧までの中身を、最上位の区切り文字で分ける。
 * 文字列 literal の中と、入れ子の括弧の中の区切り文字は数えない。
 */
function splitTopLevel(source: string, open: number, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (char === '"' || char === "'" || char === "`") {
      index = skipString(source, index);
    } else if (OPEN.includes(char)) {
      depth += 1;
    } else if (CLOSE.includes(char)) {
      depth -= 1;
      if (depth === 0) {
        parts.push(source.slice(start, index));
        return parts;
      }
    } else if (char === separator && depth === 1) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

/** その呼び出し自身の最後の引数が object literal で、最上位の key `windowsHide` の値が literal の true か。 */
function hasOwnWindowsHideTrue(args: string[]): boolean {
  const options = (args.at(-1) ?? "").trim();
  if (!options.startsWith("{") || !options.endsWith("}")) return false;
  return splitTopLevel(options, 0, ",").some((property) => HIDE_TRUE_PROPERTY.test(property));
}

function scanGeneratedSource(source: string): GeneratedSourceScan {
  const masked = maskComments(source);
  const scan: GeneratedSourceScan = { calls: 0, violations: [] };
  for (const match of masked.matchAll(CALL)) {
    const args = splitTopLevel(masked, (match.index ?? 0) + match[0].length - 1, ",");
    scan.calls += 1;
    if (!hasOwnWindowsHideTrue(args)) {
      scan.violations.push({ name: match[1] ?? "", args: args.join(",") });
    }
  }
  return scan;
}

/** 呼び出しが 0 件の入力は検査できていないので失敗させる。 */
function violationsOf(label: string, source: string): string[] {
  const scan = scanGeneratedSource(source);
  if (scan.calls === 0) throw new Error(`${label}: child_process の呼び出しを検出できない`);
  return scan.violations.map((call) => `${label}: ${call.name}(${call.args})`);
}

const GENERATED_SOURCES: Record<string, string> = {
  MISSING_RUNTIME_GUARD_BOOTSTRAP,
  CONSUMER_RUNTIME_ABSENT_WRAPPER_SOURCE,
  renderConsumerNodeWrapper: renderConsumerNodeWrapper(),
};

describe("issue #1607 生成される source の windowsHide (Red)", () => {
  describe("U-WHIDE-015", () =>
    it("U-WHIDE-015: 生成される source の child_process 呼び出しはすべて windowsHide: true を持つ", () => {
      const violations = Object.entries(GENERATED_SOURCES).flatMap(([label, source]) =>
        violationsOf(label, source),
      );
      expect(violations).toEqual([]);
    }));

  describe("U-WHIDE-016", () =>
    it("U-WHIDE-016: 検査関数は windowsHide の無い・false の呼び出しだけを指摘し、0 件の入力は検査不能とする", () => {
      const missing =
        'cp.execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"});cp.spawnSync(process.execPath,[a],{windowsHide:true})';
      const missingScan = scanGeneratedSource(missing);
      expect(missingScan.calls).toBe(2);
      expect(missingScan.violations.map((call) => call.name)).toEqual(["execFileSync"]);

      const falseScan = scanGeneratedSource('cp.spawn("x",[],{ windowsHide : false })');
      expect(falseScan.violations.map((call) => call.name)).toEqual(["spawn"]);

      expect(() => violationsOf("empty", "const x = 1; spawnSyncLike(1)")).toThrow(/検出できない/);

      const borrowedFromNested = scanGeneratedSource(
        'cp.execFileSync("git",[cp.execSync("args",{windowsHide:true})],{encoding:"utf8"})',
      );
      expect(borrowedFromNested.calls).toBe(2);
      expect(borrowedFromNested.violations.map((call) => call.name)).toEqual(["execFileSync"]);

      const borrowedFromString = scanGeneratedSource(
        'cp.execFileSync("git",[],{encoding:"utf8",note:"windowsHide:true"})',
      );
      expect(borrowedFromString.violations.map((call) => call.name)).toEqual(["execFileSync"]);

      const borrowedFromComment = scanGeneratedSource(
        'cp.execFileSync("git",[],{encoding:"utf8" /* windowsHide:true */})',
      );
      expect(borrowedFromComment.violations.map((call) => call.name)).toEqual(["execFileSync"]);
    }));
});
