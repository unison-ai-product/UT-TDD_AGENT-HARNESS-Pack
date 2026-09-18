import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  compileRightArmContract,
  RIGHT_ARM_LAYERS,
  VMODEL_LAYERS,
} from "../src/vmodel-contract/application/contract-compiler.ts";

function source(): string {
  return readFileSync(resolve(process.cwd(), "docs/process/vmodel-contract.yaml"), "utf8");
}

describe("V-model contract compiler", () => {
  it("U-VMC-001: compiles L8-L14 obligations exactly once with stable digests", () => {
    const text = source();
    const first = compileRightArmContract(YAML.parse(text));
    const second = compileRightArmContract(YAML.parse(text));
    expect(first.obligations.map((entry) => entry.layer)).toEqual(RIGHT_ARM_LAYERS);
    expect(first).toEqual(second);
  });

  it("U-VMC-002: keeps the right-arm gate mapping exactly once", () => {
    const text = source();
    const result = compileRightArmContract(YAML.parse(text));
    expect(result.obligations.map((entry) => entry.gate)).toEqual([
      "G8",
      "G9",
      "G10",
      "G11",
      "G12",
      "G13",
      "G14",
    ]);
  });

  it("U-VMC-009: validates the complete L0-L14 topology and gate identities", () => {
    const raw = YAML.parse(source()) as { layers: Array<Record<string, unknown>> };
    expect(raw.layers.map((entry) => entry.layer)).toEqual(VMODEL_LAYERS);
    const l0 = raw.layers.find((entry) => entry.layer === "L0") as Record<string, unknown>;
    l0.gate = "G0";
    expect(() => compileRightArmContract(raw)).toThrow("L0.gate expected=G0.5");
  });

  it("U-VMC-010: rejects a missing left-arm layer even when the right arm is intact", () => {
    const raw = YAML.parse(source()) as { layers: Array<Record<string, unknown>> };
    raw.layers = raw.layers.filter((entry) => entry.layer !== "L3");
    expect(() => compileRightArmContract(raw)).toThrow("L0-L14 exactly once");
  });

  it("U-VMC-003: rejects duplicate L8 plus missing L14 even when the count stays seven", () => {
    const text = source();
    const raw = YAML.parse(text) as { layers: Array<Record<string, unknown>> };
    const l8 = raw.layers.find((entry) => entry.layer === "L8") as Record<string, unknown>;
    raw.layers = raw.layers.filter((entry) => entry.layer !== "L14");
    raw.layers.push({ ...l8 });
    expect(() => compileRightArmContract(raw)).toThrow("exactly once");
  });

  it("U-VMC-005: rejects a missing plan identity instead of inferring it", () => {
    const text = source();
    const raw = YAML.parse(text) as { layers: Array<Record<string, unknown>> };
    const l8 = raw.layers.find((entry) => entry.layer === "L8") as Record<string, unknown>;
    delete l8.verification_plan_id;
    expect(() => compileRightArmContract(raw)).toThrow("verification_plan_id");
  });

  it("U-VMC-004: validates structured L11 and L13 pair exceptions", () => {
    const text = source();
    const result = compileRightArmContract(YAML.parse(text));
    expect(result.pairExceptions.map((entry) => entry.layer)).toEqual(["L11", "L13"]);
    expect(result.pairExceptions.every((entry) => entry.requiredBacklinks.length > 0)).toBe(true);
  });

  it("U-VMC-006: derives both digests from the same raw contract aggregate", () => {
    const raw = YAML.parse(source()) as { layers: Array<Record<string, unknown>> };
    const first = compileRightArmContract(raw);
    const l8 = raw.layers.find((entry) => entry.layer === "L8") as Record<string, unknown>;
    l8.case_id_prefix = "ALTERED-";
    const altered = compileRightArmContract(raw);
    expect(altered.sourceHash).not.toBe(first.sourceHash);
    expect(altered.generatedHash).not.toBe(first.generatedHash);
  });

  it("U-VMC-007: rejects an empty structured pair-exception obligation", () => {
    const raw = YAML.parse(source()) as {
      forward_workflow: { pair_reciprocity_exception_contracts: Array<Record<string, unknown>> };
    };
    raw.forward_workflow.pair_reciprocity_exception_contracts[0].required_backlinks = [];
    expect(() => compileRightArmContract(raw)).toThrow("non-empty string array");
  });

  it("U-VMC-008: rejects a pair exception without the owning L4 backlink", () => {
    const raw = YAML.parse(source()) as {
      forward_workflow: { pair_reciprocity_exception_contracts: Array<Record<string, unknown>> };
    };
    raw.forward_workflow.pair_reciprocity_exception_contracts[0].required_backlinks = [
      "PLAN-L9-01-engine-swap-l9",
    ];
    expect(() => compileRightArmContract(raw)).toThrow("required_backlinks drift");
  });
});
