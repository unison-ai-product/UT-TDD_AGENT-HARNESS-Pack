/**
 * 統合検証 doctor (requirements_v1.2 §7 / §7.8.5)。
 * 多数の検出器 (back-fill / review-evidence / asset-drift / cycle-p4-verification / roadmap 等) を集約し、
 * gate 判定群を runDoctor.ok に連動させて fail-close する。handover / agent-slots は warning surface。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkHandoverBypass,
  checkHandoverCompletionWording,
  checkHandoverDiscipline,
  checkHandoverOutstandingAnchor,
  type HandoverDeps,
  type HandoverPointer,
  handoverStale,
} from "../handover/index";
import { analyzeAssetDrift, assetDriftMessages, loadAssetDriftInput } from "../lint/asset-drift";
import { analyzeBranchKind, branchKindMessages, loadBranchKindInput } from "../lint/branch-kind";
import {
  analyzeChangeImpact,
  analyzeChangeSetIntegrity,
  changeImpactMessages,
  changeSetIntegrityMessages,
  isGitRepository,
  loadChangedFiles,
} from "../lint/change-impact";
import {
  analyzeCodingRules,
  codingRulesMessages,
  loadCodingRuleDocs,
  loadCodingRulePolicy,
  loadCodingWorkflowDocs,
} from "../lint/coding-rules";
import {
  analyzeCycleP4Verification,
  cycleP4VerificationMessages,
  loadCycleP4VerificationDocs,
} from "../lint/cycle-p4-verification";
import { analyzeDddTddRules, dddTddRulesMessages, loadDddTddInputs } from "../lint/ddd-tdd-rules";
import {
  analyzeDependencyDrift,
  type DependencyDriftResult,
  dependencyDriftMessages,
  expandRegressionScope,
  loadDependencyDriftInput,
  regressionExpansionMessages,
} from "../lint/dependency-drift";
import {
  analyzeDescentObligations,
  descentObligationMessages,
  filterSubstanceVerifiedAdvisories,
  loadDeferLedger,
  loadDescentAdjacency,
  loadFrUnitCoverageOracles,
  loadTraceKeyedArtifacts,
} from "../lint/descent-obligation";
import {
  analyzeDesignLanguage,
  designLanguageMessages,
  loadDesignLanguageDocs,
} from "../lint/design-language";
import { analyzeDocConsistency, loadDocConsistencyDocs } from "../lint/doc-consistency";
import {
  analyzeDriveDbRegistration,
  driveDbRegistrationMessages,
} from "../lint/drive-db-registration";
import {
  analyzeDriveModelPassage,
  driveModelPassageMessages,
  loadDriveModelPassageDocs,
} from "../lint/drive-model-passage";
import { analyzeEntityCoverage, loadBusiness as loadEntityBusiness } from "../lint/entity-coverage";
import {
  analyzeFeedbackLog,
  feedbackLogMessages,
  loadFeedbackLogInput,
} from "../lint/feedback-log";
import {
  analyzeForwardConvergence,
  forwardConvergenceMessages,
  legacyAuditDriftMessages,
  loadConvergenceDocs,
  loadLegacyAuditDrift,
} from "../lint/forward-convergence";
import { analyzeFrRegistry, loadFrDocs as loadFrRegistryDocs } from "../lint/fr-registry-audit";
import {
  analyzeFrRoadmapCoverageWithRoot,
  frRoadmapCoverageMessages,
  loadFrRoadmapCoverageDocs,
} from "../lint/fr-roadmap-coverage";
import {
  analyzeFrontendDesignCoverage,
  frontendDesignCoverageMessages,
  loadFrontendDesignCoverageInput,
} from "../lint/frontend-design-coverage";
import {
  analyzeG8IntegrationWorkflow,
  canLoadG8IntegrationWorkflowInput,
  g8IntegrationWorkflowMessages,
  loadG8IntegrationWorkflowInput,
} from "../lint/g8-integration-workflow";
import {
  analyzeG9SystemWorkflow,
  canLoadG9SystemWorkflowInput,
  g9SystemWorkflowMessages,
  loadG9SystemWorkflowInput,
} from "../lint/g9-system-workflow";
import {
  analyzeG10UxWorkflow,
  canLoadG10UxWorkflowInput,
  g10UxWorkflowMessages,
  loadG10UxWorkflowInput,
} from "../lint/g10-ux-workflow";
import { analyzeGateConfirm, gateConfirmMessages, loadGateConfirmDocs } from "../lint/gate-confirm";
import { checkGreenCommandDigests } from "../lint/green-command-digest";
import {
  analyzeImplPlanTrace,
  implPlanTraceMessages,
  loadImplPlanTraceInput,
} from "../lint/impl-plan-trace";
import {
  analyzeImprovementBacklog,
  loadBacklog as loadImprovementBacklog,
} from "../lint/improvement-backlog";
import {
  analyzeL6Completion,
  canLoadL6CompletionInputs,
  l6CompletionMessages,
  loadL6CompletionInputs,
} from "../lint/l6-completion";
import {
  analyzeL6FrCoverage,
  l6FrCoverageMessages,
  loadL6FrCoverageDocs,
} from "../lint/l6-fr-coverage";
import {
  analyzeL7Completion,
  l7CompletionMessages,
  loadL7CompletionDocs,
} from "../lint/l7-completion";
import {
  analyzeL14CloseAudit,
  l14CloseAuditMessages,
  loadL14CloseAuditDocs,
} from "../lint/l14-close-audit";
import { analyzeLintWiring, lintWiringMessages, loadLintWiringInput } from "../lint/lint-wiring";
import {
  analyzeMergedPlanStatus,
  loadMergedPlanStatusInput,
  mergedPlanStatusMessages,
} from "../lint/merged-plan-status";
import { analyzeModuleDrift, loadModuleDocs, moduleDriftMessages } from "../lint/module-drift";
import {
  analyzeOracleTestTrace,
  loadOracleTestTraceInput,
  oracleTestTraceMessages,
} from "../lint/oracle-test-trace";
import {
  analyzePlaceholderDeps,
  loadPlaceholderDepsDocs,
  placeholderDepsMessages,
} from "../lint/placeholder-deps";
import {
  analyzePlanArtifactExistence,
  loadPlanArtifactExistenceInput,
  planArtifactExistenceMessages,
} from "../lint/plan-artifact-existence";
import { analyzePlanDod, loadPlanDodDocs, planDodMessages } from "../lint/plan-dod";
import {
  analyzeProposalDocumentCoverage,
  loadProposalDocumentCoverageLintInput,
  proposalDocumentCoverageMessages,
} from "../lint/proposal-document-coverage";
import {
  analyzeReadability,
  loadRuntimeArtifactReadabilityDocs,
  loadSystemReadabilityDocs,
  readabilityMessages,
  runtimeReadabilityMessages,
} from "../lint/readability";
import {
  analyzeRightArmGatePlanning,
  loadRightArmGatePlanningInput,
  rightArmGatePlanningMessages,
} from "../lint/right-arm-gate-planning";
import {
  analyzeProgramCoverage,
  checkSpanExistence,
  computeGateProgress,
  computeProgramRollup,
  loadRoadmaps,
  PARKED_BANDS,
  programCoverageMessages,
} from "../lint/roadmap-registry";
import {
  analyzeRuleAutomationClosure,
  loadRuleAutomationClosureDocs,
  ruleAutomationClosureMessages,
} from "../lint/rule-automation-closure";
import { analyzeRuleDrift, loadRuleAdapterDocs, ruleDriftMessages } from "../lint/rule-drift";
import {
  analyzeRuntimePortability,
  loadRuntimePortabilityDocs,
  runtimePortabilityMessages,
} from "../lint/runtime-portability";
import {
  analyzeScreenImplPairFreeze,
  loadScreenImplPairFreezeInput,
  screenImplPairFreezeMessages,
} from "../lint/screen-impl-pair-freeze";
import { fmValue } from "../lint/shared";
import {
  analyzeSkillAssignments,
  loadSkillAssignmentDocs,
  skillAssignmentMessages,
} from "../lint/skill-assignment";
import {
  analyzeSubDocCatalogDrift,
  loadSubDocCatalogDriftInput,
  subDocCatalogDriftMessages,
} from "../lint/sub-doc-catalog-drift";
import {
  analyzeSubDocSectionStructure,
  loadSubDocSectionStructureInput,
  subDocSectionStructureMessages,
} from "../lint/sub-doc-section-structure";
import {
  analyzeTelemetryClosure,
  loadTelemetryClosureDocs,
  telemetryClosureMessages,
} from "../lint/telemetry-closure";
import {
  analyzeTrackedCanonical,
  loadTrackedCanonicalInput,
  trackedCanonicalMessages,
} from "../lint/tracked-canonical";
import {
  analyzeVerificationProfileGate,
  loadVerificationRecommendation,
  verificationProfileGateMessages,
} from "../lint/verification-profile";
import type { LintResult } from "../plan/lint";
import { lintPlan, lintPlanWithGate } from "../plan/lint";
import { SUBAGENT_ALLOWLIST } from "../runtime/agent-guard";
import {
  type AgentSlotsDeps,
  DEFAULT_STALE_MINUTES,
  listActiveSlots,
  listStaleSlots,
  loadSlots,
  peakParallel,
} from "../runtime/agent-slots";
import { detectMode } from "../runtime/detect";
import { loadOrBuildDriveDbRegistrationStats } from "../state-db/drive-registration";
import { classifyProposalDocumentCoverage } from "../task/classify";
import {
  analyzePairFreeze,
  analyzeVerificationGroups,
  loadPairDocs,
  loadVerificationPlanEvidence,
  verificationGroupMessages,
  verificationGroupsOk,
} from "../vmodel/lint";
import { checkDbProjectionCoverage, checkDbProjectionIngestion } from "./db-projection";
import {
  checkBackfillResult,
  checkGuardrailInvariants,
  checkPairFreeze,
  checkPlanBodySubstance,
  checkPlanCompletionDrift,
  checkPlanSupersession,
  checkPropagation,
  checkReviewEvidence,
  checkScrumReverse,
} from "./plan-governance";
import {
  checkCodexHookAdapter,
  checkCodexWrapperParity,
  checkGithubCiPolicy,
  checkProjectHooks,
} from "./runtime-surface";

export { checkDbProjectionCoverage, checkDbProjectionIngestion } from "./db-projection";
export {
  checkBackfill,
  checkBackfillResult,
  checkGuardrailInvariants,
  checkPairFreeze,
  checkPlanBodySubstance,
  checkPlanCompletionDrift,
  checkPlanSupersession,
  checkPropagation,
  checkReviewEvidence,
  checkScrumReverse,
} from "./plan-governance";
export {
  checkCodexHookAdapter,
  checkCodexWrapperParity,
  checkGithubCiPolicy,
  checkProjectHooks,
} from "./runtime-surface";

import { checkSetupSmoke } from "./setup-smoke";

/** I/O・clock 注入 (test 可能、handover staleness 検査用)。 */
export interface DoctorDeps {
  repoRoot: string;
  now: string;
  readText: (path: string) => string | null;
  listDir: (dir: string) => string[];
}

