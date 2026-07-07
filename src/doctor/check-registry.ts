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
import {
  type DoctorRunProfileId,
  type DoctorScope,
  doctorOutputIdsForScope,
  resolveDoctorRunProfile,
} from "./profiles";
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

export type {
  DoctorRunProfile,
  DoctorRunProfileAudience,
  DoctorRunProfileId,
  DoctorRunProfileResolutionOptions,
  DoctorScope,
} from "./profiles";
export {
  consumerSafeDoctorRunProfiles,
  DOCTOR_RUN_PROFILE_IDS,
  DOCTOR_RUN_PROFILES,
  doctorOutputIdsForScope,
  doctorRunProfilesForAudience,
  FULL_DOCTOR_OUTPUT_IDS,
  isConsumerSafeDoctorRunProfile,
  resolveDoctorRunProfile,
  TOOLCHAIN_DOCTOR_OUTPUT_IDS,
} from "./profiles";

export interface DoctorOptions {
  strictTelemetryProvenance?: boolean;
  strictGreenCommandDigest?: boolean;
  setupSmoke?: boolean;
  timing?: boolean;
  scope?: DoctorScope;
  profile?: DoctorRunProfileId;
}

export interface DoctorCheckRun {
  checks: LintResult[];
  timings: DoctorTiming[];
}

export interface DoctorCheckDefinition {
  id: string;
  profiles: readonly DoctorScope[];
  requires?: readonly string[];
  run: () => LintResult;
}

export function selectDoctorCheckDefinitions(
  definitions: readonly DoctorCheckDefinition[],
  scope: DoctorScope,
): DoctorCheckDefinition[] {
  const outputIds = new Set(doctorOutputIdsForScope(scope));
  return definitions.filter(
    (definition) => definition.profiles.includes(scope) && outputIds.has(definition.id),
  );
}

