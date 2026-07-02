import { VALID_SUB_DOCS as SCHEMA_VALID_SUB_DOCS } from "../schema/index";

const SERIAL_REASONS = ["file_conflict", "downstream_dependency", "shared_state"] as const;
const MODE_PATTERN = /\[(並列|直列)\]/;
const SERIAL_MODE_PATTERN = /\[直列\]/;
const REVIEW_PATTERN = /review|レビュー|self|pmo-sonnet/i;

const DESIGN_LAYERS_REQUIRING_SUB_DOC = new Set(["L1", "L2", "L3", "L4", "L5", "L6"]);
const VALID_SUB_DOCS: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(SCHEMA_VALID_SUB_DOCS).map(([layer, subDocs]) => [layer, new Set(subDocs)]),
);
const INTERNAL_ASSET_EXTENSION_PLAN_IDS = new Set([
  "PLAN-L4-10-internal-asset-master",
  "PLAN-L4-11-roster",
  "PLAN-L4-12-skill-pack",
  "PLAN-L4-13-drift-lint",
  "PLAN-L5-05-roster",
  "PLAN-L5-06-skill",
  "PLAN-L5-07-drift",
]);
const READY_DEPENDENCY_STATUSES = new Set(["confirmed", "completed"]);

// PLAN-L7-263: route_mode と kind の整合表。add-feature mode は add-design /
// add-impl を内包する運用で、kind=impl は back-fill 義務 (KIND_BACKFILL) を
// 機械免除してしまうため許容しない (A-178 G-14)。
const ROUTE_MODE_ALLOWED_KINDS: Record<string, readonly string[]> = {
  "add-feature": ["add-design", "add-impl"],
};

// 2026-07-02 時点で landed 済みの route_mode=add-feature + kind=impl 慣行。
// 完了成果の kind を書き換えると履歴改ざんになるため恒久免除で台帳固定する。
// 正本台帳: docs/governance/route-mode-kind-debt-audit-2026-07-02.md
const ROUTE_MODE_KIND_LEGACY_LANDED_PLAN_IDS = new Set([
  "PLAN-L7-212-route-certificate-governance",
  "PLAN-L7-213-project-local-setup-wrapper",
  "PLAN-L7-214-skill-root-relation-graph-projection",
  "PLAN-L7-215-model-effort-advisor-routing",
  "PLAN-L7-221-github-ci-policy-gate",
]);

// draft のまま起票された debt。draft の間のみ免除し、着手 (status が draft
// 以外へ遷移) 時に add-impl + Reverse pairing へ昇格しないと fail-close する。
const ROUTE_MODE_KIND_DRAFT_DEBT_PLAN_IDS = new Set([
  "PLAN-L7-232-sync-pack-clean-tree-guard",
  "PLAN-L7-233-personal-path-guard-generalization",
  "PLAN-L7-234-pack-test-skip-guards",
  "PLAN-L7-235-pack-windows-ci-job",
  "PLAN-L7-237-research-drive-hardening",
  "PLAN-L7-238-retrofit-preflight-doc-command",
  "PLAN-L7-239-contract-enforcement-wiring",
  "PLAN-L7-240-reverse-right-arm-exit-gate",
  "PLAN-L7-241-human-signoff-evidence-gate",
  "PLAN-L7-242-mode-exit-enforcement-batch",
  "PLAN-L7-243-mode-first-class-db-projection",
  "PLAN-L7-244-right-arm-citation-gate",
  "PLAN-L7-245-sub-doc-schema-integrity",
  "PLAN-L7-246-feedback-event-lifecycle",
  "PLAN-L7-247-db-driven-diagram-generation",
  "PLAN-L7-249-operational-checklist-output",
  "PLAN-L7-250-layer-question-catalog",
  "PLAN-L7-251-observation-next-selector",
  "PLAN-L7-253-orchestrator-model-identity-advisor-triggers",
  "PLAN-L7-254-judgment-gate-reviewer-tier-matrix",
  "PLAN-L7-255-delegation-model-effort-injection",
  "PLAN-L7-257-orchestration-cell-roster",
  "PLAN-L7-258-guard-firing-evidence",
  "PLAN-L7-259-hybrid-git-discipline-guards",
  "PLAN-L7-260-sensitive-scan-boundary",
  "PLAN-L7-261-escalation-boundary-detector",
  "PLAN-L7-262-skill-telemetry-provenance",
  "PLAN-L7-269-deprecation-mode",
  "PLAN-L7-270-spec-change-cycle",
  "PLAN-L7-274-mutation-oracle-hardening",
  "PLAN-L7-275-glossary-code-consistency",
  "PLAN-L7-279-xml-residue-lint",
]);

const DB_PROJECTION_BACKPROP_REQUIRED_GENERATES = [
  "docs/governance/ut-tdd-agent-harness-requirements_v1.2.md",
  "docs/design/harness/L1-requirements/functional-requirements.md",
  "docs/design/harness/L1-requirements/screen-requirements.md",
  "docs/design/harness/L3-functional/functional-requirements.md",
  "docs/design/harness/L4-basic-design/function.md",
  "docs/design/harness/L5-detailed-design/physical-data.md",
  "docs/design/harness/L6-function-design/function-spec.md",
  "docs/design/harness/L6-function-design/fr-unit-coverage.md",
];
const REVERSE_FULLBACK_BACKPROP_ENFORCEMENT_DATE = "2026-06-22";
const REVERSE_R4_CLAIMED_ARTIFACT_ENFORCEMENT_DATE = "2026-06-23";
const REVERSE_R4_ROUTE_BACKPROP_ENFORCEMENT_DATE = "2026-06-23";
const REQUIRED_AGENT_ROLE_ENFORCEMENT_DATE = "2026-06-23";
const KIND_LAYER_ENFORCEMENT_DATE = "2026-06-23";
const ROUTE_CERTIFICATE_ENFORCEMENT_DATE = "2026-07-01";
const REQUIRED_REVERSE_FULLBACK_SCOPE_LAYERS = [
  "requirements",
  "L4-basic-design",
  "L5-detailed-design",
] as const;
const VALID_REVERSE_FULLBACK_SCOPE_DECISIONS = new Set(["updated", "not_impacted", "deferred"]);

export {
  DB_PROJECTION_BACKPROP_REQUIRED_GENERATES,
  DESIGN_LAYERS_REQUIRING_SUB_DOC,
  INTERNAL_ASSET_EXTENSION_PLAN_IDS,
  KIND_LAYER_ENFORCEMENT_DATE,
  MODE_PATTERN,
  READY_DEPENDENCY_STATUSES,
  REQUIRED_AGENT_ROLE_ENFORCEMENT_DATE,
  REQUIRED_REVERSE_FULLBACK_SCOPE_LAYERS,
  REVERSE_FULLBACK_BACKPROP_ENFORCEMENT_DATE,
  REVERSE_R4_CLAIMED_ARTIFACT_ENFORCEMENT_DATE,
  REVERSE_R4_ROUTE_BACKPROP_ENFORCEMENT_DATE,
  REVIEW_PATTERN,
  ROUTE_CERTIFICATE_ENFORCEMENT_DATE,
  ROUTE_MODE_ALLOWED_KINDS,
  ROUTE_MODE_KIND_DRAFT_DEBT_PLAN_IDS,
  ROUTE_MODE_KIND_LEGACY_LANDED_PLAN_IDS,
  SERIAL_MODE_PATTERN,
  SERIAL_REASONS,
  VALID_REVERSE_FULLBACK_SCOPE_DECISIONS,
  VALID_SUB_DOCS,
};
