/**
 * lint-wiring meta-gate — 「すべての `src/lint/*.ts` ルールモジュールは runtime 実行経路から
 * 到達可能であること」を機械検査 (IMP-006 = lint-coverage-map の fail-close 実装)。
 *
 * 背景: ルールモジュールがテストだけ green で **どの実行経路からも import されない** =
 * 「定義済みだが実行されない死蔵ルール」になる absence-blindness が、機械チェックを素通りしていた
 * (doc は「自動検証する」と現在形で書くのに実体は inert)。本 gate は「ルールが実際に配線されているか」
 * という、既存ゲート群が構造的に見ていなかった一段メタな不変条件を fail-close で担保する。
 *
 * 検査の向き: **すべての lint module は (a) RUNTIME_ENTRYPOINTS から推移的に到達可能、または
 * (b) DEFERRED_LINTS に理由付きで登録済み、のいずれか**。どちらでもない module は violation。
 * 加えて DEFERRED に登録されているのに実は到達可能な module (= stale 申告) も violation
 * (errata が片肺化しないよう plan-supersession と同型の双方向健全性)。
 *
 * 到達性: `ut-tdd` CLI (`src/cli.ts`) が唯一の実行ルート。CLI が import する doctor / plan-lint /
 * handover / status / db / 各 lint へ推移的に展開した集合が「live なコード」。テスト
 * (`tests/*.test.ts`) は実行経路ではないので到達性の根拠にしない。
 *
 * 純関数 (analyzeLintWiring) + I/O loader (loadLintWiringInput: src 走査 + import グラフ BFS) を分離
 * (lint 共通様式、architecture §3.2)。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = process.cwd();

/** 実行ルート (src-relative)。ここから到達不能な lint module は「未配線」。 */
export const RUNTIME_ENTRYPOINTS = ["src/cli.ts"] as const;

/**
 * 故意に未配線の lint module の allowlist (理由必須)。
 * 純関数ライブラリ / 統合待ちなど「inert だが意図的」なものを honest に明示する。
 */
export const DEFERRED_LINTS: Record<string, string> = {
  "tool-adapter":
    "adapter-probe 純関数ライブラリ (catalog/probe/normalize/planDiagramRefresh)。`ut-tdd adapter` 統合は IMP-033 rule-engine / PLAN-L7-50 R8 で deferred (closed-as-library)。",
};

export interface LintWiringInput {
  /** `src/lint/` 直下の lint module basename (拡張子・`*.test` 除外、昇順)。 */
  lintModules: string[];
  /** RUNTIME_ENTRYPOINTS から推移的に到達する src-relative file 集合。 */
  reachable: Set<string>;
}

export interface LintWiringResult {
  wired: string[];
  deferred: string[];
  /** 到達不能かつ DEFERRED 未登録 = 死蔵ルール (violation)。 */
  unwired: string[];
  /** DEFERRED 登録済みだが実は到達可能 = stale 申告 (violation)。 */
  staleDeferred: string[];
  ok: boolean;
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/** ディレクトリを再帰走査して src-relative な `*.ts` パスを集める。 */
function collectSrcTs(absDir: string, repoRoot: string, acc: string[]): void {
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const abs = join(absDir, entry.name);
    if (entry.isDirectory()) {
      collectSrcTs(abs, repoRoot, acc);
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      acc.push(toPosix(relative(repoRoot, abs)));
    }
  }
}

/** 相対 import spec を src-relative file path へ解決 (.ts / index.ts / 拡張子付きを順に試す)。 */
function resolveSpec(fromFileAbs: string, spec: string, repoRoot: string): string | null {
  if (!spec.startsWith(".")) return null; // bare / node: import は到達グラフ対象外
  const baseAbs = resolve(dirname(fromFileAbs), spec);
  for (const cand of [`${baseAbs}.ts`, join(baseAbs, "index.ts"), baseAbs]) {
    if (existsSync(cand) && statSync(cand).isFile()) {
      const rel = toPosix(relative(repoRoot, cand));
      return rel.startsWith("src/") ? rel : null;
    }
  }
  return null;
}

