/**
 * 実装→設計文書トレーサビリティ検査 (IMP-088、PLAN-REVERSE-40 塊A)。
 *
 * src module の所有が設計 doc で名指しされ、src 直下の単体ファイルが path で参照されることを検証する。
 * FR-L1-18 (横断検出・接続欠損) の descent。
 *
 * module 単位の設計所有と設計 path 参照のどちらでもない src を orphan として fail-close する。
 * baseline は縮小のみ可。本契約では既存 5 件が名指し済み module に属するため空集合とする。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { normalizePath } from "./shared.ts";

/** module 単位の設計所有で解消した旧 known-debt。 */
export const IMPL_PLAN_TRACE_BASELINE: ReadonlySet<string> = new Set();

export interface ImplPlanTraceInput {
  /** repo-relative src/**.ts (normalized `/`)。 */
  srcFiles: string[];
  /** 設計 doc で名指しされた module に属する src と、設計 doc に完全一致で現れた path の集合。 */
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

function listMarkdownFiles(dir: string, acc: string[]): void {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) {
      listMarkdownFiles(full, acc);
    } else if (e.endsWith(".md")) {
      acc.push(full);
    }
  }
}

function addDesignTrace(file: string, tracedPaths: Set<string>, namedModules: Set<string>): void {
  const content = readFileSync(file, "utf8");
  for (const m of content.matchAll(/src\/[A-Za-z0-9_./-]+\.ts/g)) {
    if (/^src\/[^/]+\.ts$/.test(m[0])) tracedPaths.add(m[0]);
  }
  for (const m of content.matchAll(/(^|[^A-Za-z0-9_./-])src\/([A-Za-z0-9_-]+)\//g)) {
    namedModules.add(m[2]);
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
  const namedModules = new Set<string>();
  try {
    const designFiles: string[] = [];
    listMarkdownFiles(join(repoRoot, "docs", "design"), designFiles);
    for (const file of designFiles) addDesignTrace(file, tracedPaths, namedModules);
  } catch {
    // design 不在は空集合 (fail-open)
  }
  for (const srcFile of srcFiles) {
    const module = srcFile.match(/^src\/([^/]+)\//)?.[1];
    if (module && namedModules.has(module)) tracedPaths.add(srcFile);
  }
  return { srcFiles, tracedPaths, baseline: IMPL_PLAN_TRACE_BASELINE };
}

export function implPlanTraceMessages(r: ImplPlanTraceResult): string[] {
  // メッセージ形式は既存の G7 公開出力契約を維持する。入力と所有判定は設計文書だけを使う。
  if (r.orphans.length === 0) {
    return ["impl-plan-trace — OK (src 全件 PLAN generates / baseline に被覆、NEW orphan 0)"];
  }
  return [
    `impl-plan-trace — ⚠ PLAN / design source trace 無き src ${r.orphans.length} 件 (trace/baseline 不在): ${r.orphans.join(", ")}`,
  ];
}
