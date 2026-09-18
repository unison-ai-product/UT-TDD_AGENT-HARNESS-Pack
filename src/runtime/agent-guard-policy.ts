/** Allowed subagent_type values for Claude Code Agent calls. */
export const SUBAGENT_ALLOWLIST: ReadonlySet<string> = new Set([
  "be-api",
  "be-logic",
  "db-schema",
  "devops-deploy",
  "pmo-sonnet",
  "pmo-haiku",
  "pmo-project-explorer",
  "pmo-project-scout",
  "pmo-tech-docs",
  "pmo-tech-fork",
  "pmo-tech-news",
  "refactor-scout",
  "pdm-tech-innovation",
  "pdm-marketing-innovation",
  "pdm-innovation-manager",
  "code-reviewer",
  "blind-reviewer",
  "security-audit",
  "qa-test",
  "ut-tdd-tl",
]);

/**
 * Claude model family catalog for guard normalization (PLAN-L7-414).
 * Kept as a runtime-layer literal because the module-boundary rule forbids
 * runtime -> team imports; equality with MODEL_IDS.claude (the SSoT in
 * src/team/model-policy.ts) is enforced by tests/model-id-ssot-drift.test.ts.
 */
export const CLAUDE_MODEL_FAMILY_CATALOG = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-5",
  fable: "claude-fable-5",
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
