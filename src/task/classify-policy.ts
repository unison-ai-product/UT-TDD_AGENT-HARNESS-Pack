import type { TaskKind } from "./classify";
import { type DocumentPack, doc } from "./proposal-coverage-data";

export const KIND_PATTERNS: { kind: TaskKind; pattern: RegExp }[] = [
  { kind: "reverse", pattern: /\b(reverse|as-is|back-?fill|reconstruct)\b/i },
  { kind: "poc", pattern: /\b(poc|spike|prototype|hypothesis|experiment|proof of concept)\b/i },
  {
    kind: "refactor",
    pattern: /\b(refactor|simplify|clean ?up|rename|extract|dedupe|deduplicate)\b/i,
  },
  {
    kind: "troubleshoot",
    pattern: /\b(fix|bug|broken|crash|incident|hotfix|regression|failing|error)\b/i,
  },
  { kind: "design", pattern: /\b(design|spec|architecture|adr)\b/i },
  { kind: "add-feature", pattern: /\b(add|new feature|implement|introduce|build|support for)\b/i },
];

// Escalation-sensitive areas (CLAUDE.md safety boundary). Bare "auth" is omitted
// on purpose so the legitimate word "author" is not flagged.
export const RISK_TERMS = [
  "authentication",
  "authorization",
  "payment",
  "billing",
  "credential",
  "mfa",
  "rbac",
  "redaction",
  "secret",
  "session",
  "tenant",
  "token",
  "pii",
  "license",
  "production",
  "incident",
  "on-call",
  "on call",
  "destructive",
  "migration",
  "schema",
  "external api",
] as const;

export const UNCERTAINTY_TERMS = [
  "unsure",
  "uncertain",
  "investigate",
  "unknown",
  "explore",
  "spike",
  "poc",
  "research",
  "hypothesis",
] as const;

export const BASELINE_DOCUMENT_PACK: DocumentPack = {
  pattern: "baseline",
  level: "G1",
  keywords: [],
  designDocs: [
    doc(
      "functional-requirements",
      "docs/design/harness/L3-functional/functional-requirements.md",
      "baseline proposal coverage",
    ),
  ],
  testDocs: [
    doc(
      "unit-test-design",
      "docs/test-design/harness/L7-unit-test-design.md",
      "baseline oracle coverage",
    ),
  ],
  evidence: ["impact_note"],
  gates: ["classification-review"],
};

export const PROPOSAL_DOCUMENT_COVERAGE_ROUTING_TEST_DOC = doc(
  "proposal-document-coverage-routing",
  "docs/test-design/harness/proposal-document-coverage-routing.md",
  "cross-layer document coverage routing",
);

export const PROPOSAL_COVERAGE_GUARDRAILS = [
  "required-documents-are-additive",
  "llm-cannot-remove-required-documents",
  "unknown-or-low-confidence-increases-granularity",
  "cheap-subagents-cannot-close-risk-or-shrink-coverage",
] as const;
