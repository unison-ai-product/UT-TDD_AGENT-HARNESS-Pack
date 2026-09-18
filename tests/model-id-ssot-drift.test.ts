import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findStaleModelIdLiterals } from "../src/lint/model-id-doc-drift.ts";
import { normalizeModelFamily } from "../src/runtime/agent-guard.ts";
import {
  CLAUDE_MODEL_FAMILY_CATALOG,
  SUBAGENT_ALLOWLIST,
} from "../src/runtime/agent-guard-policy.ts";
import { BUILTIN_GITHUB_TEMPLATES } from "../src/setup/templates.ts";
import { MODEL_IDS } from "../src/team/model-policy.ts";

// PLAN-L7-256: real-repo regression for model ID SSoT drift.
// loadTemplates prefers disk templates over built-ins, so both sources must stay aligned.
//
// Execution path (PLAN-L7-421 test-hygiene-live-tree-fence): every test file in this repo
// runs under `tests/global-setup.ts`, which fail-closes unless UT_TDD_TEST_EXECUTION_ROOT /
// UT_TDD_TEST_FENCE_ROOT / UT_TDD_HEAD_SNAPSHOT_ROOT are set. There is no per-file opt-out.
// - Canonical (post-commit, whole suite validates the committed HEAD tree):
//     bun run test -- tests/model-id-ssot-drift.test.ts
//   (scripts/run-vitest-snapshot.ts clones the current git HEAD commit; it does NOT see
//   uncommitted working-tree changes — this is the documented "HEAD-clone footgun".)
// - Local pre-commit verification against the live working tree (bash / git-bash only).
//   `./support/workspace-roots.ts` rejects UT_TDD_HEAD_SNAPSHOT_ROOT === process.cwd()
//   by design (it must be an independent detached read root, not the live execution root),
//   so a single shared root for all three env vars is NOT a valid bypass — it only appeared
//   to pass in some shells because of a POSIX-vs-Windows path string mismatch, not because
//   the roots were genuinely distinct. Use a real second directory (only `.claude/` and
//   `docs/` are read via this test file's `repoRoot`):
//     DEST="$(mktemp -d)" && mkdir -p "$DEST/.claude" "$DEST/docs" \
//       && cp -r .claude/. "$DEST/.claude/" && cp -r docs/. "$DEST/docs/" \
//       && UT_TDD_TEST_EXECUTION_ROOT="$(pwd)" UT_TDD_TEST_FENCE_ROOT="$(pwd)" \
//          UT_TDD_HEAD_SNAPSHOT_ROOT="$DEST" \
//          bunx vitest run tests/model-id-ssot-drift.test.ts
import { headSnapshotRoot } from "./support/workspace-roots.ts";

const repoRoot = headSnapshotRoot();
const CLAUDE_CATALOG = new Set<string>(Object.values(MODEL_IDS.claude));
// PLAN-RECOVERY-12 (issue #85): これらは L6 function-spec.md の model routing addendum に
// 実際に残留していた stale literal (gpt-5.5 / claude-sonnet-4-6 / gpt-5.4)。現行 doc からは
// 是正済みだが、負例 regression 用の fixture corpus として保持する。
const KNOWN_STALE_LITERALS = ["gpt-5.5", "claude-sonnet-4-6", "gpt-5.4"];

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

  it("(d) .claude/CLAUDE.md allowlist doc matches SUBAGENT_ALLOWLIST", () => {
    const docPath = join(repoRoot, ".claude", "CLAUDE.md");
    if (!existsSync(docPath)) {
      // Clean Pack artifacts intentionally omit the source-local Claude runtime policy.
      expect(docPath.includes(".claude")).toBe(true);
      return;
    }
    const text = readFileSync(docPath, "utf8");
    const section = text.match(/^Allowlist:\n\n((?:- `[^`]+`\n)+)/m);
    expect(section, "Allowlist bullet section missing in .claude/CLAUDE.md").not.toBeNull();
    const documented = new Set(
      [...(section as RegExpMatchArray)[1].matchAll(/- `([^`]+)`/g)].map((m) => m[1]),
    );
    const missingInDoc = [...SUBAGENT_ALLOWLIST].filter((name) => !documented.has(name)).sort();
    const extraInDoc = [...documented].filter((name) => !SUBAGENT_ALLOWLIST.has(name)).sort();
    expect({ missingInDoc, extraInDoc }).toEqual({ missingInDoc: [], extraInDoc: [] });
  });

  it("(e) MODEL_IDS.claude values normalize to their catalog family", () => {
    for (const [family, modelId] of Object.entries(MODEL_IDS.claude)) {
      expect(normalizeModelFamily(modelId), modelId).toBe(family);
    }
  });

  it("(f) runtime-layer CLAUDE_MODEL_FAMILY_CATALOG mirrors MODEL_IDS.claude (module-boundary duplicate)", () => {
    expect({ ...CLAUDE_MODEL_FAMILY_CATALOG }).toEqual({ ...MODEL_IDS.claude });
  });

  it("(g) L6 function-spec.md model routing addendum carries no stale model-id literal", () => {
    const docPath = join(
      repoRoot,
      "docs",
      "design",
      "harness",
      "L6-function-design",
      "function-spec.md",
    );
    const text = readFileSync(docPath, "utf8");
    const result = findStaleModelIdLiterals(text);
    expect(result.offenders).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("(h) negative regression: findStaleModelIdLiterals flags reintroduced stale literals (real-repo fixture, PLAN-L7-256 gate extension)", () => {
    // real-repo regression: this proves the detector itself catches the exact stale
    // literals that were previously found in docs/design/harness/L6-function-design/
    // function-spec.md (issue #85), rather than only asserting the current doc is clean.
    const injected = `ティア表: T0 = {claude: claude-opus-4-8, codex: gpt-5.5}, T1 = {claude: claude-sonnet-4-6, codex: gpt-5.4}`;
    const result = findStaleModelIdLiterals(injected);
    expect(result.ok).toBe(false);
    for (const literal of KNOWN_STALE_LITERALS) {
      expect(result.offenders).toContain(literal);
    }
    // 現行 catalog 値であっても doc に生 literal を再導入すれば SSoT が二重化する。
    // 「現在は一致する」ことを clean とみなさず、symbol 参照だけを許可する。
    const currentRawLiterals = `T0 = {claude: claude-opus-4-8, codex: gpt-5.6-sol}`;
    const currentResult = findStaleModelIdLiterals(currentRawLiterals);
    expect(currentResult.ok).toBe(false);
    expect(currentResult.offenders).toEqual(["claude-opus-4-8", "gpt-5.6-sol"]);

    const symbolic = `T0 = {claude: MODEL_IDS.claude.opus, codex: MODEL_IDS.codex.frontier}`;
    expect(findStaleModelIdLiterals(symbolic).ok).toBe(true);
  });
});
