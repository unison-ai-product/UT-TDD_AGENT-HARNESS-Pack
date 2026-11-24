import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  compareLenientVersion,
  newestVersioned,
  type VersionedCandidate,
} from "../src/runtime/adapter.ts";

// 符号だけを約束する。NaN は 0 とみなす (L6 semver-comparison §3.0 / D-A7)。
const sign = (n: number): number => (Number.isNaN(n) ? 0 : Math.sign(n));
const cmp = (a: string, b: string): number => sign(compareLenientVersion(a, b));

describe("A: compareLenientVersion (特性化)", () => {
  it("U-SEMVER-001: 数値の大小で比べる", () => {
    expect(cmp("1.10.0", "1.9.0")).toBe(1);
  });

  it("U-SEMVER-002: platform 接尾辞を無視する", () => {
    expect(cmp("1.10.0-win32-x64", "1.9.0")).toBe(1);
    expect(cmp("1.2.3-rc.1-win32", "1.2.3")).toBe(0);
  });

  it("U-SEMVER-003: prerelease は順序に効かない", () => {
    expect(cmp("1.2.3-rc.1", "1.2.3")).toBe(0);
    expect(cmp("1.2.3", "1.2.3-win32-x64")).toBe(0);
  });

  it("U-SEMVER-004: build を無視する", () => {
    expect(cmp("1.0.0+a", "1.0.0+b")).toBe(0);
  });

  it("U-SEMVER-005: 足りない部は 0", () => {
    expect(cmp("1.2", "1.2.0")).toBe(0);
    expect(cmp("1", "1.0.0")).toBe(0);
    expect(cmp(".5", "0.5.0")).toBe(0);
    expect(cmp("1.2.", "1.2.0")).toBe(0);
  });

  it("U-SEMVER-006: 数えられない入力は最古", () => {
    expect(cmp("", "0.0.0")).toBe(0);
    expect(cmp("abc", "0.0.0")).toBe(0);
    expect(cmp("abc", "1.0.0")).toBe(-1);
    expect(cmp("win32-x64", "0.0.0")).toBe(0);
    expect(cmp("-1.2.3", "0.0.0")).toBe(0);
  });

  it("U-SEMVER-007: v 接頭辞は 0 として読む", () => {
    expect(cmp("v1.2.3", "1.2.3")).toBe(-1);
  });

  it("U-SEMVER-008: parseInt の寛容さ", () => {
    expect(cmp("1.x.3", "1.0.3")).toBe(0);
    expect(cmp("1.2abc.3", "1.2.3")).toBe(0);
    expect(cmp("01.02.03", "1.2.3")).toBe(0);
  });

  it("U-SEMVER-009: 4 部目以降も比べる", () => {
    expect(cmp("1.2.3.4", "1.2.3")).toBe(1);
    expect(cmp("1.2.3.4", "1.2.3.5")).toBe(-1);
  });

  it("U-SEMVER-010: 桁あふれしても例外を投げず大きい側が新しい", () => {
    expect(cmp("99999999999999999999.0.0", "1.0.0")).toBe(1);
  });

  it("U-SEMVER-029: 範囲外の数は Number の丸め後の値で比べる", () => {
    expect(cmp("9007199254740992.0.0", "9007199254740994.0.0")).toBe(-1);
    expect(cmp("9007199254740992.0.0", "9007199254740993.0.0")).toBe(0);
    expect(cmp("99999999999999999999.0.0", "99999999999999999998.0.0")).toBe(0);
  });

  it("U-SEMVER-030: Infinity は次の部を見ずに打ち切る", () => {
    const huge = `1${"0".repeat(400)}`;
    const huger = `2${"0".repeat(400)}`;
    expect(cmp(`${huge}.9`, `${huge}.0`)).toBe(0);
    expect(cmp(huger, huge)).toBe(0);
  });
});

describe("A: newestVersioned (特性化)", () => {
  let root: string;
  let seq = 0;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "semver-a-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** 存在する候補は空の file を作り、存在しない候補は path だけ返す。 */
  const candidate = (version: string, exists: boolean): VersionedCandidate => {
    const dir = join(root, `c${seq++}`);
    const path = join(dir, "claude.exe");
    if (exists) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, "");
    }
    return { path, version };
  };

  it("U-SEMVER-011: 候補が空、または全て存在しなければ null", () => {
    expect(newestVersioned([])).toBeNull();
    expect(newestVersioned([candidate("1.0.0", false), candidate("2.0.0", false)])).toBeNull();
  });

  it("U-SEMVER-012: 並びに依らず最新の path を選ぶ", () => {
    const a = candidate("1.9.0", true);
    const b = candidate("1.10.0", true);
    expect(newestVersioned([a, b])).toBe(b.path);
    expect(newestVersioned([b, a])).toBe(b.path);
  });

  it("U-SEMVER-013: 同値は先に渡した候補を残す", () => {
    const appData = candidate("1.0.0", true);
    const vscode = candidate("1.0.0-win32-x64", true);
    expect(newestVersioned([appData, vscode])).toBe(appData.path);
    const unreadable = candidate("abc", true);
    const zero = candidate("0.0.0", true);
    expect(newestVersioned([unreadable, zero])).toBe(unreadable.path);
  });

  it("U-SEMVER-014: 読めない版は最古、存在しない候補は比べない", () => {
    const unreadable = candidate("abc", true);
    const one = candidate("1.0.0", true);
    expect(newestVersioned([unreadable, one])).toBe(one.path);
    const missing = candidate("1.10.0", false);
    const nine = candidate("1.9.0", true);
    expect(newestVersioned([missing, nine])).toBe(nine.path);
  });
});
