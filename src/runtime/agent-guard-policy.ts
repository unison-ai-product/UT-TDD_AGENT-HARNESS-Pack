/**
 * Closed set of subagent_type values the Agent tool may use (issue #1002).
 * Matching is exact (case-sensitive; only surrounding whitespace is trimmed).
 * Specialization is passed as skills / decision packs / design excerpts, not by type name.
 * Adding a type requires revising docs/design/harness/L6-function-design/agent-guard-delegation-boundary.md.
 */
export const GENERIC_SUBAGENT_TYPES: ReadonlySet<string> = new Set([
  "general-purpose",
  "Explore",
  "Plan",
  "claude",
]);

/**
 * Role names (not definition files) that get the Codex workspace-write sandbox (Issue #676).
 * Unrelated to Claude subagent definitions.
 */
export const CODEX_WORKSPACE_WRITE_ROLES: ReadonlySet<string> = new Set([
  "se",
  "docs",
  "be-api",
  "be-logic",
  "db-schema",
  "devops-deploy",
]);

/**
 * Claude model family catalog for guard normalization (PLAN-L7-414).
 * Kept as a runtime-layer literal because the module-boundary rule forbids
 * runtime -> team imports; equality with MODEL_IDS.claude (the SSoT in
 * src/team/model-policy.ts) is enforced by tests/model-id-ssot-drift.test.ts.
 */
export const CLAUDE_MODEL_FAMILY_CATALOG = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
  fable: "claude-fable-5-2",
} as const;

export const AGENT_GUARD_BYPASS_HINT =
  "Set UT_TDD_ALLOW_RAW_AGENT=1 only with an explicit reason recorded in the final report.";

export const AGENT_TOOL_NAME = "Agent";
export const AGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Agent",
  "Task",
  "spawn_agent",
  "spawn_agents_on_csv",
]);
