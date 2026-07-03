import { performance } from "node:perf_hooks";
import { checkHandoverOutstandingAnchor } from "../handover/index";
import { checkGreenCommandDigests } from "../lint/green-command-digest";
import type { LintResult } from "../plan/lint";
import { checkDbProjectionCoverage, checkDbProjectionIngestion } from "./db-projection";
import { checkDependencyDrift, checkRegressionExpansion } from "./dependency-regression";
import { checkDocConsistency, checkEntityCoverage, checkFrRegistryAudit } from "./doc-registry";
import {
  checkAssetDrift,
  checkBranchKind,
  checkChangeImpact,
  checkChangeSetIntegrity,
  checkDescentObligation,
  checkModuleDrift,
  checkSkillAssignment,
  checkVerificationProfile,
} from "./lint-gates";
import {
  checkBackfillResult,
  checkForwardConvergence,
  checkForwardConvergenceAudit,
  checkGuardrailInvariants,
  checkPairFreeze,
  checkPlanBodySubstance,
  checkPlanCompletionDrift,
  checkPlanGovernance,
  checkPlanSchedule,
  checkPlanSupersession,
  checkPropagation,
  checkReviewEvidence,
  checkScrumReverse,
} from "./plan-governance";
import {
  checkCycleP4Verification,
  checkDriveDbRegistration,
  checkDriveModelPassage,
  checkFeedbackLog,
  checkFrRoadmapCoverage,
  checkL6Completion,
  checkL6FrCoverage,
  checkL7Completion,
  checkL14CloseAudit,
  checkPlaceholderDeps,
  checkPlanDod,
  checkPlanTraceGate,
  checkRuleAutomationClosure,
  checkScreenImplPairFreeze,
  checkSubDocCatalogDrift,
  checkSubDocSectionStructure,
  checkTelemetryClosure,
} from "./process-quality";
import type { DoctorTiming } from "./result";
import { checkRoadmap, checkVerificationGroupsResult } from "./roadmap-verification";
import {
  checkCodingRules,
  checkDddTddRules,
  checkDesignLanguage,
  checkGateConfirm,
  checkReadability,
  checkRuleDrift,
  checkRuntimePortability,
  checkRuntimeReadability,
} from "./rule-quality";
import { type DoctorDeps, handoverDeps } from "./runtime-state";
import {
  checkCodexHookAdapter,
  checkCodexWrapperParity,
  checkGithubCiPolicy,
  checkProjectHooks,
} from "./runtime-surface";
import {
  checkImplPlanTrace,
  checkMergedPlanStatus,
  checkOracleTestTrace,
  checkPlanArtifactExistence,
  checkTrackedCanonical,
} from "./source-trace";
import { checkToolchainPin } from "./toolchain";
import {
  checkFrontendDesignCoverage,
  checkG8IntegrationWorkflow,
  checkG9SystemWorkflow,
  checkG10UxWorkflow,
  checkImprovementBacklog,
  checkLintWiring,
  checkProposalDocumentCoverage,
  checkRightArmGatePlanning,
} from "./workflow-quality";

export type DoctorScope = "full" | "toolchain";

export interface DoctorOptions {
  strictTelemetryProvenance?: boolean;
  strictGreenCommandDigest?: boolean;
  setupSmoke?: boolean;
  timing?: boolean;
  scope?: DoctorScope;
}

export interface DoctorCheckRun {
  checks: LintResult[];
  timings: DoctorTiming[];
}