export interface DoctorOptions {
  strictTelemetryProvenance?: boolean;
  strictGreenCommandDigest?: boolean;
  setupSmoke?: boolean;
}

function handoverDeps(deps: DoctorDeps): HandoverDeps {
  return {
    repoRoot: deps.repoRoot,
    now: () => deps.now,
    readText: deps.readText,
    listDir: deps.listDir,
    writeText: () => {
      throw new Error("doctor is read-only and must not write handover state");
    },
  };
}

export function checkHandoverDisciplineMessages(deps: DoctorDeps): string[] {
  const hd = handoverDeps(deps);
  return [
    ...checkHandoverDiscipline(hd),
    ...checkHandoverBypass(hd),
    ...checkHandoverCompletionWording(hd),
  ];
}

/**
 * handover 機械ポインタ (CURRENT.json) の鮮度を surface (§5.3 / §6.8.5、warning レベル)。
 * 不在・stale・壊れは message で示すのみ (doctor.ok は落とさない = §5.3 exit 0 warning)。
 */
export function checkHandover(deps: DoctorDeps): string {
  const raw = deps.readText(join(deps.repoRoot, ".ut-tdd", "handover", "CURRENT.json"));
  if (!raw) return "doctor: handover — CURRENT.json なし (ut-tdd handover で生成、§6.8.5)";
  let p: HandoverPointer;
  try {
    p = JSON.parse(raw) as HandoverPointer;
  } catch {
    return "doctor: handover — ⚠ CURRENT.json が壊れています (ut-tdd handover で再生成)";
  }
  return handoverStale(p.updated_at, deps.now)
    ? `doctor: handover — ⚠ stale (updated_at=${p.updated_at}、24h 超。ut-tdd handover で更新)`
    : `doctor: handover — OK (active=${p.active_plan ?? "-"}, updated_at=${p.updated_at})`;
}

/**
 * agent-slots (Layer-2 オーケストレーション) の stale slot / peak 並列を surface (IMP-050、warning レベル)。
 * stale (5 分超 released なし) があれば warn、無ければ active/peak を表示 (doctor.ok は落とさない)。
 */
export function checkAgentSlots(deps: AgentSlotsDeps): string {
  const all = loadSlots(deps);
  if (all.length === 0) return "doctor: agent-slots — 記録なし";
  const stale = listStaleSlots(deps, DEFAULT_STALE_MINUTES);
  const active = listActiveSlots(deps).length;
  const peak = peakParallel(all);
  if (stale.length > 0) {
    const ids = stale.map((s) => s.slot_id).join(", ");
    return `doctor: agent-slots — ⚠ stale ${stale.length} 件 (${DEFAULT_STALE_MINUTES}分超 release なし: ${ids}。release 漏れを確認)`;
  }
  return `doctor: agent-slots — OK (active=${active}, peak_parallel=${peak})`;
}

/**
 * 駆動モデルの back-fill 完全性 (impl⇔Reverse / impl⇔glossary) を検査 (IMP-051、hard)。
 * Reverse 無き impl / §6 用語の glossary 未 merge を violation にして doctor.ok に連動する。
 */
/**
 * architecture §3.1 設計 module 集合 ⊇ src/ 実在 module を検査 (IMP-075、hard)。
 * 実在するが設計 doc 未列挙 (= impl→design back-fill 漏れ) を violation にして doctor.ok に連動する。
 */
