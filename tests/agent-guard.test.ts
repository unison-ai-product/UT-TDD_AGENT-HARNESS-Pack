import { describe, expect, it } from "vitest";
import {
  type AgentGuardContext,
  type AgentGuardInput,
  evaluateAgentGuard,
  normalizeModelFamily,
  type ResolvedFamily,
  SUBAGENT_ALLOWLIST,
} from "../src/runtime/agent-guard.ts";
import { AGENT_GUARD_BYPASS_HINT, AGENT_TOOL_NAME } from "../src/runtime/agent-guard-policy.ts";

const FAMILIES: Record<string, ResolvedFamily> = {
  "be-api": "sonnet",
  "be-logic": "sonnet",
  "db-schema": "sonnet",
  "devops-deploy": "sonnet",
  "pmo-sonnet": "sonnet",
  "pmo-haiku": "haiku",
  "refactor-scout": "haiku",
  "pdm-tech-innovation": "opus",
  "code-reviewer": "sonnet",
  "blind-reviewer": "opus",
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
    expect(normalizeModelFamily("fable")).toBe("fable");
    expect(normalizeModelFamily("claude-fable-5")).toBe("fable");
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
    const d = evaluateAgentGuard(agent({ subagent_type: "rogue-agent", model: "sonnet" }), ctx());
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
      evaluateAgentGuard(agent({ subagent_type: "be-logic", model: "sonnet" }), ctx()).code,
    ).toBe(0);
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

  // PLAN-L7-399: model family is a capability *floor*, not an exact pin. An opus-tier
  // orchestrator must be able to escalate a review-critical subagent to its own tier
  // (review >= orchestrator, matching tier-router's tierFor() T0-for-consult/verify
  // invariant) instead of being stuck asking a permanently-lower-tier subagent to
  // review its work.
  it("allows escalating a sonnet-family agent to opus (upgrade, not a downgrade)", () => {
    const d = evaluateAgentGuard(agent({ subagent_type: "pmo-sonnet", model: "opus" }), ctx());
    expect(d.code).toBe(0);
  });

  it("blocks haiku on a sonnet-family agent (downgrade)", () => {
    const d = evaluateAgentGuard(agent({ subagent_type: "pmo-sonnet", model: "haiku" }), ctx());
    expect(d.code).toBe(2);
    expect(d.message).toContain("downgrade");
  });

  it("blocks sonnet or haiku on an opus-family agent (downgrade)", () => {
    const sonnetDowngrade = evaluateAgentGuard(
      agent({ subagent_type: "pdm-tech-innovation", model: "sonnet" }),
      ctx(),
    );
    expect(sonnetDowngrade.code).toBe(2);
    expect(sonnetDowngrade.message).toContain("downgrade");
    expect(
      evaluateAgentGuard(agent({ subagent_type: "pdm-tech-innovation", model: "haiku" }), ctx())
        .code,
    ).toBe(2);
  });

  it("allows opus for an opus-frontmatter agent (pdm-*)", () => {
    expect(
      evaluateAgentGuard(agent({ subagent_type: "pdm-tech-innovation", model: "opus" }), ctx())
        .code,
    ).toBe(0);
  });

  it("allows escalating review-critical subagents (code-reviewer/ut-tdd-tl) to opus", () => {
    expect(
      evaluateAgentGuard(agent({ subagent_type: "code-reviewer", model: "opus" }), ctx()).code,
    ).toBe(0);
    expect(
      evaluateAgentGuard(agent({ subagent_type: "ut-tdd-tl", model: "opus" }), ctx()).code,
    ).toBe(0);
  });

  it("allows fable only for quality-check subagents", () => {
    expect(
      evaluateAgentGuard(agent({ subagent_type: "code-reviewer", model: "fable" }), ctx()).code,
    ).toBe(0);
    expect(
      evaluateAgentGuard(agent({ subagent_type: "blind-reviewer", model: "fable" }), ctx()).code,
    ).toBe(0);
  });

  it("blocks fable for worker subagents even when it satisfies their capability floor", () => {
    const d = evaluateAgentGuard(agent({ subagent_type: "be-logic", model: "fable" }), ctx());
    expect(d.code).toBe(2);
    expect(d.message).toContain("apex-tier policy");
  });

  it("allows opus on the blind-reviewer gate subagent and blocks any downgrade", () => {
    expect(SUBAGENT_ALLOWLIST.has("blind-reviewer")).toBe(true);
    expect(
      evaluateAgentGuard(agent({ subagent_type: "blind-reviewer", model: "opus" }), ctx()).code,
    ).toBe(0);
    const sonnetDowngrade = evaluateAgentGuard(
      agent({ subagent_type: "blind-reviewer", model: "sonnet" }),
      ctx(),
    );
    expect(sonnetDowngrade.code).toBe(2);
    expect(sonnetDowngrade.message).toContain("downgrade");
    expect(
      evaluateAgentGuard(agent({ subagent_type: "blind-reviewer", model: "haiku" }), ctx()).code,
    ).toBe(2);
  });

  it("blocks an allowlisted subagent whose definition file is missing", () => {
    // pmo-tech-docs is allowlisted but intentionally absent from this test resolver.
    expect(SUBAGENT_ALLOWLIST.has("pmo-tech-docs")).toBe(true);
    const d = evaluateAgentGuard(agent({ subagent_type: "pmo-tech-docs", model: "sonnet" }), ctx());
    expect(d.code).toBe(2);
  });

  it("bypasses block when allowRaw is set", () => {
    const d = evaluateAgentGuard(
      agent({ subagent_type: "rogue-agent", model: "sonnet" }),
      ctx(true),
    );
    expect(d.code).toBe(0);
    expect(d.bypassed).toBe(true);
  });
});
