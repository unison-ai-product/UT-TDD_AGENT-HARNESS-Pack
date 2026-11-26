import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDoctorCheckDefinitionGroups } from "../src/doctor/check-definition-groups.ts";
import {
  buildFullDoctorCheckDefinitions,
  collectDoctorCheckRun,
  consumerSafeDoctorRunProfiles,
  DOCTOR_RUN_PROFILE_IDS,
  DOCTOR_RUN_PROFILES,
  doctorOutputIdsForScope,
  doctorRunProfilesForAudience,
  FULL_DOCTOR_OUTPUT_IDS,
  isConsumerSafeDoctorRunProfile,
  resolveDoctorRunProfile,
  selectDoctorCheckDefinitions,
} from "../src/doctor/check-registry.ts";
import {
  checkAgentContractDetection,
  checkAgentSlots,
  checkAssetDrift,
  checkBranchKind,
  checkChangeImpact,
  checkChangeSetIntegrity,
  checkCodexWrapperParity,
  checkCodingRules,
  checkCycleP4Verification,
  checkDbCurrency,
  checkDbProjectionCoverage,
  checkDbProjectionIngestion,
  checkDddTddRules,
  checkDependencyDrift,
  checkDescentObligation,
  checkDesignDocCrossIntegrity,
  checkDriveModelPassage,
  checkFrRoadmapCoverage,
  checkGateConfirm,
  checkGateIdFormat,
  checkHandover,
  checkHandoverDisciplineMessages,
  checkImplPlanTrace,
  checkL6Completion,
  checkL6FrCoverage,
  checkL7Completion,
  checkModuleDrift,
  checkOracleTestTrace,
  checkPairFreeze,
  checkPlaceholderDeps,
  checkProjectHooks,
  checkPropagation,
  checkReadability,
  checkRegressionExpansion,
  checkRoadmap,
  checkRuleAutomationClosure,
  checkRuleDrift,
  checkRuntimePortability,
  checkRuntimeReadability,
  checkSkillAssignment,
  checkTelemetryClosure,
  checkTraceGate,
  checkTrackedCanonical,
  checkTypedSpecLedgerBodySync,
  checkTypedSpecOwnedArtifactDispersal,
  checkTypedSpecPhaseLayerAlignment,
  checkTypedSpecTraceClosure,
  checkVerificationGroupsResult,
  checkVerificationProfile,
  type DoctorDeps,
  nodeDoctorDeps,
  runDoctor,
} from "../src/doctor/index.ts";
import { checkGateRunCoverage } from "../src/doctor/process-quality.ts";
import { buildDoctorResult } from "../src/doctor/result.ts";
import { analyzeGateRunCoverage, gateRunCoverageMessages } from "../src/lint/gate-run-coverage.ts";
import { CODEX_GIT_ROOT_PREFIX } from "../src/lint/hook-invocation.ts";
import type { AgentSlotsDeps, Slot } from "../src/runtime/agent-slots.ts";
import { BUILTIN_GITHUB_TEMPLATES } from "../src/setup/templates.ts";
import { stableId } from "../src/stable-id.ts";
import {
  analyzeDesignDetectionStats,
  DESIGN_QUALITY_CHECK_IDS,
  type DesignDetectionStats,
  designDetectionMessages,
} from "../src/state-db/design-detection.ts";
import { defaultHarnessDbPath, openHarnessDb } from "../src/state-db/index.ts";
import { consumeDoctorResultEnvelope } from "./support/doctor-envelope.ts";
import { removeTestTree } from "./support/temp-tree.ts";
import { headSnapshotRoot, noClaudeProbe } from "./support/workspace-roots.ts";

const NOW = "2026-06-04T00:00:00.000Z";
const pointerPath = join("/repo", ".ut-tdd", "handover", "CURRENT.json");
const slotStatePath = join("/repo", ".ut-tdd", "state", "agent-slots.json");
const currentPlanPath = join("/repo", ".ut-tdd", "state", "current-plan");
const digestDir = join("/repo", ".ut-tdd", "logs", "plan");

