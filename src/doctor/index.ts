/**
 * 統合検証 doctor (requirements_v1.2 §7 / §7.8.5)。
 * 多数の検出器 (back-fill / review-evidence / asset-drift / cycle-p4-verification / roadmap 等) を集約し、
 * gate 判定群を runDoctor.ok に連動させて fail-close する。handover / agent-slots は warning surface。
 */

import { checkHandoverOutstandingAnchor } from "../handover/index";
import { checkGreenCommandDigests } from "../lint/green-command-digest";
import type { LintResult } from "../plan/lint";
import { detectMode } from "../runtime/detect";
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
  checkPlanReferenceFreshnessAdvisory,
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
import { buildDoctorResult } from "./result";
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
import {
  checkAgentSlots,
  checkHandover,
  checkHandoverDisciplineMessages,
  type DoctorDeps,
  doctorSlotsDeps,
  handoverDeps,
  nodeDoctorDeps,
} from "./runtime-state";
import {
  checkCodexHookAdapter,
  checkCodexWrapperParity,
  checkGithubCiPolicy,
  checkProjectHooks,
} from "./runtime-surface";
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

export { checkDbProjectionCoverage, checkDbProjectionIngestion } from "./db-projection";
export { checkDependencyDrift, checkRegressionExpansion } from "./dependency-regression";
export { checkDocConsistency, checkEntityCoverage, checkFrRegistryAudit } from "./doc-registry";
export {
  checkAssetDrift,
  checkBranchKind,
  checkChangeImpact,
  checkChangeSetIntegrity,
  checkDescentObligation,
  checkModuleDrift,
  checkSkillAssignment,
  checkVerificationProfile,
} from "./lint-gates";
export {
  checkBackfill,
  checkBackfillResult,
  checkForwardConvergence,
  checkForwardConvergenceAudit,
  checkGuardrailInvariants,
  checkPairFreeze,
  checkPlanBodySubstance,
  checkPlanCompletionDrift,
  checkPlanGovernance,
  checkPlanReferenceFreshnessAdvisory,
  checkPlanSchedule,
  checkPlanSupersession,
  checkPropagation,
  checkReviewEvidence,
  checkScrumReverse,
} from "./plan-governance";
export {
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
export {
  checkRoadmap,
  checkVerificationGroups,
  checkVerificationGroupsResult,
} from "./roadmap-verification";
export {
  checkCodingRules,
  checkDddTddRules,
  checkDesignLanguage,
  checkGateConfirm,
  checkReadability,
  checkRuleDrift,
  checkRuntimePortability,
  checkRuntimeReadability,
} from "./rule-quality";
export {
  checkAgentSlots,
  checkHandover,
  checkHandoverDisciplineMessages,
  type DoctorDeps,
  nodeDoctorDeps,
} from "./runtime-state";
export {
  checkCodexHookAdapter,
  checkCodexWrapperParity,
  checkGithubCiPolicy,
  checkProjectHooks,
} from "./runtime-surface";
export {
  checkFrontendDesignCoverage,
  checkG8IntegrationWorkflow,
  checkG9SystemWorkflow,
  checkG10UxWorkflow,
  checkImprovementBacklog,
  checkLintWiring,
  checkProposalDocumentCoverage,
  checkRightArmGatePlanning,
} from "./workflow-quality";

import { checkSetupSmoke } from "./setup-smoke";
import {
  checkImplPlanTrace,
  checkMergedPlanStatus,
  checkOracleTestTrace,
  checkPlanArtifactExistence,
  checkTrackedCanonical,
} from "./source-trace";

export {
  checkImplPlanTrace,
  checkMergedPlanStatus,
  checkOracleTestTrace,
  checkPlanArtifactExistence,
  checkTrackedCanonical,
} from "./source-trace";

export interface DoctorOptions {
  strictTelemetryProvenance?: boolean;
  strictGreenCommandDigest?: boolean;
  setupSmoke?: boolean;
}

function collectDoctorChecks(deps: DoctorDeps, options: DoctorOptions = {}) {
  const backfill = checkBackfillResult(deps.repoRoot);
  const scrumRev = checkScrumReverse(deps.repoRoot);
  const planSupersession = checkPlanSupersession(deps.repoRoot);
  const planBodySubstance = checkPlanBodySubstance(deps.repoRoot);
  const planCompletionDrift = checkPlanCompletionDrift(deps.repoRoot);
  const propagation = checkPropagation(deps.repoRoot);
  const reviewEvidence = checkReviewEvidence(deps.repoRoot);
  const pairFreeze = checkPairFreeze(deps.repoRoot);
  const moduleDrift = checkModuleDrift(deps.repoRoot);
  const mergedPlanStatus = checkMergedPlanStatus(deps.repoRoot);
  const planArtifactExistence = checkPlanArtifactExistence(deps.repoRoot);
  const assetDrift = checkAssetDrift(deps.repoRoot);
  const skillAssignment = checkSkillAssignment(deps.repoRoot);
  const descentObligation = checkDescentObligation(deps.repoRoot);
  const changeImpact = checkChangeImpact(deps.repoRoot);
  const changeSetIntegrity = checkChangeSetIntegrity(deps.repoRoot);
  const verificationProfile = checkVerificationProfile(deps.repoRoot);
  const branchKind = checkBranchKind(deps.repoRoot);
  const codingRules = checkCodingRules(deps.repoRoot);
  const designLanguage = checkDesignLanguage(deps.repoRoot);
  const dddTddRules = checkDddTddRules(deps.repoRoot);
  const runtimePortability = checkRuntimePortability(deps.repoRoot);
  const ruleDrift = checkRuleDrift(deps.repoRoot);
  const gateConfirm = checkGateConfirm(deps.repoRoot);
  const planSchedule = checkPlanSchedule(deps.repoRoot);
  const planGovernance = checkPlanGovernance(deps.repoRoot);
  const planDod = checkPlanDod(deps.repoRoot);
  const placeholderDeps = checkPlaceholderDeps(deps.repoRoot);
  const g1Trace = checkPlanTraceGate(deps.repoRoot, "G1-trace");
  const g3Trace = checkPlanTraceGate(deps.repoRoot, "G3-trace");
  const ruleAutomationClosure = checkRuleAutomationClosure(deps.repoRoot);
  const driveModelPassage = checkDriveModelPassage(deps.repoRoot);
  const driveDbRegistration = checkDriveDbRegistration(deps.repoRoot);
  const frRoadmapCoverage = checkFrRoadmapCoverage(deps.repoRoot);
  const telemetryClosure = checkTelemetryClosure(deps.repoRoot);
  const cycleP4Verification = checkCycleP4Verification(deps.repoRoot);
  const l14CloseAudit = checkL14CloseAudit(deps.repoRoot);
  const projectHooks = checkProjectHooks(deps.repoRoot);
  const githubCiPolicy = checkGithubCiPolicy(deps.repoRoot);
  const codexHookAdapter = checkCodexHookAdapter(deps.repoRoot);
  const codexWrapperParity = checkCodexWrapperParity(deps);
  const l6FrCoverage = checkL6FrCoverage(deps.repoRoot);
  const readability = checkReadability(deps.repoRoot);
  const runtimeReadability = checkRuntimeReadability(deps.repoRoot);
  const feedbackLog = checkFeedbackLog(deps.repoRoot);
  const l6Completion = checkL6Completion(deps.repoRoot);
  const l7Completion = checkL7Completion(deps.repoRoot);
  const roadmap = checkRoadmap(deps.repoRoot);
  const implPlanTrace = checkImplPlanTrace(deps.repoRoot);
  const oracleTestTrace = checkOracleTestTrace(deps.repoRoot);
  const trackedCanonical = checkTrackedCanonical(deps.repoRoot);
  const subDocCatalogDrift = checkSubDocCatalogDrift(deps.repoRoot);
  const subDocSectionStructure = checkSubDocSectionStructure(deps.repoRoot);
  const screenImplPairFreeze = checkScreenImplPairFreeze(deps.repoRoot);
  const verificationGroups = checkVerificationGroupsResult(deps.repoRoot);
  const dependencyDrift = checkDependencyDrift(deps.repoRoot);
  const regressionExpansion = checkRegressionExpansion(deps.repoRoot, dependencyDrift.result);
  const guardrailInvariants = checkGuardrailInvariants(deps.repoRoot);
  const dbProjectionCoverage = checkDbProjectionCoverage(deps.repoRoot);
  const dbProjectionIngestion = checkDbProjectionIngestion(deps.repoRoot, options);
  const docConsistency = checkDocConsistency(deps.repoRoot);
  const entityCoverage = checkEntityCoverage(deps.repoRoot);
  const frRegistryAudit = checkFrRegistryAudit(deps.repoRoot);
  const improvementBacklog = checkImprovementBacklog(deps.repoRoot);
  const rightArmGatePlanning = checkRightArmGatePlanning(deps.repoRoot);
  const g8IntegrationWorkflow = checkG8IntegrationWorkflow(deps.repoRoot);
  const g9SystemWorkflow = checkG9SystemWorkflow(deps.repoRoot);
  const g10UxWorkflow = checkG10UxWorkflow(deps.repoRoot);
  const lintWiring = checkLintWiring(deps.repoRoot);
  const proposalDocumentCoverage = checkProposalDocumentCoverage(deps.repoRoot);
  const frontendDesignCoverage = checkFrontendDesignCoverage(deps.repoRoot);
  const handoverOutstanding = checkHandoverOutstandingAnchor(handoverDeps(deps));
  // hard gate: green_command digest が evidence_path 実 hash と一致するか (fake substance 可視化、PLAN-L7-194)。
  const greenCommandDigestResult = checkGreenCommandDigests(deps.repoRoot);
  const greenCommandDigest = {
    ...greenCommandDigestResult,
    // PLAN-L7-132 intentionally exposes digest mismatches as advisory evidence until
    // a hardening plan can bind each digest update to a same-packet green re-run.
    ok:
      options.strictGreenCommandDigest === true
        ? greenCommandDigestResult.mismatches.length === 0
        : true,
  };
  // fail-close: spine-外 kind=impl の NEW 未集約 landed を gate (PLAN-DISCOVERY-08 Step5)。legacy は grandfather。
  const forwardConvergence = checkForwardConvergence(deps.repoRoot);
  const forwardConvergenceAudit = checkForwardConvergenceAudit(deps.repoRoot);

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

  return checks;
}

export function runDoctor(
  deps: DoctorDeps = nodeDoctorDeps(process.cwd()),
  options: DoctorOptions = {},
): LintResult {
  if (options.setupSmoke === true) return checkSetupSmoke(deps);

  const d = detectMode();
  // handover / agent-slots are warning surfaces. Verification profile is a hard gate.
  const leadingMessages = [
    `doctor: mode=${d.mode} (claude=${d.claude}, codex=${d.codex})`,
    checkHandover(deps),
    ...checkHandoverDisciplineMessages(deps).map((m) => `doctor: handover-discipline — ${m}`),
    checkAgentSlots(doctorSlotsDeps(deps)),
    ...checkPlanReferenceFreshnessAdvisory(deps.repoRoot),
  ];
  const checks = collectDoctorChecks(deps, options);

  return buildDoctorResult({ leadingMessages, checks });
}
