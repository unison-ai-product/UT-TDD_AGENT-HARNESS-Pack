import { describe, expect, it } from "vitest";
import { analyzeBranchKind, branchKindMessages, classifyBranchKind } from "../src/lint/branch-kind";

describe("branch-kind-check", () => {
  it("classifies governed branch prefixes", () => {
    expect(classifyBranchKind("feature/issue-spine")).toBe("feature");
    expect(classifyBranchKind("hotfix/recovery")).toBe("hotfix");
    expect(classifyBranchKind("main")).toBe("none");
  });

  it("hard-fails when a governed branch touches no PLAN", () => {
    const result = analyzeBranchKind({
      branch: "feature/issue-spine",
      changedPaths: ["src/cli.ts"],
      plans: [],
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: "missing_plan", severity: "error" }),
    );
  });

  it("hard-fails PLAN kind mismatch and warns missing github_issue_id", () => {
    const result = analyzeBranchKind({
      branch: "feature/issue-spine",
      changedPaths: ["docs/plans/PLAN-L7-121-branch-kind-check.md"],
      plans: [
        {
          file: "docs/plans/PLAN-L7-121-branch-kind-check.md",
          plan_id: "PLAN-L7-121",
          kind: "design",
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: "kind_mismatch", severity: "error" }),
    );
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: "missing_github_issue_id", severity: "warn" }),
    );
  });

  it("allows feature impl PLAN and keeps missing issue as warning only", () => {
    const result = analyzeBranchKind({
      branch: "feature/issue-spine",
      changedPaths: ["docs/plans/PLAN-L7-121-branch-kind-check.md"],
      plans: [
        {
          file: "docs/plans/PLAN-L7-121-branch-kind-check.md",
          plan_id: "PLAN-L7-121",
          kind: "impl",
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(branchKindMessages(result).join("\n")).toContain("warnings=1");
  });

  it("requires PLAN when docs/chore branches touch skill docs", () => {
    const result = analyzeBranchKind({
      branch: "docs/skill-update",
      changedPaths: ["docs/skills/review-checklist.md"],
      plans: [],
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: "skill_doc_plan_missing", severity: "error" }),
    );
  });
});
