import { describe, expect, it } from "vitest";
import {
  kindSchema,
  recommendedCommandV1Schema,
  V_MODEL_PAIRS,
  VALID_ARTIFACT_TYPES,
  VALID_KINDS,
  VALID_LAYERS,
  VALID_ORCHESTRATION_MODES,
} from "../src/schema";
import { planIdSchema } from "../src/schema/frontmatter";

describe("planIdSchema (§1.10 A、NN = d{2,} で 99 ceiling 解消)", () => {
  it("2 桁 plan_id を受理", () => {
    expect(planIdSchema.safeParse("PLAN-L7-99-sub-doc-catalog-drift-gate").success).toBe(true);
    expect(planIdSchema.safeParse("PLAN-DISCOVERY-01-workflow").success).toBe(true);
  });

  it("3 桁 plan_id (99 到達後) を受理 (L7-100+)", () => {
    expect(
      planIdSchema.safeParse("PLAN-L7-100-standard-deliverable-section-structure").success,
    ).toBe(true);
    expect(planIdSchema.safeParse("PLAN-REVERSE-123-x").success).toBe(true);
  });

  it("1 桁 NN / 不正 token は棄却", () => {
    expect(planIdSchema.safeParse("PLAN-L7-5-x").success).toBe(false);
    expect(planIdSchema.safeParse("PLAN-FOO-01-x").success).toBe(false);
  });
});

describe("schema (zod single source, ADR-001 / requirements_v1.2 §1)", () => {
  it("L0-L14 + cross = 16 layers", () => {
    expect(VALID_LAYERS).toHaveLength(16);
    expect(VALID_LAYERS).toContain("L14");
    expect(VALID_LAYERS).toContain("cross");
  });

  it("12 kinds incl. charter (L0 企画); zod rejects unknown", () => {
    expect(VALID_KINDS).toHaveLength(12);
    expect(kindSchema.safeParse("impl").success).toBe(true);
    expect(kindSchema.safeParse("charter").success).toBe(true);
    expect(kindSchema.safeParse("nope").success).toBe(false);
  });

  it("19 artifact types (test_design / test_code 分離、§1.7)", () => {
    expect(VALID_ARTIFACT_TYPES).toHaveLength(19);
    expect(VALID_ARTIFACT_TYPES).toContain("test_design");
    expect(VALID_ARTIFACT_TYPES).toContain("test_code");
  });

  it("5 orchestration modes", () => {
    expect(VALID_ORCHESTRATION_MODES).toHaveLength(5);
    expect(VALID_ORCHESTRATION_MODES).toContain("claude_judge_codex_impl");
  });

  it("V-model pairs L6<->L7 / L1<->L14", () => {
    expect(V_MODEL_PAIRS.L6).toBe("L7");
    expect(V_MODEL_PAIRS.L1).toBe("L14");
  });

  const legacyRuntimeName = ["he", "lix"].join("");

  it("RecommendedCommandV1 rejects legacy runtime command, accepts ut-tdd", () => {
    expect(
      recommendedCommandV1Schema.safeParse({
        schema_version: "v1",
        command: `${legacyRuntimeName} plan draft`,
        safety: {},
      }).success,
    ).toBe(false);
    expect(
      recommendedCommandV1Schema.safeParse({
        schema_version: "v1",
        command: "ut-tdd plan draft",
        safety: {},
      }).success,
    ).toBe(true);
  });
});
