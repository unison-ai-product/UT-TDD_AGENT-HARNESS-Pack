export const TEAM_MEMBER_PROMPT_HEADER = "UT-TDD team member";
export const TEAM_MEMBER_TASK_HEADER = "Task:";
export const TEAM_MEMBER_RULES_HEADER = "Rules:";

export const TEAM_MEMBER_RULES = [
  "You are not alone in the codebase. Do not revert edits made by others.",
  "Keep your work scoped to this assigned task and report changed files.",
  "If you are reviewing, report findings first with file/line references.",
] as const;

export const TEAM_RUN_REQUIRES_HYBRID_MESSAGE = "team run requires hybrid mode";
export const TEAM_RUN_REQUIRES_BOTH_RUNTIMES_MESSAGE =
  "hybrid team run requires both claude and codex members";
export const TEAM_RUN_REQUIRES_CROSS_PROVIDER_REVIEW_MESSAGE =
  "hybrid team run requires worker and reviewer on different providers";
export const TEAM_RUN_DRY_RUN_EXECUTION_MESSAGE =
  "team run plan is dry-run; rebuild with execute=true before execution";
export const TEAM_RUN_NOT_EXECUTABLE_MESSAGE = "team run plan is not executable";

export function duplicateRoleProviderMessage(key: string): string {
  return `duplicate role/provider assignment: ${key}`;
}

export function serializeAfterTargetNotFoundMessage(memberKey: string, target: string): string {
  return `serialize_after target not found for ${memberKey}: ${target}`;
}

export function serializeAfterTargetAmbiguousMessage(memberKey: string, target: string): string {
  return `serialize_after target is ambiguous for ${memberKey}: ${target}`;
}

export function teamDependencyCycleMessage(memberKey: string): string {
  return `team dependency cycle detected at ${memberKey}`;
}

export function frontierBlockedMessage(memberKey: string, reason: string): string {
  return `member blocked by frontier gate: ${memberKey} (${reason})`;
}

export function memberNotExecutableMessage(memberKey: string): string {
  return `member is not executable through runtime adapter: ${memberKey}`;
}

export function dependencyFailedMessage(target: string): string {
  return `dependency failed: ${target}`;
}
