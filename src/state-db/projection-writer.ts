import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { parse as parseYaml } from "yaml";
import type { DocumentExportProjectionRows } from "../export/document-export.ts";
import {
  buildDocumentExportDataset,
  type CanonicalDocumentFamily,
  parseCanonicalDocumentStructure,
} from "../export/document-export.ts";
import { loadRelationGraphSourceSet } from "../graph/loader.ts";
import { resolveLegacyPlanAlias } from "../kernel/plan-alias.ts";
import { loadChangedFiles } from "../lint/change-impact.ts";
import {
  analyzeDescentObligations,
  loadDeferLedger,
  loadDescentAdjacency,
  loadTraceKeyedArtifacts,
} from "../lint/descent-obligation.ts";
import { analyzeDocConsistency, loadDocConsistencyDocs } from "../lint/doc-consistency.ts";
import {
  analyzeEntityCoverage,
  loadBusiness as loadEntityBusiness,
} from "../lint/entity-coverage.ts";
import { analyzeFrRegistry, loadFrDocs as loadFrRegistryDocs } from "../lint/fr-registry-audit.ts";
import {
  analyzeFrRoadmapCoverageWithRoot,
  loadFrRoadmapCoverageDocs,
} from "../lint/fr-roadmap-coverage.ts";
import { analyzeL6FrCoverage, loadL6FrCoverageDocs } from "../lint/l6-fr-coverage.ts";
import { analyzeModuleDrift, loadModuleDocs } from "../lint/module-drift.ts";
import {
  analyzeRelationImpact,
  collectRelationGraphProjection,
  type RelationGraphProjection,
  type VerificationEvidenceProjection,
} from "../lint/relation-graph.ts";
import { loadReviewPlans } from "../lint/review-evidence.ts";
import {
  computeGateProgress,
  computeProgramRollup,
  loadRoadmaps,
  PARKED_BANDS,
} from "../lint/roadmap-registry.ts";
import {
  analyzeSubDocCatalogDrift,
  loadSubDocCatalogDriftInput,
} from "../lint/sub-doc-catalog-drift.ts";
import {
  analyzeSubDocSectionStructure,
  loadSubDocSectionStructureInput,
} from "../lint/sub-doc-section-structure.ts";
import {
  catalogVerificationProfiles,
  recommendVerificationProfiles,
} from "../lint/verification-profile.ts";
import { loadMemoryEntries } from "../memory/index.ts";
import { RepositoryModelEvaluationConfig } from "../projection/adapters/model-evaluation-config.ts";
import { loadRepositoryPlanSources } from "../projection/adapters/repository-plan-sources.ts";
import { projectModelEvaluations as projectModelEvaluationsApplication } from "../projection/application/project-model-evaluations.ts";
import { projectOperationalMetrics as projectOperationalMetricsApplication } from "../projection/application/project-operational-metrics.ts";
import { projectPocEvaluations as projectPocEvaluationsApplication } from "../projection/application/project-poc-evaluations.ts";
import type { ProjectionEvent } from "../projection/contracts/projection-store.ts";
import { type ProjectedPlan, projectPlanSources } from "../projection/domain/plan-projection.ts";
import { HARNESS_DB_TABLES } from "../schema/harness-db.ts";
import { workflowModeForPlan as catalogWorkflowModeForPlan } from "../schema/mode-catalog.ts";
import { normalizePath } from "../shared/source-text.ts";
import { stableId } from "../stable-id.ts";
import { analyzePairFreeze, loadPairDocs, type PairOrphanReason } from "../vmodel/lint.ts";
import { deriveArtifactProgressDecision } from "./artifact-progress-decision.ts";
import { DESIGN_QUALITY_CHECK_IDS, type DesignQualityCheckId } from "./design-detection.ts";
import {
  projectFeedbackEvents,
  projectFeedbackLifecycle,
  projectImprovementLog,
  projectIssueApprovalGuardrails,
  projectIssueQueue,
  projectRefactorCandidateSignals,
  projectRetryEvents,
  projectTroubleEvents,
  projectVerificationDefectRoutingRefactorCandidates,
  reconcileFeedbackLifecycle,
} from "./feedback-projections.ts";
import { rebuildExecutionReadiness } from "./github-forward-projection.ts";
import { type GuardrailDecisionInput, inspectGuardrailInvariants } from "./guardrail-invariants.ts";
import { defaultHarnessDbPath, type HarnessDb, openHarnessDb } from "./index.ts";
import { migrate, rowCounts } from "./migration.ts";
import {
  projectRuntimeGuardrailDecisionFromSessionEvent as projectRuntimeGuardrailDecisionFromSessionEventCore,
  projectRuntimeSkillInvocationFromSessionEvent as projectRuntimeSkillInvocationFromSessionEventCore,
  projectRuntimeSkillInvocationsFromSessionLogs as projectRuntimeSkillInvocationsFromSessionLogsCore,
  projectRuntimeTestRunFromSessionEvent as projectRuntimeTestRunFromSessionEventCore,
} from "./runtime-projections.ts";
import {
  projectSkillEvaluations as projectSkillEvaluationsCore,
  projectSkillMetrics as projectSkillMetricsCore,
  projectSkillTelemetry as projectSkillTelemetryCore,
  skillScore,
} from "./skill-projections.ts";
import { projectSpecIr } from "./spec-ir-projections.ts";
import { clearRebuildableProjectionTables } from "./sqlite-projection-rebuild.ts";
import { type ProjectionFindingInput, SqliteProjectionStore } from "./sqlite-projection-store.ts";
import { runSqliteTransaction } from "./sqlite-transaction.ts";
import {
  loadRepoScopedRuntimeSessionUsage,
  type RepoScopeIngestStats,
  type RunUsage,
  type SessionScanDirs,
} from "./token-tracker.ts";
import { hasVmodelAuthoring, projectVmodelAuthoring } from "./vmodel-projections.ts";

export type { ProjectionEvent } from "../projection/contracts/projection-store.ts";

export interface RebuildHarnessDbInput {
  repoRoot?: string;
  db?: HarnessDb;
  relationGraph?: RelationGraphProjection;
  documentExports?: DocumentExportProjectionRows;
  verificationEvidence?: VerificationEvidenceProjection;
  timing?: boolean;
  /** token telemetry は外部セッション走査を伴うため、軽量な in-memory 投影では省略できる。 */
  skipTokenTelemetry?: boolean;
}

export interface ProjectionTiming {
  id: string;
  duration_ms: number;
}

export interface RebuildHarnessDbResult {
  ok: boolean;
  path: string;
  rowCounts: Record<string, number>;
  findings: string[];
  inputs: {
    relationGraph?: RelationGraphProjection;
    documentExports?: DocumentExportProjectionRows;
    verificationEvidence?: VerificationEvidenceProjection;
  };
  timings?: ProjectionTiming[];
  /** repo スコープ token telemetry ingest の走査統計 (issue #82、可視化用)。 */
  tokenIngest?: RepoScopeIngestStats;
}

export {
  type ArtifactProgressColor,
  type ArtifactProgressDecision,
  type ArtifactProgressDecisionInput,
  type ArtifactProgressState,
  deriveArtifactProgressDecision,
} from "./artifact-progress-decision.ts";

interface PlanDigestProjection {
  plan_id: string;
  sessions?: string[];
  event_counts?: Record<string, number>;
  updated_at?: string;
}

interface SessionLogProjection {
  ts?: string;
  session_id?: string;
  plan_id?: string | null;
  event_type?: string;
  tool?: string;
  target?: string;
  outcome?: string;
}

interface ProjectedGateRunEvidence {
  gate_run_id?: unknown;
  gate_id?: unknown;
  plan_id?: unknown;
  status?: unknown;
  checked_at?: unknown;
}

interface ProviderHandoverProjection {
  handover_id?: string;
  from?: string;
  to?: string;
  active_plan?: string;
  created_at?: string;
  context?: {
    summary?: string;
  };
}

const VERIFY_CUTOVER_PLAN_ID = "PLAN-M-00-verify-cutover";
const VERIFY_CUTOVER_AUDIT_PATH = ".ut-tdd/audit/A-132-l8-l14-verification-band-execution.md";
const VERIFICATION_BAND_LAYERS = ["L8", "L9", "L10", "L11", "L12", "L13", "L14"] as const;

function nowIso(): string {
  return new Date().toISOString();
}

function stableHash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function relationArtifactId(nodeId: string): string {
  return stableId("relation-artifact", nodeId);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function scalarNumber(db: HarnessDb, sql: string, params: unknown[] = []): number {
  const row = db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  const value = row?.value;
  return typeof value === "number" ? value : Number(value ?? 0);
}

function planExists(db: HarnessDb, planId: string): boolean {
  return new SqliteProjectionStore(db).planExists(planId);
}

function recordFinding(db: HarnessDb, input: ProjectionFindingInput): void {
  new SqliteProjectionStore(db).recordFinding(input);
}

function designCoverageId(subjectId: string): string {
  return stableId("design-quality-coverage", `${subjectId}:violation_count`);
}

function recordDesignQualityCoverage(
  db: HarnessDb,
  input: {
    subjectId: DesignQualityCheckId;
    violationCount: number;
  },
): void {
  const passed = input.violationCount <= 0;
  recordProjectionEvent(db, {
    table: "coverage",
    id: designCoverageId(input.subjectId),
    row: {
      coverage_id: designCoverageId(input.subjectId),
      scope: "design-quality",
      subject_id: input.subjectId,
      metric: "violation_count",
      value: input.violationCount,
      threshold: 0,
      status: passed ? "passed" : "blocked",
    },
  });
}

function designQualityLoadError(db: HarnessDb, subjectId: DesignQualityCheckId): void {
  recordDesignQualityCoverage(db, { subjectId, violationCount: 1 });
  recordFinding(db, {
    kind: "design-quality-load-error",
    severity: "error",
    subjectId,
    source: "design-quality-projection",
  });
}

export function projectDesignPairFreezeFindings(repoRoot: string, db: HarnessDb): void {
  let result: ReturnType<typeof analyzePairFreeze>;
  try {
    result = analyzePairFreeze(loadPairDocs(repoRoot));
  } catch {
    recordFinding(db, {
      kind: "design-pair-orphan:load-error",
      severity: "error",
      subjectId: "vmodel-pair-freeze",
      source: "vmodel-pair-freeze",
      evidencePath: "docs/design/harness",
    });
    return;
  }
  const knownReasons = new Set<PairOrphanReason>([
    "pair-missing",
    "ref-unresolved",
    "trace-orphan",
  ]);
  for (const orphan of result.orphans) {
    const reason = knownReasons.has(orphan.reason) ? orphan.reason : "trace-orphan";
    recordFinding(db, {
      kind: `design-pair-orphan:${reason}`,
      severity: "error",
      subjectId: orphan.path,
      source: "vmodel-pair-freeze",
      evidencePath: orphan.path,
    });
  }
}

function projectOneDesignQualityCoverage(
  db: HarnessDb,
  subjectId: DesignQualityCheckId,
  run: () => number,
): void {
  try {
    recordDesignQualityCoverage(db, { subjectId, violationCount: run() });
  } catch {
    designQualityLoadError(db, subjectId);
  }
}

export function projectDesignQualityCoverage(repoRoot: string, db: HarnessDb): void {
  const expected = new Set<DesignQualityCheckId>(DESIGN_QUALITY_CHECK_IDS);
  const checks: Record<DesignQualityCheckId, () => number> = {
    "doc-consistency": () => {
      const result = analyzeDocConsistency(loadDocConsistencyDocs(repoRoot));
      return (
        result.carryOrphans.length +
        result.screenIdOrphans.length +
        (result.nfrCount.mismatch ? 1 : 0)
      );
    },
    "entity-coverage": () => analyzeEntityCoverage(loadEntityBusiness(repoRoot)).duplicates.length,
    "fr-registry-audit": () => {
      const result = analyzeFrRegistry(loadFrRegistryDocs(repoRoot));
      return (
        result.unregistered.length +
        result.unexplainedGaps.length +
        result.attributeOrphans.length +
        result.countMismatches.length +
        result.screenCoverageOrphans.length
      );
    },
    "sub-doc-catalog-drift": () =>
      analyzeSubDocCatalogDrift(loadSubDocCatalogDriftInput(repoRoot)).drift.length,
    "sub-doc-section-structure": () =>
      analyzeSubDocSectionStructure(loadSubDocSectionStructureInput(repoRoot)).violations.length,
    "l6-fr-coverage": () => {
      const result = analyzeL6FrCoverage(loadL6FrCoverageDocs(repoRoot));
      return (
        result.missing.length +
        result.unknown.length +
        result.incomplete.length +
        result.missingSpecFiles.length +
        result.weakContracts.length +
        result.missingSubstance.length
      );
    },
    "fr-roadmap-coverage": () => {
      const result = analyzeFrRoadmapCoverageWithRoot(
        loadFrRoadmapCoverageDocs(repoRoot),
        repoRoot,
      );
      return (result.checked === 0 ? 1 : 0) + result.violations.length + result.openRows.length;
    },
    "module-drift": () => analyzeModuleDrift(loadModuleDocs(repoRoot)).orphans.length,
  };
  for (const subjectId of DESIGN_QUALITY_CHECK_IDS) {
    const check = checks[subjectId];
    if (!check || !expected.has(subjectId)) {
      designQualityLoadError(db, subjectId);
      continue;
    }
    projectOneDesignQualityCoverage(db, subjectId, check);
  }
}

export function recordProjectionEvent(db: HarnessDb, event: ProjectionEvent): void {
  new SqliteProjectionStore(db).record(event);
}

function markdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(dir, name))
    .sort();
}

