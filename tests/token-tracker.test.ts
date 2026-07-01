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
import { type HarnessDb, openHarnessDb, upsertRow } from "../src/state-db/index";
import { migrate } from "../src/state-db/migration";
import { projectModelEvaluations, projectTokenUsage } from "../src/state-db/projection-writer";
import {
  computeClaudeCostUsd,
  computeCodexCostUsd,
  loadRuntimeSessionUsage,
  parseClaudeSessionUsage,
  parseCodexSessionUsage,
  type RunUsage,
  summarizeRunUsage,
} from "../src/state-db/token-tracker";

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

      expect(execSql).toEqual(["BEGIN IMMEDIATE", "ROLLBACK"]);
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
