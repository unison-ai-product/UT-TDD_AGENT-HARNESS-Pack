import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { type RecommendedCommandV1, recommendedCommandV1Schema } from "../schema/index";
import {
  ROUTE_COMMAND_DOCTOR,
  ROUTE_COMMAND_TASK_CLASSIFY,
  ROUTE_SIGNAL_MAP,
  type RouteSignalEntry,
  routeMatchLength,
  routeSignalCandidates,
} from "../schema/route-map";
import type { ContractResult, Finding, Severity } from "./contracts";

export type { RouteSignalEntry } from "../schema/route-map";

function finding(
  code: string,
  message: string,
  options: { evidencePath?: string; severity?: Severity } = {},
): Finding {
  return {
    code,
    severity: options.severity ?? "error",
    evidence_path: options.evidencePath ?? "",
    message,
  };
}

function result(findings: Finding[], evidence_paths: string[] = []): ContractResult {
  return { ok: findings.every((f) => f.severity !== "error"), findings, evidence_paths };
}

export function routeSignalToMode(input: {
  signal: string;
  current_plan?: string;
  drive?: string;
}): ContractResult & { candidates: string[] } {
  const candidates = routeSignalCandidates(input.signal);
  const findings =
    candidates.length === 0
      ? [finding("no-route", "unknown signal has no route", { severity: "warn" })]
      : [];
  return { ...result(findings), candidates };
}

export interface RouteEvalResult extends ContractResult {
  signal: string;
  mode: string | null;
  suggest_command: string;
  recommended_command: RecommendedCommandV1 | null;
  finding_route: FindingRouteCandidate | null;
  approval: RouteApprovalResult;
  escalation_boundaries: RouteEscalationBoundary[];
  exit_code: 0 | 1 | 2;
}

export type RouteFindingType =
  | "regression"
  | "premise-gap"
  | "deviation"
  | "feature-gap"
  | "latent-defect"
  | "smell";

export interface FindingRouteCandidate {
  finding_type: RouteFindingType;
  mode: "recovery" | "add-feature" | "refactor";
  route_signal: "regression_dev" | "feature_addition" | "code_smell";
  proposed_plan_prefix: "PLAN-RECOVERY-" | "PLAN-L7-" | "PLAN-REFACTOR-";
  requires_human_approval: boolean;
  auto_create: false;
  rationale: string;
  required_recovery_fields?: string[];
}

export interface RouteApprovalPolicy {
  rules: {
    mode: string;
    condition?: string;
    required_approvers: string[];
  }[];
  approvals?: {
    mode: string;
    condition?: string;
    approver: string;
    approved_at: string;
    subject?: string;
  }[];
}

export interface RouteApprovalResult {
  required: boolean;
  status: "not_required" | "approved" | "policy_missing" | "approval_missing";
  required_approvers: string[];
  approved_by: string[];
  missing_approvers: string[];
}

export interface RouteConfigViolation {
  code: "legacy-db-dependency" | "personal-absolute-path";
  path: string;
  evidence: string;
}

export interface RouteEscalationBoundary {
  term: string;
  evidence: string;
}

const D_CONTRACT_MODES = [
  "forward",
  "reverse",
  "recovery",
  "retrofit",
  "refactor",
  "discovery",
  "design-bottomup",
  "scrum",
  "incident",
  "add-feature",
  "version-up",
  "research",
] as const;

const dContractModeRoutingSchema = z.object({
  routes: z
    .array(
      z.object({
        signal: z.string().min(1),
        mode: z.enum(D_CONTRACT_MODES),
        priority: z.number().int().nonnegative().default(0),
        next: z.array(z.string().min(1)).default([]),
      }),
    )
    .min(1),
});

const dContractGateCheckSchema = z.object({
  check_id: z.string().min(1),
  assertion: z.string().min(1),
  next_action: recommendedCommandV1Schema,
});

const dContractGateChecksSchema = z.object({
  gates: z.record(z.string().min(1), z.array(dContractGateCheckSchema).min(1)),
});

export type DContractModeRouting = z.infer<typeof dContractModeRoutingSchema>;
export type DContractGateChecks = z.infer<typeof dContractGateChecksSchema>;

