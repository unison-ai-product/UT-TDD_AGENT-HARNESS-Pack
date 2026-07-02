interface LintResult {
  ok: boolean;
  messages: string[];
}

interface PlanScheduleDoc {
  file: string;
  content: string;
}

interface PlanScheduleViolation {
  file: string;
  step?: string;
  reason: "missing_mode" | "missing_serial_reason" | "missing_review_step" | "missing_impl_plan";
}

interface PlanScheduleResult {
  violations: PlanScheduleViolation[];
  checked: number;
  ok: boolean;
}

interface PlanGovernanceDoc {
  file: string;
  content: string;
}

type PlanGovernanceViolationReason =
  | "missing_frontmatter"
  | "invalid_frontmatter"
  | "duplicate_plan_id"
  | "missing_sub_doc"
  | "invalid_sub_doc"
  | "duplicate_layer_sub_doc"
  | "skip_sub_doc_reason"
  | "parent_missing"
  | "parent_drive_mismatch"
  | "requires_missing"
  | "requires_not_ready"
  | "parent_design_missing"
  | "artifact_type_mismatch"
  | "missing_required_agent_role"
  | "kind_layer_mismatch"
  | "db_projection_backprop_missing"
  | "reverse_fullback_backprop_missing"
  | "reverse_fullback_claimed_artifact_missing"
  | "reverse_r4_claimed_artifact_missing"
  | "reverse_r4_route_backprop_missing"
  | "reverse_fullback_scope_missing"
  | "version_route_certificate_missing"
  | "version_route_certificate_mismatch"
  | "route_certificate_missing"
  | "route_certificate_mismatch"
  | "route_mode_kind_mismatch";

interface PlanGovernanceViolation {
  file: string;
  reason: PlanGovernanceViolationReason;
  detail?: string;
}

interface PlanGovernanceResult {
  violations: PlanGovernanceViolation[];
  checked: number;
  ok: boolean;
}

export type {
  LintResult,
  PlanGovernanceDoc,
  PlanGovernanceResult,
  PlanGovernanceViolation,
  PlanGovernanceViolationReason,
  PlanScheduleDoc,
  PlanScheduleResult,
  PlanScheduleViolation,
};
