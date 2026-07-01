import { describe, expect, it } from "vitest";
import { inferTaskDifficulty, selectTeamModel } from "../src/team/model-policy";

describe("team model policy", () => {
  it("infers critical difficulty from high-risk task terms", () => {
    expect(inferTaskDifficulty({ task: "DB schema migration for production auth" })).toEqual({
      difficulty: "critical",
      source: "inferred",
    });
  });

  it("uses fast codex model and low effort for trivial work", () => {
    const selection = selectTeamModel({
      provider: "codex",
      role: "docs",
      engine: "codex-pg",
      task: "README typo",
    });

    expect(selection).toMatchObject({
      difficulty: "trivial",
      model_family: "fast",
      model: "gpt-5.3-codex-spark",
      reasoning_effort: "low",
    });
  });

  it("uses frontier model and high effort for critical codex work", () => {
    const selection = selectTeamModel({
      provider: "codex",
      role: "tl",
      engine: "codex-tl",
      task: "production security migration",
    });

    expect(selection).toMatchObject({
      difficulty: "critical",
      model_family: "frontier",
      // frontier = T0 最上位。tier-router TIER_TABLE.T0.codex (gpt-5.5) と整合 (PLAN-L7-75 reconcile)。
      model: "gpt-5.5",
      reasoning_effort: "high",
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
    expect(selection.model).toBe("claude-sonnet-4-6");
    expect(selection.model_source).toBe("engine");
    expect(selection.reasoning_effort).toBe("high");
  });

  it("honors explicit difficulty, model, and effort overrides", () => {
    const selection = selectTeamModel({
      provider: "codex",
      role: "se",
      engine: "codex-se",
      task: "implement",
      difficulty: "simple",
      model: "gpt-custom",
      effort: "high",
    });

    expect(selection).toMatchObject({
      difficulty: "simple",
      difficulty_source: "explicit",
      model: "gpt-custom",
      model_source: "explicit",
      reasoning_effort: "high",
      effort_source: "explicit",
    });
  });
});
