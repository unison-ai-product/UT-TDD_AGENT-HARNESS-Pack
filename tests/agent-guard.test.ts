import { describe, expect, it } from "vitest";
import {
  type AgentGuardContext,
  type AgentGuardInput,
  evaluateAgentGuard,
  normalizeModelFamily,
} from "../src/runtime/agent-guard.ts";
import {
  AGENT_GUARD_BYPASS_HINT,
  AGENT_TOOL_NAME,
  CLAUDE_MODEL_FAMILY_CATALOG,
} from "../src/runtime/agent-guard-policy.ts";

const legacyRuntimeCommand = `${["he", "lix"].join("")} codex`;

function ctx(allowRaw = false): AgentGuardContext {
  return { allowRaw };
}

function agent(tool_input: AgentGuardInput["tool_input"]): AgentGuardInput {
  return { tool_name: "Agent", tool_input };
}

describe("normalizeModelFamily", () => {
  it("uses the approved Claude model IDs in the guard catalog", () => {
    expect(CLAUDE_MODEL_FAMILY_CATALOG).toEqual({
      haiku: "claude-haiku-5-5",
      sonnet: "claude-sonnet-5-5",
      opus: "claude-opus-5-5",
      fable: "claude-fable-5-2",
    });
  });

  it("normalizes family names and Anthropic model ids", () => {
    expect(normalizeModelFamily("sonnet")).toBe("sonnet");
    expect(normalizeModelFamily("claude-sonnet-4-6")).toBe("sonnet");
    expect(normalizeModelFamily("claude-haiku-4-5-20251001")).toBe("haiku");
    expect(normalizeModelFamily("claude-opus-4-7")).toBe("opus");
    expect(normalizeModelFamily("fable")).toBe("fable");
    // Legacy model IDs remain normalizable; this is not the active guard catalog.
    expect(normalizeModelFamily("claude-fable-5")).toBe("fable");
    expect(normalizeModelFamily("claude-fable-5-1")).toBe("fable");
    expect(normalizeModelFamily("claude-fable-5-2")).toBe("fable");
    expect(normalizeModelFamily("claude-opus-5-5")).toBe("opus");
    expect(normalizeModelFamily("claude-sonnet-5-5")).toBe("sonnet");
    expect(normalizeModelFamily("claude-haiku-5-5")).toBe("haiku");
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

  it("blocks an envelope without tool_name (empty stdin parses to {}), even with allowRaw", () => {
    for (const allowRaw of [false, true]) {
      const d = evaluateAgentGuard({}, ctx(allowRaw));
      expect(d.code).toBe(2);
      expect(d.message).toContain("no tool_name");
      expect(evaluateAgentGuard({ tool_name: "" }, ctx(allowRaw)).code).toBe(2);
    }
  });

  it("blocks the default route (no subagent_type) when the model is missing", () => {
    expect(evaluateAgentGuard(agent({}), ctx()).code).toBe(2);
  });

  it("treats Task as a Claude subagent tool alias", () => {
    expect(
      evaluateAgentGuard(
        { tool_name: "Task", tool_input: { subagent_type: "Explore", model: "sonnet" } },
        ctx(),
      ).code,
    ).toBe(0);
    expect(evaluateAgentGuard({ tool_name: "Task", tool_input: {} }, ctx()).code).toBe(2);
  });

  it("treats Codex spawn_agent as a guarded subagent spawn surface", () => {
    expect(
      evaluateAgentGuard(
        { tool_name: "spawn_agent", tool_input: { subagent_type: "Plan", model: "sonnet" } },
        ctx(),
      ).code,
    ).toBe(0);
    expect(
      evaluateAgentGuard(
        { tool_name: "spawn_agent", tool_input: { agent: "claude", model_family: "sonnet" } },
        ctx(),
      ).code,
    ).toBe(0);
    expect(evaluateAgentGuard({ tool_name: "spawn_agent", tool_input: {} }, ctx()).code).toBe(2);
  });

  it("blocks null / omitted tool_input (fail-close)", () => {
    expect(evaluateAgentGuard({ tool_name: "Agent", tool_input: null }, ctx()).code).toBe(2);
    expect(evaluateAgentGuard({ tool_name: "Agent" }, ctx()).code).toBe(2);
  });

  it("passes a generic subagent with an explicit model (#1002)", () => {
    for (const subagent_type of ["general-purpose", "Explore", "Plan", "claude", undefined]) {
      for (const model of ["sonnet", "haiku", "opus", "claude-sonnet-5-5"]) {
        expect(evaluateAgentGuard(agent({ subagent_type, model }), ctx()).code).toBe(0);
      }
    }
  });

  it("blocks a generic subagent without a model, with an unnormalizable model, or with fable", () => {
    const missing = evaluateAgentGuard(agent({ subagent_type: "general-purpose" }), ctx());
    expect(missing.code).toBe(2);
    expect(missing.message).toContain("missing model");
    expect(missing.message).not.toContain(legacyRuntimeCommand);
    expect(
      evaluateAgentGuard(agent({ subagent_type: "general-purpose", model: "gpt-6-luna" }), ctx())
        .code,
    ).toBe(2);
    const fable = evaluateAgentGuard(agent({ subagent_type: "Explore", model: "fable" }), ctx());
    expect(fable.code).toBe(2);
    expect(fable.message).toContain("fable");
  });

  it("blocks a retired definition-based type even with a valid model", () => {
    for (const subagent_type of ["pmo-sonnet", "blind-reviewer", "be-api", "unknown-type"]) {
      const d = evaluateAgentGuard(agent({ subagent_type, model: "sonnet" }), ctx());
      expect(d.code, subagent_type).toBe(2);
      expect(d.message, subagent_type).toContain("general-purpose");
    }
  });

  it("bypasses block when allowRaw is set", () => {
    const d = evaluateAgentGuard(agent({ subagent_type: "general-purpose" }), ctx(true));
    expect(d.code).toBe(0);
    expect(d.bypassed).toBe(true);
  });
});
