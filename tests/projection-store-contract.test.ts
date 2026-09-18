import { describe, expect, it } from "vitest";
import { projectPocEvaluations } from "../src/projection/application/project-poc-evaluations.ts";

describe("U-DOMAIN-003: PoC projection ports", () => {
  it("projects a semantic read result through the store without SQLite", () => {
    const events: unknown[] = [];
    projectPocEvaluations({
      evaluatedAt: "2026-07-13T00:00:00.000Z",
      read: { readPocDecisionCounts: () => [{ decision_outcome: "confirmed", cnt: 2 }] },
      store: { record: (event) => events.push(event) },
    });
    expect(events).toMatchObject([{ id: "poc-evaluation:summary", row: { total_count: 2 } }]);
  });

  it("does not write at cold start", () => {
    const events: unknown[] = [];
    projectPocEvaluations({
      evaluatedAt: "2026-07-13T00:00:00.000Z",
      read: { readPocDecisionCounts: () => [] },
      store: { record: (event) => events.push(event) },
    });
    expect(events).toEqual([]);
  });
});
