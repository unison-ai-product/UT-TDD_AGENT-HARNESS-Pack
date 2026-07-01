import { describe, expect, it } from "vitest";
import {
  analyzeFrRoadmapCoverage,
  analyzeFrRoadmapCoverageWithRoot,
  frRoadmapCoverageMessages,
  loadFrRoadmapCoverageDocs,
} from "../src/lint/fr-roadmap-coverage";

const compliant = `# A-TEST

## Residual Feature Buckets

| Bucket | Upstream source | Current route | V-model state | Required next artifact | Status |
|---|---|---|---|---|---|
| R1 Learning | FR-L1-19/20 | L4 carry | partial | Child PLAN seed | \`scheduled\` |
| R2 FE | FR-L1-21/22/28 | L4 carry | partial | L7 implementation WBS | \`scheduled\` |
| R3 Infra | FR-L1-31-35 | Phase B carry | partial | Park decision or scheduled PLAN | \`parked\` |
| R4 Drive | FR-L1-37/39/40/41/42/44 | L4 carry | partial | WBS split | \`scheduled\` |
| R5 Assets | FR-L1-46-49 | L4-L6 carry | partial | Residual PLAN | \`scheduled\` |
| R6 DDD | FR-L1-50 | add-feature carry | partial | Matrix PLAN/WBS | \`scheduled\` |
| R7 Graph | A-124 addendum | L7 | partial | Residual PLAN | \`scheduled\` |
| R8 MCP | A-125 addendum | L7 | partial | PO decision | \`PO decision\` |
| R9 Export | A-126 addendum | L7 | partial | Export PLAN | \`scheduled\` |

## Next
`;

const closed = `# A-TEST

## Residual Feature Buckets

| Bucket | Upstream source | Current route | V-model state | Required next artifact | Status |
|---|---|---|---|---|---|
| R1 Learning | FR-L1-19/20 | L4 carry | closed | PLAN-L7-50 WBS-L7-50-R1 | \`closed\` |
| R2 FE | FR-L1-21/22/28 | L4 carry | closed | PLAN-L7-50 WBS-L7-50-R2 | \`closed\` |
| R3 Infra | FR-L1-31-35 | Phase B carry | closed | PLAN-L7-50 WBS-L7-50-R3 | \`closed\` |
| R4 Drive | FR-L1-37/39/40/41/42/44 | L4 carry | closed | PLAN-L7-50 WBS-L7-50-R4 | \`closed\` |
| R5 Assets | FR-L1-46-49 | L4-L6 carry | closed | PLAN-L7-50 WBS-L7-50-R5 | \`closed\` |
| R6 DDD | FR-L1-50 | add-feature carry | closed | PLAN-L7-50 WBS-L7-50-R6 | \`closed\` |
| R7 Graph | A-124 addendum | L7 | closed | PLAN-L7-50 WBS-L7-50-R7 | \`closed\` |
| R8 MCP | A-125 addendum | L7 | closed | PLAN-L7-50 WBS-L7-50-R8 | \`closed\` |
| R9 Export | A-126 addendum | L7 | closed | PLAN-L7-50 WBS-L7-50-R9 | \`closed\` |

## Residual Feature Closure Evidence

| Bucket | PLAN / WBS | L7 source | test file / oracle citation | coverage gate | Status |
|---|---|---|---|---|---|
| R1 | docs/plans/PLAN-L7-50-feature-list-residual-closure.md#WBS-L7-50-R1 | src/feedback/engine.ts | tests/search-feedback.test.ts | doctor fr-roadmap-coverage + npm test | \`closed\` |
| R2 | docs/plans/PLAN-L7-50-feature-list-residual-closure.md#WBS-L7-50-R2 | src/workflow/readiness.ts | tests/readiness-guardrail.test.ts | doctor fr-roadmap-coverage + npm test | \`closed\` |
| R3 | docs/plans/PLAN-L7-50-feature-list-residual-closure.md#WBS-L7-50-R3 | src/guardrail/ledger.ts | tests/issue-queue.test.ts | doctor fr-roadmap-coverage + npm test | \`closed\` |
| R4 | docs/plans/PLAN-L7-50-feature-list-residual-closure.md#WBS-L7-50-R4 | src/runtime/provider-handover.ts | tests/provider-handover.test.ts | doctor fr-roadmap-coverage + npm test | \`closed\` |
| R5 | docs/plans/PLAN-L7-50-feature-list-residual-closure.md#WBS-L7-50-R5 | src/assets/catalog.ts | tests/asset-catalog.test.ts | doctor fr-roadmap-coverage + npm test | \`closed\` |
| R6 | docs/plans/PLAN-L7-50-feature-list-residual-closure.md#WBS-L7-50-R6 | src/lint/ddd-tdd-rules.ts | tests/ddd-tdd-rules.test.ts | doctor fr-roadmap-coverage + npm test | \`closed\` |
| R7 | docs/plans/PLAN-L7-50-feature-list-residual-closure.md#WBS-L7-50-R7 | src/lint/relation-graph.ts | tests/relation-graph.test.ts | doctor fr-roadmap-coverage + npm test | \`closed\` |
| R8 | docs/plans/PLAN-L7-50-feature-list-residual-closure.md#WBS-L7-50-R8 | src/lint/tool-adapter.ts | tests/tool-adapter.test.ts | doctor fr-roadmap-coverage + npm test | \`closed\` |
| R9 | docs/plans/PLAN-L7-50-feature-list-residual-closure.md#WBS-L7-50-R9 | src/export/document-export.ts | tests/document-export.test.ts | doctor fr-roadmap-coverage + npm test | \`closed\` |

## Next
`;

