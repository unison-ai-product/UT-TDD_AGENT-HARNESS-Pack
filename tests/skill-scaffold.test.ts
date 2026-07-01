import { describe, expect, it } from "vitest";
import { scaffoldSkill, skillOutputRoot } from "../src/skill-engine/scaffold";

describe("skill scaffolder", () => {
  it("U-SKILL-NEW-001: scaffolds a workflow skill that passes self lint", () => {
    const result = scaffoldSkill({
      name: "L6 Reviewer",
      category: "workflow",
      layers: ["L6"],
      driveModels: ["Forward"],
      description: "review L6 design",
    });

    expect(result.ok).toBe(true);
    expect(result.path).toBe("skills/l6-reviewer.md");
    expect(result.content).toContain("schema_version: skill.v1");
    expect(result.content).toContain("category: workflow");
    expect(result.content).toContain("  layers:\n    - L6");
    expect(result.content).toContain("  drive_models:\n    - Forward");
  });

  it("U-SKILL-NEW-002: scaffolds a domain skill indexed by category metadata", () => {
    const result = scaffoldSkill({
      name: "Writing Style",
      category: "domain",
      domainTags: ["writing", "style"],
      description: "writing style guidance",
    });

    expect(result.ok).toBe(true);
    expect(result.path).toBe("skills/writing-style.md");
    expect(result.content).toContain("category: domain");
    expect(result.content).toContain("domain_tags:\n  - style\n  - writing");
    expect(result.content).not.toContain("applies_to:");
  });

  it("U-SKILL-NEW-003: sends project skills to the consumer root and reports collisions", () => {
    expect(skillOutputRoot("workflow")).toBe("skills");
    expect(skillOutputRoot("workflow", { productSkillRoot: "docs/skills" })).toBe("docs/skills");
    expect(skillOutputRoot("project", { projectSkillRoot: "project-skills" })).toBe(
      "project-skills",
    );

    const result = scaffoldSkill(
      {
        name: "Case Convention",
        category: "project",
        industry: "finance",
      },
      {
        projectSkillRoot: "project-skills",
        exists: (path) => path === "project-skills/case-convention.md",
      },
    );

    expect(result.ok).toBe(false);
    expect(result.path).toBe("project-skills/case-convention.md");
    expect(result.findings).toEqual([
      "name-collision: project-skills/case-convention.md already exists (not overwritten)",
    ]);
  });

  it("fails closed when a generated skill is not indexable", () => {
    const result = scaffoldSkill({
      name: "No Index",
      category: "workflow",
      description: "no index axis",
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toContain("self-lint:not-indexable");
  });
});
