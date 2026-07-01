import { describe, expect, it } from "vitest";
import {
  analyzeG10UxWorkflow,
  g10UxWorkflowMessages,
  loadG10UxWorkflowInput,
} from "../src/lint/g10-ux-workflow";

const workflowBlock = [
  "## G10-WORKFLOW",
  "test_strategy: risk-based UX verification tied to L2 screen contracts and L4 FE design standards.",
  "test_plan: select UXV cases by visual, token, accessibility, visual-regression, and UX-review risk.",
  "test_conditions: each selected UXV case has a concrete rendered or reviewable evidence path.",
  "coverage_items: UXV-* coverage is mapped to visual, token, a11y, VRT, and UX review families.",
  "test_procedures: run the mapped vitest/doctor/render/review commands and capture exit codes.",
  "execution_evidence: UX evidence manifest records command, UXV IDs, paths, and result.",
  "exit_criteria: all mandatory selected UXV cases pass or explicit defer exists.",
  "defect_routing: failed UXV cases route to L10 correction, L2/L4 back-prop, Reverse, or Incident by scope.",
].join("\n");

const gateBlock = ["G10-WORKFLOW", "UX evidence manifest", "UXV-* coverage", "exit blocks"].join(
  "\n",
);

const uxvRows = [
  "| UXV-VISUAL-01 | Given | When | Then |",
  "| UXV-TOKEN-01 | Given | When | Then |",
  "| UXV-A11Y-01 | Given | When | Then |",
  "| UXV-VRT-01 | Given | When | Then |",
  "| UXV-REVIEW-01 | Given | When | Then |",
].join("\n");

const validManifest = {
  manifest_path: ".ut-tdd/evidence/g10-ux/test.json",
  schema_version: "g10-ux-evidence-v1",
  gate: "G10",
  profile: "ux-minimum",
  plan_id: "PLAN-L7-184-g10-ux-workflow",
  selected_uxv_ids: ["UXV-VISUAL-01", "UXV-TOKEN-01", "UXV-A11Y-01", "UXV-VRT-01", "UXV-REVIEW-01"],
  mandatory_uxv_ids: [
    "UXV-VISUAL-01",
    "UXV-TOKEN-01",
    "UXV-A11Y-01",
    "UXV-VRT-01",
    "UXV-REVIEW-01",
  ],
  deferred_uxv_ids: [],
  commands: [
    {
      command_id: "cmd-ux-minimum-targeted",
      command:
        "bun run vitest run tests\\frontend-design-coverage.test.ts tests\\workflow-contracts.test.ts tests\\screen-impl-pair-freeze.test.ts tests\\g10-ux-workflow.test.ts",
      runner: "bun",
      scope: "targeted",
      exit_code: 0,
      evidence_path: "tests/g10-ux-workflow.test.ts",
      output_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      uxv_ids: ["UXV-VISUAL-01", "UXV-TOKEN-01", "UXV-A11Y-01", "UXV-VRT-01", "UXV-REVIEW-01"],
    },
  ],
  coverage: [
    {
      uxv_id: "UXV-VISUAL-01",
      status: "passed",
      evidence_paths: ["tests/frontend-design-coverage.test.ts"],
      command_ids: ["cmd-ux-minimum-targeted"],
    },
    {
      uxv_id: "UXV-TOKEN-01",
      status: "passed",
      evidence_paths: ["tests/workflow-contracts.test.ts"],
      command_ids: ["cmd-ux-minimum-targeted"],
    },
    {
      uxv_id: "UXV-A11Y-01",
      status: "passed",
      evidence_paths: ["tests/workflow-contracts.test.ts"],
      command_ids: ["cmd-ux-minimum-targeted"],
    },
    {
      uxv_id: "UXV-VRT-01",
      status: "passed",
      evidence_paths: ["tests/screen-impl-pair-freeze.test.ts"],
      command_ids: ["cmd-ux-minimum-targeted"],
    },
    {
      uxv_id: "UXV-REVIEW-01",
      status: "passed",
      evidence_paths: ["tests/g10-ux-workflow.test.ts"],
      command_ids: ["cmd-ux-minimum-targeted"],
    },
  ],
  exit_criteria: {
    all_mandatory_passed: true,
    failed_mandatory_count: 0,
    stale_defer_count: 0,
    doctor_check: "g10-ux-workflow",
  },
};

describe("g10-ux-workflow lint", () => {
  it("fails when L10 has UXV rows but no executable G10 workflow granularity", () => {
    const result = analyzeG10UxWorkflow({
      repoRoot: process.cwd(),
      l10Design: uxvRows,
      gatesMd: "G10 remains concept-only.",
      evidenceManifests: [],
    });

    expect(result.ok).toBe(false);
    expect(result.missingWorkflowMarkers).toContain("test_strategy");
    expect(result.missingGateMarkers).toContain("UX evidence manifest");
    expect(g10UxWorkflowMessages(result)[0]).toContain("violation");
  });

  it("fails when workflow markers exist but the UX evidence manifest is missing", () => {
    const result = analyzeG10UxWorkflow({
      repoRoot: process.cwd(),
      l10Design: `${workflowBlock}\n${uxvRows}`,
      gatesMd: gateBlock,
      evidenceManifests: [],
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toContain(
      "G10 UX evidence manifest is missing under .ut-tdd/evidence/g10-ux",
    );
  });

  it("fails when mandatory UXV coverage is not passed", () => {
    const result = analyzeG10UxWorkflow({
      repoRoot: process.cwd(),
      l10Design: `${workflowBlock}\n${uxvRows}`,
      gatesMd: gateBlock,
      evidenceManifests: [
        {
          ...validManifest,
          coverage: validManifest.coverage.map((entry) =>
            entry.uxv_id === "UXV-A11Y-01" ? { ...entry, status: "failed" } : entry,
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
    expect(result.violations.join("\n")).toContain("mandatory coverage UXV-A11Y-01 is not passed");
  });

  it("fails when required UXV families are missing across all manifests", () => {
    const result = analyzeG10UxWorkflow({
      repoRoot: process.cwd(),
      l10Design: `${workflowBlock}\n${uxvRows}`,
      gatesMd: gateBlock,
      evidenceManifests: [
        {
          ...validManifest,
          selected_uxv_ids: ["UXV-VISUAL-01"],
          mandatory_uxv_ids: ["UXV-VISUAL-01"],
          coverage: validManifest.coverage.filter((entry) => entry.uxv_id === "UXV-VISUAL-01"),
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toContain("G10 selected UXV coverage missing UXV-TOKEN- family");
    expect(result.violations).toContain("G10 mandatory UXV coverage missing UXV-REVIEW- family");
  });

  it("passes when L10 workflow, G10 gate markers, and UX evidence manifest are explicit", () => {
    const result = analyzeG10UxWorkflow({
      repoRoot: process.cwd(),
      l10Design: `${workflowBlock}\n${uxvRows}`,
      gatesMd: gateBlock,
      evidenceManifests: [validManifest],
    });

    expect(result.ok).toBe(true);
    expect(result.uxvCaseCount).toBe(5);
    expect(result.manifestCount).toBe(1);
    expect(result.selectedUxvCount).toBe(5);
    expect(g10UxWorkflowMessages(result)[0]).toContain("OK");
  });

  it("live repo keeps the G10 workflow contract present", () => {
    const result = analyzeG10UxWorkflow(loadG10UxWorkflowInput());

    expect(result.ok).toBe(true);
    expect(result.uxvCaseCount).toBeGreaterThanOrEqual(5);
  });
});