describe("fr-roadmap-coverage lint", () => {
  it("U-FRC-001: blocks completion while residual bucket rows are non-closed", () => {
    const r = analyzeFrRoadmapCoverage([{ file: "A.md", content: compliant }]);

    expect(r.ok).toBe(false);
    expect(r.rows).toHaveLength(9);
    expect(r.openRows).toHaveLength(9);
    expect(frRoadmapCoverageMessages(r)[0]).toContain("non-closed 9");
  });

  it("U-FRC-002: fails missing/ambiguous residual rows", () => {
    const content = compliant.replace("| R9 Export |", "| RX Export |");
    const r = analyzeFrRoadmapCoverage([{ file: "A.md", content }]);

    expect(r.ok).toBe(false);
    expect(r.violations).toContainEqual({
      file: "A.md",
      bucket: "R9",
      reason: "missing_expected_bucket",
    });
  });

  it("U-FRC-003: passes only when closed rows have PLAN/source/test/gate evidence", () => {
    const r = analyzeFrRoadmapCoverageWithRoot([{ file: "A.md", content: closed }], process.cwd());

    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(9);
    expect(r.closureRows).toHaveLength(9);
    expect(frRoadmapCoverageMessages(r)[0]).toContain("closure=9");
  });

  it("U-FRC-004: fails closed rows without closure evidence", () => {
    const r = analyzeFrRoadmapCoverageWithRoot(
      [{ file: "A.md", content: closed.replace("src/feedback/engine.ts", "src/missing.ts") }],
      process.cwd(),
    );

    expect(r.ok).toBe(false);
    expect(r.violations).toContainEqual({
      file: "A.md",
      bucket: "R1",
      reason: "missing_evidence_file",
    });
  });

  it("U-FRC-004b: reports missing residual bucket docs as a violation", () => {
    const r = analyzeFrRoadmapCoverage([]);

    expect(r.checked).toBe(0);
    expect(frRoadmapCoverageMessages(r)[0]).toContain("violation");
  });

  it("U-FRC-005: current A-133 audit closes R1-R9 with closure evidence", () => {
    const docs = loadFrRoadmapCoverageDocs(process.cwd());
    const r = analyzeFrRoadmapCoverageWithRoot(docs, process.cwd());

    expect(docs.length).toBeGreaterThan(0);
    expect(r.ok).toBe(true);
    expect(r.rows.map((row) => row.bucket)).toEqual([
      "R1",
      "R2",
      "R3",
      "R4",
      "R5",
      "R6",
      "R7",
      "R8",
      "R9",
    ]);
    expect(r.openRows).toEqual([]);
    expect(r.closureRows.map((row) => row.bucket)).toEqual([
      "R1",
      "R2",
      "R3",
      "R4",
      "R5",
      "R6",
      "R7",
      "R8",
      "R9",
    ]);
  });
});