export function collectDoctorCheckRun(
  deps: DoctorDeps,
  options: DoctorOptions = {},
): DoctorCheckRun {
  const scope = options.scope ?? "full";
  const timings: DoctorTiming[] = [];
  const record = <T extends LintResult>(id: string, run: () => T): T => {
    if (options.timing !== true) return run();
    const started = performance.now();
    const result = run();
    timings.push({
      id,
      duration_ms: Number((performance.now() - started).toFixed(3)),
      ok: result.ok,
      message_count: result.messages.length,
    });
    return result;
  };

  if (scope === "toolchain") {
    const toolchainPin = record("toolchain-pin", () => checkToolchainPin(deps.repoRoot));
    return { checks: [toolchainPin], timings };
  }

  const backfill = record("backfill", () => checkBackfillResult(deps.repoRoot));
  const scrumRev = record("scrum-reverse", () => checkScrumReverse(deps.repoRoot));
  const planSupersession = record("plan-supersession", () => checkPlanSupersession(deps.repoRoot));
  const planBodySubstance = record("plan-body-substance", () =>
    checkPlanBodySubstance(deps.repoRoot),
  );
  const planCompletionDrift = record("plan-completion-drift", () =>
    checkPlanCompletionDrift(deps.repoRoot),
  );
  const propagation = record("propagation", () => checkPropagation(deps.repoRoot));
  const reviewEvidence = record("review-evidence", () => checkReviewEvidence(deps.repoRoot));
  const pairFreeze = record("pair-freeze", () => checkPairFreeze(deps.repoRoot));
  const moduleDrift = record("module-drift", () => checkModuleDrift(deps.repoRoot));
  const mergedPlanStatus = record("merged-plan-status", () => checkMergedPlanStatus(deps.repoRoot));
  const planArtifactExistence = record("plan-artifact-existence", () =>
    checkPlanArtifactExistence(deps.repoRoot),
  );
  const assetDrift = record("asset-drift", () => checkAssetDrift(deps.repoRoot));
  const skillAssignment = record("skill-assignment", () => checkSkillAssignment(deps.repoRoot));
  const descentObligation = record("descent-obligation", () =>
    checkDescentObligation(deps.repoRoot),
  );
  const changeImpact = record("change-impact", () => checkChangeImpact(deps.repoRoot));
  const changeSetIntegrity = record("change-set-integrity", () =>
    checkChangeSetIntegrity(deps.repoRoot),
  );
  const verificationProfile = record("verification-profile", () =>
    checkVerificationProfile(deps.repoRoot),
  );
  const branchKind = record("branch-kind-check", () => checkBranchKind(deps.repoRoot));
  const codingRules = record("coding-rules", () => checkCodingRules(deps.repoRoot));
  const designLanguage = record("design-language", () => checkDesignLanguage(deps.repoRoot));
  const dddTddRules = record("ddd-tdd-rules", () => checkDddTddRules(deps.repoRoot));
  const runtimePortability = record("runtime-portability", () =>
    checkRuntimePortability(deps.repoRoot),
  );
  const ruleDrift = record("rule-drift", () => checkRuleDrift(deps.repoRoot));
  const gateConfirm = record("gate-confirm", () => checkGateConfirm(deps.repoRoot));
  const planSchedule = record("plan-schedule", () => checkPlanSchedule(deps.repoRoot));
  const planGovernance = record("plan-governance", () => checkPlanGovernance(deps.repoRoot));
  const planDod = record("plan-dod", () => checkPlanDod(deps.repoRoot));
  const placeholderDeps = record("placeholder-deps", () => checkPlaceholderDeps(deps.repoRoot));
  const g1Trace = record("g1-trace", () => checkPlanTraceGate(deps.repoRoot, "G1-trace"));
  const g3Trace = record("g3-trace", () => checkPlanTraceGate(deps.repoRoot, "G3-trace"));
  const ruleAutomationClosure = record("rule-automation-closure", () =>
    checkRuleAutomationClosure(deps.repoRoot),
  );
  const driveModelPassage = record("drive-model-passage", () =>
    checkDriveModelPassage(deps.repoRoot),
  );
  const driveDbRegistration = record("drive-db-registration", () =>
    checkDriveDbRegistration(deps.repoRoot),
  );
  const frRoadmapCoverage = record("fr-roadmap-coverage", () =>
    checkFrRoadmapCoverage(deps.repoRoot),
  );
  const telemetryClosure = record("telemetry-closure", () => checkTelemetryClosure(deps.repoRoot));
  const cycleP4Verification = record("cycle-p4-verification", () =>
    checkCycleP4Verification(deps.repoRoot),
  );
  const l14CloseAudit = record("l14-close-audit", () => checkL14CloseAudit(deps.repoRoot));
  const projectHooks = record("project-hook", () => checkProjectHooks(deps.repoRoot));
  const githubCiPolicy = record("github-ci-policy", () => checkGithubCiPolicy(deps.repoRoot));
  const codexHookAdapter = record("codex-hook-adapter", () => checkCodexHookAdapter(deps.repoRoot));
  const codexWrapperParity = record("codex-wrapper-parity", () => checkCodexWrapperParity(deps));
  const toolchainPin = record("toolchain-pin", () => checkToolchainPin(deps.repoRoot));
  const l6FrCoverage = record("l6-fr-coverage", () => checkL6FrCoverage(deps.repoRoot));
  const readability = record("readability", () => checkReadability(deps.repoRoot));
  const runtimeReadability = record("runtime-readability", () =>
    checkRuntimeReadability(deps.repoRoot),
  );
  const feedbackLog = record("feedback-log", () => checkFeedbackLog(deps.repoRoot));
  const l6Completion = record("l6-completion", () => checkL6Completion(deps.repoRoot));
  const l7Completion = record("l7-completion", () => checkL7Completion(deps.repoRoot));
  const roadmap = record("roadmap", () => checkRoadmap(deps.repoRoot));
  const implPlanTrace = record("impl-plan-trace", () => checkImplPlanTrace(deps.repoRoot));
  const oracleTestTrace = record("oracle-test-trace", () => checkOracleTestTrace(deps.repoRoot));
  const trackedCanonical = record("tracked-canonical", () => checkTrackedCanonical(deps.repoRoot));
  const subDocCatalogDrift = record("sub-doc-catalog-drift", () =>
    checkSubDocCatalogDrift(deps.repoRoot),
  );
  const subDocSectionStructure = record("sub-doc-section-structure", () =>
    checkSubDocSectionStructure(deps.repoRoot),
  );
  const screenImplPairFreeze = record("screen-impl-pair-freeze", () =>
    checkScreenImplPairFreeze(deps.repoRoot),
  );
  const verificationGroups = record("verification-groups", () =>
    checkVerificationGroupsResult(deps.repoRoot),
  );
  const dependencyDrift = record("dependency-drift", () => checkDependencyDrift(deps.repoRoot));
  const regressionExpansion = record("regression-expansion", () =>
    checkRegressionExpansion(deps.repoRoot, dependencyDrift.result),
  );
  const guardrailInvariants = record("guardrail-invariants", () =>
    checkGuardrailInvariants(deps.repoRoot),
  );
  const dbProjectionCoverage = record("db-projection-coverage", () =>
    checkDbProjectionCoverage(deps.repoRoot),
  );
  const dbProjectionIngestion = record("db-projection-ingestion", () =>
    checkDbProjectionIngestion(deps.repoRoot, options),
  );
  const docConsistency = record("doc-consistency", () => checkDocConsistency(deps.repoRoot));
  const entityCoverage = record("entity-coverage", () => checkEntityCoverage(deps.repoRoot));
  const frRegistryAudit = record("fr-registry-audit", () => checkFrRegistryAudit(deps.repoRoot));
  const improvementBacklog = record("improvement-backlog", () =>
    checkImprovementBacklog(deps.repoRoot),
  );
  const rightArmGatePlanning = record("right-arm-gate-planning", () =>
    checkRightArmGatePlanning(deps.repoRoot),
  );
  const g8IntegrationWorkflow = record("g8-integration-workflow", () =>
    checkG8IntegrationWorkflow(deps.repoRoot),
  );
  const g9SystemWorkflow = record("g9-system-workflow", () => checkG9SystemWorkflow(deps.repoRoot));
  const g10UxWorkflow = record("g10-ux-workflow", () => checkG10UxWorkflow(deps.repoRoot));
  const lintWiring = record("lint-wiring", () => checkLintWiring(deps.repoRoot));
  const proposalDocumentCoverage = record("proposal-document-coverage", () =>
    checkProposalDocumentCoverage(deps.repoRoot),
  );
  const frontendDesignCoverage = record("frontend-design-coverage", () =>
    checkFrontendDesignCoverage(deps.repoRoot),
  );
  const handoverOutstanding = record("handover-outstanding", () =>
    checkHandoverOutstandingAnchor(handoverDeps(deps)),
  );
  const greenCommandDigest = record("green-command-digest", () => {
    const result = checkGreenCommandDigests(deps.repoRoot);
    return {
      ...result,
      ok: options.strictGreenCommandDigest === true ? result.mismatches.length === 0 : true,
    };
  });
  const forwardConvergence = record("forward-convergence", () =>
    checkForwardConvergence(deps.repoRoot),
  );
  const forwardConvergenceAudit = record("forward-convergence-audit", () =>
    checkForwardConvergenceAudit(deps.repoRoot),
  );

  const checks = [
    backfill,
    scrumRev,
    planSupersession,
    planBodySubstance,
    planCompletionDrift,
    propagation,
    pairFreeze,
    moduleDrift,
    mergedPlanStatus,
    planArtifactExistence,
    assetDrift,
    skillAssignment,
    descentObligation,
    changeImpact,
    changeSetIntegrity,
    verificationProfile,
    branchKind,
    codingRules,
    designLanguage,
    dddTddRules,
    runtimePortability,
    ruleDrift,
    gateConfirm,
    planSchedule,
    planGovernance,
    planDod,
    placeholderDeps,
    g1Trace,
    g3Trace,
    ruleAutomationClosure,
    driveModelPassage,
    driveDbRegistration,
    frRoadmapCoverage,
    telemetryClosure,
    cycleP4Verification,
    l14CloseAudit,
    projectHooks,
    githubCiPolicy,
    codexHookAdapter,
    codexWrapperParity,
    toolchainPin,
    l6FrCoverage,
    readability,
    runtimeReadability,
    feedbackLog,
    l6Completion,
    l7Completion,
    reviewEvidence,
    guardrailInvariants,
    verificationGroups,
    roadmap,
    implPlanTrace,
    oracleTestTrace,
    trackedCanonical,
    subDocCatalogDrift,
    subDocSectionStructure,
    screenImplPairFreeze,
    dependencyDrift,
    regressionExpansion,
    dbProjectionCoverage,
    dbProjectionIngestion,
    docConsistency,
    entityCoverage,
    frRegistryAudit,
    improvementBacklog,
    rightArmGatePlanning,
    g8IntegrationWorkflow,
    g9SystemWorkflow,
    g10UxWorkflow,
    lintWiring,
    proposalDocumentCoverage,
    frontendDesignCoverage,
    handoverOutstanding,
    greenCommandDigest,
    forwardConvergence,
    forwardConvergenceAudit,
  ];

  return { checks, timings };
}

export function collectDoctorChecks(deps: DoctorDeps, options: DoctorOptions = {}): LintResult[] {
  return collectDoctorCheckRun(deps, options).checks;
}