/**
 * merged-plan-status hard gate (PO 指摘 2026-06-15): generated src が merge 済みなのに owning PLAN が
 * draft / 未 confirm のまま放置される V-model state 不整合を fail-close 検出する。review-evidence gate が
 * confirmed PLAN にのみ証跡を要求し draft を素通りさせる absence-blindness を補完する (柱3 = state DB が
 * フィードバック機構)。
 */
export function checkMergedPlanStatus(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["merged-plan-status - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeMergedPlanStatus(loadMergedPlanStatusInput(repoRoot));
    return { messages: mergedPlanStatusMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["merged-plan-status - violation: PLAN generates could not be read"],
      ok: false,
    };
  }
}

/**
 * plan-artifact-existence hard gate (PO /goal 2026-06-15): PLAN が confirmed/completed/accepted (完了宣言)
 * なのに generates artifact が不在 (phantom / false-completion) を fail-close 検出する。merged-plan-status
 * の鏡像で、PLAN↕artifact 実在マトリクスを 2 gate で完結させる。impl-plan-trace (src→PLAN) も
 * review-evidence (証跡有無) も artifact 実在を見ない absence-blindness を塞ぐ (柱3 / 柱6)。
 */
export function checkPlanArtifactExistence(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["plan-artifact-existence - violation: repo root could not be read"],
      ok: false,
    };
  }
  try {
    const r = analyzePlanArtifactExistence(loadPlanArtifactExistenceInput(repoRoot));
    return { messages: planArtifactExistenceMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["plan-artifact-existence - violation: PLAN generates could not be read"],
      ok: false,
    };
  }
}

export function checkModuleDrift(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["module-drift - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeModuleDrift(loadModuleDocs(repoRoot));
    return { messages: moduleDriftMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["module-drift - violation: architecture/src modules could not be read"],
      ok: false,
    };
  }
}

export function checkAssetDrift(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["asset-drift - violation: repo root could not be read"], ok: false };
  }
  try {
    const input = loadAssetDriftInput(repoRoot);
    input.allowlist = [...SUBAGENT_ALLOWLIST].sort();
    const r = analyzeAssetDrift(input);
    return { messages: assetDriftMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["asset-drift — violation: internal asset drift lint could not run"],
      ok: false,
    };
  }
}

export function checkSkillAssignment(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["skill-assignment - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeSkillAssignments(loadSkillAssignmentDocs(repoRoot));
    return { messages: skillAssignmentMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["skill-assignment - violation: skill assignment metadata could not be read"],
      ok: false,
    };
  }
}

export function checkDescentObligation(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["descent-obligation - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = filterSubstanceVerifiedAdvisories(
      analyzeDescentObligations(
        loadTraceKeyedArtifacts(repoRoot),
        loadDescentAdjacency(repoRoot),
        loadDeferLedger(repoRoot),
      ),
      loadFrUnitCoverageOracles(repoRoot),
    );
    return { messages: descentObligationMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["descent-obligation - violation: descent obligation ledger could not be read"],
      ok: false,
    };
  }
}

export function checkChangeImpact(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["change-impact - violation: repo root could not be read"], ok: false };
  }
  // 非 git (ZIP 展開のみ) では change-impact は適用不能 → skip (ok)。git は在るが status が
  // 壊れる実エラーは下の catch で fail-close を維持する。CI は常に git repo なので影響なし。
  if (!isGitRepository(repoRoot)) {
    return { messages: ["change-impact — skipped (not a git repository)"], ok: true };
  }
  try {
    const r = analyzeChangeImpact({ changedFiles: loadChangedFiles(repoRoot) });
    return { messages: changeImpactMessages(r), ok: r.ok };
  } catch {
    return { messages: ["change-impact - violation: git status could not be read"], ok: false };
  }
}

export function checkChangeSetIntegrity(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["change-set-integrity - violation: repo root could not be read"],
      ok: false,
    };
  }
  // 非 git では変更集合を確定できない → skip (change-impact と同じ非 git fail-open 方針)。
  if (!isGitRepository(repoRoot)) {
    return { messages: ["change-set-integrity — skipped (not a git repository)"], ok: true };
  }
  try {
    const dependencyDrift = analyzeDependencyDrift(loadDependencyDriftInput(repoRoot));
    const result = analyzeChangeSetIntegrity({
      changedFiles: loadChangedFiles(repoRoot),
      dependencyDrift,
    });
    return { messages: changeSetIntegrityMessages(result), ok: result.ok };
  } catch {
    return {
      messages: ["change-set-integrity - violation: change/dependency graph could not be read"],
      ok: false,
    };
  }
}

function loadChangedFilesForDoctor(repoRoot: string): string[] {
  try {
    return loadChangedFiles(repoRoot);
  } catch {
    return [];
  }
}

export function checkVerificationProfile(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["verification-profile - violation: repo root could not be read"],
      ok: false,
    };
  }
  try {
    const r = analyzeVerificationProfileGate(loadVerificationRecommendation(repoRoot));
    return {
      messages: verificationProfileGateMessages(r),
      ok: r.ok,
    };
  } catch {
    return {
      messages: ["verification-profile - violation: changed file graph could not be read"],
      ok: false,
    };
  }
}

export function checkBranchKind(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["branch-kind-check - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeBranchKind(loadBranchKindInput(repoRoot));
    return { messages: branchKindMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["branch-kind-check - violation: branch/check input could not be read"],
      ok: false,
    };
  }
}

export function checkCodingRules(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["coding-rules - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeCodingRules(
      loadCodingRuleDocs(repoRoot),
      loadCodingRulePolicy(repoRoot),
      loadCodingWorkflowDocs(repoRoot),
    );
    return { messages: codingRulesMessages(r), ok: r.ok };
  } catch {
    return { messages: ["coding-rules — violation: TS coding rule lint could not run"], ok: false };
  }
}

export function checkDesignLanguage(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["design-language - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeDesignLanguage(loadDesignLanguageDocs(repoRoot));
    return { messages: designLanguageMessages(r), ok: r.ok };
  } catch {
    return { messages: ["design-language - violation: design docs could not be read"], ok: false };
  }
}

export function checkDddTddRules(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["ddd-tdd-rules - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeDddTddRules(loadDddTddInputs(repoRoot));
    return { messages: dddTddRulesMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["ddd-tdd-rules - violation: DDD/TDD strictness lint could not run"],
      ok: false,
    };
  }
}

export function checkRuleDrift(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["rule-drift - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeRuleDrift(loadRuleAdapterDocs(repoRoot));
    return { messages: ruleDriftMessages(r), ok: r.ok };
  } catch {
    return { messages: ["rule-drift - violation: adapter rule docs could not be read"], ok: false };
  }
}

export function checkRuntimePortability(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["runtime-portability - violation: repo root could not be read"],
      ok: false,
    };
  }
  try {
    const r = analyzeRuntimePortability(loadRuntimePortabilityDocs(repoRoot));
    return { messages: runtimePortabilityMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["runtime-portability - violation: TS/Bun/Node portability lint could not run"],
      ok: false,
    };
  }
}

