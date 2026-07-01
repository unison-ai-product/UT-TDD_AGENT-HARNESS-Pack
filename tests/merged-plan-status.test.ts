import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkMergedPlanStatus } from "../src/doctor/index";
import { analyzeMergedPlanStatus, loadMergedPlanStatusInput } from "../src/lint/merged-plan-status";

// PO 指摘 2026-06-15: merge 済み generated artifact を持つのに owning PLAN が draft のまま
// 放置される V-model state 不整合 (PLAN-L7-53 の実例) を機械検出する gate の回帰。

describe("analyzeMergedPlanStatus", () => {
  it("flags an artifact-producing PLAN that is draft but whose src is merged", () => {
    const r = analyzeMergedPlanStatus({
      plans: [{ planId: "PLAN-X", status: "draft", kind: "impl", mergedArtifacts: ["src/x.ts"] }],
    });
    expect(r.ok).toBe(false);
    expect(r.violations[0]?.planId).toBe("PLAN-X");
  });

  it("does not flag a confirmed/completed PLAN with merged artifacts", () => {
    const r = analyzeMergedPlanStatus({
      plans: [
        { planId: "PLAN-A", status: "confirmed", kind: "impl", mergedArtifacts: ["src/a.ts"] },
        { planId: "PLAN-B", status: "completed", kind: "add-impl", mergedArtifacts: ["src/b.ts"] },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it("does not flag a draft PLAN whose src is NOT yet merged (genuinely in-progress)", () => {
    const r = analyzeMergedPlanStatus({
      plans: [{ planId: "PLAN-WIP", status: "draft", kind: "impl", mergedArtifacts: [] }],
    });
    expect(r.ok).toBe(true);
  });

  // PLAN-L7-87 (2026-06-22): kind no longer gates detection. A poc dogfood spike
  // (DISCOVERY-05) or add-design (L3-04/L3-05) that ships merged src must be flagged when
  // left draft. The pre-fix kind filter assumed design/poc/reverse never merge deliverables,
  // which is false and let 3 draft-with-merged-src PLANs slip through doctor green.
  it("flags ANY kind (incl design/poc/add-design) when it ships merged src while draft", () => {
    const r = analyzeMergedPlanStatus({
      plans: [
        { planId: "PLAN-POC", status: "draft", kind: "poc", mergedArtifacts: ["src/schema/x.ts"] },
        {
          planId: "PLAN-AD",
          status: "draft",
          kind: "add-design",
          mergedArtifacts: ["src/lint/y.ts"],
        },
        { planId: "PLAN-DS", status: "draft", kind: "design", mergedArtifacts: ["src/d.ts"] },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.planId)).toEqual(["PLAN-AD", "PLAN-DS", "PLAN-POC"]);
  });

  it("still does not flag a draft PLAN of any kind whose deliverable is NOT merged", () => {
    const r = analyzeMergedPlanStatus({
      plans: [
        { planId: "PLAN-POC-WIP", status: "draft", kind: "poc", mergedArtifacts: [] },
        { planId: "PLAN-AD-WIP", status: "draft", kind: "add-design", mergedArtifacts: [] },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it("flags add-impl and refactor kinds too (status-accuracy applies to all src-producers)", () => {
    const r = analyzeMergedPlanStatus({
      plans: [
        { planId: "PLAN-AI", status: "draft", kind: "add-impl", mergedArtifacts: ["src/ai.ts"] },
        { planId: "PLAN-RF", status: "draft", kind: "refactor", mergedArtifacts: ["src/rf.ts"] },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.planId)).toEqual(["PLAN-AI", "PLAN-RF"]);
  });

  it("does not flag an accepted PLAN with merged artifacts (terminal done state)", () => {
    const r = analyzeMergedPlanStatus({
      plans: [
        { planId: "PLAN-ACC", status: "accepted", kind: "impl", mergedArtifacts: ["src/acc.ts"] },
      ],
    });
    expect(r.ok).toBe(true);
  });
});

describe("loadMergedPlanStatusInput + checkMergedPlanStatus", () => {
  function writePlan(root: string, name: string, status: string, srcPath: string): void {
    writeFileSync(
      join(root, "docs", "plans", name),
      [
        "---",
        `plan_id: ${name.replace(/\.md$/, "")}`,
        `status: ${status}`,
        "kind: impl",
        "generates:",
        `  - artifact_path: ${srcPath}`,
        "    artifact_type: source_module",
        "---",
        "",
        "body",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  it("detects a draft PLAN whose generated src exists on disk (merged)", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-merged-plan-"));
    try {
      mkdirSync(join(root, "docs", "plans"), { recursive: true });
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "merged.ts"), "export const x = 1;\n", "utf8");
      // draft PLAN with an existing (merged) src → violation
      writePlan(root, "PLAN-TEST-90-merged.md", "draft", "src/merged.ts");
      // draft PLAN whose src does NOT exist → no violation (in-progress)
      writePlan(root, "PLAN-TEST-91-wip.md", "draft", "src/not-yet.ts");

      const result = checkMergedPlanStatus(root);
      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("PLAN-TEST-90-merged");
      expect(result.messages.join("\n")).not.toContain("PLAN-TEST-91-wip");

      const input = loadMergedPlanStatusInput(root);
      const merged = input.plans.find((p) => p.planId === "PLAN-TEST-90-merged");
      expect(merged?.mergedArtifacts).toContain("src/merged.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when repo root cannot be read", () => {
    const result = checkMergedPlanStatus(join(tmpdir(), "ut-tdd-merged-plan-nope-zzz"));
    expect(result.ok).toBe(false);
  });

  // Regression for the L7-71 detection hole (2026-06-19): an impl PLAN that ships a
  // non-src deliverable (.claude/commands/*.md) and is left draft must be flagged.
  // The pre-fix gate only counted src/*.ts, so this class of drift slipped through.
  function writePlanWithDeliverable(
    root: string,
    name: string,
    status: string,
    deliverablePath: string,
  ): void {
    writeFileSync(
      join(root, "docs", "plans", name),
      [
        "---",
        `plan_id: ${name.replace(/\.md$/, "")}`,
        `status: ${status}`,
        "kind: impl",
        "generates:",
        `  - artifact_path: docs/plans/${name}`,
        "    artifact_type: markdown_doc",
        `  - artifact_path: ${deliverablePath}`,
        "    artifact_type: markdown_doc",
        "---",
        "",
        "body",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  it("flags a draft impl PLAN that ships a merged .claude/ deliverable (non-src), not just src/*.ts", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-merged-plan-claude-"));
    try {
      mkdirSync(join(root, "docs", "plans"), { recursive: true });
      mkdirSync(join(root, ".claude", "commands"), { recursive: true });
      writeFileSync(join(root, ".claude", "commands", "ship.md"), "# ship\n", "utf8");
      // draft impl PLAN whose ONLY deliverable is a committed .claude/ asset -> must flag
      writePlanWithDeliverable(root, "PLAN-TEST-71-cmd.md", "draft", ".claude/commands/ship.md");
      // draft impl PLAN whose .claude/ deliverable does NOT exist yet -> no violation (in-progress)
      writePlanWithDeliverable(root, "PLAN-TEST-72-wip.md", "draft", ".claude/commands/none.md");

      const result = checkMergedPlanStatus(root);
      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("PLAN-TEST-71-cmd");
      expect(result.messages.join("\n")).not.toContain("PLAN-TEST-72-wip");

      const input = loadMergedPlanStatusInput(root);
      const flagged = input.plans.find((p) => p.planId === "PLAN-TEST-71-cmd");
      expect(flagged?.mergedArtifacts).toContain(".claude/commands/ship.md");
      // the PLAN's own docs/ artifact must NOT count as a merged deliverable
      expect(flagged?.mergedArtifacts).not.toContain("docs/plans/PLAN-TEST-71-cmd.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not flag a draft design PLAN that ships only a docs/ artifact (docs/ excluded, kind-independent)", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-merged-plan-design-"));
    try {
      mkdirSync(join(root, "docs", "plans"), { recursive: true });
      mkdirSync(join(root, "docs", "design"), { recursive: true });
      writeFileSync(join(root, "docs", "design", "x.md"), "# design\n", "utf8");
      writeFileSync(
        join(root, "docs", "plans", "PLAN-TEST-73-design.md"),
        [
          "---",
          "plan_id: PLAN-TEST-73-design",
          "status: draft",
          "kind: add-design",
          "generates:",
          "  - artifact_path: docs/design/x.md",
          "    artifact_type: markdown_doc",
          "---",
          "",
          "body",
          "",
        ].join("\n"),
        "utf8",
      );
      const result = checkMergedPlanStatus(root);
      expect(result.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // PLAN-L7-87 (2026-06-22): the real drift — a draft add-design/poc PLAN that merged a src/
  // deliverable. The pre-fix gate skipped these by kind; it must now flag them by deliverable.
  it("flags a draft add-design PLAN whose merged deliverable is a src/ module (kind-independent)", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-merged-plan-adsrc-"));
    try {
      mkdirSync(join(root, "docs", "plans"), { recursive: true });
      mkdirSync(join(root, "src", "lint"), { recursive: true });
      writeFileSync(join(root, "src", "lint", "y.ts"), "export const y = 1;\n", "utf8");
      writeFileSync(
        join(root, "docs", "plans", "PLAN-TEST-87-adsrc.md"),
        [
          "---",
          "plan_id: PLAN-TEST-87-adsrc",
          "status: draft",
          "kind: add-design",
          "generates:",
          "  - artifact_path: docs/plans/PLAN-TEST-87-adsrc.md",
          "    artifact_type: markdown_doc",
          "  - artifact_path: src/lint/y.ts",
          "    artifact_type: source_module",
          "---",
          "",
          "body",
          "",
        ].join("\n"),
        "utf8",
      );
      const result = checkMergedPlanStatus(root);
      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("PLAN-TEST-87-adsrc");
      const input = loadMergedPlanStatusInput(root);
      const flagged = input.plans.find((p) => p.planId === "PLAN-TEST-87-adsrc");
      expect(flagged?.mergedArtifacts).toContain("src/lint/y.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
