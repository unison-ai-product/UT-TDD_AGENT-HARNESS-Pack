import type { ProposalDocumentCoverageScenario } from "./proposal-document-coverage";

export const PROPOSAL_ROUTING_DOC_PATH =
  "docs/test-design/harness/proposal-document-coverage-routing.md";

export const DEFAULT_PROPOSAL_COVERAGE_SCENARIOS: ProposalDocumentCoverageScenario[] = [
  {
    id: "ui-ux-api-data",
    text: "Build a screen UI form with UX research, user journey, usability test, frontend tokens, API, DB schema, backend function and common component.",
    expectedPatterns: [
      "screen-ui",
      "frontend-design",
      "ux-research-usability",
      "api-if",
      "data-db",
      "backend-function",
      "common-component",
    ],
  },
  {
    id: "batch-report-async-notification",
    text: "Add batch CSV report output with async queue, dead-letter retry and email notification.",
    expectedPatterns: ["batch-report", "report-output", "async-job-flow", "notification-message"],
  },
  {
    id: "risk-ops-nfr",
    text: "Add security privacy permissions, audit log, monitoring, NFR, release rollback and migration plan.",
    expectedPatterns: [
      "security-privacy",
      "error-observability-audit",
      "ops-release-migration",
      "nfr-quality",
    ],
  },
  {
    id: "test-design",
    text: "Create a test plan, acceptance test, system test, regression procedure and operational test coverage.",
    expectedPatterns: ["test-design"],
  },
  {
    id: "workflow-agent-discovery",
    text: "Research discovery for workflow gate, agent orchestration, provider handover and team run.",
    expectedPatterns: ["workflow-gate", "agent-orchestration", "discovery"],
  },
];

export const REQUIRED_EVIDENCE_BY_PATTERN: Record<string, string[]> = {
  "screen-ui": ["screen_trace"],
  "ux-research-usability": ["usability_test_plan", "ux_findings_trace"],
  "api-if": ["contract_tests"],
  "data-db": ["migration_plan"],
  "batch-report": ["idempotency"],
  "report-output": ["output_layout"],
  "async-job-flow": ["retry_dead_letter_policy"],
  "notification-message": ["recipient_rules"],
  "security-privacy": ["role_permission_matrix", "human_security_approval"],
  "error-observability-audit": ["audit_log_schema", "redaction_policy"],
  "ops-release-migration": ["rollback_plan", "migration_rehearsal"],
  "nfr-quality": ["nfr_grade"],
  "test-design": ["oracle_matrix", "requirements_traceability"],
  "workflow-gate": ["gate_contract"],
  "agent-orchestration": ["runtime_routing", "handover_evidence"],
  discovery: ["hypothesis", "s4_decision"],
};

export const REQUIRED_GATE_BY_PATTERN: Record<string, string[]> = {
  "screen-ui": ["screen-design-workflow"],
  "api-if": ["if-contract-review"],
  "data-db": ["data-contract-review"],
  "security-privacy": ["security-privacy-review"],
  "error-observability-audit": ["error-observability-audit-review"],
  "ops-release-migration": ["ops-release-migration-review"],
  "nfr-quality": ["nfr-quality-review"],
  "test-design": ["test-design-coverage-review"],
  "workflow-gate": ["workflow-gate-review"],
  "agent-orchestration": ["agent-runtime-review"],
  discovery: ["discovery-s4-decision"],
};

export const REQUIRED_ROUTING_DOC_MARKERS = [
  "L7",
  "L8",
  "L9",
  "L12",
  "L14",
  "LLM wording",
  "coverage floor",
] as const;

export const REQUIRED_ROUTING_ORACLES = [
  "DOCROUTE-U-01",
  "DOCROUTE-U-02",
  "DOCROUTE-U-03",
  "DOCROUTE-U-04",
  "DOCROUTE-U-05",
  "DOCROUTE-U-06",
  "DOCROUTE-U-07",
  "DOCROUTE-U-08",
  "DOCROUTE-IT-01",
  "DOCROUTE-IT-02",
  "DOCROUTE-IT-03",
  "DOCROUTE-ST-01",
] as const;

export const REQUIRED_SUBAGENT_GUARD_MARKERS = [
  "T2-mini",
  "T2-spark",
  "T0-frontier",
  "parallel_slots",
  "ownership",
  "closing_authority=false",
  "cannot close G4/G5 risk",
] as const;
