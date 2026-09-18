/**
 * UT-TDD subagent guard.
 *
 * Claude Code Agent calls are controlled fail-closed:
 * 1. Missing subagent_type is blocked.
 * 2. Non-allowlisted subagents are blocked.
 * 3. Missing model is blocked.
 * 4. Calls that request a model family *below* the one declared in frontmatter are
 *    blocked (no quiet downgrade / cost-cutting). Requesting a family *at or above*
 *    the declared floor is allowed (PLAN-L7-399): review-critical subagents
 *    (blind-reviewer / code-reviewer / ut-tdd-tl / security-audit / qa-test) declare a sonnet floor,
 *    but a higher-tier orchestrator (opus) must be able to escalate a review to its
 *    own tier or above — pinning review strictly below the orchestrator inverts the
 *    "review >= orchestrator" invariant the harness otherwise enforces via
 *    src/task/tier-router-policy.ts's tierFor() (consult/verify roles always T0).
 *
 * This module is pure. The hook shim owns stdin and filesystem access.
 */

import {
  AGENT_GUARD_BYPASS_HINT,
  AGENT_TOOL_NAMES,
  CLAUDE_MODEL_FAMILY_CATALOG,
  SUBAGENT_ALLOWLIST,
} from "./agent-guard-policy.ts";

export type ModelFamily = keyof typeof CLAUDE_MODEL_FAMILY_CATALOG;

/** Capability floor ordering. Higher rank = strictly more capable, never a valid "downgrade" target. */
const FAMILY_RANK: Record<ModelFamily, number> = { haiku: 0, sonnet: 1, opus: 2, fable: 3 };
const MODEL_FAMILY_CATALOG = Object.entries(CLAUDE_MODEL_FAMILY_CATALOG) as Array<
  [ModelFamily, string]
>;
const MODEL_FAMILIES = MODEL_FAMILY_CATALOG.map(([family]) => family);
const MODEL_FAMILY_TEXT = MODEL_FAMILIES.join(" / ");

// PLAN-L7-414: fable is an apex tier reserved for judgement gates, never worker consumption.
const FABLE_QUALITY_CHECK_SUBAGENTS = new Set([
  "blind-reviewer",
  "code-reviewer",
  "ut-tdd-tl",
  "security-audit",
  "qa-test",
]);

export { SUBAGENT_ALLOWLIST } from "./agent-guard-policy.ts";

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

export type ResolvedFamily = ModelFamily | "missing" | "unknown";

export interface AgentGuardContext {
  resolveAgentFamily: (subagentType: string) => ResolvedFamily;
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

const ALLOWLIST_TEXT = [...SUBAGENT_ALLOWLIST].join(" ");

function firstString(...values: Array<string | undefined>): string {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim() ?? "";
}

export function evaluateAgentGuard(input: AgentGuardInput, ctx: AgentGuardContext): GuardDecision {
  if (!AGENT_TOOL_NAMES.has(input.tool_name ?? "")) return { code: 0 };

  const ti = input.tool_input ?? {};
  const subagentType = firstString(ti.subagent_type, ti.agent_type, ti.agent, ti.role, ti.name);
  const model = firstString(ti.model, ti.model_family);

  const blockOrBypass = (message: string): GuardDecision =>
    ctx.allowRaw
      ? {
          code: 0,
          bypassed: true,
          message: `[ut-tdd-guard] WARN: UT_TDD_ALLOW_RAW_AGENT=1 bypassed.\n${message}`,
        }
      : { code: 2, message };

  if (!subagentType) {
    return blockOrBypass(
      `[ut-tdd-guard] BLOCK: Agent call is missing subagent_type.\nAllowed: ${ALLOWLIST_TEXT}\n${AGENT_GUARD_BYPASS_HINT}`,
    );
  }

  if (!SUBAGENT_ALLOWLIST.has(subagentType)) {
    return blockOrBypass(
      `[ut-tdd-guard] BLOCK: subagent_type=${subagentType} is not allowlisted.\n` +
        `Allowed: ${ALLOWLIST_TEXT}\n` +
        `Use an approved subagent or route provider work through ut-tdd codex --role ...\n${AGENT_GUARD_BYPASS_HINT}`,
    );
  }

  const family = ctx.resolveAgentFamily(subagentType);
  if (family === "missing") {
    return {
      code: 2,
      message: `[ut-tdd-guard] BLOCK: .claude/agents/${subagentType}.md is missing.`,
    };
  }
  if (family === "unknown") {
    return {
      code: 2,
      message: `[ut-tdd-guard] BLOCK: ${subagentType} frontmatter does not declare ${MODEL_FAMILY_TEXT} model family.`,
    };
  }

  if (!model) {
    return blockOrBypass(
      `[ut-tdd-guard] BLOCK: subagent_type=${subagentType} call is missing model.\n` +
        `Use model: "${family}".\n${AGENT_GUARD_BYPASS_HINT}`,
    );
  }

  const requested = normalizeModelFamily(model);
  if (requested === null) {
    return blockOrBypass(
      `[ut-tdd-guard] BLOCK: model=${model} cannot be normalized to ${MODEL_FAMILY_TEXT}.`,
    );
  }
  if (requested === "fable" && !FABLE_QUALITY_CHECK_SUBAGENTS.has(subagentType)) {
    return blockOrBypass(
      `[ut-tdd-guard] BLOCK: apex-tier policy reserves fable for quality-check subagents ` +
        `(blind-reviewer / code-reviewer / ut-tdd-tl / security-audit / qa-test); ${subagentType} is not eligible.`,
    );
  }
  if (FAMILY_RANK[requested] < FAMILY_RANK[family]) {
    return blockOrBypass(
      `[ut-tdd-guard] BLOCK: model downgrade detected.\n` +
        `  subagent_type: ${subagentType}\n` +
        `  declared floor: ${family}\n` +
        `  requested model: ${model} (family: ${requested})\n${AGENT_GUARD_BYPASS_HINT}`,
    );
  }

  return { code: 0 };
}
