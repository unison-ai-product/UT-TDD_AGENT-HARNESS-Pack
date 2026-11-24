import type { ModelEvaluationFacts } from "../domain/model-evaluations.ts";
import type { OperationalMetricFacts } from "../domain/operational-metrics.ts";

export interface ProjectionEvent {
  table: string;
  id: string;
  row: Record<string, unknown>;
}

/** projectorが永続化adapterへ要求する書込みport。 */
export interface ProjectionStore {
  record(event: ProjectionEvent): void;
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
