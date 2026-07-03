/**
 * PLAN-L7-238: process docs が引用する `ut-tdd <sub>` の top-level command 実在性を検査する。
 *
 * Oracle:
 * - docs/process/ の本文で backtick 引用された `ut-tdd <sub>` の第 1 token は、
 *   CLI 登録済み top-level command 名でなければならない。
 * - まだ実装しない command は同じ行で「実装予定」または「未実装」と明示する。
 * - `<...>` や `*` などの placeholder token は検査対象外にする。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function cliCommandTokens(repoRoot: string): Set<string> {
  const sources = [
    readFileSync(join(repoRoot, "src", "cli.ts"), "utf8"),
    readFileSync(join(repoRoot, "src", "cli", "delegation.ts"), "utf8"),
  ];
  const tokens = new Set<string>();
  // top-level のみ抽出する。nested subcommand を混ぜると `ut-tdd preflight` のような
  // 不正な top-level 引用を見逃す。
  for (const cli of sources) {
    for (const m of cli.matchAll(/program\s*[\r\n]*\s*\.command\("([a-z0-9-]+)/g)) {
      tokens.add(m[1]);
    }
    for (const m of cli.matchAll(/runtimeCommand\([^,]+,\s*"([a-z0-9-]+)"/g)) {
      tokens.add(m[1]);
    }
  }
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
    expect(commands.has("doctor")).toBe(true);
    expect(commands.has("codex")).toBe(true);
    expect(commands.has("guard")).toBe(true);
    expect(commands.has("preflight")).toBe(false);

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