function frontmatterValue(content: string, key: string): string {
  const match = content.match(new RegExp(`^${key}:\\s*"?([^"\\r\\n]+)"?`, "m"));
  return match?.[1]?.trim() ?? "";
}

function markdownFrontmatter(content: string): string {
  if (!content.startsWith("---")) return "";
  const end = content.indexOf("\n---", 3);
  return end < 0 ? "" : content.slice(3, end);
}

function metadataFromContent(path: string, content: string): Record<string, unknown> {
  const raw = /\.md$/i.test(path) ? markdownFrontmatter(content) : content;
  if (!raw.trim()) return {};
  const parsed = parseYaml(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

// PLAN-L7-243: mode 導出は route_mode 正本 + legacy フォールバック (mode-catalog) へ置換。
// plan_id prefix 4 分岐のみの旧導出 (kind=refactor/troubleshoot 等の Forward 落ち) は廃止。
function planModeResolver(plans: Map<string, ProjectedPlan>): (planId: string) => string {
  return (planId) => {
    const plan = plans.get(planId);
    return catalogWorkflowModeForPlan({
      planId,
      routeMode: plan?.routeMode,
      kind: plan?.kind,
    });
  };
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function projectPlans(repoRoot: string, db: HarnessDb): Map<string, ProjectedPlan> {
  const result = projectPlanSources(loadRepositoryPlanSources(repoRoot), {
    stableId,
    hash: stableHash,
  });
  for (const write of result.writes) recordProjectionEvent(db, write);
  return new Map(result.plans);
}

function projectDriveRuns(
  repoRoot: string,
  db: HarnessDb,
  plans: Map<string, ProjectedPlan>,
): void {
  for (const plan of plans.values()) {
    const digest = readJson<PlanDigestProjection>(
      join(repoRoot, ".ut-tdd", "logs", "plan", `${plan.planId}.digest.json`),
    );
    const sessions = ["", ...(digest?.sessions ?? [])];
    for (const sessionId of sessions) {
      const id = stableId("drive-run", `${plan.planId}:${sessionId || "documented"}`);
      const completed = (digest?.event_counts?.session_end ?? 0) > 0;
      recordProjectionEvent(db, {
        table: "drive_runs",
        id,
        row: {
          drive_run_id: id,
          plan_id: plan.planId,
          session_id: sessionId,
          drive: plan.drive,
          mode: catalogWorkflowModeForPlan({
            planId: plan.planId,
            routeMode: plan.routeMode,
            kind: plan.kind,
          }),
          layer: plan.layer,
          kind: plan.kind,
          started_at: plan.updatedAt || digest?.updated_at || "",
          completed_at: completed ? (digest?.updated_at ?? "") : "",
          status: sessionId ? (completed ? "completed" : "active") : plan.status || "documented",
        },
      });
    }
  }
}

function resolveProjectedPlanId(plans: Map<string, ProjectedPlan>, planId: string): string {
  const resolved = resolveLegacyPlanAlias(planId, [...plans.keys()]);
  return resolved.ok ? resolved.value : planId;
}

function projectHookEvents(
  repoRoot: string,
  db: HarnessDb,
  plans: Map<string, ProjectedPlan>,
): void {
  const sessionDir = join(repoRoot, ".ut-tdd", "logs", "session");
  if (existsSync(sessionDir)) {
    for (const file of readdirSync(sessionDir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort()) {
      const path = join(sessionDir, file);
      const relPath = normalizePath(relative(repoRoot, path));
      for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        let event: SessionLogProjection;
        try {
          event = JSON.parse(line) as SessionLogProjection;
        } catch {
          continue;
        }
        if (!event.session_id || !event.plan_id || !event.event_type) continue;
        const hookName =
          event.event_type === "session_start"
            ? "SessionStart"
            : event.event_type === "session_end"
              ? "Stop"
              : event.event_type === "forced_stop"
                ? "ForcedStop"
                : "PostToolUse";
        const id = stableId(
          "hook-event",
          `${event.session_id}:${event.plan_id}:${event.ts ?? ""}:${event.event_type}`,
        );
        recordProjectionEvent(db, {
          table: "hook_events",
          id,
          row: {
            event_id: id,
            session_id: event.session_id,
            plan_id: resolveProjectedPlanId(plans, event.plan_id),
            hook_name: hookName,
            event_type: event.event_type,
            occurred_at: event.ts ?? "",
            digest: event.outcome ?? "",
            evidence_path: relPath,
          },
        });
        projectRuntimeTestRunFromSessionEvent({ db, plans, event, evidencePath: relPath });
        projectRuntimeGuardrailDecisionFromSessionEvent({
          db,
          plans,
          event,
          evidencePath: relPath,
        });
      }
    }
  }

  const providerDir = join(repoRoot, ".ut-tdd", "handover", "provider");
  if (!existsSync(providerDir)) return;
  for (const file of readdirSync(providerDir)
    .filter((name) => name.endsWith(".json"))
    .sort()) {
    const path = join(providerDir, file);
    const relPath = normalizePath(relative(repoRoot, path));
    const handover = readJson<ProviderHandoverProjection>(path);
    const rawPlanId = asString(handover?.active_plan);
    if (!rawPlanId) continue;
    const planId = resolveProjectedPlanId(plans, rawPlanId);
    const handoverId = asString(handover?.handover_id) ?? file.replace(/\.json$/, "");
    const id = stableId("hook-event", `provider:${handoverId}:${planId}`);
    recordProjectionEvent(db, {
      table: "hook_events",
      id,
      row: {
        event_id: id,
        session_id: handoverId,
        plan_id: planId,
        hook_name: "ProviderHandover",
        event_type: "provider_handover",
        occurred_at: handover?.created_at ?? "",
        digest: handover?.context?.summary ?? `${handover?.from ?? ""}->${handover?.to ?? ""}`,
        evidence_path: relPath,
      },
    });
  }
}

export interface RuntimeTestRunProjectionInput {
  db: HarnessDb;
  plans: Map<string, ProjectedPlan>;
  event: SessionLogProjection;
  evidencePath: string;
}

export interface RuntimeGuardrailDecisionProjectionInput {
  db: HarnessDb;
  plans: Map<string, ProjectedPlan>;
  event: SessionLogProjection;
  evidencePath: string;
}

export interface RuntimeSkillInvocationProjectionInput {
  db: HarnessDb;
  plans: Map<string, ProjectedPlan>;
  event: SessionLogProjection;
  evidencePath: string;
}

export function projectRuntimeTestRunFromSessionEvent(input: RuntimeTestRunProjectionInput): void {
  projectRuntimeTestRunFromSessionEventCore({
    ...input,
    deps: {
      stableId,
      resolvePlanId: (planId) => resolveProjectedPlanId(input.plans, planId),
      recordProjectionEvent,
    },
  });
}

export function projectRuntimeGuardrailDecisionFromSessionEvent(
  input: RuntimeGuardrailDecisionProjectionInput,
): void {
  projectRuntimeGuardrailDecisionFromSessionEventCore({
    ...input,
    deps: {
      stableId,
      resolvePlanId: (planId) => resolveProjectedPlanId(input.plans, planId),
      recordProjectionEvent,
    },
  });
}

export function projectRuntimeSkillInvocationFromSessionEvent(
  input: RuntimeSkillInvocationProjectionInput,
): void {
  projectRuntimeSkillInvocationFromSessionEventCore({
    ...input,
    deps: {
      stableId,
      resolvePlanId: (planId) => resolveProjectedPlanId(input.plans, planId),
      recordProjectionEvent,
      skillScore: (plan, asset) =>
        skillScore({
          plan,
          asset,
          deps: { skillDriveModelForPlan: planModeResolver(input.plans) },
        }),
    },
  });
}

function projectRuntimeSkillInvocationsFromSessionLogs(
  repoRoot: string,
  db: HarnessDb,
  plans: Map<string, ProjectedPlan>,
): void {
  projectRuntimeSkillInvocationsFromSessionLogsCore({
    repoRoot,
    db,
    plans,
    deps: {
      stableId,
      resolvePlanId: (planId) => resolveProjectedPlanId(plans, planId),
      recordProjectionEvent,
      skillScore: (plan, asset) =>
        skillScore({
          plan,
          asset,
          deps: { skillDriveModelForPlan: planModeResolver(plans) },
        }),
    },
  });
}

function runtimeForModel(model: string): string {
  if (/claude/i.test(model)) return "claude";
  if (/gpt|codex/i.test(model)) return "codex";
  return "";
}

function projectReviewModelRuns(
  repoRoot: string,
  db: HarnessDb,
  plans: Map<string, ProjectedPlan>,
): void {
  for (const plan of loadReviewPlans(repoRoot)) {
    const meta = plans.get(plan.plan_id);
    plan.crossEntries.forEach((entry, index) => {
      for (const role of ["worker", "reviewer"] as const) {
        const model = role === "worker" ? entry.worker_model : entry.reviewer_model;
        if (!model) continue;
        const id = stableId("model-run", `${plan.plan_id}:${index}:${role}:${model}`);
        recordProjectionEvent(db, {
          table: "model_runs",
          id,
          row: {
            run_id: id,
            runtime: runtimeForModel(model),
            model,
            role,
            drive: meta?.drive ?? "",
            plan_id: plan.plan_id,
            started_at: entry.tests_green_at ?? entry.reviewed_at ?? "",
            completed_at: entry.reviewed_at ?? "",
            evidence_path: normalizePath(join("docs", "plans", plan.file)),
          },
        });
      }
    });
  }
}

/**
 * token-tracker が走査した session ログの RunUsage[] を model_runs へ投入する (FR-L1-38、PLAN-L7-57)。
 * review-evidence 由来行 (token NULL) とは別ソースで、token/cost 列が非 NULL の行を足す。
 * cold-start (usages 空) は no-op。run_id は runtime:session:turn から安定生成 (再投入で重複しない)。
 */
export function projectTokenUsage(db: HarnessDb, usages: RunUsage[]): void {
  if (usages.length === 0) return;
  runSqliteTransaction(db, () => {
    for (const u of usages) {
      if (!u.model) continue; // model 不明の行は集計不能なので捨てる
      const id = stableId("token-run", `${u.runtime}:${u.sessionId}:${u.turnIndex}`);
      recordProjectionEvent(db, {
        table: "model_runs",
        id,
        row: {
          run_id: id,
          runtime: u.runtime,
          model: u.model,
          role: "session",
          drive: "",
          plan_id: "",
          started_at: "",
          completed_at: "",
          evidence_path: u.sessionId,
          input_tokens: u.inputTokens,
          output_tokens: u.outputTokens,
          cached_input_tokens: u.cachedInputTokens,
          reasoning_tokens: u.reasoningTokens,
          cost_usd: u.costUsd,
        },
      });
    }
  });
}

/**
 * repo スコープの session ディレクトリを解決する (env override > OS default)。doctor 経路
 * (`projectRuntimeModelTelemetryForDoctor`、src/doctor/db-projection.ts) と同じ解決順を踏襲する。
 */
function repoScopedSessionDirs(): SessionScanDirs {
  return {
    claudeDirs: [process.env.UT_TDD_CLAUDE_SESSIONS_DIR ?? join(homedir(), ".claude", "projects")],
    codexDirs: [process.env.UT_TDD_CODEX_SESSIONS_DIR ?? join(homedir(), ".codex", "sessions")],
  };
}

/**
 * repo スコープの実測 token/cost telemetry を model_runs へ投入する (issue #82、PLAN-L7-454)。
 * `loadRepoScopedRuntimeSessionUsage` で **この repo に帰属する session usage のみ** (Claude
 * project-slug ディレクトリ / Codex session cwd フィルタ) を取得し `projectTokenUsage` へ渡す。
 * cold-start (該当ログ不在) は no-op。個別ファイルの読取失敗は loadRepoScopedRuntimeSessionUsage 内で
 * fail-open 済み (rebuild 全体を落とさない)。
 */
export function projectRepoScopedTokenUsage(repoRoot: string, db: HarnessDb): RepoScopeIngestStats {
  const { usages, stats } = loadRepoScopedRuntimeSessionUsage(repoRoot, repoScopedSessionDirs());
  projectTokenUsage(db, usages);
  return stats;
}

function planStatusMap(repoRoot: string): Map<string, string> {
  return new Map(loadReviewPlans(repoRoot).map((plan) => [plan.plan_id, plan.status]));
}

function projectRoadmapRollup(repoRoot: string, db: HarnessDb): void {
  const records = loadRoadmaps(repoRoot);
  const statuses = planStatusMap(repoRoot);
  const statusOf = (planId: string): string | null => statuses.get(planId) ?? null;
  const rollup = computeProgramRollup(records, statusOf, new Set(PARKED_BANDS.keys()));
  const computedAt = nowIso();

  recordProjectionEvent(db, {
    table: "roadmap_rollups",
    id: "program",
    row: {
      rollup_id: "program",
      total_bands: rollup.totalBands,
      covered_bands: rollup.coveredBands,
      parked_bands: rollup.parkedBands,
      uncovered_bands: rollup.uncoveredBands,
      total_gates: rollup.totalGates,
      reached_gates: rollup.reachedGates,
      total_spans: rollup.totalSpans,
      confirmed_spans: rollup.confirmedSpans,
      frontier: rollup.frontier.join(","),
      computed_at: computedAt,
    },
  });

  for (const band of rollup.perBand) {
    recordProjectionEvent(db, {
      table: "roadmap_band_coverage",
      id: band.bandId,
      row: {
        band_id: band.bandId,
        name: band.name,
        status: band.status,
        roadmap_ids: band.roadmaps.join(","),
        computed_at: computedAt,
      },
    });
  }

  for (const record of records) {
    for (const gate of computeGateProgress(record.roadmap, statusOf)) {
      const id = stableId("roadmap-gate", `${record.planId}:${gate.gateId}`);
      recordProjectionEvent(db, {
        table: "roadmap_gate_progress",
        id,
        row: {
          roadmap_gate_id: id,
          plan_id: record.planId,
          gate_id: gate.gateId,
          total_spans: gate.totalSpans,
          confirmed_spans: gate.confirmedSpans,
          reached: gate.reached ? 1 : 0,
          computed_at: computedAt,
        },
      });
    }
  }
}

export function latestReviewEvidenceEntry<T extends { reviewed_at?: string }>(
  entries: T[],
): T | undefined {
  const timestampRank = (value?: string): number => {
    const parsed = Date.parse(value ?? "");
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
  };
  return entries.reduce<T | undefined>((latest, entry) => {
    if (!latest) return entry;
    return timestampRank(entry.reviewed_at) >= timestampRank(latest.reviewed_at) ? entry : latest;
  }, undefined);
}

function projectReviewEvidenceRegistry(repoRoot: string, db: HarnessDb): void {
  const indexedAt = nowIso();
  for (const plan of loadReviewPlans(repoRoot)) {
    const latestEntry = latestReviewEvidenceEntry(plan.crossEntries);
    const id = stableId("review-evidence", plan.plan_id);
    recordProjectionEvent(db, {
      table: "review_evidence_registry",
      id,
      row: {
        review_evidence_id: id,
        plan_id: plan.plan_id,
        kind: plan.kind,
        status: plan.status,
        has_evidence: plan.hasEvidence ? 1 : 0,
        review_kind: latestEntry?.review_kind ?? "",
        verdict: latestEntry?.verdict ?? "",
        reviewed_at: latestEntry?.reviewed_at ?? "",
        tests_green_at: latestEntry?.tests_green_at ?? "",
        worker_model: latestEntry?.worker_model ?? "",
        reviewer_model: latestEntry?.reviewer_model ?? "",
        source: normalizePath(join("docs", "plans", plan.file)),
        indexed_at: indexedAt,
      },
    });
    for (const [entryIndex, entry] of plan.crossEntries.entries()) {
      for (const [commandIndex, command] of (entry.green_commands ?? []).entries()) {
        const completedAt = command.completed_at ?? entry.tests_green_at ?? entry.reviewed_at ?? "";
        const testRunId = stableId(
          "test-run",
          `${plan.plan_id}:${entryIndex}:${commandIndex}:${command.command}:${command.evidence_path}:${completedAt}`,
        );
        recordProjectionEvent(db, {
          table: "test_runs",
          id: testRunId,
          row: {
            test_run_id: testRunId,
            session_id: "",
            plan_id: plan.plan_id,
            command: command.command,
            runner: command.runner,
            runtime: "",
            os: "",
            shell: "",
            scope: command.scope,
            started_at: "",
            completed_at: completedAt,
            exit_code: command.exit_code ?? -1,
            evidence_path: command.evidence_path,
            output_digest: command.output_digest,
            green_definition_id: "",
            status: command.exit_code === 0 ? "passed" : "failed",
          },
        });
      }
    }
  }
}

function projectGithubReviewLaneReceipts(repoRoot: string, db: HarnessDb): void {
  for (const plan of loadReviewPlans(repoRoot)) {
    for (const [index, entry] of plan.crossEntries.entries()) {
      if (
        entry.review_kind !== "cross_agent" ||
        !entry.lane ||
        !entry.plan_revision ||
        !entry.subject_head
      )
        continue;
      const id = stableId(
        "github-review-lane",
        `${plan.plan_id}:${entry.plan_revision}:${entry.lane}:${entry.subject_head}:${index}`,
      );
      recordProjectionEvent(db, {
        table: "github_review_lane_receipts",
        id,
        row: {
          review_lane_receipt_id: id,
          plan_id: plan.plan_id,
          plan_revision: entry.plan_revision,
          lane: entry.lane,
          subject_head: entry.subject_head,
          verdict: entry.verdict ?? "",
          reviewed_at: entry.reviewed_at ?? "",
          tests_green_at: entry.tests_green_at ?? "",
          worker_model: entry.worker_model ?? "",
          reviewer_model: entry.reviewer_model ?? "",
          attack_trials: entry.attack_trials ?? 0,
          citations_json: JSON.stringify(entry.citations ?? []),
          source: normalizePath(join("docs", "plans", plan.file)),
        },
      });
    }
  }
}

function advisorySubject(rule: string, reviewEvidenceId: string): string {
  // Plan-id-free, stable subject. The warn-first advisory must surface as a
  // feedback event WITHOUT flipping automation readiness, which scans
  // findings.subject_id LIKE '%plan_id%' (severity-agnostic). The hard-gate that
  // would block on this violation stays PO-gated (PLAN-L7-52 C-1 option A).
  const digest = createHash("sha1").update(reviewEvidenceId).digest("hex").slice(0, 12);
  return `guardrail-self-review:${rule}:${digest}`;
}

export function projectGuardrailInvariantAdvisories(db: HarnessDb): void {
  // PLAN-L7-52 C-1 (option C, PO-approved): consult the guardrail invariant SSoT
  // (inspectGuardrailInvariants) against committed review evidence at CLI-rebuild
  // time — no API runtime. Surfaces violations (e.g. reviewer_model ==
  // worker_model self-review) as non-blocking advisory findings only; projected
  // decisions and readiness are unchanged. Empty model strings are passed as
  // undefined so blank evidence never false-positives as same-model.
  const rows = db
    .prepare(
      "SELECT review_evidence_id, plan_id, reviewer_model, worker_model, review_kind, source FROM review_evidence_registry ORDER BY review_evidence_id",
    )
    .all();
  for (const row of rows) {
    const reviewEvidenceId = String(row.review_evidence_id ?? "");
    const reviewerModel = String(row.reviewer_model ?? "");
    const workerModel = String(row.worker_model ?? "");
    const reviewKind = String(row.review_kind ?? "");
    const evidencePath = String(row.source ?? "");
    const input: GuardrailDecisionInput = {
      plan_id: String(row.plan_id ?? ""),
      session_id: "",
      guardrail: "review-self-review",
      decision: "allow",
      mode: "review",
      evidence_path: evidencePath,
      reviewer_model: reviewerModel ? reviewerModel : undefined,
      worker_model: workerModel ? workerModel : undefined,
    };
    for (const violation of inspectGuardrailInvariants(input).violations) {
      // review_kind scoping mirrors the doctor hard gate (src/doctor/index.ts
      // checkGuardrailInvariants) and concept §2.1.2.1: same-model AND same-provider
      // are defects ONLY for a review that CLAIMS cross-runtime independence
      // (review_kind=cross_agent). intra_runtime_subagent is the design-sanctioned
      // Tier ② single-runtime substitute whose review is same-model by definition
      // (§2.1.2.1: "②は同一モデルである事実を必ず記録...cross-provider 要件には数えない"),
      // so neither rule is a defect there. secret-evidence /
      // human-required-without-evidence stay review_kind-independent. Full
      // projection-gate parity — PLAN-L7-144 corrects PLAN-L7-143's same-model asymmetry.
      if (
        (violation.rule === "same-provider-cross-review" ||
          violation.rule === "same-model-self-review") &&
        reviewKind !== "cross_agent"
      ) {
        continue;
      }
      recordFinding(db, {
        kind: `guardrail-invariant-advisory:${violation.rule}`,
        severity: "warn",
        subjectId: advisorySubject(violation.rule, reviewEvidenceId),
        source: "guardrail-invariant-advisory",
        evidencePath,
      });
    }
  }
}

function projectDescentObligations(repoRoot: string, db: HarnessDb): void {
  const indexedAt = nowIso();
  const result = analyzeDescentObligations(
    loadTraceKeyedArtifacts(repoRoot),
    loadDescentAdjacency(repoRoot),
    loadDeferLedger(repoRoot),
  );
  for (const obligation of result.obligations) {
    const id = stableId(
      "descent-obligation",
      `${obligation.traceKey}:${obligation.fromLayer}:${obligation.requiredLayer}:${obligation.kind}`,
    );
    recordProjectionEvent(db, {
      table: "descent_obligations",
      id,
      row: {
        descent_obligation_id: id,
        trace_key: obligation.traceKey,
        from_layer: obligation.fromLayer,
        required_layer: obligation.requiredLayer,
        kind: obligation.kind,
        status: obligation.status,
        reason: obligation.reason,
        defer_owner: obligation.defer?.owner ?? "",
        defer_spec: obligation.defer?.waitingSpec ?? "",
        source: "descent-obligation",
        indexed_at: indexedAt,
      },
    });
  }
  for (const violation of result.implAhead) {
    const id = stableId(
      "descent-obligation",
      `${violation.traceKey}:${violation.landedAt}:${violation.waitingLayer}:impl-ahead`,
    );
    recordProjectionEvent(db, {
      table: "descent_obligations",
      id,
      row: {
        descent_obligation_id: id,
        trace_key: violation.traceKey,
        from_layer: violation.landedAt,
        required_layer: violation.waitingLayer,
        kind: "impl-guard",
        status: "impl-ahead",
        reason: violation.waitingSpec,
        defer_owner: violation.owner,
        defer_spec: violation.waitingSpec,
        source: "descent-obligation",
        indexed_at: indexedAt,
      },
    });
  }
  for (const finding of result.findings) {
    recordFinding(db, {
      kind: `descent-${finding.code}`,
      severity: "warn",
      subjectId: finding.traceKey || finding.path || finding.code,
      source: "descent-obligation",
      evidencePath: finding.path,
    });
  }
}

function projectVerificationBandExecution(db: HarnessDb): void {
  if (!planExists(db, VERIFY_CUTOVER_PLAN_ID)) return;

  const programCoveredBands = scalarNumber(
    db,
    "SELECT covered_bands AS value FROM roadmap_rollups WHERE rollup_id = ?",
    ["program"],
  );
  const programTotalBands = scalarNumber(
    db,
    "SELECT total_bands AS value FROM roadmap_rollups WHERE rollup_id = ?",
    ["program"],
  );
  const reachedGates = scalarNumber(
    db,
    "SELECT reached_gates AS value FROM roadmap_rollups WHERE rollup_id = ?",
    ["program"],
  );
  const totalGates = scalarNumber(
    db,
    "SELECT total_gates AS value FROM roadmap_rollups WHERE rollup_id = ?",
    ["program"],
  );
  const passingReviewEvidence = scalarNumber(
    db,
    "SELECT COUNT(*) AS value FROM review_evidence_registry WHERE plan_id IN (?, ?) AND has_evidence = 1 AND verdict = ?",
    [VERIFY_CUTOVER_PLAN_ID, "PLAN-M-01-cutover-backfill", "pass"],
  );
  const checkedAt = nowIso();
  const driveRunId = stableId("drive-run", `${VERIFY_CUTOVER_PLAN_ID}:documented`);
  const localPass =
    programTotalBands > 0 &&
    programCoveredBands === programTotalBands &&
    totalGates > 0 &&
    reachedGates === totalGates &&
    passingReviewEvidence >= 2;

  for (const layer of VERIFICATION_BAND_LAYERS) {
    const humanRequired = layer === "L12" || layer === "L13" ? 1 : 0;
    const blockedReason =
      humanRequired === 1
        ? "production deploy, post-deploy observation, and PO signoff are explicitly outside this local execution band"
        : "";
    recordProjectionEvent(db, {
      table: "workflow_runs",
      id: stableId("verification-band-workflow", layer),
      row: {
        workflow_run_id: stableId("verification-band-workflow", layer),
        plan_id: VERIFY_CUTOVER_PLAN_ID,
        drive_run_id: driveRunId,
        workflow: "L8-L14-verification-band",
        phase: layer,
        ready_status: localPass ? "passed_local" : "blocked",
        blocked_reason: localPass
          ? blockedReason
          : "roadmap, gate, or review evidence projection is incomplete",
        human_required: humanRequired,
        checked_at: checkedAt,
      },
    });
    recordProjectionEvent(db, {
      table: "gate_runs",
      id: stableId("verification-band-gate", layer),
      row: {
        gate_run_id: stableId("verification-band-gate", layer),
        gate_id: `G-VERIFY.${layer}`,
        plan_id: VERIFY_CUTOVER_PLAN_ID,
        status: localPass ? "passed" : "blocked",
        checked_at: checkedAt,
        evidence_path: VERIFY_CUTOVER_AUDIT_PATH,
      },
    });
    recordProjectionEvent(db, {
      table: "coverage",
      id: stableId("verification-band-coverage", `${layer}:local_check_passed`),
      row: {
        coverage_id: stableId("verification-band-coverage", `${layer}:local_check_passed`),
        scope: "verification-band",
        subject_id: layer,
        metric: "local_check_passed",
        value: localPass ? 1 : 0,
        threshold: 1,
        status: localPass ? "passed" : "blocked",
      },
    });
  }

  for (const metric of [
    {
      subject_id: "program",
      metric: "covered_program_bands",
      value: programCoveredBands,
      threshold: programTotalBands,
    },
    {
      subject_id: "program",
      metric: "reached_roadmap_gates",
      value: reachedGates,
      threshold: totalGates,
    },
    {
      subject_id: "review",
      metric: "passing_review_evidence",
      value: passingReviewEvidence,
      threshold: 2,
    },
  ]) {
    const passed = metric.threshold > 0 && metric.value >= metric.threshold;
    recordProjectionEvent(db, {
      table: "coverage",
      id: stableId("verification-band-coverage", `${metric.subject_id}:${metric.metric}`),
      row: {
        coverage_id: stableId(
          "verification-band-coverage",
          `${metric.subject_id}:${metric.metric}`,
        ),
        scope: "verification-band",
        subject_id: metric.subject_id,
        metric: metric.metric,
        value: metric.value,
        threshold: metric.threshold,
        status: passed ? "passed" : "blocked",
      },
    });
  }
}

// PLAN-RECOVERY-14: gate 証跡 (.ut-tdd/gate_runs/*.json) は projectHookEvents /
// projectReviewModelRuns 等と異なり legacy plan alias (PLAN rename でファイル名に説明的
// suffix が付いた旧 short-id 参照) を解決していなかった。これが orphan_gate_run の主因の
// 一つ (alias 解決可能な行が恒久 orphan として残り続ける)。他 projection と同じ
// resolveProjectedPlanId で揃える。
function projectGateRunEvidence(
  repoRoot: string,
  db: HarnessDb,
  plans: Map<string, ProjectedPlan>,
): void {
  const dir = join(repoRoot, ".ut-tdd", "gate_runs");
  if (!existsSync(dir)) return;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(dir, name))
    .sort();
  for (const file of files) {
    const evidencePath = normalizePath(relative(repoRoot, file));
    let parsed: ProjectedGateRunEvidence;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8")) as ProjectedGateRunEvidence;
    } catch {
      recordFinding(db, {
        kind: "invalid-gate-run-evidence",
        severity: "warn",
        subjectId: evidencePath,
        source: "gate-run-projection",
        evidencePath,
      });
      continue;
    }
    const gateRunId = asString(parsed.gate_run_id);
    const gateId = asString(parsed.gate_id);
    const status =
      parsed.status === "passed" ? "passed" : parsed.status === "failed" ? "failed" : null;
    const checkedAt = asString(parsed.checked_at);
    if (!gateRunId || !gateId || !status || !checkedAt) {
      recordFinding(db, {
        kind: "invalid-gate-run-evidence",
        severity: "warn",
        subjectId: evidencePath,
        source: "gate-run-projection",
        evidencePath,
      });
      continue;
    }
    const rawPlanId = asString(parsed.plan_id ?? undefined) ?? "";
    const planId = rawPlanId ? resolveProjectedPlanId(plans, rawPlanId) : "";
    recordProjectionEvent(db, {
      table: "gate_runs",
      id: gateRunId,
      row: {
        gate_run_id: gateRunId,
        gate_id: gateId,
        plan_id: planId,
        status,
        checked_at: checkedAt,
        evidence_path: evidencePath,
      },
    });
    if (!planId) continue;
    const workflowRunId = stableId("gate-workflow", gateRunId);
    recordProjectionEvent(db, {
      table: "workflow_runs",
      id: workflowRunId,
      row: {
        workflow_run_id: workflowRunId,
        plan_id: planId,
        // Must match the "documented" (session_id="") drive_runs row id that
        // projectDriveRuns always creates for every projected plan
        // (`stableId("drive-run", `${planId}:documented`)`). The previous
        // `stableId("gate-drive", planId)` used a different id prefix, so it could
        // never join drive_runs — every gate-derived workflow_runs row was a
        // guaranteed false-positive workflow_orphans hit (PLAN-RECOVERY-14 root cause).
        drive_run_id: stableId("drive-run", `${planId}:documented`),
        workflow: "routine-gate",
        phase: gateId,
        ready_status: status === "passed" ? "passed" : "blocked",
        blocked_reason: status === "passed" ? "" : "gate run status failed",
        human_required: 0,
        checked_at: checkedAt,
      },
    });
  }
}

function truncateProjectionTables(db: HarnessDb): void {
  clearRebuildableProjectionTables(db);
}

function projectRelationGraph(db: HarnessDb, graph: RelationGraphProjection | undefined): void {
  if (!graph) return;
  const indexedAt = nowIso();
  const artifactIds = new Map<string, string>();
  for (const node of graph.nodes) {
    const artifactId = relationArtifactId(node.id);
    artifactIds.set(node.id, artifactId);
    recordProjectionEvent(db, {
      table: "graph_nodes",
      id: node.id,
      row: {
        node_id: node.id,
        node_type: node.kind,
        subject_id: node.id.split(":").slice(1).join(":"),
        section_id: "",
        path: node.path ?? "",
        name: node.label ?? node.id,
        layer: "",
        kind: node.kind,
        status: "current",
        source: "relation-graph",
        indexed_at: indexedAt,
      },
    });
    recordProjectionEvent(db, {
      table: "artifact_registry",
      id: artifactId,
      row: {
        artifact_id: artifactId,
        artifact_type: "relation_node",
        path: node.path ?? "",
        pair_artifact: "",
        status: "current",
        updated_at: indexedAt,
      },
    });
  }
  for (const edge of graph.edges) {
    const id = stableId("edge", `${edge.from}->${edge.kind}->${edge.to}`);
    recordProjectionEvent(db, {
      table: "dependency_edges",
      id,
      row: {
        edge_id: id,
        from_node_id: edge.from,
        to_node_id: edge.to,
        edge_kind: edge.kind,
        strength: 1,
        source: "relation-graph",
        evidence_path: "",
        is_expected: 1,
        is_actual: edge.lifecycle === "planned" ? 0 : 1,
        indexed_at: indexedAt,
      },
    });
    const fromArtifact = artifactIds.get(edge.from);
    const toArtifact = artifactIds.get(edge.to);
    if (fromArtifact && toArtifact) {
      recordProjectionEvent(db, {
        table: "trace_edges",
        id: stableId("trace-edge", `${edge.from}->${edge.kind}->${edge.to}`),
        row: {
          edge_id: stableId("trace-edge", `${edge.from}->${edge.kind}->${edge.to}`),
          from_artifact: fromArtifact,
          to_artifact: toArtifact,
          edge_kind: edge.kind,
          plan_id: "",
          status: "current",
        },
      });
    }
  }
  for (const finding of graph.findings) {
    recordFinding(db, {
      kind: finding.code,
      severity: finding.severity,
      subjectId: finding.nodeId ?? finding.code,
      source: "relation-graph",
      evidencePath: finding.evidencePath,
    });
  }
}

function projectDocumentExports(
  db: HarnessDb,
  exportsProjection: DocumentExportProjectionRows | undefined,
): void {
  if (!exportsProjection) return;
  for (const run of exportsProjection.document_export_runs) {
    recordProjectionEvent(db, {
      table: "document_export_runs",
      id: run.document_export_run_id,
      row: {
        document_export_run_id: run.document_export_run_id,
        source_snapshot_hash: run.source_snapshot_hash,
        evidence_path: run.evidence_path,
        normalized_status: "projected",
      },
    });
  }
  for (const dataset of exportsProjection.document_export_datasets) {
    recordProjectionEvent(db, {
      table: "document_export_datasets",
      id: dataset.document_export_dataset_id,
      row: {
        document_export_dataset_id: dataset.document_export_dataset_id,
        export_run_id: dataset.document_export_run_id,
        dataset_kind: dataset.format,
        format: dataset.format,
      },
    });
  }
  for (const artifact of exportsProjection.document_export_artifacts) {
    const id = stableId(
      "document-export-artifact",
      `${artifact.document_export_run_id}:${artifact.artifact_path}`,
    );
    recordProjectionEvent(db, {
      table: "document_export_artifacts",
      id,
      row: {
        document_export_artifact_id: id,
        export_run_id: artifact.document_export_run_id,
        format: artifact.format,
        path: artifact.artifact_path,
        stale_status: artifact.stale ? "stale" : "current",
      },
    });
  }
  for (const finding of exportsProjection.findings) {
    recordFinding(db, {
      kind: finding.code,
      severity: finding.severity,
      subjectId: finding.sourcePath ?? finding.code,
      source: "document-export",
    });
  }
}

function projectVerificationEvidence(
  db: HarnessDb,
  evidence: VerificationEvidenceProjection | undefined,
): void {
  if (!evidence) return;
  for (const profile of evidence.verification_profiles) {
    recordProjectionEvent(db, {
      table: "verification_profiles",
      id: profile.verification_profile_id,
      row: {
        ...profile,
        package_refs: (profile.package_refs ?? []).join(","),
        trigger_signals: (profile.trigger_signals ?? []).join(","),
        requires_docker: profile.requires_docker ? 1 : 0,
        requires_browser: profile.requires_browser ? 1 : 0,
        requires_network: profile.requires_network ? 1 : 0,
        enabled: profile.enabled ? 1 : 0,
      },
    });
  }
  for (const recommendation of evidence.verification_recommendations) {
    recordProjectionEvent(db, {
      table: "verification_recommendations",
      id: recommendation.verification_recommendation_id,
      row: {
        ...recommendation,
        accepted: recommendation.accepted ? 1 : 0,
        created_at: nowIso(),
      },
    });
  }
  for (const run of evidence.mcp_server_runs) {
    recordProjectionEvent(db, {
      table: "mcp_server_runs",
      id: run.mcp_run_id,
      row: { ...run },
    });
  }
  for (const finding of evidence.external_tool_findings) {
    recordProjectionEvent(db, {
      table: "external_tool_findings",
      id: finding.external_finding_id,
      row: {
        ...finding,
        status: finding.status ?? "open",
        created_at: nowIso(),
      },
    });
  }
  for (const finding of evidence.findings) {
    recordFinding(db, {
      kind: finding.code,
      severity: finding.severity,
      subjectId: finding.nodeId ?? finding.code,
      source: "verification-evidence",
      evidencePath: finding.evidencePath,
    });
  }
}

function defaultRelationGraphProjection(repoRoot: string): RelationGraphProjection {
  const sourceSet = loadRelationGraphSourceSet(repoRoot);
  return collectRelationGraphProjection({
    ...sourceSet,
    dbTables: HARNESS_DB_TABLES.map((table) => ({
      name: table.name,
      upstream: ["plan:PLAN-L7-44-harness-db-master"],
      path: "src/schema/harness-db.ts",
    })),
  });
}

function projectGraphSnapshot(db: HarnessDb, graph: RelationGraphProjection | undefined): void {
  if (!graph) return;
  const createdAt = nowIso();
  const sourceDigest = stableHash(JSON.stringify({ nodes: graph.nodes, edges: graph.edges }));
  const id = stableId("graph-snapshot", sourceDigest);
  recordProjectionEvent(db, {
    table: "graph_snapshots",
    id,
    row: {
      graph_snapshot_id: id,
      scope: "repo",
      node_count: graph.nodes.length,
      edge_count: graph.edges.length,
      hash: sourceDigest,
      created_at: createdAt,
      source_digest: sourceDigest,
    },
  });
}

const DEFAULT_IMPACT_RULES = [
  {
    id: "source-tests-design",
    edge: "covered-by",
    node: "source",
    required: "test",
    action: "require-sibling-test",
    gate: "G4",
  },
  {
    id: "design-pair",
    edge: "pairs",
    node: "design",
    required: "test-design",
    action: "update-paired-artifact",
    gate: "G2",
  },
  {
    id: "db-table-upstream",
    edge: "upstream",
    node: "db-table",
    required: "plan",
    action: "review-upstream",
    gate: "G7",
  },
  {
    id: "diagram-refresh",
    edge: "visualizes",
    node: "diagram",
    required: "graph-snapshot",
    action: "refresh-diagram",
    gate: "G8",
  },
] as const;

function projectImpactRules(db: HarnessDb): void {
  for (const rule of DEFAULT_IMPACT_RULES) {
    const id = stableId("impact-rule", rule.id);
    recordProjectionEvent(db, {
      table: "impact_rules",
      id,
      row: {
        impact_rule_id: id,
        trigger_edge_kind: rule.edge,
        trigger_node_type: rule.node,
        required_node_type: rule.required,
        required_action: rule.action,
        severity: "warn",
        gate: rule.gate,
        enabled: 1,
      },
    });
  }
}

function projectCurrentImpactResults(
  repoRoot: string,
  db: HarnessDb,
  graph: RelationGraphProjection | undefined,
): void {
  if (!graph) return;
  let changedFiles: string[] = [];
  try {
    changedFiles = loadChangedFiles(repoRoot);
  } catch {
    return;
  }
  if (changedFiles.length === 0) return;
  const result = analyzeRelationImpact({ changedPaths: changedFiles, projection: graph });
  const plansByGeneratedPath = planGeneratedPathMultiMap(repoRoot);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const computedAt = nowIso();
  for (const action of result.actions) {
    const id = stableId("impact-result", `working-tree:${action.kind}:${action.nodeId}`);
    const closure = resolvedImpactClosure({
      db,
      plansByGeneratedPath,
      nodeById,
      nodeId: action.nodeId,
      actionKind: action.kind,
      changedFiles,
    });
    recordProjectionEvent(db, {
      table: "impact_results",
      id,
      row: {
        impact_result_id: id,
        change_set_id: "working-tree",
        root_node_id: action.nodeId,
        impacted_node_id: action.nodeId,
        required_action: action.kind,
        status: closure.closed ? "closed" : "open",
        reason: action.reason,
        evidence_path: closure.evidencePath || "git status --porcelain",
        computed_at: computedAt,
      },
    });
  }
  for (const finding of result.findings) {
    recordFinding(db, {
      kind: finding.code,
      severity: finding.severity,
      subjectId: finding.nodeId ?? finding.message,
      source: "relation-impact",
      evidencePath: finding.evidencePath,
    });
  }
}

function resolvedImpactClosure(input: {
  db: HarnessDb;
  plansByGeneratedPath: Map<string, string[]>;
  nodeById: Map<string, { path?: string }>;
  nodeId: string;
  actionKind: string;
  changedFiles: string[];
}): { closed: boolean; evidencePath: string } {
  const { db, plansByGeneratedPath, nodeById, nodeId, actionKind, changedFiles } = input;
  const path = normalizePath(nodeById.get(nodeId)?.path ?? nodeId.replace(/^[^:]+:/, ""));
  if (actionKind === "update-paired-artifact" && !changedFiles.includes(path)) {
    return { closed: true, evidencePath: "doctor:pair-freeze" };
  }
  const candidatePlanIds = [
    ...(plansByGeneratedPath.get(path) ?? []),
    nodeId.startsWith("plan:") ? nodeId.replace(/^plan:/, "") : "",
  ].filter(Boolean);
  if (candidatePlanIds.length === 0) return { closed: false, evidencePath: "" };
  const placeholders = candidatePlanIds.map(() => "?").join(", ");
  const row = db
    .prepare(
      `SELECT r.source AS source
       FROM plan_registry p
       JOIN review_evidence_registry r ON r.plan_id = p.plan_id
       WHERE p.plan_id IN (${placeholders})
         AND p.status IN ('confirmed', 'completed', 'accepted')
         AND r.has_evidence = 1
         AND r.verdict IN ('approve', 'approve_after_fixes', 'pass', 'pass-with-fixes')
         AND COALESCE(r.tests_green_at, '') <> ''
       ORDER BY r.reviewed_at DESC
       LIMIT 1`,
    )
    .get(...candidatePlanIds) as { source?: string } | undefined;
  return row
    ? { closed: true, evidencePath: row.source ?? "" }
    : { closed: false, evidencePath: "" };
}

const PROGRESS_NODE_KINDS = new Set(["source", "design", "test-design", "plan", "requirement"]);

function artifactProgressType(kind: string): string {
  return kind === "source" ? "source" : kind;
}

function passedTestRunsForPaths(db: HarnessDb, testPaths: string[]): string[] {
  const ids = new Set<string>();
  for (const path of testPaths) {
    const like = `%${path.replace(/\\/g, "/")}%`;
    const rows = db
      .prepare(
        `SELECT test_run_id
         FROM test_runs
         WHERE exit_code = 0
           AND (evidence_path = ? OR command LIKE ?)
         ORDER BY completed_at, test_run_id`,
      )
      .all(path, like);
    for (const row of rows) ids.add(String(row.test_run_id ?? ""));
  }
  return [...ids].filter(Boolean).sort();
}

function activeRecoveryPlanIds(db: HarnessDb): string[] {
  const rows = db
    .prepare(
      `SELECT plan_id
       FROM plan_registry
       WHERE kind IN ('reverse', 'recovery', 'refactor')
         AND status NOT IN ('confirmed', 'completed', 'accepted')
       ORDER BY plan_id`,
    )
    .all();
  return rows.map((row) => String(row.plan_id ?? "")).filter(Boolean);
}

function nodeRecoveryPlanIds(
  activePlans: string[],
  openDependencyImpacts: number,
  artifactPath: string,
): string[] {
  if (openDependencyImpacts <= 0 || activePlans.length === 0) return [];
  const slug = artifactPath
    .split("/")
    .at(-1)
    ?.replace(/\.[^.]+$/, "")
    .toLowerCase();
  const direct = slug ? activePlans.filter((planId) => planId.toLowerCase().includes(slug)) : [];
  return direct.length > 0 ? direct : activePlans;
}

function projectArtifactProgress(db: HarnessDb, graph: RelationGraphProjection | undefined): void {
  if (!graph) return;
  const indexedAt = nowIso();
  const dependencyCheckRunId = stableId(
    "dependency-check",
    stableHash(JSON.stringify({ nodes: graph.nodes.length, edges: graph.edges.length })),
  );
  const progressNodes = graph.nodes
    .filter((node) => PROGRESS_NODE_KINDS.has(node.kind) && node.path)
    .sort((a, b) => String(a.path).localeCompare(String(b.path)));
  const coveredByEdges = new Map<string, typeof graph.edges>();
  const pairedEdges = new Map<string, typeof graph.edges>();
  for (const edge of graph.edges) {
    if (edge.kind === "covered-by") {
      const list = coveredByEdges.get(edge.from) ?? [];
      list.push(edge);
      coveredByEdges.set(edge.from, list);
    }
    if (edge.kind === "pairs") {
      for (const endpoint of [edge.from, edge.to]) {
        const list = pairedEdges.get(endpoint) ?? [];
        list.push(edge);
        pairedEdges.set(endpoint, list);
      }
    }
  }
  const activeRecoveries = activeRecoveryPlanIds(db);
  for (const node of progressNodes) {
    const artifactPath = node.path ?? node.id.replace(/^[^:]+:/, "");
    const linkedTestIds = (coveredByEdges.get(node.id) ?? [])
      .map((edge) => edge.to)
      .filter((id) => graph.nodes.some((candidate) => candidate.id === id))
      .sort();
    const pairedTestDesignIds = (pairedEdges.get(node.id) ?? [])
      .map((edge) => (edge.from === node.id ? edge.to : edge.from))
      .filter((id) => graph.nodes.some((candidate) => candidate.id === id))
      .sort();
    const linkedIds = [...new Set([...linkedTestIds, ...pairedTestDesignIds])].sort();
    const linkedTestPaths = linkedIds
      .map((id) => graph.nodes.find((candidate) => candidate.id === id)?.path ?? id)
      .filter((path) => path)
      .sort();
    const openDependencyImpacts = scalarNumber(
      db,
      "SELECT COUNT(*) AS value FROM impact_results WHERE status = 'open' AND (root_node_id = ? OR impacted_node_id = ?)",
      [node.id, node.id],
    );
    const passedTestRunIds = passedTestRunsForPaths(db, linkedTestPaths);
    const recoveryPlanIds = nodeRecoveryPlanIds(
      activeRecoveries,
      openDependencyImpacts,
      artifactPath,
    );
    const decision = deriveArtifactProgressDecision({
      linkedTestCount: linkedIds.length,
      passedLinkedTestRunCount: passedTestRunIds.length,
      dependencyChecked: true,
      dependencyCheckRunId,
      dependencyCheckedAt: indexedAt,
      openDependencyImpacts,
      recoveryPlanIds,
    });
    const artifactHash = stableHash(
      JSON.stringify({
        path: artifactPath,
        tests: linkedIds,
        passedRuns: passedTestRunIds,
        impacts: openDependencyImpacts,
        recoveryPlanIds,
      }),
    );
    recordProjectionEvent(db, {
      table: "artifact_progress",
      id: artifactPath,
      row: {
        artifact_path: artifactPath,
        artifact_type: artifactProgressType(node.kind),
        artifact_hash: artifactHash,
        state: decision.state,
        color: decision.color,
        linked_test_ids: linkedIds.join(","),
        linked_test_paths: linkedTestPaths.join(","),
        linked_test_count: linkedIds.length,
        passed_test_run_ids: passedTestRunIds.join(","),
        passed_test_run_count: passedTestRunIds.length,
        dependency_checked: 1,
        dependency_check_run_id: dependencyCheckRunId,
        dependency_checked_at: indexedAt,
        dependency_check_source: "relation-impact",
        open_dependency_impacts: openDependencyImpacts,
        recovery_plan_ids: recoveryPlanIds.join(","),
        reason: decision.reason,
        indexed_at: indexedAt,
      },
    });
    recordProjectionEvent(db, {
      table: "artifact_progress_events",
      id: stableId("artifact-progress-event", `${artifactPath}:${artifactHash}`),
      row: {
        artifact_progress_event_id: stableId(
          "artifact-progress-event",
          `${artifactPath}:${artifactHash}`,
        ),
        artifact_path: artifactPath,
        artifact_type: artifactProgressType(node.kind),
        previous_color: "",
        color: decision.color,
        state: decision.state,
        trigger:
          decision.color === "red"
            ? "dependency-impact"
            : decision.color === "yellow"
              ? "verification-needed"
              : "test-run-passed",
        test_run_ids: passedTestRunIds.join(","),
        dependency_check_run_id: dependencyCheckRunId,
        recovery_plan_ids: recoveryPlanIds.join(","),
        reason: decision.reason,
        occurred_at: indexedAt,
      },
    });
  }
}

function projectVerificationCatalogs(repoRoot: string, db: HarnessDb): void {
  const indexedAt = nowIso();
  const profiles = catalogVerificationProfiles().profiles;
  for (const profile of profiles) {
    recordProjectionEvent(db, {
      table: "verification_profiles",
      id: profile.id,
      row: {
        verification_profile_id: profile.id,
        name: profile.label,
        profile_type: profile.sourceType,
        package_refs: profile.packageName ?? "",
        requires_docker: profile.requiresDocker ? 1 : 0,
        requires_browser: profile.id.includes("playwright") ? 1 : 0,
        requires_network: profile.requiresNetwork ? 1 : 0,
        green_definition_id: profile.defaultEnabled ? "default-green" : "",
        trigger_signals: (profile.triggerSignals ?? []).join(","),
        enabled: profile.defaultEnabled ? 1 : 0,
      },
    });
    if (profile.sourceType === "mcp") {
      recordProjectionEvent(db, {
        table: "mcp_server_profiles",
        id: profile.id,
        row: {
          mcp_profile_id: profile.id,
          name: profile.label,
          package_ref: profile.packageName ?? "",
          source_url: profile.sourceUrl ?? "",
          transport: "stdio",
          command: profile.command,
          args_digest: stableHash(profile.command),
          allowed_tools: (profile.allowedTools ?? []).join(","),
          read_only: profile.readOnly ? 1 : 0,
          requires_network: profile.requiresNetwork ? 1 : 0,
          requires_docker: profile.requiresDocker ? 1 : 0,
          requires_auth: profile.requiresAuth ? 1 : 0,
          risk_tier: profile.riskTier,
          enabled: profile.defaultEnabled ? 1 : 0,
          source: "verification-profile-catalog",
          indexed_at: indexedAt,
        },
      });
      for (const signal of profile.triggerSignals ?? []) {
        const id = stableId("mcp-trigger", `${profile.id}:${signal}`);
        recordProjectionEvent(db, {
          table: "mcp_profile_triggers",
          id,
          row: {
            trigger_id: id,
            mcp_profile_id: profile.id,
            signal,
            workflow: "",
            layer: "",
            gate: "",
            reason: `${signal} recommends ${profile.id}`,
            enabled: 1,
          },
        });
      }
    }
  }
  let changedFiles: string[] = [];
  try {
    changedFiles = loadChangedFiles(repoRoot);
  } catch {
    changedFiles = [];
  }
  const recommendations = recommendVerificationProfiles(changedFiles);
  for (const rec of recommendations.recommendations) {
    const id = stableId("verification-rec", `working-tree:${rec.profile.id}`);
    recordProjectionEvent(db, {
      table: "verification_recommendations",
      id,
      row: {
        verification_recommendation_id: id,
        change_set_id: "working-tree",
        plan_id: "",
        profile_id: rec.profile.id,
        profile_kind: rec.profile.sourceType,
        reason: rec.reasons.join("; "),
        source_rule: rec.signals.join(","),
        accepted: rec.profile.defaultEnabled ? 1 : 0,
        created_at: indexedAt,
      },
    });
  }
}

const DOCUMENT_EXPORT_PROFILES = [
  {
    id: "doc-csv-matrix",
    name: "Canonical CSV matrix",
    family: "mixed",
    format: "csv",
    renderer: "builtin",
    builtIn: 1,
    requiresPackage: 0,
    requiresD2: 0,
    enabled: 1,
    riskTier: "low",
    signals: "doc_backprop,document_export_profile_changed",
  },
  {
    id: "doc-markdown-summary",
    name: "Canonical Markdown summary",
    family: "mixed",
    format: "markdown",
    renderer: "builtin",
    builtIn: 1,
    requiresPackage: 0,
    requiresD2: 0,
    enabled: 1,
    riskTier: "low",
    signals: "doc_backprop,document_export_profile_changed",
  },
  {
    id: "doc-xlsx-workbook",
    name: "Canonical XLSX workbook",
    family: "mixed",
    format: "xlsx",
    renderer: "exceljs-or-sheetjs",
    builtIn: 0,
    requiresPackage: 1,
    requiresD2: 0,
    enabled: 0,
    riskTier: "medium",
    signals: "document_export_profile_changed",
  },
  {
    id: "doc-pptx-deck",
    name: "Canonical PPTX deck",
    family: "mixed",
    format: "pptx",
    renderer: "pptxgenjs",
    builtIn: 0,
    requiresPackage: 1,
    requiresD2: 0,
    enabled: 0,
    riskTier: "medium",
    signals: "document_export_profile_changed",
  },
  {
    id: "doc-d2-pptx-diagram",
    name: "Canonical D2 diagram deck",
    family: "diagram",
    format: "pptx",
    renderer: "d2+pptxgenjs",
    builtIn: 0,
    requiresPackage: 1,
    requiresD2: 1,
    enabled: 0,
    riskTier: "medium",
    signals: "diagram_changed,document_export_profile_changed",
  },
] as const;

function projectDocumentExportCatalogs(db: HarnessDb): void {
  for (const profile of DOCUMENT_EXPORT_PROFILES) {
    recordProjectionEvent(db, {
      table: "document_export_profiles",
      id: profile.id,
      row: {
        document_export_profile_id: profile.id,
        name: profile.name,
        source_doc_family: profile.family,
        format: profile.format,
        renderer: profile.renderer,
        package_ref: "",
        source_url: "",
        built_in: profile.builtIn,
        requires_package: profile.requiresPackage,
        requires_d2: profile.requiresD2,
        enabled: profile.enabled,
        risk_tier: profile.riskTier,
        trigger_signals: profile.signals,
      },
    });
    for (const signal of profile.signals.split(",")) {
      const id = stableId("document-export-trigger", `${profile.id}:${signal}`);
      recordProjectionEvent(db, {
        table: "document_export_triggers",
        id,
        row: {
          trigger_id: id,
          document_export_profile_id: profile.id,
          signal,
          workflow: "",
          layer: "",
          gate: "",
          reason: `${signal} recommends ${profile.id}`,
          enabled: 1,
        },
      });
    }
  }
}

function canonicalDocInputs(repoRoot: string): Array<{
  family: CanonicalDocumentFamily;
  path: string;
  content: string;
}> {
  const roots: Array<{ family: CanonicalDocumentFamily; dir: string }> = [
    { family: "concept", dir: join(repoRoot, "docs", "governance") },
    { family: "requirements", dir: join(repoRoot, "docs", "design", "harness", "L1-requirements") },
    { family: "design", dir: join(repoRoot, "docs", "design", "harness") },
    { family: "plan", dir: join(repoRoot, "docs", "plans") },
    { family: "adr", dir: join(repoRoot, "docs", "adr") },
    { family: "test-design", dir: join(repoRoot, "docs", "test-design") },
  ];
  const docs: Array<{ family: CanonicalDocumentFamily; path: string; content: string }> = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const path of assetFiles(root.dir, /\.md$/i)) {
      const rel = normalizePath(relative(repoRoot, path));
      if (seen.has(rel)) continue;
      seen.add(rel);
      docs.push({ family: root.family, path: rel, content: readFileSync(path, "utf8") });
    }
  }
  return docs.sort((a, b) => a.path.localeCompare(b.path));
}

