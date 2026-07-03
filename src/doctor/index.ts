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
import { analyzeDependencyDrift, loadDependencyDriftInput } from "../lint/dependency-drift";
import {
  analyzeDescentObligations,
  descentObligationMessages,
  filterSubstanceVerifiedAdvisories,
  loadDeferLedger,
  loadDescentAdjacency,
  loadFrUnitCoverageOracles,
  loadTraceKeyedArtifacts,
} from "../lint/descent-obligation";
import { checkGreenCommandDigests } from "../lint/green-command-digest";
import { analyzeModuleDrift, loadModuleDocs, moduleDriftMessages } from "../lint/module-drift";
import {
  analyzeSkillAssignments,
  loadSkillAssignmentDocs,
  skillAssignmentMessages,
} from "../lint/skill-assignment";
import {
  analyzeVerificationProfileGate,
  loadVerificationRecommendation,
  verificationProfileGateMessages,
} from "../lint/verification-profile";
import type { LintResult } from "../plan/lint";
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
import { checkDbProjectionCoverage, checkDbProjectionIngestion } from "./db-projection";
import { checkDependencyDrift, checkRegressionExpansion } from "./dependency-regression";
import { checkDocConsistency, checkEntityCoverage, checkFrRegistryAudit } from "./doc-registry";
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
