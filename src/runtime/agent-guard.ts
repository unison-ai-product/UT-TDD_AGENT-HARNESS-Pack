/**
 * UT-TDD subagent guard (issue #1002, contract: docs/design/harness/L6-function-design/agent-guard-delegation-boundary.md).
 *
 * Claude Code Agent calls are controlled fail-closed against a closed set of generic types:
 * G1 envelope without tool_name -> BLOCK (never bypassed).
 * G2 non-Agent tools pass.
 * G3 subagent_type outside GENERIC_SUBAGENT_TYPES -> BLOCK.
 * G4 missing model -> BLOCK.  G5 un-normalizable / ambiguous model -> BLOCK.
 * G6 fable -> BLOCK (apex tier stays with the judgement layer, i.e. the delegation path).
 * There is no model floor here: the floor lives in the delegation routing (src/team/delegation-routing.ts).
 * A subagent has no closing authority; its output is never a verdict or a merge basis.
 *
 * This module is pure: no filesystem, no environment. The hook shim owns stdin and exit codes.
 */

import {
  AGENT_GUARD_BYPASS_HINT,
  AGENT_TOOL_NAMES,
  CLAUDE_MODEL_FAMILY_CATALOG,
  GENERIC_SUBAGENT_TYPES,
} from "./agent-guard-policy.ts";

export type ModelFamily = keyof typeof CLAUDE_MODEL_FAMILY_CATALOG;

const MODEL_FAMILY_CATALOG = Object.entries(CLAUDE_MODEL_FAMILY_CATALOG) as Array<
  [ModelFamily, string]
>;
const MODEL_FAMILIES = MODEL_FAMILY_CATALOG.map(([family]) => family);
const MODEL_FAMILY_TEXT = MODEL_FAMILIES.join(" / ");
const GENERIC_TYPES_TEXT = [...GENERIC_SUBAGENT_TYPES].join(" / ");

export interface AgentGuardInput {
  tool_name?: string;
  tool_input?: {
    subagent_type?: string;
    agent_type?: string;
    agent?: string;
    role?: string;
    name?: string;
    model?: string;
    model_family?: string;
  } | null;
}

export interface AgentGuardContext {
  allowRaw: boolean;
}

export interface GuardDecision {
  code: 0 | 2;
  message?: string;
  bypassed?: boolean;
}

/** Normalize model family names and Anthropic model ids. Ambiguous values fail closed. */
export function normalizeModelFamily(raw: string | null | undefined): ModelFamily | null {
  if (!raw) return null;
  const normalizedRaw = raw.toLowerCase();
  const hits = new Set<ModelFamily>();
  for (const [family, modelId] of MODEL_FAMILY_CATALOG) {
    if (normalizedRaw === modelId.toLowerCase() || new RegExp(`\\b${family}\\b`, "i").test(raw)) {
      hits.add(family);
    }
  }
  return hits.size === 1 ? [...hits][0] : null;
}

function firstString(...values: Array<string | undefined>): string {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim() ?? "";
}

export function evaluateAgentGuard(input: AgentGuardInput, ctx: AgentGuardContext): GuardDecision {
  // G1: an envelope without tool_name (empty stdin parsed as {}) cannot be verified: fail closed.
  if (typeof input.tool_name !== "string" || input.tool_name.length === 0) {
    return {
      code: 2,
      message: "[ut-tdd-guard] BLOCK: hook envelope has no tool_name (fail-close).",
    };
  }
  // G2
  if (!AGENT_TOOL_NAMES.has(input.tool_name)) return { code: 0 };

  const ti = input.tool_input ?? {};
  // An empty type resolves to general-purpose (the Claude Code default).
  const subagentType =
    firstString(ti.subagent_type, ti.agent_type, ti.agent, ti.role, ti.name) || "general-purpose";
  const model = firstString(ti.model, ti.model_family);

  const blockOrBypass = (message: string): GuardDecision =>
    ctx.allowRaw
      ? {
          code: 0,
          bypassed: true,
          message: `[ut-tdd-guard] WARN: UT_TDD_ALLOW_RAW_AGENT=1 bypassed.
${message}`,
        }
      : { code: 2, message };

  // G3
  if (!GENERIC_SUBAGENT_TYPES.has(subagentType)) {
    return blockOrBypass(
      `[ut-tdd-guard] BLOCK: subagent_type=${subagentType} is not an allowed generic type.
` +
        `Allowed types: ${GENERIC_TYPES_TEXT}.
${AGENT_GUARD_BYPASS_HINT}`,
    );
  }
  // G4
  if (!model) {
    return blockOrBypass(
      `[ut-tdd-guard] BLOCK: subagent_type=${subagentType} call is missing model.
` +
        `Pass an explicit model (${MODEL_FAMILY_TEXT}).
${AGENT_GUARD_BYPASS_HINT}`,
    );
  }
  // G5
  const requested = normalizeModelFamily(model);
  if (requested === null) {
    return blockOrBypass(
      `[ut-tdd-guard] BLOCK: model=${model} cannot be normalized to ${MODEL_FAMILY_TEXT}.`,
    );
  }
  // G6
  if (requested === "fable") {
    return blockOrBypass(
      `[ut-tdd-guard] BLOCK: Agent tool では fable を使えない (apex tier は判断の層 = 委譲経路に残す)。
subagent_type=${subagentType}`,
    );
  }
  return { code: 0 };
}