function defaultDocumentExportProjection(repoRoot: string): DocumentExportProjectionRows {
  const projections = canonicalDocInputs(repoRoot).map((doc) =>
    parseCanonicalDocumentStructure({
      family: doc.family,
      sourcePath: doc.path,
      content: doc.content,
    }),
  );
  const dataset = buildDocumentExportDataset({
    projections,
    format: "markdown",
    maxRowsPerChunk: 500,
  });
  const sourceSnapshotHash = stableHash(
    JSON.stringify(projections.map((p) => [p.sourcePath, p.sourceHash])),
  );
  const runId = stableId("document-export-run", "doc-markdown-summary:rebuild");
  return {
    document_export_runs: [
      {
        document_export_run_id: runId,
        source_snapshot_hash: sourceSnapshotHash,
        evidence_path: "docs",
      },
    ],
    document_export_datasets: [
      {
        document_export_dataset_id: dataset.datasetId,
        document_export_run_id: runId,
        format: dataset.format,
      },
    ],
    document_export_artifacts: [],
    findings: dataset.findings,
    actionsTaken: [],
    ok: dataset.ok,
  };
}

function planGeneratedPathMap(repoRoot: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const [artifactPath, planIds] of planGeneratedPathMultiMap(repoRoot)) {
    const planId = planIds.at(-1);
    if (planId) map.set(artifactPath, planId);
  }
  return map;
}