const IMPORT_SPEC = /(?:\bfrom\b|\bimport\b|\brequire\b)\s*\(?\s*["']([^"']+)["']/g;

/**
 * 行 `//` + ブロック `/* ... *​/` コメントを除去する。
 * コメントアウトされた import (`// import { x } from "../lint/dead"`) を偽の到達 edge として
 * 数えると、死蔵 module を「wired」と誤判定して meta-gate の意味が消える (reviewer 指摘)。
 * 抽出専用の前処理なので、文字列内 URL の `//` 等を潰しても害はない (import 検出のみに使う)。
 */
export function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** src ファイル本文から import/require spec 文字列を抽出 (コメント除去後)。 */
export function extractImportSpecs(content: string): string[] {
  const specs: string[] = [];
  for (const m of stripComments(content).matchAll(IMPORT_SPEC)) specs.push(m[1]);
  return specs;
}

/** src を走査し import グラフを構築、RUNTIME_ENTRYPOINTS から BFS して到達集合を返す。 */
export function loadLintWiringInput(repoRoot: string = ROOT): LintWiringInput {
  const srcDir = join(repoRoot, "src");
  const srcFiles: string[] = [];
  collectSrcTs(srcDir, repoRoot, srcFiles);

  const graph = new Map<string, string[]>();
  for (const rel of srcFiles) {
    const abs = join(repoRoot, rel);
    const content = readFileSync(abs, "utf8");
    const edges: string[] = [];
    for (const spec of extractImportSpecs(content)) {
      const target = resolveSpec(abs, spec, repoRoot);
      if (target) edges.push(target);
    }
    graph.set(rel, edges);
  }

  const reachable = new Set<string>();
  const queue: string[] = RUNTIME_ENTRYPOINTS.filter((e) => graph.has(e));
  while (queue.length > 0) {
    const f = queue.pop() as string;
    if (reachable.has(f)) continue;
    reachable.add(f);
    for (const next of graph.get(f) ?? []) {
      if (!reachable.has(next)) queue.push(next);
    }
  }

  const lintDir = join(srcDir, "lint");
  const lintModules = readdirSync(lintDir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => f.replace(/\.ts$/, ""))
    .sort();

  return { lintModules, reachable };
}

export function analyzeLintWiring(input: LintWiringInput): LintWiringResult {
  const wired: string[] = [];
  const deferred: string[] = [];
  const unwired: string[] = [];
  const staleDeferred: string[] = [];

  for (const m of input.lintModules) {
    const reachable = input.reachable.has(`src/lint/${m}.ts`);
    const isDeferred = Object.hasOwn(DEFERRED_LINTS, m);
    if (reachable) {
      wired.push(m);
      if (isDeferred) staleDeferred.push(m);
    } else if (isDeferred) {
      deferred.push(m);
    } else {
      unwired.push(m);
    }
  }

  return {
    wired,
    deferred,
    unwired,
    staleDeferred,
    ok: unwired.length === 0 && staleDeferred.length === 0,
  };
}

export function lintWiringOk(result: LintWiringResult): boolean {
  return result.ok;
}

export function lintWiringMessages(result: LintWiringResult): string[] {
  if (result.ok) {
    const deferredLabel = result.deferred.length > 0 ? result.deferred.join(", ") : "none";
    return [
      `lint-wiring — OK (wired=${result.wired.length}, deferred=${result.deferred.length} [${deferredLabel}], 死蔵 0)`,
    ];
  }
  const parts: string[] = [];
  if (result.unwired.length > 0) {
    parts.push(`未配線 (死蔵ルール)=${result.unwired.length}: ${result.unwired.join(", ")}`);
  }
  if (result.staleDeferred.length > 0) {
    parts.push(
      `stale-deferred (到達可能なのに DEFERRED 申告)=${result.staleDeferred.length}: ${result.staleDeferred.join(", ")}`,
    );
  }
  return [
    `lint-wiring — violation: ${parts.join("; ")}。各 src/lint/<name>.ts は runtime 経路 (cli→doctor/plan-lint 等) から到達するよう配線するか、DEFERRED_LINTS に理由付きで登録せよ (IMP-006)`,
  ];
}
