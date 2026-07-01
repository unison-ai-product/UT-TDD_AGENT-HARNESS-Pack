import type { ResearchAdoptionDecision } from "./classify";

const SOURCE_NABLARCH_FINTAN = "Nablarch/Fintan";
const SOURCE_NABLARCH_STANDARDS = "Nablarch development standards";
const SOURCE_IPA = "IPA";
const SOURCE_KU_WIEGERS = "KU Wiegers";
const SOURCE_SMARTSHEET = "Smartsheet";
const SOURCE_STANFORD = "Stanford";
const SOURCE_UT_TDD_GOVERNANCE = "UT-TDD governance";

export const RESEARCH_ADOPTION_BY_PATTERN: Record<string, ResearchAdoptionDecision> = {
  "screen-ui": {
    pattern: "screen-ui",
    disposition: "incorporate",
    sources: ["Bizroute", "PocketDOC", "CreativeContentLab", SOURCE_NABLARCH_FINTAN],
    use_cases: ["new screen", "screen redesign", "admin form", "dashboard", "mobile/web UI"],
    incorporated_as: [
      "screen inventory",
      "screen flow",
      "screen detail",
      "wireframe",
      "UI element checklist",
    ],
    not_incorporated: ["template visual styling", "spreadsheet layout as source of truth"],
    reason:
      "screen artifacts are common across researched templates and map directly to UT-TDD L1/L2/L3/L8 coverage",
  },
  "business-flow": {
    pattern: "business-flow",
    disposition: "incorporate",
    sources: ["Bizroute", "PocketDOC", SOURCE_NABLARCH_FINTAN],
    use_cases: ["business process", "approval flow", "operator workflow", "state transition"],
    incorporated_as: ["business flow", "business detail", "acceptance criteria"],
    not_incorporated: ["organization-specific sample process", "untraced swimlane-only diagrams"],
    reason:
      "business-flow templates are useful when they are tied to requirements and acceptance coverage",
  },
  "frontend-design": {
    pattern: "frontend-design",
    disposition: "reference",
    sources: ["CreativeContentLab", SOURCE_SMARTSHEET, SOURCE_NABLARCH_FINTAN],
    use_cases: ["frontend polish", "accessibility", "visual regression", "design tokens"],
    incorporated_as: ["UI evidence vocabulary", "visual review checklist"],
    not_incorporated: [
      "aesthetic-only mockups",
      "brand/marketing page layout",
      "unverified accessibility claims",
    ],
    reason:
      "external templates help vocabulary, but UT-TDD requires first-class token, a11y, and VRT evidence",
  },
  "ux-research-usability": {
    pattern: "ux-research-usability",
    disposition: "reference",
    sources: ["NN/g", "Figma/FigJam", "Maze", "EngageCSEdu", "Smashing Magazine"],
    use_cases: [
      "usability test",
      "user journey map",
      "persona",
      "prototype validation",
      "card sorting",
      "task scenario research",
    ],
    incorporated_as: [
      "user journey evidence",
      "usability test plan fields",
      "task scenario checklist",
      "participant criteria",
      "UX findings trace",
    ],
    not_incorporated: [
      "Figma/Miro board layout as canonical design",
      "persona template without requirement trace",
      "qualitative finding without acceptance impact",
    ],
    reason:
      "UX templates are incorporated as evidence/checklist fields and must trace back to screen, flow, and acceptance artifacts",
  },
  "api-if": {
    pattern: "api-if",
    disposition: "incorporate",
    sources: [SOURCE_NABLARCH_FINTAN, SOURCE_IPA, SOURCE_SMARTSHEET, SOURCE_STANFORD],
    use_cases: ["REST API", "external API", "webhook", "adapter", "third-party integration"],
    incorporated_as: ["external IF", "IF detail", "contract/failure/timeout test checklist"],
    not_incorporated: ["provider-specific SDK prose", "sample endpoint tables without error cases"],
    reason:
      "interface templates map directly to external-if, if-detail, and integration/system test design",
  },
  "data-db": {
    pattern: "data-db",
    disposition: "incorporate",
    sources: [SOURCE_NABLARCH_FINTAN, SOURCE_IPA, SOURCE_SMARTSHEET],
    use_cases: ["schema change", "migration", "projection", "storage", "data integrity"],
    incorporated_as: ["data model", "physical data", "migration/rollback/integrity checklist"],
    not_incorporated: [
      "DB product-specific tuning notes without project impact",
      "sample ERD formatting",
    ],
    reason:
      "data templates are incorporated only as traceable data design and rollback/test obligations",
  },
  "batch-report": {
    pattern: "batch-report",
    disposition: "incorporate",
    sources: [SOURCE_NABLARCH_FINTAN, SOURCE_IPA],
    use_cases: [
      "batch job",
      "scheduled import",
      "CSV export",
      "report generation",
      "large data processing",
    ],
    incorporated_as: [
      "trigger/schedule",
      "internal processing",
      "data flow",
      "retry/idempotency test cases",
    ],
    not_incorporated: [
      "tool-specific scheduler screenshots",
      "operations runbook text without oracle",
    ],
    reason:
      "batch/report use cases need internal-processing, data, and operational test coverage beyond basic function docs",
  },
  "report-output": {
    pattern: "report-output",
    disposition: "incorporate",
    sources: [SOURCE_NABLARCH_FINTAN, SOURCE_NABLARCH_STANDARDS],
    use_cases: ["PDF report", "CSV export", "Excel output", "printed form", "aggregated output"],
    incorporated_as: [
      "output layout",
      "sort/grouping rule",
      "format/encoding rule",
      "sample output evidence",
    ],
    not_incorporated: [
      "spreadsheet styling as canonical truth",
      "sample report without data trace",
    ],
    reason:
      "report/output templates are adopted when they define data source, layout, encoding, and validation evidence",
  },
  "async-job-flow": {
    pattern: "async-job-flow",
    disposition: "incorporate",
    sources: [SOURCE_NABLARCH_FINTAN, SOURCE_NABLARCH_STANDARDS],
    use_cases: [
      "message queue",
      "delayed job",
      "async event",
      "job network",
      "dead-letter handling",
    ],
    incorporated_as: [
      "job/message flow",
      "message contract",
      "retry/dead-letter policy",
      "ordering/idempotency cases",
    ],
    not_incorporated: [
      "middleware-specific console setting",
      "queue diagram without failure cases",
    ],
    reason:
      "async/job templates are incorporated only with failure, retry, ordering, and recovery coverage",
  },
  "notification-message": {
    pattern: "notification-message",
    disposition: "incorporate",
    sources: [SOURCE_NABLARCH_FINTAN, SOURCE_NABLARCH_STANDARDS],
    use_cases: ["email", "notification", "SMS", "message template", "delivery failure"],
    incorporated_as: [
      "recipient rules",
      "message template",
      "delivery failure case",
      "locale/timezone case",
      "privacy redaction case",
    ],
    not_incorporated: ["copy-only message text", "untraced notification sample"],
    reason:
      "notification templates are adopted when recipients, payload, failure, and privacy behavior are traceable",
  },
  "common-component": {
    pattern: "common-component",
    disposition: "incorporate",
    sources: [SOURCE_NABLARCH_FINTAN, SOURCE_NABLARCH_STANDARDS, "UT-TDD architecture"],
    use_cases: ["shared library", "middleware", "common component", "framework utility"],
    incorporated_as: [
      "component API contract",
      "reuse impact",
      "compatibility matrix",
      "dependency impact",
    ],
    not_incorporated: ["generic coding guideline without component boundary"],
    reason:
      "common-component templates are adopted only when reuse and dependency impact are explicit",
  },
  "security-privacy": {
    pattern: "security-privacy",
    disposition: "reference",
    sources: [SOURCE_IPA, "NIST", "OWASP", SOURCE_UT_TDD_GOVERNANCE],
    use_cases: ["authentication", "authorization", "role matrix", "PII", "secrets", "privacy"],
    incorporated_as: [
      "role/permission matrix",
      "privacy data classification",
      "abuse cases",
      "negative authorization tests",
    ],
    not_incorporated: [
      "generic security checklist without testable control",
      "policy prose without owner",
    ],
    reason:
      "security/privacy sources are reference inputs; UT-TDD requires explicit G4 evidence and approval",
  },
  "error-observability-audit": {
    pattern: "error-observability-audit",
    disposition: "reference",
    sources: [SOURCE_IPA, SOURCE_NABLARCH_FINTAN, SOURCE_UT_TDD_GOVERNANCE],
    use_cases: ["error handling", "audit log", "monitoring", "alerting", "redaction"],
    incorporated_as: [
      "error taxonomy",
      "audit log schema",
      "alert threshold",
      "redaction policy",
      "failure observability tests",
    ],
    not_incorporated: ["logging wishlist", "monitoring dashboard screenshot without oracle"],
    reason:
      "observability templates are reference material until converted into failure and audit evidence",
  },
  "ops-release-migration": {
    pattern: "ops-release-migration",
    disposition: "reference",
    sources: [SOURCE_IPA, SOURCE_NABLARCH_FINTAN, SOURCE_UT_TDD_GOVERNANCE],
    use_cases: ["release", "deployment", "cutover", "rollback", "data migration", "runbook"],
    incorporated_as: [
      "release plan",
      "rollback plan",
      "cutover checklist",
      "migration rehearsal",
      "operation handover",
    ],
    not_incorporated: ["operation manual prose without verification", "deployment screenshot"],
    reason:
      "release/operation templates are reference inputs and become required only as verifiable operational evidence",
  },
  "nfr-quality": {
    pattern: "nfr-quality",
    disposition: "reference",
    sources: [SOURCE_IPA, SOURCE_KU_WIEGERS, SOURCE_SMARTSHEET],
    use_cases: [
      "security",
      "performance",
      "availability",
      "auditability",
      "PII handling",
      "permissions",
    ],
    incorporated_as: ["NFR vocabulary", "quality grade prompts", "system test evidence checklist"],
    not_incorporated: ["generic non-functional wish lists", "unmeasurable quality statements"],
    reason:
      "external NFR templates are useful only when converted into measurable UT-TDD grade and evidence rows",
  },
  "test-design": {
    pattern: "test-design",
    disposition: "incorporate",
    sources: ["IEEE 829", "NASA SWEHB", "NIST CFTT", "GSA", "VA", "CMS", "StickyMinds"],
    use_cases: [
      "master test plan",
      "level test design",
      "test case specification",
      "UAT",
      "regression",
      "system validation",
    ],
    incorporated_as: [
      "test level matrix",
      "oracle matrix",
      "test case specification",
      "test procedure/data",
      "entry/exit criteria",
      "requirements traceability",
    ],
    not_incorporated: [
      "test management staffing template",
      "untraced QA checklist",
      "test summary without linked oracle",
    ],
    reason:
      "test documentation templates are adopted only as traceable test-design structure tied to UT-TDD oracle coverage",
  },
  "backend-function": {
    pattern: "backend-function",
    disposition: "incorporate",
    sources: [SOURCE_NABLARCH_FINTAN, SOURCE_SMARTSHEET, SOURCE_KU_WIEGERS, SOURCE_STANFORD],
    use_cases: ["domain logic", "CLI command", "service behavior", "validation rule"],
    incorporated_as: [
      "functional requirement",
      "basic function design",
      "function-spec",
      "unit oracle",
    ],
    not_incorporated: ["large monolithic SRS sections without unit oracle split"],
    reason: "functional templates are incorporated at cohesive unit-test granularity",
  },
  "workflow-gate": {
    pattern: "workflow-gate",
    disposition: "ut-tdd-specific",
    sources: [SOURCE_UT_TDD_GOVERNANCE, "UT-TDD workflow contracts"],
    use_cases: ["gate", "doctor", "lint", "PLAN routing", "workflow classifier"],
    incorporated_as: ["process/gate contract", "projection impact", "regression evidence"],
    not_incorporated: ["generic PM checklist", "template-only approval stamp"],
    reason:
      "workflow/gate behavior is product-specific and cannot be delegated to external template shape",
  },
  "agent-orchestration": {
    pattern: "agent-orchestration",
    disposition: "ut-tdd-specific",
    sources: [SOURCE_UT_TDD_GOVERNANCE, "UT-TDD runtime contracts"],
    use_cases: [
      "Codex/Claude delegation",
      "team run",
      "provider routing",
      "handover",
      "cross review",
    ],
    incorporated_as: ["runtime contract", "cross-review evidence", "handover evidence"],
    not_incorporated: ["generic AI prompt template", "agent marketing workflow"],
    reason:
      "agent orchestration is a UT-TDD runtime concern and external templates are reference-only at most",
  },
  discovery: {
    pattern: "discovery",
    disposition: "reference",
    sources: [SOURCE_KU_WIEGERS, SOURCE_SMARTSHEET, SOURCE_STANFORD, SOURCE_UT_TDD_GOVERNANCE],
    use_cases: ["unknown feasibility", "hypothesis", "research", "PoC", "option comparison"],
    incorporated_as: ["hypothesis", "success condition", "S4 decision evidence"],
    not_incorporated: [
      "research memo without decision route",
      "PoC output promoted without Reverse/Forward route",
    ],
    reason:
      "research templates help decision framing, but UT-TDD requires explicit S4 and route evidence",
  },
  baseline: {
    pattern: "baseline",
    disposition: "reference",
    sources: ["general template catalog"],
    use_cases: ["uncategorized proposal", "small local change"],
    incorporated_as: ["impact note", "baseline function/test design reference"],
    not_incorporated: ["unclassified external template fields"],
    reason: "uncategorized work gets a small baseline, then escalates if evidence is unclear",
  },
};

