import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_PROPOSAL_COVERAGE_SCENARIOS,
  PROPOSAL_ROUTING_DOC_PATH,
  REQUIRED_EVIDENCE_BY_PATTERN,
  REQUIRED_GATE_BY_PATTERN,
  REQUIRED_ROUTING_DOC_MARKERS,
  REQUIRED_ROUTING_ORACLES,
  REQUIRED_SUBAGENT_GUARD_MARKERS,
} from "./proposal-document-coverage-policy";

export interface ProposalDocumentCoverageLintInput {
  repoRoot: string;
  routingDocText: string | null;
  classifyCoverage: ProposalDocumentCoverageClassifier;
  scenarios?: ProposalDocumentCoverageScenario[];
}

export type ProposalDocumentCoverageClassifier = (input: { text: string }) => {
  patterns: string[];
  required_design_docs: ProposalDocumentCoverageDocument[];
  required_test_docs: ProposalDocumentCoverageDocument[];
  required_evidence: string[];
  required_gates: string[];
  recommended_subagents?: { tier: string; guard: string }[];
  findings: { code: string }[];
};

export interface ProposalDocumentCoverageDocument {
  id: string;
  path: string;
}

export interface ProposalDocumentCoverageScenario {
  id: string;
  text: string;
  expectedPatterns: string[];
}

export interface ProposalDocumentCoverageViolation {
  kind:
    | "missing-routing-doc"
    | "missing-routing-marker"
    | "missing-required-doc"
    | "missing-cross-layer-routing-doc"
    | "missing-expected-pattern"
    | "missing-cross-artifact-trace"
    | "missing-shrinkage-guard"
    | "missing-required-evidence"
    | "missing-required-gate"
    | "missing-routing-oracle"
    | "missing-subagent-guard";
  scenario?: string;
  path?: string;
  detail: string;
}

export interface ProposalDocumentCoverageLintResult {
  ok: boolean;
  checkedScenarios: number;
  checkedPatterns: string[];
  violations: ProposalDocumentCoverageViolation[];
}

