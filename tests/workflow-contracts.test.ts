import { describe, expect, it } from "vitest";
import { recommendedCommandV1Schema } from "../src/schema/index";
import { routeSignalCandidates } from "../src/schema/route-map";
import { openHarnessDb } from "../src/state-db/index";
import { migrate } from "../src/state-db/migration";
import {
  assertRefactorInvariant,
  classifyDriveTddFits,
  computeUtHistorySignals,
  decideDiscoveryS4,
  detectFrontendDrift,
  enforceForwardOrder,
  evaluateGreenDefinition,
  evaluateResearchDecision,
  evaluateRetrofitMatrix,
  mergeTwoStageAgentDesign,
  recordCrossCuttingEvent,
  recordTestRunEvidence,
  routeReverseR4,
  routeScrumFullback,
  validateDContractDsl,
  validateFrontendDesignWorkflow,
  validateScreenDesignWorkflow,
} from "../src/workflow/contracts";
import {
  buildCommandCatalog,
  catalogExistingAssets,
  catalogSkills,
  classifyDrive,
  prioritizeCapabilityGaps,
  recommendModelEffort,
  recommendSkills,
  renderFoundationReadiness,
  resolveDriveStatePartition,
  suggestSkillInjection,
  validateDriveStatePartitions,
  validateFolderRules,
} from "../src/workflow/contracts-extras";
import { DRIVE_TDD_FITS } from "../src/workflow/contracts-policy";
import type { ContractResult as SidecarContractResult } from "../src/workflow/contracts-types";
import {
  evaluateRouteCommand,
  routeSignalToMode,
  validateRouteConfigText,
} from "../src/workflow/routing-contracts";

// @ut-tdd-trace FR-L1-06
// @ut-tdd-trace FR-L1-08
// @ut-tdd-trace FR-L1-11
// @ut-tdd-trace FR-L1-12
// @ut-tdd-trace FR-L1-13
// @ut-tdd-trace FR-L1-14
// @ut-tdd-trace FR-L1-15
// @ut-tdd-trace FR-L1-22
// @ut-tdd-trace FR-L1-23
// @ut-tdd-trace FR-L1-25
// @ut-tdd-trace FR-L1-26
// @ut-tdd-trace FR-L1-27
// @ut-tdd-trace FR-L1-28
// @ut-tdd-trace FR-L1-29
// @ut-tdd-trace FR-L1-30
// @ut-tdd-trace FR-L1-32
// @ut-tdd-trace FR-L1-37
// @ut-tdd-trace FR-L1-39
// @ut-tdd-trace FR-L1-40
// @ut-tdd-trace FR-L1-41
// @ut-tdd-trace FR-L1-47
// @ut-tdd-trace FR-L1-48

