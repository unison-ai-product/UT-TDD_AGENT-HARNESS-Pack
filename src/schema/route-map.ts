export const ROUTE_COMMAND_TASK_CLASSIFY = "ut-tdd task classify";
export const ROUTE_COMMAND_DOCTOR = "ut-tdd doctor";

export interface RouteSignalEntry {
  tokens: string[];
  mode: string;
  command: string;
  preflight: boolean;
  requiresApproval: boolean;
}

export const ROUTE_SIGNAL_MAP: RouteSignalEntry[] = [
  {
    tokens: ["failure", "doctor"],
    mode: "reverse",
    command: ROUTE_COMMAND_TASK_CLASSIFY,
    preflight: true,
    requiresApproval: false,
  },
  {
    tokens: ["drift", "reverse", "gap", "design_gap"],
    mode: "reverse",
    command: ROUTE_COMMAND_TASK_CLASSIFY,
    preflight: true,
    requiresApproval: false,
  },
  {
    tokens: ["agent_runaway", "runaway", "context_exhaustion", "forced_stop", "regression_dev"],
    mode: "recovery",
    command: ROUTE_COMMAND_DOCTOR,
    preflight: true,
    requiresApproval: true,
  },
  {
    tokens: ["dependency_outdated", "upgrade", "config_drift"],
    mode: "retrofit",
    command: ROUTE_COMMAND_DOCTOR,
    preflight: true,
    requiresApproval: false,
  },
  {
    tokens: ["debt_degradation", "code_smell", "structural", "debt"],
    mode: "refactor",
    command: ROUTE_COMMAND_TASK_CLASSIFY,
    preflight: true,
    requiresApproval: false,
  },
  {
    tokens: [
      "requirement_undefined",
      "feasibility_unknown",
      "success_condition_unclear",
      "design_uncertain",
    ],
    mode: "discovery",
    command: ROUTE_COMMAND_TASK_CLASSIFY,
    preflight: true,
    requiresApproval: false,
  },
  {
    tokens: ["poc", "discovery"],
    mode: "discovery",
    command: ROUTE_COMMAND_TASK_CLASSIFY,
    preflight: true,
    requiresApproval: false,
  },
  {
    tokens: [
      "screen_addition_to_backend",
      "design_bottomup",
      "backend_derived_screen",
      "add_ui_to_backend",
    ],
    mode: "design-bottomup",
    command: ROUTE_COMMAND_TASK_CLASSIFY,
    preflight: true,
    requiresApproval: false,
  },
  {
    tokens: ["user_feedback_iteration", "requirement_continuous_refinement", "scrum"],
    mode: "scrum",
    command: ROUTE_COMMAND_TASK_CLASSIFY,
    preflight: true,
    requiresApproval: false,
  },
  {
    tokens: ["production_incident", "hotfix_required", "regression_prod", "incident", "stop"],
    mode: "incident",
    command: ROUTE_COMMAND_DOCTOR,
    preflight: true,
    requiresApproval: true,
  },
  {
    tokens: ["feature_addition", "scope_extension", "new_requirement", "po_change", "add-feature"],
    mode: "add-feature",
    command: ROUTE_COMMAND_TASK_CLASSIFY,
    preflight: true,
    requiresApproval: false,
  },
  {
    tokens: ["version_deferral", "version-up", "version_up", "future_version"],
    mode: "version-up",
    command: ROUTE_COMMAND_TASK_CLASSIFY,
    preflight: true,
    requiresApproval: false,
  },
  {
    tokens: ["tech_decision_required", "option_comparison_needed", "adr_required", "research"],
    mode: "research",
    command: ROUTE_COMMAND_TASK_CLASSIFY,
    preflight: true,
    requiresApproval: false,
  },
  {
    tokens: ["interrupt", "constraint"],
    mode: "forward",
    command: ROUTE_COMMAND_TASK_CLASSIFY,
    preflight: true,
    requiresApproval: false,
  },
];

export function routeMatchLength(entry: RouteSignalEntry, normalizedSignal: string): number {
  return Math.max(
    0,
    ...entry.tokens.map((token) =>
      normalizedSignal.includes(token.toLowerCase()) ? token.length : 0,
    ),
  );
}

export function routeSignalCandidates(signal: string): string[] {
  const normalized = signal.trim().toLowerCase();
  return ROUTE_SIGNAL_MAP.map((entry, index) => ({
    entry,
    index,
    matchLength: routeMatchLength(entry, normalized),
  }))
    .filter((candidate) => candidate.matchLength > 0)
    .sort((a, b) => b.matchLength - a.matchLength || a.index - b.index)
    .map((candidate) => candidate.entry.mode);
}
