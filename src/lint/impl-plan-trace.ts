/**
 * impl→PLAN トレーサビリティ検査 (IMP-088、PLAN-REVERSE-40 塊A)。
 *
 * src module / 公開 CLI / lint / doctor check が、いずれかの PLAN の generates (または本文参照) に
 * 紐づくことを検証する。module-drift (src⇔architecture §3.1) / pair-freeze (design⇔test-design) は
 * いずれも PLAN を見ないため、「設計 doc に名前が載れば PLAN 無しでも通る」穴 (A-108 orphan の根因)
 * を塞ぐ。FR-L1-18 (横断検出・接続欠損) の descent。
 *
 * baseline = A-108 検出前から存在し未 trace だった既存 lint 8 件 (known-debt)。NEW orphan のみ
 * fail-close する段階導入 (ddd-tdd-rules の baseline debt と同型)。IMP-087 の 4 orphan は baseline
 * でなく PLAN-REVERSE-40 generates への back-fill で trace 解消する (baseline には含めない)。
 * 根拠 = 2026-06-10 実測 (`find src -name '*.ts'` vs PLAN generates) で 12 孤児 (= 4 + 8)。
 * baseline は縮小のみ可 (新規追加で穴を広げない)。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { normalizePath } from "./shared";

/** A-108 以前からの既存 untraced lint (known-debt)。段階 back-fill で縮小する。 */
export const IMPL_PLAN_TRACE_BASELINE: ReadonlySet<string> = new Set([
  "src/lint/asset-drift.ts",
  "src/lint/change-impact.ts",
  "src/lint/doc-consistency.ts",
  "src/lint/entity-coverage.ts",
  "src/lint/g3-trace.ts",
  "src/lint/improvement-backlog.ts",
  "src/lint/readability.ts",
  "src/lint/shared.ts",
]);

export interface ImplPlanTraceInput {
  /** repo-relative src/**.ts (normalized `/`)。 */
  srcFiles: string[];
  /** いずれかの PLAN の generates / 本文に出現した src パス集合。 */
  tracedPaths: Set<string>;
  /** known-debt allowlist。 */
  baseline: ReadonlySet<string>;
}

export interface ImplPlanTraceResult {
  orphans: string[];
  ok: boolean;
}

/** traced でも baseline でもない src を orphan として返す (NEW orphan で ok=false)。 */
export function analyzeImplPlanTrace(input: ImplPlanTraceInput): ImplPlanTraceResult {
  const orphans = input.srcFiles
    .filter((f) => !input.tracedPaths.has(f) && !input.baseline.has(f))
    .sort();
  return { orphans, ok: orphans.length === 0 };
}

function listSrcTs(dir: string, repoRoot: string, acc: string[]): void {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) {
      listSrcTs(full, repoRoot, acc);
    } else if (e.endsWith(".ts")) {
      acc.push(normalizePath(full.slice(repoRoot.length + 1)));
    }
  }
}

export function loadImplPlanTraceInput(repoRoot: string): ImplPlanTraceInput {
  const srcFiles: string[] = [];
  try {
    listSrcTs(join(repoRoot, "src"), repoRoot, srcFiles);
  } catch {
    // src 不在は空集合 (fail-open、doctor 堅牢性)
  }
  const tracedPaths = new Set<string>();
  try {
    const plansDir = join(repoRoot, "docs", "plans");
    for (const f of readdirSync(plansDir).filter((x) => x.endsWith(".md"))) {
      const content = readFileSync(join(plansDir, f), "utf8");
      // 注 (review Minor): PLAN generates の artifact_path は `/` 区切り統一 (repository-structure.md
      // 規約)。`\` 区切りの Windows パス記法は対象外 (docs は LF/`/` 統一、.gitattributes)。
      for (const m of content.matchAll(/src\/[A-Za-z0-9_./-]+\.ts/g)) {
        tracedPaths.add(m[0]);
      }
    }
  } catch {
    // plans 不在は空集合 (fail-open)
  }
  return { srcFiles, tracedPaths, baseline: IMPL_PLAN_TRACE_BASELINE };
}

export function implPlanTraceMessages(r: ImplPlanTraceResult): string[] {
  if (r.orphans.length === 0) {
    return ["impl-plan-trace — OK (src 全件 PLAN generates / baseline に被覆、NEW orphan 0)"];
  }
  return [
    `impl-plan-trace — ⚠ PLAN 無き src ${r.orphans.length} 件 (generates/baseline 不在): ${r.orphans.join(", ")}`,
  ];
}
