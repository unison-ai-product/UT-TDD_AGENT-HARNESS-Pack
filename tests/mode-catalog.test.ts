/**
 * PLAN-L7-243: mode (駆動モデル) の第一級化 (A-173 F-9 latent-defect の是正)。
 *
 * Oracle:
 *   - drive_runs.mode の導出は route_mode (frontmatter 正本) を最優先し、
 *     legacy PLAN は plan_id prefix → kind の順でフォールバックする。
 *   - kind=refactor / troubleshoot が Forward へ誤投影されない (旧 4 分岐の損失解消)。
 *   - docs/process/modes/ の mode doc は全件 MODE_CATALOG_DOC_FILES 写像を持ち、
 *     新 mode doc 追加時の取りこぼしを drive-db-registration lint が fail-close 検出する。
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeDriveDbRegistration } from "../src/lint/drive-db-registration";
import {
  MODE_CATALOG_DOC_FILES,
  ROUTE_MODE_DISPLAY,
  unmappedModeCatalogDocs,
  workflowModeForPlan,
} from "../src/schema/mode-catalog";
import { ROUTE_SIGNAL_MAP } from "../src/schema/route-map";

describe("PLAN-L7-243: mode catalog derivation", () => {
  it("route_mode frontmatter wins over plan_id prefix and kind", () => {
    expect(
      workflowModeForPlan({ planId: "PLAN-L7-900-x", routeMode: "refactor", kind: "impl" }),
    ).toBe("Refactor");
    expect(
      workflowModeForPlan({ planId: "PLAN-L7-901-x", routeMode: "add-feature", kind: "add-impl" }),
    ).toBe("Add-feature");
    expect(
      workflowModeForPlan({ planId: "PLAN-L7-902-x", routeMode: "version-up", kind: "impl" }),
    ).toBe("Version-up");
  });

  it("legacy plans without route_mode fall back to plan_id prefix then kind", () => {
    expect(workflowModeForPlan({ planId: "PLAN-DISCOVERY-01-x" })).toBe("Discovery");
    expect(workflowModeForPlan({ planId: "PLAN-REVERSE-56-x" })).toBe("Reverse");
    expect(workflowModeForPlan({ planId: "PLAN-RECOVERY-06-x" })).toBe("Recovery");
    expect(workflowModeForPlan({ planId: "PLAN-M-01-cutover" })).toBe("Verification");
    // A-173 F-9: kind=refactor / troubleshoot の Forward 誤投影を解消する分岐。
    expect(workflowModeForPlan({ planId: "PLAN-L7-230-x", kind: "refactor" })).toBe("Refactor");
    expect(workflowModeForPlan({ planId: "PLAN-L7-231-x", kind: "troubleshoot" })).toBe("Incident");
    expect(workflowModeForPlan({ planId: "PLAN-L7-232-x", kind: "retrofit" })).toBe("Retrofit");
    expect(workflowModeForPlan({ planId: "PLAN-L4-01-x", kind: "design" })).toBe("Forward");
    expect(workflowModeForPlan({ planId: "PLAN-L7-01-x", kind: "impl" })).toBe("Forward");
  });

  it("every route-map mode token has a display mapping (drift guard)", () => {
    const mappedTokens = Object.keys(ROUTE_MODE_DISPLAY);
    for (const entry of ROUTE_SIGNAL_MAP) {
      expect(mappedTokens, `route-map mode ${entry.mode}`).toContain(entry.mode);
    }
  });

  it("every mode doc in docs/process/modes is mapped (real-repo catalog sync)", () => {
    const files = readdirSync(join(process.cwd(), "docs", "process", "modes"));
    expect(unmappedModeCatalogDocs(files)).toEqual([]);
    for (const file of Object.keys(MODE_CATALOG_DOC_FILES)) {
      expect(files, `catalog doc ${file}`).toContain(file);
    }
  });

  it("drive-db-registration fails closed on expected-mode gaps and unmapped catalog docs", () => {
    const base = {
      planCount: 1,
      driveRuns: 1,
      plansWithoutDriveRun: 0,
      workflowRuns: 1,
      workflowOrphans: 0,
      modelRuns: 1,
      modelOrphans: 0,
      skillRecommendations: 1,
      skillRecommendationOrphans: 0,
      skillInvocations: 1,
      skillInvocationOrphans: 0,
      registeredHookEvents: 1,
      hookOrphans: 0,
      modes: ["Forward"],
    };

    const gap = analyzeDriveDbRegistration({
      ...base,
      expectedModes: ["Forward", "Refactor"],
      unmappedCatalogDocs: [],
    });
    expect(gap.ok).toBe(false);
    expect(gap.violations).toContainEqual({ reason: "missing_required_mode", mode: "Refactor" });

    const unmapped = analyzeDriveDbRegistration({
      ...base,
      expectedModes: ["Forward"],
      unmappedCatalogDocs: ["new-mode.md"],
    });
    expect(unmapped.ok).toBe(false);
    expect(unmapped.violations).toContainEqual({
      reason: "mode_catalog_unmapped",
      mode: "new-mode.md",
    });

    const green = analyzeDriveDbRegistration({
      ...base,
      expectedModes: ["Forward"],
      unmappedCatalogDocs: [],
    });
    expect(green.ok).toBe(true);
  });
});