export function missingTestPlanIdNextAction(status: string | undefined): string {
  if (status === "draft")
    return "confirm the owning PLAN and declare this test in generates together (merged-plan-status alignment)";
  if (status === "confirmed") return "declare this test in the owning PLAN generates";
  return "declare this test in an owning PLAN generates";
}

function planStatusById(repoRoot: string): Map<string, string> {
  const statuses = new Map<string, string>();
  for (const path of markdownFiles(join(repoRoot, "docs", "plans"))) {
    const content = readFileSync(path, "utf8");
    const planId = frontmatterValue(content, "plan_id");
    const status = frontmatterValue(content, "status");
    if (planId) statuses.set(planId, status);
  }
  return statuses;
}

function planGeneratedPathMultiMap(repoRoot: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const path of markdownFiles(join(repoRoot, "docs", "plans"))) {
    const content = readFileSync(path, "utf8");
    const planId = frontmatterValue(content, "plan_id");
    const meta = metadataFromContent(path, content);
    const generates = Array.isArray(meta.generates) ? meta.generates : [];
    for (const item of generates) {
      if (!item || typeof item !== "object") continue;
      const artifactPath = (item as Record<string, unknown>).artifact_path;
      if (typeof artifactPath === "string" && artifactPath) {
        const normalized = normalizePath(artifactPath);
        const values = map.get(normalized) ?? [];
        values.push(planId);
        map.set(normalized, values);
      }
    }
  }
  return map;
}

