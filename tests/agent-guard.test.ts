import { describe, expect, it } from "vitest";
import {
  type AgentGuardContext,
  type AgentGuardInput,
  evaluateAgentGuard,
  normalizeModelFamily,
  type ResolvedFamily,
  SUBAGENT_ALLOWLIST,
} from "../src/runtime/agent-guard";
import { AGENT_GUARD_BYPASS_HINT, AGENT_TOOL_NAME } from "../src/runtime/agent-guard-policy";

const FAMILIES: Record<string, ResolvedFamily> = {
  "pmo-sonnet": "sonnet",
  "pmo-haiku": "haiku",
  "refactor-scout": "haiku",
  "pdm-tech-innovation": "opus",
  "code-reviewer": "sonnet",
  "ut-tdd-tl": "sonnet",
};
const legacyRuntimeCommand = `${["he", "lix"].join("")} codex`;

function ctx(allowRaw = false): AgentGuardContext {
  return {
    allowRaw,
    resolveAgentFamily: (s) => FAMILIES[s] ?? "missing",
  };
}

function agent(tool_input: AgentGuardInput["tool_input"]): AgentGuardInput {
  return { tool_name: "Agent", tool_input };
}

describe("normalizeModelFamily", () => {
  it("normalizes family names and Anthropic model ids", () => {
    expect(normalizeModelFamily("sonnet")).toBe("sonnet");
    expect(normalizeModelFamily("claude-sonnet-4-6")).toBe("sonnet");
    expect(normalizeModelFamily("claude-haiku-4-5-20251001")).toBe("haiku");
    expect(normalizeModelFamily("claude-opus-4-7")).toBe("opus");
  });
  it("returns null for empty / non-Claude models", () => {
    expect(normalizeModelFamily("")).toBeNull();
    expect(normalizeModelFamily(null)).toBeNull();
    expect(normalizeModelFamily("gpt-5.5")).toBeNull();
  });
  it("returns null for ambiguous strings containing multiple families", () => {
    expect(normalizeModelFamily("sonnet-opus")).toBeNull();
    expect(normalizeModelFamily("haiku/sonnet")).toBeNull();
  });
});

describe("evaluateAgentGuard", () => {
  it("loads guard policy from the externalized policy module", () => {
    expect(AGENT_TOOL_NAME).toBe("Agent");
    expect(AGENT_GUARD_BYPASS_HINT).toContain("UT_TDD_ALLOW_RAW_AGENT");
  });

  it("passes non-Agent tools untouched", () => {
    expect(evaluateAgentGuard({ tool_name: "Bash" }, ctx()).code).toBe(0);
    expect(evaluateAgentGuard({ tool_name: "Edit" }, ctx()).code).toBe(0);
  });

  it("blocks missing subagent_type (general-purpose default route)", () => {
    expect(evaluateAgentGuard(agent({}), ctx()).code).toBe(2);
  });

  it("treats Task as a Claude subagent tool alias", () => {
    expect(
      evaluateAgentGuard(
        { tool_name: "Task", tool_input: { subagent_type: "pmo-sonnet", model: "sonnet" } },
        ctx(),
      ).code,
    ).toBe(0);
    expect(evaluateAgentGuard({ tool_name: "Task", tool_input: {} }, ctx()).code).toBe(2);
  });

  it("treats Codex spawn_agent as a guarded subagent spawn surface", () => {
    expect(
      evaluateAgentGuard(
        { tool_name: "spawn_agent", tool_input: { subagent_type: "pmo-sonnet", model: "sonnet" } },
        ctx(),
      ).code,
    ).toBe(0);
    expect(
      evaluateAgentGuard(
        { tool_name: "spawn_agent", tool_input: { agent: "pmo-sonnet", model_family: "sonnet" } },
        ctx(),
      ).code,
    ).toBe(0);
    expect(evaluateAgentGuard({ tool_name: "spawn_agent", tool_input: {} }, ctx()).code).toBe(2);
  });

  it("blocks null / omitted tool_input (fail-close)", () => {
    expect(evaluateAgentGuard({ tool_name: "Agent", tool_input: null }, ctx()).code).toBe(2);
    expect(evaluateAgentGuard({ tool_name: "Agent" }, ctx()).code).toBe(2);
  });

  it("blocks non-allowlisted subagent even with valid model", () => {
    const d = evaluateAgentGuard(agent({ subagent_type: "be-logic", model: "sonnet" }), ctx());
    expect(d.code).toBe(2);
    expect(d.message).toContain("not allowlisted");
    expect(d.message).toContain("ut-tdd codex --role");
    expect(d.message).not.toContain(legacyRuntimeCommand);
  });

  it("blocks an unnormalizable or ambiguous model on an allowlisted agent", () => {
    expect(
      evaluateAgentGuard(agent({ subagent_type: "pmo-sonnet", model: "gpt-5.5" }), ctx()).code,
    ).toBe(2);
    expect(
      evaluateAgentGuard(agent({ subagent_type: "pmo-sonnet", model: "sonnet-opus" }), ctx()).code,
    ).toBe(2);
  });

  it("blocks omitted model (strict explicit model required)", () => {
    const d = evaluateAgentGuard(agent({ subagent_type: "pmo-sonnet" }), ctx());
    expect(d.code).toBe(2);
    expect(d.message).toContain("model");
  });

  it("allows explicit model matching the agent's frontmatter family", () => {
    expect(
      evaluateAgentGuard(agent({ subagent_type: "pmo-sonnet", model: "sonnet" }), ctx()).code,
    ).toBe(0);
    expect(
      evaluateAgentGuard(agent({ subagent_type: "pmo-haiku", model: "haiku" }), ctx()).code,
    ).toBe(0);
    expect(
      evaluateAgentGuard(agent({ subagent_type: "refactor-scout", model: "haiku" }), ctx()).code,
    ).toBe(0);
    expect(
      evaluateAgentGuard(agent({ subagent_type: "ut-tdd-tl", model: "sonnet" }), ctx()).code,
    ).toBe(0);
  });

  it("blocks opus override on a sonnet-family agent", () => {
    const d = evaluateAgentGuard(agent({ subagent_type: "pmo-sonnet", model: "opus" }), ctx());
    expect(d.code).toBe(2);
    expect(d.message).toContain("override");
  });

  it("allows opus for an opus-frontmatter agent (pdm-*)", () => {
    expect(
      evaluateAgentGuard(agent({ subagent_type: "pdm-tech-innovation", model: "opus" }), ctx())
        .code,
    ).toBe(0);
  });

  it("blocks an allowlisted subagent whose definition file is missing", () => {
    // pmo-tech-docs is allowlisted but intentionally absent from this test resolver.
    expect(SUBAGENT_ALLOWLIST.has("pmo-tech-docs")).toBe(true);
    const d = evaluateAgentGuard(agent({ subagent_type: "pmo-tech-docs", model: "sonnet" }), ctx());
    expect(d.code).toBe(2);
  });

  it("bypasses block when allowRaw is set", () => {
    const d = evaluateAgentGuard(agent({ subagent_type: "be-logic", model: "sonnet" }), ctx(true));
    expect(d.code).toBe(0);
    expect(d.bypassed).toBe(true);
  });
});
