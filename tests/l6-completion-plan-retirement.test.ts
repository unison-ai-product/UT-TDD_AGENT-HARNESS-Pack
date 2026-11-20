import { describe, expect, it } from "vitest";
import { analyzeL6Completion } from "../src/lint/l6-completion.ts";

const gatePass = `
| Gate | Status | Evidence |
|---|---|---|
| G6 | PASS | A-200 |
`;

interface FixtureL6Doc {
  fileName: string;
  owner: string;
  pairArtifact: string;
  oracleId: string;
}

interface FixtureL7Doc {
  fileName: string;
  status?: string;
  body: string;
}

function l6FixtureText(doc: FixtureL6Doc): string {
  return [
    "---",
    "status: confirmed",
    doc.owner,
    `pair_artifact: ${doc.pairArtifact}`,
    "---",
    "",
    `L6 contract marker: resolve(input: string) => Result. DbC pre/post. Oracle family ${doc.oracleId}.`,
    "",
  ].join("\n");
}

function l7FixtureText(doc: FixtureL7Doc): string {
  return [
    "---",
    "layer: L6",
    "executed_at_layer: L7",
    "artifact_type: test_design",
    ...(doc.status ? [`status: ${doc.status}`] : []),
    "---",
    doc.body,
    "",
  ].join("\n");
}

function candidatePlanRetirement011Inputs(
  l6Plans: Array<{ path: string; text: string }> = [],
  selectedDocs: string[] = ["issue-owned.md", "plan-only.md", "issue-zero.md"],
) {
  const docs = [
    { fileName: "issue-owned.md", owner: "issue: 12" },
    {
      fileName: "plan-only.md",
      owner: "plan: docs/plans/PLAN-L6-1-x.md",
    },
    { fileName: "issue-zero.md", owner: "issue: 0" },
  ].filter((doc) => selectedDocs.includes(doc.fileName));
  const pairArtifact = "docs/test-design/harness/L7-unit-test-design.md";

  return {
    l6Docs: docs.map((doc) => ({
      path: `docs/design/harness/L6-function-design/${doc.fileName}`,
      text: l6FixtureText({
        ...doc,
        pairArtifact,
        oracleId: "U-L6COMP-010",
      }),
    })),
    l6Plans,
    l7Text: l7FixtureText({
      fileName: "L7-unit-test-design.md",
      status: "confirmed",
      body: docs.map((doc) => doc.fileName).join("\n"),
    }),
    gateText: gatePass,
  };
}

describe("L6 completion readiness", () => {
  it("fixture precondition: candidate 011 isolates owner and PLAN-result inputs", () => {
    const l6Plans = [
      {
        path: "docs/plans/PLAN-L6-1-x.md",
        text: "---\nkind: design\nstatus: draft\n---\n",
      },
      {
        path: "docs/plans/PLAN-L6-review.md",
        text: "---\nkind: design\nstatus: confirmed\n---\n",
      },
    ];
    const inputs = candidatePlanRetirement011Inputs(l6Plans);
    const result = analyzeL6Completion(inputs);

    expect(inputs.l6Docs).toHaveLength(3);
    expect(result.draftDocs).toEqual([]);
    expect(result.missingDocPairArtifacts).toEqual([]);
    expect(result.missingL7DocRefs).toEqual([]);
    expect(result.weakContractDocs).toEqual([]);
    expect(result.l7Status).toBe("confirmed");
    expect(result.g6Status).toBe("PASS");
  });

  it("candidate 011 fixture: positive issue remains an L6 owner", () => {
    const result = analyzeL6Completion(candidatePlanRetirement011Inputs([], ["issue-owned.md"]));

    expect(result.missingDocIssues).toEqual([]);
  });

  it("candidate 011 fixture: zero issue leaves an L6 doc ownerless", () => {
    const result = analyzeL6Completion(candidatePlanRetirement011Inputs([], ["issue-zero.md"]));

    expect(result.missingDocIssues).toEqual([
      "docs/design/harness/L6-function-design/issue-zero.md",
    ]);
  });

  it("U-PLANRET-011: plan-only L6 doc is ownerless", () => {
    const result = analyzeL6Completion(candidatePlanRetirement011Inputs([], ["plan-only.md"]));

    expect(result.missingDocIssues).toEqual([
      "docs/design/harness/L6-function-design/plan-only.md",
    ]);
  });

  it("U-PLANRET-011: no PLAN draft finding is returned", () => {
    const result = analyzeL6Completion(
      candidatePlanRetirement011Inputs([
        {
          path: "docs/plans/PLAN-L6-1-x.md",
          text: "---\nkind: design\nstatus: draft\n---\n",
        },
      ]),
    );

    expect(Object.hasOwn(result, "draftPlans")).toBe(false);
  });

  it("U-PLANRET-011: no PLAN review finding is returned", () => {
    const result = analyzeL6Completion(
      candidatePlanRetirement011Inputs([
        {
          path: "docs/plans/PLAN-L6-review.md",
          text: "---\nkind: design\nstatus: confirmed\n---\n",
        },
      ]),
    );

    expect(Object.hasOwn(result, "missingReviewPlans")).toBe(false);
  });
});