describe("buildDoctorResult", () => {
  it("preserves leading messages, prefixes check messages, and fails closed on any failed check", () => {
    const result = buildDoctorResult({
      leadingMessages: ["doctor: mode=standalone"],
      checks: [
        { ok: true, messages: ["alpha - OK"] },
        { ok: false, messages: ["beta - violation"] },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.messages).toEqual([
      "doctor: mode=standalone",
      "doctor: alpha - OK",
      "doctor: beta - violation",
    ]);
  });

  it("preserves optional timing diagnostics without changing ok/messages", () => {
    const result = buildDoctorResult({
      leadingMessages: ["doctor: mode=standalone"],
      checks: [{ ok: true, messages: ["alpha - OK"] }],
      timings: [{ id: "alpha", duration_ms: 1.25, ok: true, message_count: 1 }],
    });

    expect(result).toMatchObject({
      ok: true,
      messages: ["doctor: mode=standalone", "doctor: alpha - OK"],
      timings: [{ id: "alpha", duration_ms: 1.25, ok: true, message_count: 1 }],
    });
  });
});

describe("design-detection doctor aggregate", () => {
  const cleanStats = (): DesignDetectionStats => ({
    coverageRows: DESIGN_QUALITY_CHECK_IDS.map((subject_id) => ({
      subject_id,
      metric: "violation_count",
      value: 0,
      threshold: 0,
      status: "passed",
    })),
    missingCoverage: [],
    blockedCoverage: [],
    pairOrphanFindings: [],
  });

  it("fails on missing coverage rows without replaying file-driven lint details", () => {
    const stats = cleanStats();
    stats.coverageRows = stats.coverageRows.filter((row) => row.subject_id !== "module-drift");
    stats.missingCoverage = ["module-drift"];

    const result = analyzeDesignDetectionStats(stats);

    expect(result.ok).toBe(false);
    expect(designDetectionMessages(result).join("\n")).toContain("missing_coverage=1");
    expect(designDetectionMessages(result).join("\n")).not.toContain("module-drift —");
  });

  it("fails on blocked coverage and open pair orphan findings", () => {
    const stats = cleanStats();
    stats.blockedCoverage = [
      {
        subject_id: "l6-fr-coverage",
        metric: "violation_count",
        value: 2,
        threshold: 0,
        status: "blocked",
      },
    ];
    stats.pairOrphanFindings = [
      {
        finding_id: "finding:design-pair-orphan:pair-missing:doc",
        kind: "design-pair-orphan:pair-missing",
        severity: "error",
        subject_id: "docs/design/harness/L1-requirements/functional.md",
        source: "vmodel-pair-freeze",
        status: "open",
        evidence_path: "docs/design/harness/L1-requirements/functional.md",
      },
    ];

    const result = analyzeDesignDetectionStats(stats);
    const messages = designDetectionMessages(result).join("\n");

    expect(result.ok).toBe(false);
    expect(messages).toContain("blocked_coverage=1");
    expect(messages).toContain("pair_orphans=1");
    expect(messages).toContain("design-pair-orphan:pair-missing");
  });
});

const GATE_RUN_EVIDENCE_PATH = ".ut-tdd/gate_runs/gate-run.json";
const VERIFICATION_BAND_AUDIT_PATH = ".ut-tdd/audit/A-132-l8-l14-verification-band-execution.md";
const VERIFICATION_BAND_LAYERS = ["L8", "L9", "L10", "L11", "L12", "L13", "L14"] as const;
const GATE_RUN_CHECKED_AT = "2026-10-26T00:00:00.000Z";

function writeGateRunEvidence(
  repoRoot: string,
  input: {
    gateRunId?: string;
    gateId?: string;
    planId?: string | null;
    status?: string;
    evidenceFileName?: string;
  } = {},
): void {
  const evidenceFileName = input.evidenceFileName ?? GATE_RUN_EVIDENCE_PATH.split("/").at(-1);
  if (!evidenceFileName || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u.test(evidenceFileName)) {
    throw new Error("gate run evidence fixture must be a safe JSON file name");
  }
  mkdirSync(join(repoRoot, ".ut-tdd", "gate_runs"), { recursive: true });
  writeFileSync(
    join(repoRoot, ".ut-tdd", "gate_runs", evidenceFileName),
    `${JSON.stringify({
      schema_version: 1,
      gate_run_id: input.gateRunId ?? "gate-run:planless-1",
      gate_id: input.gateId ?? "G4",
      plan_id: input.planId ?? null,
      status: input.status ?? "passed",
      checked_at: GATE_RUN_CHECKED_AT,
      session_id: "session-gate-run-coverage",
      mode: "hybrid",
      tier: "cross_agent",
      review_kind: "cross_agent",
      static_applicable: true,
      source: "ut-tdd gate",
      messages: [],
    })}\n`,
    "utf8",
  );
}

function gateRunProjection(repoRoot: string): {
  gateRuns: Record<string, unknown>[];
  routineGateWorkflows: Record<string, unknown>[];
  verificationBandCoverageCount: number;
} {
  const db = openHarnessDb(defaultHarnessDbPath(repoRoot), { repoRoot });
  try {
    return {
      gateRuns: db
        .prepare(
          "SELECT gate_run_id, gate_id, plan_id, status, evidence_path FROM gate_runs ORDER BY gate_id, gate_run_id",
        )
        .all(),
      routineGateWorkflows: db
        .prepare(
          "SELECT workflow_run_id, plan_id, drive_run_id, workflow, phase, ready_status FROM workflow_runs WHERE workflow = 'routine-gate' ORDER BY phase, workflow_run_id",
        )
        .all(),
      verificationBandCoverageCount: Number(
        db.prepare("SELECT COUNT(*) AS value FROM coverage WHERE scope = 'verification-band'").get()
          ?.value ?? 0,
      ),
    };
  } finally {
    db.close();
  }
}

function gateRunTransactionPreimage(repoRoot: string): {
  gateRuns: Record<string, unknown>[];
  routineGateWorkflows: Record<string, unknown>[];
} {
  const db = openHarnessDb(defaultHarnessDbPath(repoRoot), { repoRoot });
  try {
    return {
      gateRuns: db.prepare("SELECT * FROM gate_runs ORDER BY gate_id, gate_run_id").all(),
      routineGateWorkflows: db
        .prepare(
          "SELECT * FROM workflow_runs WHERE workflow = 'routine-gate' ORDER BY phase, workflow_run_id",
        )
        .all(),
    };
  } finally {
    db.close();
  }
}

function observeIsolatedFixture<T>(
  prefix: string,
  observe: (repoRoot: string) => T,
): { ok: true; value: T } | { ok: false } {
  let repoRoot: string;
  try {
    repoRoot = mkdtempSync(join(tmpdir(), prefix));
  } catch {
    return { ok: false };
  }

  let value: T | undefined;
  let observed = false;
  try {
    value = observe(repoRoot);
    observed = true;
  } catch {
    // Fixture or subject-observation failures are not Red evidence.
  }

  let cleaned = false;
  try {
    removeTestTree(repoRoot);
    cleaned = true;
  } catch {
    // Cleanup failure is not Red evidence and is reported by ok=false below.
  }

  return observed && cleaned ? { ok: true, value: value as T } : { ok: false };
}

function writeVerificationBandAudit(repoRoot: string): void {
  mkdirSync(join(repoRoot, ".ut-tdd", "audit"), { recursive: true });
  writeFileSync(join(repoRoot, ...VERIFICATION_BAND_AUDIT_PATH.split("/")), "fixture\n", "utf8");
}

describe("gate-run-coverage doctor", () => {
  it("analyzer reports both reciprocal projection omissions", () => {
    const result = analyzeGateRunCoverage({
      gateRuns: 1,
      workflowRuns: 2,
      workflowPlansWithoutGateRun: 1,
      orphanGateRuns: 1,
      invalidEvidenceFindings: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.reason)).toEqual([
      "workflow_without_gate_run",
      "orphan_gate_run",
    ]);
    expect(gateRunCoverageMessages(result).join("\n")).toContain("gate-run-coverage - violation");
  });

  it("analyzer does not let another projected run mask a missing reciprocal row", () => {
    const result = analyzeGateRunCoverage({
      gateRuns: 8,
      workflowRuns: 2,
      workflowPlansWithoutGateRun: 1,
      orphanGateRuns: 1,
      invalidEvidenceFindings: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.reason)).toEqual([
      "workflow_without_gate_run",
      "orphan_gate_run",
    ]);
  });

  it("analyzer passes when projection summary reports a complete join", () => {
    const result = analyzeGateRunCoverage({
      gateRuns: 2,
      workflowRuns: 2,
      workflowPlansWithoutGateRun: 0,
      orphanGateRuns: 0,
      invalidEvidenceFindings: 0,
    });

    expect(result.ok).toBe(true);
    expect(gateRunCoverageMessages(result).join("\n")).toContain("gate-run-coverage - OK");
  });

  it("analyzer accepts one gate when the reciprocal projection is complete", () => {
    const result = analyzeGateRunCoverage({
      gateRuns: 1,
      workflowRuns: 1,
      workflowPlansWithoutGateRun: 0,
      orphanGateRuns: 0,
      invalidEvidenceFindings: 0,
    });

    expect(result.ok).toBe(true);
  });

  it("fails closed when neither current gate evidence nor the historical seed exists", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-gate-run-empty-"));
    try {
      const result = checkGateRunCoverage(root);

      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("missing_gate_runs");
    } finally {
      removeTestTree(root);
    }
  });

  it.each([
    ["malformed JSON", "{not json", undefined],
    ["empty gate_id", undefined, ""],
  ])("fails closed on %s evidence", (_case, rawJson, gateId) => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-gate-run-invalid-"));
    try {
      if (rawJson !== undefined) {
        mkdirSync(join(root, ".ut-tdd", "gate_runs"), { recursive: true });
        writeFileSync(join(root, ...GATE_RUN_EVIDENCE_PATH.split("/")), rawJson, "utf8");
      } else {
        writeGateRunEvidence(root, { gateId });
      }

      const result = checkGateRunCoverage(root);

      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("invalid_gate_run_evidence");
    } finally {
      removeTestTree(root);
    }
  });

  it("U-DOCTOR-GATE-01 accepts a planless run only with its matching workflow projection", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-gate-run-planless-"));
    const gateRunId = "gate-run:planless-1";
    try {
      writeGateRunEvidence(root, { gateRunId, gateId: "G4", planId: null });

      const result = checkGateRunCoverage(root);
      const projection = gateRunProjection(root);

      expect(result.ok).toBe(true);
      expect(projection.gateRuns).toEqual([
        {
          gate_run_id: gateRunId,
          gate_id: "G4",
          plan_id: null,
          status: "passed",
          evidence_path: GATE_RUN_EVIDENCE_PATH,
        },
      ]);
      expect(projection.routineGateWorkflows).toEqual([
        {
          workflow_run_id: stableId("gate-workflow", gateRunId),
          plan_id: null,
          drive_run_id: "",
          workflow: "routine-gate",
          phase: "G4",
          ready_status: "passed",
        },
      ]);
    } finally {
      removeTestTree(root);
    }
  });

  it("U-DOCTOR-GATE-01 accepts a valid gate/workflow pair with opaque plan metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-gate-run-unregistered-plan-"));
    const planId = "PLAN-NOT-REGISTERED-GATE-COVERAGE";
    try {
      writeGateRunEvidence(root, { gateRunId: "gate-run:unregistered-plan-1", planId });

      const result = checkGateRunCoverage(root);
      const projection = gateRunProjection(root);

      expect(result.ok).toBe(true);
      expect(projection.gateRuns).toHaveLength(1);
      expect(projection.routineGateWorkflows).toHaveLength(1);
    } finally {
      removeTestTree(root);
    }
  });

  it("U-DOCTOR-GATE-01 detects a same-plan workflow that has no gate-run counterpart", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-gate-run-workflow-extra-"));
    const planId = "PLAN-GATE-COVERAGE-RECIPROCAL";
    try {
      writeGateRunEvidence(root, { gateRunId: "gate-run:reciprocal-1", gateId: "G1", planId });
      expect(checkGateRunCoverage(root).ok).toBe(true);
      const before = gateRunProjection(root);
      expect(before.gateRuns).toHaveLength(1);
      expect(before.routineGateWorkflows).toHaveLength(1);

      const db = openHarnessDb(defaultHarnessDbPath(root), { repoRoot: root });
      try {
        db.prepare(
          "INSERT INTO workflow_runs (workflow_run_id, plan_id, drive_run_id, workflow, phase, ready_status, blocked_reason, human_required, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          stableId("gate-workflow", "gate-run:absent-1"),
          planId,
          "",
          "routine-gate",
          "G1",
          "passed",
          "",
          0,
          GATE_RUN_CHECKED_AT,
        );
      } finally {
        db.close();
      }

      expect(gateRunProjection(root).gateRuns).toEqual(before.gateRuns);
      expect(checkGateRunCoverage(root).ok).toBe(false);
    } finally {
      removeTestTree(root);
    }
  });

  it("U-DOCTOR-GATE-01 detects a gate run whose reciprocal workflow row is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-gate-run-workflow-missing-"));
    const planId = "PLAN-GATE-COVERAGE-MISSING-WORKFLOW";
    try {
      writeGateRunEvidence(root, { gateRunId: "gate-run:missing-workflow-1", planId });
      expect(checkGateRunCoverage(root).ok).toBe(true);
      const before = gateRunProjection(root);
      expect(before.gateRuns).toHaveLength(1);
      expect(before.routineGateWorkflows).toHaveLength(1);

      const db = openHarnessDb(defaultHarnessDbPath(root), { repoRoot: root });
      try {
        db.prepare("DELETE FROM workflow_runs WHERE workflow_run_id = ?").run(
          stableId("gate-workflow", "gate-run:missing-workflow-1"),
        );
      } finally {
        db.close();
      }

      expect(gateRunProjection(root).gateRuns).toEqual(before.gateRuns);
      expect(checkGateRunCoverage(root).ok).toBe(false);
    } finally {
      removeTestTree(root);
    }
  });

  it.each([
    ["phase drift", "UPDATE workflow_runs SET phase = ? WHERE workflow_run_id = ?", "G2"],
    [
      "derived id drift",
      "UPDATE workflow_runs SET workflow_run_id = ? WHERE workflow_run_id = ?",
      stableId("gate-workflow", "gate-run:unrelated-run"),
    ],
  ])("U-DOCTOR-GATE-01 detects workflow %s for a projected gate run", (_case, sql, value) => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-gate-run-workflow-drift-"));
    const planId = "PLAN-GATE-COVERAGE-WORKFLOW-DRIFT";
    const gateRunId = "gate-run:workflow-drift-1";
    try {
      writeGateRunEvidence(root, { gateRunId, planId });
      expect(checkGateRunCoverage(root).ok).toBe(true);
      const before = gateRunProjection(root);
      expect(before.gateRuns).toHaveLength(1);
      expect(before.routineGateWorkflows).toHaveLength(1);

      const db = openHarnessDb(defaultHarnessDbPath(root), { repoRoot: root });
      try {
        db.prepare(sql).run(value, stableId("gate-workflow", gateRunId));
      } finally {
        db.close();
      }

      expect(gateRunProjection(root).gateRuns).toEqual(before.gateRuns);
      expect(checkGateRunCoverage(root).ok).toBe(false);
    } finally {
      removeTestTree(root);
    }
  });

  it.each([
    {
      field: "gate_run_id",
      gateSql: "UPDATE gate_runs SET gate_run_id = ? WHERE gate_run_id = ?",
      gateValue: "gate-run:evidence-id-mismatch:projection",
      workflowSql: "UPDATE workflow_runs SET workflow_run_id = ? WHERE workflow_run_id = ?",
      workflowValue: stableId("gate-workflow", "gate-run:evidence-id-mismatch:projection"),
    },
    {
      field: "gate_id",
      gateSql: "UPDATE gate_runs SET gate_id = ? WHERE gate_run_id = ?",
      gateValue: "G2",
      workflowSql: "UPDATE workflow_runs SET phase = ? WHERE workflow_run_id = ?",
      workflowValue: "G2",
    },
    {
      field: "plan_id",
      gateSql: "UPDATE gate_runs SET plan_id = ? WHERE gate_run_id = ?",
      gateValue: "PLAN-GATE-COVERAGE-EVIDENCE-IDENTITY-OTHER",
      workflowSql: "UPDATE workflow_runs SET plan_id = ? WHERE workflow_run_id = ?",
      workflowValue: "PLAN-GATE-COVERAGE-EVIDENCE-IDENTITY-OTHER",
    },
    {
      field: "status",
      gateSql: "UPDATE gate_runs SET status = ? WHERE gate_run_id = ?",
      gateValue: "failed",
      workflowSql: undefined,
      workflowValue: undefined,
    },
    {
      field: "checked_at",
      gateSql: "UPDATE gate_runs SET checked_at = ? WHERE gate_run_id = ?",
      gateValue: "2026-10-27T00:00:00.000Z",
      workflowSql: undefined,
      workflowValue: undefined,
    },
    {
      field: "evidence_path",
      gateSql: "UPDATE gate_runs SET evidence_path = ? WHERE gate_run_id = ?",
      gateValue: ".ut-tdd/gate_runs/other.json",
      workflowSql: undefined,
      workflowValue: undefined,
    },
  ])("U-DOCTOR-GATE-02 rejects evidence $field mismatch", ({
    gateSql,
    gateValue,
    workflowSql,
    workflowValue,
  }) => {
    const fixture = observeIsolatedFixture(
      "ut-tdd-doctor-gate-run-evidence-identity-mismatch-",
      (root) => {
        const gateRunId = "gate-run:evidence-id-mismatch";
        const planId = "PLAN-GATE-COVERAGE-EVIDENCE-IDENTITY-MISMATCH";
        writeGateRunEvidence(root, { gateRunId, gateId: "G1", planId });
        const baseline = checkGateRunCoverage(root);
        if (!baseline.ok) return { ready: false as const };

        const before = gateRunProjection(root);
        if (before.gateRuns.length !== 1 || before.routineGateWorkflows.length !== 1) {
          return { ready: false as const };
        }

        const db = openHarnessDb(defaultHarnessDbPath(root), { repoRoot: root });
        try {
          db.prepare(gateSql).run(gateValue, gateRunId);
          if (workflowSql && workflowValue !== undefined) {
            db.prepare(workflowSql).run(workflowValue, stableId("gate-workflow", gateRunId));
          }
        } finally {
          db.close();
        }

        const projection = gateRunProjection(root);
        if (
          projection.gateRuns.length !== 1 ||
          projection.routineGateWorkflows.length !== 1 ||
          !projection.gateRuns[0] ||
          !projection.routineGateWorkflows[0]
        ) {
          return { ready: false as const };
        }
        const result = checkGateRunCoverage(root);
        return { ready: true as const, projection, result };
      },
    );
    expect(fixture.ok && fixture.value.ready).toBe(true);
    if (!fixture.ok || !fixture.value.ready) return;

    const [gateRun] = fixture.value.projection.gateRuns;
    const [workflow] = fixture.value.projection.routineGateWorkflows;
    expect(workflow.workflow_run_id).toBe(stableId("gate-workflow", gateRun.gate_run_id as string));
    expect(workflow.phase).toBe(gateRun.gate_id);
    expect(fixture.value.result.ok).toBe(false);
  });

  it("U-DOCTOR-GATE-02 accepts legacy plan_id values against normalized evidence", () => {
    const observeLegacyPair = (
      suffix: string,
      evidencePlanId: string | null,
      storedPlanId: string,
    ) =>
      observeIsolatedFixture(`ut-tdd-doctor-gate-run-legacy-plan-${suffix}-`, (root) => {
        const gateRunId = `gate-run:legacy-plan-${suffix}`;
        const workflowRunId = stableId("gate-workflow", gateRunId);
        writeGateRunEvidence(root, { gateRunId, planId: evidencePlanId });
        if (!checkGateRunCoverage(root).ok) return { ready: false as const };
        const db = openHarnessDb(defaultHarnessDbPath(root), { repoRoot: root });
        try {
          db.prepare("UPDATE gate_runs SET plan_id = ? WHERE gate_run_id = ?").run(
            storedPlanId,
            gateRunId,
          );
          db.prepare("UPDATE workflow_runs SET plan_id = ? WHERE workflow_run_id = ?").run(
            storedPlanId,
            workflowRunId,
          );
        } finally {
          db.close();
        }
        const result = checkGateRunCoverage(root);
        const projection = gateRunProjection(root);
        return { ready: true as const, result, projection, gateRunId, workflowRunId };
      });

    const legacyEmpty = observeLegacyPair("empty", null, "");
    expect(legacyEmpty.ok && legacyEmpty.value.ready).toBe(true);
    if (!legacyEmpty.ok || !legacyEmpty.value.ready) return;
    expect(legacyEmpty.value.result.ok).toBe(true);
    expect(legacyEmpty.value.projection.gateRuns).toEqual([
      expect.objectContaining({ gate_run_id: legacyEmpty.value.gateRunId, plan_id: "" }),
    ]);
    expect(legacyEmpty.value.projection.routineGateWorkflows).toEqual([
      expect.objectContaining({
        workflow_run_id: legacyEmpty.value.workflowRunId,
        plan_id: "",
      }),
    ]);

    const legacyPlanId = "PLAN-LEGACY-GATE-COVERAGE";
    const legacyPlan = observeLegacyPair("non-empty", legacyPlanId, legacyPlanId);
    expect(legacyPlan.ok && legacyPlan.value.ready).toBe(true);
    if (!legacyPlan.ok || !legacyPlan.value.ready) return;
    expect(legacyPlan.value.result.ok).toBe(true);
    expect(legacyPlan.value.projection.gateRuns).toEqual([
      expect.objectContaining({
        gate_run_id: legacyPlan.value.gateRunId,
        plan_id: legacyPlanId,
      }),
    ]);
    expect(legacyPlan.value.projection.routineGateWorkflows).toEqual([
      expect.objectContaining({
        workflow_run_id: legacyPlan.value.workflowRunId,
        plan_id: legacyPlanId,
      }),
    ]);
  });

  it("U-DOCTOR-GATE-04 rolls back additions and deletions when an existing row mismatches", () => {
    const mismatchedGateRunId = "gate-run:rollback-mismatched-existing";
    const removedEvidenceGateRunId = "gate-run:rollback-removed-evidence";
    const addedEvidenceGateRunId = "gate-run:rollback-added-evidence";
    const fixture = observeIsolatedFixture("ut-tdd-doctor-gate-run-stale-", (root) => {
      const planId = "PLAN-GATE-COVERAGE-STALE";
      writeGateRunEvidence(root, {
        gateRunId: mismatchedGateRunId,
        gateId: "G4",
        planId,
        evidenceFileName: "gate-run-existing.json",
      });
      writeGateRunEvidence(root, {
        gateRunId: removedEvidenceGateRunId,
        gateId: "G5",
        planId,
        evidenceFileName: "gate-run-to-remove.json",
      });
      const baseline = checkGateRunCoverage(root);
      if (!baseline.ok) return { ready: false as const };
      const baselineProjection = gateRunProjection(root);
      if (
        baselineProjection.gateRuns.length !== 2 ||
        baselineProjection.routineGateWorkflows.length !== 2
      ) {
        return { ready: false as const };
      }

      const db = openHarnessDb(defaultHarnessDbPath(root), { repoRoot: root });
      try {
        db.prepare("UPDATE gate_runs SET status = 'failed' WHERE gate_run_id = ?").run(
          mismatchedGateRunId,
        );
      } finally {
        db.close();
      }
      rmSync(join(root, ".ut-tdd", "gate_runs", "gate-run-to-remove.json"));

      writeGateRunEvidence(root, {
        gateRunId: addedEvidenceGateRunId,
        gateId: "G6",
        planId,
        evidenceFileName: "gate-run-to-add.json",
      });

      const beforeCheck = gateRunTransactionPreimage(root);
      const result = checkGateRunCoverage(root);
      const afterCheck = gateRunTransactionPreimage(root);
      return { ready: true as const, result, beforeCheck, afterCheck };
    });
    expect(fixture.ok && fixture.value.ready).toBe(true);
    if (!fixture.ok || !fixture.value.ready) return;

    expect(fixture.value.result.ok).toBe(false);
    expect(fixture.value.afterCheck).toEqual(fixture.value.beforeCheck);
    expect(fixture.value.beforeCheck.gateRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gate_run_id: mismatchedGateRunId,
          gate_id: "G4",
          status: "failed",
        }),
        expect.objectContaining({
          gate_run_id: removedEvidenceGateRunId,
          gate_id: "G5",
        }),
      ]),
    );
    expect(fixture.value.afterCheck.gateRuns).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ gate_run_id: addedEvidenceGateRunId })]),
    );
    expect(fixture.value.afterCheck.routineGateWorkflows).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workflow_run_id: stableId("gate-workflow", addedEvidenceGateRunId),
        }),
      ]),
    );
  });

  it("U-DOCTOR-GATE-03 removes the DB-only gate/workflow pair after evidence disappears", () => {
    const fixture = observeIsolatedFixture("ut-tdd-doctor-gate-run-missing-evidence-", (root) => {
      const planId = "PLAN-GATE-COVERAGE-MISSING-EVIDENCE";
      writeGateRunEvidence(root, { planId });
      const baseline = checkGateRunCoverage(root);
      if (!baseline.ok) return { ready: false as const };
      const before = gateRunProjection(root);
      if (before.gateRuns.length !== 1 || before.routineGateWorkflows.length !== 1) {
        return { ready: false as const };
      }
      rmSync(join(root, ...GATE_RUN_EVIDENCE_PATH.split("/")));

      const result = checkGateRunCoverage(root);
      const afterFirstCheck = gateRunProjection(root);
      const secondResult = checkGateRunCoverage(root);
      const afterSecondCheck = gateRunProjection(root);
      return { ready: true as const, result, afterFirstCheck, secondResult, afterSecondCheck };
    });
    expect(fixture.ok && fixture.value.ready).toBe(true);
    if (!fixture.ok || !fixture.value.ready) return;

    expect(fixture.value.result.ok).toBe(false);
    expect(fixture.value.result.messages.join("\n")).toContain("missing_gate_runs");
    expect(fixture.value.afterFirstCheck.gateRuns).toEqual([]);
    expect(fixture.value.afterFirstCheck.routineGateWorkflows).toEqual([]);
    expect(fixture.value.secondResult).toEqual(fixture.value.result);
    expect(fixture.value.afterSecondCheck).toEqual(fixture.value.afterFirstCheck);
  });

  it("U-DOCTOR-GATE-01 projects only the seven canonical A-132 rows as historical", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-gate-run-seed-"));
    try {
      writeVerificationBandAudit(root);

      const result = checkGateRunCoverage(root);
      const projection = gateRunProjection(root);

      expect(result.ok).toBe(true);
      expect(projection.gateRuns).toEqual(
        [...VERIFICATION_BAND_LAYERS].sort().map((layer) => ({
          gate_run_id: stableId("verification-band-gate", layer),
          gate_id: `G-VERIFY.${layer}`,
          plan_id: null,
          status: "historical",
          evidence_path: VERIFICATION_BAND_AUDIT_PATH,
        })),
      );
      expect(projection.routineGateWorkflows).toEqual([]);
      expect(projection.verificationBandCoverageCount).toBe(0);
    } finally {
      removeTestTree(root);
    }
  });

  it("U-DOCTOR-GATE-01 does not let canonical seeds mask an unmatched planless workflow", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-gate-run-seed-workflow-gap-"));
    try {
      writeVerificationBandAudit(root);
      checkGateRunCoverage(root);
      const db = openHarnessDb(defaultHarnessDbPath(root), { repoRoot: root });
      try {
        const insertSeed = db.prepare(
          "INSERT OR IGNORE INTO gate_runs (gate_run_id, gate_id, plan_id, status, checked_at, evidence_path) VALUES (?, ?, ?, ?, ?, ?)",
        );
        for (const layer of VERIFICATION_BAND_LAYERS) {
          insertSeed.run(
            stableId("verification-band-gate", layer),
            `G-VERIFY.${layer}`,
            "",
            "historical",
            GATE_RUN_CHECKED_AT,
            VERIFICATION_BAND_AUDIT_PATH,
          );
        }
        db.prepare(
          "INSERT INTO workflow_runs (workflow_run_id, plan_id, drive_run_id, workflow, phase, ready_status, blocked_reason, human_required, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          stableId("gate-workflow", "gate-run:absent-seed-1"),
          "",
          "",
          "routine-gate",
          "G-VERIFY.L8",
          "passed",
          "",
          0,
          GATE_RUN_CHECKED_AT,
        );
      } finally {
        db.close();
      }

      const result = checkGateRunCoverage(root);

      expect(result.messages.join("\n")).toContain("workflow_without_gate_run");
      expect(result.messages.join("\n")).not.toContain("blank_plan_gate_run");
    } finally {
      removeTestTree(root);
    }
  });

  it.each([
    {
      label: "gate outside L8-L14 with its matching derived id",
      sql: "UPDATE gate_runs SET gate_id = ?, gate_run_id = ? WHERE gate_run_id = ?",
      values: ["G-VERIFY.L15", stableId("verification-band-gate", "L15")],
    },
    {
      label: "non-derived run id",
      sql: "UPDATE gate_runs SET gate_run_id = ? WHERE gate_run_id = ?",
      values: ["verification-band-gate:not-derived"],
    },
    {
      label: "wrong fixed evidence path",
      sql: "UPDATE gate_runs SET evidence_path = ? WHERE gate_run_id = ?",
      values: [".ut-tdd/audit/other.md"],
    },
    {
      label: "non-historical status using a valid ordinary status",
      sql: "UPDATE gate_runs SET status = ? WHERE gate_run_id = ?",
      values: ["passed"],
    },
    {
      label: "non-empty plan id",
      sql: "UPDATE gate_runs SET plan_id = ? WHERE gate_run_id = ?",
      values: ["PLAN-FAKE"],
    },
  ])("U-DOCTOR-GATE-01 rejects a fake seed row: $label", ({ sql, values }) => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-gate-run-fake-seed-"));
    try {
      writeVerificationBandAudit(root);
      const result = checkGateRunCoverage(root);
      expect(result.ok).toBe(true);
      const [seed] = gateRunProjection(root).gateRuns;
      const db = openHarnessDb(defaultHarnessDbPath(root), { repoRoot: root });
      try {
        db.prepare(sql).run(...values, seed.gate_run_id);
      } finally {
        db.close();
      }

      expect(checkGateRunCoverage(root).ok).toBe(false);
    } finally {
      removeTestTree(root);
    }
  });

  it("U-DOCTOR-GATE-01 rejects duplicate canonical seed rows for one gate", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-gate-run-duplicate-seed-"));
    try {
      writeVerificationBandAudit(root);
      const result = checkGateRunCoverage(root);
      expect(result.ok).toBe(true);
      const db = openHarnessDb(defaultHarnessDbPath(root), { repoRoot: root });
      try {
        db.prepare(
          "INSERT INTO gate_runs (gate_run_id, gate_id, plan_id, status, checked_at, evidence_path) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(
          "verification-band-gate:duplicate-L8",
          "G-VERIFY.L8",
          "",
          "historical",
          GATE_RUN_CHECKED_AT,
          VERIFICATION_BAND_AUDIT_PATH,
        );
      } finally {
        db.close();
      }

      expect(checkGateRunCoverage(root).ok).toBe(false);
    } finally {
      removeTestTree(root);
    }
  });

  it("U-DOCTOR-GATE-01 requires the A-132 artifact to remain present for historical rows", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-gate-run-seed-missing-audit-"));
    try {
      writeVerificationBandAudit(root);
      expect(checkGateRunCoverage(root).ok).toBe(true);
      expect(gateRunProjection(root).gateRuns).toHaveLength(VERIFICATION_BAND_LAYERS.length);
      rmSync(join(root, ...VERIFICATION_BAND_AUDIT_PATH.split("/")));

      expect(checkGateRunCoverage(root).ok).toBe(false);
    } finally {
      removeTestTree(root);
    }
  });
});

