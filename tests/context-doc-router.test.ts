import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildDocIndex,
  contextSuggest,
  loadDocIndex,
  ROUTABLE_DOCS,
  suggestSections,
} from "../src/context/doc-router";

const SYNTHETIC = [
  "# UT-TDD 構想",
  "intro line",
  "# §1 Why",
  "why body",
  "## 1.1 設計骨格",
  "design body a",
  "design body b",
  "### 1.1.1 V-model",
  "vmodel body",
  "## 1.2 補助軸",
  "aux body",
  "# §2 リファクタ原則",
  "refactor body",
].join("\n");

describe("doc-router buildDocIndex (PLAN-L7-302 doc-router 部分)", () => {
  it("実見出しから level / 節番号 / 行範囲を索引化する", () => {
    const idx = buildDocIndex("synthetic.md", SYNTHETIC);
    expect(idx.total_lines).toBe(13);
    const headings = idx.sections.map((s) => s.heading);
    expect(headings).toEqual([
      "UT-TDD 構想",
      "§1 Why",
      "1.1 設計骨格",
      "1.1.1 V-model",
      "1.2 補助軸",
      "§2 リファクタ原則",
    ]);
  });

  it("end_line は次の同/上位レベル見出しの直前になる (ネスト正しく閉じる)", () => {
    const idx = buildDocIndex("synthetic.md", SYNTHETIC);
    const byHeading = Object.fromEntries(idx.sections.map((s) => [s.heading, s]));
    // §1 Why (level 1, line 3) は §2 (line 12) の直前 = 11 まで
    expect(byHeading["§1 Why"].start_line).toBe(3);
    expect(byHeading["§1 Why"].end_line).toBe(11);
    // 1.1 設計骨格 (level 2, line 5) は 1.2 (line 10) の直前 = 9 まで
    expect(byHeading["1.1 設計骨格"].start_line).toBe(5);
    expect(byHeading["1.1 設計骨格"].end_line).toBe(9);
    // 1.1.1 V-model (level 3, line 8) は 1.2 (line 10) の直前 = 9 まで (親より先に上位が来る)
    expect(byHeading["1.1.1 V-model"].end_line).toBe(9);
    // §2 (最終見出し) は文末まで
    expect(byHeading["§2 リファクタ原則"].end_line).toBe(13);
  });

  it("節番号を見出し先頭から抽出する (§付き / ドット列 / 無番号)", () => {
    const idx = buildDocIndex("synthetic.md", SYNTHETIC);
    const num = Object.fromEntries(idx.sections.map((s) => [s.heading, s.section_number]));
    expect(num["§1 Why"]).toBe("1");
    expect(num["1.1.1 V-model"]).toBe("1.1.1");
    expect(num["UT-TDD 構想"]).toBeNull();
  });
});

describe("doc-router suggestSections", () => {
  const idx = buildDocIndex("synthetic.md", SYNTHETIC);

  it("kind=design はトピック語 (設計/V-model) を含む見出しを推挙する", () => {
    const r = suggestSections("design", [idx]);
    expect(r.fail_open).toBe(false);
    const headings = r.sections.map((s) => s.heading);
    expect(headings).toContain("1.1 設計骨格");
    expect(headings).toContain("1.1.1 V-model");
  });

  it("kind=unknown は fail-open (全文読み推奨、sections 空)", () => {
    const r = suggestSections("unknown", [idx]);
    expect(r.fail_open).toBe(true);
    expect(r.sections).toHaveLength(0);
    expect(r.fail_open_reason).toBeTruthy();
  });

  it("既知 kind でもトピック見出しが無ければ fail-open (読み漏れより安全側)", () => {
    const emptyIdx = buildDocIndex("x.md", "# 無関係\nbody\n");
    const r = suggestSections("design", [emptyIdx]);
    expect(r.fail_open).toBe(true);
    expect(r.sections).toHaveLength(0);
  });

  it("null 索引 (読込失敗 doc) は無視する", () => {
    const r = suggestSections("design", [null, idx]);
    expect(r.fail_open).toBe(false);
    expect(r.sections.length).toBeGreaterThan(0);
  });
});

describe("doc-router 実 canonical doc 統合", () => {
  it("ルーティング対象 doc が実在し索引化できる", () => {
    for (const p of ROUTABLE_DOCS) {
      expect(existsSync(p)).toBe(true);
      const idx = loadDocIndex(process.cwd(), p);
      expect(idx).not.toBeNull();
      expect(idx?.sections.length).toBeGreaterThan(0);
      // 索引が実見出しに追随: 各 section の行範囲は doc 内で妥当
      for (const s of idx?.sections ?? []) {
        expect(s.start_line).toBeGreaterThanOrEqual(1);
        expect(s.end_line).toBeGreaterThanOrEqual(s.start_line);
        expect(s.end_line).toBeLessThanOrEqual(idx?.total_lines ?? 0);
      }
    }
  });

  it("kind=reverse は実 doc から Reverse 系セクションを推挙する (非空・fail-open でない)", () => {
    const r = contextSuggest(process.cwd(), "reverse");
    expect(r.fail_open).toBe(false);
    expect(r.sections.length).toBeGreaterThan(0);
    // 推挙は canonical doc 由来
    for (const s of r.sections) {
      expect(ROUTABLE_DOCS).toContain(s.path as (typeof ROUTABLE_DOCS)[number]);
    }
  });
});