export function checkGateConfirm(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["gate-confirm - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeGateConfirm(loadGateConfirmDocs(repoRoot));
    return { messages: gateConfirmMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["gate-confirm - violation: gate-design/doc frontmatter could not be read"],
      ok: false,
    };
  }
}

export function checkPlanSchedule(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["plan-schedule - violation: repo root could not be read"], ok: false };
  }
  try {
    return lintPlan(undefined, repoRoot);
  } catch {
    return { messages: ["plan-schedule - violation: PLAN schedule lint could not run"], ok: false };
  }
}

export function checkPlanGovernance(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["plan-governance - violation: repo root could not be read"], ok: false };
  }
  try {
    return lintPlanWithGate(undefined, repoRoot, "governance");
  } catch {
    return {
      messages: ["plan-governance - violation: PLAN governance lint could not run"],
      ok: false,
    };
  }
}

export function checkPlanDod(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["plan-dod - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzePlanDod(loadPlanDodDocs(repoRoot));
    return { messages: planDodMessages(r), ok: r.checked > 0 && r.ok };
  } catch {
    return { messages: ["plan-dod - violation: L7 PLAN DoD could not be read"], ok: false };
  }
}

export function checkPlaceholderDeps(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["placeholder-deps - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzePlaceholderDeps(loadPlaceholderDepsDocs(repoRoot));
    return { messages: placeholderDepsMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["placeholder-deps - violation: design/test-design docs could not be read"],
      ok: false,
    };
  }
}

export function checkPlanTraceGate(
  repoRoot: string,
  gate: "G1-trace" | "G3-trace",
): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return {
      messages: [`${gate.toLowerCase()} - violation: repo root could not be read`],
      ok: false,
    };
  }
  try {
    return lintPlanWithGate(undefined, repoRoot, gate);
  } catch {
    return { messages: [`${gate.toLowerCase()} - violation: trace gate could not run`], ok: false };
  }
}

export function checkRuleAutomationClosure(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["rule-automation-closure - violation: repo root could not be read"],
      ok: false,
    };
  }
  try {
    const r = analyzeRuleAutomationClosure(loadRuleAutomationClosureDocs(repoRoot));
    return { messages: ruleAutomationClosureMessages(r), ok: r.checked > 0 && r.ok };
  } catch {
    return {
      messages: ["rule-automation-closure - violation: closure table could not be read"],
      ok: false,
    };
  }
}

export function checkDriveModelPassage(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["drive-model-passage - violation: repo root could not be read"],
      ok: false,
    };
  }
  try {
    const r = analyzeDriveModelPassage(loadDriveModelPassageDocs(repoRoot));
    return { messages: driveModelPassageMessages(r), ok: r.checked > 0 && r.ok };
  } catch {
    return {
      messages: ["drive-model-passage - violation: passage certificate table could not be read"],
      ok: false,
    };
  }
}

export function checkDriveDbRegistration(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["drive-db-registration - violation: repo root could not be read"],
      ok: false,
    };
  }
  try {
    const r = analyzeDriveDbRegistration(loadOrBuildDriveDbRegistrationStats(repoRoot));
    return { messages: driveDbRegistrationMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["drive-db-registration - violation: harness.db registration could not be read"],
      ok: false,
    };
  }
}

export function checkFrRoadmapCoverage(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["fr-roadmap-coverage - violation: repo root could not be read"],
      ok: false,
    };
  }
  try {
    const r = analyzeFrRoadmapCoverageWithRoot(loadFrRoadmapCoverageDocs(repoRoot), repoRoot);
    return { messages: frRoadmapCoverageMessages(r), ok: r.checked > 0 && r.ok };
  } catch {
    return {
      messages: ["fr-roadmap-coverage - violation: residual bucket table could not be read"],
      ok: false,
    };
  }
}

export function checkTelemetryClosure(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["telemetry-closure - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeTelemetryClosure(loadTelemetryClosureDocs(repoRoot));
    return { messages: telemetryClosureMessages(r), ok: r.checked > 0 && r.ok };
  } catch {
    return {
      messages: ["telemetry-closure - violation: telemetry closure matrix could not be read"],
      ok: false,
    };
  }
}

export function checkCycleP4Verification(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["cycle-p4-verification - violation: repo root could not be read"],
      ok: false,
    };
  }
  try {
    const r = analyzeCycleP4Verification(loadCycleP4VerificationDocs(repoRoot), repoRoot);
    return { messages: cycleP4VerificationMessages(r), ok: r.checked > 0 && r.ok };
  } catch {
    return {
      messages: ["cycle-p4-verification - violation: Cycle P4 closure audit could not be read"],
      ok: false,
    };
  }
}

export function checkL14CloseAudit(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["l14-close-audit - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeL14CloseAudit(loadL14CloseAuditDocs(repoRoot), repoRoot);
    return { messages: l14CloseAuditMessages(r), ok: r.checked > 0 && r.ok };
  } catch {
    return {
      messages: ["l14-close-audit - violation: A-143 audit could not be read"],
      ok: false,
    };
  }
}

export function checkL6FrCoverage(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["l6-fr-coverage - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeL6FrCoverage(loadL6FrCoverageDocs(repoRoot));
    return { messages: l6FrCoverageMessages(r), ok: r.ok };
  } catch {
    return { messages: ["l6-fr-coverage — ⚠ L6 FR coverage matrix を読めない"], ok: false };
  }
}

export function checkReadability(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["readability - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeReadability(loadSystemReadabilityDocs(repoRoot));
    return { messages: readabilityMessages(r), ok: r.checked > 0 && r.ok };
  } catch {
    return { messages: ["readability — ⚠ prose docs を読めない"], ok: false };
  }
}

/**
 * Expanded mojibake guard for generated runtime artifacts outside docs/
 * (PLAN-L7-69): .ut-tdd/audit/** markdown and .ut-tdd/handover/** JSON
 * (cross-agent provider payloads included). Fail-open on absence — a fresh
 * repo with no runtime artifacts has nothing to corrupt — and fail-close on
 * any mojibake marker so a corrupted handover/audit/provider-JSON cannot pass
 * silently. repo root unreadable is fail-close.
 */
export function checkRuntimeReadability(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["runtime-readability - violation: repo root could not be read"],
      ok: false,
    };
  }
  try {
    const r = analyzeReadability(loadRuntimeArtifactReadabilityDocs(repoRoot));
    return { messages: runtimeReadabilityMessages(r), ok: r.ok };
  } catch {
    return { messages: ["runtime-readability — ⚠ .ut-tdd artifacts を読めない"], ok: false };
  }
}

/**
 * feedback-log のドメスティック化規律を hard gate 検査 (IMP-085、A-138 ITEM-3)。
 * docs/feedback-log.md 不在は fail-open (任意ドキュメント)、repo root 不在は fail-close。
 */
export function checkFeedbackLog(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["feedback-log - violation: repo root could not be read"], ok: false };
  }
  if (!existsSync(join(repoRoot, "docs/feedback-log.md"))) {
    return { messages: ["feedback-log — OK (docs/feedback-log.md 不在 = 適用なし)"], ok: true };
  }
  try {
    const r = analyzeFeedbackLog(loadFeedbackLogInput(repoRoot));
    return { messages: feedbackLogMessages(r), ok: r.ok };
  } catch {
    return { messages: ["feedback-log — ⚠ docs/feedback-log.md を読めない"], ok: false };
  }
}

