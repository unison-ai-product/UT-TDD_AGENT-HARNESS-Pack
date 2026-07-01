import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeProposalDocumentCoverage,
  loadProposalDocumentCoverageLintInput,
  proposalDocumentCoverageMessages,
} from "../src/lint/proposal-document-coverage";
import {
  DEFAULT_PROPOSAL_COVERAGE_SCENARIOS,
  PROPOSAL_ROUTING_DOC_PATH,
} from "../src/lint/proposal-document-coverage-policy";
import { classifyProposalDocumentCoverage } from "../src/task/classify";

describe("proposal document coverage lint", () => {
  it("passes for the real repo routing doc and representative coverage scenarios", () => {
    const result = analyzeProposalDocumentCoverage(
      loadProposalDocumentCoverageLintInput(process.cwd(), classifyProposalDocumentCoverage),
    );

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.checkedPatterns).toEqual(
      expect.arrayContaining([
        "screen-ui",
        "api-if",
        "data-db",
        "test-design",
        "workflow-gate",
        "agent-orchestration",
      ]),
    );
    expect(proposalDocumentCoverageMessages(result)[0]).toContain("OK");
    expect(PROPOSAL_ROUTING_DOC_PATH).toBe(
      "docs/test-design/harness/proposal-document-coverage-routing.md",
    );
    expect(DEFAULT_PROPOSAL_COVERAGE_SCENARIOS.length).toBeGreaterThan(0);
  });

  it("fails closed when the routing document is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doccov-"));
    try {
      const result = analyzeProposalDocumentCoverage({
        repoRoot: root,
        routingDocText: null,
        classifyCoverage: classifyProposalDocumentCoverage,
        scenarios: [
          {
            id: "baseline",
            text: "Rename a local helper.",
            expectedPatterns: ["baseline"],
          },
        ],
      });

      expect(result.ok).toBe(false);
      expect(result.violations.map((violation) => violation.kind)).toContain("missing-routing-doc");
      expect(result.violations.map((violation) => violation.kind)).toContain(
        "missing-required-doc",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects routing docs that omit classified pattern markers", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doccov-"));
    try {
      mkdirSync(join(root, "docs", "design", "harness", "L3-functional"), { recursive: true });
      mkdirSync(join(root, "docs", "test-design", "harness"), { recursive: true });

      const result = analyzeProposalDocumentCoverage({
        repoRoot: root,
        routingDocText: "L7 L8 L9 L12 L14 LLM wording coverage floor",
        classifyCoverage: classifyProposalDocumentCoverage,
        scenarios: [
          {
            id: "baseline",
            text: "Rename a local helper.",
            expectedPatterns: ["baseline"],
          },
        ],
      });

      expect(result.ok).toBe(false);
      expect(result.violations.map((violation) => violation.kind)).toContain(
        "missing-routing-marker",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects routing docs that omit oracle and subagent guard markers", () => {
    const result = analyzeProposalDocumentCoverage({
      repoRoot: process.cwd(),
      routingDocText:
        "`baseline` L7 L8 L9 L12 L14 LLM wording coverage floor required-documents-are-additive",
      classifyCoverage: classifyProposalDocumentCoverage,
      scenarios: [
        {
          id: "baseline",
          text: "Rename a local helper.",
          expectedPatterns: ["baseline"],
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.violations.map((violation) => violation.kind)).toEqual(
      expect.arrayContaining(["missing-routing-oracle", "missing-subagent-guard"]),
    );
  });
});
