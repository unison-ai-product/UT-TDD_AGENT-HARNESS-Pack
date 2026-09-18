/**
 * U-FR-L1-38 token telemetry tracker (PLAN-L7-57 + PLAN-L7-58 cost enrichment)
 *
 * Oracle: 両 runtime の session JSONL を **CLI を起動せず** 読み、per-turn token usage を正規化する。
 * - Claude: per-message usage (累積差分 不要)、cost は CLAUDE_PRICING で計算。
 * - Codex: token_count は session 累積 → 連続差分で per-turn を復元、cost は OPENAI_PRICING で計算 (公式単価未掲載モデルは null)。
 * projectTokenUsage が model_runs へ投入し、projectModelEvaluations が token 効率を集計する。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type HarnessDb, openHarnessDb, upsertRow } from "../src/state-db/index.ts";
import { migrate } from "../src/state-db/migration.ts";
import { projectModelEvaluations, projectTokenUsage } from "../src/state-db/projection-writer.ts";
import {
  claudeProjectSlug,
  codexSessionBelongsToRepo,
  computeClaudeCostUsd,
  computeCodexCostUsd,
  loadRepoScopedRuntimeSessionUsage,
  loadRuntimeSessionUsage,
  parseClaudeSessionUsage,
  parseCodexSessionMetaCwd,
  parseCodexSessionUsage,
  type RunUsage,
  resolveClaudeProjectDir,
  summarizeRunUsage,
} from "../src/state-db/token-tracker.ts";
import { MODEL_IDS } from "../src/team/model-policy.ts";

describe("computeClaudeCostUsd", () => {
  it("computes cost from CLAUDE_PRICING (input + cache multipliers + output)", () => {
    // (1000 + 2000*0.1 + 0*1.25)*5 + 500*25 = 6000 + 12500 = 18500 / 1e6 = 0.0185
    const cost = computeClaudeCostUsd({
      model: "claude-opus-4-8",
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 2000,
      cacheWriteTokens: 0,
    });
    expect(cost).toBeCloseTo(0.0185, 6);
  });

  it("tolerates a date/[1m] suffix on the model id (prefix match)", () => {
    const cost = computeClaudeCostUsd({
      model: "claude-sonnet-4-6-20251114",
      inputTokens: 1000,
      outputTokens: 1000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    // 1000*3 + 1000*15 = 18000 / 1e6 = 0.018
    expect(cost).toBeCloseTo(0.018, 6);
  });

  it("applies the 1.25x cache-write multiplier (review I-3, non-zero cacheWrite)", () => {
    // (0 + 0*0.1 + 1000*1.25)*5 + 0*25 = 6250 / 1e6 = 0.00625
    const cost = computeClaudeCostUsd({
      model: "claude-opus-4-8",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 1000,
    });
    expect(cost).toBeCloseTo(0.00625, 6);
  });

  it("returns null for an unknown (non-Claude) model — no fabricated cost", () => {
    expect(
      computeClaudeCostUsd({
        model: "gpt-5.4-codex",
        inputTokens: 1000,
        outputTokens: 1000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBeNull();
  });
});

describe("computeCodexCostUsd (OPENAI_PRICING, 公式単価)", () => {
  it("computes cost for a published codex model (uncached input + cached + output)", () => {
    // gpt-5.3-codex = $1.75/$0.175/$14 per 1M. (1000-200)*1.75 + 200*0.175 + 500*14
    //   = 1400 + 35 + 7000 = 8435 / 1e6 = 0.008435
    const cost = computeCodexCostUsd({
      model: "gpt-5.3-codex",
      inputTokens: 1000,
      cachedInputTokens: 200,
      outputTokens: 500,
    });
    expect(cost).toBeCloseTo(0.008435, 6);
  });

  it("computes cost for a published flagship model (gpt-5.4)", () => {
    // gpt-5.4 = $2.5/$0.25/$15. 1000*2.5 + 1000*15 = 17500 / 1e6 = 0.0175
    expect(
      computeCodexCostUsd({
        model: "gpt-5.4",
        inputTokens: 1000,
        cachedInputTokens: 0,
        outputTokens: 1000,
      }),
    ).toBeCloseTo(0.0175, 6);
  });

  it("computes pricing fallbacks for the GPT-5.6 worker and frontier tiers", () => {
    expect(
      computeCodexCostUsd({
        model: MODEL_IDS.codex.worker,
        inputTokens: 1_000,
        cachedInputTokens: 0,
        outputTokens: 1_000,
      }),
    ).toBeCloseTo(0.0175, 6);
    expect(
      computeCodexCostUsd({
        model: MODEL_IDS.codex.frontier,
        inputTokens: 1_000,
        cachedInputTokens: 0,
        outputTokens: 1_000,
      }),
    ).toBeCloseTo(0.035, 6);
  });

  it("tolerates a trailing date/version suffix (prefix match to gpt-5.4)", () => {
    expect(
      computeCodexCostUsd({
        model: "gpt-5.4-2026-01-01",
        inputTokens: 1000,
        cachedInputTokens: 0,
        outputTokens: 1000,
      }),
    ).toBeCloseTo(0.0175, 6);
  });

  it("does NOT cross a variant boundary — gpt-5.4-codex is unpublished => null (no fabricated $)", () => {
    // gpt-5.4-codex starts with "gpt-5.4" but is a distinct variant not in the official table.
    // The safe matcher must NOT charge it gpt-5.4's price. Keeps the existing FR-38 invariant.
    expect(
      computeCodexCostUsd({
        model: "gpt-5.4-codex",
        inputTokens: 1000,
        cachedInputTokens: 0,
        outputTokens: 1000,
      }),
    ).toBeNull();
    expect(
      computeCodexCostUsd({
        model: "gpt-4o",
        inputTokens: 1000,
        cachedInputTokens: 0,
        outputTokens: 1000,
      }),
    ).toBeNull();
  });

  it("clamps uncached input to 0 when cachedInputTokens > inputTokens (safe undercharge, no negative cost)", () => {
    // Codex 累積差分では一時的に delta.cached > delta.input が起きうる。uncached=max(0,...) で
    // 負課金を防ぐ。結果は安全方向 (undercharge)。gpt-5.4: cached $0.25 → 500*0.25 = 0.000125。
    const cost = computeCodexCostUsd({
      model: "gpt-5.4",
      inputTokens: 200,
      cachedInputTokens: 500,
      outputTokens: 0,
    });
    expect(cost).toBeCloseTo(0.000125, 6);
    expect(cost).not.toBeLessThan(0);
  });

  it("charges cached tokens at the input rate when the model has no cached rate (pro)", () => {
    // gpt-5.4-pro = $30/(no cache)/$180. cached falls back to input rate.
    // (1000-400)*30 + 400*30 + 100*180 = 18000 + 12000 + 18000 = 48000 / 1e6 = 0.048
    expect(
      computeCodexCostUsd({
        model: "gpt-5.4-pro",
        inputTokens: 1000,
        cachedInputTokens: 400,
        outputTokens: 100,
      }),
    ).toBeCloseTo(0.048, 6);
  });
});

describe("summarizeRunUsage", () => {
  it("aggregates per-runtime counts, tokens, and known cost (null cost not summed)", () => {
    const usages: RunUsage[] = [
      {
        runtime: "claude",
        model: "claude-opus-4-8",
        sessionId: "s1",
        turnIndex: 0,
        inputTokens: 100,
        outputTokens: 200,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        costUsd: 0.01,
      },
      {
        runtime: "codex",
        model: "gpt-5.4-codex",
        sessionId: "c1",
        turnIndex: 0,
        inputTokens: 50,
        outputTokens: 80,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        costUsd: null,
      },
    ];
    const s = summarizeRunUsage(usages);
    expect(s).toEqual({
      totalRuns: 2,
      claudeRuns: 1,
      codexRuns: 1,
      inputTokens: 150,
      outputTokens: 280,
      knownCostUsd: 0.01,
      runsWithoutCost: 1,
    });
  });

  it("is cold-start safe (empty input)", () => {
    expect(summarizeRunUsage([])).toMatchObject({
      totalRuns: 0,
      knownCostUsd: 0,
      runsWithoutCost: 0,
    });
  });
});

describe("parseClaudeSessionUsage", () => {
  it("extracts per-message usage and computes cost", () => {
    const content = [
      JSON.stringify({ type: "user", message: { content: "hi" } }),
      JSON.stringify({
        type: "assistant",
        sessionId: "s1",
        message: {
          model: "claude-opus-4-8",
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 2000,
          },
        },
      }),
    ].join("\n");
    const runs = parseClaudeSessionUsage(content);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      runtime: "claude",
      model: "claude-opus-4-8",
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 2000,
      reasoningTokens: 0,
    });
    expect(runs[0]?.costUsd).toBeCloseTo(0.0185, 6);
  });

  it("ignores non-assistant lines and malformed JSON", () => {
    const content = ["not json", JSON.stringify({ type: "system" }), ""].join("\n");
    expect(parseClaudeSessionUsage(content)).toEqual([]);
  });
});

describe("parseCodexSessionUsage (cumulative -> per-turn delta)", () => {
  it("delta's consecutive cumulative token_count events and reads model from meta", () => {
    const content = [
      JSON.stringify({ type: "session_meta", payload: { model: "gpt-5.4-codex" } }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 0,
              output_tokens: 200,
              reasoning_output_tokens: 100,
            },
          },
        },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 2500,
              cached_input_tokens: 500,
              output_tokens: 500,
              reasoning_output_tokens: 250,
            },
          },
        },
      }),
    ].join("\n");
    const runs = parseCodexSessionUsage(content);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({
      runtime: "codex",
      model: "gpt-5.4-codex",
      inputTokens: 1000,
      outputTokens: 200,
      reasoningTokens: 100,
      cachedInputTokens: 0,
      costUsd: null,
    });
    // second turn = cumulative delta
    expect(runs[1]).toMatchObject({
      inputTokens: 1500,
      outputTokens: 300,
      reasoningTokens: 150,
      cachedInputTokens: 500,
      costUsd: null,
    });
  });

  it("skips no-op events with zero delta", () => {
    const content = [
      JSON.stringify({ type: "session_meta", payload: { model: "gpt-5.4-codex" } }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: { input_tokens: 100, output_tokens: 50 } },
        },
      }),
      // identical cumulative -> zero delta -> skipped
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: { input_tokens: 100, output_tokens: 50 } },
        },
      }),
    ].join("\n");
    expect(parseCodexSessionUsage(content)).toHaveLength(1);
  });

  it("computes non-null cost for a published codex model (gpt-5.3-codex)", () => {
    const content = [
      JSON.stringify({ type: "session_meta", payload: { model: "gpt-5.3-codex" } }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 200,
              output_tokens: 500,
              reasoning_output_tokens: 100,
            },
          },
        },
      }),
    ].join("\n");
    const runs = parseCodexSessionUsage(content);
    expect(runs).toHaveLength(1);
    // (1000-200)*1.75 + 200*0.175 + 500*14 = 8435 / 1e6 = 0.008435 (reasoning は output に内包、別課金しない)
    expect(runs[0]?.costUsd).toBeCloseTo(0.008435, 6);
  });
});

describe("loadRuntimeSessionUsage (file scan, no CLI invocation)", () => {
  it("scans both runtime dirs; missing dirs are cold-start safe (empty)", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-token-scan-"));
    try {
      const claudeDir = join(root, "claude");
      const codexDir = join(root, "codex");
      mkdirSync(claudeDir, { recursive: true });
      mkdirSync(codexDir, { recursive: true });
      writeFileSync(
        join(claudeDir, "s1.jsonl"),
        JSON.stringify({
          type: "assistant",
          message: { model: "claude-haiku-4-5", usage: { input_tokens: 10, output_tokens: 5 } },
        }),
      );
      writeFileSync(
        join(codexDir, "rollout.jsonl"),
        [
          JSON.stringify({ type: "session_meta", payload: { model: "gpt-5.4-codex" } }),
          JSON.stringify({
            type: "event_msg",
            payload: {
              type: "token_count",
              info: { total_token_usage: { input_tokens: 20, output_tokens: 8 } },
            },
          }),
        ].join("\n"),
      );

      const usages = loadRuntimeSessionUsage({ claudeDirs: [claudeDir], codexDirs: [codexDir] });
      expect(usages.filter((u) => u.runtime === "claude")).toHaveLength(1);
      expect(usages.filter((u) => u.runtime === "codex")).toHaveLength(1);

      // missing dirs => empty, no throw
      expect(loadRuntimeSessionUsage({ claudeDirs: [join(root, "nope")] })).toEqual([]);
      expect(loadRuntimeSessionUsage({})).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("claudeProjectSlug (repo -> Claude Code project-slug directory name)", () => {
  it("replaces path separators and the drive colon with '-' (verified against real ~/.claude/projects naming)", () => {
    // 実ディレクトリ観測 (2026-07-21): "C:\Users\micro\OneDrive\Desktop\UT-TDD-agent-harness"
    // -> "C--Users-micro-OneDrive-Desktop-UT-TDD-agent-harness" (ドライブ文字の大小は別途 resolve 側で吸収)。
    expect(claudeProjectSlug("C:\\Users\\micro\\OneDrive\\Desktop\\UT-TDD-agent-harness")).toBe(
      "C--Users-micro-OneDrive-Desktop-UT-TDD-agent-harness",
    );
    expect(claudeProjectSlug("c:\\dev\\seo-agent")).toBe("c--dev-seo-agent");
  });
});

describe("resolveClaudeProjectDir (repo -> matching ~/.claude/projects/<slug> dir)", () => {
  it("resolves case-insensitively (bash-reported lowercase drive vs GUI-reported uppercase)", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-claude-projects-"));
    try {
      // 実観測どおり、同じ repo でも起動経路により大文字 C / 小文字 c の両方が実在しうる。
      mkdirSync(join(root, "c--Users-micro-OneDrive-Desktop-UT-TDD-agent-harness"), {
        recursive: true,
      });
      const resolved = resolveClaudeProjectDir(
        root,
        "C:\\Users\\micro\\OneDrive\\Desktop\\UT-TDD-agent-harness",
      );
      expect(resolved).toBe(join(root, "c--Users-micro-OneDrive-Desktop-UT-TDD-agent-harness"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null when no matching directory / the projects root is absent (cold-start safe)", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-claude-projects-"));
    try {
      mkdirSync(join(root, "c--Users-micro-OneDrive-Desktop-some-other-repo"), { recursive: true });
      expect(
        resolveClaudeProjectDir(root, "C:\\Users\\micro\\OneDrive\\Desktop\\UT-TDD-agent-harness"),
      ).toBeNull();
      expect(resolveClaudeProjectDir(join(root, "nope"), "C:\\anything")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("parseCodexSessionMetaCwd + codexSessionBelongsToRepo (Codex cwd filter)", () => {
  it("extracts cwd from a session_meta first line", () => {
    const line = JSON.stringify({
      type: "session_meta",
      payload: { id: "x", cwd: "C:\\Users\\micro\\OneDrive\\Desktop\\UT-TDD-agent-harness" },
    });
    expect(parseCodexSessionMetaCwd(line)).toBe(
      "C:\\Users\\micro\\OneDrive\\Desktop\\UT-TDD-agent-harness",
    );
  });

  it("returns null for a non session_meta first line or a missing/non-string cwd (unknown format, skip)", () => {
    expect(parseCodexSessionMetaCwd(JSON.stringify({ type: "event_msg", payload: {} }))).toBeNull();
    expect(
      parseCodexSessionMetaCwd(JSON.stringify({ type: "session_meta", payload: { id: "x" } })),
    ).toBeNull();
    expect(parseCodexSessionMetaCwd("not json")).toBeNull();
  });

  it("matches repo-root and nested-subdir cwd, case/separator-insensitively; rejects a sibling repo", () => {
    const repoRoot = "C:\\Users\\micro\\OneDrive\\Desktop\\UT-TDD-agent-harness";
    expect(codexSessionBelongsToRepo(repoRoot, repoRoot)).toBe(true);
    expect(
      codexSessionBelongsToRepo("c:/users/micro/onedrive/desktop/ut-tdd-agent-harness", repoRoot, {
        platform: "win32",
      }),
    ).toBe(true);
    expect(codexSessionBelongsToRepo(`${repoRoot}\\src\\state-db`, repoRoot)).toBe(true);
    // 負例: 同名 prefix を持つ **別 repo** (例: -engine-swap worktree) は混入させない。
    expect(codexSessionBelongsToRepo(`${repoRoot}-engine-swap`, repoRoot)).toBe(false);
    expect(
      codexSessionBelongsToRepo("C:\\Users\\micro\\OneDrive\\Desktop\\SNS-agent", repoRoot),
    ).toBe(false);
    expect(codexSessionBelongsToRepo(null, repoRoot)).toBe(false);
  });

  it("case-folds paths only on win32; POSIX (linux) stays case-sensitive (blind review Finding 2, PLAN-L7-454)", () => {
    // /work/Repo と /work/repo は Linux (case-sensitive FS) では別ディレクトリ。無条件 lowercase は誤同一視。
    expect(codexSessionBelongsToRepo("/work/Repo", "/work/repo", { platform: "linux" })).toBe(
      false,
    );
    expect(codexSessionBelongsToRepo("/work/repo", "/work/repo", { platform: "linux" })).toBe(true);
    // Windows は従来どおり case-insensitive を維持する。
    expect(codexSessionBelongsToRepo("/work/Repo", "/work/repo", { platform: "win32" })).toBe(true);
  });
});

describe("loadRepoScopedRuntimeSessionUsage (repo-scope ingest, issue #82 / PLAN-L7-454)", () => {
  const REPO_ROOT = "C:\\Users\\micro\\OneDrive\\Desktop\\UT-TDD-agent-harness";
  const REPO_SLUG = "C--Users-micro-OneDrive-Desktop-UT-TDD-agent-harness";

  function claudeAssistantLine(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cwd?: string,
  ): string {
    const line: Record<string, unknown> = {
      type: "assistant",
      sessionId: "s1",
      message: { model, usage: { input_tokens: inputTokens, output_tokens: outputTokens } },
    };
    if (cwd !== undefined) line.cwd = cwd;
    return JSON.stringify(line);
  }

  function codexSessionContent(
    cwd: string | undefined,
    inputTokens: number,
    outputTokens: number,
  ): string {
    const metaPayload: Record<string, unknown> = { model: "gpt-5.3-codex" };
    if (cwd !== undefined) metaPayload.cwd = cwd;
    return [
      JSON.stringify({ type: "session_meta", payload: metaPayload }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: { input_tokens: inputTokens, output_tokens: outputTokens } },
        },
      }),
    ].join("\n");
  }

  it("(a) ingests only repo-owned session usage: matching Claude project-slug dir + matching Codex cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-repo-scope-"));
    try {
      const claudeRoot = join(root, "claude-projects");
      const codexRoot = join(root, "codex-sessions");
      const ownProjectDir = join(claudeRoot, REPO_SLUG);
      const otherProjectDir = join(claudeRoot, "c--Users-micro-OneDrive-Desktop-SNS-agent");
      mkdirSync(ownProjectDir, { recursive: true });
      mkdirSync(otherProjectDir, { recursive: true });
      mkdirSync(codexRoot, { recursive: true });

      writeFileSync(
        join(ownProjectDir, "s1.jsonl"),
        claudeAssistantLine("claude-opus-4-8", 100, 50, REPO_ROOT),
      );
      // (b) 他 project の Claude ディレクトリは走査対象外 (混入不可能、そもそも別ディレクトリ)。
      writeFileSync(
        join(otherProjectDir, "foreign.jsonl"),
        claudeAssistantLine(
          "claude-opus-4-8",
          999,
          999,
          "C:\\Users\\micro\\OneDrive\\Desktop\\SNS-agent",
        ),
      );
      writeFileSync(join(codexRoot, "own.jsonl"), codexSessionContent(REPO_ROOT, 200, 80));
      // (b) 他 repo (cwd 不一致) の Codex session は混入させない。
      writeFileSync(
        join(codexRoot, "foreign.jsonl"),
        codexSessionContent("C:\\Users\\micro\\OneDrive\\Desktop\\SNS-agent", 999, 999),
      );
      // cwd 不明形式 (session_meta に cwd フィールドが無い) は不採用 + skip カウント対象。
      writeFileSync(join(codexRoot, "unknown-cwd.jsonl"), codexSessionContent(undefined, 999, 999));

      const { usages, stats } = loadRepoScopedRuntimeSessionUsage(REPO_ROOT, {
        claudeDirs: [claudeRoot],
        codexDirs: [codexRoot],
      });

      expect(stats.claudeProjectDirResolved).toBe(true);
      expect(stats.claudeFilesChecked).toBe(1);
      expect(stats.claudeFilesScanned).toBe(1);
      expect(stats.claudeFilesForeignRepo).toBe(0);
      expect(stats.claudeFilesSkippedUnknownCwd).toBe(0);
      expect(stats.codexFilesChecked).toBe(3);
      expect(stats.codexFilesMatched).toBe(1);
      expect(stats.codexFilesForeignRepo).toBe(1);
      expect(stats.codexFilesSkippedUnknownCwd).toBe(1);

      const claudeUsages = usages.filter((u) => u.runtime === "claude");
      const codexUsages = usages.filter((u) => u.runtime === "codex");
      // (b) 負例: 他 project/repo の usage 値 (999) が一切紛れ込んでいないことを直接確認する。
      expect(claudeUsages).toHaveLength(1);
      expect(claudeUsages[0]).toMatchObject({ inputTokens: 100, outputTokens: 50 });
      expect(codexUsages).toHaveLength(1);
      expect(codexUsages[0]).toMatchObject({ inputTokens: 200, outputTokens: 80 });
      expect(usages.some((u) => u.inputTokens === 999 || u.outputTokens === 999)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("(d) verifies per-file cwd inside a slug-collided Claude project dir; a same-slug foreign-repo file is excluded (blind review Finding 1, PLAN-L7-454)", () => {
    // claudeProjectSlug は `\`/`/`/`:` を一律 `-` に潰すため非単射: 以下 2 つの異なる repoRoot は
    // 同一 slug "C--a-b-c" に衝突する。Claude Code 自身もこの slug でディレクトリを作るため、実運用では
    // 両 repo の session が **同一物理ディレクトリ**へ混在しうる (slug 一致だけでは帰属を保証できない)。
    const repoRootOwn = "C:\\a-b\\c";
    const repoRootForeign = "C:\\a\\b-c";
    expect(claudeProjectSlug(repoRootOwn)).toBe(claudeProjectSlug(repoRootForeign)); // 前提: 衝突を確認

    const root = mkdtempSync(join(tmpdir(), "ut-tdd-repo-scope-collision-"));
    try {
      const claudeRoot = join(root, "claude-projects");
      const collidedSlugDir = join(claudeRoot, claudeProjectSlug(repoRootOwn));
      mkdirSync(collidedSlugDir, { recursive: true });

      writeFileSync(
        join(collidedSlugDir, "own.jsonl"),
        claudeAssistantLine("claude-opus-4-8", 111, 22, repoRootOwn),
      );
      // 同一 slug ディレクトリ内だが実 cwd は別 repo → per-file 検証で除外されなければならない。
      writeFileSync(
        join(collidedSlugDir, "foreign.jsonl"),
        claudeAssistantLine("claude-opus-4-8", 999, 999, repoRootForeign),
      );

      const { usages, stats } = loadRepoScopedRuntimeSessionUsage(repoRootOwn, {
        claudeDirs: [claudeRoot],
      });

      expect(stats.claudeProjectDirResolved).toBe(true);
      expect(stats.claudeFilesChecked).toBe(2);
      expect(stats.claudeFilesScanned).toBe(1);
      expect(stats.claudeFilesForeignRepo).toBe(1);

      const claudeUsages = usages.filter((u) => u.runtime === "claude");
      expect(claudeUsages).toHaveLength(1);
      expect(claudeUsages[0]).toMatchObject({ inputTokens: 111, outputTokens: 22 });
      expect(usages.some((u) => u.inputTokens === 999 || u.outputTokens === 999)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("(e) a Claude session file with no cwd field is unadopted and counted in claudeFilesSkippedUnknownCwd (blind review Finding 1, PLAN-L7-454)", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-repo-scope-nocwd-"));
    try {
      const claudeRoot = join(root, "claude-projects");
      const projectDir = join(claudeRoot, REPO_SLUG);
      mkdirSync(projectDir, { recursive: true });
      // cwd フィールドが無い形式 (旧仕様の走査だけでは他 repo 混入と区別できなかった形式)。
      writeFileSync(
        join(projectDir, "no-cwd.jsonl"),
        claudeAssistantLine("claude-opus-4-8", 999, 999),
      );

      const { usages, stats } = loadRepoScopedRuntimeSessionUsage(REPO_ROOT, {
        claudeDirs: [claudeRoot],
      });

      expect(stats.claudeProjectDirResolved).toBe(true);
      expect(stats.claudeFilesChecked).toBe(1);
      expect(stats.claudeFilesScanned).toBe(0);
      expect(stats.claudeFilesForeignRepo).toBe(0);
      expect(stats.claudeFilesSkippedUnknownCwd).toBe(1);
      expect(usages).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("(c) cold-start: no matching project dir / no session dirs => empty usages, no throw", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-repo-scope-cold-"));
    try {
      const result = loadRepoScopedRuntimeSessionUsage(REPO_ROOT, {
        claudeDirs: [join(root, "nope-claude")],
        codexDirs: [join(root, "nope-codex")],
      });
      expect(result.usages).toEqual([]);
      expect(result.stats.claudeProjectDirResolved).toBe(false);
      expect(loadRepoScopedRuntimeSessionUsage(REPO_ROOT, {}).usages).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("projectTokenUsage + projectModelEvaluations (token efficiency)", () => {
  function makeRoot(enabled: boolean): string {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-token-eval-"));
    mkdirSync(join(root, ".ut-tdd", "config"), { recursive: true });
    writeFileSync(join(root, ".ut-tdd", "config", "model-opt-in.yaml"), `enabled: ${enabled}\n`);
    return root;
  }

  it("aggregates token totals + tokens_per_success + cost_per_success across sources", () => {
    const root = makeRoot(true);
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      // success row from review-evidence (no tokens), joined via plan_registry
      upsertRow(db, {
        table: "plan_registry",
        primaryKey: "plan_id",
        row: {
          plan_id: "PLAN-X",
          kind: "impl",
          layer: "L7",
          drive: "db",
          status: "confirmed",
          updated_at: "",
          decision_outcome: "",
        },
      });
      upsertRow(db, {
        table: "model_runs",
        primaryKey: "run_id",
        row: {
          run_id: "rev-1",
          runtime: "claude",
          model: "claude-opus-4-8",
          role: "worker",
          drive: "db",
          plan_id: "PLAN-X",
          started_at: "",
          completed_at: "",
          evidence_path: "",
        },
      });
      // token row from token-tracker (output 1000, cost 0.05)
      projectTokenUsage(db, [
        {
          runtime: "claude",
          model: "claude-opus-4-8",
          sessionId: "s1",
          turnIndex: 0,
          inputTokens: 400,
          outputTokens: 1000,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          costUsd: 0.05,
        },
      ]);

      projectModelEvaluations(db, root);

      const row = db
        .prepare("SELECT * FROM model_evaluations WHERE model = ?")
        .get("claude-opus-4-8") as Record<string, number>;
      expect(row.total_output_tokens).toBe(1000);
      expect(row.total_input_tokens).toBe(400);
      expect(row.success_count).toBe(1);
      // I-2 (意図的非対称): 分子=全 model_runs の output (session 行 plan_id='' 含む 1000)、
      // 分母=plan 紐づき success (1) → 1000。「success PLAN あたり token コスト」proxy (定義は projection-writer JSDoc)。
      expect(row.tokens_per_success).toBeCloseTo(1000, 2);
      expect(row.total_cost_usd).toBeCloseTo(0.05, 6);
      expect(row.cost_per_success).toBeCloseTo(0.05, 6);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("Codex token rows give token efficiency with NULL cost (no fabricated $)", () => {
    const root = makeRoot(true);
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      upsertRow(db, {
        table: "plan_registry",
        primaryKey: "plan_id",
        row: {
          plan_id: "PLAN-Y",
          kind: "impl",
          layer: "L7",
          drive: "db",
          status: "completed",
          updated_at: "",
          decision_outcome: "",
        },
      });
      upsertRow(db, {
        table: "model_runs",
        primaryKey: "run_id",
        row: {
          run_id: "rev-2",
          runtime: "codex",
          model: "gpt-5.4-codex",
          role: "worker",
          drive: "db",
          plan_id: "PLAN-Y",
          started_at: "",
          completed_at: "",
          evidence_path: "",
        },
      });
      projectTokenUsage(db, [
        {
          runtime: "codex",
          model: "gpt-5.4-codex",
          sessionId: "c1",
          turnIndex: 0,
          inputTokens: 800,
          outputTokens: 600,
          cachedInputTokens: 100,
          reasoningTokens: 200,
          costUsd: null,
        },
      ]);

      projectModelEvaluations(db, root);
      const row = db
        .prepare("SELECT * FROM model_evaluations WHERE model = ?")
        .get("gpt-5.4-codex") as Record<string, number | null>;
      expect(row.total_output_tokens).toBe(600);
      expect(row.tokens_per_success).toBeCloseTo(600, 2);
      expect(row.total_cost_usd).toBeNull(); // codex has no cost source
      expect(row.cost_per_success).toBeNull();
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ingests token usage in a single transaction for large automatic scans", () => {
    const db = openHarnessDb(":memory:");
    const execSql: string[] = [];
    const wrappedDb: HarnessDb = {
      ...db,
      exec: (sql: string) => {
        execSql.push(sql);
        db.exec(sql);
      },
    };
    try {
      migrate(db);
      projectTokenUsage(
        wrappedDb,
        Array.from({ length: 25 }, (_, i) => ({
          runtime: "codex",
          model: "gpt-5.3-codex",
          sessionId: "bulk-session",
          turnIndex: i,
          inputTokens: 100 + i,
          outputTokens: 10 + i,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          costUsd: 0.001,
        })),
      );

      expect(execSql[0]).toBe("BEGIN IMMEDIATE");
      expect(execSql).toContain("COMMIT");
      expect(execSql).not.toContain("ROLLBACK");
      const count = db.prepare("SELECT COUNT(*) AS n FROM model_runs").get() as { n: number };
      expect(count.n).toBe(25);
    } finally {
      db.close();
    }
  });

  it("rolls back token usage ingestion when projection fails", () => {
    const db = openHarnessDb(":memory:");
    const execSql: string[] = [];
    const wrappedDb: HarnessDb = {
      ...db,
      exec: (sql: string) => {
        execSql.push(sql);
        db.exec(sql);
      },
      prepare: () => {
        throw new Error("forced projection failure");
      },
    };
    try {
      migrate(db);
      expect(() =>
        projectTokenUsage(wrappedDb, [
          {
            runtime: "claude",
            model: "claude-opus-4-8",
            sessionId: "broken-session",
            turnIndex: 0,
            inputTokens: 100,
            outputTokens: 20,
            cachedInputTokens: 0,
            reasoningTokens: 0,
            costUsd: 0.001,
          },
        ]),
      ).toThrow("forced projection failure");

      expect(execSql).toEqual([
        "BEGIN IMMEDIATE",
        "SAVEPOINT ut_tdd_projection_1",
        "ROLLBACK TO SAVEPOINT ut_tdd_projection_1",
        "RELEASE SAVEPOINT ut_tdd_projection_1",
        "ROLLBACK",
      ]);
      const count = db.prepare("SELECT COUNT(*) AS n FROM model_runs").get() as { n: number };
      expect(count.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it("opt-in disabled => 0 model_evaluations rows even with token runs (review I-1)", () => {
    // FR-38 opt-in gate 不変条件: token-tracker 投入があっても enabled:false なら 0 行。
    const root = makeRoot(false);
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      projectTokenUsage(db, [
        {
          runtime: "claude",
          model: "claude-opus-4-8",
          sessionId: "s1",
          turnIndex: 0,
          inputTokens: 100,
          outputTokens: 50,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          costUsd: 0.01,
        },
      ]);
      projectModelEvaluations(db, root);
      const count = (
        db.prepare("SELECT COUNT(*) AS n FROM model_evaluations").get() as { n: number }
      ).n;
      expect(count).toBe(0);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
