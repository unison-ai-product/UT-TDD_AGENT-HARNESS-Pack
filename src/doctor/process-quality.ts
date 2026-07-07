import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  analyzeCycleP4Verification,
  cycleP4VerificationMessages,
  loadCycleP4VerificationDocs,
} from "../lint/cycle-p4-verification";
import { analyzeDbCurrency, dbCurrencyMessages } from "../lint/db-currency";
import {
  analyzeDriveDbRegistration,
  driveDbRegistrationMessages,
} from "../lint/drive-db-registration";
import {
  analyzeDriveModelPassage,
  driveModelPassageMessages,
  loadDriveModelPassageDocs,
} from "../lint/drive-model-passage";
import {
  analyzeFeedbackLog,
  feedbackLogMessages,
  loadFeedbackLogInput,
} from "../lint/feedback-log";
import {
  analyzeFrRoadmapCoverageWithRoot,
  frRoadmapCoverageMessages,
  loadFrRoadmapCoverageDocs,
} from "../lint/fr-roadmap-coverage";
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
import {
  analyzePlaceholderDeps,
  loadPlaceholderDepsDocs,
  placeholderDepsMessages,
} from "../lint/placeholder-deps";
import { analyzePlanDod, loadPlanDodDocs, planDodMessages } from "../lint/plan-dod";
import {
  analyzeRuleAutomationClosure,
  loadRuleAutomationClosureDocs,
  ruleAutomationClosureMessages,
} from "../lint/rule-automation-closure";
import {
  analyzeScreenImplPairFreeze,
  loadScreenImplPairFreezeInput,
  screenImplPairFreezeMessages,
} from "../lint/screen-impl-pair-freeze";
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
import { lintPlanWithGate } from "../plan/lint";
import {
  loadDriveDbRegistrationStats,
  loadOrBuildDriveDbRegistrationStats,
} from "../state-db/drive-registration";

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

export function checkDbCurrency(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["db-currency - violation: repo root could not be read"],
      ok: false,
    };
  }
  try {
    const r = analyzeDbCurrency(loadDriveDbRegistrationStats(repoRoot));
    return { messages: dbCurrencyMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["db-currency - violation: harness.db currency could not be read"],
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
