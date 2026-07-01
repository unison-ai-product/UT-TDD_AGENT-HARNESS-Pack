export type TddCompatibility = "strong" | "partial" | "weak";

export interface DriveTddFit {
  mode: string;
  compatibility: TddCompatibility;
  red_triggers: string[];
  yellow_state: string;
  green_requirements: string[];
}

export const DRIVE_TDD_FITS: DriveTddFit[] = [
  {
    mode: "design",
    compatibility: "strong",
    red_triggers: ["descent_obligation_missing", "pair_artifact_missing", "test_design_missing"],
    yellow_state: "design PLAN exists but pair/test-design/trace is incomplete",
    green_requirements: ["design_doc", "test_design", "trace_edge", "review_after_green"],
  },
  {
    mode: "add-feature",
    compatibility: "strong",
    red_triggers: ["feature_addition", "scope_extension", "acceptance_gap"],
    yellow_state: "add-design/add-impl pair exists but G7/Reverse back-fill is still open",
    green_requirements: [
      "add_design",
      "add_impl",
      "regression_green",
      "reverse_backfill_if_needed",
    ],
  },
  {
    mode: "refactor",
    compatibility: "strong",
    red_triggers: ["code_smell", "structural", "debt_degradation", "artifact_progress_red"],
    yellow_state: "refactor target registered and regression fence is being established",
    green_requirements: ["behavior_unchanged", "linked_test_ids", "relation_impact_closed"],
  },
  {
    mode: "reverse",
    compatibility: "strong",
    red_triggers: ["drift", "schema_contract_gap", "as_is_test_design_missing"],
    yellow_state: "R0-R3 evidence exists but R4 routing/back-prop is incomplete",
    green_requirements: [
      "as_is_design",
      "intent_confirmed",
      "forward_routing",
      "backprop_artifacts",
    ],
  },
  {
    mode: "retrofit",
    compatibility: "strong",
    red_triggers: ["dependency_outdated", "upgrade", "config_drift", "dependency_edges_stale"],
    yellow_state: "migration matrix exists but rollback/regression evidence is incomplete",
    green_requirements: ["migration", "config", "rollback", "regression_green"],
  },
  {
    mode: "recovery",
    compatibility: "strong",
    red_triggers: ["regression_dev", "forced_stop", "agent_runaway", "quality_signal_fail"],
    yellow_state: "root cause and reopen point are known but recurrence guard is incomplete",
    green_requirements: ["root_cause", "recovery_test", "guard_or_rule", "handover"],
  },
  {
    mode: "incident",
    compatibility: "strong",
    red_triggers: ["production_incident", "hotfix_required", "regression_prod"],
    yellow_state: "hotfix is contained but postmortem/recovery back-fill is incomplete",
    green_requirements: ["prod_regression_green", "hotfix_verified", "postmortem", "recovery_plan"],
  },
  {
    mode: "screen-design",
    compatibility: "strong",
    red_triggers: ["screen_requirement_gap", "wireframe_missing", "screen_impl_pair_gap"],
    yellow_state: "L2 screen artifacts exist but flow/wireframe/component trace is incomplete",
    green_requirements: ["screen_list", "screen_flow", "wireframe", "ui_elements", "pair_trace"],
  },
  {
    mode: "frontend-design",
    compatibility: "strong",
    red_triggers: ["a11y_regression", "visual_regression", "token_drift", "ux_feedback"],
    yellow_state: "L10 UX artifacts exist but a11y/VRT/token evidence is incomplete",
    green_requirements: ["visual", "tokens", "a11y", "vrt", "ux_review"],
  },
  {
    mode: "design-bottomup",
    compatibility: "strong",
    red_triggers: [
      "screen_requirement_gap",
      "ui_detail_gap",
      "screen_spec_gap",
      "backend_derived_screen",
    ],
    yellow_state:
      "backend-derived FE requirements exist but L3/L5/L6 design bodies, concrete mock, or Forward descent are incomplete",
    green_requirements: [
      "fe_requirement_elicited",
      "screen_mock",
      "screen_functional",
      "ui_detail",
      "screen_spec",
      "discovery_s4",
    ],
  },
  {
    mode: "discovery",
    compatibility: "partial",
    red_triggers: ["requirement_undefined", "feasibility_unknown", "success_condition_unclear"],
    yellow_state: "hypothesis and PoC are running",
    green_requirements: ["hypothesis_verified", "decision_outcome", "reverse_or_forward_route"],
  },
  {
    mode: "scrum",
    compatibility: "partial",
    red_triggers: ["user_feedback_iteration", "requirement_continuous_refinement"],
    yellow_state: "increment exists but S4 decision/fullback is incomplete",
    green_requirements: ["increment_verified", "s4_decision", "reverse_fullback"],
  },
  {
    mode: "research",
    compatibility: "weak",
    red_triggers: ["tech_decision_required", "option_comparison_needed", "adr_required"],
    yellow_state: "options are being compared",
    green_requirements: ["research_memo", "sources", "adr_candidate"],
  },
];
