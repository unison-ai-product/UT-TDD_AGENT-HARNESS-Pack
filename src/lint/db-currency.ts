import type { DriveDbRegistrationStats } from "./drive-db-registration";

export type DbCurrencyViolationReason =
  | "missing_db"
  | "stale_plan_registry"
  | "stale_plan_registry_fingerprint";

export interface DbCurrencyViolation {
  reason: DbCurrencyViolationReason;
  count?: number;
}

export interface DbCurrencyResult {
  stats: DriveDbRegistrationStats | null;
  violations: DbCurrencyViolation[];
  ok: boolean;
}

export function analyzeDbCurrency(stats: DriveDbRegistrationStats | null): DbCurrencyResult {
  if (!stats) {
    return {
      stats,
      violations: [{ reason: "missing_db" }],
      ok: false,
    };
  }

  const violations: DbCurrencyViolation[] = [];
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

  return { stats, violations, ok: violations.length === 0 };
}

function fingerprintLabel(value: string | undefined): string {
  if (!value) return "unknown";
  return value.replace(/^sha256:/, "").slice(0, 12);
}

export function dbCurrencyMessages(result: DbCurrencyResult): string[] {
  if (!result.ok) {
    const sample = result.violations
      .map((v) => `${v.reason}${v.count !== undefined ? `=${v.count}` : ""}`)
      .join(", ");
    return [`db-currency - violation ${result.violations.length} (${sample})`];
  }

  const stats = result.stats;
  if (!stats) return ["db-currency - violation: stats unavailable"];
  return [
    `db-currency - OK (plans=${stats.planCount}, fingerprint=${fingerprintLabel(stats.planRegistryFingerprint)})`,
  ];
}