export function buildFullDoctorCheckDefinitions(
  deps: DoctorDeps,
  options: DoctorOptions = {},
): DoctorCheckDefinition[] {
  const fullProfile = ["full"] as const;
  const fullAndToolchainProfiles = ["full", "toolchain"] as const;
  let dependencyDriftResult: ReturnType<typeof checkDependencyDrift>["result"] = null;

  return [
    { id: "backfill", profiles: fullProfile, run: () => checkBackfillResult(deps.repoRoot) },
    { id: "scrum-reverse", profiles: fullProfile, run: () => checkScrumReverse(deps.repoRoot) },
    {
      id: "plan-supersession",
      profiles: fullProfile,
      run: () => checkPlanSupersession(deps.repoRoot),
    },
    {
      id: "plan-body-substance",
      profiles: fullProfile,
      run: () => checkPlanBodySubstance(deps.repoRoot),
    },
    {
      id: "plan-completion-drift",
      profiles: fullProfile,
      run: () => checkPlanCompletionDrift(deps.repoRoot),
    },
    { id: "propagation", profiles: fullProfile, run: () => checkPropagation(deps.repoRoot) },
    { id: "review-evidence", profiles: fullProfile, run: () => checkReviewEvidence(deps.repoRoot) },
    { id: "pair-freeze", profiles: fullProfile, run: () => checkPairFreeze(deps.repoRoot) },
    { id: "module-drift", profiles: fullProfile, run: () => checkModuleDrift(deps.repoRoot) },
    {
      id: "merged-plan-status",
      profiles: fullProfile,
      run: () => checkMergedPlanStatus(deps.repoRoot),
    },
    {
      id: "plan-artifact-existence",
      profiles: fullProfile,
      run: () => checkPlanArtifactExistence(deps.repoRoot),
    },
    { id: "asset-drift", profiles: fullProfile, run: () => checkAssetDrift(deps.repoRoot) },
    {
      id: "skill-assignment",
      profiles: fullProfile,
      run: () => checkSkillAssignment(deps.repoRoot),
    },
    {
      id: "descent-obligation",
      profiles: fullProfile,
      run: () => checkDescentObligation(deps.repoRoot),
    },
    { id: "change-impact", profiles: fullProfile, run: () => checkChangeImpact(deps.repoRoot) },
    {
      id: "change-set-integrity",
      profiles: fullProfile,
      run: () => checkChangeSetIntegrity(deps.repoRoot),
    },
    {
      id: "verification-profile",
      profiles: fullProfile,
      run: () => checkVerificationProfile(deps.repoRoot),
    },
    {
      id: "branch-kind-check",
      profiles: fullProfile,
      run: () => checkBranchKind(deps.repoRoot),
    },
    { id: "coding-rules", profiles: fullProfile, run: () => checkCodingRules(deps.repoRoot) },
    {
      id: "design-language",
      profiles: fullProfile,
      run: () => checkDesignLanguage(deps.repoRoot),
    },
    { id: "ddd-tdd-rules", profiles: fullProfile, run: () => checkDddTddRules(deps.repoRoot) },
    {
      id: "runtime-portability",
      profiles: fullProfile,
      run: () => checkRuntimePortability(deps.repoRoot),
    },
    { id: "rule-drift", profiles: fullProfile, run: () => checkRuleDrift(deps.repoRoot) },
    { id: "gate-confirm", profiles: fullProfile, run: () => checkGateConfirm(deps.repoRoot) },
    { id: "plan-schedule", profiles: fullProfile, run: () => checkPlanSchedule(deps.repoRoot) },
    {
      id: "plan-governance",
      profiles: fullProfile,
      run: () => checkPlanGovernance(deps.repoRoot),
    },
    { id: "plan-dod", profiles: fullProfile, run: () => checkPlanDod(deps.repoRoot) },
    {
      id: "placeholder-deps",
      profiles: fullProfile,
      run: () => checkPlaceholderDeps(deps.repoRoot),
    },
    {
      id: "g1-trace",
      profiles: fullProfile,
      run: () => checkPlanTraceGate(deps.repoRoot, "G1-trace"),
    },
    {
      id: "g3-trace",
      profiles: fullProfile,
      run: () => checkPlanTraceGate(deps.repoRoot, "G3-trace"),
    },
    {
      id: "rule-automation-closure",
      profiles: fullProfile,
      run: () => checkRuleAutomationClosure(deps.repoRoot),
    },
    {
      id: "drive-model-passage",
      profiles: fullProfile,
      run: () => checkDriveModelPassage(deps.repoRoot),
    },
    {
      id: "drive-db-registration",
      profiles: fullProfile,
      run: () => checkDriveDbRegistration(deps.repoRoot),
    },
    {
      id: "db-currency",
      profiles: fullProfile,
      run: () => checkDbCurrency(deps.repoRoot),
    },
    {
      id: "fr-roadmap-coverage",
      profiles: fullProfile,
      run: () => checkFrRoadmapCoverage(deps.repoRoot),
    },
    {
      id: "telemetry-closure",
      profiles: fullProfile,
      run: () => checkTelemetryClosure(deps.repoRoot),
    },
    {
      id: "cycle-p4-verification",
      profiles: fullProfile,
      run: () => checkCycleP4Verification(deps.repoRoot),
    },
    {
      id: "l14-close-audit",
      profiles: fullProfile,
      run: () => checkL14CloseAudit(deps.repoRoot),
    },
    { id: "project-hook", profiles: fullProfile, run: () => checkProjectHooks(deps.repoRoot) },
    {
      id: "github-ci-policy",
      profiles: fullProfile,
      run: () => checkGithubCiPolicy(deps.repoRoot),
    },
    {
      id: "codex-hook-adapter",
      profiles: fullProfile,
      run: () => checkCodexHookAdapter(deps.repoRoot),
    },
    {
      id: "codex-wrapper-parity",
      profiles: fullProfile,
      run: () => checkCodexWrapperParity(deps),
    },
    {
      id: "toolchain-pin",
      profiles: fullAndToolchainProfiles,
      run: () => checkToolchainPin(deps.repoRoot),
    },
    { id: "l6-fr-coverage", profiles: fullProfile, run: () => checkL6FrCoverage(deps.repoRoot) },
    { id: "readability", profiles: fullProfile, run: () => checkReadability(deps.repoRoot) },
    {
      id: "runtime-readability",
      profiles: fullProfile,
      run: () => checkRuntimeReadability(deps.repoRoot),
    },
    { id: "feedback-log", profiles: fullProfile, run: () => checkFeedbackLog(deps.repoRoot) },
    { id: "l6-completion", profiles: fullProfile, run: () => checkL6Completion(deps.repoRoot) },
    { id: "l7-completion", profiles: fullProfile, run: () => checkL7Completion(deps.repoRoot) },
    { id: "roadmap", profiles: fullProfile, run: () => checkRoadmap(deps.repoRoot) },
    {
      id: "impl-plan-trace",
      profiles: fullProfile,
      run: () => checkImplPlanTrace(deps.repoRoot),
    },
    {
      id: "oracle-test-trace",
      profiles: fullProfile,
      run: () => checkOracleTestTrace(deps.repoRoot),
    },
    {
      id: "tracked-canonical",
      profiles: fullProfile,
      run: () => checkTrackedCanonical(deps.repoRoot),
    },
    {
      id: "sub-doc-catalog-drift",
      profiles: fullProfile,
      run: () => checkSubDocCatalogDrift(deps.repoRoot),
    },
    {
      id: "sub-doc-section-structure",
      profiles: fullProfile,
      run: () => checkSubDocSectionStructure(deps.repoRoot),
    },
    {
      id: "screen-impl-pair-freeze",
      profiles: fullProfile,
      run: () => checkScreenImplPairFreeze(deps.repoRoot),
    },
    {
      id: "verification-groups",
      profiles: fullProfile,
      run: () => checkVerificationGroupsResult(deps.repoRoot),
    },
    {
      id: "dependency-drift",
      profiles: fullProfile,
      run: () => {
        const result = checkDependencyDrift(deps.repoRoot);
        dependencyDriftResult = result.result;
        return result;
      },
    },
    {
      id: "regression-expansion",
      profiles: fullProfile,
      requires: ["dependency-drift"],
      run: () => checkRegressionExpansion(deps.repoRoot, dependencyDriftResult),
    },
    {
      id: "guardrail-invariants",
      profiles: fullProfile,
      run: () => checkGuardrailInvariants(deps.repoRoot),
    },
    {
      id: "db-projection-coverage",
      profiles: fullProfile,
      run: () => checkDbProjectionCoverage(deps.repoRoot),
    },
    {
      id: "db-projection-ingestion",
      profiles: fullProfile,
      run: () => checkDbProjectionIngestion(deps.repoRoot, options),
    },
    { id: "doc-consistency", profiles: fullProfile, run: () => checkDocConsistency(deps.repoRoot) },
    { id: "entity-coverage", profiles: fullProfile, run: () => checkEntityCoverage(deps.repoRoot) },
    {
      id: "fr-registry-audit",
      profiles: fullProfile,
      run: () => checkFrRegistryAudit(deps.repoRoot),
    },
    {
      id: "improvement-backlog",
      profiles: fullProfile,
      run: () => checkImprovementBacklog(deps.repoRoot),
    },
    {
      id: "right-arm-gate-planning",
      profiles: fullProfile,
      run: () => checkRightArmGatePlanning(deps.repoRoot),
    },
    {
      id: "g8-integration-workflow",
      profiles: fullProfile,
      run: () => checkG8IntegrationWorkflow(deps.repoRoot),
    },
    {
      id: "g9-system-workflow",
      profiles: fullProfile,
      run: () => checkG9SystemWorkflow(deps.repoRoot),
    },
    { id: "g10-ux-workflow", profiles: fullProfile, run: () => checkG10UxWorkflow(deps.repoRoot) },
    { id: "lint-wiring", profiles: fullProfile, run: () => checkLintWiring(deps.repoRoot) },
    {
      id: "proposal-document-coverage",
      profiles: fullProfile,
      run: () => checkProposalDocumentCoverage(deps.repoRoot),
    },
    {
      id: "frontend-design-coverage",
      profiles: fullProfile,
      run: () => checkFrontendDesignCoverage(deps.repoRoot),
    },
    {
      id: "handover-outstanding",
      profiles: fullProfile,
      run: () => checkHandoverOutstandingAnchor(handoverDeps(deps)),
    },
    {
      id: "green-command-digest",
      profiles: fullProfile,
      run: () => {
        const result = checkGreenCommandDigests(deps.repoRoot);
        return {
          ...result,
          ok: options.strictGreenCommandDigest === true ? result.mismatches.length === 0 : true,
        };
      },
    },
    {
      id: "forward-convergence",
      profiles: fullProfile,
      run: () => checkForwardConvergence(deps.repoRoot),
    },
    {
      id: "forward-convergence-audit",
      profiles: fullProfile,
      run: () => checkForwardConvergenceAudit(deps.repoRoot),
    },
  ];
}

