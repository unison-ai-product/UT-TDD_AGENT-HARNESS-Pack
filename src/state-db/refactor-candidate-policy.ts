export const REFACTOR_SCAN_ROOTS = ["src"] as const;

export const REFACTOR_CANDIDATE_THRESHOLDS = {
  splitModuleLines: 700,
  splitModuleExports: 24,
  extractHelperLines: 120,
  dedupeFunctionMinLines: 10,
  externalizeLiteralMinRepeats: 6,
  externalizeLiteralMinLength: 12,
  externalizePolicy: 5,
  externalizePolicyMaxBranchPoints: 40,
} as const;

export const REFACTOR_POLICY_TERMS = [
  "stage",
  "phase",
  "route",
  "approval",
  "policy",
  "model",
  "tier",
  "profile",
  "skill",
  "inject",
  "injection",
  "subagent",
  "agent",
] as const;