interface ExtractedTestCase {
  name: string;
  oracleId: string;
}

function extractTestCases(content: string): ExtractedTestCase[] {
  const describeOracles = [...content.matchAll(/\bdescribe\s*\(\s*["'`]([^"'`]+)["'`]/g)]
    .map((match) => ({
      index: match.index ?? 0,
      oracleId: match[1]?.match(/\bU-[A-Z0-9-]+\b/)?.[0] ?? "",
    }))
    .filter((entry) => entry.oracleId);
  const cases = new Map<string, ExtractedTestCase>();
  for (const match of content.matchAll(/\b(?:it|test)\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
    const name = match[1];
    if (!name) continue;
    const directOracle = name.match(/\bU-[A-Z0-9-]+\b/)?.[0] ?? "";
    const inheritedOracle =
      directOracle ||
      describeOracles.filter((entry) => entry.index < (match.index ?? 0)).at(-1)?.oracleId ||
      "";
    const existing = cases.get(name);
    if (!existing || (!existing.oracleId && inheritedOracle)) {
      cases.set(name, { name, oracleId: inheritedOracle });
    }
  }
  return [...cases.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function importedSourcePaths(content: string): string[] {
  const paths = new Set<string>();
  for (const match of content.matchAll(/(?:from|require)\s*\(?\s*["']([^"']*src\/[^"']+)["']/g)) {
    const spec = match[1];
    const idx = spec.indexOf("src/");
    if (idx < 0) continue;
    let rel = normalizePath(spec.slice(idx));
    if (!/\.(ts|tsx)$/.test(rel)) rel = `${rel}.ts`;
    paths.add(rel);
  }
  return [...paths].sort();
}

function projectTestCaseCatalog(repoRoot: string, db: HarnessDb): void {
  const planByPath = planGeneratedPathMap(repoRoot);
  const statusesByPlanId = planStatusById(repoRoot);
  const indexedAt = nowIso();
  for (const path of assetFiles(join(repoRoot, "tests"), /\.test\.ts$/i)) {
    const rel = normalizePath(relative(repoRoot, path));
    const content = readFileSync(path, "utf8");
    const planId = planByPath.get(rel) ?? "";
    const sources = importedSourcePaths(content);
    const testCases = extractTestCases(content);
    for (const [index, testCase] of testCases.entries()) {
      const { name, oracleId } = testCase;
      const testCaseId = stableId("test-case", `${rel}:${index}:${stableHash(name)}`);
      recordProjectionEvent(db, {
        table: "test_cases",
        id: testCaseId,
        row: {
          test_case_id: testCaseId,
          test_file: rel,
          test_name: name,
          name,
          test_run_id: "",
          oracle_id: oracleId,
          plan_id: planId,
          fr_id: name.match(/\bFR-L\d+-\d+\b/)?.[0] ?? "",
          artifact_id: sources[0] ?? "",
          kind: "unit",
          first_seen_at: indexedAt,
          last_seen_at: indexedAt,
          status: "cataloged",
          evidence_path: rel,
        },
      });
      if (!planId) {
        const ownershipCandidate = sources
          .map((source) => planByPath.get(source))
          .find((candidate): candidate is string => Boolean(candidate));
        recordFinding(db, {
          kind: "missing-test-plan-id",
          severity: "warn",
          subjectId: testCaseId,
          source: "test-case-catalog",
          evidencePath: rel,
          nextAction: missingTestPlanIdNextAction(
            ownershipCandidate ? statusesByPlanId.get(ownershipCandidate) : undefined,
          ),
        });
      }
      if (!oracleId) {
        recordFinding(db, {
          kind: "missing-test-oracle-id",
          severity: "info",
          subjectId: testCaseId,
          source: "test-case-catalog",
          evidencePath: rel,
        });
      }
      for (const sourcePath of sources) {
        const edgeId = stableId("test-artifact-edge", `${testCaseId}:${sourcePath}`);
        const compatibilityEdgeId = stableId("test-edge-compat", stableHash(edgeId));
        recordProjectionEvent(db, {
          table: "test_artifact_edges",
          id: edgeId,
          row: {
            edge_id: edgeId,
            test_artifact_edge_id: compatibilityEdgeId,
            test_case_id: testCaseId,
            artifact_id: sourcePath,
            plan_id: planId,
            source_path: rel,
            artifact_path: sourcePath,
            edge_kind: "tests",
            oracle_id: oracleId,
            evidence_path: rel,
          },
        });
      }
    }
  }
}

function assetFiles(dir: string, extensions: RegExp): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...assetFiles(path, extensions));
    else if (entry.isFile() && extensions.test(entry.name)) out.push(path);
  }
  return out.sort();
}

function projectAutomationAssets(repoRoot: string, db: HarnessDb): void {
  const indexedAt = nowIso();
  const skillRoot = existsSync(join(repoRoot, "skills"))
    ? join(repoRoot, "skills")
    : join(repoRoot, "docs", "skills");
  const sources = [
    { type: "skill", root: skillRoot, exts: /\.(md|ya?ml)$/i },
    { type: "roster", root: join(repoRoot, ".claude", "agents"), exts: /\.md$/i },
    { type: "command", root: join(repoRoot, "docs", "commands"), exts: /\.md$/i },
  ] as const;
  let assetCount = 0;
  for (const source of sources) {
    for (const path of assetFiles(source.root, source.exts)) {
      const rel = normalizePath(relative(repoRoot, path));
      const content = readFileSync(path, "utf8");
      const metadata = metadataFromContent(path, content);
      const appliesTo =
        metadata.applies_to && typeof metadata.applies_to === "object"
          ? (metadata.applies_to as Record<string, unknown>)
          : {};
      const name =
        (typeof metadata.name === "string" ? metadata.name : "") ||
        frontmatterValue(content, "name") ||
        rel
          .split("/")
          .at(-1)
          ?.replace(/\.(md|ya?ml)$/i, "") ||
        rel;
      const legacyRuntimeName = ["he", "lix"].join("");
      const legacyCommandPattern = new RegExp(String.raw`\b${legacyRuntimeName}\s+codex\b`, "i");
      const status = legacyCommandPattern.test(content) ? "drift" : "current";
      const assetId = `${source.type}:${name}`;
      const trigger =
        frontmatterValue(content, "triggers") || frontmatterValue(content, "description");
      const role = frontmatterValue(content, "role") || (source.type === "roster" ? name : "");
      const capability =
        frontmatterValue(content, "description") || `${source.type} metadata from ${rel}`;
      const skillType = source.type === "skill" ? String(metadata.skill_type ?? "") : "";
      const appliesLayers =
        source.type === "skill" ? stringList(appliesTo.layers).sort().join(",") : "";
      const appliesDriveModels =
        source.type === "skill" ? stringList(appliesTo.drive_models).sort().join(",") : "";
      recordProjectionEvent(db, {
        table: "automation_assets",
        id: assetId,
        row: {
          asset_id: assetId,
          asset_type: source.type,
          path: rel,
          trigger,
          role,
          capability,
          skill_type: skillType,
          applies_layers: appliesLayers,
          applies_drive_models: appliesDriveModels,
          drift_status: status,
          indexed_at: indexedAt,
        },
      });
      recordProjectionEvent(db, {
        table: "search_index",
        id: stableId("automation-asset", assetId),
        row: {
          search_id: stableId("automation-asset", assetId),
          subject_type: "automation_asset",
          subject_id: assetId,
          path: rel,
          title: name,
          tokens: `${source.type} ${trigger} ${role} ${capability} ${skillType} ${appliesLayers} ${appliesDriveModels}`,
          summary: `${source.type} ${status}`,
          updated_at: indexedAt,
        },
      });
      assetCount += 1;
      if (status === "drift") {
        recordFinding(db, {
          kind: "asset-drift",
          subjectId: assetId,
          source: "projection-writer",
          evidencePath: rel,
        });
      }
    }
  }
  if (assetCount === 0) {
    recordFinding(db, {
      kind: "empty-catalog",
      subjectId: "automation_assets",
      source: "projection-writer",
    });
  }
}

function projectMemoryEntries(repoRoot: string, db: HarnessDb): void {
  for (const entry of loadMemoryEntries(repoRoot)) {
    recordProjectionEvent(db, {
      table: "memory_entries",
      id: entry.memory_id,
      row: {
        memory_id: entry.memory_id,
        kind: entry.kind,
        title: entry.title,
        body: entry.body,
        tags: entry.tags.join(","),
        source_path: normalizePath(entry.source_path),
        updated_at: entry.updated_at,
        content_hash: entry.content_hash,
      },
    });
  }
}

function projectSkillTelemetry(db: HarnessDb, plans: Map<string, ProjectedPlan>): void {
  projectSkillTelemetryCore({
    db,
    plans,
    deps: {
      nowIso,
      stableId,
      recordProjectionEvent,
      skillDriveModelForPlan: planModeResolver(plans),
    },
  });
}

function projectSkillMetrics(db: HarnessDb): void {
  projectSkillMetricsCore({
    db,
    deps: { nowIso, stableId, recordProjectionEvent },
  });
}

export function projectSkillEvaluations(db: HarnessDb, opts?: { asOf?: string }): void {
  projectSkillEvaluationsCore({
    db,
    opts,
    deps: { nowIso, recordProjectionEvent },
  });
}

/**
 * FR-L1-43: PoC success measurement projection.
 *
 * Identifies PoC PLANs (kind="poc") from plan_registry and reads their
 * decision_outcome ("confirmed" | "rejected" | "pivot").  Projects ONE
 * summary row with id "poc-evaluation:summary".
 *
 * poc_success_rate = confirmed_count / (confirmed + rejected + pivot)
 *   — pivot counts as a non-success outcome (denominator includes it).
 *
 * Decision outcome values rationale (hardcode-with-reason):
 *   "confirmed": S4 verdict = PoC adopted, forward into implementation.
 *   "rejected":  S4 verdict = PoC abandoned; hypothesis falsified.
 *   "pivot":     S4 verdict = PoC pivoted to a different hypothesis.
 *   Only PLANs with a non-empty decision_outcome contribute to the rate;
 *   PoC PLANs without an S4 decision yet (decision_outcome="") are excluded
 *   from the denominator (still pending), matching AC-43-01 intent.
 *   Source single-source: PLAN frontmatter `decision_outcome` field parsed
 *   by projectPlans (harness-db.ts plan_registry.decision_outcome).
 *
 * AC-FR-BR21-43-01: 10 PoC, 6 confirmed / 3 rejected / 1 pivot => rate 0.60.
 * AC-FR-BR21-43-02 cold-start: 0 PoC PLANs => 0 rows, no throw.
 */
export function projectPocEvaluations(db: HarnessDb, opts?: { asOf?: string }): void {
  const store = new SqliteProjectionStore(db);
  projectPocEvaluationsApplication({
    evaluatedAt: opts?.asOf ?? nowIso(),
    read: store,
    store,
  });
}

/**
 * FR-L1-38: model evaluation projection (opt-in).
 *
 * Opt-in gate: reads .ut-tdd/config/model-opt-in.yaml under repoRoot.
 * If the file exists AND parses to { enabled: true }, evaluation runs.
 * Otherwise (file absent or enabled != true), writes 0 rows and returns.
 * Default (no file) = disabled. This is deterministic and does not throw.
 *
 * Success inferred by joining model_runs.plan_id -> plan_registry.status
 * IN PLAN_SUCCESS_STATUSES (single-source from this module).
 *
 * PLAN-L7-57: token/cost telemetry を model_runs に追加 (projectTokenUsage が session ログ走査で投入)。
 * 本関数は token 効率も集計する:
 *   - total_input/output_tokens, total_cost_usd = SUM over model_runs WHERE model (NULL は無視)。
 *   - tokens_per_success / cost_per_success の **分子と分母は別ソースで意図的に非対称** (review I-2、
 *     Option B = 定義を明示):
 *       分子 = その model の **全 model_runs** の token/cost (session ログ由来行 plan_id='' を含む)。
 *       分母 = success_count = plan_registry に join して success な行数 (review-evidence 由来)。
 *     session ログは PLAN に紐づかない (plan_id 不明) ため、両者は構造的に別母集団。よって指標の意味は
 *     「この model が全 session で費やした output token / その model が delivered した success PLAN 数」=
 *     **粗い「success PLAN あたり token コスト」proxy** であり、「success run あたり token」ではない。
 *     この非対称を解消するには session→PLAN 帰属が要るが現状ログに無い (carry)。
 *   - Output: per-model row (model PK, success_rate, run_count, success_count, evaluated_at,
 *     total_input_tokens, total_output_tokens, total_cost_usd, tokens_per_success, cost_per_success)。
 *
 * AC-38-01: model-A (2 runs, both success) => rate 1.0; model-B (2 runs, 1 success) => rate 0.5.
 * AC-38-02: disabled (no opt-in file) => 0 model_evaluations rows.
 * Cold-start (enabled but 0 model_runs): 0 rows, no throw.
 */
export function projectModelEvaluations(db: HarnessDb, repoRoot: string): void {
  const store = new SqliteProjectionStore(db);
  projectModelEvaluationsApplication({
    config: new RepositoryModelEvaluationConfig(repoRoot),
    read: store,
    store,
    evaluatedAt: nowIso(),
  });
}

function projectOperationalMetrics(db: HarnessDb): void {
  const store = new SqliteProjectionStore(db);
  projectOperationalMetricsApplication({ read: store, store, computedAt: nowIso() });
}

/** screen-list.md §1 の画面表 (画面 ID / 名 / カテゴリ / URL / L1 参照) を行に分解する。 */
function parseScreenListRows(content: string): Array<{
  screenId: string;
  name: string;
  category: string;
  url: string;
  l1Ref: string;
}> {
  const rows: Array<{
    screenId: string;
    name: string;
    category: string;
    url: string;
    l1Ref: string;
  }> = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
    if (cells.length < 5) continue;
    const screenId = cells[0].replace(/\*\*/g, "").trim();
    if (!/^(?:PM|HM|GD)-\d+$/.test(screenId)) continue;
    rows.push({
      screenId,
      name: cells[1],
      category: cells[2],
      url: cells[3].replace(/`/g, "").trim(),
      l1Ref: cells[4],
    });
  }
  return rows;
}