/** V-model 層群の Forward freeze 完了 (検証サイクル発火タイミング) を hard gate として検査する。 */
export function checkL6Completion(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!canLoadL6CompletionInputs(repoRoot)) {
    return {
      messages: ["l6-completion - violation: L6 completion inputs could not be read"],
      ok: false,
    };
  }
  try {
    const r = analyzeL6Completion(loadL6CompletionInputs(repoRoot));
    return { messages: l6CompletionMessages(r), ok: r.ready };
  } catch {
    return {
      messages: ["l6-completion - violation: L6 completion readiness could not be read"],
      ok: false,
    };
  }
}

export function checkL7Completion(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["l7-completion - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeL7Completion(loadL7CompletionDocs(repoRoot));
    return { messages: l7CompletionMessages(r), ok: r.checked > 0 && r.ok };
  } catch {
    return {
      messages: ["l7-completion - violation: active L4-L6 design docs could not be read"],
      ok: false,
    };
  }
}

/** impl→PLAN トレーサビリティ (src ⊆ PLAN generates ∪ baseline) を hard gate として検査する。 */
export function checkImplPlanTrace(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["impl-plan-trace - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeImplPlanTrace(loadImplPlanTraceInput(repoRoot));
    return { messages: implPlanTraceMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["impl-plan-trace - violation: src/PLAN trace could not be read"],
      ok: false,
    };
  }
}

/** 要件 §G.1 sub-doc 表 ⊆⊇ schema VALID_SUB_DOCS の正本同期を hard gate として検査する (IMP-141)。 */
export function checkSubDocCatalogDrift(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["sub-doc-catalog-drift - violation: repo root could not be read"],
      ok: false,
    };
  }
  try {
    const r = analyzeSubDocCatalogDrift(loadSubDocCatalogDriftInput(repoRoot));
    return { messages: subDocCatalogDriftMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["sub-doc-catalog-drift - violation: requirements doc could not be read"],
      ok: false,
    };
  }
}

/** L4 標準成果物 (report/batch/notification/code-value) の必須 § 構造を hard gate として検査する (§G.6.1)。 */
export function checkSubDocSectionStructure(repoRoot: string): {
  messages: string[];
  ok: boolean;
} {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["sub-doc-section-structure - violation: repo root could not be read"],
      ok: false,
    };
  }
  try {
    const r = analyzeSubDocSectionStructure(loadSubDocSectionStructureInput(repoRoot));
    return { messages: subDocSectionStructureMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["sub-doc-section-structure - violation: docs/plans could not be read"],
      ok: false,
    };
  }
}

/** 画面実装宣言 (implemented_screens) が検証ペア (next_pair_freeze) の段階順を破っていないか hard gate。 */
export function checkScreenImplPairFreeze(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["screen-impl-pair-freeze - violation: repo root could not be read"],
      ok: false,
    };
  }
  try {
    const r = analyzeScreenImplPairFreeze(loadScreenImplPairFreezeInput(repoRoot));
    return { messages: screenImplPairFreezeMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["screen-impl-pair-freeze - violation: screen-list.md could not be read"],
      ok: false,
    };
  }
}

/** git tracked top-level ⊆ repository-structure.md canonical の突合を hard gate として検査する。 */
export function checkTrackedCanonical(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["tracked-canonical - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeTrackedCanonical(loadTrackedCanonicalInput(repoRoot));
    return { messages: trackedCanonicalMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["tracked-canonical - violation: git/repository-structure could not be read"],
      ok: false,
    };
  }
}

/** oracle 宣言 ⇔ 実テスト citation の突合を hard gate として検査する。 */
export function checkOracleTestTrace(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["oracle-test-trace - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeOracleTestTrace(loadOracleTestTraceInput(repoRoot));
    return { messages: oracleTestTraceMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["oracle-test-trace - violation: test-design/tests could not be read"],
      ok: false,
    };
  }
}

/** 工程表 (登録 roadmap) の span 実在 + 層内ゲート進捗を hard gate として検査する。 */
export function checkRoadmap(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["roadmap - violation: repo root could not be read"], ok: false };
  }
  try {
    const records = loadRoadmaps(repoRoot);
    // 全プログラム被覆 (program coverage): 登録工程表が forward 全バンドを被覆するか。
    // PLAN-RECOVERY-04 工程表定義 = 人間向け全プログラム台帳。登録 0 は hard violation。
    const coverageMessages = programCoverageMessages(
      analyzeProgramCoverage(records, new Set(PARKED_BANDS.keys())),
    );
    if (records.length === 0) {
      return {
        messages: [
          "roadmap - violation: 登録工程表なし (master-hub roadmap block 未使用)",
          ...coverageMessages,
        ],
        ok: false,
      };
    }
    // I-1: 各 PLAN を 1 回だけ読み id→status を構築 (二重 readFile 解消)。
    const dir = join(repoRoot, "docs", "plans");
    const known = new Set<string>();
    const statusMap = new Map<string, string>();
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
      const content = readFileSync(join(dir, f), "utf8");
      const id = fmValue(content, "plan_id");
      if (id) {
        known.add(id);
        statusMap.set(id, fmValue(content, "status") ?? "draft");
      }
    }
    const messages: string[] = [];
    let issueCount = 0;
    for (const rec of records) {
      const spanIssues = checkSpanExistence(rec.roadmap, known);
      issueCount += spanIssues.length + rec.errors.length;
      const progress = computeGateProgress(rec.roadmap, (id) => statusMap.get(id) ?? null);
      const reached = progress.filter((g) => g.reached).length;
      messages.push(
        `roadmap — ${rec.planId} [${rec.roadmap.layer}]: gates ${reached}/${progress.length} 到達, spans ${rec.roadmap.spans.length}, 孤児 span ${spanIssues.length}, 構造 issue ${rec.errors.length}`,
      );
      for (const gi of progress) {
        messages.push(
          `  ${gi.gateId}: ${gi.reached ? "✅ reached" : "pending"} (${gi.confirmedSpans}/${gi.totalSpans} span reached: confirmed/completed)`,
        );
      }
      for (const si of spanIssues) messages.push(`  ⚠ ${si}`);
      for (const e of rec.errors) messages.push(`  ⚠ 構造: ${e}`);
    }
    const rollup = computeProgramRollup(
      records,
      (id) => statusMap.get(id) ?? null,
      new Set(PARKED_BANDS.keys()),
    );
    messages.push(
      `roadmap-rollup — bands ${rollup.coveredBands}/${rollup.totalBands} covered (park ${rollup.parkedBands}, uncovered ${rollup.uncoveredBands}) / gates ${rollup.reachedGates}/${rollup.totalGates} reached / spans ${rollup.confirmedSpans}/${rollup.totalSpans} / frontier: ${rollup.frontier.length ? rollup.frontier.join(", ") : "なし"}`,
    );
    messages.push(...coverageMessages);
    const coverageOk =
      analyzeProgramCoverage(records, new Set(PARKED_BANDS.keys())).uncovered.length === 0;
    return { messages, ok: issueCount === 0 && coverageOk };
  } catch {
    return { messages: ["roadmap - violation: 工程表を読めず検査できない"], ok: false };
  }
}

