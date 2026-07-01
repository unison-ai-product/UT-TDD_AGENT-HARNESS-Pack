import { describe, expect, it } from "vitest";
import { VALID_ORCHESTRATION_MODES } from "../src/schema";
import { resolveVmodelInjection } from "../src/vmodel/injection";

describe("vmodel layer-context injection", () => {
  it("returns the five required injection keys for drive x layer", () => {
    const injection = resolveVmodelInjection("db", "L7");

    expect(injection.drive).toBe("db");
    expect(injection.layer).toBe("L7");
    expect(injection.owner_role).toBe("se");
    expect(injection.mandatory_agents).toContain("dba-reviewer");
    expect(injection.recommended_skills).toContain("data-migration");
    expect(injection.recommended_commands).toContain("ut-tdd doctor");
    expect(VALID_ORCHESTRATION_MODES).toContain(injection.orchestration_mode);
  });

  it("keeps hybrid-only work explicit through orchestration_mode", () => {
    const injection = resolveVmodelInjection("agent", "L7");

    expect(injection.orchestration_mode).toBe("claude_judge_codex_impl");
    expect(injection.mandatory_agents).toContain("frontier-reviewer");
  });

  it("records execution-mode degradation without silent fallback", () => {
    const injection = resolveVmodelInjection("agent", "L7", { executionMode: "claude-only" });

    expect(injection.orchestration_mode).toBe("claude_judge_codex_impl");
    expect(injection.execution_mode).toBe("claude-only");
    expect(injection.degraded_from).toBe("claude_judge_codex_impl");
    expect(injection.degraded_to).toBe("claude_design_impl");
    expect(injection.degradation_reason).toContain("claude-only");

    const hybrid = resolveVmodelInjection("agent", "L7", { executionMode: "hybrid" });
    expect(hybrid.degraded_from).toBeUndefined();
    expect(hybrid.degraded_to).toBeUndefined();
  });

  it("rejects invalid drive or layer values", () => {
    expect(() => resolveVmodelInjection("reverse", "L7")).toThrow();
    expect(() => resolveVmodelInjection("db", "L15")).toThrow();
  });
});
