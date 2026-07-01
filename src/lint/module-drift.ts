/**
 * module-drift lint — 「architecture §3.1 が列挙する building block 集合 ⊇ `src/` 実在 module」を機械検査 (IMP-075)。
 *
 * 背景: A-103 (L4 見直し) で handover/setup/web/lint 等が「実装済かつ設計 doc が将来扱い」の
 * back-fill 漏れ (= harness 自身が [[feedback_impl_must_backfill_to_design]] を L4 で破った) を
 * **手動監査**で発見した。この meta-drift を再発させないため、architecture §3.1 の module 一覧 (設計) と
 * `src/` 実在 top-level module を突合し、「実在するが設計 doc 未列挙」(= back-fill 漏れ) を doctor で surface する。
 *
 * 検査の向き: **actual ⊆ listed** (実在 module はすべて設計 doc に列挙されていること)。
 * - orphan = `src/` に実在するが §3.1 未列挙 → back-fill 漏れ (warn)。
 * - 逆向き (設計が列挙するが src 未実在 = web/roster/skills 等の将来 module) は drift ではない (宣言済 carry)。
 *
 * 位置づけ: ADR-002 / IMP-032 (import グラフ drift) と IMP-033 (asset-drift rule engine) の **最小スライス**。
 * 完全な依存グラフ照合 (knip/madge) や rule engine 化はそれらの後続 PLAN に委ね、本 lint は
 * 「module 集合の包含」のみを doctor 直結の純関数で担保する (backlog IMP-075 の「doctor で surface」)。
 *
 * 純関数 (analyzeModuleDrift) + I/O loader (loadModuleDocs) を分離 (lint 共通様式、architecture §3.2)。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** architecture §3.1 building block 表の見出し (対象セクションの開始マーカ、単一正本)。 */
const SECTION_START = /^#{2,}\s*§?3\.1\b/m;
/** 次セクション見出し (§3.1 の終端)。 */
const NEXT_HEADING = /^#{2,}\s/m;

export interface ModuleDocs {
  /** architecture §3.1 が列挙する building block 名 (小文字)。 */
  listed: string[];
  /** `src/` 実在の top-level module 名 (dir 名 + top-level `*.ts` の basename)。 */
  actual: string[];
}

export interface ModuleDriftResult {
  /** 実在するが §3.1 未列挙の module (back-fill 漏れ)。 */
  orphans: string[];
  listedCount: number;
  actualCount: number;
  ok: boolean;
}

/**
 * architecture.md 本文から §3.1 セクションを切り出し、表 1 列目の `**name**` building block 名を抽出する。
 * §3.2 以降 (代表 module の内部) の太字を巻き込まないよう、§3.1 見出し〜次見出しに限定する。
 */
export function parseListedModules(architectureText: string): string[] {
  // search は最初のマッチ位置のみ返す = §3.1.1 等が将来増えても最初の §3.1 見出しを起点にする (決定論)。
  const start = architectureText.search(SECTION_START);
  if (start < 0) return [];
  const rest = architectureText.slice(start);
  // 見出し行自身をスキップしてから次見出しを探す (自分の見出しで切らない)。
  const afterHeading = rest.replace(SECTION_START, "");
  const end = afterHeading.search(NEXT_HEADING);
  const section = end < 0 ? afterHeading : afterHeading.slice(0, end);
  // 表行の 1 列目 `| **name** ...` のみ対象 (行頭 `|` + 太字)。name は英小文字。
  const names = [...section.matchAll(/^\|\s*\*\*([a-z][a-z0-9_-]*)\*\*/gm)].map((m) => m[1]);
  return [...new Set(names)];
}

/** `src/` を scan し top-level module 名集合を構築 (dir 名 + top-level `*.ts` の basename)。 */
export function scanActualModules(srcDir: string): string[] {
  const entries = readdirSync(srcDir, { withFileTypes: true });
  const names = entries
    .filter((e) => e.isDirectory() || (e.isFile() && e.name.endsWith(".ts")))
    .map((e) => (e.isDirectory() ? e.name : e.name.replace(/\.ts$/, "")));
  return [...new Set(names)].sort();
}

/** 設計列挙 (architecture §3.1) と実在 (`src/`) を読み込む。 */
export function loadModuleDocs(repoRoot: string): ModuleDocs {
  const architectureText = readFileSync(
    join(repoRoot, "docs", "design", "harness", "L4-basic-design", "architecture.md"),
    "utf8",
  );
  return {
    listed: parseListedModules(architectureText),
    actual: scanActualModules(join(repoRoot, "src")),
  };
}

/**
 * actual ⊆ listed を検査。実在するが未列挙の module を orphan として返す。
 * orphan 0 → ok。空虚 (listed 0 = パース失敗) は ok にせず明示 (totals で検出可能)。
 */
export function analyzeModuleDrift(docs: ModuleDocs): ModuleDriftResult {
  const listedSet = new Set(docs.listed);
  const orphans = docs.actual.filter((m) => !listedSet.has(m)).sort();
  return {
    orphans,
    listedCount: docs.listed.length,
    actualCount: docs.actual.length,
    ok: orphans.length === 0,
  };
}

/** doctor 用 message 整形 (fail-close)。 */
export function moduleDriftMessages(r: ModuleDriftResult): string[] {
  if (r.orphans.length > 0) {
    return [
      `module-drift — ⚠ ${r.orphans.length} 件: src/ 実在だが architecture §3.1 未列挙 (${r.orphans.join(", ")})。` +
        `設計 doc へ back-fill (impl→design)。[[feedback_impl_must_backfill_to_design]]`,
    ];
  }
  return [
    `module-drift — OK (src/ 実在 ${r.actualCount} module すべて architecture §3.1 に列挙、孤児 0)`,
  ];
}