function codexWrapperParityFiles(root: string, overrides: Record<string, string> = {}) {
  const file = (relativePath: string) => join(root, ...relativePath.split("/"));
  return new Map<string, string>(
    Object.entries({
      ".claude/settings.json": JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Agent|Task",
              hooks: [
                {
                  type: "command",
                  command: "node",
                  args: [`\${CLAUDE_PROJECT_DIR}/.claude/hooks/agent-guard.ts`],
                  onFailure: "block",
                },
              ],
            },
            {
              matcher: "Edit|Write|MultiEdit",
              hooks: [
                {
                  type: "command",
                  command: "node",
                  args: [`\${CLAUDE_PROJECT_DIR}/.claude/hooks/work-guard.ts`],
                  onFailure: "block",
                },
              ],
            },
          ],
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: "node",
                  args: [`\${CLAUDE_PROJECT_DIR}/src/cli.ts`, "session", "start"],
                },
              ],
            },
          ],
          PostToolUse: [
            {
              matcher: "Edit|Write|MultiEdit|Bash|PowerShell",
              hooks: [
                {
                  type: "command",
                  command: "node",
                  args: [`\${CLAUDE_PROJECT_DIR}/src/cli.ts`, "hook", "post-tool-use"],
                },
              ],
            },
          ],
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: "node",
                  args: [`\${CLAUDE_PROJECT_DIR}/src/cli.ts`, "session", "summary"],
                },
              ],
            },
            {
              hooks: [
                {
                  type: "command",
                  command: "node",
                  args: [`\${CLAUDE_PROJECT_DIR}/src/cli.ts`, "hook", "claude-memory-wake"],
                  asyncRewake: true,
                },
              ],
            },
          ],
          SubagentStop: [
            {
              hooks: [
                {
                  type: "command",
                  command: "node",
                  args: [`\${CLAUDE_PROJECT_DIR}/src/cli.ts`, "hook", "subagent-stop"],
                },
              ],
            },
          ],
        },
      }),
      "src/runtime/adapter.ts": [
        'const args = isCodex ? ["exec", "-"] : ["--print", "--input-format", "text"];',
        "return { stdin: intent.task, plan_id: intent.planId };",
      ].join("\n"),
      "src/runtime/adapter-policy.ts": 'export const CODEX_STDIN_ARGS = ["exec", "-"] as const;',
      "tests/runtime-hook-entrypoints.test.ts": [
        "ut-tdd codex --execute records the same session lifecycle through the adapter wrapper",
        "ut-tdd codex --task-file feeds file content through the same adapter wrapper",
        "ut-tdd codex records wrapper lifecycle without resolving a current PLAN",
      ].join("\n"),
      "tests/runtime-adapter.test.ts": "U-ADAPTER-007\nU-ADAPTER-008",
      "docs/test-design/harness/L7-unit-test-design.md": "U-ADAPTER-009",
      ...overrides,
    }).map(([relativePath, text]) => [file(relativePath), text]),
  );
}

