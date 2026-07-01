/** Allowed subagent_type values for Claude Code Agent calls. */
export const SUBAGENT_ALLOWLIST: ReadonlySet<string> = new Set([
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
  "security-audit",
  "qa-test",
  "ut-tdd-tl",
]);

export const AGENT_GUARD_BYPASS_HINT =
  "Set UT_TDD_ALLOW_RAW_AGENT=1 only with an explicit reason recorded in the final report.";

export const AGENT_TOOL_NAME = "Agent";
export const AGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Agent",
  "Task",
  "spawn_agent",
  "spawn_agents_on_csv",
]);
