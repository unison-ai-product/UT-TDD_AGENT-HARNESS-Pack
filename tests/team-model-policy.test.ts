import { describe, expect, it } from "vitest";
import { OPENAI_PRICING } from "../src/state-db/token-tracker.ts";
import { TIER_TABLE } from "../src/task/tier-router-policy.ts";
import { buildAdvisorDecision, resolveAdvisorRoutes } from "../src/team/advisor-policy.ts";
import {
  advisorHeavyUseRecommended,
  escalateShallowResponse,
  inferTaskDifficulty,
  inferTaskIntent,
  MODEL_EFFORT_LADDER,
  MODEL_IDS,
  PLAN_AGENT_MODELS,
  REVIEW_LANE_MODELS,
  REVIEW_LANES,
  selectTeamModel,
} from "../src/team/model-policy.ts";

describe("team model policy", () => {
  it("infers critical difficulty from high-risk task terms", () => {
    expect(inferTaskDifficulty({ task: "DB schema migration for production auth" })).toEqual({
      difficulty: "critical",
      source: "inferred",
    });
  });

  it("uses mini at ladder-base high effort for trivial doc patches (effort ladder, PO rule 2026-07-28)", () => {
    const selection = selectTeamModel({
      provider: "codex",
      role: "docs",
      engine: "codex-pg",
      task: "README typo",
    });

    expect(selection).toMatchObject({
      difficulty: "trivial",
      model_family: "fast",
      model: MODEL_IDS.codex.mini,
      // mini は base=high (改定前は xhigh)。深さが要るなら effort ではなく Terra へ上げる。
      reasoning_effort: "high",
      task_intent: "docs",
    });
  });

  it("uses frontier model at ladder-base low effort for critical codex review work", () => {
    const selection = selectTeamModel({
      provider: "codex",
      role: "qa",
      engine: "codex-tl",
      task: "review production security migration",
    });

    expect(selection).toMatchObject({
      difficulty: "critical",
      model_family: "frontier",
      // frontier = T0 最上位。tier-router TIER_TABLE.T0.codex と整合。
      model: MODEL_IDS.codex.frontier,
      // Sol は基準 low (effort ladder、PO rule 2026-07-14)。浅い時は middle へ引き上げ。
      reasoning_effort: "low",
      task_intent: "review",
    });
  });

  it("keeps explicit Claude engine family instead of escalating pmo-sonnet to opus", () => {
    const selection = selectTeamModel({
      provider: "claude",
      role: "tl",
      engine: "pmo-sonnet",
      task: "production security migration",
    });

    expect(selection.model_family).toBe("frontier");
    expect(selection.model).toBe(MODEL_IDS.claude.sonnet);
    expect(selection.model_source).toBe("engine");
    // Sonnet は基準 middle (effort ladder、PO rule 2026-07-14)。浅い時は high へ引き上げ。
    expect(selection.reasoning_effort).toBe("middle");
  });

  it("maps docs, research, UI/UX, and implementation intent to the requested effort defaults", () => {
    expect(inferTaskIntent({ role: "docs", task: "update governance docs" })).toBe("docs");
    expect(inferTaskIntent({ task: "research public SDK sources" })).toBe("research");
    expect(inferTaskIntent({ role: "uiux", task: "screen visual design" })).toBe("uiux");
    expect(inferTaskIntent({ role: "se", task: "implement setup wrapper" })).toBe("implementation");

    expect(
      selectTeamModel({
        provider: "claude",
        role: "uiux",
        engine: "pmo-sonnet",
        task: "screen visual design",
      }),
    ).toMatchObject({
      model: MODEL_IDS.claude.sonnet,
      reasoning_effort: "xhigh",
      task_intent: "uiux",
    });
    // 実装は luna へ解決され effort=high 基準 (PO rule 2026-07-14)。
    expect(
      selectTeamModel({
        provider: "codex",
        role: "se",
        engine: "codex-se",
        task: "implement setup wrapper",
      }),
    ).toMatchObject({ model: MODEL_IDS.codex.luna, reasoning_effort: "high" });
  });

  it("honors explicit difficulty, model, and effort overrides", () => {
    const selection = selectTeamModel({
      provider: "codex",
      role: "se",
      engine: "codex-se",
      task: "implement",
      difficulty: "simple",
      model: "gpt-custom",
      effort: "xhigh",
    });

    expect(selection).toMatchObject({
      difficulty: "simple",
      difficulty_source: "explicit",
      model: "gpt-custom",
      model_source: "explicit",
      reasoning_effort: "xhigh",
      effort_source: "explicit",
    });
  });

  it("routes sonnet design decisions to fable with a sol fallback (PO rule 2026-07-29)", () => {
    const claude = buildAdvisorDecision({
      task: "review whether the release gate is safe to close",
      mode: "hybrid",
      decisionKind: "design",
      currentModel: MODEL_IDS.claude.sonnet,
    });

    expect(claude).toMatchObject({
      provider: "claude",
      model: MODEL_IDS.claude.fable,
      effort: "low",
      consultation_mode: "consult",
      decision_kind: "design",
      decision_kind_source: "explicit",
      current_model_lower_than_advisor: true,
      adapterPlan: {
        provider: "claude",
        model: MODEL_IDS.claude.fable,
        dry_run: true,
      },
      fallback: {
        provider: "codex",
        model: MODEL_IDS.codex.frontier,
        effort: "low",
        consultation_mode: "consult",
      },
    });
    expect(claude.adapterPlan.stdin).toContain("upper-model advisor");
  });

  it("routes opus design decisions to adversarial fable with a sol fallback", () => {
    const decision = buildAdvisorDecision({
      task: "decide the architecture split for the projection layer",
      mode: "hybrid",
      decisionKind: "design",
      currentModel: MODEL_IDS.claude.opus,
    });

    expect(decision).toMatchObject({
      provider: "claude",
      model: MODEL_IDS.claude.fable,
      effort: "low",
      consultation_mode: "adversarial",
      fallback: {
        provider: "codex",
        model: MODEL_IDS.codex.frontier,
        effort: "low",
        consultation_mode: "adversarial",
      },
    });
    expect(decision.adapterPlan.stdin).toContain("adversarial verifier");
  });

  it("routes implementation decisions to the codex frontier model", () => {
    const sonnet = buildAdvisorDecision({
      task: "implement the retry logic in src",
      mode: "hybrid",
      currentModel: MODEL_IDS.claude.sonnet,
    });
    expect(sonnet).toMatchObject({
      provider: "codex",
      model: MODEL_IDS.codex.frontier,
      effort: "low",
      consultation_mode: "consult",
      decision_kind: "implementation",
      decision_kind_source: "inferred",
    });
    expect(sonnet.fallback).toMatchObject({
      provider: "claude",
      model: MODEL_IDS.claude.fable,
    });

    const opus = buildAdvisorDecision({
      task: "implement the retry logic in src",
      mode: "hybrid",
      currentModel: MODEL_IDS.claude.opus,
    });
    expect(opus).toMatchObject({
      provider: "codex",
      model: MODEL_IDS.codex.frontier,
      effort: "low",
      consultation_mode: "adversarial",
    });
    expect(opus.adapterPlan.stdin).toContain("adversarial verifier");
  });

  it("builds executable codex advisor plans in codex-only mode", () => {
    const codex = buildAdvisorDecision({
      task: "advise on uncertain implementation close",
      mode: "codex-only",
      provider: "codex",
      execute: true,
    });

    expect(codex).toMatchObject({
      provider: "codex",
      model: MODEL_IDS.codex.frontier,
      effort: "low",
      consultation_mode: "consult",
      adapterPlan: {
        provider: "codex",
        model: MODEL_IDS.codex.frontier,
        dry_run: false,
      },
    });
    // Sol advisor はモデル標準 effort=low を argv へ実注入する。
    expect(codex.adapterPlan.args).toEqual([
      "exec",
      "-m",
      MODEL_IDS.codex.frontier,
      "-c",
      "model_reasoning_effort=low",
      "-",
    ]);
    expect(codex.fallback).toBeUndefined();
  });

  it("omits the codex fallback in claude-only mode", () => {
    const decision = buildAdvisorDecision({
      task: "review whether the release gate is safe to close",
      mode: "claude-only",
      decisionKind: "design",
      currentModel: MODEL_IDS.claude.sonnet,
    });
    expect(decision).toMatchObject({
      provider: "claude",
      model: MODEL_IDS.claude.fable,
    });
    expect(decision.fallback).toBeUndefined();
  });

  it("treats older sonnet and haiku generations as lower than the advisor family", () => {
    for (const currentModel of ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"]) {
      expect(
        buildAdvisorDecision({
          task: "review whether the release gate is safe to close",
          mode: "hybrid",
          decisionKind: "design",
          currentModel,
        }),
      ).toMatchObject({
        // design は Fable 一次 (PO 2026-07-29)。旧世代 sonnet / haiku は
        // 世代を問わず advisor family より下位と判定される。
        provider: "claude",
        model: MODEL_IDS.claude.fable,
        current_model_lower_than_advisor: true,
      });
    }
  });
});