/** screen-requirements.md §5.5 (画面 → BR/UX/FR-L1 逆 trace) を画面×要求の edge に分解する。 */
function parseScreenTraceRows(content: string): Array<{
  screenId: string;
  requirementId: string;
  kind: string;
}> {
  const out: Array<{ screenId: string; requirementId: string; kind: string }> = [];
  const start = content.search(/^###?\s+§5\.5/m);
  if (start < 0) return out;
  // heading 行の直後から次の見出しまでを §5.5 セクションとする (現 heading を再マッチしないよう改行後から探索)。
  const afterHeading = content.indexOf("\n", start);
  const rest = content.slice(afterHeading < 0 ? start : afterHeading + 1);
  const nextSection = rest.search(/^###?\s+/m);
  const section = nextSection < 0 ? rest : rest.slice(0, nextSection);
  for (const line of section.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
    if (cells.length < 3) continue;
    const screenId = cells[0].replace(/\*\*/g, "").trim();
    if (!/^(?:PM|HM|GD)-\d+$/.test(screenId)) continue;
    for (const cell of [cells[1], cells[2]]) {
      for (const raw of cell.split("/")) {
        const id = raw.replace(/\*\*/g, "").trim();
        if (!/^(?:BR-\d+|UX-\d+|FR-L1-\d+)$/.test(id)) continue;
        const kind = id.startsWith("FR-L1") ? "fr" : id.startsWith("BR") ? "br" : "ux";
        out.push({ screenId, requirementId: id, kind });
      }
    }
  }
  return out;
}

/**
 * IMP-140: 画面 entity と FR/BR→画面 trace を doc 正本 (screen-list §1 + screen-requirements §5.5)
 * から harness.db に projection する。従来 screen は doc-only で DB に無く、HM-04 (DB 閲覧) /
 * HM-01 (機能一覧→画面) / PM-06 (設計書ビューア) を DB 駆動できなかった。
 *
 * PLAN-L7-102 (src/web Phase B): 実装済画面は screen-list frontmatter `implemented_screens`
 * (空白区切りの画面 ID 列) で宣言し implemented=1 / status=implemented で投影する。NFR-08 実装真実性 =
 * src/web に render が在る画面のみ implemented とし、宣言外は not-implemented を維持する。
 */
function projectScreens(repoRoot: string, db: HarnessDb): void {
  const screenListPath = join(repoRoot, "docs", "design", "harness", "L2-screen", "screen-list.md");
  if (!existsSync(screenListPath)) return;
  const listContent = readFileSync(screenListPath, "utf8");
  const indexedAt =
    frontmatterValue(listContent, "updated") || frontmatterValue(listContent, "created");
  const implementedSet = new Set(
    frontmatterValue(listContent, "implemented_screens")
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const screen of parseScreenListRows(listContent)) {
    const isImplemented = implementedSet.has(screen.screenId);
    recordProjectionEvent(db, {
      table: "screens",
      id: screen.screenId,
      row: {
        screen_id: screen.screenId,
        name: screen.name,
        category: screen.category,
        url: screen.url,
        l1_ref: screen.l1Ref,
        status: isImplemented ? "implemented" : "not-implemented",
        implemented: isImplemented ? 1 : 0,
        indexed_at: indexedAt,
      },
    });
  }
  const screenReqPath = join(
    repoRoot,
    "docs",
    "design",
    "harness",
    "L1-requirements",
    "screen-requirements.md",
  );
  if (!existsSync(screenReqPath)) return;
  const reqContent = readFileSync(screenReqPath, "utf8");
  for (const trace of parseScreenTraceRows(reqContent)) {
    const traceId = stableId("screen-trace", `${trace.screenId}:${trace.requirementId}`);
    recordProjectionEvent(db, {
      table: "screen_trace",
      id: traceId,
      row: {
        screen_trace_id: traceId,
        screen_id: trace.screenId,
        requirement_id: trace.requirementId,
        requirement_kind: trace.kind,
        relation: "trace",
        source: "screen-requirements §5.5",
      },
    });
  }
}

export function rebuildHarnessDb(input: RebuildHarnessDbInput = {}): RebuildHarnessDbResult {
  const repoRoot = input.repoRoot ?? process.cwd();
  const ownsDb = input.db === undefined;
  const db = input.db ?? openHarnessDb(defaultHarnessDbPath(repoRoot), { repoRoot });
  const timings: ProjectionTiming[] = [];
  let tokenIngestStats: RepoScopeIngestStats | undefined;
  const time = <T>(id: string, run: () => T): T => {
    if (input.timing !== true) return run();
    const started = performance.now();
    const result = run();
    timings.push({ id, duration_ms: Number((performance.now() - started).toFixed(3)) });
    return result;
  };
  try {
    time("migrate", () => migrate(db));
    const relationGraph =
      input.relationGraph ??
      time("load-relation-graph", () => defaultRelationGraphProjection(repoRoot));
    const documentExports =
      input.documentExports ??
      time("load-document-exports", () => defaultDocumentExportProjection(repoRoot));
    // Atomic rebuild: truncate + re-project run inside a single transaction so a
    // mid-rebuild failure rolls back to the prior committed projection instead of
    // leaving the DB truncated or half-populated (DB rebuild atomicity).
    runSqliteTransaction(db, () => {
      time("truncate", () => truncateProjectionTables(db));
      const plans = time("plans", () => projectPlans(repoRoot, db));
      if (hasVmodelAuthoring(repoRoot)) {
        time("vmodel-authoring", () => projectVmodelAuthoring(repoRoot, db));
      }
      time("drive-hook-model", () => {
        projectDriveRuns(repoRoot, db, plans);
        projectHookEvents(repoRoot, db, plans);
        projectReviewModelRuns(repoRoot, db, plans);
      });
      time("roadmap-review", () => {
        projectRoadmapRollup(repoRoot, db);
        projectReviewEvidenceRegistry(repoRoot, db);
        projectGithubReviewLaneReceipts(repoRoot, db);
        projectGuardrailInvariantAdvisories(db);
        projectDescentObligations(repoRoot, db);
        projectDesignPairFreezeFindings(repoRoot, db);
        projectDesignQualityCoverage(repoRoot, db);
        projectVerificationBandExecution(db);
        projectGateRunEvidence(repoRoot, db, plans);
      });
      time("automation-memory", () => {
        projectAutomationAssets(repoRoot, db);
        projectMemoryEntries(repoRoot, db);
      });
      time("runtime-skill-logs", () =>
        projectRuntimeSkillInvocationsFromSessionLogs(repoRoot, db, plans),
      );
      time("skill-projections", () => {
        projectSkillTelemetry(db, plans);
        projectSkillMetrics(db);
        projectSkillEvaluations(db);
        projectPocEvaluations(db);
      });
      if (!input.skipTokenTelemetry) {
        // repo スコープ token telemetry ingest (issue #82、PLAN-L7-454): 従来 model_runs には
        // review-evidence 由来行しか無かった実測欠落を是正する。model-operational (token 効率集計) より
        // 前に走らせ、同一 rebuild 内の projectModelEvaluations が新規 token 行を反映できるようにする。
        // 専用の timing id で計測し、他の projection と切り分けて可視化する。session ログ読取の想定外失敗は
        // fail-open とし、rebuild 全体を落とさない (cold-start / 権限エラー等でも継続)。
        time("token-telemetry", () => {
          try {
            tokenIngestStats = projectRepoScopedTokenUsage(repoRoot, db);
          } catch {
            tokenIngestStats = undefined;
          }
        });
      }
      time("model-operational", () => {
        projectModelEvaluations(db, repoRoot);
        projectOperationalMetrics(db);
      });
      const projectionDeps = { nowIso, stableId, recordProjectionEvent };
      time("refactor-candidates", () =>
        projectRefactorCandidateSignals(repoRoot, db, projectionDeps),
      );
      time("graph-impact", () => {
        projectRelationGraph(db, relationGraph);
        projectGraphSnapshot(db, relationGraph);
        projectImpactRules(db);
        projectCurrentImpactResults(repoRoot, db, relationGraph);
        projectArtifactProgress(db, relationGraph);
      });
      time("catalogs", () => {
        projectVerificationCatalogs(repoRoot, db);
        projectDocumentExportCatalogs(db);
      });
      time("document-exports", () => projectDocumentExports(db, documentExports));
      time("verification-evidence", () =>
        projectVerificationEvidence(db, input.verificationEvidence),
      );
      time("test-cases", () => projectTestCaseCatalog(repoRoot, db));
      time("spec-ir", () => projectSpecIr(repoRoot, db, projectionDeps));
      time("forward-readiness", () =>
        rebuildExecutionReadiness({ db, now: nowIso(), transactional: false, repoRoot }),
      );
      time("feedback", () => {
        projectFeedbackLifecycle(repoRoot, db, projectionDeps);
        projectVerificationDefectRoutingRefactorCandidates(db, projectionDeps);
        projectFeedbackEvents(db, projectionDeps);
        reconcileFeedbackLifecycle(repoRoot, db, projectionDeps);
        projectTroubleEvents(db, projectionDeps);
        projectRetryEvents(db, projectionDeps);
        projectIssueQueue(db, projectionDeps);
        projectIssueApprovalGuardrails(db, projectionDeps);
        projectImprovementLog(db, projectionDeps);
      });
      time("screens", () => projectScreens(repoRoot, db));
    });
    const counts = time("row-counts", () => rowCounts(db));
    const result: RebuildHarnessDbResult = {
      ok: true,
      path: db.path,
      rowCounts: counts,
      findings: [],
      inputs: {
        relationGraph,
        documentExports,
        verificationEvidence: input.verificationEvidence,
      },
    };
    if (input.timing === true) result.timings = timings;
    if (tokenIngestStats !== undefined) result.tokenIngest = tokenIngestStats;
    return result;
  } finally {
    if (ownsDb) db.close();
  }
}