export function collectDoctorCheckRun(
  deps: DoctorDeps,
  options: DoctorOptions = {},
): DoctorCheckRun {
  const profile = resolveDoctorRunProfile(options);
  const scope = profile.invocation === "registry" ? profile.scope : (options.scope ?? "full");
  const timings: DoctorTiming[] = [];
  const record = <T extends LintResult>(id: string, run: () => T): T => {
    if (options.timing !== true) return run();
    const started = performance.now();
    const result = run();
    const timing: DoctorTiming = {
      id,
      duration_ms: Number((performance.now() - started).toFixed(3)),
      ok: result.ok,
      message_count: result.messages.length,
    };
    const substeps = (result as { timingSubsteps?: DoctorTiming["substeps"] }).timingSubsteps;
    if (substeps && substeps.length > 0) timing.substeps = substeps;
    timings.push(timing);
    return result;
  };

  const resultsById = new Map<string, LintResult>();
  for (const definition of selectDoctorCheckDefinitions(
    buildFullDoctorCheckDefinitions(deps, options),
    scope,
  )) {
    resultsById.set(definition.id, record(definition.id, definition.run));
  }
  const checks = doctorOutputIdsForScope(scope).map((id) => {
    const result = resultsById.get(id);
    if (!result) {
      return {
        ok: false,
        messages: [`doctor registry - violation: missing full doctor check result (${id})`],
      };
    }
    return result;
  });

  return { checks, timings };
}

export function collectDoctorChecks(deps: DoctorDeps, options: DoctorOptions = {}): LintResult[] {
  return collectDoctorCheckRun(deps, options).checks;
}
