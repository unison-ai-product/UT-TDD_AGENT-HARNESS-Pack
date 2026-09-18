export interface GateRunCoverageStats {
  gateRuns: number;
  workflowRuns: number;
  workflowPlansWithoutGateRun: number;
  orphanGateRuns: number;
  blankPlanGateRuns: number;
  invalidEvidenceFindings: number;
}

export interface GateRunCoverageViolation {
  reason:
    | "missing_gate_runs"
    | "workflow_without_gate_run"
    | "orphan_gate_run"
    | "blank_plan_gate_run"
    | "invalid_gate_run_evidence";
  count?: number;
}

export interface GateRunCoverageResult {
  stats: GateRunCoverageStats | null;
  violations: GateRunCoverageViolation[];
  ok: boolean;
}

export function analyzeGateRunCoverage(stats: GateRunCoverageStats | null): GateRunCoverageResult {
  if (!stats) {
    return {
      stats,
      violations: [{ reason: "missing_gate_runs" }],
      ok: false,
    };
  }
  const violations: GateRunCoverageViolation[] = [];
  if (stats.gateRuns <= 0) violations.push({ reason: "missing_gate_runs" });
  if (stats.workflowPlansWithoutGateRun > 0) {
    violations.push({
      reason: "workflow_without_gate_run",
      count: stats.workflowPlansWithoutGateRun,
    });
  }
  if (stats.orphanGateRuns > 0) {
    violations.push({ reason: "orphan_gate_run", count: stats.orphanGateRuns });
  }
  if (stats.blankPlanGateRuns > 0) {
    violations.push({ reason: "blank_plan_gate_run", count: stats.blankPlanGateRuns });
  }
  if (stats.invalidEvidenceFindings > 0) {
    violations.push({
      reason: "invalid_gate_run_evidence",
      count: stats.invalidEvidenceFindings,
    });
  }
  return { stats, violations, ok: violations.length === 0 };
}

export function gateRunCoverageMessages(result: GateRunCoverageResult): string[] {
  if (!result.ok) {
    const sample = result.violations
      .slice(0, 8)
      .map((v) => `${v.reason}${v.count !== undefined ? `=${v.count}` : ""}`)
      .join(", ");
    return [`gate-run-coverage - violation ${result.violations.length} (${sample})`];
  }
  const stats = result.stats;
  if (!stats) return ["gate-run-coverage - violation: stats unavailable"];
  return [
    `gate-run-coverage - OK (gate_runs=${stats.gateRuns}, workflow_runs=${stats.workflowRuns}, workflow_without_gate=${stats.workflowPlansWithoutGateRun}, orphans=${stats.orphanGateRuns})`,
  ];
}