export function checkDependencyDrift(repoRoot: string): {
  messages: string[];
  ok: boolean;
  result: DependencyDriftResult | null;
} {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["dependency-drift - violation: repo root could not be read"],
      ok: false,
      result: null,
    };
  }
  try {
    const result = analyzeDependencyDrift(loadDependencyDriftInput(repoRoot));
    return { messages: dependencyDriftMessages(result), ok: result.ok, result };
  } catch {
    return {
      messages: ["dependency-drift - violation: dependency graph could not be read"],
      ok: false,
      result: null,
    };
  }
}

export function checkRegressionExpansion(
  repoRoot: string,
  drift: DependencyDriftResult | null,
): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["regression-expansion - violation: repo root could not be read"],
      ok: false,
    };
  }
  if (drift == null) {
    return {
      messages: ["regression-expansion - violation: dependency drift result is unavailable"],
      ok: false,
    };
  }
  try {
    const result = expandRegressionScope(drift, loadChangedFilesForDoctor(repoRoot));
    return { messages: regressionExpansionMessages(result), ok: result.ok };
  } catch {
    return {
      messages: ["regression-expansion - violation: regression scope could not be expanded"],
      ok: false,
    };
  }
}

export function checkVerificationGroupsResult(repoRoot: string): {
  messages: string[];
  ok: boolean;
} {
  try {
    const docs = loadPairDocs(repoRoot);
    const { orphans } = analyzePairFreeze(docs);
    const groups = analyzeVerificationGroups(docs, orphans, loadVerificationPlanEvidence(repoRoot));
    return { messages: verificationGroupMessages(groups), ok: verificationGroupsOk(groups) };
  } catch {
    return {
      messages: ["verification — violation: verification group lint could not run"],
      ok: false,
    };
  }
}

export function checkVerificationGroups(repoRoot: string): string[] {
  return checkVerificationGroupsResult(repoRoot).messages;
}

/** doctor 用に agent-slots deps を node I/O で構築 (now 固定は test 注入)。 */
function doctorSlotsDeps(deps: DoctorDeps): AgentSlotsDeps {
  return {
    repoRoot: deps.repoRoot,
    now: () => deps.now,
    readText: deps.readText,
    writeText: () => {}, // doctor は read-only
    newId: () => "doctor-readonly",
  };
}

export function nodeDoctorDeps(repoRoot: string): DoctorDeps {
  return {
    repoRoot,
    now: new Date().toISOString(),
    readText: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
    listDir: (dir) => (existsSync(dir) ? readdirSync(dir) : []),
  };
}

/**
 * doc-consistency lint を hard gate 検査 (PLAN-L7-95、要件 §G.11 の「自動検証」配線)。
 * carry 整合 / screen-id 妥当性 / NFR 件数宣言-実数を fail-close。I/O 失敗も violation。
 */
export function checkDocConsistency(repoRoot: string): { messages: string[]; ok: boolean } {
  try {
    const r = analyzeDocConsistency(loadDocConsistencyDocs(repoRoot));
    const bad = r.carryOrphans.length + r.screenIdOrphans.length + (r.nfrCount.mismatch ? 1 : 0);
    if (bad === 0) {
      return {
        messages: [
          `doc-consistency — OK (carry/screen-id/NFR 整合, screens=${r.definedScreenCount}, NFR=${r.nfrCount.actual})`,
        ],
        ok: true,
      };
    }
    return {
      messages: [
        `doc-consistency — violation: carryOrphans=${r.carryOrphans.length}, screenIdOrphans=${r.screenIdOrphans.length}, nfrMismatch=${r.nfrCount.mismatch} (declared=${r.nfrCount.declared}/actual=${r.nfrCount.actual})`,
      ],
      ok: false,
    };
  } catch {
    return {
      messages: ["doc-consistency — violation: L1/L3/screen docs could not be read"],
      ok: false,
    };
  }
}

/**
 * entity-coverage lint を hard gate 検査 (PLAN-L7-95)。business §10.1 primary entity と
 * L3 派生 entity の重複 0 を fail-close。I/O 失敗も violation。
 */
export function checkEntityCoverage(repoRoot: string): { messages: string[]; ok: boolean } {
  try {
    const r = analyzeEntityCoverage(loadEntityBusiness(repoRoot));
    if (r.duplicates.length === 0) {
      return {
        messages: [
          `entity-coverage — OK (primary/L3-derived entity 整合, total=${r.totalCount}, dup 0)`,
        ],
        ok: true,
      };
    }
    return {
      messages: [
        `entity-coverage — violation: duplicate entity=${r.duplicates.length} (${r.duplicates.join(", ")})`,
      ],
      ok: false,
    };
  } catch {
    return { messages: ["entity-coverage — violation: business doc could not be read"], ok: false };
  }
}

/**
 * fr-registry-audit lint を hard gate 検査 (PLAN-L7-95、要件 §1.10.G.10 の「漏れ監査自動化」配線)。
 * FR-L1 registry の 5 型漏れ (登録/欠番/属性/件数/画面被覆) を fail-close。I/O 失敗も violation。
 */
export function checkFrRegistryAudit(repoRoot: string): { messages: string[]; ok: boolean } {
  try {
    const r = analyzeFrRegistry(loadFrRegistryDocs(repoRoot));
    const bad =
      r.unregistered.length +
      r.unexplainedGaps.length +
      r.attributeOrphans.length +
      r.countMismatches.length +
      r.screenCoverageOrphans.length;
    if (bad === 0) {
      return {
        messages: [
          `fr-registry-audit — OK (FR-L1 registry 5 型漏れ 0, registered=${r.totals.registered})`,
        ],
        ok: true,
      };
    }
    return {
      messages: [
        `fr-registry-audit — violation: unregistered=${r.unregistered.length}, gaps=${r.unexplainedGaps.length}, attr=${r.attributeOrphans.length}, count=${r.countMismatches.length}, screen=${r.screenCoverageOrphans.length}`,
      ],
      ok: false,
    };
  } catch {
    return {
      messages: ["fr-registry-audit — violation: L1/L3/screen docs could not be read"],
      ok: false,
    };
  }
}

/**
 * improvement-backlog lint を hard gate 検査 (PLAN-L7-95、要件 §1.10.G.12 の「構造健全性検証」配線)。
 * IMP 行の malformed/dup/invalid status・candidate/incomplete/unparseable と
 * lower-layer backprop 分類欠落を fail-close。
 */
export function checkImprovementBacklog(repoRoot: string): { messages: string[]; ok: boolean } {
  try {
    const r = analyzeImprovementBacklog(loadImprovementBacklog(repoRoot));
    const bad =
      r.malformedIds.length +
      r.duplicateIds.length +
      r.invalidStatus.length +
      r.invalidCandidate.length +
      r.incompleteRows.length +
      r.unparseableRows.length +
      r.missingBackpropClassification.length;
    if (bad === 0) {
      return {
        messages: [
          `improvement-backlog — OK (backlog 書式健全, entries=${r.total}, open=${r.openCount}, 死蔵行 0, backprop分類欠落 0)`,
        ],
        ok: true,
      };
    }
    return {
      messages: [
        `improvement-backlog — violation: malformed=${r.malformedIds.length}, dup=${r.duplicateIds.length}, invalidStatus=${r.invalidStatus.length}, invalidCandidate=${r.invalidCandidate.length}, incomplete=${r.incompleteRows.length}, unparseable=${r.unparseableRows.length}, missingBackpropClassification=${r.missingBackpropClassification.length}`,
      ],
      ok: false,
    };
  } catch {
    return {
      messages: ["improvement-backlog — violation: docs/improvement-backlog.md could not be read"],
      ok: false,
    };
  }
}

