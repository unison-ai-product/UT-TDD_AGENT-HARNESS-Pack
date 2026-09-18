/**
 * erasable-syntax lint — 全 `.ts` が Node type-stripping (strip-only) で実行可能であることを
 * 機械検証する gate (PLAN-L7-462 PR-B、AC-5 後半)。
 *
 * 契約: 対象 4 ディレクトリ (src/ tests/ scripts/ .claude/hooks/) の `.ts` は erasable syntax
 * のみで書く。parameter properties / enum / namespace 等の non-erasable 構文は fail-close
 * (vitest は esbuild 経由で transform するため strip-only 違反を検出できない — 独立 gate 必須)。
 *
 * oracle は node 本体の `node:module` `stripTypeScriptTypes(code, { mode: "strip" })`:
 * 実際に hooks を動かす runtime と同一の判定器であり、非公式の構文リスト再実装をしない。
 * bun には同 API が無いため、bun 実行時は node を **1 回だけ** spawn して全ファイルを
 * 一括判定する (逐次 spawn は 634 ファイルで分単位になるため禁止)。
 */
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const ERASABLE_SYNTAX_SCOPES = ["src", "tests", "scripts", ".claude/hooks"] as const;

export interface ErasableSyntaxViolation {
  path: string;
  message: string;
}

export interface ErasableSyntaxResult {
  checked: number;
  violations: ErasableSyntaxViolation[];
  ok: boolean;
}

function walk(root: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(join(root, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(root, rel)).isDirectory()) walk(root, rel, out);
    else if (rel.endsWith(".ts")) out.push(rel);
  }
}

export function listErasableSyntaxTargets(repoRoot: string): string[] {
  const all: string[] = [];
  for (const scope of ERASABLE_SYNTAX_SCOPES) {
    try {
      walk(repoRoot, scope, all);
    } catch {
      // scope が無い checkout (Pack 等) は対象不在として skip。
    }
  }
  return all;
}

/** node 側で全ファイルを strip 判定する one-shot スクリプト (stdin = path 一覧、stdout = JSON)。 */
const NODE_BATCH_SCRIPT = `
const { stripTypeScriptTypes } = require("node:module");
const { readFileSync } = require("node:fs");
const paths = readFileSync(0, "utf8").split("\\n").filter(Boolean);
const violations = [];
for (const p of paths) {
  try {
    stripTypeScriptTypes(readFileSync(p, "utf8"), { mode: "strip" });
  } catch (e) {
    violations.push({ path: p, message: String(e && e.message ? e.message : e).slice(0, 200) });
  }
}
process.stdout.write(JSON.stringify(violations));
`;

/**
 * 対象全ファイルを node strip-only で判定する。node を 1 回だけ spawn する
 * (bun / node どちらの host runtime でも同一 oracle に固定するため常に spawn)。
 */
export function analyzeErasableSyntax(repoRoot: string): ErasableSyntaxResult {
  const targets = listErasableSyntaxTargets(repoRoot);
  const proc = spawnSync("node", ["--no-warnings", "-e", NODE_BATCH_SCRIPT], {
    cwd: repoRoot,
    input: targets.join("\n"),
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (proc.status !== 0 || proc.error) {
    // oracle 自体が起動できないのは環境故障 — 静かに green にしない (fail-close)。
    return {
      checked: targets.length,
      violations: [
        {
          path: "(node spawn)",
          message: `strip-only oracle の node 起動に失敗: ${proc.error?.message ?? proc.stderr.slice(0, 200)}`,
        },
      ],
      ok: false,
    };
  }
  const violations = JSON.parse(proc.stdout) as ErasableSyntaxViolation[];
  return { checked: targets.length, violations, ok: violations.length === 0 };
}

export function renderErasableSyntaxMessages(r: ErasableSyntaxResult): string[] {
  if (r.ok) {
    return [`erasable-syntax — OK (checked=${r.checked}, node strip-only 違反 0)`];
  }
  const head = r.violations.slice(0, 10).map((v) => `${v.path} (${v.message})`);
  return [
    `erasable-syntax — violation ${r.violations.length} 件 (node strip-only で実行不能、PLAN-L7-462 PR-B): ${head.join("; ")}`,
  ];
}

/** doctor 配線用 (check-definition-groups から呼ぶ)。 */
export function checkErasableSyntax(repoRoot: string): { messages: string[]; ok: boolean } {
  const result = analyzeErasableSyntax(repoRoot);
  return { messages: renderErasableSyntaxMessages(result), ok: result.ok };
}
