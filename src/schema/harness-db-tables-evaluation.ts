import type { TableDef } from "./harness-db";
import { col, pk } from "./harness-db-table-builders";

export const HARNESS_DB_EVALUATION_TABLES: TableDef[] = [
  {
    name: "skill_evaluations",
    columns: [
      pk("skill_id"),
      col("skill_rating", "REAL"),
      col("adoption_count", "INTEGER"),
      col("success_count", "INTEGER"),
      col("unused_flag", "INTEGER"),
      col("evaluated_at"),
    ],
  },
  // --- §9.9 PoC success measurement projection (FR-L1-43, PLAN-L7-53) ---
  {
    name: "poc_evaluations",
    columns: [
      pk("poc_evaluation_id"),
      col("poc_success_rate", "REAL"),
      col("confirmed_count", "INTEGER"),
      col("rejected_count", "INTEGER"),
      col("pivot_count", "INTEGER"),
      col("total_count", "INTEGER"),
      col("evaluated_at"),
    ],
  },
  // --- §9.10 model evaluation projection (FR-L1-38, PLAN-L7-53) ---
  // Opt-in: runs only when .ut-tdd/config/model-opt-in.yaml exists with enabled:true.
  // Computes per-model success_rate by joining model_runs.plan_id -> plan_registry.status
  // IN PLAN_SUCCESS_STATUSES. No token/cost columns — cost-efficiency is a declared
  // follow-up (see function-spec.md FR-L1-38 invariant and PLAN-L7-53).
  {
    name: "model_evaluations",
    columns: [
      pk("model"),
      col("success_rate", "REAL"),
      col("run_count", "INTEGER"),
      col("success_count", "INTEGER"),
      col("evaluated_at"),
      // FR-L1-38 cost-efficiency (PLAN-L7-57): token 効率 = cross-runtime core metric、$ は enrichment。
      // token 行が無い (review-evidence のみ) なら totals=0・tokens_per_success/cost_per_success=NULL。
      col("total_input_tokens", "INTEGER"),
      col("total_output_tokens", "INTEGER"),
      col("total_cost_usd", "REAL"),
      // tokens_per_success = total_output_tokens / success_count (provider 非依存、低いほど効率的)。
      col("tokens_per_success", "REAL"),
      // cost_per_success = total_cost_usd / success_count ($ enrichment、cost 不明なら NULL)。
      col("cost_per_success", "REAL"),
    ],
  },
  // --- roadmap / review evidence projection (cutover feedback loop) ---
  {
    name: "roadmap_rollups",
    columns: [
      pk("rollup_id"),
      col("total_bands", "INTEGER"),
      col("covered_bands", "INTEGER"),
      col("parked_bands", "INTEGER"),
      col("uncovered_bands", "INTEGER"),
      col("total_gates", "INTEGER"),
      col("reached_gates", "INTEGER"),
      col("total_spans", "INTEGER"),
      col("confirmed_spans", "INTEGER"),
      col("frontier"),
      col("computed_at"),
    ],
  },
  {
    name: "roadmap_band_coverage",
    columns: [pk("band_id"), col("name"), col("status"), col("roadmap_ids"), col("computed_at")],
  },
  {
    name: "roadmap_gate_progress",
    columns: [
      pk("roadmap_gate_id"),
      col("plan_id"),
      col("gate_id"),
      col("total_spans", "INTEGER"),
      col("confirmed_spans", "INTEGER"),
      col("reached", "INTEGER"),
      col("computed_at"),
    ],
  },
  {
    name: "review_evidence_registry",
    columns: [
      pk("review_evidence_id"),
      col("plan_id"),
      col("kind"),
      col("status"),
      col("has_evidence", "INTEGER"),
      col("review_kind"),
      col("verdict"),
      col("reviewed_at"),
      col("tests_green_at"),
      col("worker_model"),
      col("reviewer_model"),
      col("source"),
      col("indexed_at"),
    ],
  },
  {
    name: "descent_obligations",
    columns: [
      pk("descent_obligation_id"),
      col("trace_key"),
      col("from_layer"),
      col("required_layer"),
      col("kind"),
      col("status"),
      col("reason"),
      col("defer_owner"),
      col("defer_spec"),
      col("source"),
      col("indexed_at"),
    ],
  },
  // --- §9.11 screen projection (IMP-140): screen entity + FR/BR→画面 trace を doc 正本から projection ---
  // source = screen-list.md §1 (画面 ID/名/カテゴリ/URL/L1参照) + screen-requirements.md §5.5 (画面→BR/UX/FR-L1 逆 trace)。
  // HM-04 (DB 閲覧) / HM-01 (機能一覧→画面) / PM-06 (設計書ビューア) の DB 駆動を可能にする (従来 doc-only)。
  {
    name: "screens",
    columns: [
      pk("screen_id"),
      col("name"),
      col("category"),
      col("url"),
      col("l1_ref"),
      col("status"),
      col("implemented", "INTEGER"),
      col("indexed_at"),
    ],
  },
  {
    name: "screen_trace",
    columns: [
      pk("screen_trace_id"),
      col("screen_id"),
      col("requirement_id"),
      col("requirement_kind"),
      col("relation"),
      col("source"),
    ],
  },
];