function deps(over: Partial<DoctorDeps> & { files?: Map<string, string> } = {}): DoctorDeps {
  const files = over.files ?? new Map<string, string>();
  return {
    repoRoot: "/repo",
    now: NOW,
    readText: (p) => files.get(p) ?? null,
    probePathClaude: noClaudeProbe,
    listDir: (dir) =>
      [...files.keys()]
        .filter((k) => k.startsWith(`${dir}/`) || k.startsWith(`${dir}\\`))
        .map((k) => k.slice(dir.length + 1)),
    ...over,
  };
}

describe("checkHandover (doctor handover staleness surface)", () => {
  it("missing CURRENT.json prompts generation without failing", () => {
    expect(checkHandover(deps())).toContain("CURRENT.json");
  });

  it("fresh pointer returns OK and includes active plan", () => {
    const files = new Map([
      [
        pointerPath,
        JSON.stringify({
          active_plan: "PLAN-X",
          status: "in_progress",
          latest_doc: null,
          digest_summary: null,
          updated_at: "2026-06-03T18:00:00.000Z",
        }),
      ],
    ]);
    const msg = checkHandover(deps({ files }));
    expect(msg).toContain("OK");
    expect(msg).toContain("PLAN-X");
  });

  it("older than 24h returns stale warning", () => {
    const files = new Map([
      [pointerPath, JSON.stringify({ updated_at: "2026-06-01T00:00:00.000Z" })],
    ]);
    expect(checkHandover(deps({ files }))).toContain("stale");
  });

  it("broken JSON prompts regeneration without throwing", () => {
    const files = new Map([[pointerPath, "{not json"]]);
    expect(() => checkHandover(deps({ files }))).not.toThrow();
    expect(checkHandover(deps({ files }))).toContain("CURRENT.json");
  });
});

describe("checkHandoverDisciplineMessages", () => {
  it("fresh CURRENT does not surface PLAN family drift", () => {
    const files = new Map([
      [currentPlanPath, "PLAN-L5-08-harness-db-feedback\n2026-06-03T23:50:00.000Z"],
      [
        join(digestDir, "PLAN-L5-08-harness-db-feedback.digest.json"),
        JSON.stringify({
          plan_id: "PLAN-L5-08-harness-db-feedback",
          sessions: ["s1"],
          commits: [],
          files_touched: ["docs/plans/PLAN-L5-08-harness-db-feedback.md"],
          failures: [],
          updated_at: "2026-06-03T23:55:00.000Z",
        }),
      ],
      [
        pointerPath,
        JSON.stringify({
          active_plan: "PLAN-L5-00-master",
          status: "completed",
          latest_doc: null,
          digest_summary: { commits: 0, files: 0, failures: 0 },
          updated_at: "2026-06-03T23:59:00.000Z",
          generated_by: "ut-tdd-handover",
          doc_entry_count: 0,
        }),
      ],
    ]);
    const messages = checkHandoverDisciplineMessages(deps({ files }));
    expect(messages.some((m) => m.includes("drift"))).toBe(false);
  });

  it("runDoctor omits retired digest-activity warnings", () => {
    const fixtureParent = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-handover-"));
    const repoRoot = join(fixtureParent, "missing-root");
    try {
      const files = new Map([
        [
          join(repoRoot, ".ut-tdd", "state", "current-plan"),
          "PLAN-L5-08-harness-db-feedback\n2026-06-03T23:50:00.000Z",
        ],
        [
          join(repoRoot, ".ut-tdd", "logs", "plan", "PLAN-L5-08-harness-db-feedback.digest.json"),
          JSON.stringify({
            plan_id: "PLAN-L5-08-harness-db-feedback",
            sessions: ["s1"],
            commits: [],
            files_touched: ["docs/plans/PLAN-L5-08-harness-db-feedback.md"],
            failures: [],
            updated_at: "2026-06-03T23:55:00.000Z",
          }),
        ],
      ]);
      const r = runDoctor(deps({ repoRoot, files }));
      expect(r.ok).toBe(false);
      expect(r.messages.some((m) => m.includes("handover-discipline"))).toBe(false);
      expect(r.messages.some((m) => m.includes("verification group lint could not run"))).toBe(
        true,
      );
    } finally {
      removeTestTree(fixtureParent);
    }
  });
});

