export interface DriveDbRegistrationStats {
  planCount: number;
  expectedPlanCount?: number;
  planRegistryFingerprint?: string;
  expectedPlanRegistryFingerprint?: string;
  driveRuns: number;
  plansWithoutDriveRun: number;
  workflowRuns: number;
  workflowOrphans: number;
  modelRuns: number;
  modelOrphans: number;
  skillRecommendations: number;
  skillRecommendationOrphans: number;
  skillInvocations: number;
  skillInvocationOrphans: number;
  registeredHookEvents: number;
  hookOrphans: number;
  modes: string[];
}

export interface DriveDbRegistrationViolation {
  reason:
    | "missing_db"
    | "empty_plan_registry"
    | "stale_plan_registry"
    | "stale_plan_registry_fingerprint"
    | "missing_drive_runs"
    | "plans_without_drive_run"
    | "missing_workflow_runs"
    | "workflow_orphans"
    | "missing_model_runs"
    | "model_orphans"
    | "missing_skill_recommendations"
    | "skill_recommendation_orphans"
    | "missing_skill_invocations"
    | "skill_invocation_orphans"
    | "missing_registered_hook_events"
    | "missing_required_mode";
  count?: number;
  mode?: string;
}

export interface DriveDbRegistrationResult {
  stats: DriveDbRegistrationStats | null;
  violations: DriveDbRegistrationViolation[];
  ok: boolean;
}

const REQUIRED_CURRENT_MODES = ["Discovery", "Forward", "Recovery", "Reverse", "Verification"];

export function analyzeDriveDbRegistration(
  stats: DriveDbRegistrationStats | null,
): DriveDbRegistrationResult {
  const violations: DriveDbRegistrationViolation[] = [];
  if (!stats) {
    return {
      stats,
      violations: [{ reason: "missing_db" }],
      ok: false,
    };
  }

  if (stats.planCount <= 0) violations.push({ reason: "empty_plan_registry" });
  if (stats.expectedPlanCount !== undefined && stats.planCount !== stats.expectedPlanCount) {
    violations.push({
      reason: "stale_plan_registry",
      count: stats.planCount - stats.expectedPlanCount,
    });
  }
  if (
    stats.expectedPlanRegistryFingerprint !== undefined &&
    stats.planRegistryFingerprint !== stats.expectedPlanRegistryFingerprint
  ) {
    violations.push({ reason: "stale_plan_registry_fingerprint" });
  }
  if (stats.driveRuns <= 0) violations.push({ reason: "missing_drive_runs" });
  if (stats.plansWithoutDriveRun > 0) {
    violations.push({ reason: "plans_without_drive_run", count: stats.plansWithoutDriveRun });
  }
  if (stats.workflowRuns <= 0) violations.push({ reason: "missing_workflow_runs" });
  if (stats.workflowOrphans > 0) {
    violations.push({ reason: "workflow_orphans", count: stats.workflowOrphans });
  }
  if (stats.modelRuns <= 0) violations.push({ reason: "missing_model_runs" });
  if (stats.modelOrphans > 0) {
    violations.push({ reason: "model_orphans", count: stats.modelOrphans });
  }
  if (stats.skillRecommendations <= 0) {
    violations.push({ reason: "missing_skill_recommendations" });
  }
  if (stats.skillRecommendationOrphans > 0) {
    violations.push({
      reason: "skill_recommendation_orphans",
      count: stats.skillRecommendationOrphans,
    });
  }
  if (stats.skillInvocations <= 0) violations.push({ reason: "missing_skill_invocations" });
  if (stats.skillInvocationOrphans > 0) {
    violations.push({ reason: "skill_invocation_orphans", count: stats.skillInvocationOrphans });
  }
  if (stats.registeredHookEvents <= 0) {
    violations.push({ reason: "missing_registered_hook_events" });
  }
  for (const mode of REQUIRED_CURRENT_MODES) {
    if (!stats.modes.includes(mode)) violations.push({ reason: "missing_required_mode", mode });
  }

  return { stats, violations, ok: violations.length === 0 };
}

export function driveDbRegistrationMessages(result: DriveDbRegistrationResult): string[] {
  if (!result.ok) {
    const sample = result.violations
      .slice(0, 8)
      .map(
        (v) =>
          `${v.reason}${v.mode ? `:${v.mode}` : ""}${v.count !== undefined ? `=${v.count}` : ""}`,
      )
      .join(", ");
    return [`drive-db-registration - violation ${result.violations.length} (${sample})`];
  }
  const stats = result.stats;
  if (!stats) return ["drive-db-registration - violation: stats unavailable"];
  return [
    `drive-db-registration - OK (plans=${stats.planCount}, drive_runs=${stats.driveRuns}, workflow_runs=${stats.workflowRuns}, model_runs=${stats.modelRuns}, skill_recommendations=${stats.skillRecommendations}, skill_invocations=${stats.skillInvocations}, registered_hook_events=${stats.registeredHookEvents}, modes=${stats.modes.length}, legacy_hook_orphans=${stats.hookOrphans})`,
  ];
}
