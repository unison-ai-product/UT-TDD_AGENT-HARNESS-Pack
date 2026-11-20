export type DbCurrencyViolationReason = "missing_db";

export interface DbCurrencyViolation {
  reason: DbCurrencyViolationReason;
  count?: number;
}

export interface DbCurrencyResult {
  stats: Readonly<Record<string, unknown>> | null;
  violations: DbCurrencyViolation[];
  ok: boolean;
}

export function analyzeDbCurrency(
  stats: Readonly<Record<string, unknown>> | null,
): DbCurrencyResult {
  if (!stats) {
    return {
      stats,
      violations: [{ reason: "missing_db" }],
      ok: false,
    };
  }

  return { stats, violations: [], ok: true };
}

export function dbCurrencyMessages(result: DbCurrencyResult): string[] {
  if (!result.ok) {
    const sample = result.violations
      .map((v) => `${v.reason}${v.count !== undefined ? `=${v.count}` : ""}`)
      .join(", ");
    return [`db-currency - violation ${result.violations.length} (${sample})`];
  }

  return ["db-currency - OK"];
}