describe("L7 workflow contract implementations", () => {
  it("records UT run evidence into harness.db projection tables and reports weak links", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      const result = recordTestRunEvidence(
        {
          plan_id: "PLAN-L7-X",
          command: "bun run test",
          runner: "vitest",
          scope: "tests/workflow-contracts.test.ts",
          started_at: "2026-06-12T00:00:00.000Z",
          completed_at: "2026-06-12T00:01:00.000Z",
          exit_code: 0,
          evidence_path: ".ut-tdd/evidence/test.json",
          output_digest: "sha256:0123456789abcdef",
          cases: [
            {
              oracle_id: "U-FR-L1-06",
              name: "records projection",
              status: "passed",
              artifact_path: "src/workflow/contracts.ts",
            },
          ],
        },
        { db },
      );

      expect(result.ok).toBe(true);
      expect(result.refs.map((ref) => ref.table)).toEqual([
        "test_runs",
        "test_cases",
        "test_results",
        "test_artifact_edges",
      ]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM test_runs").get()?.n).toBe(1);
      expect(
        db.prepare("SELECT output_digest FROM test_runs WHERE plan_id = ?").get("PLAN-L7-X")
          ?.output_digest,
      ).toBe("sha256:0123456789abcdef");
      expect(db.prepare("SELECT COUNT(*) AS n FROM test_artifact_edges").get()?.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it("evaluates green definition and UT history signals without silent pass", () => {
    const green = evaluateGreenDefinition({
      profile: "l7",
      required_commands: ["lint", "test"],
      reviewed_at: "2026-06-12T00:05:00.000Z",
      command_evidence: [
        {
          kind: "lint",
          completed_at: "2026-06-12T00:01:00.000Z",
          exit_code: 0,
          evidence_path: "lint.log",
        },
        {
          kind: "test",
          completed_at: "2026-06-12T00:02:00.000Z",
          exit_code: 0,
          evidence_path: "test.log",
        },
      ],
    });
    expect(green.ok).toBe(true);
    expect(green.computed_green_at).toBe("2026-06-12T00:02:00.000Z");

    const weak = evaluateGreenDefinition({
      profile: "l7",
      required_commands: ["lint", "test", "doctor"],
      command_evidence: [],
    });
    expect(weak.ok).toBe(false);
    expect(weak.missing).toEqual(["lint", "test", "doctor"]);

    const signals = computeUtHistorySignals({
      required_oracles: ["U-1", "U-2"],
      test_runs: [
        {
          command: "test",
          runner: "vitest",
          scope: "unit",
          started_at: "2026-06-12T00:00:00.000Z",
          completed_at: "2026-06-12T00:01:00.000Z",
          exit_code: 0,
          evidence_path: "test.log",
          cases: [{ oracle_id: "U-1", name: "one", status: "passed" }],
        },
      ],
    });
    expect(signals.signals.find((s) => s.signal_type === "oracle_coverage")?.score).toBe(0.5);
  });

  it("implements routing, workflow, FE/design, asset, model, drive, skill, and command contracts", () => {
    expect(routeSignalCandidates("feature_addition")).toEqual(["add-feature"]);
    expect(routeSignalCandidates("version_deferral")).toEqual(["version-up"]);
    expect(routeSignalToMode({ signal: "reverse gap" }).candidates).toEqual(["reverse"]);
    expect(routeSignalToMode({ signal: "drift", drive: "agent" }).candidates[0]).toBe("reverse");
    expect(routeSignalToMode({ signal: "regression_prod" }).candidates[0]).toBe("incident");
    expect(routeSignalToMode({ signal: "new_requirement" }).candidates[0]).toBe("add-feature");
    expect(routeSignalToMode({ signal: "version_deferral" }).candidates[0]).toBe("version-up");
    const routeEval = evaluateRouteCommand({ signal: "reverse gap" });
    expect(routeEval.mode).toBe("reverse");
    expect(routeEval.exit_code).toBe(0);
    expect(routeEval.recommended_command?.command).toBe("ut-tdd task classify");
    expect(recommendedCommandV1Schema.safeParse(routeEval.recommended_command).success).toBe(true);
    expect(routeEval.suggest_command).toContain("reverse gap");
    const unknownRoute = evaluateRouteCommand({ signal: "unmapped-special-case" });
    expect(unknownRoute.exit_code).toBe(2);
    expect(unknownRoute.recommended_command).toBeNull();
    const blockedRoute = evaluateRouteCommand({ signal: "forced_stop" });
    expect(blockedRoute.exit_code).toBe(1);
    expect(blockedRoute.approval.status).toBe("policy_missing");
    expect(blockedRoute.suggest_command).toBe("ut-tdd doctor");
    expect(blockedRoute.recommended_command?.safety.requires_human_approval).toBe(true);
    for (const signal of ["production_incident", "hotfix_required", "regression_prod"]) {
      const incidentRoute = evaluateRouteCommand({ signal });
      expect(incidentRoute.mode).toBe("incident");
      expect(incidentRoute.exit_code).toBe(1);
      expect(incidentRoute.approval.required).toBe(true);
      expect(incidentRoute.recommended_command?.command).toBe("ut-tdd doctor");
    }
    const approvedRoute = evaluateRouteCommand({
      signal: "forced_stop",
      approval_policy: {
        rules: [{ mode: "recovery", required_approvers: ["tl", "po"] }],
        approvals: [
          { mode: "recovery", approver: "tl", approved_at: "2026-06-23T00:00:00.000Z" },
          { mode: "recovery", approver: "po", approved_at: "2026-06-23T00:00:00.000Z" },
        ],
      },
    });
    expect(approvedRoute.exit_code).toBe(0);
    expect(approvedRoute.approval.status).toBe("approved");
    const driftRoute = evaluateRouteCommand({ signal: "drift", drift_type: "schema" });
    expect(driftRoute.mode).toBe("reverse");
    expect(driftRoute.recommended_command?.args).toMatchObject({ drift_type: "schema" });
    const additiveInterruptRoute = evaluateRouteCommand({ signal: "new_requirement" });
    expect(additiveInterruptRoute.mode).toBe("add-feature");
    const versionDeferralRoute = evaluateRouteCommand({ signal: "version_deferral" });
    expect(versionDeferralRoute.exit_code).toBe(0);
    expect(versionDeferralRoute.mode).toBe("version-up");
    expect(versionDeferralRoute.recommended_command?.command).toBe("ut-tdd task classify");
    expect(versionDeferralRoute.recommended_command?.args).toMatchObject({
      signal: "version_deferral",
      mode: "version-up",
    });
    const legacyCommandRoute = evaluateRouteCommand({
      signal: "legacy override",
      route_map: [
        {
          tokens: ["legacy"],
          mode: "reverse",
          command: "legacy-cli reverse",
          preflight: true,
          requiresApproval: false,
        },
      ],
    });
    expect(legacyCommandRoute.exit_code).toBe(1);
    expect(legacyCommandRoute.recommended_command).toBeNull();
    expect(legacyCommandRoute.findings[0]?.code).toBe("legacy-runtime-command");
    const routeConfigViolations = validateRouteConfigText({
      path: ".ut-tdd/config/route-map.yaml",
      text: "source: legacy DB\nowner: C:\\Users\\micro\\legacy\n",
    });
    expect(routeConfigViolations.map((v) => v.code)).toEqual([
      "legacy-db-dependency",
      "personal-absolute-path",
    ]);
    const routeConfigBlocked = evaluateRouteCommand({
      signal: "reverse gap",
      route_config_violations: routeConfigViolations,
    });
    expect(routeConfigBlocked.exit_code).toBe(1);
    expect(routeConfigBlocked.recommended_command).toBeNull();
    const escalationBlocked = evaluateRouteCommand({
      signal: "feature_addition payment support",
    });
    expect(escalationBlocked.exit_code).toBe(1);
    expect(escalationBlocked.mode).toBe("add-feature");
    expect(escalationBlocked.escalation_boundaries.map((b) => b.term)).toContain("payment");
    expect(escalationBlocked.approval.status).toBe("policy_missing");
    expect(escalationBlocked.recommended_command?.safety.requires_human_approval).toBe(true);
    const escalationApproved = evaluateRouteCommand({
      signal: "feature_addition payment support",
      approval_policy: {
        rules: [{ mode: "*", condition: "escalation", required_approvers: ["po"] }],
        approvals: [
          {
            mode: "*",
            condition: "escalation",
            approver: "po",
            approved_at: "2026-06-23T00:00:00.000Z",
          },
        ],
      },
    });
    expect(escalationApproved.exit_code).toBe(0);
    expect(escalationApproved.approval.status).toBe("approved");
    expect(
      recordCrossCuttingEvent({
        type: "drift",
        subject_id: "PLAN-X",
        severity: "warn",
        evidence_path: "evidence.md",
      }).ok,
    ).toBe(true);
    const skillInjection: SidecarContractResult & {
      candidates: { skill_id: string; score: number; reason: string }[];
    } = suggestSkillInjection({
      task: "test doctor",
      layer: "L7",
      drive: "agent",
      catalog: [{ skill_id: "testing", triggers: ["test"], layers: ["L7"], drives: ["agent"] }],
    });
    expect(skillInjection.ok).toBe(true);
    expect(skillInjection.candidates[0]?.skill_id).toBe("testing");
    expect(
      enforceForwardOrder({
        layer: "L7",
        gate: "G7",
        prior_gates: [{ gate: "G6", status: "passed" }],
      }).allowed,
    ).toBe(true);
    expect(
      routeReverseR4({
        reverse_type: "gap",
        r4_evidence: { status: "confirmed", evidence_path: "r4.md" },
        forward_routing: "PLAN-L7-X",
      }).target_plan,
    ).toBe("PLAN-L7-X");
    expect(
      decideDiscoveryS4({
        hypothesis: "h",
        poc_evidence: { status: "verified", evidence_path: "poc.md" },
        outcome: "confirmed",
      }).decision,
    ).toBe("confirmed");
    expect(detectFrontendDrift({ token_root: "tokens" }).drift_signals).toContain(
      "absent:mock_root",
    );
    expect(
      routeScrumFullback({ increment: "INC-1", s4_decision: "confirmed" }).forward_targets,
    ).toEqual(["Forward:INC-1"]);
    expect(
      assertRefactorInvariant({
        before: "same",
        after: "same",
        regression: { exit_code: 0, evidence_path: "test.log", test_ids: ["U-FR-L1-25"] },
      }).unchanged,
    ).toBe(true);
    const refactorWithoutTestId = assertRefactorInvariant({
      before: "same",
      after: "same",
      regression: { exit_code: 0, evidence_path: "test.log" },
    });
    expect(refactorWithoutTestId.ok).toBe(false);
    expect(refactorWithoutTestId.findings.map((f) => f.code)).toContain("refactor-test-id-missing");
    expect(evaluateRetrofitMatrix({ migration: "m", config: "c", rollback: "r" }).readiness).toBe(
      "ready",
    );
    expect(
      evaluateResearchDecision({ memo: "m", sources: ["s"], adr_candidate: "ADR" }).decision_ready,
    ).toBe(true);
    expect(mergeTwoStageAgentDesign({ phase1: "a", phase2: "b", handoff: "c" }).merged).toContain(
      "a",
    );
    expect(
      validateScreenDesignWorkflow({
        ia: "i",
        screens: "s",
        flow: "f",
        wireframe: "w",
        mock: "m",
        components: "c",
      }).complete,
    ).toBe(true);
    expect(
      validateFrontendDesignWorkflow({
        visual: "v",
        tokens: "t",
        a11y: "a",
        vrt: "r",
        ux: "u",
      }).complete,
    ).toBe(true);
    const tddFits = classifyDriveTddFits({
      modes: ["design", "add-feature", "refactor", "screen-design", "frontend-design"],
    });
    expect(DRIVE_TDD_FITS.map((fit) => fit.mode)).toContain("design-bottomup");
    expect(tddFits.ok).toBe(true);
    expect(tddFits.fits.every((fit) => fit.compatibility === "strong")).toBe(true);
    expect(tddFits.fits.find((fit) => fit.mode === "design")?.red_triggers).toContain(
      "descent_obligation_missing",
    );
    expect(
      tddFits.fits.find((fit) => fit.mode === "frontend-design")?.green_requirements,
    ).toContain("vrt");
    expect(
      validateFolderRules({
        path: "docs/plans/PLAN.md",
        artifact_kind: "plan",
        registry: { plan: ["docs/plans/"] },
      }).violations,
    ).toEqual([]);
    expect(
      catalogExistingAssets({ roots: [{ path: "docs/skills/x.md", type: "skill" }] }).assets,
    ).toHaveLength(1);
    expect(
      prioritizeCapabilityGaps({
        assets: [{ asset_id: "a" }],
        workflow_impact: { roster: 3 },
        missing_routes: ["roster"],
      }).priorities[0]?.gap,
    ).toBe("roster");
    expect(
      renderFoundationReadiness({
        categories: [{ name: "db", implemented: true }, { name: "ui" }],
      }).missing,
    ).toEqual(["ui"]);
    expect(
      recommendModelEffort({
        task: "large uncertain",
        drive: "agent",
        layer: "L7",
        size: "L",
        uncertainty: 0.8,
      }).reasoning_effort,
    ).toBe("high");
    expect(classifyDrive({ plan: "PLAN db" }).drive).toBe("db");
    expect(
      resolveDriveStatePartition({
        drive: "db",
        mode: "Forward",
        kind: "impl",
        layer: "L7",
        plan_id: "PLAN-X",
      }).partition_path,
    ).toContain(".ut-tdd/drive/db/Forward/PLAN-X");
    const dbPartition = resolveDriveStatePartition({
      drive: "db",
      mode: "Forward",
      kind: "impl",
      layer: "L7",
      plan_id: "PLAN-DB",
    });
    const agentPartition = resolveDriveStatePartition({
      drive: "agent",
      mode: "Forward",
      kind: "impl",
      layer: "L7",
      plan_id: "PLAN-AGENT",
    });
    expect(
      validateDriveStatePartitions({
        partitions: [
          { drive: "db", partition_path: dbPartition.partition_path, artifact_ids: ["db-only"] },
          {
            drive: "agent",
            partition_path: agentPartition.partition_path,
            artifact_ids: ["agent-only"],
          },
        ],
      }).ok,
    ).toBe(true);
    const contaminated = validateDriveStatePartitions({
      partitions: [
        { drive: "db", partition_path: dbPartition.partition_path, artifact_ids: ["shared"] },
        {
          drive: "agent",
          partition_path: agentPartition.partition_path,
          artifact_ids: ["shared"],
        },
      ],
    });
    expect(contaminated.ok).toBe(false);
    expect(contaminated.findings.map((finding) => finding.code)).toContain(
      "cross-drive-artifact-contamination",
    );
    expect(
      validateDriveStatePartitions({
        allowed_cross_drive_artifacts: ["shared"],
        partitions: [
          { drive: "db", partition_path: dbPartition.partition_path, artifact_ids: ["shared"] },
          {
            drive: "agent",
            partition_path: agentPartition.partition_path,
            artifact_ids: ["shared"],
          },
        ],
      }).ok,
    ).toBe(true);
    expect(
      catalogSkills({ skill_docs: [{ path: "s.md", triggers: ["test"] }] }).skills,
    ).toHaveLength(1);
    expect(
      recommendSkills({
        task: "test",
        layer: "L7",
        drive: "agent",
        catalog: [{ skill_id: "testing", triggers: ["test"] }],
      }).recommendations,
    ).toHaveLength(1);
    expect(
      buildCommandCatalog({
        command_docs: [{ path: "docs/commands/db.md", command: "db status" }],
        cli_surface: ["db status"],
      }).ok,
    ).toBe(true);
  });

  it("IT-ADAPTER-03: validates D-CONTRACT mode-routing and gate-checks DSL before execution", () => {
    const validModeRouting = `
routes:
  - signal: drift
    mode: reverse
    priority: 10
    next: [feature_addition]
  - signal: feature_addition
    mode: add-feature
    priority: 1
  - signal: version_deferral
    mode: version-up
    priority: 1
`;
    const validGateChecks = `
gates:
  G8:
    - check_id: g8-integration-workflow
      assertion: mandatory integration tests pass
      next_action:
        schema_version: v1
        command: ut-tdd doctor
        args:
          check: g8-integration-workflow
        safety:
          auto_apply: false
          requires_human_approval: false
          requires_preflight: true
`;

    const valid = validateDContractDsl({
      modeRoutingText: validModeRouting,
      gateChecksText: validGateChecks,
      requiredGateIds: ["G8"],
    });
    expect(valid.ok).toBe(true);
    expect(valid.mode_routing?.routes.map((route) => route.mode)).toEqual([
      "reverse",
      "add-feature",
      "version-up",
    ]);
    expect(valid.gate_checks?.gates.G8?.[0]?.next_action.command).toBe("ut-tdd doctor");

    const unknownMode = validateDContractDsl({
      modeRoutingText: validModeRouting.replace("mode: reverse", "mode: unsupported"),
      gateChecksText: validGateChecks,
      requiredGateIds: ["G8"],
    });
    expect(unknownMode.ok).toBe(false);
    expect(unknownMode.findings.map((finding) => finding.code)).toContain("d-contract-schema");
    expect(unknownMode.mode_routing).toBeNull();

    const missingGate = validateDContractDsl({
      modeRoutingText: validModeRouting,
      gateChecksText: validGateChecks,
      requiredGateIds: ["G8", "G9"],
    });
    expect(missingGate.ok).toBe(false);
    expect(missingGate.findings.map((finding) => finding.code)).toContain(
      "d-contract-missing-gate",
    );

    const circularRouting = validateDContractDsl({
      modeRoutingText: `
routes:
  - signal: drift
    mode: reverse
    next: [feature_addition]
  - signal: feature_addition
    mode: add-feature
    next: [drift]
`,
      gateChecksText: validGateChecks,
      requiredGateIds: ["G8"],
    });
    expect(circularRouting.ok).toBe(false);
    expect(circularRouting.findings.map((finding) => finding.code)).toContain(
      "d-contract-routing-cycle",
    );

    const legacyCommand = validateDContractDsl({
      modeRoutingText: validModeRouting,
      gateChecksText: validGateChecks.replace(
        "command: ut-tdd doctor",
        "command: legacy-cli doctor",
      ),
      requiredGateIds: ["G8"],
    });
    expect(legacyCommand.ok).toBe(false);
    expect(legacyCommand.findings.map((finding) => finding.code)).toContain("d-contract-schema");
    expect(legacyCommand.gate_checks).toBeNull();
  });
});
