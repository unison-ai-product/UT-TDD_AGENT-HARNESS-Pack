import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findReference } from "../src/search/index.ts";
import { stableId } from "../src/stable-id.ts";
import { deriveArtifactProgressDecision } from "../src/state-db/artifact-progress-decision.ts";
import {
  analyzeDesignDetectionStats,
  collectDesignDetectionStats,
  DESIGN_QUALITY_CHECK_IDS,
} from "../src/state-db/design-detection.ts";
import {
  decideRefactorCandidate,
  projectFeedbackEvents,
  projectIssueApprovalGuardrails,
  projectIssueQueue,
  projectRefactorCandidateSignals,
  projectRetryEvents,
} from "../src/state-db/feedback-projections.ts";
import { type HarnessDb, isSecretLike, openHarnessDb } from "../src/state-db/index.ts";
import { migrate, rowCounts } from "../src/state-db/migration.ts";
import {
  projectDesignPairFreezeFindings,
  projectRuntimeGuardrailDecisionFromSessionEvent,
  projectRuntimeSkillInvocationFromSessionEvent,
  projectRuntimeTestRunFromSessionEvent,
  rebuildHarnessDb,
  recordProjectionEvent,
} from "../src/state-db/projection-writer.ts";
import {
  REFACTOR_CANDIDATE_THRESHOLDS,
  REFACTOR_POLICY_TERMS,
} from "../src/state-db/refactor-candidate-policy.ts";
import {
  analyzeRefactorCandidates,
  refactorCandidateKey,
} from "../src/state-db/refactor-candidates.ts";
import { projectRuntimeTestRunFromSessionEvent as projectRuntimeTestRunFromSessionEventCore } from "../src/state-db/runtime-projections.ts";
import { projectSkillMetrics as projectSkillMetricsCore } from "../src/state-db/skill-projections.ts";
import { claudeProjectSlug } from "../src/state-db/token-tracker.ts";

const hasSourceScreenDocs = () =>
  existsSync(join(process.cwd(), "docs", "design", "harness", "L2-screen", "screen-list.md")) &&
  existsSync(
    join(process.cwd(), "docs", "design", "harness", "L1-requirements", "screen-requirements.md"),
  );

describe("SECRET_PATTERN word-boundary anchoring", () => {
  it("does not match 'sk' inside a word but matches a boundary-delimited token", () => {
    // U-SECRET-001
    // Hyphenated slugs / paths must not false-positive (these crashed db rebuild).
    // The "sk" segments are interpolated so no literal token appears in source.
    expect(isSecretLike(`changed-path-src-${"task"}-has-no-relation-graph-node-impact`)).toBe(
      false,
    );
    expect(isSecretLike(`review the ${"risk"}-assessment-and-mitigation-plan-now-please`)).toBe(
      false,
    );
    expect(isSecretLike("planning-and-task-breakdown")).toBe(false);
    // Real boundary-delimited tokens (16+ chars) are still detected.
    expect(isSecretLike(`sk-${"a".repeat(20)}`)).toBe(true);
    expect(isSecretLike(`leaked ghp_${"b".repeat(20)} here`)).toBe(true);
  });
});