describe("checkAgentSlots (doctor agent-slots surface, IMP-050)", () => {
  function slotDeps(slots: Slot[] | null, now = "2026-06-04T00:10:00.000Z"): AgentSlotsDeps {
    const files = new Map<string, string>();
    if (slots !== null) files.set(slotStatePath, JSON.stringify(slots));
    return {
      repoRoot: "/repo",
      now: () => now,
      readText: (p) => files.get(p) ?? null,
      writeText: () => {
        throw new Error("doctor slotDeps writeText must stay read-only");
      },
      newId: () => "x",
    };
  }
  function slot(over: Partial<Slot>): Slot {
    return {
      slot_id: "s",
      agent_kind: "pmo-sonnet",
      role: null,
      slot_source: "agent_guard",
      fired_at: "2026-06-04T00:00:00.000Z",
      released_at: null,
      status: "running",
      exit_code: null,
      ...over,
    };
  }

  it("returns a no-record message when slot state is missing", () => {
    expect(checkAgentSlots(slotDeps(null))).toContain("agent-slots");
  });

  it("reports stale slots older than the release threshold", () => {
    const msg = checkAgentSlots(slotDeps([slot({ slot_id: "old" })])); // fired 00:00, now 00:10
    expect(msg).toContain("stale");
    expect(msg).toContain("old");
  });

  it("reports OK and peak for released slots without writing state", () => {
    const msg = checkAgentSlots(
      slotDeps([slot({ status: "completed", released_at: "2026-06-04T00:02:00.000Z" })]),
    );
    expect(msg).toContain("OK");
    expect(msg).toContain("peak_parallel");
  });
});

