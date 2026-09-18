export interface ModelEvaluationFacts {
  model: string;
  runCount: number;
  successCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number | null;
}

export interface ModelEvaluationEvent {
  table: "model_evaluations";
  id: string;
  row: Record<string, unknown>;
}

/** 集計済factから永続化eventを作る。DB・clock・configには依存しない。 */
export function buildModelEvaluationEvent(
  facts: ModelEvaluationFacts,
  evaluatedAt: string,
): ModelEvaluationEvent {
  const successRate =
    facts.runCount === 0 ? 0 : Number((facts.successCount / facts.runCount).toFixed(4));
  const tokensPerSuccess =
    facts.successCount > 0 && facts.totalOutputTokens > 0
      ? Number((facts.totalOutputTokens / facts.successCount).toFixed(2))
      : null;
  const costPerSuccess =
    facts.totalCostUsd != null && facts.successCount > 0
      ? Number((facts.totalCostUsd / facts.successCount).toFixed(6))
      : null;
  return {
    table: "model_evaluations",
    id: facts.model,
    row: {
      model: facts.model,
      success_rate: successRate,
      run_count: facts.runCount,
      success_count: facts.successCount,
      evaluated_at: evaluatedAt,
      total_input_tokens: facts.totalInputTokens,
      total_output_tokens: facts.totalOutputTokens,
      total_cost_usd: facts.totalCostUsd,
      tokens_per_success: tokensPerSuccess,
      cost_per_success: costPerSuccess,
    },
  };
}
