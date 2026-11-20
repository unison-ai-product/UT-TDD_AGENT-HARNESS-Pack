import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RepositoryModelEvaluationConfig } from "../src/projection/adapters/model-evaluation-config.ts";
import { projectModelEvaluations } from "../src/projection/application/project-model-evaluations.ts";
import {
  buildModelEvaluationEvent,
  type ModelEvaluationFacts,
} from "../src/projection/domain/model-evaluations.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const facts: ModelEvaluationFacts = {
  model: "model-A",
  runCount: 3,
  totalInputTokens: 30,
  totalOutputTokens: 10,
  totalCostUsd: 0.000003,
};

describe("U-DOMAIN-005: model evaluation domain/application", () => {
  it("keeps token totals and leaves PLAN-derived values unset", () => {
    const row = buildModelEvaluationEvent(facts, "2026-07-13T00:00:00.000Z").row;
    expect(row).toMatchObject({
      run_count: 3,
      total_input_tokens: 30,
      total_output_tokens: 10,
      total_cost_usd: 0.000003,
    });
    for (const key of ["success_rate", "success_count", "tokens_per_success", "cost_per_success"]) {
      expect(row).not.toHaveProperty(key);
    }
  });

  it("does not read or store when disabled", () => {
    const readModelEvaluationFacts = vi.fn(() => [facts]);
    const record = vi.fn();
    projectModelEvaluations({
      config: { isEnabled: () => false },
      read: { readModelEvaluationFacts },
      store: { record },
      evaluatedAt: "fixed",
    });
    expect(readModelEvaluationFacts).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("stores every fact with the injected evaluation time", () => {
    const record = vi.fn();
    projectModelEvaluations({
      config: { isEnabled: () => true },
      read: { readModelEvaluationFacts: () => [facts, { ...facts, model: "model-B" }] },
      store: { record },
      evaluatedAt: "fixed",
    });
    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls.map(([event]) => event.row.evaluated_at)).toEqual(["fixed", "fixed"]);
  });

  it.each([
    ["enabled: true\n", true],
    ["enabled: false\n", false],
    ["enabled: [\n", false],
  ])("loads repository opt-in without enabling malformed YAML", (yaml, expected) => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-model-config-"));
    try {
      mkdirSync(join(root, ".ut-tdd", "config"), { recursive: true });
      writeFileSync(join(root, ".ut-tdd", "config", "model-opt-in.yaml"), yaml);
      expect(new RepositoryModelEvaluationConfig(root).isEnabled()).toBe(expected);
    } finally {
      removeTestTree(root);
    }
  });
});