/**
 * lint-wiring meta-gate を hard gate 検査 (PLAN-L7-95、IMP-006)。
 * すべての src/lint module が runtime 経路から到達可能 or DEFERRED 登録済みを fail-close。
 */
export function checkRightArmGatePlanning(repoRoot: string): { messages: string[]; ok: boolean } {
  try {
    const r = analyzeRightArmGatePlanning(loadRightArmGatePlanningInput(repoRoot));
    return { messages: rightArmGatePlanningMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["right-arm-gate-planning - violation: G8-G14 carry docs could not be read"],
      ok: false,
    };
  }
}

export function checkLintWiring(repoRoot: string): { messages: string[]; ok: boolean } {
  try {
    const r = analyzeLintWiring(loadLintWiringInput(repoRoot));
    return { messages: lintWiringMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["lint-wiring — violation: src/lint modules could not be scanned"],
      ok: false,
    };
  }
}

/**
 * forward-convergence (fail-close, PLAN-DISCOVERY-08 Step5): spine-外 kind=impl の NEW 未集約 landed を
 * gate する。legacy debt allowlist は grandfather (ok を落とさず surface)。例外時は fail-close。
 */
export function checkForwardConvergence(repoRoot: string): { messages: string[]; ok: boolean } {
  try {
    const docs = loadConvergenceDocs(repoRoot);
    const r = analyzeForwardConvergence(docs.plans, docs.roadmapSpanIds, docs.reverseReferencedIds);
    return { messages: forwardConvergenceMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["forward-convergence — violation: PLAN を読めず spine-外集約を検査できない"],
      ok: false,
    };
  }
}

/** legacy debt allowlist ↔ audit doc の双方向一致 hard check (Codex Critical B)。 */
export function checkForwardConvergenceAudit(repoRoot: string): {
  messages: string[];
  ok: boolean;
} {
  try {
    const r = loadLegacyAuditDrift(repoRoot);
    return { messages: legacyAuditDriftMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["forward-convergence-audit — violation: legacy debt audit を検査できない"],
      ok: false,
    };
  }
}

export function checkFrontendDesignCoverage(repoRoot: string): {
  messages: string[];
  ok: boolean;
} {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["frontend-design-coverage - violation: repo root could not be read"],
      ok: false,
    };
  }
  try {
    const r = analyzeFrontendDesignCoverage(loadFrontendDesignCoverageInput(repoRoot));
    return { messages: frontendDesignCoverageMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["frontend-design-coverage - violation: FE design coverage check could not run"],
      ok: false,
    };
  }
}

export function checkProposalDocumentCoverage(repoRoot: string): {
  messages: string[];
  ok: boolean;
} {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["proposal-document-coverage - violation: repo root could not be read"],
      ok: false,
    };
  }
  try {
    const r = analyzeProposalDocumentCoverage(
      loadProposalDocumentCoverageLintInput(repoRoot, classifyProposalDocumentCoverage),
    );
    return { messages: proposalDocumentCoverageMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["proposal-document-coverage - violation: document coverage routing could not run"],
      ok: false,
    };
  }
}

// CLI entrypoint は process.cwd() = repoRoot を想定 (deps 未指定時)。test は deps 注入で固定。
export function checkG8IntegrationWorkflow(repoRoot: string): {
  messages: string[];
  ok: boolean;
} {
  if (!canLoadG8IntegrationWorkflowInput(repoRoot)) {
    return {
      messages: [
        "g8-integration-workflow - violation: L8 test design or gates.md could not be read",
      ],
      ok: false,
    };
  }
  try {
    const r = analyzeG8IntegrationWorkflow(loadG8IntegrationWorkflowInput(repoRoot));
    return { messages: g8IntegrationWorkflowMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["g8-integration-workflow - violation: G8 workflow check could not run"],
      ok: false,
    };
  }
}

export function checkG9SystemWorkflow(repoRoot: string): {
  messages: string[];
  ok: boolean;
} {
  if (!canLoadG9SystemWorkflowInput(repoRoot)) {
    return {
      messages: ["g9-system-workflow - violation: L9 test design or gates.md could not be read"],
      ok: false,
    };
  }
  try {
    const r = analyzeG9SystemWorkflow(loadG9SystemWorkflowInput(repoRoot));
    return { messages: g9SystemWorkflowMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["g9-system-workflow - violation: G9 workflow check could not run"],
      ok: false,
    };
  }
}

export function checkG10UxWorkflow(repoRoot: string): {
  messages: string[];
  ok: boolean;
} {
  if (!canLoadG10UxWorkflowInput(repoRoot)) {
    return {
      messages: ["g10-ux-workflow - violation: L10 UX design or gates.md could not be read"],
      ok: false,
    };
  }
  try {
    const r = analyzeG10UxWorkflow(loadG10UxWorkflowInput(repoRoot));
    return { messages: g10UxWorkflowMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["g10-ux-workflow - violation: G10 workflow check could not run"],
      ok: false,
    };
  }
}

