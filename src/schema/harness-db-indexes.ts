import type { IndexDef } from "./harness-db.ts";

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
    name: "idx_feedback_lifecycle_event",
    table: "feedback_lifecycle",
    columns: ["feedback_event_id", "source_generation", "occurred_at"],
  },
  {
    name: "idx_refactor_candidates_state",
    table: "refactor_candidates",
    columns: ["state", "confidence", "last_seen_at"],
  },
  {
    name: "idx_refactor_candidates_plan",
    table: "refactor_candidates",
    columns: ["linked_plan_id", "state"],
  },
  {
    name: "idx_memory_kind_updated",
    table: "memory_entries",
    columns: ["kind", "updated_at"],
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
    name: "idx_github_review_lane_subject",
    table: "github_review_lane_receipts",
    columns: ["plan_id", "plan_revision", "subject_head", "lane"],
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
  {
    name: "idx_spec_defs_owner",
    table: "spec_defs",
    columns: ["owner_path", "section_anchor"],
  },
  {
    name: "idx_spec_defs_kind_layer_status",
    table: "spec_defs",
    columns: ["spec_kind", "layer", "lifecycle_status"],
  },
  { name: "idx_spec_defs_plan", table: "spec_defs", columns: ["plan_id"] },
  {
    name: "idx_spec_relations_from_kind",
    table: "spec_relations",
    columns: ["from_spec_id", "relation_kind"],
  },
  {
    name: "idx_spec_relations_to_kind",
    table: "spec_relations",
    columns: ["to_spec_id", "relation_kind"],
  },
  {
    name: "idx_schedule_plan_status",
    table: "schedule_entries",
    columns: ["plan_id", "status", "rag"],
  },
  {
    name: "idx_schedule_layer_subdoc_status",
    table: "schedule_entries",
    columns: ["layer", "sub_doc", "status"],
  },
  {
    name: "idx_activation_profile_status",
    table: "activation_entries",
    columns: ["profile_id", "scope_status"],
  },
  {
    name: "idx_activation_version_status",
    table: "activation_entries",
    columns: ["target_version", "scope_status"],
  },
  {
    name: "idx_activation_schedule_plan_profile",
    table: "activation_schedule_reviews",
    columns: ["plan_id", "profile_id", "scope_status"],
  },
  {
    name: "idx_activation_schedule_scope_rag",
    table: "activation_schedule_reviews",
    columns: ["scope_status", "rag", "enabled"],
  },
  {
    name: "idx_document_catalog_layer_subdoc",
    table: "document_catalog_entries",
    columns: ["layer", "sub_doc", "applicability"],
  },
  {
    name: "idx_document_catalog_doc_type",
    table: "document_catalog_entries",
    columns: ["doc_type_id", "default_status"],
  },
  {
    name: "idx_document_scale_profile_entry",
    table: "document_scale_profile_entries",
    columns: ["profile_id", "doc_type_id", "decision"],
  },
  {
    name: "idx_document_scale_profile_review",
    table: "document_scale_profile_reviews",
    columns: ["profile_id", "decision", "catalog_layer"],
  },
  {
    name: "idx_spec_rag_closure_rag_status",
    table: "spec_rag_closure_entries",
    columns: ["rag", "closure_status"],
  },
  {
    name: "idx_spec_rag_closure_spec",
    table: "spec_rag_closure_entries",
    columns: ["spec_id", "requires_test"],
  },
  {
    name: "idx_detector_candidates_source",
    table: "detector_route_candidates",
    columns: ["source_table", "source_id"],
  },
  {
    name: "idx_detector_candidates_filing",
    table: "detector_route_candidates",
    columns: ["filing_target_id", "severity", "candidate_status"],
  },
  {
    name: "idx_detector_candidates_subject",
    table: "detector_route_candidates",
    columns: ["subject_id"],
  },
  {
    name: "idx_agent_contracts_target",
    table: "agent_contracts",
    columns: ["target_path"],
  },
  { name: "idx_vmodel_source_ordinal", table: "vmodel_sources", columns: ["ordinal"] },
  {
    name: "idx_vmodel_item_category_source",
    table: "vmodel_semantic_items",
    columns: ["category_id", "source_ref", "item_id"],
  },
  {
    name: "idx_vmodel_source_item",
    table: "vmodel_source_item_edges",
    columns: ["source_id", "item_id"],
  },
  {
    name: "idx_vmodel_source_target",
    table: "vmodel_source_target_edges",
    columns: ["source_id", "target_type", "target_ref"],
  },
  {
    name: "idx_vmodel_item_target_status",
    table: "vmodel_item_target_edges",
    columns: ["item_id", "target_status", "target_kind"],
  },
  {
    name: "idx_document_scale_profile_axis_rank",
    table: "document_scale_profiles",
    columns: ["profile_axis", "profile_rank"],
  },
  {
    name: "idx_execution_readiness_state_order",
    table: "execution_readiness_projection",
    columns: ["readiness", "implementation_order", "plan_id"],
  },
  {
    name: "idx_github_project_sync_status",
    table: "github_project_item_projection",
    columns: ["repository_id", "sync_status", "plan_id"],
  },
  {
    name: "idx_github_binding_plan_kind",
    table: "github_object_bindings",
    columns: ["repository_id", "plan_id", "object_kind", "state"],
  },
  {
    name: "idx_github_outbox_status",
    table: "github_projection_outbox",
    columns: ["status", "updated_at", "outbox_id"],
  },
];