export const RESEARCH_REJECTION_RULES: ResearchAdoptionDecision[] = [
  {
    pattern: "marketing-site-template",
    disposition: "exclude",
    sources: ["general web/marketing templates"],
    use_cases: ["landing page copy", "SEO page", "brand-only page", "campaign page"],
    incorporated_as: [],
    not_incorporated: ["marketing copy structure", "SEO checklist", "brand-only visual layout"],
    reason: "marketing template structure does not define UT-TDD product design or test evidence",
  },
  {
    pattern: "vendor-specific-format",
    disposition: "exclude",
    sources: ["single-vendor sample templates"],
    use_cases: ["tool screenshot", "vendor SDK sample", "spreadsheet formatting"],
    incorporated_as: [],
    not_incorporated: [
      "vendor-specific fields",
      "formatting-only sheets",
      "screenshots without trace",
    ],
    reason:
      "vendor-specific or formatting-only material can be reference context but cannot become required coverage",
  },
  {
    pattern: "llm-minimal-design-claim",
    disposition: "exclude",
    sources: ["LLM advisory text"],
    use_cases: ["minor claim", "skip document request", "not-needed rationale"],
    incorporated_as: [],
    not_incorporated: ["scope reduction claim", "document omission request"],
    reason:
      "LLM shrinkage is explicitly ignored; only deterministic rules or waiver can reduce coverage",
  },
];

export const RESEARCH_REJECTION_KEYWORDS: {
  decision: ResearchAdoptionDecision;
  keywords: string[];
}[] = [
  {
    decision: RESEARCH_REJECTION_RULES[0],
    keywords: ["landing", "marketing", "seo", "brand", "campaign"],
  },
  {
    decision: RESEARCH_REJECTION_RULES[1],
    keywords: ["vendor", "sdk sample", "screenshot", "spreadsheet formatting", "xlsx template"],
  },
  {
    decision: RESEARCH_REJECTION_RULES[2],
    keywords: [
      "minor",
      "simple",
      "small",
      "not needed",
      "skip",
      "\u8efd\u5fae",
      "\u4e0d\u8981",
      "\u7701\u7565",
    ],
  },
];

export const LLM_SHRINK_TERMS = [
  "minor",
  "simple",
  "small",
  "not needed",
  "skip",
  "\u8efd\u5fae",
  "\u4e0d\u8981",
  "\u7701\u7565",
];
