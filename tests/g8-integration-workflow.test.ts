import { describe, expect, it } from "vitest";
import {
  analyzeG8IntegrationWorkflow,
  g8IntegrationWorkflowMessages,
  loadG8IntegrationWorkflowInput,
} from "../src/lint/g8-integration-workflow";

const workflowBlock = [
  "## G8-WORKFLOW",
  "test_strategy: risk-based integration verification tied to L5 contracts.",
  "test_plan: select IT cases by changed boundary and required quality signal.",
  "test_conditions: each selected IT case has Given/When/Then and boundary fixture.",
  "coverage_items: IT-* coverage is mapped to module, state, adapter, asset, and DB boundaries.",
  "test_procedures: run the mapped vitest/doctor/profile commands and capture exit codes.",
  "execution_evidence: integration evidence manifest records command, IT IDs, paths, and result.",
  "exit_criteria: all mandatory selected IT cases pass or explicit defer exists.",
  "defect_routing: failed IT cases route to L8 correction, Reverse, Refactor, or Incident by scope.",
].join("\n");

const gateBlock = [
  "G8-WORKFLOW",
  "integration evidence manifest",
  "IT-* coverage",
  "exit blocks",
].join("\n");

const itRows = Array.from(
  { length: 10 },
  (_, i) => `| IT-MODULE-${String(i + 1).padStart(2, "0")} | Given | When | Then |`,
).join("\n");

const validManifest = {
  manifest_path: ".ut-tdd/evidence/g8-integration/test.json",
  schema_version: "g8-integration-evidence-v1",
  gate: "G8",
  profile: "it-module-state-minimum",
  plan_id: "PLAN-L7-169-g8-integration-evidence-manifest",
  selected_it_ids: ["IT-MODULE-01", "IT-MODULE-02", "IT-STATE-01", "IT-STATE-02"],
  mandatory_it_ids: ["IT-MODULE-01", "IT-MODULE-02", "IT-STATE-01", "IT-STATE-02"],
  deferred_it_ids: [],
  commands: [
    {
      command_id: "cmd-module-state-targeted",
      command:
        "bun run vitest run tests\\dependency-drift.test.ts tests\\lint-wiring.test.ts tests\\agent-slots.test.ts tests\\workflow-contracts.test.ts",
      runner: "bun",
      scope: "targeted",
      exit_code: 0,
      evidence_path: "tests/g8-integration-workflow.test.ts",
      output_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      it_ids: ["IT-MODULE-01", "IT-MODULE-02", "IT-STATE-01", "IT-STATE-02"],
    },
  ],
  coverage: [
    {
      it_id: "IT-MODULE-01",
      status: "passed",
      evidence_paths: ["tests/dependency-drift.test.ts"],
      command_ids: ["cmd-module-state-targeted"],
    },
    {
      it_id: "IT-MODULE-02",
      status: "passed",
      evidence_paths: ["tests/lint-wiring.test.ts"],
      command_ids: ["cmd-module-state-targeted"],
    },
    {
      it_id: "IT-STATE-01",
      status: "passed",
      evidence_paths: ["tests/agent-slots.test.ts"],
      command_ids: ["cmd-module-state-targeted"],
    },
    {
      it_id: "IT-STATE-02",
      status: "passed",
      evidence_paths: ["tests/workflow-contracts.test.ts"],
      command_ids: ["cmd-module-state-targeted"],
    },
  ],
  exit_criteria: {
    all_mandatory_passed: true,
    failed_mandatory_count: 0,
    stale_defer_count: 0,
    doctor_check: "g8-integration-workflow",
  },
};

const assetManifest = {
  manifest_path: ".ut-tdd/evidence/g8-integration/asset.json",
  schema_version: "g8-integration-evidence-v1",
  gate: "G8",
  profile: "it-asset-expansion",
  plan_id: "PLAN-L7-171-g8-adapter-asset-evidence",
  selected_it_ids: ["IT-ASSET-05", "IT-ASSET-06"],
  mandatory_it_ids: ["IT-ASSET-05", "IT-ASSET-06"],
  deferred_it_ids: [],
  commands: [
    {
      command_id: "cmd-asset-targeted",
      command: "bun run vitest run tests\\skill-recommend.test.ts tests\\asset-drift.test.ts",
      runner: "bun",
      scope: "targeted",
      exit_code: 0,
      evidence_path: "tests/skill-recommend.test.ts",
      output_digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      it_ids: ["IT-ASSET-05", "IT-ASSET-06"],
    },
  ],
  coverage: [
    {
      it_id: "IT-ASSET-05",
      status: "passed",
      evidence_paths: ["tests/skill-recommend.test.ts"],
      command_ids: ["cmd-asset-targeted"],
    },
    {
      it_id: "IT-ASSET-06",
      status: "passed",
      evidence_paths: ["tests/asset-drift.test.ts"],
      command_ids: ["cmd-asset-targeted"],
    },
  ],
  exit_criteria: {
    all_mandatory_passed: true,
    failed_mandatory_count: 0,
    stale_defer_count: 0,
    doctor_check: "g8-integration-workflow",
  },
};

