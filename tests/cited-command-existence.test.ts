/**
 * PLAN-L7-238: process doc 記載コマンドの実在保証 (A-173 F-2 の再発防止)。
 *
 * Oracle: docs/process/ の本文が backtick で正規手順として引用する `ut-tdd <sub>` の
 * 第 1 トークン (subcommand) は、src/cli.ts に登録された top-level command 名に
 * 実在しなければならない。存在しないコマンドを必須手順として記載すると実行者を
 * 確実にブロックする (実例: retrofit.md の `ut-tdd doctor --preflight upgrade`)。
 *
 * 擬似例の書式規約 (DoD):
 *   - subcommand 位置がプレースホルダや記号を含む token (`<...>`、`*` 等) は検査対象外。
 *   - 未実装コマンドを意図的に引用する行は「実装予定」または「未実装」を同一行に明記する
 *     (marker のある行は検査対象外)。
 *   - 検査対象は運用手順の正本 docs/process/ のみ (concept/requirements は将来面を規定する
 *     仕様書であり、未実装 surface の引用が正当なため対象外)。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function cliCommandTokens(repoRoot: string): Set<string> {
  const cli = readFileSync(join(repoRoot, "src", "cli.ts"), "utf8");
  const tokens = new Set<string>();
  // top-level のみ抽出する (codex レビュー所見: nested subcommand を混ぜると
  // `ut-tdd preflight` のような不正 top-level 引用が素通りし oracle が弱る)。
  for (const m of cli.matchAll(/program\s*[\r\n]*\s*\.command\("([a-z0-9-]+)/g)) {
    tokens.add(m[1]);
  }
  for (const m of cli.matchAll(/runtimeCommand\("([a-z0-9-]+)"\)/g)) tokens.add(m[1]);
  return tokens;
}

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...markdownFiles(path));
    else if (name.endsWith(".md")) out.push(path);
  }
  return out;
}

describe("PLAN-L7-238: cited ut-tdd commands exist in the CLI surface", () => {
  it("docs/process cites only real top-level subcommands (or marks planned ones)", () => {
    const repoRoot = process.cwd();
    const commands = cliCommandTokens(repoRoot);
    expect(commands.has("doctor")).toBe(true); // 抽出の自己検証 (空集合で全 pass を防ぐ)
    expect(commands.has("codex")).toBe(true); // runtimeCommand 経由の登録も抽出できている
    expect(commands.has("guard")).toBe(true); // 親 command は top-level として実在
    expect(commands.has("preflight")).toBe(false); // nested subcommand は top-level 扱いしない

    const violations: string[] = [];
    for (const file of markdownFiles(join(repoRoot, "docs", "process"))) {
      const content = readFileSync(file, "utf8");
      for (const line of content.split(/\r?\n/)) {
        if (line.includes("実装予定") || line.includes("未実装")) continue;
        for (const m of line.matchAll(/`ut-tdd\s+([^`]+)`/g)) {
          const first = m[1].trim().split(/\s+/)[0] ?? "";
          if (!/^[a-z0-9-]+$/.test(first)) continue;
          if (!commands.has(first)) {
            violations.push(`${file.slice(repoRoot.length + 1)}: ut-tdd ${first}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
