import { describe, expect, it } from "vitest";
import { recommendTeamLaunch } from "../src/team/launch-policy";
import { buildTeamRunPlan } from "../src/team/run";

describe("U-TEAM-003 team launch policy", () => {
  it("U-TEAM-003: does not launch a team for trivial work in hybrid mode", () => {
    const result = recommendTeamLaunch({
      task: "fix README typo",
      mode: "hybrid",
    });

    expect(result).toMatchObject({
      should_launch: false,
      difficulty: "trivial",
      trigger: "simple",
    });
    expect(result.definition).toBeUndefined();
  });

  it("U-TEAMRUN-003: recommends a cross-provider team for critical risk work", () => {
    const result = recommendTeamLaunch({
      task: "production security schema migration",
      mode: "hybrid",
    });

    expect(result).toMatchObject({
      should_launch: true,
      difficulty: "critical",
      trigger: "risk",
    });
    expect(result.definition?.members.map((member) => member.role)).toEqual(["se", "tl", "qa"]);
    expect(result.definition?.members.map((member) => member.engine)).toEqual([
      "codex-se",
      "pmo-sonnet",
      "claude-qa",
    ]);

    expect(result.definition).toBeDefined();
    if (!result.definition) throw new Error("expected team definition");
    const plan = buildTeamRunPlan(result.definition, "hybrid");
    expect(plan.ok).toBe(true);
    expect(plan.strategy).toBe("sequential");
    expect(plan.members.map((member) => member.provider)).toEqual(["codex", "claude", "claude"]);
    expect(plan.members.every((member) => member.model_selection.reasoning_effort === "high")).toBe(
      true,
    );
  });

  it("U-TEAM-003: launches for standard non-risk work by difficulty", () => {
    const result = recommendTeamLaunch({
      task: "implement reporting workflow",
      mode: "hybrid",
    });

    expect(result).toMatchObject({
      should_launch: true,
      difficulty: "standard",
      trigger: "difficulty",
    });
    expect(result.definition?.members.map((member) => member.role)).toEqual(["se", "tl"]);
    expect(result.definition?.members.some((member) => member.serialize_after)).toBe(false);
  });

  it("U-TEAM-003: launches for trivial work when a risk term is present", () => {
    const result = recommendTeamLaunch({
      task: "fix README typo for windows setup",
      mode: "hybrid",
    });

    expect(result).toMatchObject({
      should_launch: true,
      difficulty: "trivial",
      trigger: "risk",
    });
    expect(result.definition?.members.map((member) => member.role)).toEqual(["se", "tl"]);
  });

  it("U-TEAMRUN-003: serializes complex review after implementation", () => {
    const result = recommendTeamLaunch({
      task: "refactor runtime adapter",
      mode: "hybrid",
    });

    expect(result).toMatchObject({
      should_launch: true,
      difficulty: "complex",
    });
    expect(result.definition?.members[1]).toMatchObject({
      role: "tl",
      serialize_after: "se",
    });
  });

  it("U-TEAM-003: does not silently launch team flow outside hybrid mode", () => {
    const result = recommendTeamLaunch({
      task: "subagent runtime adapter refactor",
      mode: "codex-only",
    });

    expect(result).toMatchObject({
      should_launch: false,
      difficulty: "complex",
      trigger: "unavailable",
    });
    expect(result.reason).toContain("requires hybrid mode");
  });
});
