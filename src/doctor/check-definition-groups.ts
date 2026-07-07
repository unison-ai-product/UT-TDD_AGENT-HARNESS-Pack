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
import type { DoctorCheckDefinition, DoctorOptions } from "./runner";
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

const fullProfile = ["full"] as const;
const fullAndToolchainProfiles = ["full", "toolchain"] as const;

export interface DoctorCheckDefinitionGroup {
  id: string;
  definitions: DoctorCheckDefinition[];
}

interface DoctorCheckDefinitionGroupState {
  dependencyDriftResult: ReturnType<typeof checkDependencyDrift>["result"] | null;
}

function full(
  id: string,
  run: () => LintResult,
  requires?: readonly string[],
): DoctorCheckDefinition {
  return { id, profiles: fullProfile, ...(requires ? { requires } : {}), run };
}

function fullAndToolchain(id: string, run: () => LintResult): DoctorCheckDefinition {
  return { id, profiles: fullAndToolchainProfiles, run };
}

export function buildDoctorCheckDefinitionGroups(
  deps: DoctorDeps,
  options: DoctorOptions = {},
): DoctorCheckDefinitionGroup[] {
  const state: DoctorCheckDefinitionGroupState = { dependencyDriftResult: null };

  return [
    {
      id: "plan-governance",
      definitions: [
        full("backfill", () => checkBackfillResult(deps.repoRoot)),
        full("scrum-reverse", () => checkScrumReverse(deps.repoRoot)),
        full("plan-supersession", () => checkPlanSupersession(deps.repoRoot)),
        full("plan-body-substance", () => checkPlanBodySubstance(deps.repoRoot)),
        full("plan-completion-drift", () => checkPlanCompletionDrift(deps.repoRoot)),
        full("propagation", () => checkPropagation(deps.repoRoot)),
        full("review-evidence", () => checkReviewEvidence(deps.repoRoot)),
        full("pair-freeze", () => checkPairFreeze(deps.repoRoot)),
        full("module-drift", () => checkModuleDrift(deps.repoRoot)),
        full("merged-plan-status", () => checkMergedPlanStatus(deps.repoRoot)),
        full("plan-artifact-existence", () => checkPlanArtifactExistence(deps.repoRoot)),
        full("asset-drift", () => checkAssetDrift(deps.repoRoot)),
        full("skill-assignment", () => checkSkillAssignment(deps.repoRoot)),
        full("descent-obligation", () => checkDescentObligation(deps.repoRoot)),
        full("change-impact", () => checkChangeImpact(deps.repoRoot)),
        full("change-set-integrity", () => checkChangeSetIntegrity(deps.repoRoot)),
        full("verification-profile", () => checkVerificationProfile(deps.repoRoot)),
        full("branch-kind-check", () => checkBranchKind(deps.repoRoot)),
      ],
    },
    {
      id: "rules-and-process",
      definitions: [
        full("coding-rules", () => checkCodingRules(deps.repoRoot)),
        full("design-language", () => checkDesignLanguage(deps.repoRoot)),
        full("ddd-tdd-rules", () => checkDddTddRules(deps.repoRoot)),
        full("runtime-portability", () => checkRuntimePortability(deps.repoRoot)),
        full("rule-drift", () => checkRuleDrift(deps.repoRoot)),
        full("gate-confirm", () => checkGateConfirm(deps.repoRoot)),
        full("plan-schedule", () => checkPlanSchedule(deps.repoRoot)),
        full("plan-governance", () => checkPlanGovernance(deps.repoRoot)),
        full("plan-dod", () => checkPlanDod(deps.repoRoot)),
        full("placeholder-deps", () => checkPlaceholderDeps(deps.repoRoot)),
        full("g1-trace", () => checkPlanTraceGate(deps.repoRoot, "G1-trace")),
        full("g3-trace", () => checkPlanTraceGate(deps.repoRoot, "G3-trace")),
        full("rule-automation-closure", () => checkRuleAutomationClosure(deps.repoRoot)),
        full("drive-model-passage", () => checkDriveModelPassage(deps.repoRoot)),
        full("drive-db-registration", () => checkDriveDbRegistration(deps.repoRoot)),
        full("db-currency", () => checkDbCurrency(deps.repoRoot)),
        full("fr-roadmap-coverage", () => checkFrRoadmapCoverage(deps.repoRoot)),
        full("telemetry-closure", () => checkTelemetryClosure(deps.repoRoot)),
        full("cycle-p4-verification", () => checkCycleP4Verification(deps.repoRoot)),
        full("l14-close-audit", () => checkL14CloseAudit(deps.repoRoot)),
      ],
    },
    {
      id: "runtime-surface",
      definitions: [
        full("project-hook", () => checkProjectHooks(deps.repoRoot)),
        full("github-ci-policy", () => checkGithubCiPolicy(deps.repoRoot)),
        full("codex-hook-adapter", () => checkCodexHookAdapter(deps.repoRoot)),
        full("codex-wrapper-parity", () => checkCodexWrapperParity(deps)),
        fullAndToolchain("toolchain-pin", () => checkToolchainPin(deps.repoRoot)),
      ],
    },
    {
      id: "completion-and-readability",
      definitions: [
        full("l6-fr-coverage", () => checkL6FrCoverage(deps.repoRoot)),
        full("readability", () => checkReadability(deps.repoRoot)),
        full("runtime-readability", () => checkRuntimeReadability(deps.repoRoot)),
        full("feedback-log", () => checkFeedbackLog(deps.repoRoot)),
        full("l6-completion", () => checkL6Completion(deps.repoRoot)),
        full("l7-completion", () => checkL7Completion(deps.repoRoot)),
        full("roadmap", () => checkRoadmap(deps.repoRoot)),
      ],
    },
    {
      id: "source-trace",
      definitions: [
        full("impl-plan-trace", () => checkImplPlanTrace(deps.repoRoot)),
        full("oracle-test-trace", () => checkOracleTestTrace(deps.repoRoot)),
        full("tracked-canonical", () => checkTrackedCanonical(deps.repoRoot)),
        full("sub-doc-catalog-drift", () => checkSubDocCatalogDrift(deps.repoRoot)),
        full("sub-doc-section-structure", () => checkSubDocSectionStructure(deps.repoRoot)),
        full("screen-impl-pair-freeze", () => checkScreenImplPairFreeze(deps.repoRoot)),
        full("verification-groups", () => checkVerificationGroupsResult(deps.repoRoot)),
      ],
    },
    {
      id: "dependency-and-db",
      definitions: [
        full("dependency-drift", () => {
          const result = checkDependencyDrift(deps.repoRoot);
          state.dependencyDriftResult = result.result;
          return result;
        }),
        full(
          "regression-expansion",
          () => checkRegressionExpansion(deps.repoRoot, state.dependencyDriftResult),
          ["dependency-drift"],
        ),
        full("guardrail-invariants", () => checkGuardrailInvariants(deps.repoRoot)),
        full("db-projection-coverage", () => checkDbProjectionCoverage(deps.repoRoot)),
        full("db-projection-ingestion", () => checkDbProjectionIngestion(deps.repoRoot, options)),
        full("doc-consistency", () => checkDocConsistency(deps.repoRoot)),
        full("entity-coverage", () => checkEntityCoverage(deps.repoRoot)),
        full("fr-registry-audit", () => checkFrRegistryAudit(deps.repoRoot)),
      ],
    },
    {
      id: "workflow-and-final",
      definitions: [
        full("improvement-backlog", () => checkImprovementBacklog(deps.repoRoot)),
        full("right-arm-gate-planning", () => checkRightArmGatePlanning(deps.repoRoot)),
        full("g8-integration-workflow", () => checkG8IntegrationWorkflow(deps.repoRoot)),
        full("g9-system-workflow", () => checkG9SystemWorkflow(deps.repoRoot)),
        full("g10-ux-workflow", () => checkG10UxWorkflow(deps.repoRoot)),
        full("lint-wiring", () => checkLintWiring(deps.repoRoot)),
        full("proposal-document-coverage", () => checkProposalDocumentCoverage(deps.repoRoot)),
        full("frontend-design-coverage", () => checkFrontendDesignCoverage(deps.repoRoot)),
        full("handover-outstanding", () => checkHandoverOutstandingAnchor(handoverDeps(deps))),
        full("green-command-digest", () => {
          const result = checkGreenCommandDigests(deps.repoRoot);
          return {
            ...result,
            ok: options.strictGreenCommandDigest === true ? result.mismatches.length === 0 : true,
          };
        }),
        full("forward-convergence", () => checkForwardConvergence(deps.repoRoot)),
        full("forward-convergence-audit", () => checkForwardConvergenceAudit(deps.repoRoot)),
      ],
    },
  ];
}