export interface DContractDslValidationResult extends ContractResult {
  mode_routing: DContractModeRouting | null;
  gate_checks: DContractGateChecks | null;
}

const ROUTE_CONFIG_FORBIDDEN_PATTERNS: {
  code: RouteConfigViolation["code"];
  pattern: RegExp;
}[] = [
  { code: "legacy-db-dependency", pattern: /\blegacy\s*(?:DB|database)\b/i },
  { code: "legacy-db-dependency", pattern: /\blegacy[_-]?db\b/i },
  {
    code: "personal-absolute-path",
    pattern: /(?:[A-Za-z]:\\Users\\[^\\\s"']+|\/Users\/[^/\s"']+|~\/)/,
  },
];

const ROUTE_ESCALATION_PATTERNS: { term: string; pattern: RegExp }[] = [
  "authentication",
  "authorization",
  "payment",
  "billing",
  "credential",
  "secret",
  "pii",
  "license",
  "production",
  "destructive",
  "migration",
  "schema",
  "external api",
].map((term) => ({
  term,
  pattern: new RegExp(`\\b${term}s?\\b`, "i"),
}));

const ROUTE_CONTRACT_EVIDENCE_PATH = "src/workflow/contracts.ts";

const FINDING_ROUTE_MAP: Record<RouteFindingType, FindingRouteCandidate> = {
  regression: {
    finding_type: "regression",
    mode: "recovery",
    route_signal: "regression_dev",
    proposed_plan_prefix: "PLAN-RECOVERY-",
    requires_human_approval: true,
    auto_create: false,
    rationale:
      "監査/調査で見つかった退行は既存 regression_dev signal 経由で Recovery 起票候補にする",
    required_recovery_fields: [
      "root_cause",
      "prevention_change_trace",
      "guard_or_test_or_rule_or_hook",
      "l14_route",
    ],
  },
  "premise-gap": {
    finding_type: "premise-gap",
    mode: "recovery",
    route_signal: "regression_dev",
    proposed_plan_prefix: "PLAN-RECOVERY-",
    requires_human_approval: true,
    auto_create: false,
    rationale: "前提崩れは検証/運用の退行として Recovery 起票候補にする",
    required_recovery_fields: [
      "root_cause",
      "prevention_change_trace",
      "guard_or_test_or_rule_or_hook",
      "l14_route",
    ],
  },
  deviation: {
    finding_type: "deviation",
    mode: "recovery",
    route_signal: "regression_dev",
    proposed_plan_prefix: "PLAN-RECOVERY-",
    requires_human_approval: true,
    auto_create: false,
    rationale: "定義済み workflow からの逸脱は Recovery 起票候補にする",
    required_recovery_fields: [
      "root_cause",
      "prevention_change_trace",
      "guard_or_test_or_rule_or_hook",
      "l14_route",
    ],
  },
  "feature-gap": {
    finding_type: "feature-gap",
    mode: "add-feature",
    route_signal: "feature_addition",
    proposed_plan_prefix: "PLAN-L7-",
    requires_human_approval: false,
    auto_create: false,
    rationale: "機能欠落は Recovery に押し込まず Add-feature の起票候補にする",
  },
  "latent-defect": {
    finding_type: "latent-defect",
    mode: "add-feature",
    route_signal: "feature_addition",
    proposed_plan_prefix: "PLAN-L7-",
    requires_human_approval: false,
    auto_create: false,
    rationale: "潜在欠陥は仕様化して Add-feature/実装修正へ送る",
  },
  smell: {
    finding_type: "smell",
    mode: "refactor",
    route_signal: "code_smell",
    proposed_plan_prefix: "PLAN-REFACTOR-",
    requires_human_approval: false,
    auto_create: false,
    rationale: "構造上の smell は refactor 起票候補にする",
  },
};

function normalizeFindingType(value: string | undefined): RouteFindingType | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  return Object.hasOwn(FINDING_ROUTE_MAP, normalized) ? (normalized as RouteFindingType) : null;
}

function inferFindingType(signal: string): RouteFindingType | null {
  const normalized = signal.toLowerCase().replace(/_/g, "-");
  const entries = Object.keys(FINDING_ROUTE_MAP).sort((a, b) => b.length - a.length);
  return (
    (entries.find((entry) =>
      new RegExp(`(?:^|[\\s:;,[({])${entry}(?:$|[\\s:;,.\\])}])`).test(normalized),
    ) as RouteFindingType | undefined) ?? null
  );
}

function findingRouteEntry(candidate: FindingRouteCandidate): RouteSignalEntry {
  return {
    tokens: [candidate.route_signal],
    mode: candidate.mode,
    command: candidate.mode === "recovery" ? ROUTE_COMMAND_DOCTOR : ROUTE_COMMAND_TASK_CLASSIFY,
    preflight: true,
    requiresApproval: candidate.requires_human_approval,
  };
}

export function validateRouteConfigText(input: {
  path: string;
  text: string;
}): RouteConfigViolation[] {
  const violations: RouteConfigViolation[] = [];
  for (const { code, pattern } of ROUTE_CONFIG_FORBIDDEN_PATTERNS) {
    const match = input.text.match(pattern);
    if (match) {
      violations.push({ code, path: input.path, evidence: match[0] ?? "" });
    }
  }
  return violations;
}

export function detectRouteEscalationBoundaries(text: string): RouteEscalationBoundary[] {
  return ROUTE_ESCALATION_PATTERNS.flatMap(({ term, pattern }) => {
    const match = text.match(pattern);
    return match ? [{ term, evidence: match[0] ?? term }] : [];
  });
}

function parseYamlObject(text: string, path: string): { parsed?: unknown; finding?: Finding } {
  try {
    return { parsed: parseYaml(text) };
  } catch (error) {
    return {
      finding: finding("d-contract-yaml-parse", `invalid YAML: ${String(error)}`, {
        evidencePath: path,
      }),
    };
  }
}

function schemaFinding(path: string, schemaName: string, error: z.ZodError): Finding {
  const issue = error.issues[0];
  const location = issue?.path.length ? issue.path.join(".") : schemaName;
  return finding(
    "d-contract-schema",
    `${schemaName} schema violation at ${location}: ${issue?.message ?? "invalid value"}`,
    { evidencePath: path },
  );
}

function detectModeRoutingCycles(routing: DContractModeRouting, path: string): Finding[] {
  const routeIds = new Set(routing.routes.map((route) => route.signal));
  const edges = new Map(
    routing.routes.map((route) => [route.signal, route.next.filter((next) => routeIds.has(next))]),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(signal: string, stack: string[]): string[] | null {
    if (visiting.has(signal)) {
      const start = stack.indexOf(signal);
      return [...stack.slice(start), signal];
    }
    if (visited.has(signal)) return null;
    visiting.add(signal);
    for (const next of edges.get(signal) ?? []) {
      const cycle = visit(next, [...stack, signal]);
      if (cycle) return cycle;
    }
    visiting.delete(signal);
    visited.add(signal);
    return null;
  }

  for (const route of routing.routes) {
    const cycle = visit(route.signal, []);
    if (cycle) {
      return [
        finding("d-contract-routing-cycle", `mode-routing cycle: ${cycle.join(" -> ")}`, {
          evidencePath: path,
        }),
      ];
    }
  }
  return [];
}

export function validateDContractDsl(input: {
  modeRoutingText: string;
  gateChecksText: string;
  modeRoutingPath?: string;
  gateChecksPath?: string;
  requiredGateIds?: string[];
}): DContractDslValidationResult {
  const modeRoutingPath = input.modeRoutingPath ?? "mode-routing.yaml";
  const gateChecksPath = input.gateChecksPath ?? "gate-checks.yaml";
  const findings: Finding[] = [];

  const modeRoutingYaml = parseYamlObject(input.modeRoutingText, modeRoutingPath);
  if (modeRoutingYaml.finding) findings.push(modeRoutingYaml.finding);
  const gateChecksYaml = parseYamlObject(input.gateChecksText, gateChecksPath);
  if (gateChecksYaml.finding) findings.push(gateChecksYaml.finding);

  const modeRoutingParsed = modeRoutingYaml.finding
    ? null
    : dContractModeRoutingSchema.safeParse(modeRoutingYaml.parsed);
  if (modeRoutingParsed && !modeRoutingParsed.success) {
    findings.push(schemaFinding(modeRoutingPath, "mode-routing", modeRoutingParsed.error));
  }

  const gateChecksParsed = gateChecksYaml.finding
    ? null
    : dContractGateChecksSchema.safeParse(gateChecksYaml.parsed);
  if (gateChecksParsed && !gateChecksParsed.success) {
    findings.push(schemaFinding(gateChecksPath, "gate-checks", gateChecksParsed.error));
  }

  const modeRouting = modeRoutingParsed?.success ? modeRoutingParsed.data : null;
  const gateChecks = gateChecksParsed?.success ? gateChecksParsed.data : null;
  if (modeRouting) findings.push(...detectModeRoutingCycles(modeRouting, modeRoutingPath));
  if (gateChecks) {
    for (const gateId of input.requiredGateIds ?? []) {
      if (!gateChecks.gates[gateId]) {
        findings.push(
          finding("d-contract-missing-gate", `gate-checks missing required gate ${gateId}`, {
            evidencePath: gateChecksPath,
          }),
        );
      }
    }
  }

  return {
    ...result(findings, [modeRoutingPath, gateChecksPath]),
    mode_routing: findings.some((f) => f.evidence_path === modeRoutingPath) ? null : modeRouting,
    gate_checks: findings.some((f) => f.evidence_path === gateChecksPath) ? null : gateChecks,
  };
}

function routeCondition(input: { mode: string; signal: string; drift_type?: string }): string {
  const signal = input.signal.toLowerCase();
  if (
    input.mode === "retrofit" &&
    (input.drift_type === "config_drift" || signal.includes("config_drift"))
  ) {
    return "config_drift";
  }
  if (input.mode === "incident") return "env=prod";
  return input.mode;
}

function resolveApproval(params: {
  route: { mode: string; requiresApproval: boolean };
  input: { signal: string; drift_type?: string };
  policy?: RouteApprovalPolicy;
  escalationBoundaries?: RouteEscalationBoundary[];
}): RouteApprovalResult {
  const { input, policy, route } = params;
  const escalationBoundaries = params.escalationBoundaries ?? [];
  const condition =
    escalationBoundaries.length > 0
      ? "escalation"
      : routeCondition({
          mode: route.mode,
          signal: input.signal,
          drift_type: input.drift_type,
        });
  const required =
    route.requiresApproval ||
    escalationBoundaries.length > 0 ||
    (route.mode === "retrofit" && condition === "config_drift");
  if (!required) {
    return {
      required: false,
      status: "not_required",
      required_approvers: [],
      approved_by: [],
      missing_approvers: [],
    };
  }
  if (!policy) {
    return {
      required: true,
      status: "policy_missing",
      required_approvers: [],
      approved_by: [],
      missing_approvers: [],
    };
  }
  const rule = policy.rules.find(
    (r) => (r.mode === route.mode || r.mode === "*") && (!r.condition || r.condition === condition),
  );
  if (!rule) {
    return {
      required: true,
      status: "policy_missing",
      required_approvers: [],
      approved_by: [],
      missing_approvers: [],
    };
  }
  const approved = new Set(
    (policy.approvals ?? [])
      .filter(
        (a) =>
          (a.mode === route.mode || a.mode === "*") &&
          (!a.condition || a.condition === rule.condition),
      )
      .map((a) => a.approver),
  );
  const missing = rule.required_approvers.filter((approver) => !approved.has(approver));
  return {
    required: true,
    status: missing.length === 0 ? "approved" : "approval_missing",
    required_approvers: rule.required_approvers,
    approved_by: rule.required_approvers.filter((approver) => approved.has(approver)),
    missing_approvers: missing,
  };
}

export function evaluateRouteCommand(input: {
  signal: string;
  env?: string;
  drift_type?: string;
  finding_type?: string;
  approval_policy?: RouteApprovalPolicy;
  route_map?: RouteSignalEntry[];
  route_config_violations?: RouteConfigViolation[];
}): RouteEvalResult {
  if (input.route_config_violations && input.route_config_violations.length > 0) {
    return {
      ...result(
        input.route_config_violations.map((violation) =>
          finding(
            violation.code,
            "route configuration must not depend on legacy DB or personal absolute paths",
            { evidencePath: violation.path },
          ),
        ),
        input.route_config_violations.map((violation) => violation.path),
      ),
      signal: input.signal,
      mode: null,
      suggest_command: "fix route-map configuration before PLAN creation",
      recommended_command: null,
      finding_route: null,
      approval: {
        required: false,
        status: "not_required",
        required_approvers: [],
        approved_by: [],
        missing_approvers: [],
      },
      escalation_boundaries: [],
      exit_code: 1,
    };
  }
  const escalationBoundaries = detectRouteEscalationBoundaries(input.signal);
  const findingType = normalizeFindingType(input.finding_type) ?? inferFindingType(input.signal);
  const findingRoute = findingType ? FINDING_ROUTE_MAP[findingType] : null;
  const routeInputSignal = findingRoute?.route_signal ?? input.signal;
  const routeInputNormalized = routeInputSignal.trim().toLowerCase();
  const routeMap = [
    ...(findingRoute ? [findingRouteEntry(findingRoute)] : []),
    ...(input.route_map ?? []),
    ...ROUTE_SIGNAL_MAP,
  ];
  const route = routeMap
    .map((entry, index) => ({
      entry,
      index,
      matchLength: routeMatchLength(entry, routeInputNormalized),
    }))
    .filter((candidate) => candidate.matchLength > 0)
    .sort((a, b) => b.matchLength - a.matchLength || a.index - b.index)[0]?.entry;
  if (!route) {
    return {
      ...result([
        finding("no-route", "unknown signal has no route; escalate upstream before PLAN creation", {
          severity: "warn",
        }),
      ]),
      signal: input.signal,
      mode: null,
      suggest_command: "upstream delegation required: define route-map entry before PLAN creation",
      recommended_command: null,
      finding_route: findingRoute,
      approval: {
        required: false,
        status: "not_required",
        required_approvers: [],
        approved_by: [],
        missing_approvers: [],
      },
      escalation_boundaries: escalationBoundaries,
      exit_code: 2,
    };
  }
  const approval = resolveApproval({
    route,
    input: { ...input, signal: routeInputSignal },
    policy: input.approval_policy,
    escalationBoundaries,
  });
  const recommendedCandidate = {
    schema_version: "v1",
    command: route.command,
    args: {
      signal: input.signal,
      mode: route.mode,
      ...(findingRoute ? { route_signal: findingRoute.route_signal } : {}),
      ...(findingRoute ? { finding_type: findingRoute.finding_type } : {}),
      ...(findingRoute ? { source_signal: input.signal } : {}),
      ...(input.env ? { env: input.env } : {}),
      ...(input.drift_type ? { drift_type: input.drift_type } : {}),
    },
    safety: {
      auto_apply: false,
      requires_human_approval: approval.required,
      requires_preflight: route.preflight,
    },
  };
  const recommendedParsed = recommendedCommandV1Schema.safeParse(recommendedCandidate);
  if (!recommendedParsed.success) {
    return {
      ...result(
        [
          finding(
            "legacy-runtime-command",
            "recommended command must start with ut-tdd; legacy runtime command names are forbidden",
          ),
        ],
        [ROUTE_CONTRACT_EVIDENCE_PATH],
      ),
      signal: input.signal,
      mode: route.mode,
      suggest_command: route.command,
      recommended_command: null,
      finding_route: findingRoute,
      approval,
      escalation_boundaries: escalationBoundaries,
      exit_code: 1,
    };
  }
  const approvalFinding =
    approval.status === "policy_missing"
      ? finding("approval-policy-missing", "human approval policy is missing or unresolved")
      : approval.status === "approval_missing"
        ? finding("approval-missing", "required human approval is missing")
        : null;
  return {
    ...result(approvalFinding ? [approvalFinding] : [], [ROUTE_CONTRACT_EVIDENCE_PATH]),
    signal: input.signal,
    mode: route.mode,
    suggest_command:
      route.command === ROUTE_COMMAND_TASK_CLASSIFY
        ? `${route.command} --text "${input.signal}"`
        : route.command,
    recommended_command: recommendedParsed.data,
    finding_route: findingRoute,
    approval,
    escalation_boundaries: escalationBoundaries,
    exit_code: approvalFinding ? 1 : 0,
  };
}
