import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkFrontendDesignCoverage,
  checkG8IntegrationWorkflow,
  checkG9SystemWorkflow,
  checkG10UxWorkflow,
  checkImprovementBacklog,
  checkLintWiring,
  checkProposalDocumentCoverage,
  checkRightArmGatePlanning,
} from "../src/doctor/workflow-quality";

describe("doctor workflow quality checks", () => {
  it("fails closed when workflow quality inputs cannot read the repo root", () => {
    const missingRoot = join(tmpdir(), `ut-tdd-doctor-workflow-quality-${Date.now()}-missing`);

    const checks = [
      ["improvement-backlog", checkImprovementBacklog(missingRoot)],
      ["right-arm-gate-planning", checkRightArmGatePlanning(missingRoot)],
      ["lint-wiring", checkLintWiring(missingRoot)],
      ["frontend-design-coverage", checkFrontendDesignCoverage(missingRoot)],
      ["proposal-document-coverage", checkProposalDocumentCoverage(missingRoot)],
      ["g8-integration-workflow", checkG8IntegrationWorkflow(missingRoot)],
      ["g9-system-workflow", checkG9SystemWorkflow(missingRoot)],
      ["g10-ux-workflow", checkG10UxWorkflow(missingRoot)],
    ] as const;

    for (const [name, result] of checks) {
      expect(result.ok, name).toBe(false);
      expect(result.messages.join("\n"), name).toMatch(/violation/i);
    }
  });
});
