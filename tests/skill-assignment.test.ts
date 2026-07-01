import { describe, expect, it } from "vitest";
import {
  analyzeSkillAssignments,
  loadSkillAssignmentDocs,
  type SkillAssignmentDoc,
} from "../src/lint/skill-assignment";

const doc = (metadata: Record<string, unknown>): SkillAssignmentDoc => ({
  path: "docs/skills/example.yaml",
  metadata,
});

describe("skill-assignment lint", () => {
  // U-SKILL-IDX-001: workflow 索引 (L+駆動) は非破壊。
  it("accepts a workflow skill indexed by layers + drive models", () => {
    const result = analyzeSkillAssignments([
      doc({
        skill_type: "quality-gate-review",
        applies_to: {
          layers: ["L7"],
          drive_models: ["Forward", "Reverse"],
        },
      }),
    ]);

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  // U-SKILL-IDX-005: skill_type 空 + 値不正は依然違反 (layers/drive_models が存在すれば索引可能なので not-indexable は出ない)。
  it("rejects missing type and unknown layer/drive-model values", () => {
    const result = analyzeSkillAssignments([
      doc({
        skill_type: "",
        applies_to: {
          layers: ["L99"],
          drive_models: ["Unknown"],
        },
      }),
    ]);

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.kind)).toEqual([
      "missing-skill-type",
      "unknown-layer",
      "unknown-drive-model",
    ]);
  });

  // U-SKILL-IDX-002: domain skill (L/駆動なし + category=domain) は登録できる (旧 lint なら missing-drive-models で落ちた)。
  it("accepts a domain skill indexed by category without layers or drive models", () => {
    const result = analyzeSkillAssignments([
      doc({
        skill_type: "writing",
        category: "domain",
        domain_tags: ["writing", "documentation"],
      }),
    ]);

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  // U-SKILL-IDX-003: project skill (L/駆動なし + category=project) は登録できる。
  it("accepts a project skill indexed by category", () => {
    const result = analyzeSkillAssignments([
      doc({ skill_type: "convention", category: "project", industry: "fintech" }),
    ]);

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  // U-SKILL-IDX-004: L/駆動なし + category なし = 無索引 = fail-close。
  it("fails-closed on a not-indexable skill (no layers, no drive models, no category)", () => {
    const result = analyzeSkillAssignments([doc({ skill_type: "orphan" })]);

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.kind)).toEqual(["not-indexable"]);
  });

  // U-SKILL-IDX-005: category 値検証。
  it("rejects an unknown category value", () => {
    const result = analyzeSkillAssignments([
      doc({ skill_type: "x", category: "domains", domain_tags: ["writing"] }),
    ]);

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.kind)).toEqual(["unknown-category", "not-indexable"]);
  });

  it("real repo skills are assigned to L and drive-model scopes", () => {
    const result = analyzeSkillAssignments(loadSkillAssignmentDocs(process.cwd()));

    expect(result.ok).toBe(true);
    expect(result.checked).toBeGreaterThan(0);
  });
});
