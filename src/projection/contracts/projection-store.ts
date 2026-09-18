import type { ModelEvaluationFacts } from "../domain/model-evaluations.ts";
import type { OperationalMetricFacts } from "../domain/operational-metrics.ts";
import type { PocDecisionCount } from "../domain/poc-evaluations.ts";

export interface ProjectionEvent {
  table: string;
  id: string;
  row: Record<string, unknown>;
}

/** projectorが永続化adapterへ要求する書込みport。 */
export interface ProjectionStore {
  record(event: ProjectionEvent): void;
}

/** FR-L1-43専用の意味的読取port。SQL構文をapplicationへ漏らさない。 */
export interface PocEvaluationReadPort {
  readPocDecisionCounts(): readonly PocDecisionCount[];
}

export interface ModelEvaluationConfigPort {
  isEnabled(): boolean;
}

export interface ModelEvaluationReadPort {
  readModelEvaluationFacts(): readonly ModelEvaluationFacts[];
}

export interface OperationalMetricsReadPort {
  readOperationalMetricFacts(): OperationalMetricFacts;
}
