import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RepositoryModelEvaluationConfig } from "../src/projection/adapters/model-evaluation-config.ts";
import { projectModelEvaluations } from "../src/projection/application/project-model-evaluations.ts";
import {
  buildModelEvaluationEvent,
  type ModelEvaluationFacts,
} from "../src/projection/domain/model-evaluations.ts";

const facts: ModelEvaluationFacts = {
  model: "model-A",
  runCount: 3,
  successCount: 2,
  totalInputTokens: 30,
  totalOutputTokens: 10,
  totalCostUsd: 0.000003,
};

describe("U-DOMAIN-005: model evaluation domain/application", () => {
  it("rounds rates and efficiency without changing the asymmetric populations", () => {
    expect(buildModelEvaluationEvent(facts, "2026-07-13T00:00:00.000Z").row).toMatchObject({
      success_rate: 0.6667,
      tokens_per_success: 5,
      cost_per_success: 0.000002,
      total_input_tokens: 30,
      total_output_tokens: 10,
    });
  });

  it.each([
    [
      { ...facts, successCount: 0 },
      { tokens_per_success: null, cost_per_success: null },
    ],
    [{ ...facts, totalOutputTokens: 0 }, { tokens_per_success: null }],
    [{ ...facts, totalCostUsd: null }, { cost_per_success: null }],
  ])("does not fabricate unavailable efficiency", (input, expected) => {
    expect(buildModelEvaluationEvent(input, "fixed").row).toMatchObject(expected);
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
      rmSync(root, { recursive: true, force: true });
    }
  });
});
