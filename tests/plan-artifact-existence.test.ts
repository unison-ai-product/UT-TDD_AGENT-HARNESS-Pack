import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkPlanArtifactExistence } from "../src/doctor/index";
import {
  analyzePlanArtifactExistence,
  loadPlanArtifactExistenceInput,
} from "../src/lint/plan-artifact-existence";

// PO /goal 2026-06-15: merged-plan-status (PLAN-L7-54) の鏡像。完了宣言 (confirmed/completed/accepted)
// した PLAN なのに generates artifact が不在 (phantom / false-completion) を機械検出する gate の回帰。

describe("analyzePlanArtifactExistence", () => {
  it("flags a completed PLAN whose declared artifact does not exist", () => {
    const r = analyzePlanArtifactExistence({
      plans: [{ planId: "PLAN-X", status: "completed", missingArtifacts: ["src/x.ts"] }],
    });
    expect(r.ok).toBe(false);
    expect(r.violations[0]?.planId).toBe("PLAN-X");
  });

  it("flags confirmed and accepted statuses too (all completion-claiming states)", () => {
    const r = analyzePlanArtifactExistence({
      plans: [
        { planId: "PLAN-C", status: "confirmed", missingArtifacts: ["docs/design/c.md"] },
        { planId: "PLAN-A", status: "accepted", missingArtifacts: ["tests/a.test.ts"] },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.planId)).toEqual(["PLAN-A", "PLAN-C"]);
  });

  it("does not flag a completed PLAN whose artifacts all exist", () => {
    const r = analyzePlanArtifactExistence({
      plans: [{ planId: "PLAN-OK", status: "completed", missingArtifacts: [] }],
    });
    expect(r.ok).toBe(true);
  });

  it("does not flag a draft PLAN with missing artifacts (not yet completed)", () => {
    // loader pre-filters by status; analyzer also only fires on completion statuses.
    const r = analyzePlanArtifactExistence({
      plans: [{ planId: "PLAN-WIP", status: "draft", missingArtifacts: ["src/wip.ts"] }],
    });
    expect(r.ok).toBe(true);
  });

  // PLAN-L7-91: hollow (実在するが空) も false-completion として flag する。
  it("flags a completed PLAN whose declared artifact exists but is hollow (empty)", () => {
    const r = analyzePlanArtifactExistence({
      plans: [
        {
          planId: "PLAN-H",
          status: "completed",
          missingArtifacts: [],
          hollowArtifacts: ["src/h.ts"],
        },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.violations[0]?.planId).toBe("PLAN-H");
    expect(r.violations[0]?.hollow).toEqual(["src/h.ts"]);
  });

  it("reports phantom and hollow distinctly for the same PLAN", () => {
    const r = analyzePlanArtifactExistence({
      plans: [
        {
          planId: "PLAN-PH",
          status: "completed",
          missingArtifacts: ["src/gone.ts"],
          hollowArtifacts: ["src/empty.ts"],
        },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.violations[0]?.missing).toEqual(["src/gone.ts"]);
    expect(r.violations[0]?.hollow).toEqual(["src/empty.ts"]);
  });

  it("does not flag a draft PLAN with a hollow artifact (WIP stub allowed until completion)", () => {
    const r = analyzePlanArtifactExistence({
      plans: [
        {
          planId: "PLAN-WIP2",
          status: "draft",
          missingArtifacts: [],
          hollowArtifacts: ["src/stub.ts"],
        },
      ],
    });
    expect(r.ok).toBe(true);
  });
});

describe("loadPlanArtifactExistenceInput + checkPlanArtifactExistence", () => {
  function writePlan(root: string, name: string, status: string, artifactPath: string): void {
    writeFileSync(
      join(root, "docs", "plans", name),
      [
        "---",
        `plan_id: ${name.replace(/\.md$/, "")}`,
        `status: ${status}`,
        "kind: impl",
        "generates:",
        `  - artifact_path: ${artifactPath}`,
        "    artifact_type: source_module",
        "---",
        "",
        "body",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  it("detects a completed PLAN whose generated artifact is missing (phantom)", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-plan-artifact-"));
    try {
      mkdirSync(join(root, "docs", "plans"), { recursive: true });
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "real.ts"), "export const x = 1;\n", "utf8");
      // completed PLAN whose src exists → no violation
      writePlan(root, "PLAN-TEST-92-real.md", "completed", "src/real.ts");
      // completed PLAN whose src does NOT exist → phantom violation
      writePlan(root, "PLAN-TEST-93-phantom.md", "completed", "src/phantom.ts");
      // draft PLAN whose src does NOT exist → no violation (not yet completed)
      writePlan(root, "PLAN-TEST-94-wip.md", "draft", "src/wip.ts");

      const result = checkPlanArtifactExistence(root);
      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("PLAN-TEST-93-phantom");
      expect(result.messages.join("\n")).not.toContain("PLAN-TEST-92-real");
      expect(result.messages.join("\n")).not.toContain("PLAN-TEST-94-wip");

      const input = loadPlanArtifactExistenceInput(root);
      const phantom = input.plans.find((p) => p.planId === "PLAN-TEST-93-phantom");
      expect(phantom?.missingArtifacts).toContain("src/phantom.ts");
      // draft PLAN is pre-filtered out of the loader input entirely
      expect(input.plans.find((p) => p.planId === "PLAN-TEST-94-wip")).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects a completed PLAN whose generated artifact exists but is empty (hollow), and exempts .gitkeep", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-plan-artifact-hollow-"));
    try {
      mkdirSync(join(root, "docs", "plans"), { recursive: true });
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, ".ut-tdd", "cache"), { recursive: true });
      // exists but whitespace-only → hollow
      writeFileSync(join(root, "src", "hollow.ts"), "   \n\t\n", "utf8");
      // intentional empty placeholder → exempt
      writeFileSync(join(root, ".ut-tdd", "cache", ".gitkeep"), "", "utf8");
      writePlan(root, "PLAN-TEST-91-hollow.md", "completed", "src/hollow.ts");
      writePlan(root, "PLAN-TEST-91b-keep.md", "completed", ".ut-tdd/cache/.gitkeep");

      const result = checkPlanArtifactExistence(root);
      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("PLAN-TEST-91-hollow");
      expect(result.messages.join("\n")).toContain("hollow");
      expect(result.messages.join("\n")).not.toContain("PLAN-TEST-91b-keep");

      const input = loadPlanArtifactExistenceInput(root);
      const hollow = input.plans.find((p) => p.planId === "PLAN-TEST-91-hollow");
      expect(hollow?.hollowArtifacts).toContain("src/hollow.ts");
      expect(hollow?.missingArtifacts).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not flag a completed PLAN that declares no generates (boundary: empty/absent)", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-plan-artifact-nogen-"));
    try {
      mkdirSync(join(root, "docs", "plans"), { recursive: true });
      writeFileSync(
        join(root, "docs", "plans", "PLAN-TEST-95-nogen.md"),
        [
          "---",
          "plan_id: PLAN-TEST-95-nogen",
          "status: completed",
          "kind: design",
          "---",
          "",
          "body",
          "",
        ].join("\n"),
        "utf8",
      );
      const result = checkPlanArtifactExistence(root);
      expect(result.ok).toBe(true);
      const input = loadPlanArtifactExistenceInput(root);
      expect(input.plans.find((p) => p.planId === "PLAN-TEST-95-nogen")?.missingArtifacts).toEqual(
        [],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects phantom even when the PLAN frontmatter uses CRLF line endings (Windows-first, I-1)", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-plan-artifact-crlf-"));
    try {
      mkdirSync(join(root, "docs", "plans"), { recursive: true });
      const crlf = [
        "---",
        "plan_id: PLAN-TEST-96-crlf",
        "status: completed",
        "kind: impl",
        "generates:",
        "  - artifact_path: src/crlf-phantom.ts",
        "    artifact_type: source_module",
        "---",
        "",
        "body",
        "",
      ].join("\r\n");
      writeFileSync(join(root, "docs", "plans", "PLAN-TEST-96-crlf.md"), crlf, "utf8");
      const result = checkPlanArtifactExistence(root);
      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("PLAN-TEST-96-crlf");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when repo root cannot be read", () => {
    const result = checkPlanArtifactExistence(join(tmpdir(), "ut-tdd-plan-artifact-nope-zzz"));
    expect(result.ok).toBe(false);
  });
});