export function loadProposalDocumentCoverageLintInput(
  repoRoot: string,
  classifyCoverage: ProposalDocumentCoverageClassifier,
): ProposalDocumentCoverageLintInput {
  const routingDoc = join(repoRoot, PROPOSAL_ROUTING_DOC_PATH);
  return {
    repoRoot,
    classifyCoverage,
    routingDocText: existsSync(routingDoc) ? readFileSync(routingDoc, "utf8") : null,
  };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function existsRepoPath(repoRoot: string, repoRelativePath: string): boolean {
  return existsSync(join(repoRoot, repoRelativePath));
}

function expectedEvidenceByPattern(pattern: string): string[] {
  return REQUIRED_EVIDENCE_BY_PATTERN[pattern] ?? [];
}

function expectedGateByPattern(pattern: string): string[] {
  return REQUIRED_GATE_BY_PATTERN[pattern] ?? [];
}

export function analyzeProposalDocumentCoverage(
  input: ProposalDocumentCoverageLintInput,
): ProposalDocumentCoverageLintResult {
  const scenarios = input.scenarios ?? DEFAULT_PROPOSAL_COVERAGE_SCENARIOS;
  const violations: ProposalDocumentCoverageViolation[] = [];
  const checkedPatterns: string[] = [];

  if (input.routingDocText === null) {
    violations.push({
      kind: "missing-routing-doc",
      path: PROPOSAL_ROUTING_DOC_PATH,
      detail: "proposal document coverage routing doc is missing",
    });
  }

  for (const scenario of scenarios) {
    const coverage = input.classifyCoverage({ text: scenario.text });
    checkedPatterns.push(...coverage.patterns);

    for (const expectedPattern of scenario.expectedPatterns) {
      if (!coverage.patterns.includes(expectedPattern)) {
        violations.push({
          kind: "missing-expected-pattern",
          scenario: scenario.id,
          detail: `expected pattern ${expectedPattern} was not classified`,
        });
      }
    }

    if (
      !coverage.required_test_docs.some(
        (document) =>
          document.id === "proposal-document-coverage-routing" &&
          document.path === PROPOSAL_ROUTING_DOC_PATH,
      )
    ) {
      violations.push({
        kind: "missing-cross-layer-routing-doc",
        scenario: scenario.id,
        path: PROPOSAL_ROUTING_DOC_PATH,
        detail: "cross-layer routing test-design doc is not required",
      });
    }

    if (
      coverage.patterns.length > 1 &&
      !coverage.required_evidence.includes("cross_artifact_trace")
    ) {
      violations.push({
        kind: "missing-cross-artifact-trace",
        scenario: scenario.id,
        detail: "multi-pattern coverage must require cross_artifact_trace evidence",
      });
    }

    for (const document of [...coverage.required_design_docs, ...coverage.required_test_docs]) {
      if (!existsRepoPath(input.repoRoot, document.path)) {
        violations.push({
          kind: "missing-required-doc",
          scenario: scenario.id,
          path: document.path,
          detail: `${document.id} required by classifier does not exist`,
        });
      }
    }

    for (const evidence of scenario.expectedPatterns.flatMap((pattern) =>
      expectedEvidenceByPattern(pattern),
    )) {
      if (!coverage.required_evidence.includes(evidence)) {
        violations.push({
          kind: "missing-required-evidence",
          scenario: scenario.id,
          detail: `expected evidence ${evidence} was not required`,
        });
      }
    }

    for (const gate of scenario.expectedPatterns.flatMap((pattern) =>
      expectedGateByPattern(pattern),
    )) {
      if (!coverage.required_gates.includes(gate)) {
        violations.push({
          kind: "missing-required-gate",
          scenario: scenario.id,
          detail: `expected gate ${gate} was not required`,
        });
      }
    }
  }

  const shrinkage = input.classifyCoverage({
    text: "This is a minor screen change. Skip wireframe because design is not needed.",
  });
  if (
    !shrinkage.findings.some((finding) => finding.code === "llm-shrinkage-ignored") ||
    !shrinkage.required_design_docs.some((document) => document.id === "wireframe")
  ) {
    violations.push({
      kind: "missing-shrinkage-guard",
      scenario: "shrinkage",
      detail: "scope-reduction wording removed evidence or did not emit a guardrail finding",
    });
  }

  if (input.routingDocText !== null) {
    for (const pattern of uniqueSorted(checkedPatterns)) {
      if (!input.routingDocText.includes(`\`${pattern}\``)) {
        violations.push({
          kind: "missing-routing-marker",
          path: PROPOSAL_ROUTING_DOC_PATH,
          detail: `routing doc does not mention classified pattern ${pattern}`,
        });
      }
    }
    for (const marker of REQUIRED_ROUTING_DOC_MARKERS) {
      if (!input.routingDocText.includes(marker)) {
        violations.push({
          kind: "missing-routing-marker",
          path: PROPOSAL_ROUTING_DOC_PATH,
          detail: `routing doc does not mention required marker ${marker}`,
        });
      }
    }
    for (const oracle of REQUIRED_ROUTING_ORACLES) {
      if (!input.routingDocText.includes(oracle)) {
        violations.push({
          kind: "missing-routing-oracle",
          path: PROPOSAL_ROUTING_DOC_PATH,
          detail: `routing doc does not mention required oracle ${oracle}`,
        });
      }
    }
    for (const marker of REQUIRED_SUBAGENT_GUARD_MARKERS) {
      if (!input.routingDocText.includes(marker)) {
        violations.push({
          kind: "missing-subagent-guard",
          path: PROPOSAL_ROUTING_DOC_PATH,
          detail: `routing doc does not mention subagent guard ${marker}`,
        });
      }
    }
  }

  return {
    ok: violations.length === 0,
    checkedScenarios: scenarios.length,
    checkedPatterns: uniqueSorted(checkedPatterns),
    violations,
  };
}

export function proposalDocumentCoverageMessages(
  result: ProposalDocumentCoverageLintResult,
): string[] {
  if (result.ok) {
    return [
      `proposal-document-coverage - OK (scenarios=${result.checkedScenarios}, patterns=${result.checkedPatterns.length}, missing_docs=0, routing_markers=OK)`,
    ];
  }
  return result.violations.map((violation) => {
    const scenario = violation.scenario ? ` scenario=${violation.scenario}` : "";
    const path = violation.path ? ` ${violation.path}:` : "";
    return `proposal-document-coverage - violation:${scenario}${path} ${violation.kind} (${violation.detail})`;
  });
}
