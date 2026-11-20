import type { LintResult } from "../lint/lint-result.ts";
import { evaluateClaudeVersion } from "../runtime/claude-version-check.ts";
import { CLAUDE_CODE_VERSION_FLOOR } from "../runtime/claude-version-floor.ts";
import { type PathClaudeProbe, probePathClaude } from "./claude-path-probe.ts";

export interface ClaudeVersionFloorCheckDeps {
  probePathClaude?: () => PathClaudeProbe;
}

const PREFIX = "doctor: claude-version-floor - ";
const UNREADABLE = `${PREFIX}WARN: PATH の claude の版を読めない (版を確かめられない)`;
const NOT_FOUND = `${PREFIX}SKIP: PATH に claude が見つからない (版を確かめられない)`;

function messageFor(probe: PathClaudeProbe | null): string {
  if (probe === null) return UNREADABLE;
  if (probe.kind === "not_found") return NOT_FOUND;
  const status = evaluateClaudeVersion(probe.version);
  if (status === "unknown") return UNREADABLE;
  if (status === "below") {
    return `${PREFIX}WARN: PATH の claude の版 (${probe.version}) is below ${CLAUDE_CODE_VERSION_FLOOR}; update Claude Code.`;
  }
  return `${PREFIX}OK: PATH の claude の版 (${probe.version})`;
}

export function checkClaudeVersionFloor(deps: ClaudeVersionFloorCheckDeps = {}): LintResult {
  let probe: PathClaudeProbe | null;
  try {
    probe = (deps.probePathClaude ?? probePathClaude)();
  } catch {
    probe = null;
  }
  return { ok: true, messages: [messageFor(probe)] };
}
