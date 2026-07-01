import { describe, expect, it } from "vitest";
import { buildReleasePublicationPlan, evaluateGithubOpsGuard } from "../src/github/ops-guard";

describe("github ops guard", () => {
  it("blocks poc branches from merging directly to main", () => {
    const result = evaluateGithubOpsGuard({
      headRef: "poc/try-runtime",
      baseRef: "main",
      commitSubjects: ["feat: test runtime idea"],
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "poc-no-main-merge" }));
  });

  it("requires postmortem evidence for hotfix branches to main", () => {
    const blocked = evaluateGithubOpsGuard({
      headRef: "hotfix/prod-regression",
      baseRef: "main",
      prTitle: "fix: patch production regression",
      prBody: "## Summary\nPatch only.",
      commitSubjects: ["fix: patch production regression"],
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.findings).toContainEqual(
      expect.objectContaining({ code: "hotfix-postmortem-missing" }),
    );

    const allowed = evaluateGithubOpsGuard({
      headRef: "hotfix/prod-regression",
      baseRef: "main",
      prTitle: "fix: patch production regression",
      prBody: "## Postmortem\nRoot cause and recovery route are documented.",
      commitSubjects: ["fix: patch production regression"],
    });
    expect(allowed.ok).toBe(true);
  });

  it("enforces Conventional Commits subjects", () => {
    const result = evaluateGithubOpsGuard({
      headRef: "feature/github-ops",
      baseRef: "main",
      commitSubjects: ["feat: add github guard", "bad commit message"],
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: "commitlint-invalid", evidence: "bad commit message" }),
    );
  });

  it("renders a non-destructive release publication plan", () => {
    const plan = buildReleasePublicationPlan({
      tag: "v0.1.0",
      repo: "unison-ai-product/UT-TDD_AGENT-HARNESS-Pack",
    });

    expect(plan.ok).toBe(true);
    expect(plan.externalPublishRequiresApproval).toBe(true);
    expect(plan.commands).toEqual(
      expect.arrayContaining([
        expect.stringContaining("git tag -a v0.1.0"),
        expect.stringContaining("gh release create v0.1.0"),
      ]),
    );
  });
});
