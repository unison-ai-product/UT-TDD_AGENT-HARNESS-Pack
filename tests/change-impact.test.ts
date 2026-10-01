import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeChangeImpact,
  analyzeChangeSetIntegrity,
  changeImpactMessages,
  changeSetIntegrityMessages,
  loadUntrackedAddedFiles,
  loadWorkingTreeStatus,
  parseGitPorcelain,
  parseUntrackedAddedPaths,
} from "../src/lint/change-impact.ts";
import { analyzeDependencyDrift } from "../src/lint/dependency-drift.ts";
import { assessReviewSession } from "../src/runtime/review-guard.ts";

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
          text: 'import { doctor } from "../src/doctor/index.ts"; doctor;',
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
          text: 'import { doctor } from "../src/doctor/index.ts"; doctor;',
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

describe("parseUntrackedAddedPaths (issue #721 Sol r1 FLAG 1 — -z NUL-separated parsing)", () => {
  it("U-CHGIMPACT-UNTRACKED-001: extracts a non-ASCII untracked path unmangled from raw -z bytes", () => {
    // mutation check: replacing "\0" split with /\r?\n/ split would fail this (no newline
    // present in -z output; the whole record would parse as a single unsplit blob and the
    // leading "??" status-code slice would not isolate the path correctly for multi-record input).
    const output = `${["?? .ut-tdd/memory/日本語.md", "M  src/a.ts"].join("\0")}\0`;
    expect(parseUntrackedAddedPaths(output)).toEqual([".ut-tdd/memory/日本語.md"]);
  });

  it.each([
    "R",
    "C",
  ])("U-CHGIMPACT-UNTRACKED-002: skips the extra NUL-separated source path of a %s entry", (code) => {
    // source path 自体を "?? " で始まる正当な tracked path にする。skipNextToken を外す mutant は
    // この token を untracked 追加として漏らすため、期待値と必ず食い違う。
    const output = `${[`${code}  src/new.ts`, "?? src/old.ts", "?? .ut-tdd/memory/new.md"].join(
      "\0",
    )}\0`;
    expect(parseUntrackedAddedPaths(output)).toEqual([".ut-tdd/memory/new.md"]);
  });

  it("U-CHGIMPACT-UNTRACKED-003: filters transient harness DB journal files", () => {
    const output = `${["?? .ut-tdd/harness.db-wal", "?? .ut-tdd/memory/keep.md"].join("\0")}\0`;
    expect(parseUntrackedAddedPaths(output)).toEqual([".ut-tdd/memory/keep.md"]);
  });

  it("U-CHGIMPACT-UNTRACKED-004: an untracked directory lists each file individually (no collapse)", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-change-impact-untracked-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
      execFileSync("git", ["config", "user.name", "UT-TDD test"], { cwd: root });
      writeFileSync(join(root, "README.md"), "seed\n");
      execFileSync("git", ["add", "README.md"], { cwd: root });
      execFileSync("git", ["commit", "-qm", "seed"], { cwd: root });

      mkdirSync(join(root, ".ut-tdd", "memory"), { recursive: true });
      writeFileSync(join(root, ".ut-tdd", "memory", "a.md"), "a\n");
      writeFileSync(join(root, ".ut-tdd", "memory", "b.md"), "b\n");

      const paths = loadUntrackedAddedFiles(root);
      expect(paths.sort()).toEqual([".ut-tdd/memory/a.md", ".ut-tdd/memory/b.md"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-CHGIMPACT-UNTRACKED-005: a renamed tracked file does not appear as untracked-added", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-change-impact-rename-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
      execFileSync("git", ["config", "user.name", "UT-TDD test"], { cwd: root });
      mkdirSync(join(root, ".ut-tdd", "memory"), { recursive: true });
      writeFileSync(join(root, ".ut-tdd", "memory", "old.md"), "seed content\n");
      execFileSync("git", ["add", ".ut-tdd/memory/old.md"], { cwd: root });
      execFileSync("git", ["commit", "-qm", "seed"], { cwd: root });

      execFileSync("git", ["mv", ".ut-tdd/memory/old.md", ".ut-tdd/memory/renamed.md"], {
        cwd: root,
      });

      expect(loadUntrackedAddedFiles(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("review-guard と production loader の合成 (issue #721 Sol r2)", () => {
  it("U-CHGIMPACT-UNTRACKED-006: 実 git の日本語 memory と新規 subdirectory の追加は非違反、tracked memory 変更と memory 外追加は違反", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-guard-composition-"));
    try {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
      git("init", "--quiet");
      git("config", "user.email", "test@example.invalid");
      git("config", "user.name", "UT-TDD test");
      mkdirSync(join(root, ".ut-tdd", "memory"), { recursive: true });
      writeFileSync(join(root, ".ut-tdd", "memory", "tracked.md"), "seed");
      git("add", ".ut-tdd/memory/tracked.md");
      git("commit", "-qm", "seed");

      const before = loadWorkingTreeStatus(root).changed;
      writeFileSync(join(root, ".ut-tdd", "memory", "日本語.md"), "note");
      mkdirSync(join(root, ".ut-tdd", "memory", "dir"), { recursive: true });
      writeFileSync(join(root, ".ut-tdd", "memory", "dir", "a.md"), "note");
      const concurrentOnly = assessReviewSession({
        role: "blind-reviewer",
        before,
        after: loadWorkingTreeStatus(root).changed,
        untrackedAdded: loadUntrackedAddedFiles(root),
      });
      expect(concurrentOnly.violation).toBe(false);

      writeFileSync(join(root, ".ut-tdd", "memory", "tracked.md"), "edited");
      writeFileSync(join(root, "outside.md"), "x");
      const withEdits = assessReviewSession({
        role: "blind-reviewer",
        before,
        after: loadWorkingTreeStatus(root).changed,
        untrackedAdded: loadUntrackedAddedFiles(root),
      });
      expect(withEdits.violation).toBe(true);
      expect(withEdits.mutatedPaths).toEqual(
        expect.arrayContaining([".ut-tdd/memory/tracked.md", "outside.md"]),
      );
      expect(withEdits.mutatedPaths).not.toContain(".ut-tdd/memory/日本語.md");
      expect(withEdits.mutatedPaths).not.toContain(".ut-tdd/memory/dir/a.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