describe("IT-DB-01/02: harness.db projection writer", () => {
  it("rebuilds a clean pack repo with root skills and no docs/plans", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-pack-projection-"));
    try {
      mkdirSync(join(root, "skills"), { recursive: true });
      writeFileSync(
        join(root, "skills", "refactoring.md"),
        [
          "---",
          "schema_version: skill.v1",
          "name: refactoring",
          "skill_type: workflow",
          "category: workflow",
          "applies_to:",
          "  drive_models:",
          "    - Refactor",
          "---",
          "# refactoring",
          "",
        ].join("\n"),
        "utf8",
      );
      const db = openHarnessDb(":memory:", { repoRoot: root });
      try {
        const result = rebuildHarnessDb({
          repoRoot: root,
          db,
          relationGraph: { nodes: [], edges: [], verificationProfiles: [], findings: [] },
          documentExports: {
            document_export_runs: [],
            document_export_datasets: [],
            document_export_artifacts: [],
            findings: [],
            actionsTaken: [],
            ok: true,
          },
        });
        const row = db
          .prepare("SELECT path FROM automation_assets WHERE asset_id = ?")
          .get("skill:refactoring") as { path?: string } | undefined;

        expect(result.ok).toBe(true);
        expect(row?.path).toBe("skills/refactoring.md");
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("CANDIDATE-U-PLANRET-022: projects design-quality coverage rows from the real repo rebuild", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      rebuildHarnessDb({ db });

      const rows = db
        .prepare(
          "SELECT subject_id, value, threshold, status FROM coverage WHERE scope = ? AND metric = ? ORDER BY subject_id",
        )
        .all("design-quality", "violation_count") as Array<{
        subject_id: string;
        value: number;
        threshold: number;
        status: string;
      }>;
      expect(rows.map((row) => row.subject_id)).toEqual([...DESIGN_QUALITY_CHECK_IDS].sort());
      expect(rows.every((row) => row.value === 0 && row.threshold === 0)).toBe(true);
      expect(rows.every((row) => row.status === "passed")).toBe(true);

      const stats = collectDesignDetectionStats(db);
      expect(analyzeDesignDetectionStats(stats).ok).toBe(true);
    } finally {
      db.close();
    }
  });

  it("projects pair-freeze orphan findings as DB-detectable design findings", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-design-pair-projection-"));
    try {
      mkdirSync(join(root, "docs", "design", "harness", "L1-requirements"), {
        recursive: true,
      });
      mkdirSync(join(root, "docs", "test-design", "harness"), { recursive: true });
      writeFileSync(
        join(root, "docs", "design", "harness", "L1-requirements", "functional.md"),
        ["---", "layer: L1", "status: confirmed", "---", "# functional", ""].join("\n"),
        "utf8",
      );
      const db = openHarnessDb(":memory:", { repoRoot: root });
      try {
        migrate(db);
        projectDesignPairFreezeFindings(root, db);
        const finding = db
          .prepare(
            "SELECT kind, severity, subject_id, source, status FROM findings WHERE kind LIKE ?",
          )
          .get("design-pair-orphan:%");
        expect(finding).toMatchObject({
          kind: "design-pair-orphan:pair-missing",
          severity: "error",
          subject_id: "docs/design/harness/L1-requirements/functional.md",
          source: "vmodel-pair-freeze",
          status: "open",
        });
        expect(analyzeDesignDetectionStats(collectDesignDetectionStats(db)).ok).toBe(false);
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects typed refactor candidates for split, extraction, dedupe, and externalization", () => {
    expect(REFACTOR_CANDIDATE_THRESHOLDS.splitModuleLines).toBe(400);
    expect(REFACTOR_POLICY_TERMS).toContain("subagent");

    const longFunction = Array.from({ length: 121 }, (_, i) => `  total += ${i};`).join("\n");
    const duplicateBody = Array.from({ length: 10 }, (_, i) => `  value += ${i};`).join("\n");
    const repeatedLiteral = "copy this generated command before continuing";
    const candidates = analyzeRefactorCandidates([
      {
        path: "src/large.ts",
        content: `${Array.from({ length: 25 }, (_, i) => `export const v${i} = ${i};`).join("\n")}`,
      },
      {
        path: "src/functions.ts",
        content: `
function tooLarge() {
  let total = 0;
${longFunction}
  return total;
}
function duplicateOne() {
  let value = 0;
${duplicateBody}
  return value;
}
function duplicateTwo() {
  let value = 0;
${duplicateBody}
  return value;
}
export function literals() {
  return [
    "${repeatedLiteral}",
    "${repeatedLiteral}",
    "${repeatedLiteral}",
    "${repeatedLiteral}",
    "${repeatedLiteral}",
    "${repeatedLiteral}",
  ];
}
`,
      },
    ]);

    expect(candidates.map((candidate) => candidate.kind)).toEqual(
      expect.arrayContaining([
        "split-module",
        "extract-helper",
        "deduplicate-function",
        "externalize-literal",
      ]),
    );
    expect(
      analyzeRefactorCandidates([
        {
          path: "src/noise.ts",
          content: `
export const noise = [
  "docs/test-design/harness/L7-unit-test-design.md",
  "docs/test-design/harness/L7-unit-test-design.md",
  "docs/test-design/harness/L7-unit-test-design.md",
  "docs/test-design/harness/L7-unit-test-design.md",
  "docs/test-design/harness/L7-unit-test-design.md",
  "docs/test-design/harness/L7-unit-test-design.md",
  "evidence_path",
  "evidence_path",
  "evidence_path",
  "evidence_path",
  "evidence_path",
  "evidence_path",
  "--session <id>",
  "--session <id>",
  "--session <id>",
  "--session <id>",
  "--session <id>",
  "--session <id>",
];
`,
        },
      ]).filter((candidate) => candidate.kind === "externalize-literal"),
    ).toHaveLength(0);

    const exportOnly = analyzeRefactorCandidates([
      {
        path: "src/public-surface.ts",
        content: Array.from({ length: 26 }, (_, i) => `export const value${i} = ${i};`).join("\n"),
      },
    ]).find((candidate) => candidate.kind === "split-module");
    expect(exportOnly).toMatchObject({
      score: 26,
      threshold: 24,
      confidence: "medium",
    });
    const manyExports = analyzeRefactorCandidates([
      {
        path: "src/schema-catalog.ts",
        content: Array.from({ length: 53 }, (_, i) => `export const schema${i} = ${i};`).join("\n"),
      },
    ]).find((candidate) => candidate.kind === "split-module");
    expect(manyExports).toMatchObject({
      score: 53,
      threshold: 24,
      confidence: "medium",
    });
    const schemaIndexCatalog = analyzeRefactorCandidates([
      {
        path: "src/schema/index.ts",
        content: Array.from({ length: 53 }, (_, i) => `export const schema${i} = ${i};`).join("\n"),
      },
    ]).find((candidate) => candidate.kind === "split-module");
    expect(schemaIndexCatalog).toBeUndefined();
    const declarativeCatalog = analyzeRefactorCandidates([
      {
        path: "src/task/proposal-coverage-data.ts",
        content: [
          "export const CATALOG = [",
          ...Array.from({ length: 900 }, (_, i) => `  { id: ${i} },`),
          "];",
        ].join("\n"),
      },
    ]).find((candidate) => candidate.kind === "split-module");
    expect(declarativeCatalog).toMatchObject({
      score: expect.any(Number),
      threshold: 400,
      confidence: "medium",
    });
    const shortFunctionOrchestrator = analyzeRefactorCandidates([
      {
        path: "src/doctor/index.ts",
        content: Array.from(
          { length: 260 },
          (_, i) => `function check${i}() {\n  return ${i};\n}`,
        ).join("\n"),
      },
    ]).find((candidate) => candidate.kind === "split-module");
    expect(shortFunctionOrchestrator).toMatchObject({
      score: expect.any(Number),
      threshold: 400,
      confidence: "medium",
    });
    const largeFunctionModule = analyzeRefactorCandidates([
      {
        path: "src/large-orchestrator.ts",
        content: `export function tooLarge() {\n${Array.from(
          { length: 900 },
          (_, i) => `  returnValue += ${i};`,
        ).join("\n")}\n}`,
      },
    ]).find((candidate) => candidate.kind === "split-module");
    expect(largeFunctionModule).toMatchObject({
      score: expect.any(Number),
      threshold: 400,
      confidence: "high",
    });
    const policyExternalization = analyzeRefactorCandidates([
      {
        path: "src/team/stage-injection.ts",
        content: `
export function subagentInjectionForStage(stage: string) {
  if (stage === "design") return { subagent: "pmo-sonnet", inject: ["design-doc"] };
  if (stage === "implement") return { subagent: "be-logic", inject: ["testing"] };
  if (stage === "review") return { subagent: "code-reviewer", inject: ["review"] };
  return { subagent: "refactor-scout", inject: ["refactor"] };
}
`,
      },
    ]).find((candidate) => candidate.kind === "externalize-policy");
    expect(policyExternalization).toMatchObject({
      threshold: 5,
      confidence: "high",
    });
    const broadOrchestratorPolicyNoise = analyzeRefactorCandidates([
      {
        path: "src/cli.ts",
        content: [
          ...Array.from(
            { length: 48 },
            (_, i) => `if (phase === "phase-${i}") return routeModelTierProfileSkillAgent(${i});`,
          ),
          "export function routeModelTierProfileSkillAgent(value: number) { return value; }",
        ].join("\n"),
      },
    ]).filter((candidate) => candidate.kind === "externalize-policy");
    expect(broadOrchestratorPolicyNoise).toHaveLength(0);
    const detectorSelfNoise = analyzeRefactorCandidates([
      {
        path: "src/state-db/refactor-candidates.ts",
        content: `
import { REFACTOR_POLICY_TERMS } from "./refactor-candidate-policy";
export function collectExternalizedPolicyCandidates(text: string) {
  if (text.includes("stage")) return REFACTOR_POLICY_TERMS;
  if (text.includes("phase")) return REFACTOR_POLICY_TERMS;
  if (text.includes("route")) return REFACTOR_POLICY_TERMS;
  if (text.includes("approval")) return REFACTOR_POLICY_TERMS;
  if (text.includes("model")) return REFACTOR_POLICY_TERMS;
  if (text.includes("tier")) return REFACTOR_POLICY_TERMS;
  if (text.includes("profile")) return REFACTOR_POLICY_TERMS;
  if (text.includes("skill")) return REFACTOR_POLICY_TERMS;
  if (text.includes("subagent")) return REFACTOR_POLICY_TERMS;
  return [];
}
`,
      },
    ]).filter((candidate) => candidate.kind === "externalize-policy");
    expect(detectorSelfNoise).toHaveLength(0);
    const externalizedPolicyPair = analyzeRefactorCandidates([
      {
        path: "src/runtime/agent-guard.ts",
        content: `
export function evaluateAgentGuard(input: { stage: string; route: string; model: string }) {
  if (input.stage === "design") return input.route;
  if (input.stage === "review") return input.model;
  if (input.stage === "agent") return "subagent";
  if (input.stage === "approval") return "approved";
  return "policy";
}
`,
      },
      {
        path: "src/runtime/agent-guard-policy.ts",
        content: 'export const AGENT_POLICY = ["design", "review", "approval"];',
      },
    ]).filter((candidate) => candidate.kind === "externalize-policy");
    expect(externalizedPolicyPair).toHaveLength(0);
  });

  it("projects refactor candidates into quality signals and feedback events", () => {
    const repoRoot = join(tmpdir(), `ut-tdd-refactor-candidate-${randomUUID()}`);
    try {
      mkdirSync(join(repoRoot, "src"), { recursive: true });
      mkdirSync(join(repoRoot, "docs", "plans"), { recursive: true });
      writeFileSync(
        join(repoRoot, "src", "fixture.ts"),
        Array.from({ length: 950 }, (_, i) => `function check${i}() {\n  return ${i};\n}`).join(
          "\n",
        ),
      );

      const db = openHarnessDb(":memory:", { repoRoot });
      try {
        const result = rebuildHarnessDb({
          repoRoot,
          db,
          relationGraph: { nodes: [], edges: [], verificationProfiles: [], findings: [] },
          documentExports: {
            document_export_runs: [],
            document_export_datasets: [],
            document_export_artifacts: [],
            findings: [],
            actionsTaken: [],
            ok: true,
          },
          verificationEvidence: {
            verification_profiles: [],
            verification_recommendations: [],
            mcp_server_runs: [],
            external_tool_findings: [],
            findings: [],
            ok: true,
          },
        });
        expect(result.ok).toBe(true);

        const signal = db
          .prepare(
            "SELECT source, metric, subject_id, status FROM quality_signals WHERE source = ?",
          )
          .get("refactor-candidate-detector");
        expect(signal).toMatchObject({
          source: "refactor-candidate-detector",
          metric: "refactor_candidate:split-module",
          subject_id: "src/fixture.ts",
          status: "warn",
        });

        const feedback = db
          .prepare(
            "SELECT source_table, signal_type, severity, next_action FROM feedback_events WHERE signal_type = ?",
          )
          .get("refactor_candidate:split-module");
        expect(feedback).toMatchObject({
          source_table: "quality_signals",
          signal_type: "refactor_candidate:split-module",
          severity: "warn",
        });
        expect(String(feedback?.next_action ?? "")).toContain("review quality signal");
      } finally {
        db.close();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("projects refactor candidate signals through the externalized feedback projection module", () => {
    const repoRoot = join(tmpdir(), `ut-tdd-refactor-signal-${randomUUID()}`);
    try {
      mkdirSync(join(repoRoot, "src"), { recursive: true });
      writeFileSync(
        join(repoRoot, "src", "fixture.ts"),
        Array.from({ length: 950 }, (_, i) => `function check${i}() {\n  return ${i};\n}`).join(
          "\n",
        ),
      );

      const events: Array<{ table: string; row: Record<string, unknown> }> = [];
      projectRefactorCandidateSignals(repoRoot, {} as HarnessDb, {
        nowIso: () => "2026-06-25T00:00:00.000Z",
        stableId: (prefix, value) => `${prefix}:${value}`,
        recordProjectionEvent: (_db, event) => events.push({ table: event.table, row: event.row }),
      });

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            table: "quality_signals",
            row: expect.objectContaining({
              source: "refactor-candidate-detector",
              metric: "refactor_candidate:split-module",
              status: "warn",
            }),
          }),
        ]),
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("keeps refactor candidate lifecycle decisions across rebuilds", () => {
    const repoRoot = join(tmpdir(), `ut-tdd-refactor-lifecycle-${randomUUID()}`);
    try {
      mkdirSync(join(repoRoot, "src"), { recursive: true });
      writeFileSync(
        join(repoRoot, "src", "fixture.ts"),
        Array.from({ length: 950 }, (_, i) => `function check${i}() {\n  return ${i};\n}`).join(
          "\n",
        ),
      );

      const db = openHarnessDb(":memory:", { repoRoot });
      try {
        const input = {
          repoRoot,
          db,
          relationGraph: { nodes: [], edges: [], verificationProfiles: [], findings: [] },
          documentExports: {
            document_export_runs: [],
            document_export_datasets: [],
            document_export_artifacts: [],
            findings: [],
            actionsTaken: [],
            ok: true,
          },
          verificationEvidence: {
            verification_profiles: [],
            verification_recommendations: [],
            mcp_server_runs: [],
            external_tool_findings: [],
            findings: [],
            ok: true,
          },
        };
        expect(rebuildHarnessDb(input).ok).toBe(true);

        const detected = analyzeRefactorCandidates([
          {
            path: "src/fixture.ts",
            content: Array.from(
              { length: 950 },
              (_, i) => `function check${i}() {\n  return ${i};\n}`,
            ).join("\n"),
          },
        ]).find((candidate) => candidate.kind === "split-module");
        expect(detected).toBeDefined();
        if (!detected) throw new Error("split-module candidate was not detected");
        const candidateKey = refactorCandidateKey(detected);
        const initial = db
          .prepare("SELECT state, linked_plan_id FROM refactor_candidates WHERE candidate_key = ?")
          .get(candidateKey);
        expect(initial).toMatchObject({ state: "open", linked_plan_id: "" });

        expect(
          decideRefactorCandidate(db, {
            candidate_key: candidateKey,
            state: "rejected",
            decided_at: "2026-07-08T20:00:00.000Z",
          }).ok,
        ).toBe(true);
        expect(rebuildHarnessDb(input).ok).toBe(true);

        const preserved = db
          .prepare("SELECT state, linked_plan_id FROM refactor_candidates WHERE candidate_key = ?")
          .get(candidateKey);
        expect(preserved).toMatchObject({ state: "rejected", linked_plan_id: "" });
        const signal = db
          .prepare("SELECT status FROM quality_signals WHERE source = ? AND subject_id = ?")
          .get("refactor-candidate-detector", "src/fixture.ts");
        expect(signal).toMatchObject({ status: "pass" });
        const feedback = db
          .prepare("SELECT COUNT(*) AS n FROM feedback_events WHERE signal_type = ?")
          .get("refactor_candidate:split-module");
        expect(Number(feedback?.n ?? 0)).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("routes verification defect findings into refactor candidate lifecycle rows", () => {
    const repoRoot = join(tmpdir(), `ut-tdd-defect-routing-refactor-${randomUUID()}`);
    try {
      const db = openHarnessDb(":memory:", { repoRoot });
      try {
        const input = {
          repoRoot,
          db,
          relationGraph: { nodes: [], edges: [], verificationProfiles: [], findings: [] },
          documentExports: {
            document_export_runs: [],
            document_export_datasets: [],
            document_export_artifacts: [],
            findings: [],
            actionsTaken: [],
            ok: true,
          },
          verificationEvidence: {
            verification_profiles: [],
            verification_recommendations: [],
            mcp_server_runs: [],
            external_tool_findings: [],
            findings: [
              {
                code: "missing-test-coverage" as const,
                severity: "warn" as const,
                message: "integration structure is weak; route through defect_routing to Refactor",
                nodeId: "src/workflow/weak-module.ts#integration-structure-refactor",
                evidencePath: "docs/test-design/harness/L8-integration-test-design.md",
              },
            ],
            ok: false,
          },
        };
        expect(rebuildHarnessDb(input).ok).toBe(true);

        const candidate = db
          .prepare(
            "SELECT candidate_key, kind, path, subject, state, linked_plan_id FROM refactor_candidates WHERE kind = ?",
          )
          .get("verification-defect-routing") as
          | {
              candidate_key: string;
              kind: string;
              path: string;
              subject: string;
              state: string;
              linked_plan_id: string;
            }
          | undefined;
        expect(candidate).toMatchObject({
          kind: "verification-defect-routing",
          path: "docs/test-design/harness/L8-integration-test-design.md",
          subject: "src/workflow/weak-module.ts#integration-structure-refactor",
          state: "open",
          linked_plan_id: "",
        });

        const signal = db
          .prepare(
            "SELECT source, metric, subject_id, status FROM quality_signals WHERE source = ?",
          )
          .get("verification-defect-routing");
        expect(signal).toMatchObject({
          source: "verification-defect-routing",
          metric: "refactor_candidate:verification-defect-routing",
          subject_id: "src/workflow/weak-module.ts#integration-structure-refactor",
          status: "warn",
        });

        expect(
          decideRefactorCandidate(db, {
            candidate_key: candidate?.candidate_key ?? "",
            state: "accepted",
            linked_plan_id: "PLAN-L7-410-defect-routing-refactor-candidates",
            decided_at: "2026-07-09T00:00:00.000Z",
          }).ok,
        ).toBe(true);
        expect(rebuildHarnessDb(input).ok).toBe(true);

        const preserved = db
          .prepare("SELECT state, linked_plan_id FROM refactor_candidates WHERE candidate_key = ?")
          .get(candidate?.candidate_key ?? "");
        expect(preserved).toMatchObject({
          state: "accepted",
          linked_plan_id: "PLAN-L7-410-defect-routing-refactor-candidates",
        });
        const closedSignal = db
          .prepare("SELECT status FROM quality_signals WHERE source = ?")
          .get("verification-defect-routing");
        expect(closedSignal).toMatchObject({ status: "pass" });
      } finally {
        db.close();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("derives artifact progress colors from dependency checks and linked tests", () => {
    expect(
      deriveArtifactProgressDecision({
        linkedTestCount: 0,
        dependencyChecked: false,
        openDependencyImpacts: 0,
      }),
    ).toMatchObject({ state: "dependency_unchecked", color: "red" });
    expect(
      deriveArtifactProgressDecision({
        linkedTestCount: 0,
        dependencyChecked: true,
        openDependencyImpacts: 0,
      }),
    ).toMatchObject({ state: "implemented_unverified", color: "yellow" });
    expect(
      deriveArtifactProgressDecision({
        linkedTestCount: 1,
        dependencyChecked: true,
        openDependencyImpacts: 0,
      }),
    ).toMatchObject({ state: "implemented_unverified", color: "yellow" });
    expect(
      deriveArtifactProgressDecision({
        linkedTestCount: 1,
        passedLinkedTestRunCount: 1,
        dependencyChecked: true,
        openDependencyImpacts: 0,
      }),
    ).toMatchObject({ state: "verified", color: "green" });
    expect(
      deriveArtifactProgressDecision({
        linkedTestCount: 1,
        passedLinkedTestRunCount: 1,
        dependencyChecked: true,
        openDependencyImpacts: 1,
      }),
    ).toMatchObject({ state: "dependency_unchecked", color: "red" });
  });

  it("records normalized projection events idempotently", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      const event = {
        table: "gate_runs",
        id: "gate-1",
        row: {
          gate_run_id: "gate-1",
          gate_id: "G-L7DB.B",
          plan_id: null,
          status: "passed",
          checked_at: "2026-06-11T00:01:00.000Z",
          evidence_path: "docs/handover/projection.md",
        },
      };
      recordProjectionEvent(db, event);
      recordProjectionEvent(db, event);

      expect(rowCounts(db).gate_runs).toBe(1);
      expect(
        db.prepare("SELECT * FROM gate_runs WHERE gate_run_id = ?").get("gate-1"),
      ).toMatchObject(event.row);
    } finally {
      db.close();
    }
  });

  it("U-DBPROJ-GATE-01 projects runs with legacy PLAN IDs or aliases without PLAN links or retries", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-gate-run-projection-"));
    const planAlias = "PLAN-L7-363";
    const planId = `${planAlias}-routine-gate-run-projection`;
    try {
      mkdirSync(join(root, "docs", "plans"), { recursive: true });
      writeFileSync(
        join(root, "docs", "plans", `${planId}.md`),
        [
          "---",
          `plan_id: ${planId}`,
          'title: "gate run projection fixture"',
          "kind: impl",
          "layer: L7",
          "drive: db",
          "status: confirmed",
          "route_signal: feature_addition",
          "route_mode: add-feature",
          "created: 2026-07-09",
          "updated: 2026-07-09",
          "---",
          "",
          "# gate run projection fixture",
          "",
        ].join("\n"),
        "utf8",
      );
      mkdirSync(join(root, ".ut-tdd", "gate_runs"), { recursive: true });
      for (const [index, status] of ["failed", "passed"].entries()) {
        writeFileSync(
          join(root, ".ut-tdd", "gate_runs", `G4-attempt-${index + 1}.json`),
          `${JSON.stringify(
            {
              schema_version: 1,
              gate_run_id: `gate-run:G4:attempt-${index + 1}`,
              gate_id: "G4",
              plan_id: index === 0 ? planId : planAlias,
              status,
              checked_at: `2026-07-09T00:0${index}:00.000Z`,
              session_id: "session-gate-projection",
              mode: "hybrid",
              tier: "cross_agent",
              review_kind: "cross_agent",
              static_applicable: true,
              source: "ut-tdd gate",
              messages: [],
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
      }

      const db = openHarnessDb(":memory:", { repoRoot: root });
      try {
        rebuildHarnessDb({ repoRoot: root, db, skipTokenTelemetry: true });
        const gateRows = db
          .prepare(
            "SELECT gate_id, plan_id, status, evidence_path FROM gate_runs WHERE gate_id = ? ORDER BY checked_at",
          )
          .all("G4");
        expect(gateRows).toEqual([
          {
            gate_id: "G4",
            plan_id: null,
            status: "failed",
            evidence_path: ".ut-tdd/gate_runs/G4-attempt-1.json",
          },
          {
            gate_id: "G4",
            plan_id: null,
            status: "passed",
            evidence_path: ".ut-tdd/gate_runs/G4-attempt-2.json",
          },
        ]);
        const workflows = db
          .prepare(
            "SELECT workflow_run_id, plan_id, drive_run_id, workflow, phase, ready_status FROM workflow_runs WHERE workflow = ? AND phase = ? ORDER BY checked_at",
          )
          .all("routine-gate", "G4");
        expect(workflows).toEqual([
          {
            workflow_run_id: stableId("gate-workflow", "gate-run:G4:attempt-1"),
            plan_id: null,
            drive_run_id: "",
            workflow: "routine-gate",
            phase: "G4",
            ready_status: "blocked",
          },
          {
            workflow_run_id: stableId("gate-workflow", "gate-run:G4:attempt-2"),
            plan_id: null,
            drive_run_id: "",
            workflow: "routine-gate",
            phase: "G4",
            ready_status: "passed",
          },
        ]);
        const retries = db
          .prepare(
            "SELECT workflow, phase, attempt_count FROM retry_events WHERE workflow = ? AND phase = ?",
          )
          .all("routine-gate", "G4");
        expect(retries).toEqual([]);
        const retryMetric = db
          .prepare("SELECT value, status FROM quality_signals WHERE metric = ? AND subject_id = ?")
          .get("workflow_retry_groups", "workflow");
        expect(retryMetric).toMatchObject({ value: 0, status: "pass" });
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-DBPROJ-GATE-01 projects planless gate runs to workflow rows and excludes retry groups", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-planless-gate-run-projection-"));
    const runs = [
      { gate_run_id: "gate-run:G7:planless-attempt-1", status: "failed" },
      { gate_run_id: "gate-run:G7:planless-attempt-2", status: "passed" },
    ];
    try {
      const gateRunsDir = join(root, ".ut-tdd", "gate_runs");
      mkdirSync(gateRunsDir, { recursive: true });
      for (const [index, run] of runs.entries()) {
        writeFileSync(
          join(gateRunsDir, `G7-planless-attempt-${index + 1}.json`),
          `${JSON.stringify(
            {
              schema_version: 1,
              gate_run_id: run.gate_run_id,
              gate_id: "G7",
              plan_id: "",
              status: run.status,
              checked_at: `2026-07-09T00:0${index}:00.000Z`,
              session_id: "session-planless-gate-projection",
              mode: "hybrid",
              tier: "cross_agent",
              review_kind: "cross_agent",
              static_applicable: true,
              source: "ut-tdd gate",
              messages: [],
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
      }

      const db = openHarnessDb(":memory:", { repoRoot: root });
      try {
        rebuildHarnessDb({ repoRoot: root, db });
        const gateRows = db
          .prepare(
            "SELECT gate_run_id, gate_id, plan_id, status FROM gate_runs WHERE gate_id = ? ORDER BY checked_at",
          )
          .all("G7");
        expect(gateRows).toEqual(
          runs.map((run) => ({
            gate_run_id: run.gate_run_id,
            gate_id: "G7",
            plan_id: null,
            status: run.status,
          })),
        );

        const workflowRows = db
          .prepare(
            "SELECT workflow_run_id, plan_id, drive_run_id, workflow, phase, ready_status FROM workflow_runs WHERE workflow = ? AND phase = ? ORDER BY checked_at",
          )
          .all("routine-gate", "G7");
        expect(workflowRows).toEqual([
          {
            workflow_run_id: stableId("gate-workflow", runs[0].gate_run_id),
            plan_id: null,
            drive_run_id: "",
            workflow: "routine-gate",
            phase: "G7",
            ready_status: "blocked",
          },
          {
            workflow_run_id: stableId("gate-workflow", runs[1].gate_run_id),
            plan_id: null,
            drive_run_id: "",
            workflow: "routine-gate",
            phase: "G7",
            ready_status: "passed",
          },
        ]);
        expect(
          db
            .prepare("SELECT * FROM retry_events WHERE workflow = ? AND phase = ?")
            .all("routine-gate", "G7"),
        ).toEqual([]);
        const retryMetric = db
          .prepare("SELECT value, status FROM quality_signals WHERE metric = ? AND subject_id = ?")
          .get("workflow_retry_groups", "workflow");
        expect(retryMetric).toMatchObject({ value: 0, status: "pass" });
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-DBPROJ-GATE-01 keeps retry grouping for repeated non-routine workflows", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      const workflow = db.prepare(
        `INSERT INTO workflow_runs
           (workflow_run_id, plan_id, workflow, phase, ready_status, human_required)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      workflow.run("forward-impl-1", "PLAN-RETRY-CONTROL", "forward", "implement", "blocked", 0);
      workflow.run("forward-impl-2", "PLAN-RETRY-CONTROL", "forward", "implement", "passed", 0);
      projectRetryEvents(db, {
        nowIso: () => "2026-07-09T00:02:00.000Z",
        stableId,
        recordProjectionEvent,
      });

      expect(
        db
          .prepare("SELECT workflow, phase, attempt_count FROM retry_events WHERE plan_id = ?")
          .get("PLAN-RETRY-CONTROL"),
      ).toEqual({ workflow: "forward", phase: "implement", attempt_count: 2 });
    } finally {
      db.close();
    }
  });

  it.each([
    false,
    true,
  ])("U-DBPROJ-GATE-01 keeps A-132 seeds historical and ownerless with PLAN present=%s", (planPresent) => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-verification-band-seed-"));
    const layers = ["L8", "L9", "L10", "L11", "L12", "L13", "L14"] as const;
    const auditPath = ".ut-tdd/audit/A-132-l8-l14-verification-band-execution.md";
    try {
      mkdirSync(join(root, ".ut-tdd", "audit"), { recursive: true });
      writeFileSync(join(root, auditPath), "# A-132 verification-band execution\n", "utf8");
      if (planPresent) {
        mkdirSync(join(root, "docs", "plans"), { recursive: true });
        writeFileSync(
          join(root, "docs", "plans", "PLAN-M-00-verify-cutover.md"),
          [
            "---",
            "plan_id: PLAN-M-00-verify-cutover",
            'title: "verification band seed fixture"',
            "kind: impl",
            "layer: L7",
            "drive: db",
            "status: confirmed",
            "route_signal: feature_addition",
            "route_mode: add-feature",
            "created: 2026-07-09",
            "updated: 2026-07-09",
            "---",
            "",
            "# verification band seed fixture",
            "",
          ].join("\n"),
          "utf8",
        );
      }

      const db = openHarnessDb(":memory:", { repoRoot: root });
      try {
        rebuildHarnessDb({ repoRoot: root, db });
        const seedGates = layers.map((layer) =>
          db
            .prepare(
              "SELECT gate_run_id, gate_id, plan_id, status, evidence_path FROM gate_runs WHERE gate_run_id = ?",
            )
            .get(stableId("verification-band-gate", layer)),
        );
        expect(seedGates).toEqual(
          layers.map((layer) => ({
            gate_run_id: stableId("verification-band-gate", layer),
            gate_id: `G-VERIFY.${layer}`,
            plan_id: null,
            status: "historical",
            evidence_path: auditPath,
          })),
        );

        const workflowIds = layers.map((layer) => stableId("verification-band-workflow", layer));
        const workflowRows = db
          .prepare(
            `SELECT workflow_run_id FROM workflow_runs WHERE workflow_run_id IN (${workflowIds.map(() => "?").join(",")})`,
          )
          .all(...workflowIds);
        expect(workflowRows).toEqual([]);

        const coverageIds = layers.map((layer) =>
          stableId("verification-band-coverage", `${layer}:local_check_passed`),
        );
        const coverageRows = db
          .prepare(
            `SELECT coverage_id FROM coverage WHERE coverage_id IN (${coverageIds.map(() => "?").join(",")})`,
          )
          .all(...coverageIds);
        expect(coverageRows).toEqual([]);
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("projects runtime test_runs from session-log verification events with session provenance", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      projectRuntimeTestRunFromSessionEvent({
        db,
        event: {
          ts: "2026-06-29T00:01:00Z",
          session_id: "session-runtime-1",
          plan_id: null,
          event_type: "tool_use",
          tool: "Bash",
          target: "Bash (vitest)",
          outcome: "ok",
        },
        evidencePath: ".ut-tdd/logs/session/session-runtime-1.jsonl",
        lineNumber: 1,
      });
      projectRuntimeTestRunFromSessionEvent({
        db,
        event: {
          ts: "2026-06-29T00:02:00Z",
          session_id: "session-runtime-1",
          plan_id: null,
          event_type: "tool_use",
          tool: "Bash",
          target: "Bash (git)",
          outcome: "ok",
        },
        evidencePath: ".ut-tdd/logs/session/session-runtime-1.jsonl",
        lineNumber: 2,
      });
      projectRuntimeTestRunFromSessionEvent({
        db,
        event: {
          ts: "2026-06-29T00:03:00Z",
          session_id: "session-runtime-1",
          plan_id: null,
          event_type: "tool_use",
          tool: "PowerShell",
          target: "PowerShell (tsc)",
          outcome: "ok",
        },
        evidencePath: ".ut-tdd/logs/session/session-runtime-1.jsonl",
        lineNumber: 3,
      });

      const rows = db
        .prepare(
          "SELECT session_id, plan_id, command, runner, runtime, scope, exit_code, status, evidence_path FROM test_runs",
        )
        .all();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        session_id: "session-runtime-1",
        plan_id: null,
        command: "Bash (vitest)",
        runner: "node",
        runtime: "hook-session-log",
        scope: "runtime-hook",
        exit_code: 0,
        status: "passed",
        evidence_path: ".ut-tdd/logs/session/session-runtime-1.jsonl",
      });
      expect(rows[1]).toMatchObject({
        session_id: "session-runtime-1",
        plan_id: null,
        command: "PowerShell (tsc)",
        runner: "node",
        runtime: "hook-session-log",
        scope: "runtime-hook",
        exit_code: 0,
        status: "passed",
        evidence_path: ".ut-tdd/logs/session/session-runtime-1.jsonl",
      });
    } finally {
      db.close();
    }
  });

  it("keeps extracted runtime projection helpers behind injected dependencies", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      projectRuntimeTestRunFromSessionEventCore({
        db,
        event: {
          ts: "2026-07-02T00:01:00Z",
          session_id: "session-runtime-core",
          plan_id: "PLAN-L7-230-runtime-projection-extraction:alias",
          event_type: "tool_use",
          tool: "Bash",
          target: "Bash (doctor)",
          outcome: "error",
        },
        evidencePath: ".ut-tdd/logs/session/session-runtime-core.jsonl",
        lineNumber: 4,
        deps: {
          stableId: (prefix, value) => `${prefix}:${value}`,
          recordProjectionEvent,
        },
      });

      const row = db.prepare("SELECT plan_id, runner, exit_code, status FROM test_runs").get();
      expect(row).toMatchObject({
        plan_id: null,
        runner: "node",
        exit_code: 1,
        status: "failed",
      });
    } finally {
      db.close();
    }
  });

  it("keeps extracted skill metric helpers behind injected dependencies", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      recordProjectionEvent(db, {
        table: "skill_recommendations",
        id: "skill-rec-core",
        row: {
          skill_recommendation_id: "skill-rec-core",
          session_id: "",
          plan_id: "PLAN-L7-231-skill-projection-extraction",
          skill_id: "skill:review-checklist",
          rank: 1,
          score: 1,
          reason: "test",
          recommended_at: "2026-07-02T00:00:00.000Z",
        },
      });
      recordProjectionEvent(db, {
        table: "skill_invocations",
        id: "skill-inv-core",
        row: {
          skill_invocation_id: "skill-inv-core",
          session_id: "",
          plan_id: "PLAN-L7-231-skill-projection-extraction",
          skill_id: "skill:review-checklist",
          layer: "L7",
          drive: "db",
          fired_at: "2026-07-02T00:01:00.000Z",
          source: "runtime-hook:skill-suggest",
          accepted: 1,
        },
      });

      projectSkillMetricsCore({
        db,
        deps: {
          nowIso: () => "2026-07-02T00:02:00.000Z",
          stableId: (prefix, value) => `${prefix}:${value}`,
          recordProjectionEvent,
        },
      });

      const rows = db
        .prepare("SELECT metric, value, status FROM quality_signals WHERE source = ?")
        .all("skill-metrics:runtime");
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            metric: "skill_firing_rate",
            value: 1,
            status: "pass",
          }),
          expect.objectContaining({
            metric: "skill_acceptance_rate",
            value: 1,
            status: "pass",
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it("projects runtime guardrail_decisions from forced-stop session events only", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      const projectForcedStop = (sessionId: string, ts: string, planId: string | null) =>
        projectRuntimeGuardrailDecisionFromSessionEvent({
          db,
          event: {
            ts,
            session_id: sessionId,
            plan_id: planId,
            event_type: "forced_stop",
            outcome: "error",
          },
          evidencePath: `.ut-tdd/logs/session/${sessionId}.jsonl`,
          lineNumber: 1,
        });
      projectForcedStop(
        "session-guardrail-1",
        "2026-06-29T00:01:00Z",
        "PLAN-L7-200-runtime-guardrail-provenance",
      );
      projectRuntimeGuardrailDecisionFromSessionEvent({
        db,
        event: {
          ts: "2026-06-29T00:02:00Z",
          session_id: "session-guardrail-1",
          plan_id: "PLAN-L7-200-runtime-guardrail-provenance",
          event_type: "tool_use",
          tool: "Bash",
          target: "Bash (git)",
          outcome: "ok",
        },
        evidencePath: ".ut-tdd/logs/session/session-guardrail-1.jsonl",
        lineNumber: 2,
      });
      projectForcedStop("session-guardrail-no-plan", "2026-06-29T00:03:00Z", null);

      const rows = db
        .prepare(
          "SELECT session_id, plan_id, guardrail, decision, mode, human_signoff_required, evidence_path, decided_at FROM guardrail_decisions ORDER BY decided_at",
        )
        .all();
      expect(rows).toEqual([
        {
          session_id: "session-guardrail-1",
          plan_id: null,
          guardrail: "forced-stop",
          decision: "block",
          mode: "runtime-hook",
          human_signoff_required: 0,
          evidence_path: ".ut-tdd/logs/session/session-guardrail-1.jsonl",
          decided_at: "2026-06-29T00:01:00Z",
        },
        {
          session_id: "session-guardrail-no-plan",
          plan_id: null,
          guardrail: "forced-stop",
          decision: "block",
          mode: "runtime-hook",
          human_signoff_required: 0,
          evidence_path: ".ut-tdd/logs/session/session-guardrail-no-plan.jsonl",
          decided_at: "2026-06-29T00:03:00Z",
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("projects valid provider handovers without PLAN and skips unrelated JSON", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "ut-tdd-provider-handover-projection-"));
    const db = openHarnessDb(":memory:");
    try {
      const dir = join(repoRoot, ".ut-tdd", "handover", "provider");
      mkdirSync(dir, { recursive: true });
      const handoverId = "20260629000300-claude-to-codex";
      const timestamp = "2026-06-29T00:03:00Z";
      writeFileSync(
        join(dir, `${handoverId}.json`),
        JSON.stringify({
          schema_version: "provider-handover.v1",
          handover_kind: "mechanical",
          handover_id: handoverId,
          from: "claude",
          to: "codex",
          active_plan: null,
          context: { summary: "resume", next_actions: [], files: [] },
          created_at: timestamp,
        }),
        "utf8",
      );
      writeFileSync(join(dir, "unrelated.json"), "{}", "utf8");

      expect(rebuildHarnessDb({ repoRoot, db, skipTokenTelemetry: true }).ok).toBe(true);
      const events = db
        .prepare(
          "SELECT session_id, plan_id, hook_name, occurred_at, digest FROM hook_events WHERE event_type = 'provider_handover'",
        )
        .all();
      expect(events).toEqual([
        {
          session_id: handoverId,
          plan_id: null,
          hook_name: "ProviderHandover",
          occurred_at: timestamp,
          digest: "resume",
        },
      ]);
    } finally {
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("projects runtime skill invocation observations without PLAN or catalog identities", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      const event = {
        ts: "2026-06-29T00:01:00Z",
        session_id: "session-skill-1",
        plan_id: null,
        event_type: "tool_use",
        tool: "Bash",
        target: "Bash (skill)",
        outcome: "ok",
      };
      const evidencePath = ".ut-tdd/logs/session/session-skill-1.jsonl";
      const invocation = { db, event, evidencePath, lineNumber: 1 };
      projectRuntimeSkillInvocationFromSessionEvent(invocation);
      projectRuntimeSkillInvocationFromSessionEvent(invocation);
      projectRuntimeSkillInvocationFromSessionEvent({
        db,
        event: { ...event, target: "Bash (bash)" },
        evidencePath,
        lineNumber: 2,
      });

      const selectObservations = db.prepare(
        "SELECT session_id, plan_id, skill_id, layer, drive, source, accepted, fired_at FROM skill_invocations",
      );
      const observation = {
        session_id: "session-skill-1",
        plan_id: null,
        skill_id: null,
        layer: null,
        drive: null,
        source: "runtime-hook:skill-suggest",
        accepted: 1,
        fired_at: "2026-06-29T00:01:00Z",
      };
      expect(selectObservations.all()).toEqual([observation]);

      projectRuntimeSkillInvocationFromSessionEvent({
        db,
        event: { ...event, outcome: "error" },
        evidencePath,
        lineNumber: 3,
      });
      const observations = selectObservations.all();
      expect(observations).toHaveLength(2);
      expect(observations).toEqual(
        expect.arrayContaining([observation, { ...observation, accepted: 0 }]),
      );
    } finally {
      db.close();
    }
  });

  it("exempts structured-id columns from the secret check but still rejects free-form payload secrets", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      // Regression: a relation-graph finding_id slug that contains "sk-" inside a
      // "task-" run (built here so no literal token appears in source) matches the
      // canonical SECRET_PATTERN but is a structured identifier, not a secret. It
      // must NOT be rejected — this exact slug crashed `ut-tdd db rebuild`.
      const slugId = `finding:missing-projection:changed-path-src-${"task"}-has-no-relation-graph-node`;
      expect(() =>
        recordProjectionEvent(db, {
          table: "feedback_events",
          id: "feedback:idtest",
          row: {
            finding_id: slugId,
            plan_id: "",
            signal_type: "finding",
            severity: "warn",
            next_action: "review the missing relation-graph node",
          },
        }),
      ).not.toThrow();

      // A real high-entropy token in a free-form (non-id) column is still rejected.
      const realToken = `sk-${"a".repeat(20)}`;
      expect(() =>
        recordProjectionEvent(db, {
          table: "feedback_events",
          id: "feedback:leak",
          row: {
            finding_id: "",
            plan_id: "",
            signal_type: "finding",
            severity: "warn",
            next_action: `leaked ${realToken}`,
          },
        }),
      ).toThrow(/secret-like/);
    } finally {
      db.close();
    }
  });

  it("projects detector route candidates into feedback, dry-run issue queue, and approval guardrail", () => {
    const db = openHarnessDb(":memory:");
    const deps = {
      nowIso: () => "2026-07-08T00:00:00.000Z",
      stableId,
      recordProjectionEvent,
    };
    try {
      migrate(db);
      recordProjectionEvent(db, {
        table: "detector_route_candidates",
        id: "candidate:spec-ir-orphan",
        row: {
          route_candidate_id: "candidate:spec-ir-orphan",
          source_table: "findings",
          source_id: "finding:spec-ir-orphan",
          detector_id: "spec-ir-integrity",
          finding_kind: "spec-ir-orphan-relation",
          severity: "warn",
          subject_kind: "spec_ir",
          subject_id: "spec-relation:missing",
          filing_target_id: "routeFiling:feature_addition",
          target_layer: "L6",
          target_sub_doc: "function-spec",
          candidate_status: "non_ready",
          reason: "routeFiling SSoT evaluation required",
          evidence_path: "docs/plans/PLAN-L6-39-vmodel-spec-ir-function-contracts.md",
          computed_at: "2026-07-08T00:00:00.000Z",
        },
      });

      projectFeedbackEvents(db, deps);
      projectIssueQueue(db, deps);
      projectIssueApprovalGuardrails(db, deps);

      const feedback = db
        .prepare(
          "SELECT source_table, source_id, signal_type, severity, next_action FROM feedback_events WHERE source_table = ?",
        )
        .get("detector_route_candidates") as
        | {
            source_table: string;
            source_id: string;
            signal_type: string;
            severity: string;
            next_action: string;
          }
        | undefined;
      expect(feedback).toMatchObject({
        source_table: "detector_route_candidates",
        source_id: "candidate:spec-ir-orphan",
        signal_type: "detector_route_candidate:spec-ir-orphan-relation",
        severity: "warn",
      });
      expect(feedback?.next_action).toContain("routeFiling SSoT");
      expect(feedback?.next_action).toContain("route_eval_mode=add-feature");
      expect(feedback?.next_action).toContain("allowed_kinds=add-design,add-impl");
      expect(feedback?.next_action).toContain("layer_band=L3-L6,L7");

      const issue = db
        .prepare(
          "SELECT title, body, status, human_approval_required, external_issue_url FROM issue_queue WHERE source_event_id = ?",
        )
        .get("feedback:detector-route-candidate:candidate:spec-ir-orphan") as
        | {
            title: string;
            body: string;
            status: string;
            human_approval_required: number;
            external_issue_url: string;
          }
        | undefined;
      expect(issue).toMatchObject({
        title: "[ut-tdd detector candidate] detector_route_candidate:spec-ir-orphan-relation",
        status: "queued_dry_run",
        human_approval_required: 1,
        external_issue_url: "",
      });
      expect(issue?.body).toContain("Human approval is required before external issue creation");
      expect(issue?.body).toContain("routeFiling SSoT evaluation is recorded");
      expect(issue?.body).toContain("review_status=ssot_evaluated");

      const guardrail = db
        .prepare(
          "SELECT decision, human_signoff_required FROM guardrail_decisions WHERE guardrail = ?",
        )
        .get("external-github-issue-approval") as
        | { decision: string; human_signoff_required: number }
        | undefined;
      expect(guardrail).toMatchObject({
        decision: "requires-human-approval",
        human_signoff_required: 1,
      });
    } finally {
      db.close();
    }
  });

  it("does not project closed detector route candidates into feedback or issue queue", () => {
    const db = openHarnessDb(":memory:");
    const deps = {
      nowIso: () => "2026-07-08T00:00:00.000Z",
      stableId,
      recordProjectionEvent,
    };
    try {
      migrate(db);
      recordProjectionEvent(db, {
        table: "detector_route_candidates",
        id: "candidate:closed",
        row: {
          route_candidate_id: "candidate:closed",
          source_table: "findings",
          source_id: "finding:closed",
          detector_id: "spec-ir-integrity",
          finding_kind: "spec-ir-orphan-relation",
          severity: "warn",
          subject_kind: "spec_ir",
          subject_id: "spec-relation:closed",
          filing_target_id: "routeFiling:feature_addition",
          target_layer: "L6",
          target_sub_doc: "function-spec",
          candidate_status: "closed",
          reason: "already handled",
          evidence_path: "docs/plans/PLAN-L6-39-vmodel-spec-ir-function-contracts.md",
          computed_at: "2026-07-08T00:00:00.000Z",
        },
      });

      projectFeedbackEvents(db, deps);
      projectIssueQueue(db, deps);

      expect(
        db
          .prepare("SELECT COUNT(*) AS n FROM feedback_events WHERE source_table = ?")
          .get("detector_route_candidates"),
      ).toMatchObject({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM issue_queue").get()).toMatchObject({ n: 0 });
    } finally {
      db.close();
    }
  });

  it("does not turn feedback_events queue rows into unresolved join findings", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);

      recordProjectionEvent(db, {
        table: "feedback_events",
        id: "feedback:queue-row",
        row: {
          feedback_event_id: "feedback:queue-row",
          finding_id: "",
          plan_id: "PLAN-L7-46-missing",
          source_table: "quality_signals",
          source_id: "signal-1",
          source_color: "",
          signal_type: "skill_firing_rate",
          severity: "info",
          status: "open",
          next_action: "review quality signal signal-1",
          created_at: "2026-06-23T00:00:00.000Z",
        },
      });

      const finding = db
        .prepare("SELECT kind FROM findings WHERE subject_id = ?")
        .get("feedback_events:feedback:queue-row");
      expect(finding).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("U-DOMAIN-008: rebuildHarnessDb is atomic and preserves the prior projection after a mid-rebuild failure", () => {
    const real = openHarnessDb(":memory:");
    try {
      // Baseline: a successful rebuild populates test_cases (input independent of docs/plans).
      const baseline = rebuildHarnessDb({ repoRoot: process.cwd(), db: real });
      expect(baseline.ok).toBe(true);
      const before = rowCounts(real).test_cases;
      expect(before).toBeGreaterThan(0);

      // Inject a failure once the projection starts writing test_cases — this is
      // *after* truncateProjectionTables has emptied the tables. Without a transaction
      // boundary the rebuild would leave test_cases truncated (0 rows).
      let injected = false;
      const flaky: HarnessDb = {
        path: real.path,
        driver: real.driver,
        exec: (sql) => real.exec(sql),
        prepare: (sql) => {
          if (!injected && /INSERT INTO test_cases\b/i.test(sql)) {
            injected = true;
            throw new Error("injected mid-rebuild failure");
          }
          return real.prepare(sql);
        },
        userVersion: () => real.userVersion(),
        setUserVersion: (v) => real.setUserVersion(v),
        close: () => {},
      };
      expect(() => rebuildHarnessDb({ repoRoot: process.cwd(), db: flaky })).toThrow(
        /injected mid-rebuild failure/,
      );
      expect(injected).toBe(true);

      // The prior projection must survive: the truncate is rolled back, not committed.
      expect(rowCounts(real).test_cases).toBe(before);
    } finally {
      real.close();
    }
  });

  it("CANDIDATE-U-PLANRET-021: auto-populates relation, profile, document export, and test catalog projections on rebuild", () => {
    const db = openHarnessDb(":memory:");
    try {
      const result = rebuildHarnessDb({ repoRoot: process.cwd(), db });

      expect(result.ok).toBe(true);
      expect(rowCounts(db).graph_nodes).toBeGreaterThan(0);
      expect(rowCounts(db).dependency_edges).toBeGreaterThan(0);
      expect(rowCounts(db).graph_snapshots).toBeGreaterThan(0);
      expect(rowCounts(db).impact_rules).toBeGreaterThan(0);
      expect(rowCounts(db).verification_profiles).toBeGreaterThan(0);
      expect(rowCounts(db).mcp_server_profiles).toBeGreaterThan(0);
      expect(rowCounts(db).mcp_profile_triggers).toBeGreaterThan(0);
      expect(rowCounts(db).document_export_profiles).toBeGreaterThan(0);
      expect(rowCounts(db).document_export_triggers).toBeGreaterThan(0);
      expect(rowCounts(db).document_export_runs).toBeGreaterThan(0);
      expect(rowCounts(db).document_export_datasets).toBeGreaterThan(0);
      expect(rowCounts(db).test_cases).toBeGreaterThan(0);
      expect(rowCounts(db).test_artifact_edges).toBeGreaterThan(0);
      expect(rowCounts(db).artifact_progress).toBeGreaterThan(0);
      expect(rowCounts(db).spec_defs).toBeGreaterThan(0);
      expect(rowCounts(db).spec_relations).toBeGreaterThan(0);
      expect(rowCounts(db).document_catalog_entries).toBeGreaterThan(0);
      expect(rowCounts(db).document_scale_profile_entries).toBeGreaterThan(0);
      expect(rowCounts(db).document_scale_profile_reviews).toBeGreaterThan(0);
      expect(rowCounts(db).spec_rag_closure_entries).toBeGreaterThan(0);
      const inheritedOracle = db
        .prepare("SELECT COUNT(*) AS count FROM test_cases WHERE test_file = ? AND oracle_id = ?")
        .get("tests/handover.test.ts", "U-HOVER-001") as { count: number } | undefined;
      expect(inheritedOracle?.count ?? 0).toBeGreaterThan(0);
      const documentCatalog = db
        .prepare(
          "SELECT layer, sub_doc, default_status FROM document_catalog_entries WHERE doc_type_id = ?",
        )
        .get("DOC-L4-DATA") as
        | { layer: string; sub_doc: string; default_status: string }
        | undefined;
      expect(documentCatalog).toMatchObject({
        layer: "L4",
        sub_doc: "data",
        default_status: "required",
      });
      expect(findReference(db, "DOC-L4-DATA document catalog").at(0)).toMatchObject({
        subject_type: "document_catalog_entry",
      });
      const documentScaleProfile = db
        .prepare(
          "SELECT decision, catalog_layer, catalog_sub_doc FROM document_scale_profile_reviews WHERE profile_id = ? AND doc_type_id = ?",
        )
        .get("enterprise", "DOC-L4-REPORT") as
        | { decision: string; catalog_layer: string; catalog_sub_doc: string }
        | undefined;
      expect(documentScaleProfile).toMatchObject({
        decision: "adopt",
        catalog_layer: "L4",
        catalog_sub_doc: "report",
      });
      expect(findReference(db, "enterprise DOC-L4-REPORT adopt").at(0)).toMatchObject({
        subject_type: "document_scale_profile_review",
      });
      const typedSpec = db
        .prepare("SELECT spec_kind, section_anchor FROM spec_defs WHERE spec_id = ?")
        .get("VMS-004") as { spec_kind: string; section_anchor: string } | undefined;
      expect(typedSpec).toMatchObject({
        spec_kind: "typed-spec-authoring-source",
        section_anchor: "spec.defines:VMS-004",
      });
      expect(findReference(db, "VMS-004 typed-spec-authoring-source").at(0)).toMatchObject({
        subject_type: "typed_spec",
        subject_id: "VMS-004",
      });
      const specRag = db
        .prepare(
          "SELECT rag, closure_status, test_count, finding_count FROM spec_rag_closure_entries WHERE spec_id = ?",
        )
        .get("VMS-004") as
        | { rag: string; closure_status: string; test_count: number; finding_count: number }
        | undefined;
      expect(specRag).toMatchObject({
        rag: "green",
        closure_status: "closed",
        finding_count: 0,
      });
      expect(specRag?.test_count ?? 0).toBeGreaterThan(0);
      expect(findReference(db, "VMS-004 spec closure RAG").at(0)).toMatchObject({
        subject_type: "spec_rag_closure_entry",
        subject_id: "VMS-004",
      });
    } finally {
      db.close();
    }
  });

  it("projects artifact progress rows as yellow until linked tests have passing runs", () => {
    const db = openHarnessDb(":memory:");
    try {
      const result = rebuildHarnessDb({
        repoRoot: process.cwd(),
        db,
        relationGraph: {
          nodes: [
            { id: "source:src/covered.ts", kind: "source", path: "src/covered.ts" },
            { id: "source:src/new-file.ts", kind: "source", path: "src/new-file.ts" },
            { id: "test:tests/covered.test.ts", kind: "test", path: "tests/covered.test.ts" },
          ],
          edges: [
            {
              from: "source:src/covered.ts",
              to: "test:tests/covered.test.ts",
              kind: "covered-by",
            },
          ],
          verificationProfiles: [],
          findings: [],
        },
      });

      expect(result.ok).toBe(true);
      const covered = db
        .prepare(
          "SELECT color, state, linked_test_count, dependency_checked FROM artifact_progress WHERE artifact_path = ?",
        )
        .get("src/covered.ts") as
        | { color: string; state: string; linked_test_count: number; dependency_checked: number }
        | undefined;
      const newFile = db
        .prepare(
          "SELECT color, state, linked_test_count, dependency_checked FROM artifact_progress WHERE artifact_path = ?",
        )
        .get("src/new-file.ts") as
        | { color: string; state: string; linked_test_count: number; dependency_checked: number }
        | undefined;

      expect(covered).toMatchObject({
        color: "yellow",
        state: "implemented_unverified",
        linked_test_count: 1,
        dependency_checked: 1,
      });
      expect(newFile).toMatchObject({
        color: "yellow",
        state: "implemented_unverified",
        linked_test_count: 0,
        dependency_checked: 1,
      });
      const event = db
        .prepare(
          "SELECT color, state, dependency_check_run_id FROM artifact_progress_events WHERE artifact_path = ?",
        )
        .get("src/covered.ts");
      expect(event).toMatchObject({
        color: "yellow",
        state: "implemented_unverified",
      });
      expect(String(event?.dependency_check_run_id ?? "")).not.toHaveLength(0);
      const feedback = db
        .prepare(
          "SELECT source_table, source_id, source_color, signal_type FROM feedback_events WHERE source_table = ? AND source_id = ?",
        )
        .get("artifact_progress", "src/covered.ts");
      expect(feedback).toMatchObject({
        source_table: "artifact_progress",
        source_id: "src/covered.ts",
        source_color: "yellow",
        signal_type: "artifact_progress_yellow",
      });
    } finally {
      db.close();
    }
  });

  it("projects open working-tree impacts and pair-freeze evidence without PLAN input", () => {
    const repoRoot = join(tmpdir(), `ut-tdd-impact-closure-${randomUUID()}`);
    const designPath = "docs/design/contract.md";
    const testDesignPath = "docs/test-design/L7-contract.md";
    const designId = `design:${designPath}`;
    const testDesignId = `test-design:${testDesignPath}`;
    mkdirSync(join(repoRoot, "docs", "design"), { recursive: true });
    mkdirSync(join(repoRoot, "docs", "test-design"), { recursive: true });
    const gitOptions = { cwd: repoRoot, stdio: "ignore" } as const;
    execFileSync("git", ["init"], gitOptions);
    writeFileSync(join(repoRoot, designPath), "# Contract\n\n設計本文。\n", "utf8");
    writeFileSync(join(repoRoot, testDesignPath), "# Test design\n\n検証本文。\n", "utf8");
    execFileSync("git", ["add", "--", designPath, testDesignPath], gitOptions);
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Projection Fixture",
        "-c",
        "user.email=projection-fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "test: seed paired artifacts",
      ],
      gitOptions,
    );
    writeFileSync(join(repoRoot, designPath), "# Contract\n\n設計本文を変更した。\n", "utf8");
    const db = openHarnessDb(":memory:");
    try {
      const result = rebuildHarnessDb({
        repoRoot,
        db,
        relationGraph: {
          nodes: [
            { id: designId, kind: "design", path: designPath },
            { id: testDesignId, kind: "test-design", path: testDesignPath },
          ],
          edges: [{ from: designId, to: testDesignId, kind: "pairs" }],
          verificationProfiles: [],
          findings: [],
        },
      });
      expect(result.ok).toBe(true);
      const impacts = db
        .prepare(
          `SELECT root_node_id, required_action, status, evidence_path
           FROM impact_results
           WHERE change_set_id = ?
           ORDER BY required_action`,
        )
        .all("working-tree");
      expect(impacts).toEqual([
        {
          root_node_id: designId,
          required_action: "record-trace-freeze-evidence",
          status: "open",
          evidence_path: "git status --porcelain",
        },
        {
          root_node_id: testDesignId,
          required_action: "update-paired-artifact",
          status: "closed",
          evidence_path: "doctor:pair-freeze",
        },
        {
          root_node_id: designId,
          required_action: "update-plan-dod",
          status: "open",
          evidence_path: "git status --porcelain",
        },
      ]);
      const progress = db
        .prepare("SELECT open_dependency_impacts FROM artifact_progress WHERE artifact_path = ?")
        .get(designPath);
      expect(progress).toMatchObject({ open_dependency_impacts: 2 });
    } finally {
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("IMP-140: projects 15 screens and FR/BR→screen trace from doc source on rebuild", () => {
    if (!hasSourceScreenDocs()) return;

    const db = openHarnessDb(":memory:");
    try {
      const result = rebuildHarnessDb({ repoRoot: process.cwd(), db });
      expect(result.ok).toBe(true);

      // 15 screens (PM 6 + HM 8 + GD 1) projected from screen-list.md §1.
      const screenCount = (db.prepare("SELECT COUNT(*) AS n FROM screens").get() as { n: number })
        .n;
      expect(screenCount).toBe(15);

      // PM-06 設計書ビューア with its project-scoped URL. implemented=0: screen-list.md
      // declares implemented_screens="" (全 15 画面 not-implemented) until L10 High-Fi/UX →
      // 設計適合実装。premature flip は screen-impl-pair-freeze gate が fail-close で担保する。
      const pm06 = db
        .prepare("SELECT category, url, implemented FROM screens WHERE screen_id = ?")
        .get("PM-06") as { category: string; url: string; implemented: number } | undefined;
      expect(pm06?.category).toBe("PM");
      expect(pm06?.url).toBe("/project/:case/designs");
      expect(pm06?.implemented).toBe(0);

      // FR/BR→screen trace edges (screen-requirements §5.5) make 機能一覧→画面要求 DB-queryable.
      const traceCount = (
        db.prepare("SELECT COUNT(*) AS n FROM screen_trace").get() as { n: number }
      ).n;
      expect(traceCount).toBeGreaterThan(0);
      const hm01Frs = db
        .prepare(
          "SELECT requirement_id FROM screen_trace WHERE screen_id = ? AND requirement_kind = 'fr' ORDER BY requirement_id",
        )
        .all("HM-01") as { requirement_id: string }[];
      expect(hm01Frs.map((row) => row.requirement_id)).toContain("FR-L1-33");

      // No orphan trace: every screen_trace.screen_id resolves to a screens row.
      const orphan = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM screen_trace t LEFT JOIN screens s ON s.screen_id = t.screen_id WHERE s.screen_id IS NULL",
          )
          .get() as { n: number }
      ).n;
      expect(orphan).toBe(0);
    } finally {
      db.close();
    }
  });

  it("CANDIDATE-U-PLANRET-023: rebuildHarnessDb deterministically projects Phase3 outputs without source mutation", () => {
    const db = openHarnessDb(":memory:");
    try {
      const result = rebuildHarnessDb({
        repoRoot: process.cwd(),
        db,
        relationGraph: {
          nodes: [
            {
              id: "source:src/state-db/projection-writer.ts",
              kind: "source",
              path: "src/state-db/projection-writer.ts",
            },
          ],
          edges: [],
          verificationProfiles: [],
          findings: [],
        },
        documentExports: {
          document_export_runs: [
            {
              document_export_run_id: "export-1",
              source_snapshot_hash: "sha256:test",
              evidence_path: ".ut-tdd/evidence/export.json",
            },
          ],
          document_export_datasets: [
            {
              document_export_dataset_id: "dataset-1",
              document_export_run_id: "export-1",
              format: "markdown",
            },
          ],
          document_export_artifacts: [],
          findings: [],
          actionsTaken: [],
          ok: true,
        },
        verificationEvidence: {
          verification_profiles: [],
          verification_recommendations: [],
          mcp_server_runs: [],
          external_tool_findings: [],
          findings: [],
          ok: true,
        },
      });
      const second = rebuildHarnessDb({
        repoRoot: process.cwd(),
        db,
        relationGraph: result.inputs.relationGraph,
        documentExports: result.inputs.documentExports,
        verificationEvidence: result.inputs.verificationEvidence,
      });

      expect(result.ok).toBe(true);
      // hook/session evidence is allowed to move while the full Vitest suite runs in parallel.
      // The hook rows themselves are volatile, and unresolved hook joins are projected through
      // findings/feedback_events and their durable feedback_lifecycle projection, so exclude that
      // derived volatility from the fixed-point check. Product-owned projection tables remain exact.
      const {
        hook_events: _firstHookEvents,
        findings: _firstFindings,
        feedback_events: _firstFeedbackEvents,
        feedback_lifecycle: _firstFeedbackLifecycle,
        ...firstStableCounts
      } = result.rowCounts;
      const {
        hook_events: _secondHookEvents,
        findings: _secondFindings,
        feedback_events: _secondFeedbackEvents,
        feedback_lifecycle: _secondFeedbackLifecycle,
        ...secondStableCounts
      } = second.rowCounts;
      expect(secondStableCounts).toEqual(firstStableCounts);
      expect(rowCounts(db).graph_nodes).toBe(1);
      expect(rowCounts(db).document_export_runs).toBe(1);
      expect(rowCounts(db).descent_obligations).toBeGreaterThan(0);
      expect(rowCounts(db).hook_events).toBeGreaterThan(0);
      expect(rowCounts(db).automation_assets).toBeGreaterThan(0);
      expect(rowCounts(db).quality_signals).toBeGreaterThan(0);
      expect(rowCounts(db).feedback_events).toBeGreaterThan(0);
      expect(rowCounts(db).issue_queue).toBeGreaterThan(0);
      expect(rowCounts(db).trouble_events).toBeGreaterThanOrEqual(0);
      expect(rowCounts(db).improvement_log).toBeGreaterThan(0);

      const feedbackEvent = db
        .prepare("SELECT signal_type, next_action FROM feedback_events ORDER BY created_at LIMIT 1")
        .get();
      expect(String(feedbackEvent?.signal_type ?? "")).not.toHaveLength(0);
      expect(String(feedbackEvent?.next_action ?? "")).toContain("review");

      const issueQueue = db
        .prepare(
          "SELECT target, status, human_approval_required, external_issue_url FROM issue_queue ORDER BY created_at LIMIT 1",
        )
        .get();
      expect(issueQueue).toMatchObject({
        target: "github",
        status: "queued_dry_run",
        human_approval_required: 1,
        external_issue_url: "",
      });

      const approvalGuardrail = db
        .prepare(
          "SELECT guardrail, decision, human_signoff_required FROM guardrail_decisions WHERE guardrail = ? LIMIT 1",
        )
        .get("external-github-issue-approval");
      expect(approvalGuardrail).toMatchObject({
        guardrail: "external-github-issue-approval",
        decision: "requires-human-approval",
        human_signoff_required: 1,
      });

      const troubleCount = db.prepare("SELECT COUNT(*) AS value FROM trouble_events").get();
      expect(Number(troubleCount?.value ?? 0)).toBeGreaterThanOrEqual(0);

      const improvementLog = db
        .prepare(
          "SELECT category, status, next_action FROM improvement_log ORDER BY created_at LIMIT 1",
        )
        .get();
      expect(String(improvementLog?.next_action ?? "")).toContain("review");
      expect(improvementLog).toMatchObject({ status: "open" });
    } finally {
      db.close();
    }
  });
});

describe("rebuildHarnessDb: repo-scoped runtime token telemetry ingest (issue #82, PLAN-L7-454)", () => {
  function withSessionDirEnv<T>(claudeDir: string, codexDir: string, run: () => T): T {
    const prevClaude = process.env.UT_TDD_CLAUDE_SESSIONS_DIR;
    const prevCodex = process.env.UT_TDD_CODEX_SESSIONS_DIR;
    process.env.UT_TDD_CLAUDE_SESSIONS_DIR = claudeDir;
    process.env.UT_TDD_CODEX_SESSIONS_DIR = codexDir;
    try {
      return run();
    } finally {
      if (prevClaude === undefined) delete process.env.UT_TDD_CLAUDE_SESSIONS_DIR;
      else process.env.UT_TDD_CLAUDE_SESSIONS_DIR = prevClaude;
      if (prevCodex === undefined) delete process.env.UT_TDD_CODEX_SESSIONS_DIR;
      else process.env.UT_TDD_CODEX_SESSIONS_DIR = prevCodex;
    }
  }

  it("(a)(b)(c) ingests only repo-owned session usage into model_runs; foreign-repo usage is excluded", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-token-ingest-repo-"));
    const claudeRoot = mkdtempSync(join(tmpdir(), "ut-tdd-token-ingest-claude-"));
    const codexRoot = mkdtempSync(join(tmpdir(), "ut-tdd-token-ingest-codex-"));
    try {
      // repo に対応する Claude project-slug ディレクトリ + 別 repo (混入させてはいけない) のディレクトリ。
      const ownSlug = claudeProjectSlug(root);
      mkdirSync(join(claudeRoot, ownSlug), { recursive: true });
      mkdirSync(join(claudeRoot, `${ownSlug}-other-repo`), { recursive: true });
      writeFileSync(
        join(claudeRoot, ownSlug, "s1.jsonl"),
        JSON.stringify({
          type: "assistant",
          sessionId: "own-session",
          cwd: root,
          message: {
            model: "claude-opus-4-8",
            usage: { input_tokens: 111, output_tokens: 22 },
          },
        }),
        "utf8",
      );
      writeFileSync(
        join(claudeRoot, `${ownSlug}-other-repo`, "foreign.jsonl"),
        JSON.stringify({
          type: "assistant",
          sessionId: "foreign-session",
          message: {
            model: "claude-opus-4-8",
            usage: { input_tokens: 90909, output_tokens: 90909 },
          },
        }),
        "utf8",
      );

      // Codex: cwd 一致 (own) / cwd 不一致 (他 repo、混入させてはいけない)。
      writeFileSync(
        join(codexRoot, "own.jsonl"),
        [
          JSON.stringify({ type: "session_meta", payload: { model: "gpt-5.3-codex", cwd: root } }),
          JSON.stringify({
            type: "event_msg",
            payload: {
              type: "token_count",
              info: { total_token_usage: { input_tokens: 300, output_tokens: 44 } },
            },
          }),
        ].join("\n"),
        "utf8",
      );
      writeFileSync(
        join(codexRoot, "foreign.jsonl"),
        [
          JSON.stringify({
            type: "session_meta",
            payload: { model: "gpt-5.3-codex", cwd: `${root}-sibling-repo` },
          }),
          JSON.stringify({
            type: "event_msg",
            payload: {
              type: "token_count",
              info: { total_token_usage: { input_tokens: 80808, output_tokens: 80808 } },
            },
          }),
        ].join("\n"),
        "utf8",
      );

      const db = openHarnessDb(":memory:", { repoRoot: root });
      try {
        const result = withSessionDirEnv(claudeRoot, codexRoot, () =>
          rebuildHarnessDb({ repoRoot: root, db }),
        );

        // (c) rebuild 後の model_runs に実測 token 行 (input/output tokens 非 NULL) が存在する。
        const measuredRows = db
          .prepare(
            "SELECT runtime, model, input_tokens, output_tokens FROM model_runs WHERE input_tokens IS NOT NULL ORDER BY runtime",
          )
          .all() as Array<{
          runtime: string;
          model: string;
          input_tokens: number;
          output_tokens: number;
        }>;
        expect(measuredRows).toHaveLength(2);

        // (a) repo 帰属分のみ投入される。
        const claudeRow = measuredRows.find((r) => r.runtime === "claude");
        const codexRow = measuredRows.find((r) => r.runtime === "codex");
        expect(claudeRow).toMatchObject({ input_tokens: 111, output_tokens: 22 });
        expect(codexRow).toMatchObject({ input_tokens: 300, output_tokens: 44 });

        // (b) 他 repo の usage (90909 / 80808) は一切混入していない。
        expect(
          measuredRows.some((r) => r.input_tokens === 90909 || r.output_tokens === 90909),
        ).toBe(false);
        expect(
          measuredRows.some((r) => r.input_tokens === 80808 || r.output_tokens === 80808),
        ).toBe(false);

        // 可視化: rebuild 結果に repo スコープ ingest の走査統計が載る。
        expect(result.tokenIngest).toMatchObject({
          claudeProjectDirResolved: true,
          claudeFilesScanned: 1,
          codexFilesMatched: 1,
          codexFilesForeignRepo: 1,
        });
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(claudeRoot, { recursive: true, force: true });
      rmSync(codexRoot, { recursive: true, force: true });
    }
  });

  it("cold-start: no matching session logs => rebuild succeeds with 0 measured model_runs rows, no throw", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-token-ingest-cold-"));
    const claudeRoot = mkdtempSync(join(tmpdir(), "ut-tdd-token-ingest-cold-claude-"));
    const codexRoot = mkdtempSync(join(tmpdir(), "ut-tdd-token-ingest-cold-codex-"));
    try {
      const db = openHarnessDb(":memory:", { repoRoot: root });
      try {
        const result = withSessionDirEnv(claudeRoot, codexRoot, () =>
          rebuildHarnessDb({ repoRoot: root, db }),
        );
        expect(result.ok).toBe(true);
        const measured = db
          .prepare("SELECT COUNT(*) AS n FROM model_runs WHERE input_tokens IS NOT NULL")
          .get() as { n: number };
        expect(measured.n).toBe(0);
        expect(result.tokenIngest).toMatchObject({ claudeProjectDirResolved: false });
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(claudeRoot, { recursive: true, force: true });
      rmSync(codexRoot, { recursive: true, force: true });
    }
  });
});
