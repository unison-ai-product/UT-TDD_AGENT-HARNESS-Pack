import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveArtifactProgressDecision } from "../src/state-db/artifact-progress-decision";
import { projectRefactorCandidateSignals } from "../src/state-db/feedback-projections";
import { type HarnessDb, isSecretLike, openHarnessDb } from "../src/state-db/index";
import { migrate, rowCounts } from "../src/state-db/migration";
import {
  projectRuntimeGuardrailDecisionFromSessionEvent,
  projectRuntimeSkillInvocationFromSessionEvent,
  projectRuntimeTestRunFromSessionEvent,
  rebuildHarnessDb,
  recordProjectionEvent,
} from "../src/state-db/projection-writer";
import {
  REFACTOR_CANDIDATE_THRESHOLDS,
  REFACTOR_POLICY_TERMS,
} from "../src/state-db/refactor-candidate-policy";
import { analyzeRefactorCandidates } from "../src/state-db/refactor-candidates";
import { projectRuntimeTestRunFromSessionEvent as projectRuntimeTestRunFromSessionEventCore } from "../src/state-db/runtime-projections";
import { projectSkillMetrics as projectSkillMetricsCore } from "../src/state-db/skill-projections";

interface VerificationWorkflowRow {
  phase: string;
  ready_status: string;
  human_required: number;
}

interface VerificationGateRow {
  status: string;
  evidence_path: string;
}

interface DriveRunRow {
  plan_id: string;
  mode: string;
  status: string;
}

