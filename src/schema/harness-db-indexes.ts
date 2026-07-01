import type { IndexDef } from "./harness-db";

export const HARNESS_DB_INDEXES: IndexDef[] = [
  {
    name: "idx_plan_layer_drive_status",
    table: "plan_registry",
    // physical-data §9.3 準拠: (plan_id, layer, drive, status)。plan_id は PK だが doc 宣言に整合させる。
    columns: ["plan_id", "layer", "drive", "status"],
  },
  { name: "idx_trace_from_to", table: "trace_edges", columns: ["from_artifact", "to_artifact"] },
  {
    name: "idx_findings_subject_status",
    table: "findings",
    columns: ["subject_id", "status", "severity"],
  },
  {
    name: "idx_hook_session_plan",
    table: "hook_events",
    columns: ["session_id", "plan_id", "occurred_at"],
  },
  {
    name: "idx_skill_plan_skill",
    table: "skill_invocations",
    columns: ["plan_id", "skill_id", "fired_at"],
  },
  {
    name: "idx_issue_queue_plan_status",
    table: "issue_queue",
    columns: ["plan_id", "status", "created_at"],
  },
  {
    name: "idx_trouble_events_plan_category",
    table: "trouble_events",
    columns: ["plan_id", "category", "created_at"],
  },
  {
    name: "idx_retry_events_plan_phase",
    table: "retry_events",
    columns: ["plan_id", "workflow", "phase"],
  },
  {
    name: "idx_improvement_log_status",
    table: "improvement_log",
    columns: ["status", "created_at"],
  },
  { name: "idx_search_subject", table: "search_index", columns: ["subject_type", "subject_id"] },
  {
    name: "idx_graph_node_type_subject",
    table: "graph_nodes",
    columns: ["node_type", "subject_id"],
  },
  { name: "idx_graph_path", table: "graph_nodes", columns: ["path"] },
  {
    name: "idx_dependency_from_kind",
    table: "dependency_edges",
    columns: ["from_node_id", "edge_kind"],
  },
  {
    name: "idx_dependency_to_kind",
    table: "dependency_edges",
    columns: ["to_node_id", "edge_kind"],
  },
  {
    name: "idx_impact_change_status",
    table: "impact_results",
    columns: ["change_set_id", "status"],
  },
  {
    name: "idx_artifact_progress_color",
    table: "artifact_progress",
    columns: ["color", "state"],
  },
  {
    name: "idx_artifact_progress_tests",
    table: "artifact_progress",
    columns: ["passed_test_run_count", "dependency_checked"],
  },
  {
    name: "idx_artifact_progress_events_path",
    table: "artifact_progress_events",
    columns: ["artifact_path", "occurred_at"],
  },
  {
    name: "idx_feedback_source",
    table: "feedback_events",
    columns: ["source_table", "source_id"],
  },
  {
    name: "idx_tool_name_scope",
    table: "tool_runs",
    columns: ["tool_name", "input_scope"],
  },
  {
    name: "idx_diagram_scope_format",
    table: "diagram_artifacts",
    columns: ["scope", "format"],
  },
  {
    name: "idx_mcp_profile_name",
    table: "mcp_server_profiles",
    columns: ["name"],
  },
  {
    name: "idx_mcp_triggers_signal",
    table: "mcp_profile_triggers",
    columns: ["signal", "workflow", "gate"],
  },
  {
    name: "idx_mcp_runs_profile_plan",
    table: "mcp_server_runs",
    columns: ["mcp_profile_id", "plan_id", "started_at"],
  },
  {
    name: "idx_verification_profile_type",
    table: "verification_profiles",
    columns: ["profile_type", "enabled"],
  },
  {
    name: "idx_verification_recommendations_change",
    table: "verification_recommendations",
    columns: ["change_set_id", "profile_kind", "accepted"],
  },
  {
    name: "idx_external_tool_findings_subject",
    table: "external_tool_findings",
    columns: ["subject_id", "status", "severity"],
  },
  {
    name: "idx_document_export_run_family",
    table: "document_export_runs",
    columns: ["source_doc_family", "plan_id"],
  },
  {
    name: "idx_document_export_run_snapshot",
    table: "document_export_runs",
    columns: ["source_snapshot_hash"],
  },
  {
    name: "idx_document_export_artifact_format",
    table: "document_export_artifacts",
    columns: ["format", "stale_status"],
  },
  {
    name: "idx_document_export_profile_family",
    table: "document_export_profiles",
    columns: ["source_doc_family", "format", "enabled"],
  },
  {
    name: "idx_document_export_triggers_signal",
    table: "document_export_triggers",
    columns: ["signal", "workflow", "gate"],
  },
  {
    name: "idx_roadmap_band_status",
    table: "roadmap_band_coverage",
    columns: ["status", "band_id"],
  },
  {
    name: "idx_roadmap_gate_plan",
    table: "roadmap_gate_progress",
    columns: ["plan_id", "reached"],
  },
  {
    name: "idx_review_evidence_plan",
    table: "review_evidence_registry",
    columns: ["plan_id", "has_evidence"],
  },
  {
    name: "idx_descent_obligation_trace_status",
    table: "descent_obligations",
    columns: ["trace_key", "status", "required_layer"],
  },
  {
    name: "idx_skill_evaluations_unused",
    table: "skill_evaluations",
    columns: ["unused_flag", "skill_rating"],
  },
  {
    name: "idx_poc_evaluations_rate",
    table: "poc_evaluations",
    columns: ["poc_success_rate", "evaluated_at"],
  },
  {
    name: "idx_model_evaluations_rate",
    table: "model_evaluations",
    columns: ["success_rate", "evaluated_at"],
  },
  { name: "idx_screens_category", table: "screens", columns: ["category", "screen_id"] },
  {
    name: "idx_screen_trace_screen",
    table: "screen_trace",
    columns: ["screen_id", "requirement_kind"],
  },
];
