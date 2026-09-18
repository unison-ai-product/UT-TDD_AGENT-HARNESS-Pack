import { stableId } from "../../stable-id.ts";
import type { OperationalMetricsReadPort, ProjectionStore } from "../contracts/projection-store.ts";
import { deriveOperationalMetrics } from "../domain/operational-metrics.ts";

export function projectOperationalMetrics(input: {
  read: OperationalMetricsReadPort;
  store: ProjectionStore;
  computedAt: string;
}): void {
  for (const metric of deriveOperationalMetrics(input.read.readOperationalMetricFacts())) {
    const id = stableId("telemetry-signal", `${metric.subject}:${metric.name}`);
    input.store.record({
      table: "quality_signals",
      id,
      row: {
        signal_id: id,
        source: "telemetry-metrics",
        subject_id: metric.subject,
        metric: metric.name,
        value: metric.value,
        threshold: metric.threshold,
        status: metric.status,
        computed_at: input.computedAt,
      },
    });
  }
}
