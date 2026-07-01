import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyzeL6Completion, l6CompletionMessages } from "../src/lint/l6-completion";

const gatePass = `
| Gate | Status | Evidence |
|---|---|---|
| G6 | PASS | A-200 |
`;

const gateNotReached = `
| Gate | Status | Evidence |
|---|---|---|
| G6 | not reached | - |
`;

describe("L6 completion readiness", () => {
  it("requires confirmed L6 docs, owning PLAN refs, L7 doc refs, confirmed PLANs, confirmed L7, and G6 PASS", () => {
    const result = analyzeL6Completion({
      l6Docs: [
        {
          path: "docs/design/harness/L6-function-design/function-spec.md",
          text: "status: draft\n",
        },
        {
          path: "docs/design/harness/L6-function-design/edge-case.md",
          text: "status: confirmed\n",
        },
      ],
      l6Plans: [
        {
          path: "docs/plans/PLAN-L6-01-function-spec.md",
          text: "plan_id: PLAN-L6-01-function-spec\nkind: design\nstatus: draft\n",
        },
      ],
      l7Text: "status: draft\n",
      gateText: gateNotReached,
    });

    expect(result.ready).toBe(false);
    expect(result.freezeInputReady).toBe(false);
    expect(result.draftDocs).toEqual(["docs/design/harness/L6-function-design/function-spec.md"]);
    expect(result.missingDocPlans).toEqual([
      "docs/design/harness/L6-function-design/edge-case.md",
      "docs/design/harness/L6-function-design/function-spec.md",
    ]);
    expect(result.missingDocPairArtifacts).toEqual([
      "docs/design/harness/L6-function-design/edge-case.md",
      "docs/design/harness/L6-function-design/function-spec.md",
    ]);
    expect(result.missingL7DocRefs).toEqual([
      "docs/design/harness/L6-function-design/edge-case.md",
      "docs/design/harness/L6-function-design/function-spec.md",
    ]);
    expect(result.weakContractDocs).toEqual([
      "docs/design/harness/L6-function-design/edge-case.md",
      "docs/design/harness/L6-function-design/function-spec.md",
    ]);
    expect(result.draftPlans).toEqual(["PLAN-L6-01-function-spec"]);
    expect(result.l7Status).toBe("draft");
    expect(result.g6Status).toBe("not reached");
    expect(l6CompletionMessages(result)[0]).toContain("not ready");
  });

  it("reports ready when all G6 readiness inputs are closed", () => {
    const result = analyzeL6Completion({
      l6Docs: [
        {
          path: "docs/design/harness/L6-function-design/function-spec.md",
          text: [
            "status: confirmed",
            "pair_artifact: docs/test-design/harness/L7-unit-test-design.md",
            "plan: docs/plans/PLAN-L6-01-function-spec.md",
            "L6 contract marker: planDraft(input: PlanDraftInput) => PlanDraftResult. DbC pre/post. L7 oracle family: U-FUNC-001.",
          ].join("\n"),
        },
      ],
      l6Plans: [
        {
          path: "docs/plans/PLAN-L6-01-function-spec.md",
          text: [
            "plan_id: PLAN-L6-01-function-spec",
            "kind: design",
            "status: confirmed",
            "review_evidence:",
            "  - reviewer: pmo-sonnet",
          ].join("\n"),
        },
      ],
      l7Text: "status: confirmed\nfunction-spec.md\n",
      gateText: gatePass,
    });

    expect(result.ready).toBe(true);
    expect(result.freezeInputReady).toBe(true);
    expect(l6CompletionMessages(result)[0]).toContain("OK");
  });

  it("reports freeze-input readiness separately from final G6 completion", () => {
    const result = analyzeL6Completion({
      l6Docs: [
        {
          path: "docs/design/harness/L6-function-design/function-spec.md",
          text: [
            "status: draft",
            "pair_artifact: docs/test-design/harness/L7-unit-test-design.md",
            "plan: docs/plans/PLAN-L6-01-function-spec.md",
            "L6 contract marker: planDraft(input: PlanDraftInput) => PlanDraftResult. DbC pre/post. L7 oracle family: U-FUNC-001.",
          ].join("\n"),
        },
      ],
      l6Plans: [
        {
          path: "docs/plans/PLAN-L6-01-function-spec.md",
          text: "plan_id: PLAN-L6-01-function-spec\nkind: design\nstatus: draft\n",
        },
      ],
      l7Text: "status: draft\nfunction-spec.md\n",
      gateText: gateNotReached,
    });

    expect(result.freezeInputReady).toBe(true);
    expect(result.ready).toBe(false);
    expect(l6CompletionMessages(result)).toContain(
      "l6-completion — freeze-inputs OK (trace/substance before status flip)",
    );
  });

  it("does not reopen base G6 completion for post-G6 add-design draft PLANs", () => {
    const result = analyzeL6Completion({
      l6Docs: [
        {
          path: "docs/design/harness/L6-function-design/function-spec.md",
          text: [
            "status: confirmed",
            "pair_artifact: docs/test-design/harness/L7-unit-test-design.md",
            "plan: docs/plans/PLAN-L6-01-function-spec.md",
            "L6 contract marker: planDraft(input: PlanDraftInput) => PlanDraftResult. DbC pre/post. L7 oracle family: U-FUNC-001.",
          ].join("\n"),
        },
      ],
      l6Plans: [
        {
          path: "docs/plans/PLAN-L6-01-function-spec.md",
          text: [
            "plan_id: PLAN-L6-01-function-spec",
            "kind: design",
            "status: confirmed",
            "review_evidence:",
            "  - reviewer: pmo-sonnet",
          ].join("\n"),
        },
        {
          path: "docs/plans/PLAN-L6-24-structured-error-handling.md",
          text: "plan_id: PLAN-L6-24-structured-error-handling\nkind: add-design\nstatus: draft\n",
        },
      ],
      l7Text: "status: confirmed\nfunction-spec.md\n",
      gateText: gatePass,
    });

    expect(result.ready).toBe(true);
    expect(result.draftPlans).toEqual([]);
  });

  it("cites the screen-spec U-SCREEN oracle family in L6 and L7 docs", () => {
    const screenSpec = readFileSync(
      "docs/design/harness/L6-function-design/screen-spec.md",
      "utf8",
    );
    const l7 = readFileSync("docs/test-design/harness/L7-unit-test-design.md", "utf8");
    const ids = [
      "U-SCREEN-001",
      "U-SCREEN-002",
      "U-SCREEN-003",
      "U-SCREEN-004",
      "U-SCREEN-005",
      "U-SCREEN-006",
    ];

    for (const id of ids) {
      expect(screenSpec).toContain(id);
      expect(l7).toContain(id);
    }
  });
});
