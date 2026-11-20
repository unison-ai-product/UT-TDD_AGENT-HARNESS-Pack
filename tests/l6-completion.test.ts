import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeL6Completion,
  canLoadL6CompletionInputs,
  l6CompletionMessages,
  loadL6CompletionInputs,
} from "../src/lint/l6-completion.ts";
import { removeTestTree } from "./support/temp-tree.ts";

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

const fixturePlanPath = "docs/plans/PLAN-L6-fixture.md";
const fixturePlan = `---
plan_id: PLAN-L6-fixture
kind: design
status: confirmed
review_evidence:
  - reviewer: fixture-reviewer
---
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

function fixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), "ut-tdd-l6-completion-red-"));
}

function writeFixtureFile(root: string, relativePath: string, text: string): void {
  const path = join(root, ...relativePath.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
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

function writeL6CompletionFixture(
  root: string,
  options: { docs: FixtureL6Doc[]; l7Docs: FixtureL7Doc[]; plans?: boolean },
): void {
  for (const doc of options.docs) {
    writeFixtureFile(
      root,
      `docs/design/harness/L6-function-design/${doc.fileName}`,
      l6FixtureText(doc),
    );
  }
  if (options.plans !== false) writeFixtureFile(root, fixturePlanPath, fixturePlan);
  for (const doc of options.l7Docs) {
    writeFixtureFile(root, `docs/test-design/harness/${doc.fileName}`, l7FixtureText(doc));
  }
  writeFixtureFile(root, "docs/governance/gate-design.md", gatePass);
}

function writeIssueOwnedNoPlanFixture(root: string): void {
  writeL6CompletionFixture(root, {
    plans: false,
    docs: [
      {
        fileName: "issue-only.md",
        owner: "issue: 1035",
        pairArtifact: "docs/test-design/harness/L7-unit-test-design.md",
        oracleId: "U-L6COMP-010",
      },
    ],
    l7Docs: [
      {
        fileName: "L7-unit-test-design.md",
        status: "confirmed",
        body: "issue-only.md",
      },
    ],
  });
}

function withFixtureRoot(run: (root: string) => void): void {
  const root = fixtureRoot();
  try {
    run(root);
  } finally {
    removeTestTree(root);
  }
}

describe("L6 completion readiness", () => {
  it("requires confirmed L6 docs, issue owners, L7 doc refs, confirmed L7, and G6 PASS", () => {
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
    expect(result.missingDocIssues).toEqual([
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
            "issue: 1374",
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
      l7Text:
        "layer: L6\nexecuted_at_layer: L7\nartifact_type: test_design\nstatus: confirmed\nfunction-spec.md\n",
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
            "issue: 1374",
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
      l7Text:
        "layer: L6\nexecuted_at_layer: L7\nartifact_type: test_design\nstatus: draft\nfunction-spec.md\n",
      gateText: gateNotReached,
    });

    expect(result.freezeInputReady).toBe(true);
    expect(result.ready).toBe(false);
    expect(l6CompletionMessages(result)).toContain(
      "l6-completion — freeze-inputs OK (trace/substance before status flip)",
    );
  });

  it("does not reopen base G6 completion based on unrelated plan inputs", () => {
    const result = analyzeL6Completion({
      l6Docs: [
        {
          path: "docs/design/harness/L6-function-design/function-spec.md",
          text: [
            "status: confirmed",
            "pair_artifact: docs/test-design/harness/L7-unit-test-design.md",
            "issue: 1374",
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
      l7Text:
        "layer: L6\nexecuted_at_layer: L7\nartifact_type: test_design\nstatus: confirmed\nfunction-spec.md\n",
      gateText: gatePass,
    });

    expect(result.ready).toBe(true);
  });

  it("U-L6COMP-006: accepts a positive issue as the sole L6 owner", () => {
    const l6Doc = {
      path: "docs/design/harness/L6-function-design/issue-owned.md",
      text: l6FixtureText({
        fileName: "issue-owned.md",
        owner: "issue: 1035",
        pairArtifact: "docs/test-design/harness/L7-unit-test-design.md",
        oracleId: "U-L6COMP-006",
      }),
    };
    const result = analyzeL6Completion({
      l6Docs: [l6Doc],
      l6Plans: [],
      l7Text: l7FixtureText({
        fileName: "L7-unit-test-design.md",
        status: "confirmed",
        body: "issue-owned.md",
      }),
      gateText: gatePass,
    });

    expect(result.ready).toBe(true);
    for (const issue of ["0", "-1", "not-a-number"]) {
      const invalid = analyzeL6Completion({
        l6Docs: [{ ...l6Doc, text: l6Doc.text.replace("issue: 1035", `issue: ${issue}`) }],
        l6Plans: [],
        l7Text: l7FixtureText({
          fileName: "L7-unit-test-design.md",
          status: "confirmed",
          body: "issue-owned.md",
        }),
        gateText: gatePass,
      });
      expect(invalid.ready).toBe(false);
    }
  });

  it("U-L6COMP-008 / U-DOCSPLIT-026: accepts an existing eligible alternate L7 pair", () => {
    withFixtureRoot((root) => {
      writeL6CompletionFixture(root, {
        docs: [
          {
            fileName: "alternate-pair.md",
            owner: "issue: 1374",
            pairArtifact: "docs/test-design/harness/L7-alternate.md",
            oracleId: "U-L6COMP-008",
          },
        ],
        l7Docs: [
          { fileName: "L7-unit-test-design.md", status: "confirmed", body: "shared index" },
          {
            fileName: "L7-alternate.md",
            status: "confirmed",
            body: "alternate-pair.md",
          },
        ],
      });
      const inputs = loadL6CompletionInputs(root);
      const result = analyzeL6Completion(inputs);

      expect(Object.hasOwn(result, "missingReviewPlans")).toBe(false);
      expect(Object.hasOwn(result, "draftPlans")).toBe(false);
      expect(result.missingDocPairArtifacts).toEqual([]);
      expect(result.ready).toBe(true);
    });
  });

  it.each([
    "missing",
    "wrong-layer",
    "wrong-name",
  ])("U-L6COMP-008: rejects an ineligible selected pair (%s)", (axis) => {
    withFixtureRoot((root) => {
      const fileName = axis === "wrong-name" ? "other.md" : "L7-invalid.md";
      const pairArtifact = `docs/test-design/harness/${fileName}`;
      writeL6CompletionFixture(root, {
        docs: [
          {
            fileName: "invalid-pair.md",
            owner: "issue: 1374",
            pairArtifact,
            oracleId: "U-L6COMP-008",
          },
        ],
        l7Docs: [
          { fileName: "L7-unit-test-design.md", status: "confirmed", body: "invalid-pair.md" },
        ],
      });
      if (axis !== "missing") {
        const text = l7FixtureText({ fileName, status: "confirmed", body: "invalid-pair.md" });
        writeFixtureFile(
          root,
          pairArtifact,
          axis === "wrong-layer" ? text.replace("executed_at_layer: L7\n", "") : text,
        );
      }
      const result = analyzeL6Completion(loadL6CompletionInputs(root));
      expect(Object.hasOwn(result, "missingReviewPlans")).toBe(false);
      expect(Object.hasOwn(result, "draftPlans")).toBe(false);
      expect(result.missingDocIssues).toEqual([]);
      expect(result.missingDocPairArtifacts).toEqual([
        "docs/design/harness/L6-function-design/invalid-pair.md",
      ]);
      expect(result.ready).toBe(false);
    });
  });

  it("U-L6COMP-009: reverse reference must be in the selected pair artifact", () => {
    withFixtureRoot((root) => {
      const docPath = "docs/design/harness/L6-function-design/pair-bound-ref.md";
      writeL6CompletionFixture(root, {
        docs: [
          {
            fileName: "pair-bound-ref.md",
            owner: "issue: 1374",
            pairArtifact: "docs/test-design/harness/L7-pair-a.md",
            oracleId: "U-L6COMP-009",
          },
        ],
        l7Docs: [
          { fileName: "L7-pair-a.md", status: "confirmed", body: "does not name the L6 doc" },
          { fileName: "L7-unit-test-design.md", status: "confirmed", body: "pair-bound-ref.md" },
        ],
      });
      const inputs = loadL6CompletionInputs(root);
      const result = analyzeL6Completion(inputs);

      expect(Object.hasOwn(result, "missingReviewPlans")).toBe(false);
      expect(Object.hasOwn(result, "draftPlans")).toBe(false);
      expect(result.missingL7DocRefs).toEqual([docPath]);
      expect(result.missingDocPairArtifacts).toEqual([]);
    });
  });

  it("U-L6COMP-010 setup loads valid L6, L7, and G6 inputs", () => {
    withFixtureRoot((root) => {
      writeIssueOwnedNoPlanFixture(root);

      const inputs = loadL6CompletionInputs(root);
      expect(inputs.l6Docs).toHaveLength(1);
      expect(inputs.l6Plans).toHaveLength(0);
      expect(inputs.l7Text.trim()).not.toBe("");
      expect(inputs.l7Text).toContain("status: confirmed");
      expect(inputs.gateText).toContain("| G6 | PASS |");
    });
  });

  it("U-L6COMP-010: a complete issue-owned tree loads without docs/plans", () => {
    withFixtureRoot((root) => {
      writeIssueOwnedNoPlanFixture(root);

      const inputs = loadL6CompletionInputs(root);
      expect(canLoadL6CompletionInputs(root)).toBe(true);
      expect(analyzeL6Completion(inputs).ready).toBe(true);
    });
  });

  it("U-L6COMP-011: accepts two confirmed selected pairs", () => {
    withFixtureRoot((root) => {
      writeL6CompletionFixture(root, {
        docs: [
          {
            fileName: "pair-confirmed.md",
            owner: "issue: 1374",
            pairArtifact: "docs/test-design/harness/L7-unit-test-design.md",
            oracleId: "U-L6COMP-011",
          },
          {
            fileName: "pair-draft.md",
            owner: "issue: 1374",
            pairArtifact: "docs/test-design/harness/L7-other.md",
            oracleId: "U-L6COMP-011",
          },
        ],
        l7Docs: [
          {
            fileName: "L7-unit-test-design.md",
            status: "confirmed",
            body: "pair-confirmed.md",
          },
          { fileName: "L7-other.md", status: "confirmed", body: "pair-draft.md" },
        ],
      });
      const inputs = loadL6CompletionInputs(root);
      const result = analyzeL6Completion(inputs);

      expect(Object.hasOwn(result, "missingReviewPlans")).toBe(false);
      expect(Object.hasOwn(result, "draftPlans")).toBe(false);
      expect(result.ready).toBe(true);
    });
  });

  it.each([
    "draft",
    undefined,
  ])("U-L6COMP-011: a selected pair with status %s keeps completion not-ready", (status) => {
    withFixtureRoot((root) => {
      writeL6CompletionFixture(root, {
        docs: [
          {
            fileName: "pair-confirmed.md",
            owner: "issue: 1374",
            pairArtifact: "docs/test-design/harness/L7-unit-test-design.md",
            oracleId: "U-L6COMP-011",
          },
          {
            fileName: "pair-draft.md",
            owner: "issue: 1374",
            pairArtifact: "docs/test-design/harness/L7-other.md",
            oracleId: "U-L6COMP-011",
          },
        ],
        l7Docs: [
          {
            fileName: "L7-unit-test-design.md",
            status: "confirmed",
            body: "pair-confirmed.md",
          },
          { fileName: "L7-other.md", status, body: "pair-draft.md" },
        ],
      });
      const inputs = loadL6CompletionInputs(root);

      const result = analyzeL6Completion(inputs);
      expect(Object.hasOwn(result, "missingReviewPlans")).toBe(false);
      expect(Object.hasOwn(result, "draftPlans")).toBe(false);
      expect(result.missingDocPairArtifacts).toEqual([]);
      expect(result.missingL7DocRefs).toEqual([]);
      expect(result.ready).toBe(false);
    });
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

    // U-L6COMP-012: bind the consistency oracle to the declared L6-completion family.
    const familyHeading = "### 2026-06-09 L6 Completion Readiness Addendum";
    const nextHeading = "## PLAN-L7-68 Provider Dispatch Addendum";
    const familyStart = l7.indexOf(familyHeading);
    const familyEnd = l7.indexOf(nextHeading, familyStart + familyHeading.length);
    expect(familyStart).toBeGreaterThanOrEqual(0);
    expect(familyEnd).toBeGreaterThan(familyStart);
    const family = l7.slice(familyStart, familyEnd);
    for (const id of ["006", "008", "009", "010", "011", "012"]) {
      expect(family).toContain(`| U-L6COMP-${id} |`);
    }
    expect(family).not.toMatch(/CANDIDATE-U-L6COMP-\d{3}\b/);

    const ownerRules = family.match(/^- U-L6COMP-00[12]:.*$/gm) ?? [];
    expect(ownerRules).toHaveLength(2);
    for (const rule of ownerRules) {
      expect(rule).toContain("所有者");
      expect(rule).toContain("正の整数の `issue:`");
    }
    expect(ownerRules.join("\n")).not.toMatch(
      /owning\s+L6\s+PLAN(?:へ|に)?(?:解決|resolve)|所有PLAN必須|所有PLANへ解決|所有者(?:は|が)\s*(?:実在する)?L6\s*PLAN(?:へ|に)(?:解決|必須)/i,
    );
  });
});
