import { createHash } from "node:crypto";
import type { HarnessDb } from "../state-db/index";
import { upsertRow } from "../state-db/index";
import { DRIVE_TDD_FITS, type DriveTddFit } from "./contracts-policy";
import type {
  CommandEvidence,
  ContractResult,
  Finding,
  ProjectionRef,
  Severity,
  TestRunEvidenceInput,
} from "./contracts-types";

export type { DriveTddFit, TddCompatibility } from "./contracts-policy";
export type {
  CommandEvidence,
  ContractResult,
  Finding,
  ProjectionRef,
  Severity,
  TestCaseEvidence,
  TestRunEvidenceInput,
} from "./contracts-types";

function finding(
  code: string,
  message: string,
  options: { evidencePath?: string; severity?: Severity } = {},
) {
  return {
    code,
    severity: options.severity ?? "error",
    evidence_path: options.evidencePath ?? "",
    message,
  } satisfies Finding;
}

function result(findings: Finding[], evidence_paths: string[] = []): ContractResult {
  return { ok: findings.every((f) => f.severity !== "error"), findings, evidence_paths };
}

function stableId(prefix: string, value: string): string {
  return `${prefix}:${value || "unknown"}`.replace(/[^A-Za-z0-9._:-]+/g, "-");
}

function stableHash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nonEmpty<T>(values: T[] | undefined): T[] {
  return Array.isArray(values) ? values.filter(Boolean) : [];
}

