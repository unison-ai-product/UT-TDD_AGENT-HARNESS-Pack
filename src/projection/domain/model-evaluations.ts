export interface ModelEvaluationFacts {
  model: string;
  runCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number | null;
}

export interface ModelEvaluationEvent {
  table: "model_evaluations";
  id: string;
  row: Record<string, unknown>;
}

/** 集計済factから永続化eventを作る。PLAN 由来の成功値 (success_rate など) は書かず NULL のままにする。DB・clock・configには依存しない。 */
export function buildModelEvaluationEvent(
  facts: ModelEvaluationFacts,
  evaluatedAt: string,
): ModelEvaluationEvent {
  return {
    table: "model_evaluations",
    id: facts.model,
    row: {
      model: facts.model,
      run_count: facts.runCount,
      evaluated_at: evaluatedAt,
      total_input_tokens: facts.totalInputTokens,
      total_output_tokens: facts.totalOutputTokens,
      total_cost_usd: facts.totalCostUsd,
    },
  };
}
