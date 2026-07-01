// screen-impl-pair-freeze gate: 画面実装宣言 (implemented_screens) が検証ペア (next_pair_freeze) の
// 段階順を破っていないか fail-close で検査する。純関数 (analyze) + loader (fs fixture) + 実 repo 整合。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  analyzeScreenImplPairFreeze,
  loadScreenImplPairFreezeInput,
  type ScreenImplPairFreezeInput,
  screenImplPairFreezeMessages,
} from "../src/lint/screen-impl-pair-freeze";

describe("screen-impl-pair-freeze", () => {
  it("passes while screen implementation has not been declared", () => {
    const r = analyzeScreenImplPairFreeze({
      screenDesignPresent: true,
      nextPairFreeze: "L10",
      implementedScreens: [],
      pairFreezeReached: false,
    });

    expect(r.ok).toBe(true);
    expect(r.checked).toBe(0);
  });

  it("fails when implemented screens are declared before the next pair freeze", () => {
    const r = analyzeScreenImplPairFreeze({
      screenDesignPresent: true,
      nextPairFreeze: "L10",
      implementedScreens: ["PM-01", "HM-01"],
      pairFreezeReached: false,
    });

    expect(r.ok).toBe(false);
    expect(r.violations).toEqual(["PM-01", "HM-01"]);
  });

  it("passes once the next pair freeze has been reached", () => {
    const r = analyzeScreenImplPairFreeze({
      screenDesignPresent: true,
      nextPairFreeze: "L10",
      implementedScreens: ["PM-01"],
      pairFreezeReached: true,
    });

    expect(r.ok).toBe(true);
    expect(r.checked).toBe(1);
  });
});

const base = (over: Partial<ScreenImplPairFreezeInput> = {}): ScreenImplPairFreezeInput => ({
  screenDesignPresent: true,
  nextPairFreeze: "L10",
  implementedScreens: [],
  pairFreezeReached: false,
  ...over,
});

describe("analyzeScreenImplPairFreeze 追加ケース U-SIPF-001..002", () => {
  it("U-SIPF-001: screen 設計不在 = scope 0 OK", () => {
    const r = analyzeScreenImplPairFreeze(base({ screenDesignPresent: false }));
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(0);
  });

  it("U-SIPF-002: next_pair_freeze 未宣言 = 段階義務なしで OK (誤検出しない)", () => {
    const r = analyzeScreenImplPairFreeze(
      base({ implementedScreens: ["PM-01"], nextPairFreeze: null }),
    );
    expect(r.ok).toBe(true);
  });
});

describe("screenImplPairFreezeMessages U-SIPF-003..004", () => {
  it("U-SIPF-003: violation メッセージは mock 段階と対象 ID を述べる (LL10 重複なし)", () => {
    const r = analyzeScreenImplPairFreeze(base({ implementedScreens: ["PM-01"] }));
    const msg = screenImplPairFreezeMessages(r).join("\n");
    expect(msg).toContain("violation");
    expect(msg).toContain("mock");
    expect(msg).toContain("PM-01");
    expect(msg).not.toContain("LL10");
  });

  it("U-SIPF-004: OK (実装宣言なし) は mock 段階である旨を述べる", () => {
    const msg = screenImplPairFreezeMessages(analyzeScreenImplPairFreeze(base())).join("\n");
    expect(msg).toContain("OK");
    expect(msg).toContain("mock");
  });
});

describe("loadScreenImplPairFreezeInput (fs fixture) U-SIPF-005..007", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sipf-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeScreenList(fm: string): void {
    const dir = join(root, "docs", "design", "harness", "L2-screen");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "screen-list.md"), `---\n${fm}\n---\n# L2 画面一覧\n`);
  }

  it("U-SIPF-005: next_pair_freeze 未到達 + implemented あり → loader が violation 入力を返す", () => {
    writeScreenList('next_pair_freeze: L10\nimplemented_screens: "PM-01 PM-02"');
    const input = loadScreenImplPairFreezeInput(root);
    expect(input.screenDesignPresent).toBe(true);
    expect(input.nextPairFreeze).toBe("L10");
    expect(input.implementedScreens).toEqual(["PM-01", "PM-02"]);
    expect(input.pairFreezeReached).toBe(false);
    expect(analyzeScreenImplPairFreeze(input).ok).toBe(false);
  });

  it("U-SIPF-006: next_pair_freeze 段階に confirmed 設計 dir が実在 → 到達済で許容", () => {
    writeScreenList('next_pair_freeze: L4\nimplemented_screens: "PM-01"');
    const l4 = join(root, "docs", "design", "harness", "L4-basic");
    mkdirSync(l4, { recursive: true });
    writeFileSync(join(l4, "basic.md"), "---\nstatus: confirmed\n---\n# L4\n");
    const input = loadScreenImplPairFreezeInput(root);
    expect(input.pairFreezeReached).toBe(true);
    expect(analyzeScreenImplPairFreeze(input).ok).toBe(true);
  });

  it("U-SIPF-007: screen-list 不在 = scope 0", () => {
    const input = loadScreenImplPairFreezeInput(root);
    expect(input.screenDesignPresent).toBe(false);
    expect(analyzeScreenImplPairFreeze(input).ok).toBe(true);
  });
});

describe("実 repo 整合 U-SIPF-008", () => {
  it("U-SIPF-008: 実 repo は L10 未到達ゆえ implemented_screens が空のときのみ green (substance)", () => {
    const input = loadScreenImplPairFreezeInput(process.cwd());
    // 実 repo の screen 設計は L10 を next_pair_freeze に宣言し、L10 はまだ存在しない。
    expect(input.screenDesignPresent).toBe(true);
    expect(input.nextPairFreeze).toBe("L10");
    expect(input.pairFreezeReached).toBe(false);
    // 不変条件: L10 未到達の間は「実装宣言ゼロ ⇔ gate green」。premature flip があれば red。
    const r = analyzeScreenImplPairFreeze(input);
    expect(r.ok).toBe(input.implementedScreens.length === 0);
  });
});
