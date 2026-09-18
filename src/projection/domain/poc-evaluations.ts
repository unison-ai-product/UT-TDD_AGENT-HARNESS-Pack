/** FR-L1-43 の PoC 判定集計。DB と時刻取得を持たない pure projector。 */
export const POC_DECISION_VALUES = ["confirmed", "rejected", "pivot"] as const;

export type PocDecision = (typeof POC_DECISION_VALUES)[number];

export interface PocDecisionCount {
  decision_outcome: string;
  cnt: number;
}

export interface PocEvaluationEvent {
  table: "poc_evaluations";
  id: "poc-evaluation:summary";
  row: {
    poc_evaluation_id: "poc-evaluation:summary";
    poc_success_rate: number;
    confirmed_count: number;
    rejected_count: number;
    pivot_count: number;
    total_count: number;
    evaluated_at: string;
  };
}

export function summarizePocEvaluations(
  rows: readonly PocDecisionCount[],
  evaluatedAt: string,
): PocEvaluationEvent | undefined {
  if (rows.length === 0) return undefined;
  const counts: Record<PocDecision, number> = { confirmed: 0, rejected: 0, pivot: 0 };
  for (const row of rows) {
    if (isPocDecision(row.decision_outcome)) counts[row.decision_outcome] = Number(row.cnt ?? 0);
  }
  const totalCount = counts.confirmed + counts.rejected + counts.pivot;
  return {
    table: "poc_evaluations",
    id: "poc-evaluation:summary",
    row: {
      poc_evaluation_id: "poc-evaluation:summary",
      poc_success_rate: totalCount === 0 ? 0 : Number((counts.confirmed / totalCount).toFixed(4)),
      confirmed_count: counts.confirmed,
      rejected_count: counts.rejected,
      pivot_count: counts.pivot,
      total_count: totalCount,
      evaluated_at: evaluatedAt,
    },
  };
}

function isPocDecision(value: string): value is PocDecision {
  return (POC_DECISION_VALUES as readonly string[]).includes(value);
}
