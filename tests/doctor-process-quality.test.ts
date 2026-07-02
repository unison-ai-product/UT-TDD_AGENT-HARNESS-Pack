import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDriveModelPassage as checkDriveModelPassageFromIndex } from "../src/doctor/index";
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
} from "../src/doctor/process-quality";

describe("doctor process quality checks", () => {
  it("fails closed when process quality inputs cannot read the repo root", () => {
    const missingRoot = join(tmpdir(), `ut-tdd-doctor-process-quality-${Date.now()}-missing`);

    const checks = [
      ["plan-dod", checkPlanDod(missingRoot)],
      ["placeholder-deps", checkPlaceholderDeps(missingRoot)],
      ["g1-trace", checkPlanTraceGate(missingRoot, "G1-trace")],
      ["g3-trace", checkPlanTraceGate(missingRoot, "G3-trace")],
      ["rule-automation-closure", checkRuleAutomationClosure(missingRoot)],
      ["drive-model-passage", checkDriveModelPassage(missingRoot)],
      ["drive-db-registration", checkDriveDbRegistration(missingRoot)],
      ["fr-roadmap-coverage", checkFrRoadmapCoverage(missingRoot)],
      ["telemetry-closure", checkTelemetryClosure(missingRoot)],
      ["cycle-p4-verification", checkCycleP4Verification(missingRoot)],
      ["l14-close-audit", checkL14CloseAudit(missingRoot)],
      ["l6-fr-coverage", checkL6FrCoverage(missingRoot)],
      ["feedback-log", checkFeedbackLog(missingRoot)],
      ["l6-completion", checkL6Completion(missingRoot)],
      ["l7-completion", checkL7Completion(missingRoot)],
      ["sub-doc-catalog-drift", checkSubDocCatalogDrift(missingRoot)],
      ["sub-doc-section-structure", checkSubDocSectionStructure(missingRoot)],
      ["screen-impl-pair-freeze", checkScreenImplPairFreeze(missingRoot)],
    ] as const;

    for (const [name, result] of checks) {
      expect(result.ok, name).toBe(false);
      expect(result.messages.join("\n"), name).toMatch(/violation/i);
    }
  });

  it("keeps the doctor index re-export path available", () => {
    const missingRoot = join(tmpdir(), `ut-tdd-doctor-process-quality-index-${Date.now()}-missing`);

    const result = checkDriveModelPassageFromIndex(missingRoot);

    expect(result.ok).toBe(false);
    expect(result.messages.join("\n")).toContain("drive-model-passage - violation");
  });
});
