import { describe, expect, it } from "vitest";
import {
  analyzeG9SystemWorkflow,
  g9SystemWorkflowMessages,
  loadG9SystemWorkflowInput,
} from "../src/lint/g9-system-workflow";

const workflowBlock = [
  "## G9-WORKFLOW",
  "test_strategy: risk-based system verification tied to L4 basic-design contracts.",
  "test_plan: select ST cases by system behavior family and cross-module workflow risk.",
  "test_conditions: each selected ST case has Given/When/Then and whole-system fixture.",
  "coverage_items: ST-* coverage is mapped to data, architecture, function, asset, and external-boundary families.",
  "test_procedures: run the mapped vitest/doctor/CI commands and capture exit codes.",
  "execution_evidence: system evidence manifest records command, ST IDs, paths, and result.",
  "exit_criteria: all mandatory selected ST cases pass or explicit defer exists.",
  "defect_routing: failed ST cases route to L9 correction, Reverse, Refactor, Recovery, or Incident by scope.",
].join("\n");

const gateBlock = ["G9-WORKFLOW", "system evidence manifest", "ST-* coverage", "exit blocks"].join(
  "\n",
);

const stRows = [
  "| ST-DATA-01 | Given | When | Then |",
  "| ST-DATA-02 | Given | When | Then |",
  "| ST-ARCH-01 | Given | When | Then |",
  "| ST-ARCH-02 | Given | When | Then |",
  "| ST-FUNC-01 | Given | When | Then |",
  "| ST-FUNC-04 | Given | When | Then |",
  "| ST-ASSET-01 | Given | When | Then |",
  "| ST-ASSET-02 | Given | When | Then |",
  "| ST-EXT-01 | Given | When | Then |",
  "| ST-EXT-02 | Given | When | Then |",
].join("\n");
const stRowIds = [
  "ST-DATA-01",
  "ST-DATA-02",
  "ST-ARCH-01",
  "ST-ARCH-02",
  "ST-FUNC-01",
  "ST-FUNC-04",
  "ST-ASSET-01",
  "ST-ASSET-02",
  "ST-EXT-01",
  "ST-EXT-02",
];

const validManifest = {
  manifest_path: ".ut-tdd/evidence/g9-system/test.json",
  schema_version: "g9-system-evidence-v1",
  gate: "G9",
  profile: "st-system-minimum",
  plan_id: "PLAN-L7-179-g9-system-workflow",
  selected_st_ids: ["ST-DATA-05", "ST-ARCH-01", "ST-FUNC-04", "ST-ASSET-02", "ST-EXT-02"],
  mandatory_st_ids: ["ST-DATA-05", "ST-ARCH-01", "ST-FUNC-04", "ST-ASSET-02", "ST-EXT-02"],
  deferred_st_ids: [],
  commands: [
    {
      command_id: "cmd-system-minimum-targeted",
      command:
        "bun run vitest run tests\\review-evidence.test.ts tests\\dependency-drift.test.ts tests\\workflow-contracts.test.ts tests\\asset-drift.test.ts tests\\runtime-adapter.test.ts tests\\g9-system-workflow.test.ts",
      runner: "bun",
      scope: "targeted",
      exit_code: 0,
      evidence_path: "tests/g9-system-workflow.test.ts",
      output_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      st_ids: ["ST-DATA-05", "ST-ARCH-01", "ST-FUNC-04", "ST-ASSET-02", "ST-EXT-02"],
    },
  ],
  coverage: [
    {
      st_id: "ST-DATA-05",
      status: "passed",
      evidence_paths: ["tests/review-evidence.test.ts"],
      command_ids: ["cmd-system-minimum-targeted"],
    },
    {
      st_id: "ST-ARCH-01",
      status: "passed",
      evidence_paths: ["tests/dependency-drift.test.ts"],
      command_ids: ["cmd-system-minimum-targeted"],
    },
    {
      st_id: "ST-FUNC-04",
      status: "passed",
      evidence_paths: ["tests/workflow-contracts.test.ts"],
      command_ids: ["cmd-system-minimum-targeted"],
    },
    {
      st_id: "ST-ASSET-02",
      status: "passed",
      evidence_paths: ["tests/asset-drift.test.ts"],
      command_ids: ["cmd-system-minimum-targeted"],
    },
    {
      st_id: "ST-EXT-02",
      status: "passed",
      evidence_paths: ["tests/runtime-adapter.test.ts"],
      command_ids: ["cmd-system-minimum-targeted"],
    },
  ],
  exit_criteria: {
    all_mandatory_passed: true,
    failed_mandatory_count: 0,
    stale_defer_count: 0,
    doctor_check: "g9-system-workflow",
  },
};

const fullRowManifest = {
  ...validManifest,
  selected_st_ids: stRowIds,
  mandatory_st_ids: stRowIds,
  commands: validManifest.commands.map((command) => ({
    ...command,
    st_ids: stRowIds,
  })),
  coverage: stRowIds.map((stId) => ({
    st_id: stId,
    status: "passed",
    evidence_paths: ["tests/g9-system-workflow.test.ts"],
    command_ids: ["cmd-system-minimum-targeted"],
  })),
};

