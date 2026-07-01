import { describe, expect, it } from "vitest";
import {
  analyzeChangeImpact,
  analyzeChangeSetIntegrity,
  changeImpactMessages,
  changeSetIntegrityMessages,
  parseGitPorcelain,
} from "../src/lint/change-impact";
import { analyzeDependencyDrift } from "../src/lint/dependency-drift";

describe("change-impact lint", () => {
  it("src changes require both design and test/test-design updates", () => {
    const result = analyzeChangeImpact({
      changedFiles: ["src/lint/foo.ts", "docs/design/harness/L6-function-design/foo.md"],
    });
    expect(result.ok).toBe(false);
    expect(result.missingDesign).toBe(false);
    expect(result.missingTest).toBe(true);
  });

  it("passes when src changes have design and test coverage in the same change set", () => {
    const result = analyzeChangeImpact({
      changedFiles: [
        "src/lint/foo.ts",
        "docs/design/harness/L6-function-design/foo.md",
        "tests/foo.test.ts",
      ],
    });
    expect(result.ok).toBe(true);
    expect(changeImpactMessages(result)[0]).toContain("OK");
  });

  it("ignores documentation-only changes", () => {
    const result = analyzeChangeImpact({
      changedFiles: ["docs/design/harness/L6-function-design/foo.md"],
    });
    expect(result.ok).toBe(true);
    expect(result.sourceFiles).toEqual([]);
  });

  it("parses git porcelain paths including renames and untracked files", () => {
    expect(
      parseGitPorcelain(" M src/a.ts\nR  src/old.ts -> src/new.ts\n?? tests/a.test.ts\n"),
    ).toEqual(["src/a.ts", "src/new.ts", "tests/a.test.ts"]);
  });

  it("ignores transient harness DB journal files from git porcelain paths", () => {
    expect(
      parseGitPorcelain(
        "?? .ut-tdd/harness.db-journal\n?? .ut-tdd/harness.db-wal\n?? .ut-tdd/harness.db-shm\n M docs/handover/session-handover-2026-06-22.md\n",
      ),
    ).toEqual(["docs/handover/session-handover-2026-06-22.md"]);
  });

  it("warns when only one artifact category is touched", () => {
    const result = analyzeChangeSetIntegrity({
      changedFiles: ["docs/design/harness/L6-function-design/foo.md"],
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "singleton-artifact-set", severity: "warn" }),
    );
    expect(changeSetIntegrityMessages(result).join("\n")).toContain("warn singleton-artifact-set");
  });

  it("warns when a change set has only a partial artifact set", () => {
    const result = analyzeChangeSetIntegrity({
      changedFiles: ["docs/design/harness/L6-function-design/foo.md", "tests/foo.test.ts"],
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "incomplete-artifact-set",
        message: "change set is missing source",
      }),
    );
  });

  it("blocks when dependent modules exist and mapped regression tests are untouched", () => {
    const dependencyDrift = analyzeDependencyDrift({
      sourceDocs: [
        { path: "src/lint/rule.ts", text: "export const rule = true;" },
        { path: "src/doctor/index.ts", text: 'import { rule } from "../lint/rule"; rule;' },
      ],
      testDocs: [
        { path: "tests/lint-rule.test.ts", text: 'import { rule } from "../src/lint/rule"; rule;' },
        {
          path: "tests/doctor.test.ts",
          text: 'import { doctor } from "../src/doctor/index"; doctor;',
        },
      ],
    });
    const result = analyzeChangeSetIntegrity({
      changedFiles: ["src/lint/rule.ts", "docs/plans/PLAN-L7-99-rule.md"],
      dependencyDrift,
    });

    expect(result.ok).toBe(false);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({
        code: "dependent-regression-untouched",
        severity: "error",
        modules: ["doctor"],
      }),
    );
  });

  it("passes dependency block when a mapped regression test is part of the change set", () => {
    const dependencyDrift = analyzeDependencyDrift({
      sourceDocs: [
        { path: "src/lint/rule.ts", text: "export const rule = true;" },
        { path: "src/doctor/index.ts", text: 'import { rule } from "../lint/rule"; rule;' },
      ],
      testDocs: [
        { path: "tests/lint-rule.test.ts", text: 'import { rule } from "../src/lint/rule"; rule;' },
        {
          path: "tests/doctor.test.ts",
          text: 'import { doctor } from "../src/doctor/index"; doctor;',
        },
      ],
    });
    const result = analyzeChangeSetIntegrity({
      changedFiles: [
        "src/lint/rule.ts",
        "docs/plans/PLAN-L7-99-rule.md",
        "tests/lint-rule.test.ts",
      ],
      dependencyDrift,
    });

    expect(result.ok).toBe(true);
    expect(result.blockers).toEqual([]);
  });
});
