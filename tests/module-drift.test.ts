/**
 * module-drift lint test (IMP-075、PLAN-L7-16)。
 * architecture §3.1 設計 module 集合 ⊇ src/ 実在 module の包含検査 (impl→design back-fill 漏れ surface)。
 * L7-unit-test-design §1.16 U-MDRIFT-001〜005 を被覆 + 実 repo 完全性ガード (孤児0)。
 */
import { describe, expect, it } from "vitest";
import {
  analyzeModuleDrift,
  loadModuleDocs,
  type ModuleDocs,
  moduleDriftMessages,
  parseListedModules,
  scanActualModules,
} from "../src/lint/module-drift";

const docs = (listed: string[], actual: string[]): ModuleDocs => ({ listed, actual });

describe("module-drift lint (U-MDRIFT)", () => {
  // U-MDRIFT-001: parseListedModules は §3.1 表 1 列目の **name** のみ抽出、§3.2 以降を含まない。
  it("U-MDRIFT-001: §3.1 表の building block 名を抽出し、次セクションは含まない", () => {
    const text = [
      "## §3 building block view",
      "### §3.1 Level 1 — サブシステム",
      "| building block | 責務 |",
      "|---|---|",
      "| **cli** (`src/cli.ts`) | ディスパッチ |",
      "| **schema** (`src/schema/`) | 単一正本 |",
      "| **web** (`src/web/`) | Phase B |",
      "| **roster** (将来 `src/roster/`) | 将来 |",
      "> **依存方向**: schema へ一方向。",
      "### §3.2 Level 2 — 代表 module の内部",
      "- **schema**: index.ts ...", // §3.2 の太字は拾わない
    ].join("\n");
    expect(parseListedModules(text)).toEqual(["cli", "schema", "web", "roster"]);
  });

  // U-MDRIFT-002: §3.1 見出し不在 → 空配列 (パース失敗を空虚 ok にしない)。
  it("U-MDRIFT-002: §3.1 セクション不在なら空配列", () => {
    expect(parseListedModules("# no such section\n本文のみ")).toEqual([]);
  });

  // U-MDRIFT-003: analyzeModuleDrift は actual ⊆ listed を検査、未列挙を orphan に。
  it("U-MDRIFT-003: 実在するが未列挙の module を orphan として返す", () => {
    const r = analyzeModuleDrift(docs(["cli", "schema", "web"], ["cli", "schema", "handover"]));
    expect(r.orphans).toEqual(["handover"]);
    expect(r.ok).toBe(false);
    expect(r.actualCount).toBe(3);
    expect(r.listedCount).toBe(3);
  });

  // U-MDRIFT-004: actual ⊆ listed (将来 module が listed に余分にあっても drift でない) → ok。
  it("U-MDRIFT-004: 設計が将来 module を余分に列挙 (src 未実在) は drift でない", () => {
    const r = analyzeModuleDrift(
      docs(["cli", "schema", "web", "roster", "skills"], ["cli", "schema"]),
    );
    expect(r.orphans).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("moduleDriftMessages: orphan あり→warn / なし→OK", () => {
    expect(moduleDriftMessages(analyzeModuleDrift(docs(["cli"], ["cli", "x"])))[0]).toMatch(/⚠/);
    expect(moduleDriftMessages(analyzeModuleDrift(docs(["cli"], ["cli"])))[0]).toMatch(/OK/);
  });

  // U-MDRIFT-005: 実 repo 完全性ガード — 実在 src/ module はすべて architecture §3.1 に列挙 (孤児0)。
  // back-fill 漏れ (handover/setup/web を「将来」のまま放置する meta-drift) を CI で fail-close に近づける回帰網。
  it("U-MDRIFT-005: 実 repo は孤児0 (src/ 実在 ⊆ architecture §3.1)", () => {
    const r = analyzeModuleDrift(loadModuleDocs(process.cwd()));
    expect(r.orphans).toEqual([]);
    expect(r.actualCount).toBeGreaterThan(0);
    expect(r.listedCount).toBeGreaterThanOrEqual(r.actualCount);
  });

  it("scanActualModules: dir 名 + top-level *.ts basename を返す (実 repo に cli を含む)", () => {
    const actual = scanActualModules(`${process.cwd()}/src`);
    expect(actual).toContain("cli");
    expect(actual).toContain("doctor");
    expect(actual).toContain("lint");
  });
});
