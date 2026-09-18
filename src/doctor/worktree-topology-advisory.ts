import type { LintResult } from "../plan/lint.ts";
import {
  analyzeWorktreeTopology,
  type TopologyFinding,
  type WorktreeTopologyInput,
} from "../runtime/worktree-topology.ts";

const FINDING_CAP = 8;

function findingMessage(finding: TopologyFinding): string {
  const path = finding.worktreePathKey ? ` path=${finding.worktreePathKey}` : "";
  const admin = finding.adminPathKey ? ` admin=${finding.adminPathKey}` : "";
  return `${finding.kind} (${finding.operation}/${finding.evidenceCode})${path}${admin}`;
}

/** PF3 の topology advisory は empty input を doctor の表示からも除外する。 */
export function worktreeTopologyAdvisoryMessages(input: WorktreeTopologyInput): string[] {
  const report = analyzeWorktreeTopology(input);
  if (input.facts.length === 0 && input.adminEntries.length === 0 && report.findings.length === 0)
    return [];

  if (report.findings.length === 0) {
    return [`worktree-topology — OK (healthy=${report.healthy}, findings=0; advisory only)`];
  }

  const shown = report.findings.slice(0, FINDING_CAP).map(findingMessage).join(", ");
  const more =
    report.findings.length > FINDING_CAP ? ` (+${report.findings.length - FINDING_CAP} more)` : "";
  return [
    `worktree-topology — advisory: ${report.findings.length} finding(s) (non-blocking): ${shown}${more}`,
  ];
}

/** Doctor consumer adapter. Findings are rendered, but the result is always non-blocking. */
export function checkWorktreeTopologyAdvisory(input: WorktreeTopologyInput): LintResult {
  return { ok: true, messages: worktreeTopologyAdvisoryMessages(input) };
}
