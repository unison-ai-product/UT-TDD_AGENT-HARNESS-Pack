import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILTIN_GITHUB_TEMPLATES } from "../src/setup/templates";
import { MODEL_IDS } from "../src/team/model-policy";

// PLAN-L7-256: real-repo regression for model ID SSoT drift.
// loadTemplates prefers disk templates over built-ins, so both sources must stay aligned.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLAUDE_CATALOG = new Set<string>(Object.values(MODEL_IDS.claude));

describe("U-MODELID-SSOT: model ID single source of truth", () => {
  it("(a) .claude/agents frontmatter models are all in the MODEL_IDS catalog", () => {
    const dir = join(repoRoot, ".claude", "agents");
    if (!existsSync(dir)) {
      // Clean Pack artifacts intentionally omit source-local active Claude agents.
      expect(dir.includes(".claude")).toBe(true);
      return;
    }
    const offenders: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) continue;
      const text = readFileSync(join(dir, name), "utf8");
      const match = text.match(/^model:\s*(\S+)\s*$/m);
      if (!match) {
        offenders.push(`${name}: model frontmatter missing`);
        continue;
      }
      if (!CLAUDE_CATALOG.has(match[1])) {
        offenders.push(`${name}: ${match[1]} not in MODEL_IDS.claude`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("(b) docs/templates/adapter mirror matches BUILTIN_GITHUB_TEMPLATES", () => {
    const mismatches: string[] = [];
    for (const [name, content] of Object.entries(BUILTIN_GITHUB_TEMPLATES)) {
      if (!name.startsWith("adapter/")) continue;
      const diskPath = join(repoRoot, "docs", "templates", name);
      let disk: string;
      try {
        disk = readFileSync(diskPath, "utf8");
      } catch {
        mismatches.push(`${name}: mirror file missing`);
        continue;
      }
      if (disk.replaceAll("\r\n", "\n") !== content.replaceAll("\r\n", "\n")) {
        mismatches.push(`${name}: mirror content diverged from builtin`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("(c) generated agent templates carry only catalog model IDs", () => {
    const offenders: string[] = [];
    for (const [name, content] of Object.entries(BUILTIN_GITHUB_TEMPLATES)) {
      if (!name.startsWith("adapter/.claude/agents/")) continue;
      const match = content.match(/^model:\s*(\S+)\s*$/m);
      if (!match || !CLAUDE_CATALOG.has(match[1])) {
        offenders.push(`${name}: ${match?.[1] ?? "missing"}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