describe("task-kind routing v2 (PLAN-L7-430, PO rule 2026-07-14)", () => {
  it("U-ROUTE2-001: codex テスト実装は terra + ladder base middle effort", () => {
    const selection = selectTeamModel({
      provider: "codex",
      role: "se",
      engine: "codex-se",
      task: "write vitest oracle for the retry logic",
    });
    expect(selection).toMatchObject({
      model: MODEL_IDS.codex.worker,
      // Terra は基準 middle (effort ladder)。浅い時 high、なお浅ければ Sol low へ乗り換え。
      reasoning_effort: "middle",
      task_intent: "test",
    });
  });

  it("U-ROUTE2-002: codex 実装 (非軽量) は luna + high effort (worker middle 既定の上書き)", () => {
    const selection = selectTeamModel({
      provider: "codex",
      role: "se",
      engine: "codex-se",
      task: "implement the projection ingestion pipeline in src",
    });
    expect(selection).toMatchObject({
      model: MODEL_IDS.codex.luna,
      reasoning_effort: "high",
      task_intent: "implementation",
    });
  });

  it("U-ROUTE2-003: codex 軽量実装は spark、研究/web は mini", () => {
    expect(
      selectTeamModel({
        provider: "codex",
        role: "se",
        engine: "codex-se",
        task: "rename src variable",
        difficulty: "simple",
      }).model,
    ).toBe(MODEL_IDS.codex.spark);
    expect(
      selectTeamModel({
        provider: "codex",
        role: "pg",
        engine: "codex-pg",
        task: "web research on library sources",
      }).model,
    ).toBe(MODEL_IDS.codex.mini);
  });

  it("U-ROUTE2-004: codex 設計/検証は sol", () => {
    expect(
      selectTeamModel({
        provider: "codex",
        role: "se",
        engine: "codex-se",
        task: "architecture contract for the projection layer",
      }).model,
    ).toBe(MODEL_IDS.codex.frontier);
  });

  it("U-ROUTE2-014: task-kind remains primary for critical implementation and test work", () => {
    expect(
      selectTeamModel({
        provider: "codex",
        role: "se",
        engine: "codex-se",
        task: "implement database migration for production",
      }),
    ).toMatchObject({
      difficulty: "critical",
      task_intent: "implementation",
      model: MODEL_IDS.codex.luna,
    });
    expect(
      selectTeamModel({
        provider: "codex",
        role: "se",
        engine: "codex-se",
        task: "write test for database migration",
      }),
    ).toMatchObject({
      difficulty: "critical",
      task_intent: "test",
      model: MODEL_IDS.codex.worker,
    });
  });

  it("U-ROUTE2-015: intent inference uses token boundaries instead of substrings", () => {
    expect(inferTaskIntent({ task: "summarize the contest result" })).toBe("general");
    expect(inferTaskIntent({ task: "build adapter" })).toBe("implementation");
    expect(inferTaskIntent({ task: "update build script" })).toBe("implementation");
    expect(inferTaskIntent({ task: "guide patch" })).toBe("general");
  });

  it("U-ROUTE2-016: overlapping test/review wording preserves the explicit test task-kind", () => {
    expect(
      selectTeamModel({
        provider: "codex",
        role: "se",
        engine: "codex-se",
        task: "write a vitest test to verify retry behavior",
      }),
    ).toMatchObject({ task_intent: "test", model: MODEL_IDS.codex.worker });
  });

  it("U-ROUTE2-017: Claude task-kind overrides a lower explicit engine family", () => {
    expect(
      selectTeamModel({
        provider: "claude",
        role: "se",
        engine: MODEL_IDS.claude.sonnet,
        task: "author the architecture design contract",
      }),
    ).toMatchObject({ task_intent: "design", model: MODEL_IDS.claude.opus });
  });

  it("U-ROUTE2-018: Japanese task text preserves test, design, and UI task kinds", () => {
    expect(inferTaskIntent({ task: "テストを実装する" })).toBe("test");
    expect(inferTaskIntent({ task: "設計を作成する" })).toBe("design");
    expect(inferTaskIntent({ task: "UIを実装する" })).toBe("uiux");
  });

  it("U-ROUTE2-019: leading action disambiguates compound test and review tasks", () => {
    expect(inferTaskIntent({ task: "review tests and implement fix" })).toBe("review");
    expect(inferTaskIntent({ task: "write tests to audit security" })).toBe("test");
    expect(inferTaskIntent({ task: "implement fix and review tests" })).toBe("implementation");
    expect(inferTaskIntent({ task: "review release notes" })).toBe("review");
    expect(inferTaskIntent({ task: "implement docs generator" })).toBe("implementation");
  });

  it("U-ROUTE2-020: compound test and release-note terms remain routable", () => {
    expect(inferTaskIntent({ task: "run unit-test suite" })).toBe("test");
    expect(inferTaskIntent({ task: "testing retry behavior" })).toBe("test");
    expect(inferTaskIntent({ task: "update release notes" })).toBe("docs");
  });

  it("U-ROUTE2-021: detected and explicit task kinds override role defaults", () => {
    expect(
      selectTeamModel({
        provider: "codex",
        role: "qa",
        engine: "codex-qa",
        task: "write a vitest test for retry behavior",
      }),
    ).toMatchObject({ task_intent: "test", model: MODEL_IDS.codex.worker });
    expect(
      selectTeamModel({
        provider: "codex",
        role: "qa",
        engine: "codex-qa",
        task: "generic task text",
        intent: "implementation",
      }),
    ).toMatchObject({ task_intent: "implementation", model: MODEL_IDS.codex.luna });
  });

  it("U-ROUTE2-005: claude 設計ドキュメント作成は opus、doc 修正は sonnet、doc パッチは haiku", () => {
    expect(
      selectTeamModel({
        provider: "claude",
        role: "se",
        engine: "generic",
        task: "author the module decomposition design document architecture",
      }).model,
    ).toBe(MODEL_IDS.claude.opus);
    expect(
      selectTeamModel({
        provider: "claude",
        role: "docs",
        engine: "generic",
        task: "update the governance handbook section wording",
        difficulty: "standard",
      }).model,
    ).toBe(MODEL_IDS.claude.sonnet);
    expect(
      selectTeamModel({
        provider: "claude",
        role: "docs",
        engine: "generic",
        task: "readme typo",
      }).model,
    ).toBe(MODEL_IDS.claude.haiku);
  });

  it("U-ROUTE2-006: tier-router T1 codex は luna、T0 は sol/opus のまま", () => {
    expect(TIER_TABLE.T1.codex).toBe(MODEL_IDS.codex.luna);
    expect(TIER_TABLE.T0.codex).toBe(MODEL_IDS.codex.frontier);
    expect(TIER_TABLE.T0.claude).toBe(MODEL_IDS.claude.opus);
  });

  it("U-ROUTE2-007: luna の公式 pricing が登録されている (cost null 回避)", () => {
    expect(OPENAI_PRICING[MODEL_IDS.codex.luna]).toEqual({ input: 1, cached: 0.1, output: 6 });
  });

  it("U-ROUTE2-008: advisor uiux 判断は fable 一次 + sol fallback (PO: Fable、次点 Sol)", () => {
    const decision = buildAdvisorDecision({
      task: "judge the UI wireframe direction",
      mode: "hybrid",
      decisionKind: "uiux",
      currentModel: MODEL_IDS.claude.sonnet,
    });
    expect(decision).toMatchObject({
      provider: "claude",
      model: MODEL_IDS.claude.fable,
      decision_kind: "uiux",
    });
    expect(decision.fallback).toMatchObject({
      provider: "codex",
      model: MODEL_IDS.codex.frontier,
    });
  });

  it("U-ROUTE2-009: troubleshooting は task 文から推論され sol 一次", () => {
    const decision = buildAdvisorDecision({
      task: "debug the flaky crash in the session log ingestion",
      mode: "hybrid",
      currentModel: MODEL_IDS.claude.sonnet,
    });
    expect(decision).toMatchObject({
      provider: "codex",
      model: MODEL_IDS.codex.frontier,
      decision_kind: "troubleshooting",
      decision_kind_source: "inferred",
    });
  });

  it("U-ROUTE2-011: 進行判断 (レーン選択・優先順位) は task 文から推論され fable 一次 (PO 2026-07-29)", () => {
    for (const task of [
      "どのレーンに着手するか優先順位を決めたい",
      "decide the lane and sequencing for this block",
    ]) {
      const decision = buildAdvisorDecision({
        task,
        mode: "hybrid",
        currentModel: MODEL_IDS.claude.opus,
      });
      expect(decision).toMatchObject({
        provider: "claude",
        model: MODEL_IDS.claude.fable,
        decision_kind: "progress",
        decision_kind_source: "inferred",
      });
      expect(decision.fallback).toMatchObject({
        provider: "codex",
        model: MODEL_IDS.codex.frontier,
      });
    }
  });

  it("U-ROUTE2-012: 進行判断は troubleshooting 語を含んでも進行側へ寄せる (レーン選択は技術判断でない)", () => {
    const decision = buildAdvisorDecision({
      // 実例 2026-07-29: 「CI が fail している PR を先に見るか」というレーン選択。
      // fail / error 語を含むが判断そのものは進行。
      task: "PR の CI fail を先に見るか、設計 freeze を先にやるか着手順を決めたい",
      mode: "hybrid",
      currentModel: MODEL_IDS.claude.opus,
    });
    expect(decision).toMatchObject({
      provider: "claude",
      model: MODEL_IDS.claude.fable,
      decision_kind: "progress",
    });
  });

  it("U-ROUTE2-013: 技術判断 (implementation / troubleshooting) は sol 一次のまま (PO 2026-07-29 で不変)", () => {
    for (const [task, kind] of [
      ["implement the retry logic in src", "implementation"],
      ["debug the crash in the projection writer", "troubleshooting"],
    ] as const) {
      const decision = buildAdvisorDecision({
        task,
        mode: "hybrid",
        currentModel: MODEL_IDS.claude.opus,
      });
      expect(decision).toMatchObject({
        provider: "codex",
        model: MODEL_IDS.codex.frontier,
        decision_kind: kind,
      });
      expect(decision.fallback).toMatchObject({
        provider: "claude",
        model: MODEL_IDS.claude.fable,
      });
    }
  });

  it("U-ROUTE2-014: opus orchestrator への相談は provider を問わず敵対検証 (追認バイアス防止の不変条件)", () => {
    const design = buildAdvisorDecision({
      task: "decide the architecture split for the projection layer",
      mode: "hybrid",
      decisionKind: "design",
      currentModel: MODEL_IDS.claude.opus,
    });
    expect(design.consultation_mode).toBe("adversarial");
    expect(design.adapterPlan.stdin).toContain("adversarial verifier");

    const sonnet = buildAdvisorDecision({
      task: "decide the architecture split for the projection layer",
      mode: "hybrid",
      decisionKind: "design",
      currentModel: MODEL_IDS.claude.sonnet,
    });
    expect(sonnet.consultation_mode).toBe("consult");
  });

  it("U-ROUTE2-015: 実装の進行状況は進行判断へ過剰分類せず troubleshooting を優先する", () => {
    const decision = buildAdvisorDecision({
      task: "着手した実装が進行中に crash した。原因を debug したい",
      mode: "hybrid",
      currentModel: MODEL_IDS.claude.opus,
    });
    expect(decision).toMatchObject({
      provider: "codex",
      model: MODEL_IDS.codex.frontier,
      decision_kind: "troubleshooting",
    });
  });

  it("U-ROUTE2-016: 英語の優先順判断は technical 語を含んでも progress を優先する", () => {
    for (const task of [
      "Which failing PR should we fix first?",
      "Which failing PR to fix first?",
    ]) {
      const decision = buildAdvisorDecision({
        task,
        mode: "hybrid",
        currentModel: MODEL_IDS.claude.opus,
      });
      expect(decision).toMatchObject({
        provider: "claude",
        model: MODEL_IDS.claude.fable,
        decision_kind: "progress",
      });
    }
  });

  it("U-ROUTE2-016b: first/next を含む原因調査は progress へ誤分類しない", () => {
    for (const task of [
      "What caused the first crash?",
      "What is the next error in this stack trace?",
      "障害は何から発生したか debug したい",
    ]) {
      expect(
        buildAdvisorDecision({
          task,
          mode: "hybrid",
          currentModel: MODEL_IDS.claude.opus,
        }),
      ).toMatchObject({
        provider: "codex",
        model: MODEL_IDS.codex.frontier,
        decision_kind: "troubleshooting",
      });
    }
  });

  it("U-ROUTE2-017: provider 強制は hybrid の単一路に限定し runtime-only 矛盾を fail-close する", () => {
    const forcedCodex = resolveAdvisorRoutes({
      decisionKind: "design",
      family: "opus",
      mode: "hybrid",
      forcedProvider: "codex",
    });
    expect(forcedCodex).toMatchObject({
      primary: { provider: "codex", model: MODEL_IDS.codex.frontier },
    });
    expect(forcedCodex).not.toHaveProperty("fallback");
    expect(() =>
      resolveAdvisorRoutes({
        decisionKind: "design",
        family: "opus",
        mode: "claude-only",
        forcedProvider: "codex",
      }),
    ).toThrow("advisor-provider-mode-conflict");
    expect(() =>
      resolveAdvisorRoutes({
        decisionKind: "troubleshooting",
        family: "opus",
        mode: "codex-only",
        forcedProvider: "claude",
      }),
    ).toThrow("advisor-provider-mode-conflict");
  });

  it("U-ROUTE2-010: 想定を下回る orchestrator は advisor 多用を推奨 (未知モデルは推奨側へ fail)", () => {
    expect(
      advisorHeavyUseRecommended({
        provider: "claude",
        phase: "design",
        currentModel: MODEL_IDS.claude.sonnet,
      }),
    ).toBe(true);
    expect(
      advisorHeavyUseRecommended({
        provider: "claude",
        phase: "design",
        currentModel: MODEL_IDS.claude.opus,
      }),
    ).toBe(false);
    expect(
      advisorHeavyUseRecommended({
        provider: "codex",
        phase: "implementation",
        currentModel: MODEL_IDS.codex.spark,
      }),
    ).toBe(true);
    expect(
      advisorHeavyUseRecommended({
        provider: "codex",
        phase: "design",
        currentModel: "unknown-model-id",
      }),
    ).toBe(true);
  });

  it("U-ROUTE2-012: effort ladder 基準 — sol/fable=low, opus/terra/sonnet=middle, luna/spark/mini=high", () => {
    const base = (model: string) => MODEL_EFFORT_LADDER[model]?.base;
    expect(base(MODEL_IDS.codex.frontier)).toBe("low");
    expect(base(MODEL_IDS.codex.worker)).toBe("middle");
    expect(base(MODEL_IDS.claude.fable)).toBe("low");
    expect(base(MODEL_IDS.claude.sonnet)).toBe("middle");
    expect(base(MODEL_IDS.claude.opus)).toBe("middle");
    expect(base(MODEL_IDS.codex.luna)).toBe("high");
    expect(base(MODEL_IDS.codex.spark)).toBe("high");
    expect(base(MODEL_IDS.codex.mini)).toBe("high");
  });

  // PO 2026-07-28:「xhigh 以上はモデル上げたほうがいい」。ラダーが既定として xhigh を配ると
  // 深さを effort で買う経路が固定化するため、base / shallow から xhigh を外し、行き止まり
  // (shallow も escalate も無い帯) を禁じる。明示 --effort xhigh (UI/UX 例外) は別経路。
  it("U-ROUTE2-014: ラダーは既定値として xhigh を配らず、全帯が次段を持つ", () => {
    for (const [model, ladder] of Object.entries(MODEL_EFFORT_LADDER)) {
      expect(ladder.base, `${model} base must not default to xhigh`).not.toBe("xhigh");
      expect(ladder.shallow, `${model} shallow must not default to xhigh`).not.toBe("xhigh");
      expect(
        Boolean(ladder.shallow) || Boolean(ladder.escalate),
        `${model} needs an effort step or a model step`,
      ).toBe(true);
    }
  });

  it("U-ROUTE2-013: 浅い回答のエスカレーション — effort 1 段、その先はモデル上げ (PO 2026-07-28)", () => {
    // terra: middle → high (effort) → sol low (モデル上げ)
    expect(
      escalateShallowResponse({ model: MODEL_IDS.codex.worker, currentEffort: "middle" }),
    ).toEqual({ model: MODEL_IDS.codex.worker, effort: "high" });
    expect(
      escalateShallowResponse({ model: MODEL_IDS.codex.worker, currentEffort: "high" }),
    ).toEqual({ model: MODEL_IDS.codex.frontier, effort: "low" });
    // sol: low → middle。frontier なのでその先は無い (advisor / 人間判断へ)
    expect(
      escalateShallowResponse({ model: MODEL_IDS.codex.frontier, currentEffort: "low" }),
    ).toEqual({ model: MODEL_IDS.codex.frontier, effort: "middle" });
    expect(
      escalateShallowResponse({ model: MODEL_IDS.codex.frontier, currentEffort: "middle" }),
    ).toBeNull();
    // opus: middle → high → sol low。改定前は shallow=xhigh だった (effort で深さを買っていた)
    expect(
      escalateShallowResponse({ model: MODEL_IDS.claude.opus, currentEffort: "middle" }),
    ).toEqual({ model: MODEL_IDS.claude.opus, effort: "high" });
    expect(
      escalateShallowResponse({ model: MODEL_IDS.claude.opus, currentEffort: "high" }),
    ).toEqual({ model: MODEL_IDS.codex.frontier, effort: "low" });
    // sonnet: middle → high → opus middle (族内でモデル上げ)
    expect(
      escalateShallowResponse({ model: MODEL_IDS.claude.sonnet, currentEffort: "high" }),
    ).toEqual({ model: MODEL_IDS.claude.opus, effort: "middle" });
    // base=high 帯 (luna / spark / mini) は shallow を持たず、base から直接モデル上げ。
    // 改定前は luna / spark が行き止まり、mini が base=xhigh だった。
    expect(escalateShallowResponse({ model: MODEL_IDS.codex.luna, currentEffort: "high" })).toEqual(
      { model: MODEL_IDS.codex.frontier, effort: "low" },
    );
    expect(
      escalateShallowResponse({ model: MODEL_IDS.codex.spark, currentEffort: "high" }),
    ).toEqual({ model: MODEL_IDS.codex.worker, effort: "middle" });
    expect(escalateShallowResponse({ model: MODEL_IDS.codex.mini, currentEffort: "high" })).toEqual(
      {
        model: MODEL_IDS.codex.worker,
        effort: "middle",
      },
    );
    // ラダー外モデルは対象外 (従来どおり null)
    expect(escalateShallowResponse({ model: "unknown-model", currentEffort: "low" })).toBeNull();
  });

  it("U-ROUTE2-011: レビュー 3 面と プランエージェント (fable 一次 / sol fallback) の正本", () => {
    expect(REVIEW_LANES).toEqual(["design-review", "implementation-review", "blind-review"]);
    for (const lane of REVIEW_LANES) {
      expect(REVIEW_LANE_MODELS[lane]).toEqual({
        claude: MODEL_IDS.claude.opus,
        codex: MODEL_IDS.codex.frontier,
      });
    }
    expect(PLAN_AGENT_MODELS).toEqual({
      primary: MODEL_IDS.claude.fable,
      fallback: MODEL_IDS.codex.frontier,
    });
  });
});
