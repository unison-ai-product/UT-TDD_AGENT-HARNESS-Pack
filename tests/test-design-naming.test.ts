import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeTestDesignNaming,
  loadTestDesignDocs,
  testDesignNamingMessages,
} from "../src/lint/test-design-naming.ts";

describe("test-design right-arm naming lint (U-TDNAME, PLAN-RECOVERY-09)", () => {
  it("U-TDNAME-001: 右腕層命名 + executed_at_layer 一致は準拠", () => {
    const r = analyzeTestDesignNaming([
      { name: "L8-integration-test-design.md", executedAtLayer: "L8" },
      { name: "L14-operational-test-design.md", executedAtLayer: "L14" },
      { name: "README.md", executedAtLayer: null },
      { name: "proposal-document-coverage-routing.md", executedAtLayer: "L7-L14" },
    ]);
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(2); // 明示許可 2 件は対象外
  });

  it("U-TDNAME-002: 左腕層命名 (旧 L1/L3) は violation (fail-close)", () => {
    const r = analyzeTestDesignNaming([
      { name: "L1-operational-test-design.md", executedAtLayer: "L14" },
      { name: "L3-acceptance-test-design.md", executedAtLayer: "L12" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.violations).toHaveLength(2);
    expect(r.violations[0]).toContain("右腕層でない");
  });

  it("U-TDNAME-003: 標準外 filename / executed_at_layer 不一致は violation", () => {
    const r = analyzeTestDesignNaming([
      { name: "ux-notes.md", executedAtLayer: "L10" }, // 標準外命名
      { name: "L10-ux-validation-test-design.md", executedAtLayer: "L2" }, // 層不一致
      { name: "L9-system-test-design.md", executedAtLayer: null }, // 欠落
    ]);
    expect(r.ok).toBe(false);
    expect(r.violations).toHaveLength(3);
    expect(testDesignNamingMessages(r)[0]).toContain("violation");
  });

  it("U-TDNAME-004: 実 repo 回帰ガード — 全 test-design doc が右腕層命名に準拠", () => {
    const r = analyzeTestDesignNaming(loadTestDesignDocs(process.cwd()));
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checked).toBeGreaterThanOrEqual(6); // L7/L8/L9/L10/L12/L14
  });

  it("U-TDNAME-005: 大文字拡張子 (.MD) は検査対象に入り violation (case-bypass 穴を塞ぐ)", () => {
    const root = mkdtempSync(join(tmpdir(), "tdname-case-"));
    const dir = join(root, "docs", "test-design", "harness");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "L1-old.MD"), "---\nexecuted_at_layer: L14\n---\n");
    writeFileSync(join(dir, "L8-integration-test-design.md"), "---\nexecuted_at_layer: L8\n---\n");
    const r = analyzeTestDesignNaming(loadTestDesignDocs(root));
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.includes("L1-old.MD"))).toBe(true);
  });

  it("U-TDNAME-006: frontmatter の trailing comment / quote 付き値を正しく抽出 (crying-wolf 防止)", () => {
    const root = mkdtempSync(join(tmpdir(), "tdname-fm-"));
    const dir = join(root, "docs", "test-design", "harness");
    mkdirSync(dir, { recursive: true });
    // コメント付き値 + 本文に紛らわしい例示行があっても frontmatter を優先
    writeFileSync(
      join(dir, "L8-integration-test-design.md"),
      '---\nexecuted_at_layer: "L8"  # 実施層\n---\n\n例: executed_at_layer: L99 と書く\n',
    );
    const r = analyzeTestDesignNaming(loadTestDesignDocs(root));
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });
});
