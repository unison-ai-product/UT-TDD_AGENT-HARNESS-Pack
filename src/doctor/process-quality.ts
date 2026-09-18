import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  analyzeCycleP4Verification,
  cycleP4VerificationMessages,
  loadCycleP4VerificationDocs,
} from "../lint/cycle-p4-verification.ts";
import { analyzeDbCurrency, dbCurrencyMessages } from "../lint/db-currency.ts";
import {
  analyzeDriveDbRegistration,
  driveDbRegistrationMessages,
} from "../lint/drive-db-registration.ts";
import {
  analyzeDriveModelPassage,
  driveModelPassageMessages,
  loadDriveModelPassageDocs,
} from "../lint/drive-model-passage.ts";
import {
  analyzeFeedbackLog,
  feedbackLogMessages,
  loadFeedbackLogInput,
} from "../lint/feedback-log.ts";
import {
  analyzeFrRoadmapCoverageWithRoot,
  frRoadmapCoverageMessages,
  loadFrRoadmapCoverageDocs,
} from "../lint/fr-roadmap-coverage.ts";
import { analyzeGateRunCoverage, gateRunCoverageMessages } from "../lint/gate-run-coverage.ts";
import {
  analyzeL6Completion,
  canLoadL6CompletionInputs,
  l6CompletionMessages,
  loadL6CompletionInputs,
} from "../lint/l6-completion.ts";
import {
  analyzeL6FrCoverage,
  l6FrCoverageMessages,
  loadL6FrCoverageDocs,
} from "../lint/l6-fr-coverage.ts";
import {
  analyzeL7Completion,
  l7CompletionMessages,
  loadL7CompletionDocs,
} from "../lint/l7-completion.ts";
import {
  analyzeL14CloseAudit,
  l14CloseAuditMessages,
  loadL14CloseAuditDocs,
} from "../lint/l14-close-audit.ts";
import {
  analyzePlaceholderDeps,
  loadPlaceholderDepsDocs,
  placeholderDepsMessages,
} from "../lint/placeholder-deps.ts";
import { analyzePlanDod, loadPlanDodDocs, planDodMessages } from "../lint/plan-dod.ts";
import {
  analyzeRuleAutomationClosure,
  loadRuleAutomationClosureDocs,
  ruleAutomationClosureMessages,
} from "../lint/rule-automation-closure.ts";
import {
  analyzeScreenImplPairFreeze,
  loadScreenImplPairFreezeInput,
  screenImplPairFreezeMessages,
} from "../lint/screen-impl-pair-freeze.ts";
import {
  analyzeSubDocCatalogDrift,
  loadSubDocCatalogDriftInput,
  subDocCatalogDriftMessages,
} from "../lint/sub-doc-catalog-drift.ts";
import {
  analyzeSubDocSchemaIntegrity,
  loadSubDocSchemaIntegrityInput,
  subDocSchemaIntegrityMessages,
} from "../lint/sub-doc-schema-integrity.ts";
import {
  analyzeSubDocSectionStructure,
  loadSubDocSectionStructureInput,
  subDocSectionStructureMessages,
} from "../lint/sub-doc-section-structure.ts";
import {
  analyzeTelemetryClosure,
  loadTelemetryClosureDocs,
  telemetryClosureMessages,
} from "../lint/telemetry-closure.ts";
import { lintPlanWithGate } from "../plan/lint.ts";
import {
  loadDriveDbRegistrationStats,
  loadOrBuildDriveDbRegistrationStats,
} from "../state-db/drive-registration.ts";
import { defaultHarnessDbPath, type HarnessDb, openHarnessDb } from "../state-db/index.ts";
import { rebuildHarnessDb } from "../state-db/projection-writer.ts";

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

export function checkGateRunCoverage(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["gate-run-coverage - violation: repo root could not be read"],
      ok: false,
    };
  }
  try {
    const r = analyzeGateRunCoverage(loadOrBuildGateRunCoverageStats(repoRoot));
    return { messages: gateRunCoverageMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["gate-run-coverage - violation: harness.db gate run coverage could not be read"],
      ok: false,
    };
  }
}

function loadOrBuildGateRunCoverageStats(repoRoot: string) {
  const dbPath = defaultHarnessDbPath(repoRoot);
  const needsRebuild = !existsSync(dbPath);
  const db = openHarnessDb(dbPath, { repoRoot });
  try {
    if (needsRebuild) rebuildHarnessDb({ repoRoot, db });
    const gateRuns = count(db, "SELECT COUNT(*) AS value FROM gate_runs");
    const workflowRuns = count(db, "SELECT COUNT(*) AS value FROM workflow_runs");
    const workflowPlansWithoutGateRun = count(
      db,
      `SELECT COUNT(*) AS value
       FROM (
         SELECT DISTINCT w.plan_id
         FROM workflow_runs w
         WHERE COALESCE(w.plan_id, '') <> ''
           AND NOT EXISTS (
             SELECT 1 FROM gate_runs g WHERE g.plan_id = w.plan_id
           )
       )`,
    );
    const orphanGateRuns = count(
      db,
      `SELECT COUNT(*) AS value
       FROM gate_runs g
       WHERE COALESCE(g.plan_id, '') <> ''
         AND NOT EXISTS (
           SELECT 1 FROM plan_registry p WHERE p.plan_id = g.plan_id
         )`,
    );
    const blankPlanGateRuns = count(
      db,
      "SELECT COUNT(*) AS value FROM gate_runs WHERE COALESCE(plan_id, '') = ''",
    );
    const invalidEvidenceFindings = count(
      db,
      "SELECT COUNT(*) AS value FROM findings WHERE kind = 'invalid-gate-run-evidence' AND status = 'open'",
    );
    return {
      gateRuns,
      workflowRuns,
      workflowPlansWithoutGateRun,
      orphanGateRuns,
      blankPlanGateRuns,
      invalidEvidenceFindings,
    };
  } finally {
    db.close();
  }
}

function count(db: HarnessDb, sql: string): number {
  const row = db.prepare(sql).get() as { value?: number } | undefined;
  return Number(row?.value ?? 0);
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

export function checkSubDocSchemaIntegrity(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["sub-doc-schema-integrity - violation: repo root could not be read"],
      ok: false,
    };
  }
  try {
    const r = analyzeSubDocSchemaIntegrity(loadSubDocSchemaIntegrityInput(repoRoot));
    return { messages: subDocSchemaIntegrityMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["sub-doc-schema-integrity - violation: design docs could not be read"],
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
