import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeSkillAssignments,
  loadSkillAssignmentDocs,
  type SkillAssignmentDoc,
} from "../src/lint/skill-assignment";

const doc = (metadata: Record<string, unknown>): SkillAssignmentDoc => ({
  path: "skills/example.yaml",
  metadata,
});

describe("skill-assignment lint", () => {
  it("U-SKILL-IDX-001: accepts a workflow skill indexed by layers + drive models", () => {
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

  it("U-SKILL-IDX-005: rejects missing type and unknown layer/drive-model values", () => {
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

  it("U-SKILL-IDX-002: accepts a domain skill indexed by category without layers or drive models", () => {
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

  it("U-SKILL-IDX-003: accepts a project skill indexed by category", () => {
    const result = analyzeSkillAssignments([
      doc({ skill_type: "convention", category: "project", industry: "fintech" }),
    ]);

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("U-SKILL-IDX-004: fails closed on a not-indexable skill", () => {
    const result = analyzeSkillAssignments([doc({ skill_type: "orphan" })]);

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.kind)).toEqual(["not-indexable"]);
  });

  it("U-SKILL-IDX-005: rejects an unknown category value", () => {
    const result = analyzeSkillAssignments([
      doc({ skill_type: "x", category: "domains", domain_tags: ["writing"] }),
    ]);

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.kind)).toEqual(["unknown-category", "not-indexable"]);
  });

  it("prefers root skills over legacy docs/skills when both exist", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-skill-root-"));
    try {
      mkdirSync(join(root, "skills"), { recursive: true });
      mkdirSync(join(root, "docs", "skills"), { recursive: true });
      writeFileSync(
        join(root, "skills", "root.md"),
        "---\nskill_type: root\ncategory: domain\n---\n# Root\n",
        "utf8",
      );
      writeFileSync(
        join(root, "docs", "skills", "legacy.md"),
        "---\nskill_type: legacy\ncategory: domain\n---\n# Legacy\n",
        "utf8",
      );

      const docs = loadSkillAssignmentDocs(root);

      expect(docs.map((d) => d.path)).toEqual(["skills/root.md"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("real repo skills are assigned to L and drive-model scopes", () => {
    const result = analyzeSkillAssignments(loadSkillAssignmentDocs(process.cwd()));

    expect(result.ok).toBe(true);
    expect(result.checked).toBeGreaterThan(0);
  });
});
