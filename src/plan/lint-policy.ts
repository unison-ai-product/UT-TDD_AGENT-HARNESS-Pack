import { VALID_SUB_DOCS as SCHEMA_VALID_SUB_DOCS } from "../schema/index.ts";
import { FILING_TARGET_BY_MODE } from "../schema/route-filing.ts";

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

// routeFiling の設計契約を lint 側でも直接読む。mode/kind/layer を別の手書き表へ複製しない。
// range (`L3-L6`) は PLAN lint の単層照合用に展開する。
function expandLayerBand(values: readonly string[]): string[] {
  return values.flatMap((value) => {
    const match = /^L(\d+)-L(\d+)$/.exec(value);
    if (!match) return [value];
    const start = Number(match[1]);
    const end = Number(match[2]);
    return Array.from({ length: end - start + 1 }, (_, index) => `L${start + index}`);
  });
}

const routeModes = Object.entries(FILING_TARGET_BY_MODE);

const ROUTE_MODE_ALLOWED_KINDS: Record<string, readonly string[]> = Object.fromEntries(
  routeModes.map(([mode, target]) => [mode, [...target.allowed_kinds]]),
);

const ROUTE_MODE_LAYER_BANDS: Record<string, readonly string[]> = Object.fromEntries(
  routeModes.map(([mode, target]) => [mode, expandLayerBand(target.layer_band)]),
);

const RIGHT_ARM_VERIFICATION_GATE_BY_LAYER: Record<string, string> = {
  L8: "G8",
  L9: "G9",
  L10: "G10",
  L11: "G11",
  L12: "G12",
  L13: "G13",
  L14: "G14",
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
  // PLAN-RECOVERY-10 (Stage 1, 2026-07-07): refactor/recovery mode を SSoT で登録した際に
  // 炙り出た landed off-diagonal。全て confirmed = landed 済のため恒久免除 (kind 書換=履歴改ざん回避)。
  // 個別 burn-down (Reverse 起票) は debt-audit doc の refactor/recovery 節で追う。
  // refactor mode + kind=impl (SSoT: refactor→refactor)。behavior-invariant 義務を免除する同クラス債務。
  "PLAN-L7-216-setup-boundary-refactor",
  "PLAN-L7-217-doctor-setup-smoke-extraction",
  "PLAN-L7-218-setup-distribution-module-extraction",
  "PLAN-L7-220-doctor-plan-governance-extraction",
  "PLAN-L7-222-doctor-runtime-surface-extraction",
  "PLAN-L7-223-cli-distribution-registrar-extraction",
  "PLAN-L7-224-doctor-db-projection-extraction",
  "PLAN-L7-225-doctor-rule-quality-extraction",
  "PLAN-L7-226-doctor-workflow-quality-extraction",
  "PLAN-L7-227-doctor-doc-registry-extraction",
  "PLAN-L7-228-doctor-roadmap-verification-extraction",
  "PLAN-L7-256-model-id-ssot-drift-gate",
  // recovery mode + kind={refactor,impl} (SSoT: recovery→recovery)。
  "PLAN-L7-359-consumer-setup-profile-wiring",
  "PLAN-L7-361-setup-noninteractive-package-tar-portability",
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
  "PLAN-L7-363-routine-gate-run-projection",
  "PLAN-L7-364-reverse-stage-db-obligation",
  "PLAN-L7-365-harness-db-currency-hook",
  "PLAN-L7-366-takeover-surface-warn-actionable",
  "PLAN-L7-367-refactor-candidate-lifecycle",
  "PLAN-L7-368-design-lint-db-projection",
]);

// parked version-up契約の導入前にconfirmedとなった履歴1件。履歴は書き換えず負債台帳で追う。
const VERSION_UP_PARKING_LEGACY_LANDED_PLAN_IDS = new Set(["PLAN-L7-303-digest-commit-anchor"]);

/**
 * #145 で解消する既存の PLAN identity 衝突。
 *
 * key は namespace + 数値化した ordinal。値は main で既知の plan_id 集合を完全一致で固定する。
 * key だけの allowlist ではないため、既存座標への3件目追加や slug 差し替えも fail-close する。
 */