function containsSecret(value: string): boolean {
  return /(sk-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/.test(value);
}

export function recordTestRunEvidence(
  input: TestRunEvidenceInput,
  deps: { db?: HarnessDb; now?: () => string } = {},
): { ok: boolean; findings: Finding[]; refs: ProjectionRef[]; evidence_paths: string[] } {
  const findings: Finding[] = [];
  if (!hasText(input.command)) findings.push(finding("missing-command", "command is required"));
  if (!hasText(input.runner)) findings.push(finding("missing-runner", "runner is required"));
  if (!hasText(input.scope)) findings.push(finding("missing-scope", "scope is required"));
  if (!hasText(input.evidence_path)) {
    findings.push(finding("missing-evidence", "evidence_path is required"));
  } else if (containsSecret(input.evidence_path)) {
    findings.push(finding("secret-evidence", "evidence_path must not contain secret-like values"));
  }
  if (!Number.isInteger(input.exit_code)) {
    findings.push(finding("invalid-exit-code", "exit_code must be an integer"));
  }
  const outputDigest =
    input.output_digest ??
    stableHash(`${input.command}:${input.evidence_path}:${input.completed_at}`);
  const testRunId = stableId(
    "test-run",
    `${input.plan_id ?? "no-plan"}:${input.command}:${input.started_at}`,
  );
  const refs: ProjectionRef[] = [];
  if (deps.db && findings.every((f) => f.severity !== "error")) {
    upsertRow(deps.db, {
      table: "test_runs",
      primaryKey: "test_run_id",
      row: {
        test_run_id: testRunId,
        plan_id: input.plan_id ?? "",
        command: input.command,
        runner: input.runner,
        scope: input.scope,
        started_at: input.started_at,
        completed_at: input.completed_at,
        exit_code: input.exit_code,
        evidence_path: input.evidence_path,
        output_digest: outputDigest,
        status: input.exit_code === 0 ? "passed" : "failed",
      },
    });
    refs.push({ table: "test_runs", id: testRunId, evidence_path: input.evidence_path });
    for (const [index, testCase] of nonEmpty(input.cases).entries()) {
      const testCaseId = stableId("test-case", `${testRunId}:${testCase.oracle_id ?? index}`);
      const resultId = stableId("test-result", `${testCaseId}:${testCase.status}`);
      upsertRow(deps.db, {
        table: "test_cases",
        primaryKey: "test_case_id",
        row: {
          test_case_id: testCaseId,
          test_run_id: testRunId,
          plan_id: input.plan_id ?? "",
          oracle_id: testCase.oracle_id ?? "",
          name: testCase.name,
          status: testCase.status,
          duration_ms: testCase.duration_ms ?? 0,
          evidence_path: input.evidence_path,
        },
      });
      upsertRow(deps.db, {
        table: "test_results",
        primaryKey: "test_result_id",
        row: {
          test_result_id: resultId,
          test_case_id: testCaseId,
          test_run_id: testRunId,
          oracle_id: testCase.oracle_id ?? "",
          status: testCase.status,
          message: testCase.message ?? "",
          evidence_path: input.evidence_path,
        },
      });
      refs.push({ table: "test_cases", id: testCaseId, evidence_path: input.evidence_path });
      refs.push({ table: "test_results", id: resultId, evidence_path: input.evidence_path });
      if (testCase.artifact_path) {
        const edgeId = stableId("test-edge", `${testRunId}:${testCase.artifact_path}:${index}`);
        upsertRow(deps.db, {
          table: "test_artifact_edges",
          primaryKey: "edge_id",
          row: {
            edge_id: edgeId,
            test_artifact_edge_id: stableId("test-edge-compat", stableHash(edgeId)),
            test_case_id: testCaseId,
            test_run_id: testRunId,
            artifact_path: testCase.artifact_path,
            artifact_id: testCase.artifact_path,
            plan_id: input.plan_id ?? "",
            source_path: input.evidence_path,
            edge_kind: "covers",
            oracle_id: testCase.oracle_id ?? "",
            evidence_path: input.evidence_path,
          },
        });
        refs.push({ table: "test_artifact_edges", id: edgeId, evidence_path: input.evidence_path });
      }
    }
  }
  if (!input.plan_id) {
    findings.push(
      finding("missing-plan-id", "missing plan_id creates a finding, not silent pass", {
        evidencePath: input.evidence_path,
        severity: "warn",
      }),
    );
  }
  if (nonEmpty(input.cases).some((c) => !c.oracle_id)) {
    findings.push(
      finding("missing-oracle-id", "missing oracle_id creates a finding, not silent pass", {
        evidencePath: input.evidence_path,
        severity: "warn",
      }),
    );
  }
  return {
    ok: findings.every((f) => f.severity !== "error"),
    findings,
    refs,
    evidence_paths: [input.evidence_path].filter(Boolean),
  };
}

export function evaluateGreenDefinition(input: {
  profile: string;
  required_commands: string[];
  command_evidence: CommandEvidence[];
  reviewed_at?: string;
}): ContractResult & { computed_green_at?: string; missing: string[]; non_green: string[] } {
  const evidenceByKind = new Map(input.command_evidence.map((e) => [e.kind, e]));
  const missing = input.required_commands.filter((kind) => !evidenceByKind.has(kind));
  const nonGreen = input.command_evidence.filter((e) => e.exit_code !== 0).map((e) => e.kind);
  const findings: Finding[] = [
    ...missing.map((kind) => finding("missing-command-evidence", `missing ${kind}`)),
    ...nonGreen.map((kind) => finding("non-green-command", `${kind} exit_code is non-zero`)),
  ];
  const completed = input.command_evidence
    .map((e) => e.completed_at)
    .filter(Boolean)
    .sort();
  const computedGreenAt =
    missing.length === 0 && nonGreen.length === 0 ? completed.at(-1) : undefined;
  if (computedGreenAt && input.reviewed_at && computedGreenAt > input.reviewed_at) {
    findings.push(finding("review-before-green", "computed green time is after review time"));
  }
  return {
    ...result(
      findings,
      input.command_evidence.map((e) => e.evidence_path),
    ),
    computed_green_at: computedGreenAt,
    missing,
    non_green: nonGreen,
  };
}

export function computeUtHistorySignals(input: {
  test_runs: TestRunEvidenceInput[];
  required_oracles?: string[];
}): {
  signals: { signal_type: string; subject_id: string; score: number; evidence_path: string }[];
} {
  const runs = input.test_runs;
  const cases = runs.flatMap((run) => nonEmpty(run.cases));
  const required = new Set(input.required_oracles ?? []);
  const covered = new Set(cases.map((c) => c.oracle_id).filter((id): id is string => !!id));
  const passedRuns = runs.filter((run) => run.exit_code === 0).length;
  const failedByOracle = new Map<string, number>();
  for (const c of cases.filter((c) => c.oracle_id && c.status === "failed")) {
    failedByOracle.set(c.oracle_id ?? "", (failedByOracle.get(c.oracle_id ?? "") ?? 0) + 1);
  }
  const oracleCoverage = required.size === 0 ? 1 : covered.size / required.size;
  const planGreenRate = runs.length === 0 ? 0 : passedRuns / runs.length;
  const flakeScore =
    covered.size === 0
      ? 0
      : [...failedByOracle.values()].filter((n) => n === 1).length / covered.size;
  const evidencePath = runs.find((run) => run.evidence_path)?.evidence_path ?? "";
  return {
    signals: [
      {
        signal_type: "oracle_coverage",
        subject_id: "ut-history",
        score: oracleCoverage,
        evidence_path: evidencePath,
      },
      {
        signal_type: "plan_green_rate",
        subject_id: "ut-history",
        score: planGreenRate,
        evidence_path: evidencePath,
      },
      {
        signal_type: "flake_score",
        subject_id: "ut-history",
        score: flakeScore,
        evidence_path: evidencePath,
      },
      {
        signal_type: "green_definition_compliance",
        subject_id: "ut-history",
        score: planGreenRate === 1 ? 1 : 0,
        evidence_path: evidencePath,
      },
    ],
  };
}

export type {
  RouteApprovalPolicy,
  RouteApprovalResult,
  RouteConfigViolation,
  RouteEscalationBoundary,
  RouteEvalResult,
  RouteSignalEntry,
} from "./routing-contracts";
export {
  detectRouteEscalationBoundaries,
  evaluateRouteCommand,
  routeSignalToMode,
  validateDContractDsl,
  validateRouteConfigText,
} from "./routing-contracts";
export function recordCrossCuttingEvent(input: {
  type: string;
  subject_id: string;
  severity: Severity;
  evidence_path: string;
}): { ok: boolean; findings: Finding[]; ref?: ProjectionRef } {
  const findings: Finding[] = [];
  if (!hasText(input.type)) findings.push(finding("missing-type", "event type is required"));
  if (!hasText(input.subject_id))
    findings.push(finding("missing-subject", "subject_id is required"));
  if (!hasText(input.evidence_path))
    findings.push(finding("missing-evidence", "evidence_path is required"));
  return {
    ok: findings.length === 0,
    findings,
    ref:
      findings.length === 0
        ? {
            table: "findings",
            id: stableId(`cross:${input.type}`, input.subject_id),
            evidence_path: input.evidence_path,
          }
        : undefined,
  };
}

export {
  buildCommandCatalog,
  catalogExistingAssets,
  catalogSkills,
  classifyDrive,
  prioritizeCapabilityGaps,
  recommendModelEffort,
  recommendSkills,
  renderFoundationReadiness,
  resolveDriveStatePartition,
  scoreTaskComplexity,
  suggestSkillInjection,
  validateFolderRules,
} from "./contracts-extras";
export function enforceForwardOrder(input: {
  layer: string;
  gate: string;
  prior_gates: { gate: string; status: string; evidence_path?: string }[];
}): ContractResult & { allowed: boolean } {
  const blocked = input.prior_gates.filter(
    (g) => g.status !== "passed" && g.status !== "confirmed",
  );
  const findings = blocked.map((g) =>
    finding("prior-gate-not-passed", `${g.gate} is ${g.status}`, {
      evidencePath: g.evidence_path ?? "",
    }),
  );
  return { ...result(findings), allowed: blocked.length === 0 };
}

export function routeReverseR4(input: {
  reverse_type: string;
  r4_evidence: { status: string; evidence_path: string };
  forward_routing?: string;
}): ContractResult & { target_plan?: string } {
  const findings =
    input.r4_evidence.status === "confirmed"
      ? []
      : [
          finding("reverse-not-confirmed", "R4 evidence must be confirmed", {
            evidencePath: input.r4_evidence.evidence_path,
          }),
        ];
  if (!input.forward_routing)
    findings.push(finding("missing-forward-routing", "forward_routing is required"));
  return {
    ...result(findings, [input.r4_evidence.evidence_path]),
    target_plan: findings.length === 0 ? input.forward_routing : undefined,
  };
}

export function decideDiscoveryS4(input: {
  hypothesis: string;
  poc_evidence: { status: string; evidence_path: string };
  outcome: "confirmed" | "rejected" | "pivot";
}): ContractResult & { decision: string } {
  const findings = input.poc_evidence.status
    ? []
    : [finding("missing-poc-evidence", "PoC evidence is required")];
  return { ...result(findings, [input.poc_evidence.evidence_path]), decision: input.outcome };
}

export function detectFrontendDrift(input: {
  mock_root?: string;
  token_root?: string;
  a11y?: string;
  vrt?: string;
}): ContractResult & { drift_signals: string[] } {
  const required = ["mock_root", "token_root", "a11y", "vrt"] as const;
  const missing = required.filter((key) => !input[key]);
  const findings = missing.map((key) =>
    finding("frontend-evidence-absent", `${key} absent by contract`, { severity: "warn" }),
  );
  return { ...result(findings), drift_signals: missing.map((key) => `absent:${key}`) };
}

export function routeScrumFullback(input: {
  increment: string;
  s4_decision: "confirmed" | "rejected" | "pivot";
}): ContractResult & { forward_targets: string[] } {
  const allowed = input.s4_decision === "confirmed";
  return {
    ...result(
      allowed
        ? []
        : [finding("scrum-not-confirmed", "only confirmed increments can enter Forward")],
    ),
    forward_targets: allowed ? [`Forward:${input.increment}`] : [],
  };
}

export function assertRefactorInvariant(input: {
  before: string;
  after: string;
  regression: { exit_code: number; evidence_path: string; test_ids?: string[] };
}): ContractResult & { unchanged: boolean; linked_test_ids: string[] } {
  const unchanged = input.before === input.after && input.regression.exit_code === 0;
  const linkedTestIds = nonEmpty(input.regression.test_ids);
  const findings = [
    ...(unchanged
      ? []
      : [
          finding("refactor-invariant-broken", "behavior changed or regression failed", {
            evidencePath: input.regression.evidence_path,
          }),
        ]),
    ...(linkedTestIds.length > 0
      ? []
      : [
          finding(
            "refactor-test-id-missing",
            "refactor green requires linked regression test ids",
            {
              evidencePath: input.regression.evidence_path,
            },
          ),
        ]),
  ];
  return {
    ...result(findings, [input.regression.evidence_path]),
    unchanged,
    linked_test_ids: linkedTestIds,
  };
}

export function evaluateRetrofitMatrix(input: {
  migration?: string;
  config?: string;
  rollback?: string;
}): ContractResult & { readiness: "ready" | "blocked" } {
  const missing = ["migration", "config", "rollback"].filter(
    (key) => !input[key as keyof typeof input],
  );
  const findings = missing.map((key) =>
    finding("retrofit-evidence-missing", `${key} evidence is missing`),
  );
  return { ...result(findings), readiness: findings.length === 0 ? "ready" : "blocked" };
}

export function evaluateResearchDecision(input: {
  memo: string;
  sources: string[];
  adr_candidate?: string;
}): ContractResult & { decision_ready: boolean } {
  const findings: Finding[] = [];
  if (!hasText(input.memo))
    findings.push(finding("missing-research-memo", "research memo is required"));
  if (input.sources.length === 0)
    findings.push(finding("missing-sources", "source list is required"));
  if (!input.adr_candidate)
    findings.push(
      finding("missing-adr-candidate", "ADR candidate is required", { severity: "warn" }),
    );
  return { ...result(findings), decision_ready: findings.every((f) => f.severity !== "error") };
}

export function mergeTwoStageAgentDesign(input: {
  phase1?: string;
  phase2?: string;
  handoff?: string;
}): ContractResult & { merged?: string } {
  const missing = ["phase1", "phase2", "handoff"].filter(
    (key) => !input[key as keyof typeof input],
  );
  const findings = missing.map((key) =>
    finding("missing-agent-design-stage", `${key} is required`),
  );
  return {
    ...result(findings),
    merged:
      findings.length === 0 ? `${input.phase1}\n${input.phase2}\n${input.handoff}` : undefined,
  };
}

function validateRequiredArtifacts(
  input: Record<string, unknown>,
  required: string[],
  code: string,
): ContractResult & { complete: boolean } {
  const findings = required
    .filter((key) => !input[key])
    .map((key) => finding(code, `${key} is required`));
  return { ...result(findings), complete: findings.length === 0 };
}

export function validateScreenDesignWorkflow(input: Record<string, unknown>) {
  return validateRequiredArtifacts(
    input,
    ["ia", "screens", "flow", "wireframe", "mock", "components"],
    "screen-design-artifact-missing",
  );
}

export function validateFrontendDesignWorkflow(input: Record<string, unknown>) {
  return validateRequiredArtifacts(
    input,
    ["visual", "tokens", "a11y", "vrt", "ux"],
    "frontend-design-artifact-missing",
  );
}

export function classifyDriveTddFits(input: { modes?: string[] } = {}): ContractResult & {
  fits: DriveTddFit[];
} {
  const requested = new Set((input.modes ?? []).map((mode) => mode.trim()).filter(Boolean));
  const fits =
    requested.size === 0 ? DRIVE_TDD_FITS : DRIVE_TDD_FITS.filter((fit) => requested.has(fit.mode));
  const findings =
    requested.size > 0 && fits.length !== requested.size
      ? [
          finding("unknown-tdd-drive-mode", "some requested modes have no TDD fit definition", {
            severity: "warn",
          }),
        ]
      : [];
  return { ...result(findings), fits };
}