export function runDoctor(
  deps: DoctorDeps = nodeDoctorDeps(process.cwd()),
  options: DoctorOptions = {},
): LintResult {
  if (options.setupSmoke === true) return checkSetupSmoke(deps);

  const d = detectMode();
  // handover / agent-slots are warning surfaces. Verification profile is a hard gate.
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
  return {
    ok:
      backfill.ok &&
      scrumRev.ok &&
      planSupersession.ok &&
      planBodySubstance.ok &&
      planCompletionDrift.ok &&
      propagation.ok &&
      reviewEvidence.ok &&
      guardrailInvariants.ok &&
      pairFreeze.ok &&
      moduleDrift.ok &&
      mergedPlanStatus.ok &&
      planArtifactExistence.ok &&
      assetDrift.ok &&
      skillAssignment.ok &&
      descentObligation.ok &&
      changeImpact.ok &&
      changeSetIntegrity.ok &&
      verificationProfile.ok &&
      branchKind.ok &&
      codingRules.ok &&
      designLanguage.ok &&
      dddTddRules.ok &&
      runtimePortability.ok &&
      ruleDrift.ok &&
      gateConfirm.ok &&
      planSchedule.ok &&
      planGovernance.ok &&
      planDod.ok &&
      placeholderDeps.ok &&
      g1Trace.ok &&
      g3Trace.ok &&
      ruleAutomationClosure.ok &&
      driveModelPassage.ok &&
      driveDbRegistration.ok &&
      frRoadmapCoverage.ok &&
      telemetryClosure.ok &&
      cycleP4Verification.ok &&
      l14CloseAudit.ok &&
      l6FrCoverage.ok &&
      readability.ok &&
      runtimeReadability.ok &&
      feedbackLog.ok &&
      projectHooks.ok &&
      githubCiPolicy.ok &&
      codexHookAdapter.ok &&
      codexWrapperParity.ok &&
      l6Completion.ok &&
      l7Completion.ok &&
      verificationGroups.ok &&
      roadmap.ok &&
      implPlanTrace.ok &&
      oracleTestTrace.ok &&
      trackedCanonical.ok &&
      subDocCatalogDrift.ok &&
      subDocSectionStructure.ok &&
      screenImplPairFreeze.ok &&
      dependencyDrift.ok &&
      regressionExpansion.ok &&
      dbProjectionCoverage.ok &&
      dbProjectionIngestion.ok &&
      docConsistency.ok &&
      entityCoverage.ok &&
      frRegistryAudit.ok &&
      improvementBacklog.ok &&
      rightArmGatePlanning.ok &&
      g8IntegrationWorkflow.ok &&
      g9SystemWorkflow.ok &&
      g10UxWorkflow.ok &&
      lintWiring.ok &&
      proposalDocumentCoverage.ok &&
      frontendDesignCoverage.ok &&
      greenCommandDigest.ok &&
      forwardConvergence.ok &&
      forwardConvergenceAudit.ok &&
      handoverOutstanding.ok,
    messages: [
      `doctor: mode=${d.mode} (claude=${d.claude}, codex=${d.codex})`,
      checkHandover(deps),
      ...checkHandoverDisciplineMessages(deps).map((m) => `doctor: handover-discipline — ${m}`),
      checkAgentSlots(doctorSlotsDeps(deps)),
      ...backfill.messages.map((m) => `doctor: ${m}`),
      ...scrumRev.messages.map((m) => `doctor: ${m}`),
      ...planSupersession.messages.map((m) => `doctor: ${m}`),
      ...planBodySubstance.messages.map((m) => `doctor: ${m}`),
      ...planCompletionDrift.messages.map((m) => `doctor: ${m}`),
      ...propagation.messages.map((m) => `doctor: ${m}`),
      ...pairFreeze.messages.map((m) => `doctor: ${m}`),
      ...moduleDrift.messages.map((m) => `doctor: ${m}`),
      ...mergedPlanStatus.messages.map((m) => `doctor: ${m}`),
      ...planArtifactExistence.messages.map((m) => `doctor: ${m}`),
      ...assetDrift.messages.map((m) => `doctor: ${m}`),
      ...skillAssignment.messages.map((m) => `doctor: ${m}`),
      ...descentObligation.messages.map((m) => `doctor: ${m}`),
      ...changeImpact.messages.map((m) => `doctor: ${m}`),
      ...changeSetIntegrity.messages.map((m) => `doctor: ${m}`),
      ...verificationProfile.messages.map((m) => `doctor: ${m}`),
      ...branchKind.messages.map((m) => `doctor: ${m}`),
      ...codingRules.messages.map((m) => `doctor: ${m}`),
      ...designLanguage.messages.map((m) => `doctor: ${m}`),
      ...dddTddRules.messages.map((m) => `doctor: ${m}`),
      ...runtimePortability.messages.map((m) => `doctor: ${m}`),
      ...ruleDrift.messages.map((m) => `doctor: ${m}`),
      ...gateConfirm.messages.map((m) => `doctor: ${m}`),
      ...planSchedule.messages.map((m) => `doctor: ${m}`),
      ...planGovernance.messages.map((m) => `doctor: ${m}`),
      ...planDod.messages.map((m) => `doctor: ${m}`),
      ...placeholderDeps.messages.map((m) => `doctor: ${m}`),
      ...g1Trace.messages.map((m) => `doctor: ${m}`),
      ...g3Trace.messages.map((m) => `doctor: ${m}`),
      ...ruleAutomationClosure.messages.map((m) => `doctor: ${m}`),
      ...driveModelPassage.messages.map((m) => `doctor: ${m}`),
      ...driveDbRegistration.messages.map((m) => `doctor: ${m}`),
      ...frRoadmapCoverage.messages.map((m) => `doctor: ${m}`),
      ...telemetryClosure.messages.map((m) => `doctor: ${m}`),
      ...cycleP4Verification.messages.map((m) => `doctor: ${m}`),
      ...l14CloseAudit.messages.map((m) => `doctor: ${m}`),
      ...projectHooks.messages.map((m) => `doctor: ${m}`),
      ...githubCiPolicy.messages.map((m) => `doctor: ${m}`),
      ...codexHookAdapter.messages.map((m) => `doctor: ${m}`),
      ...codexWrapperParity.messages.map((m) => `doctor: ${m}`),
      ...l6FrCoverage.messages.map((m) => `doctor: ${m}`),
      ...readability.messages.map((m) => `doctor: ${m}`),
      ...runtimeReadability.messages.map((m) => `doctor: ${m}`),
      ...feedbackLog.messages.map((m) => `doctor: ${m}`),
      ...l6Completion.messages.map((m) => `doctor: ${m}`),
      ...l7Completion.messages.map((m) => `doctor: ${m}`),
      ...reviewEvidence.messages.map((m) => `doctor: ${m}`),
      ...guardrailInvariants.messages.map((m) => `doctor: ${m}`),
      ...verificationGroups.messages.map((m) => `doctor: ${m}`),
      ...roadmap.messages.map((m) => `doctor: ${m}`),
      ...implPlanTrace.messages.map((m) => `doctor: ${m}`),
      ...oracleTestTrace.messages.map((m) => `doctor: ${m}`),
      ...trackedCanonical.messages.map((m) => `doctor: ${m}`),
      ...subDocCatalogDrift.messages.map((m) => `doctor: ${m}`),
      ...subDocSectionStructure.messages.map((m) => `doctor: ${m}`),
      ...screenImplPairFreeze.messages.map((m) => `doctor: ${m}`),
      ...dependencyDrift.messages.map((m) => `doctor: ${m}`),
      ...regressionExpansion.messages.map((m) => `doctor: ${m}`),
      ...dbProjectionCoverage.messages.map((m) => `doctor: ${m}`),
      ...dbProjectionIngestion.messages.map((m) => `doctor: ${m}`),
      ...docConsistency.messages.map((m) => `doctor: ${m}`),
      ...entityCoverage.messages.map((m) => `doctor: ${m}`),
      ...frRegistryAudit.messages.map((m) => `doctor: ${m}`),
      ...improvementBacklog.messages.map((m) => `doctor: ${m}`),
      ...rightArmGatePlanning.messages.map((m) => `doctor: ${m}`),
      ...g8IntegrationWorkflow.messages.map((m) => `doctor: ${m}`),
      ...g9SystemWorkflow.messages.map((m) => `doctor: ${m}`),
      ...g10UxWorkflow.messages.map((m) => `doctor: ${m}`),
      ...lintWiring.messages.map((m) => `doctor: ${m}`),
      ...proposalDocumentCoverage.messages.map((m) => `doctor: ${m}`),
      ...frontendDesignCoverage.messages.map((m) => `doctor: ${m}`),
      ...handoverOutstanding.messages.map((m) => `doctor: ${m}`),
      ...greenCommandDigest.messages.map((m) => `doctor: ${m}`),
      ...forwardConvergence.messages.map((m) => `doctor: ${m}`),
      ...forwardConvergenceAudit.messages.map((m) => `doctor: ${m}`),
    ],
  };
}