describe("g8-integration-workflow lint", () => {
  it("fails when L8 has IT rows but no executable G8 workflow granularity", () => {
    const result = analyzeG8IntegrationWorkflow({
      repoRoot: process.cwd(),
      l8TestDesign: itRows,
      gatesMd: "G8 remains concept-only.",
      evidenceManifests: [],
    });

    expect(result.ok).toBe(false);
    expect(result.missingWorkflowMarkers).toContain("test_strategy");
    expect(result.missingGateMarkers).toContain("integration evidence manifest");
    expect(g8IntegrationWorkflowMessages(result)[0]).toContain("violation");
  });

  it("fails when workflow markers exist but the integration evidence manifest is missing", () => {
    const result = analyzeG8IntegrationWorkflow({
      repoRoot: process.cwd(),
      l8TestDesign: `${workflowBlock}\n${itRows}`,
      gatesMd: gateBlock,
      evidenceManifests: [],
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toContain(
      "G8 integration evidence manifest is missing under .ut-tdd/evidence/g8-integration",
    );
  });

  it("fails when mandatory IT coverage is not passed", () => {
    const result = analyzeG8IntegrationWorkflow({
      repoRoot: process.cwd(),
      l8TestDesign: `${workflowBlock}\n${itRows}`,
      gatesMd: gateBlock,
      evidenceManifests: [
        {
          ...validManifest,
          coverage: validManifest.coverage.map((entry) =>
            entry.it_id === "IT-STATE-02" ? { ...entry, status: "failed" } : entry,
          ),
          exit_criteria: {
            ...validManifest.exit_criteria,
            all_mandatory_passed: false,
            failed_mandatory_count: 1,
          },
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.violations.join("\n")).toContain("mandatory coverage IT-STATE-02 is not passed");
  });

  it("passes when L8 workflow, G8 gate markers, and IT evidence manifest are explicit", () => {
    const result = analyzeG8IntegrationWorkflow({
      repoRoot: process.cwd(),
      l8TestDesign: `${workflowBlock}\n${itRows}`,
      gatesMd: gateBlock,
      evidenceManifests: [validManifest],
    });

    expect(result.ok).toBe(true);
    expect(result.itCaseCount).toBe(10);
    expect(result.manifestCount).toBe(1);
    expect(result.selectedItCount).toBe(4);
    expect(g8IntegrationWorkflowMessages(result)[0]).toContain("OK");
  });

  it("passes when required IT families are satisfied across split manifests", () => {
    const result = analyzeG8IntegrationWorkflow({
      repoRoot: process.cwd(),
      l8TestDesign: `${workflowBlock}\n${itRows}`,
      gatesMd: gateBlock,
      evidenceManifests: [validManifest, assetManifest],
    });

    expect(result.ok).toBe(true);
    expect(result.manifestCount).toBe(2);
    expect(result.selectedItCount).toBe(6);
    expect(result.mandatoryItCount).toBe(6);
  });

  it("fails when required IT families are missing across all manifests", () => {
    const result = analyzeG8IntegrationWorkflow({
      repoRoot: process.cwd(),
      l8TestDesign: `${workflowBlock}\n${itRows}`,
      gatesMd: gateBlock,
      evidenceManifests: [assetManifest],
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toContain("G8 selected IT coverage missing IT-MODULE- family");
    expect(result.violations).toContain("G8 mandatory IT coverage missing IT-STATE- family");
  });

  it("live repo keeps the G8 workflow contract present", () => {
    const result = analyzeG8IntegrationWorkflow(loadG8IntegrationWorkflowInput());

    expect(result.ok).toBe(true);
    expect(result.itCaseCount).toBeGreaterThanOrEqual(10);
  });
});
