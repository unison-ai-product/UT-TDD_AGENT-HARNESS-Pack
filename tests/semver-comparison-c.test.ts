import semver from "semver";
import { describe, expect, it } from "vitest";
import { comparePackageSemver, parsePackageSemver } from "../src/setup/update-check.ts";

const parse = (v: string) => {
  const p = parsePackageSemver(v);
  if (!p) throw new Error(`parse failed: ${v}`);
  return p;
};
const cmp = (a: string, b: string) => Math.sign(comparePackageSemver(parse(a), parse(b)));

describe("C: parsePackageSemver / comparePackageSemver (特性化)", () => {
  it("U-SEMVER-022: 長さの上限を設けない", () => {
    const a251 = `1.0.0-${"a".repeat(251)}`;
    const b251 = `1.0.0-${"b".repeat(251)}`;
    const a250 = `1.0.0-${"a".repeat(250)}`;
    expect(a251.length).toBe(257);
    expect(a250.length).toBe(256);
    for (const v of [a251, b251, a250]) expect(parsePackageSemver(v)).not.toBeNull();
    expect(() => comparePackageSemver(parse(a251), parse(b251))).not.toThrow();
    expect(cmp(a251, b251)).toBeLessThan(0);
  });

  it("U-SEMVER-023: 厳密な受け入れ", () => {
    const bad: unknown[] = [
      "1.0.0 ",
      "1.0.0\n",
      " 0.2.0-canary.1",
      "v0.2.0-canary.1",
      "=1.0.0",
      "1.2",
      "01.0.0",
      "1.0.0-a..b",
      "1.0.0+",
      "1.0.0-1.01",
      "0.2.0-",
      "0.2.0-01",
      "9007199254740992.0.0",
      undefined,
      1,
    ];
    for (const v of bad) expect(parsePackageSemver(v)).toBeNull();
  });

  it("U-SEMVER-024: prerelease は文字列の配列で、前者が低い", () => {
    const pre = parse("0.2.0-canary.1");
    expect(pre.prerelease).toEqual(["canary", "1"]);
    expect(comparePackageSemver(pre, parse("0.2.0"))).toBeLessThan(0);
  });

  it("U-SEMVER-025: build は無視する", () => {
    expect(cmp("1.0.0+build.1", "1.0.0+build.2")).toBe(0);
  });

  const lowerPairs: [string, string][] = [
    ["1.0.0-alpha", "1.0.0-alpha.1"],
    ["1.0.0-1", "1.0.0-alpha"],
    ["1.0.0-rc.2", "1.0.0-rc.10"],
    ["1.0.0-RC", "1.0.0-rc"],
    ["1.0.0-9007199254740993", "1.0.0-9007199254740994"],
  ];

  it("U-SEMVER-026: prerelease の識別子の順", () => {
    for (const [lo, hi] of lowerPairs)
      expect(comparePackageSemver(parse(lo), parse(hi))).toBeLessThan(0);
  });

  it("U-SEMVER-027: 返り値は符号だけを約束する", () => {
    for (const [lo, hi] of lowerPairs) {
      expect(cmp(lo, hi)).toBe(-1);
      expect(cmp(hi, lo)).toBe(1);
      expect(cmp(lo, lo)).toBe(0);
    }
  });

  it("U-SEMVER-028: 15 桁以下の識別子では semver.compare と符号が一致する", () => {
    let s = 20261120;
    const rnd = (n: number) => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return Math.floor((s / 2 ** 32) * n);
    };
    const alpha = "abcxyzAZ-";
    const seen = { numeric: 0, alpha: 0, hyphen: 0, samePrerelease: 0 };
    const ident = () => {
      const kind = rnd(3);
      if (kind === 0) seen.numeric++;
      else seen.alpha++;
      if (kind === 0) {
        const len = 1 + rnd(15);
        const d = String(1 + rnd(9)) + Array.from({ length: len - 1 }, () => rnd(10)).join("");
        return len === 1 && rnd(2) === 0 ? "0" : d;
      }
      const len = 1 + rnd(6);
      const body = Array.from({ length: len }, () => alpha[rnd(alpha.length)]).join("");
      if (body.includes("-")) seen.hyphen++;
      return kind === 1 ? `${body}a` : `${body}${rnd(10)}`;
    };
    const version = () => {
      const core = `${rnd(3)}.${rnd(3)}.${rnd(3)}`;
      const n = rnd(4);
      return n === 0 ? core : `${core}-${Array.from({ length: n }, ident).join(".")}`;
    };
    const pairs = 2500;
    for (let i = 0; i < pairs; i++) {
      const a = version();
      const b = version();
      expect(semver.valid(a), a).not.toBeNull();
      expect(semver.valid(b), b).not.toBeNull();
      expect(cmp(a, b), `${a} vs ${b}`).toBe(Math.sign(semver.compare(a, b)));
      const [coreA, preA] = a.split(/-(.*)/s);
      const [coreB, preB] = b.split(/-(.*)/s);
      if (preA && preB && coreA === coreB) seen.samePrerelease++;
    }
    // 生成器が L7 の範囲 (数字・英字・ハイフンの識別子、core が等しい prerelease 同士) を実際に作ったことを確かめる。
    expect(seen.numeric).toBeGreaterThan(0);
    expect(seen.alpha).toBeGreaterThan(0);
    expect(seen.hyphen).toBeGreaterThan(0);
    expect(seen.samePrerelease).toBeGreaterThan(0);
  });

  it("U-SEMVER-032: 長い数字の識別子は桁数と辞書順で比べる (反例)", () => {
    expect(cmp("1.0.0-9007199254740992", "1.0.0-9007199254740993")).toBe(-1);
    expect(cmp("1.0.0-99999999999999999998", "1.0.0-99999999999999999999")).toBe(-1);
  });

  it("U-SEMVER-033: 長さ 256 と 257 の境界で同じ順になる", () => {
    for (const n of [250, 251]) {
      const lo = `1.0.0-${"a".repeat(n)}`;
      const hi = `1.0.0-${"b".repeat(n)}`;
      expect(() => comparePackageSemver(parse(lo), parse(hi))).not.toThrow();
      expect(cmp(lo, hi)).toBe(-1);
    }
    expect(`1.0.0-${"a".repeat(250)}`.length).toBe(256);
  });
});