describe("SECRET_PATTERN word-boundary anchoring", () => {
  it("does not match 'sk' inside a word but matches a boundary-delimited token", () => {
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

  it("detects typed refactor candidates for split, extraction, dedupe, and externalization", () => {
    expect(REFACTOR_CANDIDATE_THRESHOLDS.splitModuleLines).toBe(700);
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
      threshold: 700,
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
      threshold: 700,
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
      threshold: 700,
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
            "SELECT source_table, signal_type, next_action FROM feedback_events WHERE signal_type = ?",
          )
          .get("refactor_candidate:split-module");
        expect(feedback).toMatchObject({
          source_table: "quality_signals",
          signal_type: "refactor_candidate:split-module",
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
        openDependencyImpacts: 0,
        recoveryPlanIds: ["PLAN-REVERSE-56"],
      }),
    ).toMatchObject({ state: "recovering", color: "yellow" });
  });

  it("records normalized projection events idempotently and keeps rows joinable by plan_id", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);

      recordProjectionEvent(db, {
        table: "plan_registry",
        id: "PLAN-L7-46-projection-writer",
        row: {
          plan_id: "PLAN-L7-46-projection-writer",
          kind: "impl",
          layer: "L7",
          drive: "db",
          status: "draft",
          updated_at: "2026-06-11T00:00:00.000Z",
        },
      });
      recordProjectionEvent(db, {
        table: "gate_runs",
        id: "gate-1",
        row: {
          gate_run_id: "gate-1",
          gate_id: "G-L7DB.B",
          plan_id: "PLAN-L7-46-projection-writer",
          status: "passed",
          checked_at: "2026-06-11T00:01:00.000Z",
          evidence_path: "docs/handover/projection.md",
        },
      });
      recordProjectionEvent(db, {
        table: "gate_runs",
        id: "gate-1",
        row: {
          gate_run_id: "gate-1",
          gate_id: "G-L7DB.B",
          plan_id: "PLAN-L7-46-projection-writer",
          status: "passed",
          checked_at: "2026-06-11T00:01:00.000Z",
          evidence_path: "docs/handover/projection.md",
        },
      });

      expect(rowCounts(db).plan_registry).toBe(1);
      expect(rowCounts(db).gate_runs).toBe(1);
      const joined = db
        .prepare(
          `SELECT g.gate_id, p.plan_id
           FROM gate_runs g
           JOIN plan_registry p ON p.plan_id = g.plan_id
           WHERE g.gate_run_id = ?`,
        )
        .get("gate-1");
      expect(joined).toMatchObject({
        gate_id: "G-L7DB.B",
        plan_id: "PLAN-L7-46-projection-writer",
      });
    } finally {
      db.close();
    }
  });

  it("projects runtime test_runs from session-log verification events with session provenance", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      recordProjectionEvent(db, {
        table: "plan_registry",
        id: "PLAN-L7-193-runtime-test-run-provenance",
        row: {
          plan_id: "PLAN-L7-193-runtime-test-run-provenance",
          kind: "impl",
          layer: "L7",
          drive: "db",
          status: "confirmed",
          title: "runtime test run provenance",
          source_path: "docs/plans/PLAN-L7-193-runtime-test-run-provenance.md",
          source_hash: "sha256:test",
          updated_at: "2026-06-29T00:00:00Z",
        },
      });
      const plans = new Map([
        [
          "PLAN-L7-193-runtime-test-run-provenance",
          {
            planId: "PLAN-L7-193-runtime-test-run-provenance",
            kind: "impl",
            layer: "L7",
            drive: "db",
            status: "confirmed",
            updatedAt: "2026-06-29T00:00:00Z",
          },
        ],
      ]);

      projectRuntimeTestRunFromSessionEvent({
        db,
        plans,
        event: {
          ts: "2026-06-29T00:01:00Z",
          session_id: "session-runtime-1",
          plan_id: "PLAN-L7-193-runtime-test-run-provenance",
          event_type: "tool_use",
          tool: "Bash",
          target: "Bash (vitest)",
          outcome: "ok",
        },
        evidencePath: ".ut-tdd/logs/session/session-runtime-1.jsonl",
      });
      projectRuntimeTestRunFromSessionEvent({
        db,
        plans,
        event: {
          ts: "2026-06-29T00:02:00Z",
          session_id: "session-runtime-1",
          plan_id: "PLAN-L7-193-runtime-test-run-provenance",
          event_type: "tool_use",
          tool: "Bash",
          target: "Bash (git)",
          outcome: "ok",
        },
        evidencePath: ".ut-tdd/logs/session/session-runtime-1.jsonl",
      });

      const rows = db
        .prepare(
          "SELECT session_id, command, runner, runtime, scope, exit_code, status, evidence_path FROM test_runs",
        )
        .all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        session_id: "session-runtime-1",
        command: "Bash (vitest)",
        runner: "bun",
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
      recordProjectionEvent(db, {
        table: "plan_registry",
        id: "PLAN-L7-230-runtime-projection-extraction",
        row: {
          plan_id: "PLAN-L7-230-runtime-projection-extraction",
          kind: "refactor",
          layer: "L7",
          drive: "db",
          status: "confirmed",
          title: "runtime projection extraction",
          source_path: "docs/plans/PLAN-L7-230-runtime-projection-extraction.md",
          source_hash: "sha256:test",
          updated_at: "2026-07-02T00:00:00Z",
        },
      });
      const plans = new Map([
        [
          "PLAN-L7-230-runtime-projection-extraction",
          {
            planId: "PLAN-L7-230-runtime-projection-extraction",
            kind: "refactor",
            layer: "L7",
            drive: "db",
            status: "confirmed",
            updatedAt: "2026-07-02T00:00:00Z",
          },
        ],
      ]);

      projectRuntimeTestRunFromSessionEventCore({
        db,
        plans,
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
        deps: {
          stableId: (prefix, value) => `${prefix}:${value}`,
          resolvePlanId: () => "PLAN-L7-230-runtime-projection-extraction",
          recordProjectionEvent,
        },
      });

      const row = db.prepare("SELECT plan_id, runner, exit_code, status FROM test_runs").get();
      expect(row).toMatchObject({
        plan_id: "PLAN-L7-230-runtime-projection-extraction",
        runner: "ut-tdd",
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
          source: "test",
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
        .all("skill-metrics");
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
      recordProjectionEvent(db, {
        table: "plan_registry",
        id: "PLAN-L7-200-runtime-guardrail-provenance",
        row: {
          plan_id: "PLAN-L7-200-runtime-guardrail-provenance",
          kind: "impl",
          layer: "L7",
          drive: "db",
          status: "confirmed",
          title: "runtime guardrail provenance",
          source_path: "docs/plans/PLAN-L7-200-runtime-guardrail-provenance.md",
          source_hash: "sha256:test",
          updated_at: "2026-06-29T00:00:00Z",
        },
      });
      const plans = new Map([
        [
          "PLAN-L7-200-runtime-guardrail-provenance",
          {
            planId: "PLAN-L7-200-runtime-guardrail-provenance",
            kind: "impl",
            layer: "L7",
            drive: "db",
            status: "confirmed",
            updatedAt: "2026-06-29T00:00:00Z",
          },
        ],
      ]);

      projectRuntimeGuardrailDecisionFromSessionEvent({
        db,
        plans,
        event: {
          ts: "2026-06-29T00:01:00Z",
          session_id: "session-guardrail-1",
          plan_id: "PLAN-L7-200-runtime-guardrail-provenance",
          event_type: "forced_stop",
          outcome: "error",
        },
        evidencePath: ".ut-tdd/logs/session/session-guardrail-1.jsonl",
      });
      projectRuntimeGuardrailDecisionFromSessionEvent({
        db,
        plans,
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
      });

      const rows = db
        .prepare(
          "SELECT session_id, guardrail, decision, mode, human_signoff_required, evidence_path, decided_at FROM guardrail_decisions",
        )
        .all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        session_id: "session-guardrail-1",
        guardrail: "forced-stop",
        decision: "block",
        mode: "runtime-hook",
        human_signoff_required: 0,
        evidence_path: ".ut-tdd/logs/session/session-guardrail-1.jsonl",
        decided_at: "2026-06-29T00:01:00Z",
      });
    } finally {
      db.close();
    }
  });

  it("projects runtime skill_invocations from skill suggest session events only", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      recordProjectionEvent(db, {
        table: "plan_registry",
        id: "PLAN-L7-201-runtime-skill-provenance",
        row: {
          plan_id: "PLAN-L7-201-runtime-skill-provenance",
          kind: "impl",
          layer: "L7",
          drive: "db",
          status: "confirmed",
          title: "runtime skill provenance",
          source_path: "docs/plans/PLAN-L7-201-runtime-skill-provenance.md",
          source_hash: "sha256:test",
          updated_at: "2026-06-29T00:00:00Z",
        },
      });
      recordProjectionEvent(db, {
        table: "automation_assets",
        id: "skill:review-checklist",
        row: {
          asset_id: "skill:review-checklist",
          asset_type: "skill",
          path: "docs/skills/review-checklist.yaml",
          trigger: "review checklist",
          role: "reviewer",
          capability: "quality review checklist",
          skill_type: "workflow",
          applies_layers: "L7",
          applies_drive_models: "Forward",
          drift_status: "ok",
          indexed_at: "2026-06-29T00:00:00Z",
        },
      });
      const plans = new Map([
        [
          "PLAN-L7-201-runtime-skill-provenance",
          {
            planId: "PLAN-L7-201-runtime-skill-provenance",
            kind: "impl",
            layer: "L7",
            drive: "db",
            status: "confirmed",
            updatedAt: "2026-06-29T00:00:00Z",
          },
        ],
      ]);

      projectRuntimeSkillInvocationFromSessionEvent({
        db,
        plans,
        event: {
          ts: "2026-06-29T00:01:00Z",
          session_id: "session-skill-1",
          plan_id: "PLAN-L7-201-runtime-skill-provenance",
          event_type: "tool_use",
          tool: "Bash",
          target: "Bash (skill)",
          outcome: "ok",
        },
        evidencePath: ".ut-tdd/logs/session/session-skill-1.jsonl",
      });
      projectRuntimeSkillInvocationFromSessionEvent({
        db,
        plans,
        event: {
          ts: "2026-06-29T00:02:00Z",
          session_id: "session-skill-1",
          plan_id: "PLAN-L7-201-runtime-skill-provenance",
          event_type: "tool_use",
          tool: "Bash",
          target: "Bash (bash)",
          outcome: "ok",
        },
        evidencePath: ".ut-tdd/logs/session/session-skill-1.jsonl",
      });

      const rows = db
        .prepare(
          "SELECT session_id, skill_id, layer, drive, source, accepted, fired_at FROM skill_invocations",
        )
        .all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        session_id: "session-skill-1",
        skill_id: "skill:review-checklist",
        layer: "L7",
        drive: "db",
        source: "runtime-hook:skill-suggest",
        accepted: 1,
        fired_at: "2026-06-29T00:01:00Z",
      });
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

  it("turns unresolved cross-drive/model joins into findings instead of silently skipping them", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);

      recordProjectionEvent(db, {
        table: "model_runs",
        id: "run-with-missing-plan",
        row: {
          run_id: "run-with-missing-plan",
          runtime: "codex",
          model: "gpt-5.4",
          role: "se",
          drive: "db",
          plan_id: "PLAN-L7-46-missing",
          started_at: "2026-06-11T00:02:00.000Z",
          completed_at: "2026-06-11T00:03:00.000Z",
          evidence_path: ".ut-tdd/evidence/run.json",
        },
      });

      const finding = db
        .prepare("SELECT kind, severity, subject_id, status FROM findings WHERE subject_id = ?")
        .get("model_runs:run-with-missing-plan");
      expect(finding).toMatchObject({
        kind: "unresolved-join",
        severity: "warn",
        status: "open",
      });
    } finally {
      db.close();
    }
  });

  it("does NOT flag work-context plan_id labels (audit-cycle id / compound) as unresolved joins (PLAN-L7-144)", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      // hook_events carries the active WORK CONTEXT, which can be a non-PLAN label:
      // an audit-cycle id, or a compound "PLAN-a+b+c" spanning several PLANs. Neither
      // is a single-PLAN foreign key, so neither is a dangling reference.
      for (const [id, planId] of [
        ["audit-ctx", "A-136-cycle-p4-verification-audit"],
        ["compound-ctx", "PLAN-L7-47+48+49-db-feedback-audit-close"],
      ] as const) {
        recordProjectionEvent(db, {
          table: "model_runs",
          id,
          row: {
            run_id: id,
            runtime: "codex",
            model: "gpt-5.4",
            role: "se",
            drive: "db",
            plan_id: planId,
            started_at: "2026-06-11T00:02:00.000Z",
            completed_at: "2026-06-11T00:03:00.000Z",
            evidence_path: ".ut-tdd/evidence/run.json",
          },
        });
      }
      const flagged = db
        .prepare(
          "SELECT COUNT(*) AS n FROM findings WHERE kind = 'unresolved-join' AND subject_id IN (?, ?)",
        )
        .get("model_runs:audit-ctx", "model_runs:compound-ctx") as { n: number };
      expect(flagged.n).toBe(0);
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

  it("rebuildHarnessDb is atomic: a mid-rebuild failure rolls back, leaving the prior projection intact", () => {
    const real = openHarnessDb(":memory:");
    try {
      // Baseline: a successful rebuild populates plan_registry.
      const baseline = rebuildHarnessDb({ repoRoot: process.cwd(), db: real });
      expect(baseline.ok).toBe(true);
      const before = rowCounts(real).plan_registry;
      expect(before).toBeGreaterThan(0);

      // Inject a failure once the projection starts writing plan_registry — this is
      // *after* truncateProjectionTables has emptied the tables. Without a transaction
      // boundary the rebuild would leave plan_registry truncated (0 rows).
      let injected = false;
      const flaky: HarnessDb = {
        path: real.path,
        driver: real.driver,
        exec: (sql) => real.exec(sql),
        prepare: (sql) => {
          if (!injected && /INSERT INTO plan_registry\b/i.test(sql)) {
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
      expect(rowCounts(real).plan_registry).toBe(before);
    } finally {
      real.close();
    }
  });

  it("auto-populates relation, profile, document export, and test catalog projections on rebuild", () => {
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
      const inheritedOracle = db
        .prepare("SELECT COUNT(*) AS count FROM test_cases WHERE test_file = ? AND oracle_id = ?")
        .get("tests/handover.test.ts", "U-HOVER-001") as { count: number } | undefined;
      expect(inheritedOracle?.count ?? 0).toBeGreaterThan(0);
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

  it("closes working-tree relation impacts when the owning PLAN has review and green evidence", () => {
    const repoRoot = join(tmpdir(), `ut-tdd-impact-closure-${randomUUID()}`);
    mkdirSync(join(repoRoot, "docs", "plans"), { recursive: true });
    mkdirSync(join(repoRoot, "docs", "design"), { recursive: true });
    execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
    writeFileSync(
      join(repoRoot, "docs", "design", "contract.md"),
      "# Contract\n\n設計本文。\n",
      "utf8",
    );
    writeFileSync(
      join(repoRoot, "docs", "plans", "PLAN-L7-999-impact-closure.md"),
      `---
plan_id: PLAN-L7-999-impact-closure
title: "PLAN-L7-999: Impact closure fixture"
kind: impl
layer: L7
drive: db
status: confirmed
created: 2026-06-30
updated: 2026-06-30
generates:
  - artifact_path: docs/design/contract.md
    artifact_type: design_doc
review_evidence:
  - reviewer: codex-fixture
    review_kind: intra_runtime_subagent
    reviewed_at: "2026-06-30T00:00:00Z"
    tests_green_at: "2026-06-30T00:00:00Z"
    verdict: approve
    green_commands:
      - kind: unit_test
        command: "bun run vitest run tests\\\\fixture.test.ts"
        runner: bun
        scope: targeted
        exit_code: 0
        completed_at: "2026-06-30T00:00:00Z"
        evidence_path: tests/fixture.test.ts
        output_digest: "sha256:fixture"
---

# PLAN-L7-999

Fixture.
`,
      "utf8",
    );
    const db = openHarnessDb(":memory:");
    try {
      const result = rebuildHarnessDb({
        repoRoot,
        db,
        relationGraph: {
          nodes: [
            {
              id: "design:docs/design/contract.md",
              kind: "design",
              path: "docs/design/contract.md",
            },
          ],
          edges: [],
          verificationProfiles: [],
          findings: [],
        },
      });
      expect(result.ok).toBe(true);
      const impacts = db
        .prepare(
          `SELECT required_action, status, evidence_path
           FROM impact_results
           WHERE root_node_id = ?
           ORDER BY required_action`,
        )
        .all("design:docs/design/contract.md") as Array<{
        required_action: string;
        status: string;
        evidence_path: string;
      }>;
      expect(impacts.map((row) => [row.required_action, row.status])).toEqual([
        ["record-trace-freeze-evidence", "closed"],
        ["update-plan-dod", "closed"],
      ]);
      expect(impacts.every((row) => row.evidence_path.includes("PLAN-L7-999"))).toBe(true);
      const progress = db
        .prepare(
          "SELECT color, open_dependency_impacts FROM artifact_progress WHERE artifact_path = ?",
        )
        .get("docs/design/contract.md") as
        | { color: string; open_dependency_impacts: number }
        | undefined;
      expect(progress).toMatchObject({ color: "yellow", open_dependency_impacts: 0 });
    } finally {
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("IMP-140: projects 15 screens and FR/BR→screen trace from doc source on rebuild", () => {
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

  it("rebuildHarnessDb deterministically projects plans and Phase3 outputs without source mutation", () => {
    const db = openHarnessDb(":memory:");
    try {
      const result = rebuildHarnessDb({
        repoRoot: process.cwd(),
        db,
        relationGraph: {
          nodes: [
            {
              id: "plan:PLAN-L7-46-projection-writer",
              kind: "plan",
              path: "docs/plans/PLAN-L7-46-projection-writer.md",
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
      // findings/feedback_events, so exclude that derived volatility from the fixed-point check.
      const {
        hook_events: _firstHookEvents,
        findings: _firstFindings,
        feedback_events: _firstFeedbackEvents,
        ...firstStableCounts
      } = result.rowCounts;
      const {
        hook_events: _secondHookEvents,
        findings: _secondFindings,
        feedback_events: _secondFeedbackEvents,
        ...secondStableCounts
      } = second.rowCounts;
      expect(secondStableCounts).toEqual(firstStableCounts);
      expect(rowCounts(db).plan_registry).toBeGreaterThan(0);
      const projectedPlan = db
        .prepare("SELECT source_hash FROM plan_registry WHERE source_hash <> '' LIMIT 1")
        .get() as { source_hash?: string } | undefined;
      expect(projectedPlan?.source_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(rowCounts(db).graph_nodes).toBe(1);
      expect(rowCounts(db).document_export_runs).toBe(1);
      expect(rowCounts(db).roadmap_rollups).toBe(1);
      expect(rowCounts(db).roadmap_band_coverage).toBeGreaterThan(0);
      expect(rowCounts(db).roadmap_gate_progress).toBeGreaterThan(0);
      expect(rowCounts(db).review_evidence_registry).toBeGreaterThan(0);
      expect(rowCounts(db).descent_obligations).toBeGreaterThan(0);
      expect(rowCounts(db).drive_runs).toBeGreaterThan(0);
      expect(rowCounts(db).hook_events).toBeGreaterThan(0);
      expect(rowCounts(db).model_runs).toBeGreaterThan(0);
      expect(rowCounts(db).automation_assets).toBeGreaterThan(0);
      expect(rowCounts(db).skill_recommendations).toBeGreaterThan(0);
      expect(rowCounts(db).skill_invocations).toBeGreaterThan(0);
      expect(rowCounts(db).quality_signals).toBeGreaterThan(0);
      expect(rowCounts(db).feedback_events).toBeGreaterThan(0);
      expect(rowCounts(db).issue_queue).toBeGreaterThan(0);
      expect(rowCounts(db).trouble_events).toBeGreaterThanOrEqual(0);
      expect(rowCounts(db).improvement_log).toBeGreaterThan(0);

      const program = db
        .prepare("SELECT * FROM roadmap_rollups WHERE rollup_id = ?")
        .get("program");
      expect(program).toMatchObject({
        total_bands: 5,
        covered_bands: 5,
        parked_bands: 0,
        uncovered_bands: 0,
        total_gates: 20,
        reached_gates: 20,
      });

      const verificationBand = db
        .prepare("SELECT status, roadmap_ids FROM roadmap_band_coverage WHERE band_id = ?")
        .get("verification");
      expect(verificationBand).toMatchObject({ status: "covered" });
      expect(String(verificationBand?.roadmap_ids)).toContain("PLAN-M-00-verify-cutover");

      const cutoverBand = db
        .prepare("SELECT status, roadmap_ids FROM roadmap_band_coverage WHERE band_id = ?")
        .get("cutover");
      expect(cutoverBand).toMatchObject({ status: "covered" });
      expect(String(cutoverBand?.roadmap_ids)).toContain("PLAN-M-01-cutover-backfill");

      const cutoverGate = db
        .prepare(
          "SELECT reached, confirmed_spans, total_spans FROM roadmap_gate_progress WHERE plan_id = ? AND gate_id = ?",
        )
        .get("PLAN-M-01-cutover-backfill", "G-CUTOVER.B");
      expect(cutoverGate).toMatchObject({
        reached: 1,
        confirmed_spans: 1,
        total_spans: 1,
      });

      const reviewEvidence = db
        .prepare(
          "SELECT has_evidence, review_kind, verdict FROM review_evidence_registry WHERE plan_id = ?",
        )
        .get("PLAN-M-01-cutover-backfill");
      expect(reviewEvidence).toMatchObject({
        has_evidence: 1,
        review_kind: "intra_runtime_subagent",
        verdict: "pass",
      });

      const verificationRuns = db
        .prepare(
          `SELECT phase, ready_status, human_required
           FROM workflow_runs
           WHERE plan_id = ? AND workflow = ?
           ORDER BY CASE phase
             WHEN 'L8' THEN 8
             WHEN 'L9' THEN 9
             WHEN 'L10' THEN 10
             WHEN 'L11' THEN 11
             WHEN 'L12' THEN 12
             WHEN 'L13' THEN 13
             WHEN 'L14' THEN 14
             ELSE 99
           END`,
        )
        .all(
          "PLAN-M-00-verify-cutover",
          "L8-L14-verification-band",
        ) as unknown as VerificationWorkflowRow[];
      expect(verificationRuns).toHaveLength(7);
      expect(verificationRuns.map((row) => row.phase)).toEqual([
        "L8",
        "L9",
        "L10",
        "L11",
        "L12",
        "L13",
        "L14",
      ]);
      expect(verificationRuns.every((row) => row.ready_status === "passed_local")).toBe(true);
      expect(
        verificationRuns
          .filter((row) => row.phase === "L12" || row.phase === "L13")
          .every((row) => row.human_required === 1),
      ).toBe(true);

      const verificationDriveJoin = db
        .prepare(
          `SELECT d.plan_id, d.mode, d.status
           FROM workflow_runs w
           JOIN drive_runs d ON d.drive_run_id = w.drive_run_id
           WHERE w.plan_id = ? AND w.phase = ?`,
        )
        .get("PLAN-M-00-verify-cutover", "L8") as DriveRunRow | undefined;
      expect(verificationDriveJoin).toMatchObject({
        plan_id: "PLAN-M-00-verify-cutover",
        mode: "Verification",
      });

      const hookJoin = db
        .prepare(
          `SELECT COUNT(*) AS value
           FROM hook_events h
           JOIN plan_registry p ON p.plan_id = h.plan_id`,
        )
        .get() as { value: number };
      expect(hookJoin.value).toBeGreaterThan(0);

      const modelJoin = db
        .prepare(
          `SELECT COUNT(*) AS value
           FROM model_runs m
           JOIN plan_registry p ON p.plan_id = m.plan_id`,
        )
        .get() as { value: number };
      expect(modelJoin.value).toBeGreaterThan(0);

      const verificationGates = db
        .prepare(
          "SELECT gate_id, status, evidence_path FROM gate_runs WHERE plan_id = ? AND gate_id LIKE ? ORDER BY gate_id",
        )
        .all("PLAN-M-00-verify-cutover", "G-VERIFY.L%") as unknown as VerificationGateRow[];
      expect(verificationGates).toHaveLength(7);
      expect(verificationGates.every((row) => row.status === "passed")).toBe(true);
      expect(
        verificationGates.every((row) =>
          String(row.evidence_path).includes("A-132-l8-l14-verification-band-execution.md"),
        ),
      ).toBe(true);

      const coverage = db
        .prepare(
          "SELECT value, threshold, status FROM coverage WHERE scope = ? AND subject_id = ? AND metric = ?",
        )
        .get("verification-band", "program", "covered_program_bands");
      expect(coverage).toMatchObject({
        value: 5,
        threshold: 5,
        status: "passed",
      });

      const skillRecommendation = db
        .prepare(
          "SELECT skill_id, reason FROM skill_recommendations WHERE plan_id = ? ORDER BY rank LIMIT 1",
        )
        .get("PLAN-M-01-cutover-backfill");
      expect(skillRecommendation).toMatchObject({ skill_id: "skill:review-checklist" });
      expect(String(skillRecommendation?.reason)).toContain("layer=");

      const skillInvocation = db
        .prepare(
          "SELECT skill_id, source, accepted FROM skill_invocations WHERE plan_id = ? AND skill_id = ?",
        )
        .get("PLAN-M-01-cutover-backfill", "skill:review-checklist");
      expect(skillInvocation).toMatchObject({
        skill_id: "skill:review-checklist",
        source: "auto-projection:review-evidence",
        accepted: 1,
      });

      const driveMetric = db
        .prepare("SELECT metric, status FROM quality_signals WHERE metric = ? LIMIT 1")
        .get("drive_firing_rate");
      expect(driveMetric).toMatchObject({ metric: "drive_firing_rate" });

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