const LEGACY_PLAN_ID_COLLISION_DEBT: Readonly<Record<string, readonly string[]>> = {
  "L6:70": [
    "PLAN-L6-70-source-catalog-profile-resolver-contracts",
    "PLAN-L6-70-vmodel-judgement-skill-pack",
  ],
  "L7:168": ["PLAN-L7-168-g8-integration-workflow", "PLAN-L7-168-verification-profile-type-split"],
  "L7:169": [
    "PLAN-L7-169-g8-integration-evidence-manifest",
    "PLAN-L7-169-relation-graph-type-split",
  ],
  "L7:170": [
    "PLAN-L7-170-external-review-remediation",
    "PLAN-L7-170-g8-evidence-graph-node",
    "PLAN-L7-170-plan-lint-type-policy-split",
  ],
  "L7:171": [
    "PLAN-L7-171-g8-adapter-asset-evidence",
    "PLAN-L7-171-workflow-contracts-type-cleanup",
  ],
  "L7:172": ["PLAN-L7-172-harness-db-catalog-section-split", "PLAN-L7-172-roster-cli-g8-evidence"],
  "L7:173": ["PLAN-L7-173-handover-type-constant-split", "PLAN-L7-173-roster-boundary-g8-evidence"],
  "L7:174": [
    "PLAN-L7-174-green-command-digest-correction",
    "PLAN-L7-174-skill-catalog-g8-evidence",
  ],
  "L7:246": [
    "PLAN-L7-246-doctor-result-aggregation-extraction",
    "PLAN-L7-246-feedback-event-lifecycle",
  ],
  "L7:250": [
    "PLAN-L7-250-doctor-dependency-regression-extraction",
    "PLAN-L7-250-layer-question-catalog",
  ],
  "L7:258": ["PLAN-L7-258-github-branch-ref-normalization", "PLAN-L7-258-guard-firing-evidence"],
  "L7:259": [
    "PLAN-L7-259-hybrid-git-discipline-guards",
    "PLAN-L7-259-pack-github-ci-profile-loader",
  ],
  "L7:325": ["PLAN-L7-325-doctor-lint-gate-extraction", "PLAN-L7-325-goal-workflow-binding"],
  "L7:395": ["PLAN-L7-395-byte-integrity-readability-guard", "PLAN-L7-395-gate-id-format-lint"],
  "L7:397": [
    "PLAN-L7-397-relation-graph-docs-root-ledger-coverage",
    "PLAN-L7-397-right-lung-doc-governance",
  ],
  "L7:398": [
    "PLAN-L7-398-scope-detection-dry-run-preview",
    "PLAN-L7-398-session-log-summarize-path-truncation",
  ],
  "L7:417": [
    "PLAN-L7-417-skill-decision-points-retrofit",
    "PLAN-L7-417-source-disposition-profile-projection",
  ],
  "L7:419": [
    "PLAN-L7-419-forward-fsm-transition-workflow-cli",
    "PLAN-L7-419-hook-failopen-hardening",
  ],
  "L7:420": [
    "PLAN-L7-420-ci-strict-evidence-gates",
    "PLAN-L7-420-vmodel-contract-compiler-registry",
  ],
  "L7:421": [
    "PLAN-L7-421-generic-right-arm-doctor-gate",
    "PLAN-L7-421-test-hygiene-live-tree-fence",
  ],
  "L7:423": [
    "PLAN-L7-423-engine-swap-domain-objects-ports",
    "PLAN-L7-423-gate-minor-hardening-batch",
  ],
  "L7:424": ["PLAN-L7-424-git-hooks-ownership", "PLAN-L7-424-semantic-assessment-debt-router"],
  "L7:425": ["PLAN-L7-425-independent-detector-meta-verifier", "PLAN-L7-425-setup-standardization"],
  "REVERSE:12": ["PLAN-REVERSE-12-review-evidence", "PLAN-REVERSE-12-self-pair-normalization"],
  "REVERSE:395": [
    "PLAN-REVERSE-395-cli-command-design-backfill",
    "PLAN-REVERSE-395-gate-id-format-lint-backfill",
  ],
  "REVERSE:396": [
    "PLAN-REVERSE-396-encoding-byte-integrity-backfill",
    "PLAN-REVERSE-396-verify-gate-binding-backfill",
  ],
};

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
  LEGACY_PLAN_ID_COLLISION_DEBT,
  MODE_PATTERN,
  READY_DEPENDENCY_STATUSES,
  REQUIRED_AGENT_ROLE_ENFORCEMENT_DATE,
  REQUIRED_REVERSE_FULLBACK_SCOPE_LAYERS,
  REVERSE_FULLBACK_BACKPROP_ENFORCEMENT_DATE,
  REVERSE_R4_CLAIMED_ARTIFACT_ENFORCEMENT_DATE,
  REVERSE_R4_ROUTE_BACKPROP_ENFORCEMENT_DATE,
  REVIEW_PATTERN,
  RIGHT_ARM_VERIFICATION_GATE_BY_LAYER,
  ROUTE_CERTIFICATE_ENFORCEMENT_DATE,
  ROUTE_MODE_ALLOWED_KINDS,
  ROUTE_MODE_KIND_DRAFT_DEBT_PLAN_IDS,
  ROUTE_MODE_KIND_LEGACY_LANDED_PLAN_IDS,
  ROUTE_MODE_LAYER_BANDS,
  SERIAL_MODE_PATTERN,
  SERIAL_REASONS,
  VALID_REVERSE_FULLBACK_SCOPE_DECISIONS,
  VALID_SUB_DOCS,
  VERSION_UP_PARKING_LEGACY_LANDED_PLAN_IDS,
};
