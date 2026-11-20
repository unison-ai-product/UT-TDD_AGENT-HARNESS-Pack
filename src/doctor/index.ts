/**
 * 統合検証 doctor (requirements_v1.2 §7 / §7.8.5)。
 * 多数の検出器 (back-fill / review-evidence / asset-drift / cycle-p4-verification / roadmap 等) を集約し、
 * gate 判定群を runDoctor.ok に連動させて fail-close する。handover / agent-slots は warning surface。
 */

import { detectMode } from "../runtime/detect.ts";
import {
  collectDoctorCheckRun,
  type DoctorOptions,
  resolveDoctorRunProfile,
} from "./check-registry.ts";
import type { DoctorRunProfile } from "./profiles.ts";
import { buildDoctorResult, type DoctorResult } from "./result.ts";
import {
  checkAgentSlots,
  checkHandover,
  checkHandoverDisciplineMessages,
  type DoctorDeps,
  doctorSlotsDeps,
  nodeDoctorDeps,
} from "./runtime-state.ts";
import { checkSetupSmoke } from "./setup-smoke.ts";
import { checkWorktreeTopologyAdvisory } from "./worktree-topology-advisory.ts";

export { checkErasableSyntax } from "../lint/erasable-syntax.ts";
export { checkImportSpecifiers } from "../lint/import-specifier.ts";
export type { DoctorOptions } from "./check-registry.ts";
export { checkClaudeVersionFloor } from "./claude-version-floor-check.ts";
export {
  checkAgentContractDetection,
  checkDbProjectionCoverage,
  checkDbProjectionIngestion,
  checkDesignDetection,
  checkDesignDocCrossIntegrity,
  checkTypedSpecLedgerBodySync,
  checkTypedSpecOwnedArtifactDispersal,
  checkTypedSpecPhaseLayerAlignment,
  checkTypedSpecTraceClosure,
} from "./db-projection.ts";
export { checkDependencyDrift, checkRegressionExpansion } from "./dependency-regression.ts";
export { checkDocConsistency, checkEntityCoverage, checkFrRegistryAudit } from "./doc-registry.ts";
export {
  checkAssetDrift,
  checkBranchKind,
  checkChangeImpact,
  checkChangeSetIntegrity,
  checkDescentObligation,
  checkModuleDrift,
  checkSkillAssignment,
  checkVerificationProfile,
} from "./lint-gates.ts";
export {
  checkPairFreeze,
  checkPropagation,
} from "./plan-governance.ts";
export {
  checkCycleP4Verification,
  checkDbCurrency,
  checkDriveModelPassage,
  checkFeedbackLog,
  checkFrRoadmapCoverage,
  checkGateRunCoverage,
  checkL6Completion,
  checkL6FrCoverage,
  checkL7Completion,
  checkL14CloseAudit,
  checkPlaceholderDeps,
  checkRuleAutomationClosure,
  checkScreenImplPairFreeze,
  checkSubDocCatalogDrift,
  checkSubDocSectionStructure,
  checkTelemetryClosure,
  checkTraceGate,
} from "./process-quality.ts";
export {
  checkRoadmap,
  checkVerificationGroups,
  checkVerificationGroupsResult,
} from "./roadmap-verification.ts";
export {
  checkCodingRules,
  checkDddTddRules,
  checkDesignLanguage,
  checkGateConfirm,
  checkGateIdFormat,
  checkModelIdDocDrift,
  checkReadability,
  checkRuleDrift,
  checkRuntimePortability,
  checkRuntimeReadability,
  checkSecretScan,
} from "./rule-quality.ts";
export {
  checkAgentSlots,
  checkHandover,
  checkHandoverDisciplineMessages,
  type DoctorDeps,
  nodeDoctorDeps,
} from "./runtime-state.ts";
export {
  checkRuntimeStateLocation,
  findRuntimeStateLocationFindings,
} from "./runtime-state-location.ts";
export {
  checkCodexHookAdapter,
  checkCodexWrapperParity,
  checkGithubCiPolicy,
  checkProjectHooks,
} from "./runtime-surface.ts";
export {
  checkImplPlanTrace,
  checkOracleTestTrace,
  checkTrackedCanonical,
} from "./source-trace.ts";
export { checkTestRepositoryIsolation } from "./test-repository-isolation.ts";
export { checkToolchainPin } from "./toolchain.ts";
export {
  checkFrontendDesignCoverage,
  checkG8IntegrationWorkflow,
  checkG9SystemWorkflow,
  checkG10UxWorkflow,
  checkImprovementBacklog,
  checkLintWiring,
  checkProposalDocumentCoverage,
  checkRightLungDocGovernance,
} from "./workflow-quality.ts";
export {
  checkWorktreeTopologyAdvisory,
  worktreeTopologyAdvisoryMessages,
} from "./worktree-topology-advisory.ts";

export interface DoctorMeasurement {
  result: DoctorResult;
  checkIds: string[];
  profile: DoctorRunProfile;
}

export function runDoctorMeasured(
  deps: DoctorDeps = nodeDoctorDeps(process.cwd()),
  options: DoctorOptions = {},
): DoctorMeasurement {
  const profile = resolveDoctorRunProfile(options);
  if (profile.invocation === "setup-smoke") {
    return { result: checkSetupSmoke(deps), checkIds: ["setup-smoke"], profile };
  }

  const d = detectMode();
  // handover / agent-slots are warning surfaces. Verification profile is a hard gate.
  const leadingMessages = [
    `doctor: mode=${d.mode} (claude=${d.claude}, codex=${d.codex})`,
    checkHandover(deps),
    ...checkHandoverDisciplineMessages(deps).map((m) => `doctor: handover-discipline — ${m}`),
    checkAgentSlots(doctorSlotsDeps(deps)),
    ...checkWorktreeTopologyAdvisory(
      typeof deps.worktreeTopology === "function"
        ? deps.worktreeTopology()
        : (deps.worktreeTopology ?? { facts: [], adminEntries: [] }),
    ).messages.map((m) => `doctor: ${m}`),
  ];
  const { checks, checkIds, timings } = collectDoctorCheckRun(deps, options);

  return {
    result: buildDoctorResult({
      leadingMessages,
      checks,
      timings: options.timing === true ? timings : undefined,
    }),
    checkIds,
    profile,
  };
}

export function runDoctor(
  deps: DoctorDeps = nodeDoctorDeps(process.cwd()),
  options: DoctorOptions = {},
): DoctorResult {
  return runDoctorMeasured(deps, options).result;
}
