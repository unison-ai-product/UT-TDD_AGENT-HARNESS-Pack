import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyChangeLane,
  DOC_LANE_PREFIXES,
  type GitDiffNamesPort,
  isDocSafeChangePath,
  resolveChangeDiffRange,
  runChangeLaneClassification,
} from "../src/github/change-lane.ts";
import { workspaceRead } from "./support/workspace-roots.ts";

describe("change-lane classification (PLAN-L7-455)", () => {
  describe("isDocSafeChangePath", () => {
    it("accepts only noncanonical prose reference trees", () => {
      expect(isDocSafeChangePath("docs/archive/README.md")).toBe(true);
      expect(isDocSafeChangePath("docs/migration/note.md")).toBe(true);
      expect(isDocSafeChangePath("docs/reference/api.md")).toBe(true);
      expect(isDocSafeChangePath("docs/research/result.md")).toBe(true);
    });

    it("FLAG regression: canonical and runtime-bearing docs always use full lane", () => {
      for (const path of [
        "docs/governance/README.md",
        "docs/design/foo.md",
        "docs/process/runbook.md",
        "docs/adr/ADR-001.md",
        "docs/test-design/harness/L7-unit-test-design.md",
        "docs/templates/plan.md",
        "docs/handover/session.md",
        ".ut-tdd/memory/foo.md",
      ])
        expect(isDocSafeChangePath(path)).toBe(false);
    });

    it("rejects code, config, workflow, and script paths (fail-close)", () => {
      for (const path of [
        "src/lint/github-ci-policy.ts",
        "tests/github-ci-policy.test.ts",
        "package.json",
        "bun.lock",
        ".github/workflows/harness-check.yml",
        "scripts/run-vitest-snapshot.ts",
        ".claude/CLAUDE",
        "AGENTS.md.ts",
      ]) {
        expect(isDocSafeChangePath(path)).toBe(false);
      }
    });

    it("blind review FLAG regression: rejects docs/plans/** (PLAN frontmatter is governance, not doc-safe)", () => {
      expect(isDocSafeChangePath("docs/plans/PLAN-L7-455-ci-cost-speedup-phase1.md")).toBe(false);
      expect(isDocSafeChangePath("docs/plans/PLAN-X.md")).toBe(false);
    });

    it("blind review FLAG regression: rejects root/runtime-rule *.md (global *.md rule removed)", () => {
      expect(isDocSafeChangePath("README.md")).toBe(false);
      expect(isDocSafeChangePath("CLAUDE.md")).toBe(false);
      expect(isDocSafeChangePath("AGENTS.md")).toBe(false);
      expect(isDocSafeChangePath(".claude/CLAUDE.md")).toBe(false);
    });

    it("rejects empty or whitespace-only paths", () => {
      expect(isDocSafeChangePath("")).toBe(false);
      expect(isDocSafeChangePath("   ")).toBe(false);
    });
  });

  describe("classifyChangeLane", () => {
    it("classifies doc-only changes as the doc lane", () => {
      const result = classifyChangeLane([
        "docs/archive/foo.md",
        "docs/migration/README.md",
        "docs/reference/note.md",
      ]);
      expect(result.lane).toBe("doc");
      expect(result.fileCount).toBe(3);
    });

    it("regression: classifies a mix that includes one code path as full (負例 fail-close)", () => {
      const result = classifyChangeLane(["docs/reference/foo.md", "src/lint/github-ci-policy.ts"]);
      expect(result.lane).toBe("full");
      expect(result.reason).toContain("src/lint/github-ci-policy.ts");
    });

    it("regression: a single code-only change never classifies as doc lane", () => {
      const result = classifyChangeLane(["src/github/change-lane.ts"]);
      expect(result.lane).toBe("full");
    });

    it("fail-closes to full when no changed files are resolvable", () => {
      const result = classifyChangeLane([]);
      expect(result.lane).toBe("full");
      expect(result.reason).toContain("fail-close");
    });

    it("fail-closes to full for unknown/new-shape paths not on the allowlist", () => {
      const result = classifyChangeLane(["skills/new-skill.yaml"]);
      expect(result.lane).toBe("full");
    });

    it("blind review FLAG regression: docs/plans/** alone classifies as full (governance bypass attack reproduction)", () => {
      const result = classifyChangeLane(["docs/plans/PLAN-X.md"]);
      expect(result.lane).toBe("full");
    });

    it("blind review FLAG regression: root runtime-rule *.md files classify as full", () => {
      expect(classifyChangeLane(["CLAUDE.md"]).lane).toBe("full");
      expect(classifyChangeLane(["AGENTS.md"]).lane).toBe("full");
      expect(classifyChangeLane([".claude/CLAUDE.md"]).lane).toBe("full");
    });

    it("blind review FLAG regression: a doc-safe path mixed with docs/plans/** classifies as full (fail-close on mix)", () => {
      const result = classifyChangeLane(["docs/reference/foo.md", "docs/plans/PLAN-X.md"]);
      expect(result.lane).toBe("full");
    });
  });

  describe("resolveChangeDiffRange", () => {
    it("resolves a pull_request diff range from base/head SHAs", () => {
      const result = resolveChangeDiffRange({
        eventName: "pull_request",
        headSha: "head123",
        baseSha: "base456",
      });
      expect(result.range).toBe("base456...head123");
    });

    it("fail-closes pull_request without a resolvable base SHA", () => {
      const result = resolveChangeDiffRange({ eventName: "pull_request", headSha: "head123" });
      expect(result.range).toBeNull();
    });

    it("resolves a push diff range from before/head SHAs", () => {
      const result = resolveChangeDiffRange({
        eventName: "push",
        headSha: "head123",
        beforeSha: "before456",
      });
      expect(result.range).toBe("before456...head123");
    });

    it("fail-closes push with a null before SHA (force-push/new-branch)", () => {
      const result = resolveChangeDiffRange({
        eventName: "push",
        headSha: "head123",
        beforeSha: "0000000000000000000000000000000000000000",
      });
      expect(result.range).toBeNull();
      expect(result.reason).toContain("resolvable-before");
    });

    it("fail-closes unsupported events and missing head SHA", () => {
      expect(
        resolveChangeDiffRange({ eventName: "workflow_dispatch", headSha: "h" }).range,
      ).toBeNull();
      expect(resolveChangeDiffRange({ eventName: "push", headSha: "" }).range).toBeNull();
    });
  });

  describe("runChangeLaneClassification", () => {
    function fakeGit(files: string[]): GitDiffNamesPort {
      return { diffNames: () => files };
    }

    it("classifies doc lane end-to-end via an injected git port", () => {
      const result = runChangeLaneClassification({
        eventName: "pull_request",
        headSha: "head",
        baseSha: "base",
        git: fakeGit(["docs/reference/foo.md"]),
      });
      expect(result.lane).toBe("doc");
      expect(result.range).toBe("base...head");
    });

    it("regression: end-to-end code change classifies as full even via the git port", () => {
      const result = runChangeLaneClassification({
        eventName: "pull_request",
        headSha: "head",
        baseSha: "base",
        git: fakeGit(["docs/README.md", "src/cli.ts"]),
      });
      expect(result.lane).toBe("full");
    });

    it("fail-closes to full when the diff range cannot be resolved (no git call needed)", () => {
      const result = runChangeLaneClassification({
        eventName: "workflow_dispatch",
        headSha: "head",
        git: fakeGit(["docs/README.md"]),
      });
      expect(result.lane).toBe("full");
      expect(result.range).toBeNull();
    });

    it("fail-closes to full when git diff itself throws", () => {
      const throwingGit: GitDiffNamesPort = {
        diffNames: () => {
          throw new Error("git diff failed: unknown revision");
        },
      };
      const result = runChangeLaneClassification({
        eventName: "pull_request",
        headSha: "head",
        baseSha: "base",
        git: throwingGit,
      });
      expect(result.lane).toBe("full");
      expect(result.reason).toContain("diff-failed");
    });
  });

  // 2026-07-28: harness-check.yml の header コメントが実装より広い allowlist
  // (docs/**.md ・.ut-tdd/memory/**) を記述しており、orchestrator が lane を誤予測した。
  // コメントは人間と agent が最初に読む面なので、実装との集合一致を機械で固定する。
  describe("workflow header allowlist stays in sync with DOC_LANE_PREFIXES", () => {
    const MARKER = "doc-safe allowlist (SSoT: src/github/change-lane.ts DOC_LANE_PREFIXES):";

    function headerAllowlistPrefixes(): string[] {
      // live root ではなく detached HEAD snapshot を読む (U-TESTHYGIENE-015 /
      // test-repository-isolation の規律)。
      const workflow = readFileSync(
        join(
          workspaceRead({
            id: "change-lane-workflow-header",
            mode: "head_snapshot",
            reason: "workflow header の doc-safe allowlist を実装と突き合わせるため",
          }),
          ".github",
          "workflows",
          "harness-check.yml",
        ),
        "utf8",
      );
      const lines = workflow.split(/\r?\n/);
      const markerIndex = lines.findIndex((line) => line.includes(MARKER));
      // fail-close: marker を消した (= 契約を外した) 変更はテストを落とす。
      expect(markerIndex, `workflow header lost the allowlist marker: ${MARKER}`).toBeGreaterThan(
        -1,
      );
      const listLine = lines[markerIndex + 1] ?? "";
      return [...listLine.matchAll(/docs\/([a-z0-9-]+)\/\*\*\.md/g)].map(
        (match) => `docs/${match[1]}/`,
      );
    }

    it("enumerates exactly the implemented doc-safe prefixes", () => {
      expect([...headerAllowlistPrefixes()].sort()).toEqual([...DOC_LANE_PREFIXES].sort());
    });

    it("only enumerates prefixes the classifier actually accepts", () => {
      for (const prefix of headerAllowlistPrefixes()) {
        expect(isDocSafeChangePath(`${prefix}sample.md`)).toBe(true);
      }
    });
  });
});