describe("runDoctor", () => {
  let cachedRealRepoDoctor: ReturnType<typeof runDoctor> | null = null;
  /**
   * PLAN-L7-461: real-repo fence の生産者。CI では同一 job の doctor step が書いた envelope を
   * 消費して doctor の二重実行を避ける。採用は **観測面 (HEAD / root / ref map / options /
   * check ID 集合) が完全一致したときだけ**で、ローカル実行を含むそれ以外は従来どおり自走する
   * (fence の assertion 対象は「real repo に対する doctor 実行の messages」のまま不変)。
   */
  const realRepoDoctor = () => {
    if (cachedRealRepoDoctor) return cachedRealRepoDoctor;
    cachedRealRepoDoctor =
      consumeDoctorResultEnvelope() ??
      runDoctor({ ...nodeDoctorDeps(headSnapshotRoot()), probePathClaude: noClaudeProbe });
    return cachedRealRepoDoctor;
  };

  it("U-TESTHYGIENE-028: accepts the resolved aggregate doctor baseline", () => {
    const r = realRepoDoctor();
    const blockers = r.messages.filter(
      (message) => message.includes(" - violation") || message.includes(" — violation"),
    );

    expect(r.ok, `non-OK doctor checks:\n${blockers.join("\n")}`).toBe(true);
    expect(blockers).toHaveLength(0);
  });

  it("ok=true includes handover and agent-slots surfaces as warnings", () => {
    const fixtureParent = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-missing-root-"));
    try {
      const r = runDoctor(deps({ repoRoot: join(fixtureParent, "missing-root") }));
      expect(r.ok).toBe(false);
      expect(r.messages.some((m) => m.includes("handover"))).toBe(true);
      expect(r.messages.some((m) => m.includes("agent-slots"))).toBe(true);
      expect(r.messages.some((m) => m.includes("verification group lint could not run"))).toBe(
        true,
      );
      // Keep surviving hard-fail lint surfaces visible alongside warning-only checks.
      expect(r.messages.some((m) => m.includes("propagation"))).toBe(true);
      expect(r.messages.some((m) => m.includes("coding-rules"))).toBe(true);
    } finally {
      removeTestTree(fixtureParent);
    }
  });

  it("U-SETUP-014: supports a fresh-consumer setup smoke without requiring dogfood PLAN/design docs", () => {
    const codexHook = (...args: string[]) => ({
      type: "command",
      command: `node "${CODEX_GIT_ROOT_PREFIX}.ut-tdd/bin/ut-tdd.mjs" ${args.join(" ")}`,
    });
    const codexHookJson = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            hooks: [codexHook("hook", "agent-guard")],
          },
          {
            hooks: [codexHook("hook", "work-guard")],
          },
        ],
        SessionStart: [{ hooks: [codexHook("session", "start")] }],
        PostToolUse: [
          {
            hooks: [codexHook("hook", "post-tool-use")],
          },
        ],
        Stop: [
          {
            hooks: [codexHook("session", "summary")],
          },
        ],
      },
    });
    const claudeHookJson = BUILTIN_GITHUB_TEMPLATES["adapter/.claude/settings.json"];
    const file = (path: string) => join("/repo", ...path.split("/"));
    const files = new Map<string, string>([
      [
        file(".ut-tdd/bin/ut-tdd.mjs"),
        "const localBin = '.ut-tdd/bin/ut-tdd.mjs';\nspawnSync(process.execPath, args);\n",
      ],
      [file("AGENTS.md"), "UT-TDD adapter"],
      [file("CLAUDE.md"), "UT-TDD adapter"],
      [file(".claude/CLAUDE.md"), "UT-TDD adapter"],
      [file(".claude/settings.json"), claudeHookJson],
      [file(".codex/config.toml"), "hooks = true"],
      [file(".codex/hooks.json"), codexHookJson],
    ]);

    const r = runDoctor(deps({ files }), { setupSmoke: true });

    expect(DOCTOR_RUN_PROFILE_IDS).toEqual([
      "source-full",
      "source-doc-lane",
      "source-toolchain",
      "consumer-toolchain",
      "consumer-setup-smoke",
    ]);
    expect(new Set(DOCTOR_RUN_PROFILE_IDS).size).toBe(DOCTOR_RUN_PROFILE_IDS.length);
    expect(Object.keys(DOCTOR_RUN_PROFILES).sort()).toEqual([...DOCTOR_RUN_PROFILE_IDS].sort());
    expect(doctorRunProfilesForAudience("consumer")).toEqual([
      DOCTOR_RUN_PROFILES["consumer-toolchain"],
      DOCTOR_RUN_PROFILES["consumer-setup-smoke"],
    ]);
    expect(doctorRunProfilesForAudience("consumer").every(isConsumerSafeDoctorRunProfile)).toBe(
      true,
    );
    expect(consumerSafeDoctorRunProfiles().map((profile) => profile.id)).toEqual([
      "source-toolchain",
      "consumer-toolchain",
      "consumer-setup-smoke",
    ]);
    expect(consumerSafeDoctorRunProfiles().every(isConsumerSafeDoctorRunProfile)).toBe(true);
    expect(consumerSafeDoctorRunProfiles().some((profile) => profile.sourceOnly)).toBe(false);
    expect(consumerSafeDoctorRunProfiles()).not.toContainEqual(
      expect.objectContaining({ sourceOnly: true }),
    );
    expect(
      consumerSafeDoctorRunProfiles().filter((profile) => profile.audience === "consumer"),
    ).toEqual([
      DOCTOR_RUN_PROFILES["consumer-toolchain"],
      DOCTOR_RUN_PROFILES["consumer-setup-smoke"],
    ]);
    expect(resolveDoctorRunProfile({ setupSmoke: true })).toEqual(
      DOCTOR_RUN_PROFILES["consumer-setup-smoke"],
    );
    expect(resolveDoctorRunProfile({ setupSmoke: true })).toMatchObject({
      id: "consumer-setup-smoke",
      audience: "consumer",
      invocation: "setup-smoke",
      setupSmoke: true,
      outputIds: [],
      sourceOnly: false,
    });
    expect(resolveDoctorRunProfile({ setupSmoke: true, scope: "toolchain" })).toMatchObject({
      id: "consumer-setup-smoke",
      invocation: "setup-smoke",
      setupSmoke: true,
      sourceOnly: false,
    });
    expect(resolveDoctorRunProfile({ profile: "consumer-setup-smoke" })).toEqual(
      DOCTOR_RUN_PROFILES["consumer-setup-smoke"],
    );
    expect(resolveDoctorRunProfile({ profile: "consumer-toolchain" })).toEqual(
      DOCTOR_RUN_PROFILES["consumer-toolchain"],
    );
    expect(r.messages).toEqual(["doctor: setup-smoke - OK (checked=23, failed=0)"]);
  });

  it("runs only the toolchain scope gates when doctor scope is toolchain", () => {
    const doctorDeps = { ...nodeDoctorDeps(headSnapshotRoot()), probePathClaude: noClaudeProbe };
    const definitions = buildFullDoctorCheckDefinitions(doctorDeps);
    const selected = selectDoctorCheckDefinitions(definitions, "toolchain");
    const run = collectDoctorCheckRun(doctorDeps, {
      scope: "toolchain",
      timing: true,
    });
    expect(run.checkIds).toEqual(selected.map((definition) => definition.id));

    expect(resolveDoctorRunProfile()).toEqual(DOCTOR_RUN_PROFILES["source-full"]);
    expect(doctorRunProfilesForAudience("source").map((profile) => profile.id)).toEqual([
      "source-full",
      "source-doc-lane",
      "source-toolchain",
    ]);
    expect(doctorRunProfilesForAudience("source").filter((profile) => profile.sourceOnly)).toEqual([
      DOCTOR_RUN_PROFILES["source-full"],
      DOCTOR_RUN_PROFILES["source-doc-lane"],
    ]);
    expect(isConsumerSafeDoctorRunProfile(DOCTOR_RUN_PROFILES["source-full"])).toBe(false);
    expect(isConsumerSafeDoctorRunProfile(DOCTOR_RUN_PROFILES["source-toolchain"])).toBe(true);
    expect(resolveDoctorRunProfile()).toMatchObject({
      id: "source-full",
      audience: "source",
      invocation: "registry",
      scope: "full",
      setupSmoke: false,
      outputIds: FULL_DOCTOR_OUTPUT_IDS,
      sourceOnly: true,
    });
    expect(resolveDoctorRunProfile({ scope: "toolchain" })).toEqual(
      DOCTOR_RUN_PROFILES["source-toolchain"],
    );
    expect(resolveDoctorRunProfile({ scope: "toolchain" })).toMatchObject({
      id: "source-toolchain",
      audience: "source",
      invocation: "registry",
      scope: "toolchain",
      setupSmoke: false,
      outputIds: ["toolchain-pin", "claude-version-floor"],
      sourceOnly: false,
    });
    expect(resolveDoctorRunProfile({ profile: "source-full", setupSmoke: true })).toEqual(
      DOCTOR_RUN_PROFILES["source-full"],
    );
    expect(resolveDoctorRunProfile({ profile: "source-toolchain" })).toEqual(
      DOCTOR_RUN_PROFILES["source-toolchain"],
    );
    expect(resolveDoctorRunProfile({ profile: "consumer-toolchain" })).toMatchObject({
      id: "consumer-toolchain",
      audience: "consumer",
      invocation: "registry",
      scope: "toolchain",
      setupSmoke: false,
      outputIds: ["toolchain-pin", "claude-version-floor"],
      sourceOnly: false,
    });
    expect(DOCTOR_RUN_PROFILES["source-full"].outputIds).toEqual(doctorOutputIdsForScope("full"));
    expect(DOCTOR_RUN_PROFILES["source-toolchain"].outputIds).toEqual(
      doctorOutputIdsForScope("toolchain"),
    );
    expect(DOCTOR_RUN_PROFILES["consumer-toolchain"].outputIds).toEqual(
      doctorOutputIdsForScope("toolchain"),
    );
    expect(doctorOutputIdsForScope("toolchain")).toEqual(["toolchain-pin", "claude-version-floor"]);
    expect(selected.map((definition) => definition.id)).toEqual([
      "toolchain-pin",
      "claude-version-floor",
    ]);
    expect(run.checks).toHaveLength(2);
    expect(run.checks[0]?.messages[0]).toContain("toolchain-pin");
    expect(run.timings).toEqual([
      expect.objectContaining({
        id: "toolchain-pin",
        ok: run.checks[0]?.ok,
        message_count: 1,
      }),
      expect.objectContaining({
        id: "claude-version-floor",
        ok: true,
        message_count: 1,
      }),
    ]);
  });

  it("U-CIPOL-027: runs exactly the checks declared by the source doc lane profile", () => {
    const profile = DOCTOR_RUN_PROFILES["source-doc-lane"];
    const profileOutputIds = new Set<string>(profile.outputIds);
    const definitions = buildFullDoctorCheckDefinitions(nodeDoctorDeps(headSnapshotRoot()));
    const selected = selectDoctorCheckDefinitions(definitions, profile.scope, profile.outputIds);
    const run = collectDoctorCheckRun(nodeDoctorDeps(headSnapshotRoot()), {
      profile: "source-doc-lane",
      timing: true,
    });

    expect(selected.map((definition) => definition.id)).toEqual([...profile.outputIds]);
    expect(run.checkIds).toEqual([...profile.outputIds]);
    expect(run.checks).toHaveLength(profile.outputIds.length);
    expect(run.timings.map((timing) => timing.id)).toEqual(
      definitions
        .filter(
          (definition) =>
            definition.profiles.includes(profile.scope) && profileOutputIds.has(definition.id),
        )
        .map((definition) => definition.id),
    );
  });

  it("includes asset-drift hard gate in doctor output", () => {
    const r = realRepoDoctor();
    // This test verifies gate wiring; unrelated active repo gates may legitimately be non-terminal.
    expect(r.messages.some((m) => m.includes("doctor: asset-drift") && m.includes("OK"))).toBe(
      true,
    );
  });

  it("includes skill-assignment hard gate in doctor output", () => {
    const r = realRepoDoctor();
    expect(r.messages.some((m) => m.includes("doctor: skill-assignment - OK"))).toBe(true);
  });

  // PLAN-L7-95: the 4 previously-inert lint audits + the lint-wiring meta-gate must be
  // invoked by runDoctor (invocation fence — guards against re-introducing the absence-blindness
  // where a lint module is reachable/tested but its audit never runs in a runtime path).
  it("invokes the 4 newly-wired lint audits + lint-wiring meta-gate in doctor output", () => {
    const r = realRepoDoctor();
    for (const gate of [
      "doctor: doc-consistency — OK",
      "doctor: entity-coverage — OK",
      "doctor: fr-registry-audit — OK",
      "doctor: improvement-backlog — OK",
      "doctor: lint-wiring — OK",
    ]) {
      expect(r.messages.some((m) => m.includes(gate))).toBe(true);
    }
  });

  it("includes branch-kind-check in doctor output", () => {
    const r = realRepoDoctor();
    expect(r.messages.some((m) => m.includes("doctor: branch-kind-check - OK"))).toBe(true);
  });

  it("includes GitHub CI policy hard gate in doctor output", () => {
    const r = realRepoDoctor();
    expect(r.messages.some((m) => m.includes("doctor: github-ci-policy - OK"))).toBe(true);
  });

  it("includes G1/G3 trace gates in doctor output", () => {
    const r = realRepoDoctor();
    expect(r.messages.some((m) => m.includes("doctor: g1-trace - OK"))).toBe(true);
    expect(r.messages.some((m) => m.includes("doctor: g3-trace - OK"))).toBe(true);
  });

  it("surfaces typed spec trace closure as a doctor hard gate", () => {
    const result = checkTypedSpecTraceClosure(headSnapshotRoot());
    const r = realRepoDoctor();

    expect(result.ok).toBe(true);
    expect(result.messages[0]).toContain("typed-spec-trace-closure - OK");
    expect(r.messages.some((m) => m.includes("doctor: typed-spec-trace-closure - OK"))).toBe(true);
  });

  it("surfaces design doc cross integrity as a doctor hard gate", () => {
    const result = checkDesignDocCrossIntegrity(headSnapshotRoot());
    const r = realRepoDoctor();

    expect(result.ok).toBe(true);
    expect(result.messages[0]).toContain("design-doc-cross-integrity - OK");
    expect(r.messages.some((m) => m.includes("doctor: design-doc-cross-integrity - OK"))).toBe(
      true,
    );
  });

  it("fails design doc cross integrity when a typed spec is defined by multiple docs", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-design-cross-"));
    try {
      mkdirSync(join(root, "docs", "governance"), { recursive: true });
      mkdirSync(join(root, "docs", "design", "harness", "L4-basic-design"), {
        recursive: true,
      });
      writeFileSync(
        join(root, "docs", "governance", "vmodel-document-catalog.md"),
        [
          "# V-model document catalog",
          "",
          "| doc_type_id | layer | sub_doc | category | requirement_class | applicability | default_status | source_doc_family | authoring_source_path | projection_table | profile_controlled | skip_reason_required |",
          "|---|---|---|---|---|---|---|---|---|---|---|---|",
          "| DOC-A | L4 | data | basic-design | core | in_scope | required | fixture | docs/design/harness/L4-basic-design/data.md | spec_defs | false | false |",
          "| DOC-B | L4 | function | basic-design | core | in_scope | required | fixture | docs/design/harness/L4-basic-design/function.md | spec_defs | false | false |",
        ].join("\n"),
        "utf8",
      );
      writeFileSync(
        join(root, "docs", "design", "harness", "L4-basic-design", "data.md"),
        [
          "# A",
          "",
          "```yaml",
          "spec:",
          "  defines:",
          "    - id: VMS-DUP",
          "      kind: contract",
          "```",
        ].join("\n"),
        "utf8",
      );
      writeFileSync(
        join(root, "docs", "design", "harness", "L4-basic-design", "function.md"),
        [
          "# B",
          "",
          "```yaml",
          "spec:",
          "  defines:",
          "    - id: VMS-DUP",
          "      kind: contract",
          "```",
        ].join("\n"),
        "utf8",
      );

      const result = checkDesignDocCrossIntegrity(root);

      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("design-doc-duplicate-definition");
    } finally {
      removeTestTree(root);
    }
  });

  it("fails typed spec trace closure when bidirectional trace or test backlink is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-typed-spec-closure-"));
    try {
      mkdirSync(join(root, "docs", "governance"), { recursive: true });
      writeFileSync(
        join(root, "docs", "governance", "vmodel-typed-spec-definitions.md"),
        [
          "# Typed spec bad closure",
          "",
          "```yaml",
          "spec:",
          "  defines:",
          "    - id: VMS-301",
          "      kind: typed-source",
          "      traces_to: [VMS-302]",
          "      tests: [TVMS-301]",
          "    - id: VMS-302",
          "      kind: typed-projection",
          "    - id: TVMS-301",
          "      kind: unit-oracle",
          "```",
        ].join("\n"),
        "utf8",
      );

      const result = checkTypedSpecTraceClosure(root);

      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("typed-spec-trace-reverse-missing");
      expect(result.messages.join("\n")).toContain("typed-spec-test-backlink-missing");
      expect(result.messages.join("\n")).toContain("typed-spec-test-missing");
    } finally {
      removeTestTree(root);
    }
  });

  it("surfaces typed spec ledger/body sync as a doctor hard gate", () => {
    const result = checkTypedSpecLedgerBodySync(headSnapshotRoot());
    const r = realRepoDoctor();

    expect(result.ok).toBe(true);
    expect(result.messages[0]).toContain("typed-spec-ledger-body-sync - OK");
    expect(r.messages.some((m) => m.includes("doctor: typed-spec-ledger-body-sync - OK"))).toBe(
      true,
    );
  });

  it("fails typed spec ledger/body sync when body, ledger, or phase direction is invalid", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-typed-spec-ledger-"));
    try {
      mkdirSync(join(root, "docs", "governance"), { recursive: true });
      writeFileSync(
        join(root, "docs", "governance", "vmodel-typed-spec-definitions.md"),
        [
          "# Typed spec bad ledger",
          "",
          "```yaml",
          "spec:",
          "  defines:",
          "    - id: VMS-401",
          "      kind: typed-source",
          "      traces_from: [VMS-402]",
          "      tests: [TVMS-401]",
          "    - id: VMS-402",
          "      kind: typed-projection",
          "      tests: [TVMS-402]",
          "    - id: TVMS-401",
          "      kind: unit-oracle",
          "      traces_from: [VMS-401]",
          "    - id: TVMS-402",
          "      kind: unit-oracle",
          "      traces_from: [VMS-402]",
          "```",
          "",
          "| spec_id | ledger_sources | v_phase |",
          "| --- | --- | --- |",
          "| VMS-401 | docs/plans/PLAN-L6-401.md | L6 |",
          "| VMS-402 | docs/plans/PLAN-L7-402.md | L7 |",
          "| TVMS-401 | docs/test-design/harness/L7-unit-test-design.md | L7 |",
          "| TVMS-999 | docs/test-design/harness/L7-unit-test-design.md | L7 |",
          "",
          "VMS-401 has body substance.",
          "VMS-402 has body substance.",
          "TVMS-401 has body substance.",
        ].join("\n"),
        "utf8",
      );

      const result = checkTypedSpecLedgerBodySync(root);

      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("typed-spec-ledger-row-missing");
      expect(result.messages.join("\n")).toContain("typed-spec-body-missing");
      expect(result.messages.join("\n")).toContain("typed-spec-ledger-unknown-id");
      expect(result.messages.join("\n")).toContain("typed-spec-phase-direction-invalid");
    } finally {
      removeTestTree(root);
    }
  });

  it("surfaces typed spec owned artifact dispersal as a doctor hard gate", () => {
    const result = checkTypedSpecOwnedArtifactDispersal(headSnapshotRoot());
    const r = realRepoDoctor();

    expect(result.ok).toBe(true);
    expect(result.messages[0]).toContain("typed-spec-owned-artifact-dispersal - OK");
    expect(
      r.messages.some((m) => m.includes("doctor: typed-spec-owned-artifact-dispersal - OK")),
    ).toBe(true);
  });

  it("fails typed spec owned artifact dispersal when declarations remain outside ledger sources", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-typed-spec-owned-"));
    try {
      mkdirSync(join(root, "docs", "governance"), { recursive: true });
      writeFileSync(
        join(root, "docs", "governance", "vmodel-typed-spec-definitions.md"),
        [
          "# Typed spec ownership bad fixture",
          "",
          "```yaml",
          "spec:",
          "  defines:",
          "    - id: VMS-601",
          "      kind: typed-source",
          "```",
          "",
          "| spec_id | ledger_sources | v_phase |",
          "| --- | --- | --- |",
          "| VMS-601 | docs/plans/PLAN-L6-601.md | L6 |",
          "",
          "VMS-601 has body substance.",
        ].join("\n"),
        "utf8",
      );

      const result = checkTypedSpecOwnedArtifactDispersal(root);

      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("typed-spec-owned-source-mismatch");
    } finally {
      removeTestTree(root);
    }
  });

  it("surfaces typed spec phase/layer alignment as a doctor hard gate", () => {
    const result = checkTypedSpecPhaseLayerAlignment(headSnapshotRoot());
    const r = realRepoDoctor();

    expect(result.ok).toBe(true);
    expect(result.messages[0]).toContain("typed-spec-phase-layer-alignment - OK");
    expect(
      r.messages.some((m) => m.includes("doctor: typed-spec-phase-layer-alignment - OK")),
    ).toBe(true);
  });

  it("fails typed spec phase/layer alignment when owner frontmatter does not match v_phase", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-typed-spec-phase-layer-"));
    try {
      mkdirSync(join(root, "docs", "governance"), { recursive: true });
      writeFileSync(
        join(root, "docs", "governance", "vmodel-typed-spec-definitions.md"),
        [
          "---",
          "title: Typed spec phase layer bad fixture",
          "status: confirmed",
          "typed_spec_phase_owner: L5",
          "---",
          "",
          "# Typed spec phase/layer bad fixture",
          "",
          "```yaml",
          "spec:",
          "  defines:",
          "    - id: VMS-701",
          "      kind: typed-source",
          "```",
          "",
          "| spec_id | ledger_sources | v_phase |",
          "| --- | --- | --- |",
          "| VMS-701 | docs/governance/vmodel-typed-spec-definitions.md | L6 |",
          "",
          "VMS-701 has body substance.",
        ].join("\n"),
        "utf8",
      );

      const result = checkTypedSpecPhaseLayerAlignment(root);

      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("typed-spec-phase-layer-mismatch");
    } finally {
      removeTestTree(root);
    }
  });

  it("surfaces V-model agent contract detection as a doctor hard gate", () => {
    const result = checkAgentContractDetection(headSnapshotRoot());
    const r = realRepoDoctor();

    expect(result.ok).toBe(true);
    expect(result.messages[0]).toContain("agent-contract-detection - OK");
    expect(r.messages.some((m) => m.includes("doctor: agent-contract-detection - OK"))).toBe(true);
  });

  it("fails V-model agent contract detection when done_when references an unknown doctor gate", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-agent-contract-"));
    try {
      const governanceDir = join(root, "docs", "governance");
      mkdirSync(governanceDir, { recursive: true });
      writeFileSync(join(governanceDir, "vmodel-upgrade-schedule.md"), "# Schedule\n", "utf8");
      writeFileSync(
        join(governanceDir, "vmodel-typed-spec-definitions.md"),
        "# Typed spec\n",
        "utf8",
      );
      writeFileSync(
        join(governanceDir, "vmodel-agent-contracts.md"),
        [
          "# Agent contracts",
          "",
          "```yaml",
          "agent_contracts:",
          "  - contract_id: VAGENT-301",
          "    target_path: docs/governance/vmodel-typed-spec-definitions.md",
          "    defines: [VMS-301]",
          "    read_first:",
          "      - docs/governance/vmodel-upgrade-schedule.md",
          "    done_when:",
          "      - doctor:no-such-gate",
          "```",
        ].join("\n"),
        "utf8",
      );

      const result = checkAgentContractDetection(root);

      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("agent-contract-doctor-gate-unknown");
      expect(result.messages.join("\n")).toContain("VAGENT-301:no-such-gate");
    } finally {
      removeTestTree(root);
    }
  });

  it("keeps doctor lint gate re-exports stable after extraction", () => {
    expect(checkModuleDrift).toBeTypeOf("function");
    expect(checkAssetDrift).toBeTypeOf("function");
    expect(checkSkillAssignment).toBeTypeOf("function");
    expect(checkDescentObligation).toBeTypeOf("function");
    expect(checkChangeImpact).toBeTypeOf("function");
    expect(checkChangeSetIntegrity).toBeTypeOf("function");
    expect(checkVerificationProfile).toBeTypeOf("function");
    expect(checkBranchKind).toBeTypeOf("function");
  });

  it("keeps doctor runtime-state re-exports stable after extraction", () => {
    expect(checkHandover).toBeTypeOf("function");
    expect(checkHandoverDisciplineMessages).toBeTypeOf("function");
    expect(checkAgentSlots).toBeTypeOf("function");
    expect(nodeDoctorDeps).toBeTypeOf("function");
  });

  it("surfaces dependency-drift and regression expansion instead of scaffold stub", () => {
    const r = realRepoDoctor();
    expect(r.messages.some((m) => m.includes("doctor: dependency-drift"))).toBe(true);
    expect(r.messages.some((m) => m.includes("doctor: regression-expansion"))).toBe(true);
    expect(r.messages.some((m) => m.includes("scaffold stub"))).toBe(false);
  });

  it("surfaces Cycle P4 closure audit as a hard gate", () => {
    const r = realRepoDoctor();

    expect(r.messages.some((m) => m.includes("doctor: cycle-p4-verification - OK"))).toBe(true);
  });

  it("fails descent-obligation when a trace chain has no required downstream landing", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-descent-"));
    try {
      const docDir = join(root, "docs", "design", "harness", "L6-function-design");
      mkdirSync(docDir, { recursive: true });
      writeFileSync(
        join(docDir, "bad.md"),
        "---\nlayer: L6\nstatus: confirmed\n---\nFR-L1-99\n",
        "utf8",
      );

      const result = checkDescentObligation(root);

      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("descent-obligation - unmet");
      expect(result.messages.join("\n")).toContain("FR-L1-99");
    } finally {
      removeTestTree(root);
    }
  });

  it("fails active design/test-design docs with unresolved L7 placeholder_deps", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-placeholder-deps-"));
    try {
      const docDir = join(root, "docs", "design", "harness", "L5-detailed-design");
      mkdirSync(docDir, { recursive: true });
      writeFileSync(
        join(docDir, "physical-data.md"),
        [
          "---",
          "layer: L5",
          "status: confirmed",
          "---",
          "",
          "- placeholder_deps: {waiting_layer:L7, waiting_spec: stale implementation bridge}",
          "- Current status: dedicated `placeholder_deps` doctor rule is not implemented yet.",
        ].join("\n"),
        "utf8",
      );

      const result = checkPlaceholderDeps(root);

      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("placeholder-deps - violation");
      expect(result.messages.join("\n")).toContain("physical-data.md:6");
    } finally {
      removeTestTree(root);
    }
  });

  it("fails active L4-L6 design docs with stale L7 completion blockers", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-l7-completion-"));
    try {
      const docDir = join(root, "docs", "design", "harness", "L4-basic-design");
      mkdirSync(docDir, { recursive: true });
      writeFileSync(
        join(docDir, "function.md"),
        [
          "---",
          "layer: L4",
          "status: confirmed",
          "---",
          "",
          "> Current implementation only covers C2; remaining items are L7 carry.",
          "| `ut-tdd review --uncommitted` | FR-45 | pending | doc-reviewer |",
        ].join("\n"),
        "utf8",
      );

      const result = checkL7Completion(root);

      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("l7-completion - violation");
      expect(result.messages.join("\n")).toContain("function.md:6");
    } finally {
      removeTestTree(root);
    }
  });

  it("U-ADAPTER-009: surfaces Claude hook / Codex wrapper parity as a doctor hard gate", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-codex-parity-"));
    try {
      const result = checkCodexWrapperParity(
        deps({ repoRoot: root, files: codexWrapperParityFiles(root) }),
      );

      expect(result.ok).toBe(true);
      expect(result.messages.join("\n")).toContain("codex-wrapper-parity - OK");
      expect(result.messages.join("\n")).toContain("codex=ut-tdd-wrapper-lifecycle");
    } finally {
      removeTestTree(root);
    }
  });

  it("U-ADAPTER-009: fails closed when Codex wrapper lifecycle evidence is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-codex-parity-missing-"));
    try {
      const result = checkCodexWrapperParity(
        deps({
          repoRoot: root,
          files: codexWrapperParityFiles(root, {
            "tests/runtime-hook-entrypoints.test.ts": "Claude settings only",
          }),
        }),
      );

      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("Codex wrapper lifecycle test missing");
    } finally {
      removeTestTree(root);
    }
  });

  it("fails closed when hard-gate checker inputs cannot be read", () => {
    const missingRoot = join(tmpdir(), `ut-tdd-doctor-missing-${Date.now()}-nope`);
    const checks = [
      ["propagation", checkPropagation(missingRoot)],
      ["pair-freeze", checkPairFreeze(missingRoot)],
      ["module-drift", checkModuleDrift(missingRoot)],
      ["asset-drift", checkAssetDrift(missingRoot)],
      ["skill-assignment", checkSkillAssignment(missingRoot)],
      ["descent-obligation", checkDescentObligation(missingRoot)],
      ["change-impact", checkChangeImpact(missingRoot)],
      ["change-set-integrity", checkChangeSetIntegrity(missingRoot)],
      ["verification-profile", checkVerificationProfile(missingRoot)],
      ["branch-kind", checkBranchKind(missingRoot)],
      ["coding-rules", checkCodingRules(missingRoot)],
      ["ddd-tdd-rules", checkDddTddRules(missingRoot)],
      ["runtime-portability", checkRuntimePortability(missingRoot)],
      ["db-projection-coverage", checkDbProjectionCoverage(missingRoot)],
      ["db-projection-ingestion", checkDbProjectionIngestion(missingRoot)],
      ["typed-spec-trace-closure", checkTypedSpecTraceClosure(missingRoot)],
      ["typed-spec-ledger-body-sync", checkTypedSpecLedgerBodySync(missingRoot)],
      ["typed-spec-owned-artifact-dispersal", checkTypedSpecOwnedArtifactDispersal(missingRoot)],
      ["typed-spec-phase-layer-alignment", checkTypedSpecPhaseLayerAlignment(missingRoot)],
      ["agent-contract-detection", checkAgentContractDetection(missingRoot)],
      ["rule-drift", checkRuleDrift(missingRoot)],
      ["gate-confirm", checkGateConfirm(missingRoot)],
      ["gate-id-format", checkGateIdFormat(missingRoot)],
      ["placeholder-deps", checkPlaceholderDeps(missingRoot)],
      ["g1-trace", checkTraceGate(missingRoot, "G1-trace")],
      ["g3-trace", checkTraceGate(missingRoot, "G3-trace")],
      ["rule-automation-closure", checkRuleAutomationClosure(missingRoot)],
      ["drive-model-passage", checkDriveModelPassage(missingRoot)],
      ["db-currency", checkDbCurrency(missingRoot)],
      ["fr-roadmap-coverage", checkFrRoadmapCoverage(missingRoot)],
      ["telemetry-closure", checkTelemetryClosure(missingRoot)],
      ["cycle-p4-verification", checkCycleP4Verification(missingRoot)],
      ["l6-fr-coverage", checkL6FrCoverage(missingRoot)],
      ["readability", checkReadability(missingRoot)],
      ["runtime-readability", checkRuntimeReadability(missingRoot)],
      ["project-hook", checkProjectHooks(missingRoot)],
      ["codex-wrapper-parity", checkCodexWrapperParity(deps({ repoRoot: missingRoot }))],
      ["l6-completion", checkL6Completion(missingRoot)],
      ["l7-completion", checkL7Completion(missingRoot)],
      ["verification-groups", checkVerificationGroupsResult(missingRoot)],
      ["roadmap", checkRoadmap(missingRoot)],
      ["impl-plan-trace", checkImplPlanTrace(missingRoot)],
      ["oracle-test-trace", checkOracleTestTrace(missingRoot)],
      ["tracked-canonical", checkTrackedCanonical(missingRoot)],
      ["dependency-drift", checkDependencyDrift(missingRoot)],
      ["regression-expansion", checkRegressionExpansion(missingRoot, null)],
    ] as const;

    expect(checks.filter(([, result]) => result.ok).map(([name]) => name)).toEqual([]);
    for (const [, result] of checks) {
      expect(result.messages.join("\n")).toMatch(/violation/i);
    }
  });

  it("keeps all hard gates wired into runDoctor hard-gate aggregation", () => {
    const indexSource = readFileSync(join(headSnapshotRoot(), "src", "doctor", "index.ts"), "utf8");
    const registrySource = readFileSync(
      join(headSnapshotRoot(), "src", "doctor", "check-registry.ts"),
      "utf8",
    );
    const definitionsSource = readFileSync(
      join(headSnapshotRoot(), "src", "doctor", "check-definitions.ts"),
      "utf8",
    );
    const groupSource = readFileSync(
      join(headSnapshotRoot(), "src", "doctor", "check-definition-groups.ts"),
      "utf8",
    );
    const profileSource = readFileSync(
      join(headSnapshotRoot(), "src", "doctor", "profiles.ts"),
      "utf8",
    );
    const runnerSource = readFileSync(
      join(headSnapshotRoot(), "src", "doctor", "runner.ts"),
      "utf8",
    );
    const definitions = buildFullDoctorCheckDefinitions(nodeDoctorDeps(headSnapshotRoot()));
    const definitionGroups = buildDoctorCheckDefinitionGroups(nodeDoctorDeps(headSnapshotRoot()));
    const flattenedGroupDefinitions = definitionGroups.flatMap((group) => group.definitions);
    const checkIds = definitions.map((definition) => definition.id);
    const groupCheckIds = flattenedGroupDefinitions.map((definition) => definition.id);
    const outputIds = [...FULL_DOCTOR_OUTPUT_IDS];
    expect(indexSource).toContain("resolveDoctorRunProfile");
    expect(indexSource).toContain("const profile = resolveDoctorRunProfile(options)");
    expect(indexSource).toContain('if (profile.invocation === "setup-smoke")');
    expect(indexSource).toContain(
      "const { checks, checkIds, timings } = collectDoctorCheckRun(deps, options)",
    );
    expect(registrySource).toContain('} from "./runner.ts"');
    expect(registrySource).toContain('} from "./check-definitions.ts"');
    expect(runnerSource).toContain("export function collectDoctorCheckRun");
    expect(runnerSource).toContain("export function collectDoctorChecks");
    expect(definitionsSource).toContain("export function buildFullDoctorCheckDefinitions");
    expect(definitionsSource).toContain("buildDoctorCheckDefinitionGroups(deps, options)");
    expect(groupSource).toContain("export function buildDoctorCheckDefinitionGroups");
    expect(runnerSource).toContain("buildFullDoctorCheckDefinitions(deps, options)");
    expect(definitionsSource).not.toContain("checkPlanReferenceFreshnessAdvisory");
    expect(registrySource).toContain('} from "./profiles.ts"');
    expect(profileSource).toContain("export const DOCTOR_RUN_PROFILES");
    expect(profileSource).toContain("export const DOCTOR_RUN_PROFILE_IDS");
    expect(profileSource).toContain("export function resolveDoctorRunProfile");
    expect(profileSource).toContain("export function doctorRunProfilesForAudience");
    expect(profileSource).toContain("export function consumerSafeDoctorRunProfiles");
    expect(profileSource).toContain("export function isConsumerSafeDoctorRunProfile");
    expect(profileSource).toContain('consumerSafeDoctorRunProfile("consumer-setup-smoke")');
    expect(profileSource).toContain('consumerSafeDoctorRunProfile("source-toolchain")');
    expect(runnerSource).toContain("export function selectDoctorCheckDefinitions");
    expect(profileSource).toContain('export type DoctorScope = "full" | "toolchain"');
    expect(definitionGroups.map((group) => group.id)).toEqual([
      "plan-governance",
      "rules-and-process",
      "runtime-surface",
      "completion-and-readability",
      "source-trace",
      "dependency-and-db",
      "workflow-and-final",
    ]);
    const expectedHardGates = [
      "propagation",
      "pair-freeze",
      "module-drift",
      "memory-sync",
      "asset-drift",
      "skill-assignment",
      "descent-obligation",
      "change-impact",
      "change-set-integrity",
      "verification-profile",
      "branch-kind-check",
      "coding-rules",
      "design-language",
      "ddd-tdd-rules",
      "runtime-portability",
      "db-projection-coverage",
      "db-projection-ingestion",
      "design-detection",
      "rule-drift",
      "model-id-doc-drift",
      "gate-confirm",
      "gate-id-format",
      "placeholder-deps",
      "g1-trace",
      "g3-trace",
      "rule-automation-closure",
      "drive-model-passage",
      "db-currency",
      "fr-roadmap-coverage",
      "telemetry-closure",
      "cycle-p4-verification",
      "l6-fr-coverage",
      "readability",
      "runtime-readability",
      "runtime-state-location",
      "test-repository-isolation",
      "project-hook",
      "codex-wrapper-parity",
      "toolchain-pin",
      "l6-completion",
      "l7-completion",
      "verification-groups",
      "roadmap",
      "impl-plan-trace",
      "oracle-test-trace",
      "tracked-canonical",
      "dependency-drift",
      "regression-expansion",
      "agent-contract-detection",
    ];

    expect(new Set(checkIds).size).toBe(checkIds.length);
    expect(groupCheckIds).toEqual(checkIds);
    expect(new Set(definitionGroups.map((group) => group.id)).size).toBe(definitionGroups.length);
    expect(new Set(outputIds).size).toBe(outputIds.length);
    expect(checkIds).toEqual(expect.arrayContaining(outputIds));
    expect(
      selectDoctorCheckDefinitions(definitions, "full").map((definition) => definition.id),
    ).toEqual(checkIds);
    expect(doctorOutputIdsForScope("full")).toEqual(outputIds);
    expect(outputIds).toEqual(expect.arrayContaining(expectedHardGates));
    const retiredPlanDoctorIds = [
      "merged-plan-status",
      "plan-body-substance",
      "plan-completion-drift",
      "green-command-digest",
      "review-evidence",
      "guardrail-invariants",
    ];
    for (const id of retiredPlanDoctorIds) {
      expect(checkIds).not.toContain(id);
      expect(outputIds).not.toContain(id);
    }
    expect(checkIds).not.toContain("plan-reference-freshness");
    expect(outputIds).not.toContain("plan-reference-freshness");
    expect(registrySource).not.toContain("checkPlanReferenceFreshnessAdvisory");
    const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]));
    for (const definition of definitions) {
      for (const requiredId of definition.requires ?? []) {
        const required = definitionsById.get(requiredId);
        expect(required).toBeDefined();
        expect(checkIds.indexOf(requiredId)).toBeLessThan(checkIds.indexOf(definition.id));
        expect(required?.profiles).toEqual(expect.arrayContaining([...definition.profiles]));
      }
    }
    expect(
      definitions.find((definition) => definition.id === "regression-expansion"),
    ).toMatchObject({
      requires: ["dependency-drift"],
    });
    const dependencyGroupIds =
      definitionGroups
        .find((group) => group.id === "dependency-and-db")
        ?.definitions.map((definition) => definition.id) ?? [];
    expect(dependencyGroupIds).toEqual(
      expect.arrayContaining(["dependency-drift", "regression-expansion"]),
    );
    expect(dependencyGroupIds.indexOf("dependency-drift")).toBeLessThan(
      dependencyGroupIds.indexOf("regression-expansion"),
    );
  });
});
