/**
 * 統合検証 doctor (requirements_v1.2 §7 / §7.8.5)。
 * 多数の検出器 (back-fill / review-evidence / asset-drift / cycle-p4-verification / roadmap 等) を集約し、
 * gate 判定群を runDoctor.ok に連動させて fail-close する。handover / agent-slots は warning surface。
 */

import { detectMode } from "../runtime/detect";
import {
  collectDoctorCheckRun,
  type DoctorOptions,
  resolveDoctorRunProfile,
} from "./check-registry";
import { checkPlanReferenceFreshnessAdvisory } from "./plan-governance";
import { buildDoctorResult, type DoctorResult } from "./result";
import {
  checkAgentSlots,
  checkHandover,
  checkHandoverDisciplineMessages,
  type DoctorDeps,
  doctorSlotsDeps,
  nodeDoctorDeps,
} from "./runtime-state";
import { checkSetupSmoke } from "./setup-smoke";

export type { DoctorOptions } from "./check-registry";
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
  checkDbCurrency,
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
  checkImplPlanTrace,
  checkMergedPlanStatus,
  checkOracleTestTrace,
  checkPlanArtifactExistence,
  checkTrackedCanonical,
} from "./source-trace";
export { checkToolchainPin } from "./toolchain";
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

export function runDoctor(
  deps: DoctorDeps = nodeDoctorDeps(process.cwd()),
  options: DoctorOptions = {},
): DoctorResult {
  const profile = resolveDoctorRunProfile(options);
  if (profile.invocation === "setup-smoke") return checkSetupSmoke(deps);

  const d = detectMode();
  // handover / agent-slots are warning surfaces. Verification profile is a hard gate.
  const leadingMessages = [
    `doctor: mode=${d.mode} (claude=${d.claude}, codex=${d.codex})`,
    checkHandover(deps),
    ...checkHandoverDisciplineMessages(deps).map((m) => `doctor: handover-discipline — ${m}`),
    checkAgentSlots(doctorSlotsDeps(deps)),
    ...checkPlanReferenceFreshnessAdvisory(deps.repoRoot),
  ];
  const { checks, timings } = collectDoctorCheckRun(deps, options);

  return buildDoctorResult({
    leadingMessages,
    checks,
    timings: options.timing === true ? timings : undefined,
  });
}
