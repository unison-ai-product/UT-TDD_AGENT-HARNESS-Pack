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
  SERIAL_MODE_PATTERN,
  SERIAL_REASONS,
  VALID_REVERSE_FULLBACK_SCOPE_DECISIONS,
  VALID_SUB_DOCS,
};