describe("g9-system-workflow lint", () => {
  it("fails when L9 has ST rows but no executable G9 workflow granularity", () => {
    const result = analyzeG9SystemWorkflow({
      repoRoot: process.cwd(),
      l9TestDesign: stRows,
      gatesMd: "G9 remains concept-only.",
      evidenceManifests: [],
    });

    expect(result.ok).toBe(false);
    expect(result.missingWorkflowMarkers).toContain("test_strategy");
    expect(result.missingGateMarkers).toContain("system evidence manifest");
    expect(g9SystemWorkflowMessages(result)[0]).toContain("violation");
  });

  it("fails when workflow markers exist but the system evidence manifest is missing", () => {
    const result = analyzeG9SystemWorkflow({
      repoRoot: process.cwd(),
      l9TestDesign: `${workflowBlock}\n${stRows}`,
      gatesMd: gateBlock,
      evidenceManifests: [],
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toContain(
      "G9 system evidence manifest is missing under .ut-tdd/evidence/g9-system",
    );
  });

  it("fails when mandatory ST coverage is not passed", () => {
    const result = analyzeG9SystemWorkflow({
      repoRoot: process.cwd(),
      l9TestDesign: `${workflowBlock}\n${stRows}`,
      gatesMd: gateBlock,
      evidenceManifests: [
        {
          ...fullRowManifest,
          coverage: fullRowManifest.coverage.map((entry) =>
            entry.st_id === "ST-FUNC-04" ? { ...entry, status: "failed" } : entry,
          ),
          exit_criteria: {
            ...fullRowManifest.exit_criteria,
            all_mandatory_passed: false,
            failed_mandatory_count: 1,
          },
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.violations.join("\n")).toContain("mandatory coverage ST-FUNC-04 is not passed");
  });

  it("fails when required ST families are missing across all manifests", () => {
    const result = analyzeG9SystemWorkflow({
      repoRoot: process.cwd(),
      l9TestDesign: `${workflowBlock}\n${stRows}`,
      gatesMd: gateBlock,
      evidenceManifests: [
        {
          ...validManifest,
          selected_st_ids: ["ST-DATA-05"],
          mandatory_st_ids: ["ST-DATA-05"],
          coverage: validManifest.coverage.filter((entry) => entry.st_id === "ST-DATA-05"),
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toContain("G9 selected ST coverage missing ST-ARCH- family");
    expect(result.violations).toContain("G9 mandatory ST coverage missing ST-EXT- family");
  });

  it("fails when a designed ST row has neither mandatory evidence nor an explicit defer", () => {
    const result = analyzeG9SystemWorkflow({
      repoRoot: process.cwd(),
      l9TestDesign: `${workflowBlock}\n${stRows}`,
      gatesMd: gateBlock,
      evidenceManifests: [
        {
          ...fullRowManifest,
          selected_st_ids: stRowIds.filter((stId) => stId !== "ST-ARCH-02"),
          mandatory_st_ids: stRowIds.filter((stId) => stId !== "ST-ARCH-02"),
          coverage: fullRowManifest.coverage.filter((entry) => entry.st_id !== "ST-ARCH-02"),
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toContain(
      "G9 designed ST row lacks mandatory/deferred evidence: ST-ARCH-02",
    );
  });

  it("passes when L9 workflow, G9 gate markers, and ST evidence manifest are explicit", () => {
    const result = analyzeG9SystemWorkflow({
      repoRoot: process.cwd(),
      l9TestDesign: `${workflowBlock}\n${stRows}`,
      gatesMd: gateBlock,
      evidenceManifests: [fullRowManifest],
    });

    expect(result.ok).toBe(true);
    expect(result.stCaseCount).toBe(10);
    expect(result.manifestCount).toBe(1);
    expect(result.selectedStCount).toBe(10);
    expect(g9SystemWorkflowMessages(result)[0]).toContain("OK");
  });

  it("allows GitHub Actions workflow paths as CI-boundary evidence", () => {
    const result = analyzeG9SystemWorkflow({
      repoRoot: process.cwd(),
      l9TestDesign: `${workflowBlock}\n${stRows}`,
      gatesMd: gateBlock,
      evidenceManifests: [
        {
          ...fullRowManifest,
          commands: fullRowManifest.commands.map((command) => ({
            ...command,
            evidence_path: ".github/workflows/harness-check.yml",
          })),
          coverage: fullRowManifest.coverage.map((entry) => ({
            ...entry,
            evidence_paths: [".github/workflows/harness-check.yml"],
          })),
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("live repo keeps the G9 workflow contract present", () => {
    const result = analyzeG9SystemWorkflow(loadG9SystemWorkflowInput());

    expect(result.ok).toBe(true);
    expect(result.stCaseCount).toBeGreaterThanOrEqual(10);
  });
});
