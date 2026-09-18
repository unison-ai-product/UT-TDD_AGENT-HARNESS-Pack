/**
 * parent_drive_mismatch の既存債務。
 *
 * 2026-08-05 時点の実測で検出された `parent_drive_mismatch` 39 件を
 * baseline 化する。既知債務は現時点では fail-close せず、修正が完了したら
 * baseline を縮小していく。
 */
export const PARENT_DRIVE_MISMATCH_BASELINE: ReadonlySet<string> = new Set([
  "PLAN-L7-136-harness-db-journal-status-filter",
  "PLAN-L7-137-feedback-surface-taxonomy",
  "PLAN-L7-147-refactor-candidate-detector",
  "PLAN-L7-160-runtime-adapter-policy-extraction",
  "PLAN-L7-161-task-classify-policy-extraction",
  "PLAN-L7-163-workflow-contracts-policy-extraction",
  "PLAN-L7-172-harness-db-catalog-section-split",
  "PLAN-L7-184-g10-ux-workflow",
  "PLAN-L7-185-g10-evidence-directory-projection",
  "PLAN-L7-203-windows-provider-spawn-verbatim",
  "PLAN-L7-230-runtime-projection-extraction",
  "PLAN-L7-246-doctor-result-aggregation-extraction",
  "PLAN-L7-284-cli-delegation-execution-extraction",
  "PLAN-L7-378-doctor-test-lazy-cache",
  "PLAN-L7-470-review-dispatch-analyzer-ownership",
  "PLAN-L7-479-release-manifest-pf1-pure-domain",
  "PLAN-L7-52-l7-completion-audit-closure",
  "PLAN-L7-54-merged-plan-status-gate",
  "PLAN-L7-60-change-set-integrity",
  "PLAN-L7-76-review-remediation-reliability",
  "PLAN-L7-77-codex-stdin-prompt-dispatch",
  "PLAN-L7-78-claude-stdin-prompt-dispatch",
  "PLAN-L7-79-mcp-launcher-argv-tokenization",
  "PLAN-L7-80-session-digest-event-watermark",
  "PLAN-L7-81-codex-wrapper-parity-gate",
  "PLAN-L7-84-status-next-action-field",
  "PLAN-L7-85-review-readonly-guard",
  "PLAN-L7-86-merged-plan-status-deliverable-scope",
  "PLAN-L7-88-handover-summary-injection-cap",
  "PLAN-L7-91-hollow-deliverable-detection",
  "PLAN-RECOVERY-19-gate-run-orphan-projection-fix",
  "PLAN-REVERSE-398-scope-detection-dry-run-preview-backfill",
  "PLAN-REVERSE-403-feedback-surface-context-efficiency-backfill",
  "PLAN-REVERSE-442-doctor-singleton-backfill",
  "PLAN-REVERSE-444-engine-swap-g8-evidence-backfill",
  "PLAN-REVERSE-445-ops-rule-mechanization-backfill",
  "PLAN-REVERSE-446-model-policy-enforcement-backfill",
  "PLAN-REVERSE-447-memory-rule-builder-backfill",
  "PLAN-REVERSE-472-claude-memory-async-wake-backfill",
]);
