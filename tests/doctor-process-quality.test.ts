import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDriveModelPassage as checkDriveModelPassageFromIndex } from "../src/doctor/index.ts";
import {
  checkCycleP4Verification,
  checkDbCurrency,
  checkDriveModelPassage,
  checkFeedbackLog,
  checkFrRoadmapCoverage,
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
} from "../src/doctor/process-quality.ts";
import { createTraceGateFixture, G1_G3_REQUIRED_DOC_CASES } from "./support/g1-g3-trace-fixture.ts";
import { removeTestTree } from "./support/temp-tree.ts";

describe("doctor process quality checks", () => {
  it.each(
    G1_G3_REQUIRED_DOC_CASES,
  )("U-PLANRET-028: $doctorGate passes control and rejects one missing trace doc", ({
    doctorGate,
    gate,
    missingPath,
    traceMessage,
  }) => {
    for (const omitted of [undefined, missingPath]) {
      const root = createTraceGateFixture(gate, omitted);
      try {
        const result = checkTraceGate(root, doctorGate);
        if (omitted === undefined) {
          expect(result.ok).toBe(true);
          expect(result.messages.join("\n")).toContain(doctorGate.toLowerCase() + " - OK");
          expect(result.messages).toContain(traceMessage);
        } else {
          expect(result.ok).toBe(false);
          expect(result.messages.join("\n")).toContain("required doc not created: " + missingPath);
        }
      } finally {
        removeTestTree(root);
      }
    }
  });

  it("fails closed when process quality inputs cannot read the repo root", () => {
    const missingRoot = join(tmpdir(), `ut-tdd-doctor-process-quality-${Date.now()}-missing`);

    const checks = [
      ["placeholder-deps", checkPlaceholderDeps(missingRoot)],
      ["g1-trace", checkTraceGate(missingRoot, "G1-trace")],
      ["g3-trace", checkTraceGate(missingRoot, "G3-trace")],
      ["rule-automation-closure", checkRuleAutomationClosure(missingRoot)],
      ["drive-model-passage", checkDriveModelPassage(missingRoot)],
      ["db-currency", checkDbCurrency(missingRoot)],
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

  it("db-currency checks existence without opening or rebuilding the DB", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-db-currency-existence-"));
    try {
      expect(checkDbCurrency(root)).toMatchObject({ ok: false });
      expect(checkDbCurrency(root).messages.join("\n")).toContain("missing_db");
      mkdirSync(join(root, ".ut-tdd"));
      const path = join(root, ".ut-tdd", "harness.db");
      writeFileSync(path, "not a SQLite database", "utf8");
      expect(checkDbCurrency(root)).toMatchObject({ ok: true });
      expect(readFileSync(path, "utf8")).toBe("not a SQLite database");
    } finally {
      removeTestTree(root);
    }
  });
});
