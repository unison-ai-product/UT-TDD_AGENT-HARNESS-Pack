#!/usr/bin/env node
/**
 * UT-TDD Agent Harness CLI (TypeScript core, ADR-001).
 * 薄い OS 別 entrypoint (scripts/ut-tdd, ut-tdd.ps1) が本 core を呼ぶ。
 * status / doctor / plan lint / vmodel lint / gate / runtime adapter を集約する。
 */
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Command } from "commander";
import { parse as parseYaml } from "yaml";
import {
  catalogAutomationAssets,
  checkRosterConsistency,
  listRosterRegistry,
} from "./assets/catalog.ts";
import { loadBranchAudit, renderBranchAudit } from "./audit/branches.ts";
import { renderQualityAudit, runQualityAudit } from "./audit/quality.ts";
import {
  adapterExecutionEnv,
  executeAdapterPlanForCli,
  registerDelegationCommands,
} from "./cli/delegation.ts";
import { registerDistributionCommands } from "./cli/distribution.ts";
import { registerFeedbackCommands } from "./cli/feedback.ts";
import { registerPlanAdmissionCommands } from "./cli/plan-admission.ts";
import { registerPlanAssetCommands } from "./cli/plan-asset.ts";
import { registerPlanDraftCommand } from "./cli/plan-draft.ts";
import { registerPlanRevisionCommand } from "./cli/plan-revise.ts";
import { registerPrMergeCommands } from "./cli/pr-merge.ts";
import { registerLiveReviewCommands } from "./cli/review-live.ts";
import { contextSuggest } from "./context/doc-router.ts";
import {
  DOCTOR_RUN_PROFILE_IDS,
  DOCTOR_RUN_PROFILES,
  type DoctorRunProfileId,
} from "./doctor/check-registry.ts";
import { runDoctor, runDoctorMeasured } from "./doctor/index.ts";
import { writeDoctorResultEnvelopeFile } from "./doctor/result-file.ts";
import { acquireDoctorLock, doctorLockBlockedMessage } from "./doctor/singleton-lock.ts";
import { renderElicitationContext, selectElicitationContext } from "./elicitation/context.ts";
import { appendDesignDecision, DESIGN_DECISION_LOG_PATH } from "./elicitation/record.ts";
import { computeSkillMetrics } from "./feedback/engine.ts";
import { registerForwardWorkflowCommands } from "./forward/adapters/cli-registrar.ts";
import { evaluateGateReview, loadReviewChecklistIfPresent } from "./gate/review-tier.ts";
import { writeGateRunEvidence } from "./gate/run-evidence.ts";
import { evaluateStaticGate } from "./gate/static.ts";
import { runChangeLaneClassification, SystemGitDiffNamesPort } from "./github/change-lane.ts";
import { collectJobSummary, renderJobSummary } from "./github/job-summary.ts";
import { evaluateGithubOpsGuard, renderGithubOpsGuard } from "./github/ops-guard.ts";
import { renderPrTraceBlock, validatePrTraceBody } from "./github/pr-trace.ts";
import { GhProjectV2Adapter, persistProjectSync, syncForwardProject } from "./github/project-v2.ts";
import { syncRepositoryBindings } from "./github/repository-bindings.ts";
import {
  diffRepositoryPolicy,
  normalizeRulesets,
  parseRepositoryPolicy,
  renderPolicyDiff,
} from "./github/repository-policy.ts";
import { loadRelationGraphSourceSet } from "./graph/loader.ts";
import {
  checkHandoverBypass,
  checkHandoverDiscipline,
  latestSessionId,
  nodeHandoverDeps,
  runHandover,
  setActivePlanCli,
} from "./handover/index.ts";
import {
  renderSessionStartDigest,
  selectSessionStartDigest,
} from "./handover/session-start-digest.ts";
// Final retirement admission reuses the independent detector through the CLI runtime graph.
import {
  admitFinalBunRetirement,
  type BunRetirementAdmissionReceipt,
  type BunRetirementF0bReceipt,
  type BunRetirementF0cReceipt,
  type BunRetirementQ0Receipt,
  collectFinalRetirementFindings,
  collectFinalRetirementSurfaceInventory,
} from "./lint/bun-final-retirement.ts";
import {
  type NodeBanF0cAggregateBinding,
  nodeBanAuditMessages,
  runNodeBanAudit,
} from "./lint/bun-permanent-ban.ts";
import { loadChangedFiles, loadStagedFiles } from "./lint/change-impact.ts";
import {
  applyDigestAnchorCandidatesToContent,
  nodeHistoryScanDeps,
  planDigestMigration,
} from "./lint/green-command-digest.ts";
import { parseNodeGenerationCiEvidence } from "./lint/node-generation-ci-policy.ts";

export { collectFinalRetirementFindings };

import { computeOutstandingWork, outstandingSummaryLine } from "./lint/outstanding.ts";
import {
  analyzeRelationImpact,
  collectRelationGraphProjection,
  exportRelationDiagram,
  type RelationDiagramAdapter,
} from "./lint/relation-graph.ts";
import { loadReviewPlans } from "./lint/review-evidence.ts";
import {
  inspectMcpProfile,
  listVerificationProfiles,
  nodeVerificationProbeDeps,
  probeVerificationProfile,
  recommendVerificationProfiles,
  runVerificationProfile,
  saveVerificationEvidence,
  verificationRecommendationMermaid,
} from "./lint/verification-profile.ts";
import { runWriteEncodingGuard } from "./lint/write-encoding-guard.ts";
import { type MemoryKind, renderMemoryList, renderMemorySurface } from "./memory/index.ts";
import {
  type MemoryQueryOptions,
  type MemoryReadResult,
  readMemory,
  registrationReceiptFor,
  renderMemoryHealth,
  writeMemory,
} from "./memory/service.ts";
import { lintPlanWithGate } from "./plan/lint.ts";
import { createNodePlanDraftRunner } from "./plan-admission/node-plan-draft-runner.ts";
import { createNodePlanRevisionRunner } from "./plan-admission/node-plan-revision-runner.ts";
import {
  type AdapterContextInjection,
  type AdapterProvider,
  buildProviderInvocation,
} from "./runtime/adapter.ts";
import {
  type AgentGuardInput,
  evaluateAgentGuard,
  normalizeModelFamily,
  type ResolvedFamily,
} from "./runtime/agent-guard.ts";
import { SUBAGENT_ALLOWLIST } from "./runtime/agent-guard-policy.ts";
import {
  nodeAgentSlotsDeps,
  recordGuardFire,
  releaseOldestGuardSlot,
  sweepStaleGuardSlots,
} from "./runtime/agent-slots.ts";
import {
  attemptsFromSessionEvents,
  evaluateAttemptEscalation,
  renderEscalationSignals,
  selectPrecedingSessionFile,
} from "./runtime/attempt-escalation.ts";
import {
  buildClaudeProviderInboxEntry,
  type ClaudeInboxPullRequestObservation,
  claudeWorkspaceId,
  isClaudeMemoryWakeTarget,
  parseClaudeInboxPullRequestObservation,
  publishClaudeInboxEntry,
  recoverClaudeInboxBacklog,
  resolveClaudeWakeDelay,
  resolveLiveClaudeTarget,
  summarizeUnclaimedInbox,
  waitForClaudeMemory,
} from "./runtime/claude-memory-wake.ts";
import { detectMode, nextActionForMode, type RuntimeDetection } from "./runtime/detect.ts";
import { scanDanglingStops } from "./runtime/forced-stop.ts";
import { createNodeInvocation, verifyNodeGeneration } from "./runtime/node-bootstrap.ts";
import {
  isLinkedWorktreeCheckout,
  requireProjectMemoryRoot,
  resolveProjectMemoryRoot,
} from "./runtime/project-memory-root.ts";
import {
  nodeProviderHandoverDeps,
  type ProviderRuntime,
  readProviderHandoverCurrent,
  runProviderHandover,
} from "./runtime/provider-handover.ts";
import { requireRuntimeRepoRoot } from "./runtime/repo-root.ts";
import { summarizeStagedReview } from "./runtime/review-guard.ts";
import {
  classifyRuntimeImageProcess,
  NodeOnlyProcessObserver,
} from "./runtime/runtime-image-observer.ts";
import {
  dispatch,
  nodeDeps,
  parseSessionEvents,
  recordSkillInjectionAttempt,
  resolveActivePlan,
  type SessionHookInput,
  safeName,
} from "./runtime/session-log.ts";
import {
  evaluateWorkGuardTargets,
  extractEditTargets,
  normalizeRepoRelative,
  resolveForeignEditOverride,
} from "./runtime/work-guard.ts";
import { findReference } from "./search/index.ts";
import {
  admitConsumerLocalRuntime,
  admitReleaseAggregate,
  type ConsumerLocalRuntimeAdmissionInput,
  nodeSetupDeps,
  type ReleaseAggregateAdmissionInput,
  runSetupAsync,
  type SetupArgs,
  type SetupConsumerRuntimeInput,
} from "./setup/index.ts";
import type { ReleaseChannelAttestation } from "./setup/release-channel-adapter.ts";
import {
  checkForUpdate,
  defaultHarnessRoot,
  nodeUpdateCheckDeps,
  readHarnessVersion,
  renderUpdateLine,
  UPDATE_CHECK_DISABLE_ENV,
  updateCheckDisabled,
} from "./setup/update-check.ts";
import { ensureDir } from "./shared/fs.ts";
import {
  bucketRecommendations,
  buildSkillInjectionSet,
  recommendSkillsForPlan,
  recommendSkillsForText,
  recordSkillRecommendations,
  resolveRuntimeSessionId,
} from "./skill-engine/recommend.ts";
import { type SkillCategory, scaffoldSkill } from "./skill-engine/scaffold.ts";
import {
  claimGithubProjection,
  deriveStoredForwardReadiness,
  isManualGithubObservationKind,
  markGithubProjectionFailed,
  queueGithubProjection,
  rebuildExecutionReadiness,
  recordGithubBinding,
  selectActiveProjectRows,
  selectExistingProjectPlans,
} from "./state-db/github-forward-projection.ts";
import { defaultHarnessDbPath, openHarnessDb } from "./state-db/index.ts";
import { harnessDbStatus } from "./state-db/maintenance.ts";
import { migrate } from "./state-db/migration.ts";
import {
  projectModelEvaluations,
  projectTokenUsage,
  rebuildHarnessDb,
} from "./state-db/projection-writer.ts";
import { buildScopeDryRunPreview } from "./state-db/scope-preview.ts";
import {
  refuseBunStopRefresh,
  runCoalescedStopRefresh,
  spawnDetachedStopRefresh,
} from "./state-db/stop-refresh.ts";
import { loadRuntimeSessionUsage, summarizeRunUsage } from "./state-db/token-tracker.ts";
import { classifyProposalDocumentCoverage, classifyTask } from "./task/classify.ts";
import {
  type Provider,
  type RouterRole,
  roster,
  route,
  routeTeamMembers,
  routeToAdapterPlan,
} from "./task/tier-router.ts";
import {
  ADVISOR_DECISION_KINDS,
  type AdvisorDecisionKind,
  buildAdvisorDecision,
} from "./team/advisor-policy.ts";
import { recommendTeamLaunch } from "./team/launch-policy.ts";
import {
  buildTeamRunPlan,
  executeTeamRunPlan,
  loadTeamDefinition,
  type MemberPlacement,
} from "./team/run.ts";
import { analyzeTraceImpact } from "./trace/impact.ts";
import { formatVmodelInjection, resolveVmodelInjection } from "./vmodel/injection.ts";
import { lintVmodel } from "./vmodel/lint.ts";
import {
  buildCommandCatalog,
  evaluateRouteCommand,
  type RouteApprovalPolicy,
  type RouteConfigViolation,
  type RouteEvalResult,
  type RouteSignalEntry,
  validateRouteConfigText,
} from "./workflow/contracts.ts";
import { evaluateAutomationReadiness } from "./workflow/readiness.ts";

const HOOK_EVENT_SESSION_START = "SessionStart";
const SAVE_EVIDENCE_OPTION_DESCRIPTION = "persist normalized evidence for DB collector";
const SESSION_OPTION_DESCRIPTION = "session_id (defaults to stdin session_id or ut-tdd-cli)";
const MODE_OVERRIDE_OPTION_DESCRIPTION = "override execution mode for tests";
const TASK_FILE_OPTION_DESCRIPTION = "read task text from file";

function gitBranch(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function gitHead(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function optionFromCommandChain<T>(cmd: Command, key: string): T | undefined {
  let current: Command | null = cmd;
  while (current) {
    const value = (current.opts() as Record<string, unknown>)[key];
    if (value !== undefined) return value as T;
    current = current.parent ?? null;
  }
  return undefined;
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function resolveTaskText(opts: { task?: string; taskFile?: string }): string | null {
  if (opts.task && opts.taskFile) return null;
  if (opts.taskFile) {
    try {
      return readFileSync(opts.taskFile, "utf8");
    } catch {
      return null;
    }
  }
  return opts.task ?? null;
}

function resolveSkillContextInjection(
  planId: string | undefined,
): AdapterContextInjection | undefined {
  if (!planId) return undefined;
  const repoRoot = process.cwd();
  // PLAN-L7-262: 注入の成功/skip を session jsonl へ記録する (silent fail-open をやめ、
  // 「握った事実の記録付き fail-open」へ)。記録自体は recordEvent の fail-open に従う。
  const logDeps = nodeDeps(repoRoot, () => null);
  const db = openHarnessDb(":memory:", { repoRoot });
  try {
    try {
      // 文脈注入は skill/PLAN 投影だけが必要で、グローバル token telemetry の再走査は不要。
      // 毎回の provider 起動で home 配下を走査すると実行境界を不必要に遅延させる。
      rebuildHarnessDb({ repoRoot, db, skipTokenTelemetry: true });
    } catch {
      recordSkillInjectionAttempt(
        { plan_id: planId, status: "skipped", reason: "rebuild-failed", required: 0, optional: 0 },
        logDeps,
      );
      return undefined;
    }
    const recommendations = recommendSkillsForPlan(db, planId);
    const injection = buildSkillInjectionSet(db, recommendations);
    if (injection.required_paths.length === 0 && injection.optional_paths.length === 0) {
      recordSkillInjectionAttempt(
        {
          plan_id: planId,
          status: "skipped",
          reason: "no-matching-skills",
          required: 0,
          optional: 0,
        },
        logDeps,
      );
      return undefined;
    }
    recordSkillInjectionAttempt(
      {
        plan_id: planId,
        status: "injected",
        required: injection.required_paths.length,
        optional: injection.optional_paths.length,
      },
      logDeps,
    );
    return {
      required_paths: injection.required_paths,
      optional_paths: injection.optional_paths,
    };
  } finally {
    db.close();
  }
}

function planIdFromPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    const raw = readFileSync(path, "utf8");
    return raw.match(/^plan_id:\s*([^\r\n]+)/m)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

function readHookInput(defaultEvent: string, sessionId?: string): SessionHookInput {
  const raw = process.stdin.isTTY ? "" : readStdin();
  const normalized = raw.replace(/^\uFEFF/, "").trim();
  let parsed: SessionHookInput = {};
  if (normalized) {
    try {
      parsed = JSON.parse(normalized) as SessionHookInput;
    } catch {
      parsed = {};
    }
  }
  return {
    ...parsed,
    hook_event_name: parsed.hook_event_name ?? defaultEvent,
    session_id: sessionId ?? parsed.session_id ?? "ut-tdd-cli",
  };
}

function sessionTouchedFilesForGuard(repoRoot: string, sessionId: string | undefined): string[] {
  if (!sessionId) return [];
  const safe = sessionId.replace(/[\\/]+/g, "_");
  const file = join(repoRoot, ".ut-tdd", "logs", "session", `${safe}.jsonl`);
  if (!existsSync(file)) return [];
  const touched: string[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as { target?: string };
      if (ev.target) touched.push(normalizeRepoRelative(ev.target, repoRoot));
    } catch {
      // Ignore malformed session-log rows; preflight should keep checking other rows.
    }
  }
  return touched;
}

function guardTargetsFromPatchText(patchText: string, repoRoot: string): string[] {
  return extractEditTargets({ input: patchText }).map((target) =>
    normalizeRepoRelative(target, repoRoot),
  );
}

function parseHookInput<T>(raw: string): T | null {
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, "") || "{}") as T;
  } catch {
    return null;
  }
}

function resolveAgentFamilyFromRepo(repoRoot: string, subagentType: string): ResolvedFamily {
  const md = join(repoRoot, ".claude", "agents", `${subagentType}.md`);
  if (!existsSync(md)) return "missing";
  const content = readFileSync(md, "utf8");
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return "unknown";
  const modelLine = fm[1].match(/^model:[ \t]*(\S+)/m);
  return normalizeModelFamily(modelLine?.[1]?.trim()) ?? "unknown";
}

function hookTargetPaths(input: { tool_input?: unknown } | null, repoRoot: string): string[] {
  return extractEditTargets(input?.tool_input).map((target) =>
    normalizeRepoRelative(target, repoRoot),
  );
}

function writeHandoverWarnings(): void {
  const hdeps = nodeHandoverDeps(process.cwd());
  for (const w of [...checkHandoverDiscipline(hdeps), ...checkHandoverBypass(hdeps)]) {
    process.stderr.write(`[ut-tdd handover] ${w}\n`);
  }
}

type SessionStartSideEffectInput = {
  repoRoot: string;
  input: SessionHookInput;
  deps: ReturnType<typeof nodeDeps>;
  json?: boolean;
};

function runSessionStartSideEffects({
  repoRoot,
  input,
  deps,
  json = false,
}: SessionStartSideEffectInput): void {
  try {
    scanDanglingStops(deps, input.session_id);
    sweepStaleGuardSlots(nodeAgentSlotsDeps(repoRoot));
  } catch {
    // fail-open: lifecycle maintenance must not block the runtime.
  }
  // JSON は機械可読な実行結果だけを stdout に返す契約。人間向け digest は
  // 並列 provider ごとに DB / memory を再読する必要がなく、lifecycle dispatch
  // (SessionStart/Stop) は呼び出し側で継続するため、JSON 経路では省略する。
  if (json) return;
  surfaceSessionStartDigestToStdout(
    repoRoot,
    attemptEscalationBlock(repoRoot, input.session_id),
    "stdout",
  );
}

/**
 * 引き継ぎ (SessionStart) 時に **直前 session** の連続失敗ループ (Iron Law escalation) を surface
 * する (PLAN-RECOVERY-05 item 2、Q2=b)。harness.db には書かず、直前 session の jsonl ログを都度
 * 再導出する (core rebuild の入力境界を広げない)。現セッションを除いた最新 1 ファイルのみを読むため
 * 古い失敗は再浮上しない。独立した fail-open: ログ不在 / 破損で runtime を止めない。
 */
function attemptEscalationBlock(repoRoot: string, currentSessionId?: string): string {
  try {
    const dir = join(repoRoot, ".ut-tdd", "logs", "session");
    if (!existsSync(dir)) return "";
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }));
    const currentName = currentSessionId ? `${safeName(currentSessionId)}.jsonl` : undefined;
    const preceding = selectPrecedingSessionFile(files, currentName);
    if (!preceding) return "";
    const events = parseSessionEvents(readFileSync(join(dir, preceding), "utf8"));
    const signals = evaluateAttemptEscalation(attemptsFromSessionEvents(events));
    return renderEscalationSignals(signals);
  } catch {
    // fail-open: escalation surface は best-effort。
    return "";
  }
}

/** DB state、HEAD、actionable、memory を固定4段で返す。各入力は fail-open。 */
function recentHeadCommits(repoRoot: string, limit = 5): string[] {
  try {
    const output = execFileSync("git", ["log", `-${limit}`, "--format=%h %s"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    return output ? output.split(/\r?\n/).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * 共有 memory の読み出し入口 (PLAN-L7-468)。index (harness.db) が開けなくても
 * 正本ファイルから結果を返し、degraded は freshness で可視化する。
 */
function readMemoryThroughService(
  repoRoot: string,
  options: MemoryQueryOptions = {},
): MemoryReadResult {
  const project = requireProjectMemoryRoot(repoRoot);
  let db: ReturnType<typeof openHarnessDb> | undefined;
  try {
    db = openHarnessDb(defaultHarnessDbPath(project.canonicalProjectRoot), {
      repoRoot: project.canonicalProjectRoot,
    });
    return readMemory({ repoRoot: project.canonicalProjectRoot, db, options });
  } catch {
    // index を開けないこと自体は読み出しの失敗ではない (ファイルが正本)。
    return readMemory({ repoRoot: project.canonicalProjectRoot, options });
  } finally {
    db?.close();
  }
}

/**
 * Read-only PR lifecycle observation at the CLI boundary.
 *
 * The inbox core accepts an observation port so it never owns GitHub/network
 * policy.  `gh pr view` is deliberately invoked without a shell and every
 * parse/network failure returns `undefined`; callers then leave the entry
 * live.  A missing observation must never become a terminal decision.
 */
function observeClaudeInboxPullRequest(
  repoRoot: string,
  pr: number,
): ClaudeInboxPullRequestObservation | undefined {
  try {
    const raw = execFileSync(
      "gh",
      ["pr", "view", String(pr), "--json", "state,mergedAt,headRefOid"],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return parseClaudeInboxPullRequestObservation(pr, raw);
  } catch {
    return undefined;
  }
}

function recoverClaudeInboxForSessionStart(repoRoot: string): void {
  try {
    recoverClaudeInboxBacklog({
      repoRoot,
      dryRun: false,
      pullRequestState: (pr) => observeClaudeInboxPullRequest(repoRoot, pr),
    });
  } catch {
    // SessionStart remains fail-open; unknown PR state keeps entries live.
  }
}

function surfaceSessionStartDigestToStdout(
  repoRoot: string,
  escalationBlock = "",
  outputTo: "stdout" | "stderr" = "stdout",
): void {
  const writeOutput = (text: string) => {
    if (outputTo === "stderr") {
      process.stderr.write(text);
      return;
    }
    process.stdout.write(text);
  };
  // memory は DB 障害と独立に正本ファイルから読む (PLAN-L7-468 欠陥 3)。
  const memory = readMemoryThroughService(repoRoot, { limit: 5 });
  let unclaimedInbox: ReturnType<typeof summarizeUnclaimedInbox> | undefined;
  try {
    recoverClaudeInboxForSessionStart(repoRoot);
    const workspaceId = claudeWorkspaceId(repoRoot);
    unclaimedInbox = summarizeUnclaimedInbox(repoRoot, workspaceId);
  } catch {
    unclaimedInbox = undefined;
  }
  try {
    const db = openHarnessDb(defaultHarnessDbPath(repoRoot), { repoRoot });
    try {
      const block = renderSessionStartDigest(
        selectSessionStartDigest(db, recentHeadCommits(repoRoot), {
          escalationLines: escalationBlock.trim().split(/\r?\n/).filter(Boolean),
          memory: memory.entries,
          unclaimedInbox,
        }),
      );
      if (block) writeOutput(block);
      process.stderr.write(renderMemoryHealth(memory));
    } finally {
      db.close();
    }
  } catch (error) {
    // hook は止めないが、無音では終わらせない (「引き継ぎ情報が無い」と
    // 「読めなかった」を SessionStart で区別できないことが欠陥 3 の本体)。
    // stdout は機械可読出力の面なので汚さない (JSON を parse する呼び手が壊れる)。
    // 劣化は stderr に出して「無音ではない」を満たす。
    process.stderr.write(
      renderDegradedSessionStartDigest({
        memory,
        error,
        headCommits: recentHeadCommits(repoRoot),
      }),
    );
  }
}

/** DB 由来の段が全滅した場合の劣化 digest。memory と HEAD は DB に依存しないので残す。 */
function renderDegradedSessionStartDigest(input: {
  memory: MemoryReadResult;
  error: unknown;
  headCommits: string[];
}): string {
  const { memory, error, headCommits } = input;
  const reason = error instanceof Error ? error.message : String(error);
  const lines = [
    "session-start digest DEGRADED — harness.db 由来の段 (state/gates, actionable) を読めなかった",
    `  reason: ${reason}`,
    "  → 「引き継ぎ情報が無い」ではなく「index が読めなかった」。DB 復旧まで判断の根拠にしない",
    "[2/4 head]",
  ];
  if (headCommits.length === 0) lines.push("  - unavailable");
  for (const commit of headCommits) lines.push(`  - ${commit}`);
  lines.push("[4/4 memory] (source=.ut-tdd/memory 正本ファイル)");
  if (memory.entries.length === 0) lines.push("  - none");
  for (const entry of memory.entries) {
    const body = entry.body.replace(/\s+/g, " ").slice(0, 160);
    lines.push(`  - ${entry.kind} ${entry.title}: ${body}`);
  }
  return `${lines.join("\n")}\n${renderMemoryHealth(memory)}`;
}

const program = new Command();
program
  .name("ut-tdd")
  .description("UT-TDD Agent Harness (TypeScript core, ADR-001)")
  // PLAN-L7-362: update-check の比較元 (harness root package.json) と同一ソースで表示する。
  .version(readHarnessVersion(defaultHarnessRoot()));

program
  .command("status")
  .description("実行モード検出 (standalone / claude-only / codex-only / hybrid)")
  .option("--json", "JSON で出力")
  .action((opts: { json?: boolean }) => {
    const d = detectMode();
    const nextAction = nextActionForMode(d.mode);
    // IMP-139: 未了の正の集計 (非終端 PLAN 層別 + open defer) を additive に surface し
    // 「doctor green = 完了」誤読を機械照合可能にする (gate ではない informational surface)。
    const outstanding = computeOutstandingWork(process.cwd());
    // PLAN-L7-362: update-check advisory (fail-open、gate ではない)。基準は harness checkout。
    const update =
      process.env[UPDATE_CHECK_DISABLE_ENV] === "1"
        ? updateCheckDisabled(UPDATE_CHECK_DISABLE_ENV)
        : process.env.CI === "true"
          ? updateCheckDisabled("CI")
          : checkForUpdate(nodeUpdateCheckDeps());
    if (opts.json) {
      // 既存 6 フィールド (camelCase 公開契約) に nextAction + outstanding を additive に付加する
      // (A-138 ITEM-1、PLAN-L7-84、IMP-139、taxonomy=current)。判断ゲートの進め方 + 未了量を提示。
      process.stdout.write(
        `${JSON.stringify({ ...d, nextAction, outstanding, update }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(
        `mode: ${d.mode}  (claude=${d.claude}, codex=${d.codex}, current=${d.currentRuntime ?? "-"})\n`,
      );
      process.stdout.write(`next: ${nextAction}\n`);
      process.stdout.write(`${outstandingSummaryLine(outstanding)}\n`);
      process.stdout.write(`${renderUpdateLine(update)}\n`);
    }
  });

program
  .command("doctor")
  .description("統合検証 (doctor / gate / trace / drift / roadmap)")
  .option(
    "--strict-telemetry-provenance",
    "fail closed when populated telemetry tables have only projection provenance",
  )
  .option(
    "--strict-green-command-digest",
    "fail closed when green command digests do not match their evidence files",
  )
  .option(
    "--setup-smoke",
    "run only the fresh-consumer setup smoke checks for wrapper and adapter hooks",
  )
  .option("--profile <profile>", `run a named doctor profile (${DOCTOR_RUN_PROFILE_IDS.join("|")})`)
  .option("--profiles", "list available doctor profiles and exit")
  .option("--scope <scope>", "limit doctor checks to a supported scope (full|toolchain)")
  .option("--timing", "include per-check doctor timing diagnostics")
  .option(
    "--result-file <path>",
    "write the measured result as an envelope for a same-job consumer (PLAN-L7-461)",
  )
  .option("--json", "JSON output")
  .action(
    async (opts: {
      strictTelemetryProvenance?: boolean;
      strictGreenCommandDigest?: boolean;
      setupSmoke?: boolean;
      profile?: string;
      profiles?: boolean;
      scope?: string;
      timing?: boolean;
      resultFile?: string;
      json?: boolean;
    }) => {
      if (opts.profiles === true) {
        const profiles = DOCTOR_RUN_PROFILE_IDS.map((id) => DOCTOR_RUN_PROFILES[id]);
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(profiles, null, 2)}\n`);
        } else {
          for (const profile of profiles) {
            const scope = "scope" in profile ? ` scope=${profile.scope}` : "";
            process.stdout.write(
              `doctor profile: ${profile.id} audience=${profile.audience} invocation=${profile.invocation}${scope} sourceOnly=${profile.sourceOnly}\n`,
            );
          }
        }
        return;
      }
      const profile = opts.profile;
      if (profile && !DOCTOR_RUN_PROFILE_IDS.includes(profile as DoctorRunProfileId)) {
        const message = `doctor: invalid --profile "${profile}" (expected: ${DOCTOR_RUN_PROFILE_IDS.join(", ")})`;
        if (opts.json) {
          process.stdout.write(`${JSON.stringify({ ok: false, messages: [message] }, null, 2)}\n`);
        } else {
          process.stderr.write(`${message}\n`);
        }
        process.exitCode = 1;
        return;
      }
      const scope = opts.scope ?? "full";
      if (scope !== "full" && scope !== "toolchain") {
        const message = `doctor: invalid --scope "${scope}" (expected: full, toolchain)`;
        if (opts.json) {
          process.stdout.write(`${JSON.stringify({ ok: false, messages: [message] }, null, 2)}\n`);
        } else {
          process.stderr.write(`${message}\n`);
        }
        process.exitCode = 1;
        return;
      }
      // 多重起動 fail-fast (PLAN-L7-442): 再試行嵐で doctor プロセスが積み上がり
      // メモリ枯渇する実害 (2026-07-16) の再発防止。lock 障害は fail-open。
      const lock = acquireDoctorLock(process.cwd());
      if (!lock.acquired) {
        const message = doctorLockBlockedMessage(lock.holder);
        if (opts.json) {
          process.stdout.write(`${JSON.stringify({ ok: false, messages: [message] }, null, 2)}\n`);
        } else {
          process.stderr.write(`${message}\n`);
        }
        process.exitCode = 2;
        return;
      }
      let measured: ReturnType<typeof runDoctorMeasured>;
      try {
        measured = runDoctorMeasured(undefined, {
          strictTelemetryProvenance: opts.strictTelemetryProvenance === true,
          strictGreenCommandDigest: opts.strictGreenCommandDigest === true,
          setupSmoke: opts.setupSmoke === true,
          ...(profile ? { profile: profile as DoctorRunProfileId } : {}),
          scope,
          timing: opts.timing === true,
        });
      } finally {
        lock.release();
      }
      const r = measured.result;
      if (opts.resultFile) {
        // PLAN-L7-461: 同一 job 内の consumer (vitest fence) が「どの面をどの条件で観測したか」を
        // 完全一致で検査できるよう、観測面ごと書き出す。書き出し失敗は測定自体を失敗させない
        // (consumer は envelope 不在で自走へ fail-close する)。
        try {
          writeDoctorResultEnvelopeFile(opts.resultFile, process.cwd(), {
            scope:
              measured.profile.invocation === "registry" ? measured.profile.scope : "setup-smoke",
            profile: profile
              ? (profile as DoctorRunProfileId)
              : opts.setupSmoke === true
                ? measured.profile.id
                : null,
            options: {
              strict_green_command_digest: opts.strictGreenCommandDigest === true,
              strict_telemetry_provenance: opts.strictTelemetryProvenance === true,
              timing: opts.timing === true,
            },
            checkIds: measured.checkIds,
            result: r,
          });
        } catch (error) {
          process.stderr.write(
            `doctor: result-file の書き出しに失敗 (consumer は自走へ落ちる): ${String(error)}\n`,
          );
        }
      }
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      } else {
        for (const m of r.messages) process.stdout.write(`${m}\n`);
        if (opts.timing === true && r.timings) {
          const slowest = [...r.timings].sort((a, b) => b.duration_ms - a.duration_ms).slice(0, 10);
          for (const timing of slowest) {
            process.stdout.write(
              `doctor: timing - ${timing.id} ${timing.duration_ms.toFixed(3)}ms messages=${timing.message_count} ok=${timing.ok}\n`,
            );
          }
        }
      }
      process.exitCode = r.ok ? 0 : 1;
    },
  );

// `web` command は PLAN-L7-102 prototype (table-dumper) 破棄に伴い撤去 (2026-06-24)。
// component-derived な中央UI 再実装は PLAN-L7-141 で再配線する。

const mcp = program.command("mcp").description("MCP and external verification profile catalog");
const mcpProfile = mcp.command("profile").description("verification profile catalog");
mcpProfile
  .command("list")
  .description("list MCP / external verification profiles")
  .option("--all", "include builtin profiles")
  .option("--json", "JSON output")
  .option("--save-evidence", SAVE_EVIDENCE_OPTION_DESCRIPTION)
  .action((opts: { all?: boolean; json?: boolean; saveEvidence?: boolean }) => {
    const deps = nodeVerificationProbeDeps(process.cwd());
    const profiles = listVerificationProfiles().filter(
      (profile) => opts.all || profile.sourceType !== "builtin",
    );
    if (opts.saveEvidence) {
      saveVerificationEvidence({ kind: "profile-list", id: "catalog", payload: profiles }, deps);
    }
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(profiles, null, 2)}\n`);
      return;
    }
    for (const profile of profiles) {
      const state = profile.defaultEnabled ? "enabled" : "disabled";
      process.stdout.write(
        `${profile.id}: ${profile.sourceType} ${state} risk=${profile.riskTier} command="${profile.command}"\n`,
      );
    }
  });

mcpProfile
  .command("probe <name>")
  .description("probe whether a verification profile is configured and runnable")
  .option("--json", "JSON output")
  .option("--save-evidence", SAVE_EVIDENCE_OPTION_DESCRIPTION)
  .action((name: string, opts: { json?: boolean; saveEvidence?: boolean }) => {
    const deps = nodeVerificationProbeDeps(process.cwd());
    const result = probeVerificationProfile(name, deps);
    if (!result) {
      process.stderr.write(`unknown profile: ${name}\n`);
      process.exitCode = 1;
      return;
    }
    if (opts.saveEvidence) {
      saveVerificationEvidence({ kind: "profile-probe", id: name, payload: result }, deps);
    }
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    process.stdout.write(
      `profile ${result.profile.id}: ${result.ready ? "ready" : "not-ready"} (${result.profile.label})\n`,
    );
    for (const check of result.checks) {
      process.stdout.write(`  - ${check.ok ? "ok" : "missing"} ${check.name}: ${check.message}\n`);
    }
    process.exitCode = result.ready ? 0 : 1;
  });

mcp
  .command("inspect <name>")
  .description("inspect an MCP profile through the MCP Inspector readiness gate")
  .option("--method <method>", "MCP method to inspect", "tools/list")
  .option("--allow-external", "allow disabled external MCP inspection after review")
  .option("--json", "JSON output")
  .option("--save-evidence", SAVE_EVIDENCE_OPTION_DESCRIPTION)
  .action(
    (
      name: string,
      opts: { method?: string; allowExternal?: boolean; json?: boolean; saveEvidence?: boolean },
    ) => {
      const deps = nodeVerificationProbeDeps(process.cwd());
      const result = inspectMcpProfile(
        name,
        { method: opts.method, allowExternal: Boolean(opts.allowExternal) },
        deps,
      );
      if (!result) {
        process.stderr.write(`unknown MCP profile: ${name}\n`);
        process.exitCode = 1;
        return;
      }
      if (opts.saveEvidence) {
        saveVerificationEvidence({ kind: "mcp-inspect", id: name, payload: result }, deps);
      }
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        process.stdout.write(`mcp inspect ${name}: ${result.status} method=${result.method}\n`);
        for (const message of result.messages) process.stdout.write(`  - ${message}\n`);
      }
      process.exitCode = result.status === "ready" ? 0 : 1;
    },
  );

const verify = program.command("verify").description("verification profile recommendation");
verify
  .command("recommend")
  .description("recommend verification profiles from changed files and emit an impact graph")
  .option("--changed <path...>", "changed path(s); defaults to git status --porcelain")
  .option("--format <format>", "text / json / mermaid", "text")
  .option("--save-evidence", SAVE_EVIDENCE_OPTION_DESCRIPTION)
  .action(
    (opts: {
      changed?: string[];
      format?: "text" | "json" | "mermaid" | string;
      saveEvidence?: boolean;
    }) => {
      const deps = nodeVerificationProbeDeps(process.cwd());
      const changedFiles =
        opts.changed && opts.changed.length > 0 ? opts.changed : loadChangedFiles();
      const result = recommendVerificationProfiles(changedFiles);
      if (opts.saveEvidence) {
        saveVerificationEvidence(
          { kind: "verify-recommend", id: "changed-files", payload: result },
          deps,
        );
      }
      if (opts.format === "json") {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      if (opts.format === "mermaid") {
        process.stdout.write(`${verificationRecommendationMermaid(result)}\n`);
        return;
      }
      process.stdout.write(
        `verify recommend: ${result.recommendations.length} profile(s), changed=${result.changedFiles.length}\n`,
      );
      for (const recommendation of result.recommendations) {
        const profile = recommendation.profile;
        const disabled = profile.defaultEnabled ? "" : " disabled-by-default";
        process.stdout.write(
          `  - ${profile.id}${disabled}: ${recommendation.signals.join(", ")} -> ${profile.command}\n`,
        );
      }
      if (result.missingProfiles.length > 0) {
        process.stdout.write(`missing/disabled profiles: ${result.missingProfiles.join(", ")}\n`);
      }
    },
  );

verify
  .command("run")
  .description("run an allow-listed verification profile")
  .requiredOption("--profile <id>", "profile id")
  .option("--dry-run", "print runnable command without executing")
  .option("--allow-external", "allow disabled-by-default external profile execution after review")
  .option("--json", "JSON output")
  .option("--save-evidence", SAVE_EVIDENCE_OPTION_DESCRIPTION)
  .action(
    (opts: {
      profile: string;
      dryRun?: boolean;
      allowExternal?: boolean;
      json?: boolean;
      saveEvidence?: boolean;
    }) => {
      const deps = nodeVerificationProbeDeps(process.cwd());
      const result = runVerificationProfile(
        opts.profile,
        { dryRun: Boolean(opts.dryRun), allowExternal: Boolean(opts.allowExternal) },
        deps,
      );
      if (!result) {
        process.stderr.write(`unknown profile: ${opts.profile}\n`);
        process.exitCode = 1;
        return;
      }
      if (opts.saveEvidence) {
        saveVerificationEvidence({ kind: "verify-run", id: opts.profile, payload: result }, deps);
      }
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        process.stdout.write(
          `verify run ${result.profile.id}: ${result.status} command="${result.command}"\n`,
        );
        for (const message of result.messages) process.stdout.write(`  - ${message}\n`);
      }
      process.exitCode = result.status === "passed" || result.status === "dry-run" ? 0 : 1;
    },
  );

// PLAN-L7-32 §9 discharge: cross-artifact relation graph CLI (ADR-002 A-124 surface)。
// 純関数 (collect/analyze/export) は src/lint/relation-graph.ts、repo→source set loader は
// src/graph/loader.ts。doc/source graph に集中し db-table node は projection-writer 経由で別供給。
const graph = program
  .command("graph")
  .description("cross-artifact relation graph (impact analysis / diagram export)");
graph
  .command("impact")
  .description("compute impact of changed files across the cross-artifact relation graph")
  .option("--changed <path...>", "changed path(s); defaults to git status --porcelain")
  .action((opts: { changed?: string[] }) => {
    const repoRoot = process.cwd();
    const changedFiles =
      opts.changed && opts.changed.length > 0 ? opts.changed : loadChangedFiles();
    const projection = collectRelationGraphProjection(loadRelationGraphSourceSet(repoRoot));
    const result = analyzeRelationImpact({ changedPaths: changedFiles, projection });
    process.stdout.write(
      `graph impact: changed=${result.changedNodes.length}, impacted=${result.impacted.length}, actions=${result.actions.length}\n`,
    );
    for (const n of result.changedNodes) process.stdout.write(`  changed: ${n.id}\n`);
    for (const n of result.impacted) process.stdout.write(`  impacted: ${n.id}\n`);
    for (const a of result.actions) {
      process.stdout.write(`  action: ${a.kind} -> ${a.nodeId} (${a.reason})\n`);
    }
    for (const f of result.findings) {
      process.stdout.write(`  [${f.severity}] ${f.code}: ${f.message}\n`);
    }
    process.exitCode = result.ok ? 0 : 1;
  });
graph
  .command("export")
  .description("export the relation graph as a diagram (mermaid|dot)")
  .option("--format <format>", "mermaid | dot", "mermaid")
  .option("--scope <scope>", "scope label (full export; per-scope filtering is a follow-up)")
  .action((opts: { format?: string; scope?: string }) => {
    const repoRoot = process.cwd();
    const projection = collectRelationGraphProjection(loadRelationGraphSourceSet(repoRoot));
    const format = opts.format === "dot" ? "dot" : "mermaid";
    // dot は renderDot が純粋に DOT テキストを生成する (外部 graphviz は SVG 化の後段でのみ要る)
    // ため CLI からは常に emit 可能。adapter を available 宣言して text 出力を有効化する。
    const availableAdapters: RelationDiagramAdapter[] = format === "dot" ? ["dot"] : [];
    const artifact = exportRelationDiagram({ snapshot: projection, format, availableAdapters });
    if (opts.scope) {
      process.stdout.write(
        `# scope=${opts.scope} (full export; per-scope filtering is a follow-up)\n`,
      );
    }
    if (!artifact.ok) {
      for (const f of artifact.findings) {
        process.stderr.write(`[${f.severity}] ${f.code}: ${f.message}\n`);
      }
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${artifact.content}\n`);
  });

const trace = program.command("trace").description("ID-based typed spec trace traversal");
trace
  .command("impact")
  .description("compute upstream/downstream/test impact from a spec id")
  .requiredOption("--id <id>", "spec id to traverse, for example VMS-004")
  .option("--json", "JSON output")
  .action((opts: { id: string; json?: boolean }) => {
    const repoRoot = process.cwd();
    const db = openHarnessDb(defaultHarnessDbPath(repoRoot), { repoRoot });
    try {
      migrate(db);
      const result = analyzeTraceImpact(db, opts.id);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else if (result.ok) {
        process.stdout.write(`trace impact: ${result.root?.spec_id} (${result.root?.spec_kind})\n`);
        for (const node of result.upstream) process.stdout.write(`  upstream: ${node.spec_id}\n`);
        for (const node of result.downstream) {
          process.stdout.write(`  downstream: ${node.spec_id}\n`);
        }
        for (const node of result.tests) process.stdout.write(`  test: ${node.spec_id}\n`);
      } else {
        for (const finding of result.findings) {
          process.stderr.write(`[${finding.severity}] ${finding.code}: ${finding.message}\n`);
        }
      }
      process.exitCode = result.ok ? 0 : 1;
    } finally {
      db.close();
    }
  });
trace
  .command("rag")
  .description("list typed spec closure RAG ledger entries")
  .option("--id <id>", "filter by spec id")
  .option("--json", "JSON output")
  .action((opts: { id?: string; json?: boolean }) => {
    type TraceRagRow = {
      spec_id: string;
      spec_kind: string;
      layer: string;
      sub_doc: string;
      rag: string;
      closure_status: string;
      requires_test: number;
      upstream_count: number;
      downstream_count: number;
      test_count: number;
      finding_count: number;
      impact_summary: string;
      source_path: string;
      indexed_at: string;
    };
    const repoRoot = process.cwd();
    const db = openHarnessDb(defaultHarnessDbPath(repoRoot), { repoRoot });
    try {
      migrate(db);
      const rows = opts.id
        ? db
            .prepare(
              "SELECT spec_id, spec_kind, layer, sub_doc, rag, closure_status, requires_test, upstream_count, downstream_count, test_count, finding_count, impact_summary, source_path, indexed_at FROM spec_rag_closure_entries WHERE spec_id = ? ORDER BY spec_id",
            )
            .all(opts.id)
        : db
            .prepare(
              "SELECT spec_id, spec_kind, layer, sub_doc, rag, closure_status, requires_test, upstream_count, downstream_count, test_count, finding_count, impact_summary, source_path, indexed_at FROM spec_rag_closure_entries ORDER BY CASE rag WHEN 'red' THEN 0 WHEN 'yellow' THEN 1 ELSE 2 END, spec_id",
            )
            .all();
      const typedRows = rows as TraceRagRow[];
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(typedRows, null, 2)}\n`);
        return;
      }
      if (typedRows.length === 0) {
        process.stdout.write("trace rag: no rows (run `ut-tdd db rebuild` first)\n");
        process.exitCode = opts.id ? 1 : 0;
        return;
      }
      for (const row of typedRows) {
        process.stdout.write(
          `${row.rag} ${row.spec_id} ${row.closure_status} tests=${row.test_count} findings=${row.finding_count} ${row.impact_summary}\n`,
        );
      }
    } finally {
      db.close();
    }
  });

const session = program.command("session").description("session-log runtime events");
session
  .command("start")
  .description("record SessionStart through the shared session-log core")
  .option("--session <id>", SESSION_OPTION_DESCRIPTION)
  .action((opts: { session?: string }) => {
    const input = readHookInput(HOOK_EVENT_SESSION_START, opts.session);
    const repoRoot = requireRuntimeRepoRoot();
    const deps = nodeDeps(repoRoot, gitBranch, gitHead);
    runSessionStartSideEffects({ repoRoot, input, deps });
    dispatch(input, deps, HOOK_EVENT_SESSION_START);
    process.stdout.write(`session-log: start ${input.session_id ?? "ut-tdd-cli"}\n`);
  });

session
  .command("summary")
  .description("compress session events into PLAN digest and surface handover discipline warnings")
  .option("--session <id>", SESSION_OPTION_DESCRIPTION)
  .action((opts: { session?: string }) => {
    const input = readHookInput("Stop", opts.session);
    const repoRoot = requireRuntimeRepoRoot();
    dispatch(input, nodeDeps(repoRoot, gitBranch, gitHead), "Stop");
    writeHandoverWarnings();
    // PLAN-L7-365 Step 2 (issue #78): Stop 境界で on-disk harness.db を自動追従。
    // Stop hook の timeout 予算 (5s) を消費しないよう detached で fire-and-forget 起動し、
    // fail-open — 起動失敗は警告のみで session 終了 (exit 0) を妨げない。
    const refresh = spawnDetachedStopRefresh({ repoRoot });
    if (!refresh.launched && !refresh.coalesced) {
      process.stderr.write(`session-log: db refresh not launched (${refresh.reason})\n`);
    }
    process.stdout.write(`session-log: summary ${input.session_id ?? "ut-tdd-cli"}\n`);
  });

session
  .command("db-refresh")
  .description(
    "Stop 境界の on-disk harness.db refresh (session summary から detached 起動される内部エントリ)",
  )
  .requiredOption("--generation <id>", "Stop refresh lease generation")
  .action((opts: { generation: string }) => {
    const repoRoot = requireRuntimeRepoRoot();
    if (
      refuseBunStopRefresh({
        repoRoot,
        generation: opts.generation,
        execPath: process.execPath,
        runtimeBunVersion: (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun,
      })
    ) {
      process.stderr.write("session-log: db refresh skipped (bun-runtime-refused)\n");
      return;
    }
    const result = runCoalescedStopRefresh({
      repoRoot,
      generation: opts.generation,
    });
    const r = result.runs.at(-1);
    if (!result.owned || !r) {
      process.stderr.write("session-log: db refresh skipped (stale-generation)\n");
      return;
    }
    if (!r.ok) {
      process.stderr.write(`session-log: db refresh skipped (${r.skippedReason})\n`);
    }
    if (r.vacuum?.warning) {
      process.stderr.write(`session-log: db vacuum skipped (${r.vacuum.warning})\n`);
    }
    process.stdout.write(
      `session-log: db refresh ${r.ok ? "ok" : "skipped"} (rebuilt=${r.rebuilt}, tokenRuns=${r.tokenRunsIngested}, vacuumRan=${r.vacuum?.ran ?? false})\n`,
    );
  });

const hook = program.command("hook").description("package-local hook entrypoints");
hook
  .command("claude-memory-wake")
  .description("wait for a HARNESS memory notification and rewake an idle Claude session")
  .action(async () => {
    if (!isClaudeMemoryWakeTarget(process.env)) return;
    const input = readHookInput("Stop");
    const repoRoot = requireRuntimeRepoRoot({ allowCwdFallback: true });
    const result = await waitForClaudeMemory({
      repoRoot,
      sessionId: input.session_id ?? "ut-tdd-cli",
      pollIntervalMs: resolveClaudeWakeDelay(process.env.UT_TDD_CLAUDE_WAKE_POLL_MS, 2_000),
      maxWaitMs: resolveClaudeWakeDelay(process.env.UT_TDD_CLAUDE_WAKE_MAX_MS, 900_000),
      pullRequestState: (pr) => observeClaudeInboxPullRequest(repoRoot, pr),
    });
    if (result.kind === "delivered" && result.message) {
      process.stderr.write(`${result.message}\n`);
      process.exitCode = 2;
    } else if (result.kind === "denied") {
      process.stderr.write(`claude-memory-wake: denied (${result.reason})\n`);
    }
  });

hook
  .command("post-tool-use")
  .description("record PostToolUse through the shared session-log core")
  .option("--session <id>", SESSION_OPTION_DESCRIPTION)
  .option("--tool <name>", "tool_name override")
  .option("--path <path>", "file_path/path target hint")
  .option("--command <command>", "Bash command target hint")
  .option("--outcome <outcome>", "tool outcome: ok or error")
  .action(
    (opts: {
      session?: string;
      tool?: string;
      path?: string;
      command?: string;
      outcome?: "ok" | "error";
    }) => {
      const input = readHookInput("PostToolUse", opts.session);
      const toolInput: Record<string, unknown> = {
        ...(input.tool_input ?? {}),
        ...(opts.path ? { file_path: opts.path } : {}),
        ...(opts.command ? { command: opts.command } : {}),
      };
      const repoRoot = requireRuntimeRepoRoot({ allowCwdFallback: true });
      const postInput = {
        ...input,
        hook_event_name: "PostToolUse",
        tool_name: opts.tool ?? input.tool_name ?? (opts.command ? "Bash" : "manual"),
        tool_input: toolInput,
        tool_response: opts.outcome
          ? {
              ...(typeof input.tool_response === "object" ? input.tool_response : {}),
              outcome: opts.outcome,
            }
          : input.tool_response,
      };
      dispatch(postInput, nodeDeps(repoRoot, gitBranch, gitHead), "PostToolUse");
      const encodingGuard = runWriteEncodingGuard(postInput, {
        repoRoot,
        changedFiles: () => loadChangedFiles(repoRoot),
      });
      process.stdout.write(`session-log: post-tool-use ${input.session_id ?? "ut-tdd-cli"}\n`);
      for (const message of encodingGuard.messages) {
        process.stderr.write(`${message}\n`);
      }
    },
  );

hook
  .command("agent-guard")
  .description(
    "PreToolUse(Agent|Task): enforce subagent allowlist and declared model family; exits: 0=pass, 1=error, 2=blocked",
  )
  .action(() => {
    const repoRoot = requireRuntimeRepoRoot();
    const input = parseHookInput<AgentGuardInput>(readStdin());
    if (!input) {
      process.stderr.write("[ut-tdd-guard] BLOCK: malformed hook JSON (fail-close)\n");
      process.exitCode = 2;
      return;
    }
    const decision = evaluateAgentGuard(input, {
      resolveAgentFamily: (subagentType) => resolveAgentFamilyFromRepo(repoRoot, subagentType),
      allowRaw: process.env.UT_TDD_ALLOW_RAW_AGENT === "1",
    });
    if (decision.message) process.stderr.write(`${decision.message}\n`);
    if (decision.code === 0 && input.tool_input?.subagent_type) {
      try {
        recordGuardFire(
          { agentKind: input.tool_input.subagent_type },
          nodeAgentSlotsDeps(repoRoot),
        );
      } catch {
        // Slot telemetry is advisory; guard enforcement already passed.
      }
    }
    process.exitCode = decision.code;
  });

hook
  .command("work-guard")
  .description(
    "PreToolUse(Edit|Write|MultiEdit/apply_patch|write_file): block foreign edits; exits: 0=pass, 1=error, 2=blocked",
  )
  .action(() => {
    const repoRoot = requireRuntimeRepoRoot();
    const input = parseHookInput<{ tool_input?: unknown; session_id?: string }>(readStdin());
    if (!input) {
      // Work guard remains fail-open on malformed hook I/O, matching the repo-local shim.
      process.exitCode = 0;
      return;
    }
    const override = resolveForeignEditOverride({
      env: process.env.UT_TDD_ALLOW_FOREIGN_EDIT,
    });
    const result = evaluateWorkGuardTargets({
      targetPaths: hookTargetPaths(input, repoRoot),
      uncommittedFiles: loadChangedFiles(repoRoot),
      sessionTouchedFiles: sessionTouchedFilesForGuard(repoRoot, input.session_id),
      bypass: override.bypass,
    });
    if (result.blocked) process.stderr.write(`${result.blocked.message}\n`);
    process.exitCode = result.decision === "block" ? 2 : 0;
  });

hook
  .command("subagent-stop")
  .description(
    "SubagentStop: agent_guard slot を 1 件 (最古) release し active 数を実時間で正確化 (fail-open)",
  )
  .action(() => {
    // SubagentStop payload (session_id/transcript_path/stop_hook_active) は終了 subagent の
    // slot_id を含まず slot 個体相関に使えないため読まない (設計根拠 = agent-slots.md §2.4)。
    const released = releaseOldestGuardSlot(nodeAgentSlotsDeps(requireRuntimeRepoRoot()));
    process.stdout.write(
      released
        ? `agent-slots: released ${released.slot_id} (${released.agent_kind})\n`
        : "agent-slots: no running guard slot to release\n",
    );
  });

const guard = program.command("guard").description("manual guard checks for non-hooked runtimes");
guard
  .command("preflight")
  .description(
    "run work-guard before hosted/API edits that cannot execute repo-local Codex hooks; exits: 0=pass, 1=error, 2=blocked",
  )
  .option("--target <path...>", "repo-relative or absolute target path(s) to edit")
  .option("--patch-file <path>", "patch file to scan for apply_patch headers")
  .option("--stdin", "read an apply_patch body from stdin")
  .option("--session <id>", "session_id used to load already-touched files")
  .option("--json", "JSON output")
  .option("--allow-foreign-edit", "intentional bypass; equivalent to an explicit guard override")
  .action(
    (opts: {
      target?: string[];
      patchFile?: string;
      stdin?: boolean;
      session?: string;
      json?: boolean;
      allowForeignEdit?: boolean;
    }) => {
      const repoRoot = process.cwd();
      const targetPaths = (opts.target ?? []).map((target) =>
        normalizeRepoRelative(target, repoRoot),
      );
      if (opts.patchFile) {
        targetPaths.push(
          ...guardTargetsFromPatchText(readFileSync(opts.patchFile, "utf8"), repoRoot),
        );
      }
      if (opts.stdin) {
        targetPaths.push(...guardTargetsFromPatchText(readStdin(), repoRoot));
      }
      const override = resolveForeignEditOverride({
        env: opts.allowForeignEdit ? "1" : process.env.UT_TDD_ALLOW_FOREIGN_EDIT,
      });
      const result = evaluateWorkGuardTargets({
        targetPaths,
        uncommittedFiles: loadChangedFiles(repoRoot),
        sessionTouchedFiles: sessionTouchedFilesForGuard(repoRoot, opts.session),
        bypass: override.bypass,
      });
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              ...result,
              override,
              apiToolPathEnforced: false,
              note: "hosted/API tools do not execute .codex/hooks.json; guard preflight is the repo-side substitute",
            },
            null,
            2,
          )}\n`,
        );
      } else if (result.blocked) {
        process.stderr.write(`${result.blocked.message}\n`);
      } else {
        process.stdout.write(
          `guard preflight: pass (${result.reason}, targets=${result.results.length})\n`,
        );
      }
      process.exitCode = result.decision === "block" ? 2 : 0;
    },
  );

const plan = program.command("plan").description("PLAN 操作");
registerPlanAssetCommands(plan);
registerPlanAdmissionCommands(plan);
registerPlanDraftCommand(plan, { runner: createNodePlanDraftRunner(process.cwd()) });
registerPlanRevisionCommand(plan, { runner: createNodePlanRevisionRunner(process.cwd()) });
plan
  .command("lint [path]")
  .description("PLAN lint")
  .option(
    "--gate <id>",
    "run a named PLAN gate lint (schedule, governance/frontmatter, G1-trace, G3-trace)",
  )
  .action((path?: string, opts?: { gate?: string }) => {
    const r = lintPlanWithGate(path, process.cwd(), opts?.gate);
    for (const m of r.messages) process.stdout.write(`${m}\n`);
    process.exitCode = r.ok ? 0 : 1;
  });

plan
  .command("digest-migrate")
  .description(
    "green_command digest を記録時点 commit へ anchor 化する計画 (PLAN-L7-303、dry-run 既定)。" +
      "履歴から claimed digest 一致 commit を特定し recoverable/suspect に分類する。",
  )
  .option("--json", "JSON 出力")
  .option(
    "--execute",
    "recoverable entry に anchor_commit を追記する (既存 output_digest は変更しない)",
  )
  .action((opts: { json?: boolean; execute?: boolean }) => {
    const repoRoot = process.cwd();
    const plans = loadReviewPlans(repoRoot);
    const candidates = planDigestMigration(plans, nodeHistoryScanDeps(repoRoot));
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(candidates, null, 2)}\n`);
      return;
    }
    const counts = { recoverable: 0, suspect: 0, "already-anchored": 0 } as Record<string, number>;
    for (const c of candidates) counts[c.disposition] = (counts[c.disposition] ?? 0) + 1;
    if (opts.execute) {
      const byFile = new Map<string, typeof candidates>();
      for (const c of candidates.filter((x) => x.disposition === "recoverable")) {
        byFile.set(c.file, [...(byFile.get(c.file) ?? []), c]);
      }
      let touchedFiles = 0;
      let applied = 0;
      let skippedAlreadyAnchored = 0;
      for (const [file, fileCandidates] of byFile) {
        const path = join(repoRoot, "docs", "plans", file);
        const before = readFileSync(path, "utf8");
        const result = applyDigestAnchorCandidatesToContent(before, fileCandidates);
        applied += result.applied;
        skippedAlreadyAnchored += result.skippedAlreadyAnchored;
        if (result.content !== before) {
          writeFileSync(path, result.content, "utf8");
          touchedFiles += 1;
        }
      }
      process.stdout.write(
        `plan digest-migrate --execute — applied=${applied} files=${touchedFiles} ` +
          `skipped_already_anchored=${skippedAlreadyAnchored} suspect=${counts.suspect}\n`,
      );
      process.stdout.write(
        "既存 output_digest は変更していない。suspect は履歴に claimed 一致 blob が無いため未更新。\n",
      );
      return;
    }
    process.stdout.write(
      `plan digest-migrate (dry-run) — ${candidates.length} green_command: ` +
        `recoverable=${counts.recoverable} suspect=${counts.suspect} already-anchored=${counts["already-anchored"]}\n`,
    );
    for (const c of candidates.filter((x) => x.disposition !== "already-anchored")) {
      const anchor = c.anchor_candidate
        ? `anchor=${c.anchor_candidate.slice(0, 12)}`
        : "anchor=none";
      process.stdout.write(`  [${c.disposition}] ${c.plan_id} ${c.evidence_path} ${anchor}\n`);
    }
    process.stdout.write(
      "\nsuspect = どの commit にも claimed 一致 blob 無し (捏造/回復不能疑い、A-18x 台帳化)。" +
        "\n書き込みは --execute で recoverable に anchor_commit のみ追記する。\n",
    );
  });

plan
  .command("use [id]")
  .description(
    "active PLAN を .ut-tdd/state/current-plan に記録 (session-log digest を活性化)。--clear で解除",
  )
  .option("--clear", "current-plan を clear")
  .action((id: string | undefined, opts: { clear?: boolean }) => {
    if (!opts.clear && !id) {
      process.stderr.write("plan use <id> または --clear を指定してください\n");
      process.exitCode = 1;
      return;
    }
    setActivePlanCli(process.cwd(), opts.clear ? null : (id as string), gitBranch);
    process.stdout.write(opts.clear ? "current-plan: cleared\n" : `current-plan: ${id}\n`);
  });

plan
  .command("complete [id]")
  .description("active PLAN を completed handover として記録し、current-plan を clear")
  .option("--dry-run", "handover を生成するが書き込まない")
  .option("--scope-active", "active plan family の digest のみで handover を生成")
  .action((id: string | undefined, opts: { dryRun?: boolean; scopeActive?: boolean }) => {
    const date = new Date().toISOString().slice(0, 10);
    const deps = nodeHandoverDeps(process.cwd());
    const r = runHandover(
      {
        date,
        dryRun: Boolean(opts.dryRun),
        complete: true,
        scopeToActive: Boolean(opts.scopeActive),
        ...(id ? { planId: id } : {}),
      },
      deps,
    );
    process.stdout.write(
      `plan complete: active=${r.pointer.active_plan ?? "-"} status=${r.pointer.status}${opts.dryRun ? " (dry-run)" : ""}\n`,
    );
    for (const w of r.written) process.stdout.write(`  + ${w}\n`);
  });

const handover = program
  .command("handover")
  .description(
    "session-log PLAN digest から handover を生成 (機械ポインタ CURRENT.json + 人間判断 markdown scaffold、要件 §6.8.5)",
  )
  .option("--dry-run", "書き込まず内容のみ表示")
  .option("--complete", "status=completed として記録 (PLAN 完了時)")
  .option("--plan <id>", "明示 active PLAN (省略時 current-plan/branch から解決)")
  .option("--scope-active", "§1-§2 を active plan family の digest のみへ絞る (IMP-048 ノイズ低減)")
  .option(
    "--scope-session",
    "§1-§2 を直近 session が触れた digest のみへ絞る (IMP-078 gap④ 前 session 混入排除)",
  )
  .option(
    "--session <id>",
    "session scope に使う session_id を明示 (省略時 --scope-session で直近を推定)",
  )
  .action(
    (opts: {
      dryRun?: boolean;
      complete?: boolean;
      plan?: string;
      scopeActive?: boolean;
      scopeSession?: boolean;
      session?: string;
    }) => {
      const date = new Date().toISOString().slice(0, 10);
      const deps = nodeHandoverDeps(process.cwd());
      // IMP-078 gap④: --session 明示 > --scope-session 推定 (latestSessionId) > なし。
      const sessionId =
        opts.session ?? (opts.scopeSession ? (latestSessionId(deps) ?? undefined) : undefined);
      const r = runHandover(
        {
          date,
          dryRun: Boolean(opts.dryRun),
          complete: Boolean(opts.complete),
          scopeToActive: Boolean(opts.scopeActive),
          ...(sessionId ? { sessionId } : {}),
          ...(opts.plan ? { planId: opts.plan } : {}),
        },
        deps,
      );
      process.stdout.write(
        `handover: active=${r.pointer.active_plan ?? "-"} status=${r.pointer.status}${opts.dryRun ? " (dry-run)" : ""}\n`,
      );
      for (const w of r.written) process.stdout.write(`  + ${w}\n`);
      if (opts.dryRun) process.stdout.write(`\n--- scaffold ---\n${r.content}\n`);
    },
  );

const providerHandover = handover.command("provider").description("Claude/Codex provider handover");
providerHandover
  .command("export")
  .description("write provider handover package under .ut-tdd/handover/provider")
  .requiredOption("--from <runtime>", "claude or codex")
  .requiredOption("--to <runtime>", "claude or codex")
  .requiredOption("--summary <text>", "handover context summary")
  .option("--plan <id>", "active PLAN (defaults to current-plan/branch resolution)")
  .option("--budget <text>", "budget or constraint summary")
  .option("--next-action <text...>", "next actions")
  .option("--file <path...>", "relevant files")
  .option("--dry-run", "do not write files")
  .action(
    (
      opts: {
        from: ProviderRuntime;
        to: ProviderRuntime;
        summary: string;
        plan?: string;
        budget?: string;
        nextAction?: string[];
        file?: string[];
        dryRun?: boolean;
      },
      cmd: Command,
    ) => {
      const localOpts = cmd.opts() as typeof opts;
      const chainPlan = optionFromCommandChain<string>(cmd, "plan");
      const chainBudget = optionFromCommandChain<string>(cmd, "budget");
      const chainNextAction = optionFromCommandChain<string[]>(cmd, "nextAction");
      const chainFile = optionFromCommandChain<string[]>(cmd, "file");
      const chainDryRun = optionFromCommandChain<boolean>(cmd, "dryRun");
      const planId =
        localOpts.plan ??
        opts.plan ??
        chainPlan ??
        resolveActivePlan(nodeDeps(process.cwd(), gitBranch));
      if (!planId) {
        process.stderr.write("provider handover requires --plan or active current-plan\n");
        process.exitCode = 1;
        return;
      }
      try {
        const result = runProviderHandover(
          {
            from: opts.from,
            to: opts.to,
            activePlan: planId,
            budget: localOpts.budget ?? opts.budget ?? chainBudget ?? null,
            summary: opts.summary,
            nextActions: localOpts.nextAction ?? opts.nextAction ?? chainNextAction ?? [],
            files: localOpts.file ?? opts.file ?? chainFile ?? [],
            dryRun: Boolean(localOpts.dryRun ?? opts.dryRun ?? chainDryRun),
          },
          nodeProviderHandoverDeps(process.cwd()),
        );
        process.stdout.write(`${JSON.stringify(result.package, null, 2)}\n`);
        for (const w of result.written) process.stdout.write(`  + ${w}\n`);
      } catch (e) {
        process.stderr.write(`${String(e)}\n`);
        process.exitCode = 1;
      }
    },
  );

providerHandover
  .command("status")
  .description("show latest provider handover package")
  .option("--json", "JSON output")
  .action((opts: { json?: boolean }) => {
    const current = readProviderHandoverCurrent(nodeProviderHandoverDeps(process.cwd()));
    if (!current) {
      process.stderr.write("provider handover: CURRENT.json not found\n");
      process.exitCode = 1;
      return;
    }
    if (opts.json) process.stdout.write(`${JSON.stringify(current, null, 2)}\n`);
    else {
      process.stdout.write(
        `provider handover: ${current.handover_id} ${current.from}->${current.to} plan=${current.active_plan}\n`,
      );
    }
  });

const db = program
  .command("db")
  .description("harness.db projection state (PLAN-L7-44 工程表、span ① foundation)");
db.command("status")
  .description(
    "harness.db の schema version / table / 行数 / orphan を報告 (read-only、新規作成しない)",
  )
  .option("--json", "JSON output")
  .action((opts: { json?: boolean }) => {
    const s = harnessDbStatus(process.cwd());
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(s, null, 2)}\n`);
      return;
    }
    if (!s.initialized) {
      process.stdout.write(
        `db status: not initialized (${s.path})\n  → 'ut-tdd db rebuild' で schema を作成\n`,
      );
      return;
    }
    const stale = s.schemaVersion !== s.expectedVersion ? ` (expected ${s.expectedVersion})` : "";
    process.stdout.write(
      `db status: schema v${s.schemaVersion}${stale}, tables ${s.tableCount}, rows ${s.totalRows}, orphan trace_edges ${s.orphanTraceEdges}\n`,
    );
    if (s.missingTables.length > 0) {
      process.stdout.write(`  ⚠ missing tables: ${s.missingTables.join(", ")}\n`);
    }
  });
db.command("rebuild")
  .description("harness.db schema と deterministic projection を再構築")
  .option("--json", "JSON output")
  .action((opts: { json?: boolean }) => {
    // Memory projection must come from the canonical project root: a linked worktree cwd
    // would otherwise project its own legacy .ut-tdd/memory (PLAN-L7-566 PR-2, P-MEMCUT-006).
    // The process.cwd() fallback below exists for the nested-snapshot-clone case (a real `git
    // clone` of a snapshot tree, U-TESTHYGIENE-043) where the clone has git topology (it is a
    // clone, so `git rev-parse` resolves) but no usable project identity of its own. Measured on
    // Windows CI (run 35216823766): that case yields reason "project_identity_unavailable", not
    // "git_topology_unavailable" — a nested clone is a git repo, so git-dir/git-common-dir both
    // resolve fine, only `loadProjectIdentityFromHead` comes back empty. A linked worktree always
    // has a git-dir distinct from its git-common-dir (`isLinkedWorktreeCheckout`), so gating the
    // fallback on "not a linked worktree" keeps the P-MEMCUT-006 negatives fail-closed: a linked
    // worktree with an unresolvable or drifted identity must never fall back to `process.cwd()`
    // and silently project its own legacy memory. "project_identity_drift" (a resolvable but
    // *disagreeing* identity) stays fail-closed unconditionally in both topologies — drift is
    // never the nested-snapshot case, it always means two distinct, resolvable identities.
    const projectRoot = resolveProjectMemoryRoot(process.cwd());
    let dbRebuildRepoRoot: string;
    if (projectRoot.ok) {
      dbRebuildRepoRoot = projectRoot.canonicalProjectRoot;
    } else if (
      (projectRoot.reason === "git_topology_unavailable" ||
        projectRoot.reason === "project_identity_unavailable") &&
      !isLinkedWorktreeCheckout(process.cwd())
    ) {
      dbRebuildRepoRoot = process.cwd();
    } else {
      process.stderr.write(
        `ut-tdd db rebuild: refusing to project memory (project_memory_root reason=` +
          `${projectRoot.reason}); a linked worktree or a repo with drifted/unavailable project ` +
          "identity must not project legacy memory into harness.db (PLAN-L7-566 P-MEMCUT-006)\n",
      );
      process.exitCode = 1;
      return;
    }
    const r = rebuildHarnessDb({ repoRoot: dbRebuildRepoRoot });
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      return;
    }
    const totalRows = Object.values(r.rowCounts).reduce((sum, n) => sum + n, 0);
    process.stdout.write(
      `db rebuild: projection ${r.ok ? "ok" : "failed"}, rows ${totalRows} (${r.path})\n`,
    );
    process.stdout.write(
      "  note: plans / roadmap rollups / review evidence / optional Phase3 outputs を projection\n",
    );
    if (r.tokenIngest) {
      const t = r.tokenIngest;
      process.stdout.write(
        `  token telemetry (repo-scoped, issue #82): claude files matched ${t.claudeFilesScanned}/${t.claudeFilesChecked} ` +
          `(project dir resolved=${t.claudeProjectDirResolved}, foreign repo ${t.claudeFilesForeignRepo}, unknown cwd ${t.claudeFilesSkippedUnknownCwd}), ` +
          `codex files matched ${t.codexFilesMatched}/${t.codexFilesChecked} ` +
          `(foreign repo ${t.codexFilesForeignRepo}, unknown cwd ${t.codexFilesSkippedUnknownCwd})\n`,
      );
    }
  });
db.command("scope-preview")
  .description("preview document/activation detection scope from harness.db profiles")
  .requiredOption("--profile <profile>", "document scale profile id (poc|standard|enterprise)")
  .option("--activation-profile <profile>", "optional activation profile id")
  .option("--capability <flag...>", "capability flag(s) that resolve conditional documents")
  .option("--json", "JSON output")
  .action(
    (opts: {
      profile: string;
      activationProfile?: string;
      capability?: string[];
      json?: boolean;
    }) => {
      const repoRoot = process.cwd();
      const db = openHarnessDb(defaultHarnessDbPath(repoRoot), { repoRoot });
      try {
        const result = buildScopeDryRunPreview(db, {
          profileId: opts.profile,
          activationProfileId: opts.activationProfile,
          capabilityFlags: opts.capability,
        });
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          process.stdout.write(
            `scope-preview: profile=${result.profile_id} docs=${result.summary.documents_total} ` +
              `in_scope=${result.summary.documents_in_scope} conditional=${result.summary.documents_conditional} ` +
              `deferred=${result.summary.documents_deferred} skipped=${result.summary.documents_skipped}\n`,
          );
          process.stdout.write(`  gates=${result.gates.join(",") || "-"}\n`);
          process.stdout.write(`  detectors=${result.detectors.join(",")}\n`);
          for (const row of result.documents) {
            process.stdout.write(
              `  ${row.resolved_scope_status} ${row.doc_type_id} ${row.detail_override}/${row.status_override} gate=${row.gate_id} action=${row.required_action}\n`,
            );
          }
          for (const finding of result.findings) {
            process.stdout.write(`  ${finding.severity} ${finding.kind}: ${finding.message}\n`);
          }
        }
        if (!result.ok) process.exitCode = 1;
      } finally {
        db.close();
      }
    },
  );

const progress = program.command("progress").description("artifact progress read model");
progress
  .command("artifacts")
  .description("list DB-backed artifact progress colors")
  .option("--json", "JSON output")
  .option("--color <color>", "filter by color: red, yellow, or green")
  .action((opts: { json?: boolean; color?: string }) => {
    const db = openHarnessDb(defaultHarnessDbPath(process.cwd()), { repoRoot: process.cwd() });
    try {
      migrate(db);
      const color = opts.color?.trim().toLowerCase();
      const rows =
        color != null && color.length > 0
          ? db
              .prepare(
                "SELECT artifact_path, artifact_type, state, color, linked_test_count, passed_test_run_count, dependency_checked, dependency_check_run_id, open_dependency_impacts, linked_test_paths, passed_test_run_ids, recovery_plan_ids, reason, indexed_at FROM artifact_progress WHERE color = ? ORDER BY artifact_path",
              )
              .all(color)
          : db
              .prepare(
                "SELECT artifact_path, artifact_type, state, color, linked_test_count, passed_test_run_count, dependency_checked, dependency_check_run_id, open_dependency_impacts, linked_test_paths, passed_test_run_ids, recovery_plan_ids, reason, indexed_at FROM artifact_progress ORDER BY CASE color WHEN 'red' THEN 0 WHEN 'yellow' THEN 1 ELSE 2 END, artifact_path",
              )
              .all();
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
        return;
      }
      if (rows.length === 0) {
        process.stdout.write("artifact progress: no rows (run `ut-tdd db rebuild` first)\n");
        return;
      }
      for (const row of rows as Array<Record<string, unknown>>) {
        process.stdout.write(
          `${row.color} ${row.artifact_path} ${row.state} tests=${row.linked_test_count} passed_runs=${row.passed_test_run_count} deps=${row.dependency_checked} check=${row.dependency_check_run_id} impacts=${row.open_dependency_impacts} recovery=${row.recovery_plan_ids} - ${row.reason}\n`,
        );
      }
    } finally {
      db.close();
    }
  });

program
  .command("find <query>")
  .description("search harness.db reference index")
  .option("--json", "JSON output")
  .action((query: string, opts: { json?: boolean }) => {
    const dbPath = defaultHarnessDbPath(process.cwd());
    const db = openHarnessDb(dbPath, { repoRoot: process.cwd() });
    try {
      const rows = findReference(db, query);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
        return;
      }
      for (const row of rows) {
        process.stdout.write(
          `${row.subject_type} ${row.subject_id} ${row.path} (${row.reason}, score=${row.score})\n`,
        );
      }
    } finally {
      db.close();
    }
  });

const metrics = program.command("metrics").description("harness.db quality metrics");
metrics
  .command("skill")
  .description("compute skill firing and acceptance metrics")
  .option("--json", "JSON output")
  .action((opts: { json?: boolean }) => {
    const db = openHarnessDb(defaultHarnessDbPath(process.cwd()), { repoRoot: process.cwd() });
    try {
      const rows = computeSkillMetrics(db);
      if (opts.json) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      else {
        for (const row of rows) {
          process.stdout.write(
            `${row.plan_id} ${row.skill_id}: firing=${row.firing_rate} acceptance=${row.acceptance_rate}\n`,
          );
        }
      }
    } finally {
      db.close();
    }
  });

const telemetry = program
  .command("telemetry")
  .description("cross-runtime token/cost telemetry (FR-L1-38、PLAN-L7-57/58)");
telemetry
  .command("scan")
  .description(
    "両 runtime の session JSONL を走査し token/cost を harness.db (model_runs) へ ingest (CLI 非起動)",
  )
  .option(
    "--claude-dir <dir>",
    "Claude transcript dir (default: $UT_TDD_CLAUDE_SESSIONS_DIR or ~/.claude/projects)",
  )
  .option(
    "--codex-dir <dir>",
    "Codex session dir (default: $UT_TDD_CODEX_SESSIONS_DIR or ~/.codex/sessions)",
  )
  .option("--json", "JSON output")
  .action((opts: { claudeDir?: string; codexDir?: string; json?: boolean }) => {
    const repoRoot = process.cwd();
    // env-specific session-dir 解決: 明示 option > 環境変数 > OS default。CLI は一切起動せず
    // 既存ログを読むだけ (8009001d 無関係、OS 非依存)。不在ディレクトリは cold-start 安全 (空)。
    const claudeDir =
      opts.claudeDir ??
      process.env.UT_TDD_CLAUDE_SESSIONS_DIR ??
      join(homedir(), ".claude", "projects");
    const codexDir =
      opts.codexDir ??
      process.env.UT_TDD_CODEX_SESSIONS_DIR ??
      join(homedir(), ".codex", "sessions");
    const usages = loadRuntimeSessionUsage({ claudeDirs: [claudeDir], codexDirs: [codexDir] });
    const summary = summarizeRunUsage(usages);
    const db = openHarnessDb(defaultHarnessDbPath(repoRoot), { repoRoot });
    try {
      // 既存 on-disk db が古い schema (token 列なし) でも壊れないよう migrate (冪等 ADD COLUMN)。
      migrate(db);
      projectTokenUsage(db, usages);
      // model_evaluations を再集計 (opt-in gate 無効なら no-op、cold-start 安全)。
      projectModelEvaluations(db, repoRoot);
    } finally {
      db.close();
    }
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ claudeDir, codexDir, ...summary }, null, 2)}\n`);
      return;
    }
    process.stdout.write(
      `telemetry scan: ${summary.totalRuns} runs ingested (claude=${summary.claudeRuns}, codex=${summary.codexRuns})\n` +
        `  tokens: input ${summary.inputTokens}, output ${summary.outputTokens}\n` +
        `  cost: $${summary.knownCostUsd} known, ${summary.runsWithoutCost} runs without published pricing (cost=null)\n` +
        `  sources: claude=${claudeDir}, codex=${codexDir}\n`,
    );
  });

const skill = program.command("skill").description("skill recommendation and invocation telemetry");
skill
  .command("suggest")
  .description("suggest skills for a PLAN id or a free-text task from harness.db context")
  .option("--plan <id>", "PLAN id (harness.db plan/layer/drive context)")
  .option("--text <task>", "free-text task (classify → context; mutually exclusive with --plan)")
  .option("--record", "write recommendations to harness.db (--plan only)")
  .option("--buckets", "group ranked rows into required/recommended/optional (additive view)")
  .option("--inject", "emit provider context injection manifest (skill paths only)")
  .option("--json", "JSON output")
  .action(
    (opts: {
      plan?: string;
      text?: string;
      record?: boolean;
      buckets?: boolean;
      inject?: boolean;
      json?: boolean;
    }) => {
      // A-138 ITEM-2: --plan / --text のどちらか一方が必須 (相互排他、flat ranked list は不変)。
      if (Boolean(opts.plan) === Boolean(opts.text)) {
        process.stderr.write("skill suggest requires exactly one of --plan or --text\n");
        process.exitCode = 1;
        return;
      }
      // 自由文は登録 PLAN でないので DB record 不可 (--record は --plan 専用)。
      if (opts.text && opts.record) {
        process.stderr.write(
          "--record requires --plan (free-text task is not a registered PLAN)\n",
        );
        process.exitCode = 1;
        return;
      }
      const repoRoot = process.cwd();
      const db = openHarnessDb(opts.record ? defaultHarnessDbPath(repoRoot) : ":memory:", {
        repoRoot,
      });
      try {
        rebuildHarnessDb({ repoRoot, db });
        const rows = opts.plan
          ? recommendSkillsForPlan(db, opts.plan)
          : recommendSkillsForText(db, opts.text ?? "");
        if (opts.record) recordSkillRecommendations(db, rows);
        if (opts.inject) {
          const injection = buildSkillInjectionSet(db, rows);
          if (opts.json) process.stdout.write(`${JSON.stringify(injection, null, 2)}\n`);
          else {
            process.stdout.write(`${injection.plan_id} skill injection\n`);
            for (const entry of injection.entries) {
              process.stdout.write(
                `  ${entry.tier} ${entry.inject_at} ${entry.skill_id} -> ${entry.skill_path} reason=${entry.reason}\n`,
              );
            }
            for (const skillId of injection.missing_skill_ids) {
              process.stdout.write(`  missing ${skillId}\n`);
            }
          }
          return;
        }
        // A-138 ITEM-2 PO 残課題: --buckets で required/recommended/optional に再編成 (additive、flat は既定)。
        if (opts.buckets) {
          const buckets = bucketRecommendations(rows);
          if (opts.json) process.stdout.write(`${JSON.stringify(buckets, null, 2)}\n`);
          else {
            for (const tier of ["required", "recommended", "optional"] as const) {
              process.stdout.write(`# ${tier}\n`);
              for (const row of buckets[tier]) {
                process.stdout.write(
                  `  ${row.skill_id}: score=${row.score} reason=${row.reason}\n`,
                );
              }
            }
          }
        } else if (opts.json) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
        else {
          for (const row of rows) {
            process.stdout.write(
              `${row.plan_id} ${row.skill_id}: rank=${row.rank} score=${row.score} reason=${row.reason}\n`,
            );
          }
        }
      } finally {
        db.close();
      }
    },
  );

skill
  .command("new")
  .description("scaffold a skill.v1 pack (skill-index.md §2; workflow/domain/project)")
  .requiredOption("--name <slug>", "skill name (slugified)")
  .option("--category <category>", "workflow | domain | project", "workflow")
  .option("--skill-type <type>", "finer sub-type (default = category)")
  .option("--layers <list>", "comma-separated layers (workflow)")
  .option("--drive-models <list>", "comma-separated drive models (workflow)")
  .option("--domain-tags <list>", "comma-separated domain tags (domain)")
  .option("--industry <name>", "industry/project tag (project)")
  .option("--description <text>", "one-line trigger/description")
  .option("--force", "overwrite an existing file on name collision")
  .option("--json", "JSON output")
  .action(
    (opts: {
      name: string;
      category: string;
      skillType?: string;
      layers?: string;
      driveModels?: string;
      domainTags?: string;
      industry?: string;
      description?: string;
      force?: boolean;
      json?: boolean;
    }) => {
      const repoRoot = process.cwd();
      const splitList = (value?: string): string[] =>
        (value ?? "")
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean);
      const result = scaffoldSkill(
        {
          name: opts.name,
          category: opts.category as SkillCategory,
          skillType: opts.skillType,
          layers: splitList(opts.layers),
          driveModels: splitList(opts.driveModels),
          domainTags: splitList(opts.domainTags),
          industry: opts.industry,
          description: opts.description,
        },
        { exists: (rel) => existsSync(join(repoRoot, rel)) },
      );
      const collision = result.findings.some((f) => f.startsWith("name-collision"));
      const otherFindings = result.findings.filter((f) => !f.startsWith("name-collision"));
      // 衝突以外の finding (unknown-category / not-indexable 等) では決して書かない (fail-close)。
      const writable = otherFindings.length === 0 && (!collision || Boolean(opts.force));
      let written = false;
      if (writable) {
        const absolute = join(repoRoot, result.path);
        ensureDir(dirname(absolute), { recursive: true });
        writeFileSync(absolute, result.content, "utf8");
        written = true;
      }
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ ...result, written }, null, 2)}\n`);
      } else {
        process.stdout.write(`${written ? "wrote" : "skipped"} ${result.path}\n`);
        for (const finding of result.findings) process.stdout.write(`  finding: ${finding}\n`);
      }
      if (!written) process.exitCode = 1;
    },
  );

const review = program
  .command("review")
  .description("prepare a deterministic review packet for the current worktree")
  .option("--uncommitted", "review uncommitted git changes")
  .option("--staged", "confirm the staged set before commit (IMP-137 staged-diff gate)")
  .option("--json", "JSON output")
  .action((opts: { uncommitted?: boolean; staged?: boolean; json?: boolean }) => {
    if (opts.staged) {
      // commit 前 staged-diff 確認の機械化 (IMP-137): staged 集合を surface し doctor を回す。
      // 意図しない混入を staged 段階で弾く (doctor 失敗 / suspect 検出で fail-close)。
      const staged = loadStagedFiles(process.cwd());
      const summary = summarizeStagedReview(staged);
      const lock = acquireDoctorLock(process.cwd());
      if (!lock.acquired) {
        const message = doctorLockBlockedMessage(lock.holder);
        const blocked = {
          scope: "staged",
          ok: false,
          staged: summary.staged,
          suspect: summary.suspect,
          doctorOk: false,
          doctorMessages: [message],
        };
        if (opts.json) process.stdout.write(`${JSON.stringify(blocked, null, 2)}\n`);
        else process.stderr.write(`${message}\n`);
        process.exitCode = 2;
        return;
      }
      let doctor: ReturnType<typeof runDoctor>;
      try {
        doctor = runDoctor();
      } finally {
        lock.release();
      }
      const ok = doctor.ok && summary.ok;
      const stagedOutput = {
        scope: "staged",
        ok,
        staged: summary.staged,
        suspect: summary.suspect,
        doctorOk: doctor.ok,
        doctorMessages: doctor.messages,
      };
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(stagedOutput, null, 2)}\n`);
      } else {
        process.stdout.write(
          `review staged: ${ok ? "ok" : "failed"} staged=${summary.staged.length} doctor=${doctor.ok ? "ok" : "failed"}\n`,
        );
        for (const path of summary.staged) process.stdout.write(`  + ${path}\n`);
      }
      process.exitCode = ok ? 0 : 1;
      return;
    }
    if (!opts.uncommitted) {
      process.stderr.write(
        "review requires --uncommitted or --staged for the current implementation surface\n",
      );
      process.exitCode = 1;
      return;
    }
    const changedFiles = loadChangedFiles(process.cwd());
    const lock = acquireDoctorLock(process.cwd());
    if (!lock.acquired) {
      const message = doctorLockBlockedMessage(lock.holder);
      const blocked = {
        scope: "uncommitted",
        ok: false,
        changedFiles,
        verificationRecommendations: [],
        missingProfiles: [],
        doctorMessages: [message],
      };
      if (opts.json) process.stdout.write(`${JSON.stringify(blocked, null, 2)}\n`);
      else process.stderr.write(`${message}\n`);
      process.exitCode = 2;
      return;
    }
    let doctor: ReturnType<typeof runDoctor>;
    try {
      doctor = runDoctor();
    } finally {
      lock.release();
    }
    const verification = recommendVerificationProfiles(changedFiles);
    const output = {
      scope: "uncommitted",
      ok: doctor.ok,
      changedFiles,
      verificationRecommendations: verification.recommendations.map((r) => ({
        profile: r.profile.id,
        signals: r.signals,
        command: r.profile.command,
        defaultEnabled: r.profile.defaultEnabled,
      })),
      missingProfiles: verification.missingProfiles,
      doctorMessages: doctor.messages,
    };
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    } else {
      process.stdout.write(
        `review uncommitted: ${doctor.ok ? "ok" : "failed"} changed=${changedFiles.length} recommendations=${output.verificationRecommendations.length}\n`,
      );
      for (const rec of output.verificationRecommendations) {
        process.stdout.write(`  - ${rec.profile}: ${rec.signals.join(", ")} -> ${rec.command}\n`);
      }
      if (verification.missingProfiles.length > 0) {
        process.stdout.write(
          `missing/disabled profiles: ${verification.missingProfiles.join(", ")}\n`,
        );
      }
    }
    process.exitCode = doctor.ok ? 0 : 1;
  });

registerLiveReviewCommands(review);

program
  .command("cutover")
  .description("prepare a non-destructive cutover / rollback plan")
  .requiredOption("--to <target>", "target ref, environment, or release label")
  .option("--from <source>", "source ref; defaults to current git HEAD when available")
  .option("--dry-run", "emit plan only; required for current implementation surface")
  .option("--json", "JSON output")
  .action((opts: { to: string; from?: string; dryRun?: boolean; json?: boolean }) => {
    const from = opts.from ?? gitHead() ?? "unknown";
    const output = {
      ok: Boolean(opts.dryRun),
      mode: opts.dryRun ? "dry-run" : "requires-human-approval",
      from,
      to: opts.to,
      checks: ["node src\\cli.ts doctor", "node src\\cli.ts db status --json"],
      rollback:
        from === "unknown" ? "record source ref before applying cutover" : `git switch ${from}`,
      humanApprovalRequired: true,
    };
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    } else {
      process.stdout.write(
        `cutover ${from} -> ${opts.to}: ${output.mode} approval=${output.humanApprovalRequired}\n`,
      );
      for (const check of output.checks) process.stdout.write(`  - check: ${check}\n`);
      process.stdout.write(`  - rollback: ${output.rollback}\n`);
    }
    if (!opts.dryRun) {
      process.stderr.write(
        "cutover apply is not implemented without explicit human-approved runbook\n",
      );
      process.exitCode = 1;
    }
  });

const automation = program.command("automation").description("workflow automation readiness");
automation
  .command("readiness")
  .description("evaluate automation readiness from harness.db projections")
  .option("--json", "JSON output")
  .action((opts: { json?: boolean }) => {
    const db = openHarnessDb(defaultHarnessDbPath(process.cwd()), { repoRoot: process.cwd() });
    try {
      const rows = evaluateAutomationReadiness(db);
      if (opts.json) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      else {
        for (const row of rows) {
          process.stdout.write(
            `${row.plan_id} ${row.workflow}/${row.phase}: ${row.ready_status} ${row.blocked_reason}\n`,
          );
        }
      }
    } finally {
      db.close();
    }
  });

const guardrail = program.command("guardrail").description("guardrail decision ledger");
guardrail
  .command("status")
  .description("list guardrail decisions from harness.db")
  .option("--json", "JSON output")
  .action((opts: { json?: boolean }) => {
    const db = openHarnessDb(defaultHarnessDbPath(process.cwd()), { repoRoot: process.cwd() });
    try {
      const rows = db.prepare("SELECT * FROM guardrail_decisions ORDER BY decided_at").all();
      if (opts.json) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      else {
        for (const row of rows) {
          process.stdout.write(
            `${row.plan_id ?? ""} ${row.guardrail ?? ""}: ${row.decision ?? ""} evidence=${row.evidence_path ?? ""}\n`,
          );
        }
      }
    } finally {
      db.close();
    }
  });

const issue = program.command("issue").description("external issue dry-run queue");
issue
  .command("queue")
  .description("list GitHub issue dry-run queue entries")
  .option("--json", "JSON output")
  .action((opts: { json?: boolean }) => {
    const db = openHarnessDb(defaultHarnessDbPath(process.cwd()), { repoRoot: process.cwd() });
    try {
      const rows = db
        .prepare("SELECT * FROM issue_queue ORDER BY created_at, issue_queue_id")
        .all();
      if (opts.json) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      else {
        for (const row of rows) {
          process.stdout.write(
            `${row.issue_queue_id ?? ""} ${row.status ?? ""}: ${row.title ?? ""} approval=${row.human_approval_required ?? ""}\n`,
          );
        }
      }
    } finally {
      db.close();
    }
  });

issue
  .command("mark-created")
  .description("record externally created GitHub issue back-reference for a queued dry-run item")
  .requiredOption("--queue-id <id>", "issue_queue_id")
  .requiredOption("--issue-url <url>", "created GitHub issue URL")
  .option("--issue-id <id>", "GitHub issue number or node id")
  .option("--approved-by <name>", "human approver")
  .action((opts: { queueId: string; issueUrl: string; issueId?: string; approvedBy?: string }) => {
    const db = openHarnessDb(defaultHarnessDbPath(process.cwd()), { repoRoot: process.cwd() });
    try {
      const existing = db
        .prepare("SELECT * FROM issue_queue WHERE issue_queue_id = ?")
        .get(opts.queueId);
      if (!existing) {
        process.stderr.write(`issue queue entry not found: ${opts.queueId}\n`);
        process.exitCode = 1;
        return;
      }
      db.prepare(
        `UPDATE issue_queue
           SET status = ?,
               human_approval_required = 0,
               approved_by = ?,
               approved_at = ?,
               external_issue_id = ?,
               external_issue_url = ?
           WHERE issue_queue_id = ?`,
      ).run(
        "created",
        opts.approvedBy ?? "",
        new Date().toISOString(),
        opts.issueId ?? "",
        opts.issueUrl,
        opts.queueId,
      );
      process.stdout.write(`issue queue updated: ${opts.queueId} -> ${opts.issueUrl}\n`);
    } finally {
      db.close();
    }
  });

const trouble = program.command("trouble").description("trouble taxonomy events");
trouble
  .command("list")
  .description("list projected trouble events")
  .option("--json", "JSON output")
  .action((opts: { json?: boolean }) => {
    const db = openHarnessDb(defaultHarnessDbPath(process.cwd()), { repoRoot: process.cwd() });
    try {
      const rows = db
        .prepare("SELECT * FROM trouble_events ORDER BY created_at, trouble_event_id")
        .all();
      if (opts.json) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      else {
        for (const row of rows) {
          process.stdout.write(
            `${row.trouble_event_id ?? ""} ${row.category ?? ""}: ${row.summary ?? ""}\n`,
          );
        }
      }
    } finally {
      db.close();
    }
  });

const improvement = program.command("improvement").description("self-improvement log");
improvement
  .command("log")
  .description("list projected self-improvement log entries")
  .option("--json", "JSON output")
  .action((opts: { json?: boolean }) => {
    const db = openHarnessDb(defaultHarnessDbPath(process.cwd()), { repoRoot: process.cwd() });
    try {
      const rows = db
        .prepare("SELECT * FROM improvement_log ORDER BY created_at, improvement_log_id")
        .all();
      if (opts.json) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      else {
        for (const row of rows) {
          process.stdout.write(
            `${row.improvement_log_id ?? ""} ${row.category ?? ""}: ${row.next_action ?? ""}\n`,
          );
        }
      }
    } finally {
      db.close();
    }
  });

const asset = program.command("asset").description("automation asset catalog");
asset
  .command("catalog")
  .description("catalog skill/roster/command docs into harness.db")
  .option("--json", "JSON output")
  .action((opts: { json?: boolean }) => {
    const db = openHarnessDb(defaultHarnessDbPath(process.cwd()), { repoRoot: process.cwd() });
    try {
      const result = catalogAutomationAssets({ repoRoot: process.cwd(), db });
      if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else {
        process.stdout.write(
          `asset catalog: ${result.assets.length} assets, findings=${result.findings.length}\n`,
        );
        for (const id of result.assets) process.stdout.write(`  - ${id}\n`);
      }
      process.exitCode = result.ok ? 0 : 1;
    } finally {
      db.close();
    }
  });

const rosterCommand = program.command("roster").description("subagent roster registry");
rosterCommand
  .command("list")
  .description("scan .claude/agents into a deterministic roster registry")
  .option("--json", "JSON output")
  .action((opts: { json?: boolean }) => {
    const result = listRosterRegistry({
      repoRoot: process.cwd(),
      allowlist: SUBAGENT_ALLOWLIST,
    });
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`roster list: ${result.count} agents\n`);
      for (const entry of result.entries) {
        process.stdout.write(
          `  - ${entry.id} model=${entry.model_family} allowlisted=${entry.allowlisted}\n`,
        );
      }
    }
    process.exitCode = result.ok ? 0 : 1;
  });
rosterCommand
  .command("check")
  .description("compare .claude/agents roster with the guard allowlist")
  .option("--json", "JSON output")
  .action((opts: { json?: boolean }) => {
    const result = checkRosterConsistency({
      repoRoot: process.cwd(),
      allowlist: SUBAGENT_ALLOWLIST,
    });
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(
        `roster check: ${result.ok ? "ok" : "failed"} allowlistedPresent=${result.allowlistedPresent} missingFromRoster=${result.missingFromRoster.length} nameMismatches=${result.nameMismatches.length} nonAllowlisted=${result.nonAllowlisted.length}\n`,
      );
    }
    process.exitCode = result.ok ? 0 : 1;
  });

const builder = program.command("builder").description("command and workflow builder catalog");
builder
  .command("catalog")
  .description("emit the implemented command-builder surface without mutating state")
  .option("--json", "JSON output")
  .action((opts: { json?: boolean }) => {
    const commandDocs = [
      { path: "src/cli.ts", command: "ut-tdd skill suggest", description: "skill recommendation" },
      { path: "src/cli.ts", command: "ut-tdd review --uncommitted", description: "review packet" },
      { path: "src/cli.ts", command: "ut-tdd cutover --to", description: "cutover dry-run" },
      { path: "src/cli.ts", command: "ut-tdd asset catalog", description: "asset catalog" },
      { path: "src/cli.ts", command: "ut-tdd roster list", description: "roster registry" },
      { path: "src/cli.ts", command: "ut-tdd roster check", description: "roster guard check" },
      { path: "src/cli.ts", command: "ut-tdd builder catalog", description: "builder catalog" },
    ];
    const surface = commandDocs.map((doc) => doc.command);
    const result = buildCommandCatalog({ command_docs: commandDocs, cli_surface: surface });
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`builder catalog: ${result.commands.length} commands\n`);
      for (const row of result.commands) process.stdout.write(`  - ${row.command}\n`);
    }
    process.exitCode = result.ok ? 0 : 1;
  });

const vmodel = program.command("vmodel").description("V-model trace");
vmodel
  .command("lint [path]")
  .description("V-model 4 artifact trace lint")
  .action((path?: string) => {
    const r = lintVmodel(path);
    for (const m of r.messages) process.stdout.write(`${m}\n`);
    process.exitCode = r.ok ? 0 : 1;
  });
vmodel
  .command("show <drive> <layer>")
  .description("show drive x layer V-model context")
  .option("--injection", "show layer-context injection")
  .option("--json", "JSON output")
  .option("--mode <mode>", "override execution mode for degradation checks")
  .action(
    (
      drive: string,
      layer: string,
      opts: { injection?: boolean; json?: boolean; mode?: ReturnType<typeof detectMode>["mode"] },
    ) => {
      if (!opts.injection) {
        process.stderr.write("vmodel show currently requires --injection\n");
        process.exitCode = 1;
        return;
      }
      try {
        const executionMode = opts.mode ?? detectMode().mode;
        const injection = resolveVmodelInjection(drive, layer, { executionMode });
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(injection, null, 2)}\n`);
          return;
        }
        for (const line of formatVmodelInjection(injection)) process.stdout.write(`${line}\n`);
      } catch (e) {
        process.stderr.write(`invalid vmodel injection input: ${String(e)}\n`);
        process.exitCode = 1;
      }
    },
  );

function loadRouteApprovalPolicy(repoRoot: string): RouteApprovalPolicy | undefined {
  const policyPath = join(repoRoot, ".ut-tdd", "config", "approval-policy.yaml");
  if (!existsSync(policyPath)) return undefined;
  const parsed = parseYaml(readFileSync(policyPath, "utf8")) as Partial<RouteApprovalPolicy>;
  if (!Array.isArray(parsed.rules)) return undefined;
  return {
    rules: parsed.rules
      .filter(
        (rule) => rule && typeof rule.mode === "string" && Array.isArray(rule.required_approvers),
      )
      .map((rule) => ({
        mode: String(rule.mode),
        ...(typeof rule.condition === "string" ? { condition: rule.condition } : {}),
        required_approvers: rule.required_approvers.map(String),
      })),
    approvals: Array.isArray(parsed.approvals)
      ? parsed.approvals
          .filter(
            (approval) =>
              approval &&
              typeof approval.mode === "string" &&
              typeof approval.approver === "string" &&
              typeof approval.approved_at === "string",
          )
          .map((approval) => ({
            mode: String(approval.mode),
            ...(typeof approval.condition === "string" ? { condition: approval.condition } : {}),
            approver: String(approval.approver),
            approved_at: String(approval.approved_at),
            ...(typeof approval.subject === "string" ? { subject: approval.subject } : {}),
          }))
      : [],
  };
}

function appendRouteApprovalAudit(repoRoot: string, evaluated: RouteEvalResult): string {
  const auditDir = join(repoRoot, ".ut-tdd", "audit");
  ensureDir(auditDir, { recursive: true });
  const auditPath = join(auditDir, "route-approval.jsonl");
  appendFileSync(
    auditPath,
    `${JSON.stringify({
      event: "route_approval_blocked",
      occurred_at: new Date().toISOString(),
      signal: evaluated.signal,
      mode: evaluated.mode,
      approval_status: evaluated.approval.status,
      required_approvers: evaluated.approval.required_approvers,
      missing_approvers: evaluated.approval.missing_approvers,
      recommended_command: evaluated.recommended_command,
    })}\n`,
  );
  return auditPath;
}

function loadRouteMap(
  repoRoot: string,
  explicitPath?: string,
): { routes?: RouteSignalEntry[]; violations: RouteConfigViolation[] } {
  const routeMapPath = explicitPath ?? join(repoRoot, ".ut-tdd", "config", "route-map.yaml");
  if (!existsSync(routeMapPath)) return { violations: [] };
  const text = readFileSync(routeMapPath, "utf8");
  const violations = validateRouteConfigText({ path: routeMapPath, text });
  const parsed = parseYaml(text) as {
    routes?: Partial<RouteSignalEntry>[];
  };
  if (!Array.isArray(parsed.routes)) return { violations };
  return {
    violations,
    routes: parsed.routes
      .filter(
        (route) =>
          route &&
          Array.isArray(route.tokens) &&
          typeof route.mode === "string" &&
          typeof route.command === "string",
      )
      .map((route) => ({
        tokens: route.tokens?.map(String) ?? [],
        mode: String(route.mode),
        command: String(route.command),
        preflight: route.preflight !== false,
        requiresApproval: route.requiresApproval === true,
      })),
  };
}

const routeCommand = program.command("route").description("signal routing");
routeCommand
  .command("eval")
  .description("evaluate a signal into a mode and RecommendedCommandV1")
  .requiredOption("--signal <signal>", "observed signal")
  .option("--env <env>", "runtime environment")
  .option("--drift-type <type>", "drift subtype")
  .option("--finding-type <type>", "audit/research finding type")
  .option("--route-map <path>", "route-map YAML override")
  .option("--format <format>", "output format: text or json", "text")
  .option("--json", "JSON output (alias for --format json)")
  .action(
    (opts: {
      signal: string;
      env?: string;
      driftType?: string;
      findingType?: string;
      routeMap?: string;
      format?: string;
      json?: boolean;
    }) => {
      const repoRoot = process.cwd();
      const routeMap = loadRouteMap(repoRoot, opts.routeMap);
      const evaluated = evaluateRouteCommand({
        signal: opts.signal,
        env: opts.env,
        drift_type: opts.driftType,
        finding_type: opts.findingType,
        approval_policy: loadRouteApprovalPolicy(repoRoot),
        route_map: routeMap.routes,
        route_config_violations: routeMap.violations,
      });
      const auditPath =
        evaluated.exit_code === 1 ? appendRouteApprovalAudit(repoRoot, evaluated) : "";
      if (opts.json || opts.format === "json") {
        process.stdout.write(
          `${JSON.stringify(auditPath ? { ...evaluated, audit_path: auditPath } : evaluated, null, 2)}\n`,
        );
      } else if (evaluated.recommended_command) {
        process.stdout.write(`mode=${evaluated.mode}\n`);
        process.stdout.write(`suggest_command=${evaluated.suggest_command}\n`);
        process.stdout.write(`command=${evaluated.recommended_command.command}\n`);
        if (evaluated.finding_route) {
          process.stdout.write(
            `finding_route=${evaluated.finding_route.finding_type}->${evaluated.finding_route.mode}\n`,
          );
          process.stdout.write(`auto_create=${String(evaluated.finding_route.auto_create)}\n`);
        }
        if (auditPath) process.stderr.write(`human approval blocked; audit=${auditPath}\n`);
      } else {
        process.stderr.write(`${evaluated.suggest_command}\n`);
      }
      process.exitCode = evaluated.exit_code;
    },
  );

program
  .command("advisor")
  .description("upper-model advisor adapter for uncertain orchestration decisions")
  .option("--task <text>", "task text")
  .option("--task-file <path>", TASK_FILE_OPTION_DESCRIPTION)
  .option("--provider <provider>", "advisor provider (claude|codex)")
  .option(
    "--decision <kind>",
    "decision kind (design|progress|implementation|troubleshooting|uiux); inferred when omitted",
  )
  .option("--current-model <model>", "current orchestrator model that needs advice")
  .option("--reason <text>", "why upper-model advice is needed")
  .option("--plan <id>", "PLAN id")
  .option("--execute", "execute provider CLI instead of dry-run")
  .option("--mode <mode>", MODE_OVERRIDE_OPTION_DESCRIPTION)
  .option("--json", "JSON output")
  .action(
    (opts: {
      task?: string;
      taskFile?: string;
      provider?: string;
      decision?: string;
      currentModel?: string;
      reason?: string;
      plan?: string;
      execute?: boolean;
      mode?: ReturnType<typeof detectMode>["mode"];
      json?: boolean;
    }) => {
      const task = resolveTaskText(opts);
      if (!task) {
        process.stderr.write("advisor requires exactly one of --task or --task-file\n");
        process.exitCode = 1;
        return;
      }
      if (opts.provider && opts.provider !== "claude" && opts.provider !== "codex") {
        process.stderr.write("advisor --provider must be claude or codex\n");
        process.exitCode = 1;
        return;
      }
      if (opts.decision && !(ADVISOR_DECISION_KINDS as readonly string[]).includes(opts.decision)) {
        // 受理集合は advisor-policy の SSoT に従う (旧実装は design|implementation を
        // ハードコードしており、uiux / troubleshooting が CLI から指定できなかった)。
        process.stderr.write(
          `advisor --decision must be one of ${ADVISOR_DECISION_KINDS.join(" | ")}\n`,
        );
        process.exitCode = 1;
        return;
      }
      const mode = opts.mode ?? detectMode().mode;
      const decision = buildAdvisorDecision({
        task,
        mode,
        provider: opts.provider as AdapterProvider | undefined,
        decisionKind: opts.decision as AdvisorDecisionKind | undefined,
        currentModel: opts.currentModel,
        reason: opts.reason,
        planId: opts.plan,
        execute: Boolean(opts.execute),
        contextInjection: resolveSkillContextInjection(opts.plan),
      });
      if (!decision.adapterPlan.available) {
        if (opts.json) process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
        else process.stderr.write(`${decision.adapterPlan.messages.join("\n")}\n`);
        process.exitCode = 1;
        return;
      }
      if (!opts.execute) {
        if (opts.json) process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
        else {
          process.stdout.write(
            `advisor: provider=${decision.provider} model=${decision.model} effort=${decision.effort} mode=${decision.consultation_mode} decision=${decision.decision_kind} intent=${decision.task_intent} lower=${decision.current_model_lower_than_advisor} dry-run\n`,
          );
          process.stdout.write(`  - ${decision.reason}\n`);
          process.stdout.write(
            `  - dispatch: command=${decision.adapterPlan.command} args=[${decision.adapterPlan.args.join(" ")}]\n`,
          );
          if (decision.fallback) {
            process.stdout.write(
              `  - fallback on response error: provider=${decision.fallback.provider} model=${decision.fallback.model} effort=${decision.fallback.effort} mode=${decision.fallback.consultation_mode}\n`,
            );
          }
        }
        return;
      }
      const execution = executeAdapterPlanForCli(
        decision.adapterPlan,
        {
          sessionPrefix: `advisor-${decision.provider}`,
          toolName: "advisor",
          planId: opts.plan,
          jsonOut: Boolean(opts.json),
        },
        { gitBranch, gitHead, runSessionStartSideEffects, writeHandoverWarnings },
      );
      // 一次相談先のレスポンスエラーは advisor 全体を落とさず fallback へ切替える
      // (advisor-tool の advisor_tool_result_error と同じ fail-soft 思想)。
      let fallbackExecution: ReturnType<typeof executeAdapterPlanForCli> | undefined;
      if ((execution.exit_code ?? 1) !== 0 && decision.fallback?.adapterPlan.available) {
        process.stderr.write(
          `advisor: primary provider=${decision.provider} failed (exit=${execution.exit_code ?? "null"}); falling back to provider=${decision.fallback.provider} model=${decision.fallback.model} mode=${decision.fallback.consultation_mode}\n`,
        );
        fallbackExecution = executeAdapterPlanForCli(
          decision.fallback.adapterPlan,
          {
            sessionPrefix: `advisor-${decision.fallback.provider}`,
            toolName: "advisor",
            planId: opts.plan,
            jsonOut: Boolean(opts.json),
          },
          { gitBranch, gitHead, runSessionStartSideEffects, writeHandoverWarnings },
        );
      }
      const output = {
        ...decision,
        adapterPlan: {
          ...decision.adapterPlan,
          ...execution,
          dry_run: false,
        },
        ...(fallbackExecution && decision.fallback
          ? {
              fallback: {
                ...decision.fallback,
                adapterPlan: {
                  ...decision.fallback.adapterPlan,
                  ...fallbackExecution,
                  dry_run: false,
                },
              },
              fallback_used: true,
            }
          : {}),
      };
      if (opts.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      else if (fallbackExecution && decision.fallback) {
        process.stdout.write(
          `advisor executed (fallback): provider=${decision.fallback.provider} model=${decision.fallback.model} mode=${decision.fallback.consultation_mode} exit=${fallbackExecution.exit_code ?? "null"}\n`,
        );
      } else {
        process.stdout.write(
          `advisor executed: provider=${decision.provider} model=${decision.model} exit=${execution.exit_code ?? "null"}\n`,
        );
      }
      process.exitCode = (fallbackExecution ?? execution).exit_code ?? 1;
    },
  );

registerDelegationCommands(program, {
  gitBranch,
  gitHead,
  resolveTaskText,
  resolveSkillContextInjection,
  runSessionStartSideEffects,
  taskFileOptionDescription: TASK_FILE_OPTION_DESCRIPTION,
  writeHandoverWarnings,
});

program
  .command("gate <id>")
  .description("mode-aware gate review-tier and deterministic static checks")
  .option("--mode <mode>", MODE_OVERRIDE_OPTION_DESCRIPTION)
  .option("--review-kind <kind>", "cross_agent / intra_runtime_subagent / human")
  .option("--worker-model <model>", "worker provider/model id")
  .option("--reviewer-model <model>", "reviewer provider/model id")
  .option("--checklist <path>", "YAML checklist evidence for single-runtime review")
  .option("--coverage-summary <path>", "coverage/coverage-summary.json evidence for G7")
  .option("--plan <id>", "plan_id to attach to gate run evidence")
  .option("--session <id>", "session_id to attach to gate run evidence")
  .option("--human-approved", "standalone human approval evidence")
  .option("--json", "JSON output")
  .action(
    (
      id: string,
      opts: {
        mode?: ReturnType<typeof detectMode>["mode"];
        reviewKind?: "cross_agent" | "intra_runtime_subagent" | "human";
        workerModel?: string;
        reviewerModel?: string;
        checklist?: string;
        coverageSummary?: string;
        plan?: string;
        session?: string;
        humanApproved?: boolean;
        json?: boolean;
      },
    ) => {
      const mode = opts.mode ?? detectMode().mode;
      let checklist = null;
      const checklistMessages: string[] = [];
      try {
        checklist = loadReviewChecklistIfPresent(opts.checklist);
      } catch (e) {
        checklistMessages.push(
          `review checklist - violation: could not load checklist (${String(e)})`,
        );
      }
      const review = evaluateGateReview({
        gate: id,
        mode,
        reviewKind: opts.reviewKind,
        workerModel: opts.workerModel,
        reviewerModel: opts.reviewerModel,
        checklist,
        humanApproved: Boolean(opts.humanApproved),
      });
      if (checklistMessages.length > 0) {
        review.passed = false;
        review.messages.push(...checklistMessages);
      }
      const staticGate = evaluateStaticGate({
        gate: id,
        repoRoot: process.cwd(),
        coverageSummaryPath: opts.coverageSummary,
      });
      const result = {
        ...review,
        passed: review.passed && staticGate.passed,
        review,
        static_gate: staticGate,
        messages: [...review.messages, ...staticGate.messages],
      };
      let gateRunEvidence: { path: string; gate_run_id: string } | null = null;
      let gateRunEvidenceWarning: string | null = null;
      try {
        const written = writeGateRunEvidence({
          repoRoot: process.cwd(),
          gateId: id,
          planId:
            opts.plan ??
            process.env.UT_TDD_PLAN_ID ??
            resolveActivePlan(nodeDeps(process.cwd(), gitBranch)),
          sessionId: opts.session ?? process.env.UT_TDD_SESSION_ID ?? null,
          status: result.passed ? "passed" : "failed",
          mode,
          reviewKind: result.review_kind,
          workerModel: opts.workerModel ?? null,
          reviewerModel: opts.reviewerModel ?? null,
          checklistPath: opts.checklist ?? null,
          coverageSummaryPath: opts.coverageSummary ?? null,
          staticApplicable: staticGate.applicable,
          checks: [
            {
              name: "review-tier",
              result: review.passed ? "passed" : "failed",
              messages: review.messages,
            },
            {
              name: "static-gate",
              result: staticGate.applicable
                ? staticGate.passed
                  ? "passed"
                  : "failed"
                : "not_applicable",
              messages: staticGate.messages,
            },
          ],
          messages: result.messages,
        });
        gateRunEvidence = {
          path: written.path,
          gate_run_id: written.evidence.gate_run_id,
        };
      } catch (error) {
        gateRunEvidenceWarning = `gate run evidence write failed: ${String(error)}`;
      }
      const output = {
        ...result,
        gate_run_evidence: gateRunEvidence,
        gate_run_evidence_warning: gateRunEvidenceWarning,
      };
      if (opts.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      else {
        process.stdout.write(
          `gate ${id}: ${result.passed ? "passed" : "failed"} mode=${result.mode} review=${result.review_kind ?? "-"} cross_agent_review=${result.cross_agent_review} static=${staticGate.applicable ? (staticGate.passed ? "passed" : "failed") : "n-a"}\n`,
        );
        if (gateRunEvidence) process.stdout.write(`  - evidence: ${gateRunEvidence.path}\n`);
        if (gateRunEvidenceWarning) process.stdout.write(`  - ${gateRunEvidenceWarning}\n`);
        for (const m of result.messages) process.stdout.write(`  - ${m}\n`);
      }
      process.exitCode = result.passed ? 0 : 1;
    },
  );

const task = program
  .command("task")
  .description("task classification (FR-L1-39: kind/drive/size/complexity/risk)");
task
  .command("classify")
  .description("classify a task into kind / drive / size / complexity / difficulty / risk")
  .option("--text <text>", "task text")
  .option("--text-file <path>", TASK_FILE_OPTION_DESCRIPTION)
  .option("--plan <path>", "read task text from a PLAN file")
  .option("--files <list>", "comma-separated affected file paths")
  .option("--design-docs", "derive required design/test documents from proposal text")
  .option("--json", "JSON output")
  .action(
    (opts: {
      text?: string;
      textFile?: string;
      plan?: string;
      files?: string;
      designDocs?: boolean;
      json?: boolean;
    }) => {
      const text = resolveTaskText({ task: opts.text, taskFile: opts.textFile ?? opts.plan });
      if (text === null || text.trim().length === 0) {
        process.stderr.write(
          "task classify requires exactly one of --text, --text-file, or --plan\n",
        );
        process.exitCode = 1;
        return;
      }
      const affected_files = opts.files
        ? opts.files
            .split(",")
            .map((f) => f.trim())
            .filter(Boolean)
        : undefined;
      if (opts.designDocs) {
        const result = {
          task: classifyTask({ text, affected_files }),
          document_coverage: classifyProposalDocumentCoverage({ text, affected_files }),
        };
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          return;
        }
        const coverage = result.document_coverage;
        process.stdout.write(
          `task design-docs: granularity=${coverage.granularity} patterns=[${coverage.patterns.join(",")}] escalators=[${coverage.escalators.join(",")}]\n`,
        );
        process.stdout.write("  design docs:\n");
        for (const d of coverage.required_design_docs) {
          process.stdout.write(`    - ${d.id}: ${d.path}\n`);
        }
        process.stdout.write("  test docs:\n");
        for (const d of coverage.required_test_docs) {
          process.stdout.write(`    - ${d.id}: ${d.path}\n`);
        }
        process.stdout.write("  research adoption:\n");
        for (const r of coverage.research_adoption) {
          process.stdout.write(`    - ${r.pattern}: ${r.disposition} (${r.reason})\n`);
        }
        for (const r of coverage.research_rejections) {
          process.stdout.write(`    - ${r.pattern}: ${r.disposition} (${r.reason})\n`);
        }
        process.stdout.write("  recommended subagents:\n");
        for (const a of coverage.recommended_subagents) {
          process.stdout.write(
            `    - ${a.role}: ${a.tier} ${a.model} slots=${a.parallel_slots} closing=${a.closing_authority} ownership=${a.ownership} (${a.purpose}; guard=${a.guard})\n`,
          );
        }
        for (const f of coverage.findings) {
          process.stdout.write(`  - ${f.severity}: ${f.code} ${f.message}\n`);
        }
        return;
      }
      const result = classifyTask({ text, affected_files });
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      process.stdout.write(
        `task classify: kind=${result.kind} drive=${result.drive}(${result.drive_confidence}) mode=${result.route.mode ?? "-"} route_exit=${result.route.exit_code} approval=${result.route.approval_status} size=${result.size} complexity=${result.complexity_score} difficulty=${result.difficulty} risk=[${result.risk_flags.join(",")}]\n`,
      );
      for (const f of result.findings) {
        process.stdout.write(`  - ${f.severity}: ${f.code} ${f.message}\n`);
      }
    },
  );

const ROUTER_ROLES: readonly RouterRole[] = ["tl", "qa", "uiux", "se", "docs"];

task
  .command("route")
  .description(
    "route a task to a role tier/provider (難易度ルーター: archetype × difficulty × 主 provider)",
  )
  .requiredOption("--role <role>", `router role: ${ROUTER_ROLES.join("|")}`)
  .option("--text <text>", "task text")
  .option("--text-file <path>", TASK_FILE_OPTION_DESCRIPTION)
  .option("--plan <path>", "read task text from a PLAN file")
  .option("--files <list>", "comma-separated affected file paths")
  .option("--primary <provider>", "override primary provider (claude|codex)")
  .option("--allow-frontier", "explicitly authorize T0 (opus/gpt-5.5)")
  .option("--execute", "bridge the decision to the provider adapter plan (dry-run command)")
  .option("--mode <mode>", MODE_OVERRIDE_OPTION_DESCRIPTION)
  .option("--json", "JSON output")
  .action(
    (opts: {
      role: string;
      text?: string;
      textFile?: string;
      plan?: string;
      files?: string;
      primary?: string;
      allowFrontier?: boolean;
      execute?: boolean;
      mode?: ReturnType<typeof detectMode>["mode"];
      json?: boolean;
    }) => {
      if (!ROUTER_ROLES.includes(opts.role as RouterRole)) {
        process.stderr.write(`task route requires --role in ${ROUTER_ROLES.join("|")}\n`);
        process.exitCode = 1;
        return;
      }
      const text = resolveTaskText({ task: opts.text, taskFile: opts.textFile ?? opts.plan });
      if (text === null || text.trim().length === 0) {
        process.stderr.write("task route requires exactly one of --text, --text-file, or --plan\n");
        process.exitCode = 1;
        return;
      }
      if (opts.primary && opts.primary !== "claude" && opts.primary !== "codex") {
        process.stderr.write("task route --primary must be claude or codex\n");
        process.exitCode = 1;
        return;
      }
      const affected_files = opts.files
        ? opts.files
            .split(",")
            .map((f) => f.trim())
            .filter(Boolean)
        : undefined;
      const base = detectMode();
      const detection = opts.mode ? { ...base, mode: opts.mode } : base;
      const decision = route(
        { role: opts.role as RouterRole, task: { text, affected_files } },
        detection,
        {
          primary: opts.primary as Provider | undefined,
          auth: { explicit: Boolean(opts.allowFrontier) },
        },
      );
      const adapterPlan = opts.execute
        ? routeToAdapterPlan(decision, text, {
            mode: detection.mode,
            contextInjection: resolveSkillContextInjection(planIdFromPath(opts.plan)),
          })
        : null;
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ decision, adapterPlan }, null, 2)}\n`);
        return;
      }
      process.stdout.write(
        `task route: role=${decision.role} archetype=${decision.archetype} tier=${decision.tier} provider=${decision.provider} model=${decision.model ?? "(blocked)"} status=${decision.status} review=${decision.reviewEntry} gate=${decision.gate} crossReview=${decision.crossReview} switch=${decision.cross.execution}>${decision.cross.judgement}(${decision.cross.review_kind}) difficulty=${decision.difficulty} risk=[${decision.riskFlags.join(",")}]\n`,
      );
      if (decision.reason) process.stdout.write(`  - ${decision.reason}\n`);
      if (opts.execute) {
        if (adapterPlan) {
          process.stdout.write(
            `  dispatch: provider=${adapterPlan.provider} available=${adapterPlan.available} command=${adapterPlan.command} args=[${adapterPlan.args.join(" ")}]\n`,
          );
        } else {
          process.stdout.write("  dispatch: not executable (T0 explicit-permission gate)\n");
          process.exitCode = 1;
        }
      }
    },
  );

task
  .command("roster")
  .description("list the symmetric dual-provider role roster (10 bindings)")
  .option("--json", "JSON output")
  .action((opts: { json?: boolean }) => {
    const bindings = roster();
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(bindings, null, 2)}\n`);
      return;
    }
    for (const b of bindings) {
      process.stdout.write(
        `roster: role=${b.role} archetype=${b.archetype} claude=${b.claude} codex=${b.codex}\n`,
      );
    }
  });

const team = program.command("team").description("team orchestration");
team
  .command("suggest")
  .description("recommend whether a task should launch a Claude/Codex team")
  .requiredOption("--task <text>", "task text to classify")
  .option("--mode <mode>", MODE_OVERRIDE_OPTION_DESCRIPTION)
  .option(
    "--design-docs",
    "derive a parallel proposal-document coverage team from design-doc lanes",
  )
  .option("--json", "JSON output")
  .action(
    (opts: {
      task: string;
      mode?: ReturnType<typeof detectMode>["mode"];
      designDocs?: boolean;
      json?: boolean;
    }) => {
      const mode = opts.mode ?? detectMode().mode;
      const coverage = opts.designDocs
        ? classifyProposalDocumentCoverage({ text: opts.task })
        : undefined;
      const result = recommendTeamLaunch({
        task: opts.task,
        mode,
        proposalSubagents: coverage?.recommended_subagents,
      });
      const output = coverage ? { ...result, document_coverage: coverage } : result;
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      } else {
        process.stdout.write(
          `team suggest: ${result.should_launch ? "launch" : "single-agent"} mode=${result.mode} difficulty=${result.difficulty} trigger=${result.trigger}\n`,
        );
        process.stdout.write(`  - ${result.reason}\n`);
        if (result.definition) {
          process.stdout.write(
            `  - definition=${result.definition.name} members=${result.definition.members.length}\n`,
          );
        }
      }
    },
  );
team
  .command("run")
  .description("validate, plan, and optionally execute a hybrid team run")
  .requiredOption("--definition <path>", "team definition YAML")
  .option("--mode <mode>", MODE_OVERRIDE_OPTION_DESCRIPTION)
  .option("--plan <id>", "PLAN id to attach to provider adapter metadata")
  .option("--execute", "execute provider adapters; default is dry-run planning only")
  .option(
    "--route",
    "tier-router でクロス配置 (ワーカー=主 / 相談・検証=相手) と原則安く tier モデルを導出",
  )
  .option("--primary <provider>", "クロス分岐の主 provider (claude/codex)。--route 時に使用")
  .option("--allow-frontier", "T0 (opus/gpt-5.5) の相談・検証 member を明示許可 (--route 時)")
  .option("--json", "JSON output")
  .action(
    async (opts: {
      definition: string;
      mode?: ReturnType<typeof detectMode>["mode"];
      plan?: string;
      execute?: boolean;
      route?: boolean;
      primary?: Provider;
      allowFrontier?: boolean;
      json?: boolean;
    }) => {
      try {
        const mode = opts.mode ?? detectMode().mode;
        const definition = loadTeamDefinition(opts.definition);
        let placements: (MemberPlacement | null)[] | undefined;
        if (opts.route) {
          const base = detectMode();
          const detection: RuntimeDetection = { ...base, mode };
          const primary = opts.primary ?? base.currentRuntime ?? "claude";
          const auth = opts.allowFrontier ? { explicit: true } : undefined;
          const routings = routeTeamMembers(
            definition.members.map((m) => ({ role: m.role, task: m.task })),
            detection,
            { primary, auth },
          );
          placements = routings.map((r): MemberPlacement | null => {
            if (!r.routed || !r.decision) return null;
            const d = r.decision;
            if (d.status !== "ready" || !d.model) {
              return { provider: d.provider, model: "", blockedReason: d.reason ?? "blocked" };
            }
            return { provider: d.provider, model: d.model };
          });
        }
        const result = buildTeamRunPlan(definition, mode, {
          execute: Boolean(opts.execute),
          planId: opts.plan,
          placements,
          contextInjection: resolveSkillContextInjection(opts.plan),
        });
        if (!opts.execute) {
          if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          else {
            process.stdout.write(
              `team ${definition.name}: ${result.ok ? "ok" : "failed"} mode=${mode} strategy=${result.strategy}${opts.route ? " routed" : ""} dry-run\n`,
            );
            for (const member of result.members) {
              process.stdout.write(
                `  - ${member.role}:${member.engine} provider=${member.provider} model=${member.model_selection.model}${member.adapter ? ` command=${member.adapter.command}` : ""}\n`,
              );
            }
            for (const m of result.messages) process.stdout.write(`  - ${m}\n`);
          }
          process.exitCode = result.ok ? 0 : 1;
          return;
        }
        let teamSessionSeq = 0;
        const repoRoot = process.cwd();
        const repoHasGitDir = existsSync(join(repoRoot, ".git"));
        const cachedBranch = repoHasGitDir ? gitBranch() : null;
        const cachedHead = repoHasGitDir ? gitHead() : null;
        const sessionDeps = nodeDeps(
          repoRoot,
          () => cachedBranch,
          () => cachedHead,
        );
        if (opts.json) {
          sessionDeps.warn = (message) => process.stderr.write(`${message}\n`);
        }
        const execution = await executeTeamRunPlan(result, {
          slots: nodeAgentSlotsDeps(repoRoot),
          runCommand: ({ command, args, provider, env, stdin }) =>
            new Promise((resolve) => {
              const sessionId = `${provider}-team-${Date.now()}-${teamSessionSeq++}`;
              const startInput: SessionHookInput = {
                hook_event_name: HOOK_EVENT_SESSION_START,
                session_id: sessionId,
                ...(opts.plan ? { plan_id: opts.plan } : {}),
              };
              runSessionStartSideEffects({
                repoRoot,
                input: startInput,
                deps: sessionDeps,
                json: Boolean(opts.json),
              });
              dispatch(startInput, sessionDeps, HOOK_EVENT_SESSION_START);
              const invocation = buildProviderInvocation({ provider, command, args });
              const ioMode = opts.json ? "ignore" : "inherit";
              let child: ReturnType<typeof spawn>;
              try {
                child = spawn(invocation.command, invocation.args, {
                  cwd: repoRoot,
                  env: adapterExecutionEnv(provider, env),
                  // Provider prompts are passed through stdin; argv carries only fixed
                  // command flags so shell metacharacters and tool markup stay inert.
                  // codex はプロンプトを stdin で受ける (cmd.exe shell-wrap 回避、PLAN-L7-77)。
                  stdio: stdin === undefined ? ioMode : ["pipe", ioMode, ioMode],
                  shell: invocation.shell ?? false,
                  windowsVerbatimArguments: invocation.windowsVerbatimArguments ?? false,
                });
              } catch (error) {
                process.stderr.write(
                  `${provider} provider launch failed (team run): ${String(error)}\n`,
                );
                resolve({ exitCode: null });
                return;
              }
              if (stdin !== undefined) {
                const inputStream = child.stdin;
                if (inputStream) {
                  // Provider が入力を読む前に終了すると Node は stdin の EPIPE を
                  // 未処理 error event として親プロセスへ上げる。close event の終了
                  // コードを正本にし、早期 close は team run を落とさない。
                  inputStream.on("error", () => undefined);
                  try {
                    inputStream.write(stdin);
                    inputStream.end();
                  } catch {
                    // close/error handler が最終結果を確定する。
                  }
                }
              }
              let finalized = false;
              const finish = (exitCode: number | null) => {
                if (finalized) return;
                finalized = true;
                dispatch(
                  {
                    hook_event_name: "PostToolUse",
                    session_id: sessionId,
                    ...(opts.plan ? { plan_id: opts.plan } : {}),
                    tool_name: provider,
                    tool_input: { command: `${command} ${args.join(" ")}` },
                    tool_response: { outcome: exitCode === 0 ? "ok" : "error" },
                  },
                  sessionDeps,
                  "PostToolUse",
                );
                dispatch(
                  {
                    hook_event_name: "Stop",
                    session_id: sessionId,
                    ...(opts.plan ? { plan_id: opts.plan } : {}),
                  },
                  sessionDeps,
                  "Stop",
                );
                resolve({ exitCode });
              };
              child.on("error", () => finish(null));
              child.on("close", (code) => finish(code));
            }),
        });
        writeHandoverWarnings();
        if (opts.json) process.stdout.write(`${JSON.stringify(execution, null, 2)}\n`);
        else {
          process.stdout.write(
            `team ${definition.name}: ${execution.ok ? "completed" : "failed"} strategy=${execution.strategy}\n`,
          );
          for (const member of execution.executions) {
            process.stdout.write(
              `  - ${member.role}:${member.engine} status=${member.status} exit=${member.exit_code ?? "null"} slot=${member.slot_id ?? "-"}\n`,
            );
          }
          for (const m of execution.messages) process.stdout.write(`  - ${m}\n`);
        }
        process.exitCode = execution.ok ? 0 : 1;
      } catch (e) {
        process.stderr.write(`${String(e)}\n`);
        process.exitCode = 1;
      }
    },
  );

const audit = program.command("audit").description("read-only repository audits");

audit
  .command("node-ban")
  .description("Q0 Node-only Bun permanent-ban qualification audit")
  .requiredOption("--generation <path>", "sealed Node generation directory")
  .requiredOption("--f0c-evidence <path>", "F0c aggregate evidence JSON")
  .requiredOption("--f0c-lane <path...>", "Linux and Windows F0c lane evidence JSON")
  .option("--receipt <path>", "write Q0 receipt JSON")
  .option("--json", "JSON output")
  .action(
    (opts: {
      generation: string;
      f0cEvidence: string;
      f0cLane: string[];
      receipt?: string;
      json?: boolean;
    }) => {
      try {
        const repoRoot = process.cwd();
        const subjectRevision = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: repoRoot,
          encoding: "utf8",
        }).trim();
        const generation = verifyNodeGeneration(
          repoRoot,
          resolve(repoRoot, opts.generation),
          subjectRevision,
        );
        const observer = new NodeOnlyProcessObserver();
        const runNodeScope = (
          scope: "status" | "doctor" | "test" | "hook",
          args: readonly string[],
          input?: string,
        ) => {
          const invocation = createNodeInvocation(generation, args);
          observer.invoke(
            invocation,
            () => {
              try {
                execFileSync(invocation.command, invocation.args, {
                  cwd: repoRoot,
                  ...invocation.options,
                  ...(input ? { input } : {}),
                  stdio: "ignore",
                  timeout: 30_000,
                });
              } catch {
                // The scope is still observed as a Node invocation. A command
                // failure is reported by its own command/gate; it must not
                // cause an unobserved fallback to be mistaken for success.
              }
            },
            scope,
          );
        };
        runNodeScope("status", ["status", "--json"]);
        runNodeScope("doctor", ["doctor", "--profile", "consumer-toolchain"]);
        runNodeScope("test", [
          "plan",
          "lint",
          "docs/plans/PLAN-L7-458-node-self-hosted-bun-ban-foundation.md",
        ]);
        runNodeScope("hook", ["hook", "work-guard"], "{}\n");
        observer.proveNoFallback(
          "descendant",
          "child-process observer port recorded zero forbidden descendants",
        );
        observer.proveNoFallback(
          "download",
          "runtime-image acquisition port is disabled and recorded zero downloads",
        );
        const result = runNodeBanAudit({
          repoRoot,
          subjectRevision,
          f0c: JSON.parse(readFileSync(opts.f0cEvidence, "utf8")) as NodeBanF0cAggregateBinding,
          node: {
            generation_id: generation.receipt.generation_id,
            lane: process.platform === "win32" ? "windows" : "linux",
            subject_revision: generation.receipt.subject_revision,
            artifact_digest: `sha256:${generation.receipt.compiled_cli.sha256}`,
            receipt_digest: generation.receipt.receipt_digest,
            runtime: "node",
          },
          f0cLanes: opts.f0cLane.map((path) => {
            const evidence = parseNodeGenerationCiEvidence(
              JSON.parse(readFileSync(resolve(repoRoot, path), "utf8")),
            );
            if (!evidence) throw new Error("invalid F0c lane evidence");
            return evidence;
          }),
          processObservations: observer.snapshot(),
          observedScopes: ["status", "doctor", "test", "hook", "descendant", "download"],
          classifyProcess: classifyRuntimeImageProcess,
        });
        if (opts.receipt)
          writeFileSync(
            resolve(repoRoot, opts.receipt),
            `${JSON.stringify(result.receipt)}\n`,
            "utf8",
          );
        process.stdout.write(
          opts.json
            ? `${JSON.stringify(result.receipt, null, 2)}\n`
            : `${nodeBanAuditMessages(result).join("\n")}\n`,
        );
        process.exitCode = result.receipt.qualification === "qualified" ? 0 : 1;
      } catch (error) {
        process.stderr.write(`node-ban-audit failed: ${String(error)}\n`);
        process.exitCode = 2;
      }
    },
  );

audit
  .command("bun-retirement")
  .description("admit the final Bun retirement from exact F0b/F0c/Q0 receipts")
  .requiredOption("--f0b <path>", "F0b sealed Node receipt JSON")
  .requiredOption("--f0c <path>", "F0c aggregate receipt JSON")
  .requiredOption("--q0 <path>", "Q0 Node-only audit receipt JSON")
  .requiredOption("--f0c-lane <path...>", "Linux and Windows F0c lane evidence JSON")
  .requiredOption("--retirement-receipt <path>", "exact final retirement admission receipt JSON")
  .option("--json", "JSON output")
  .action(
    (opts: {
      f0b: string;
      f0c: string;
      q0: string;
      f0cLane: string[];
      retirementReceipt: string;
      json?: boolean;
    }) => {
      try {
        const repoRoot = process.cwd();
        const readJson = <T>(path: string): T =>
          JSON.parse(readFileSync(resolve(repoRoot, path), "utf8")) as T;
        const retirementSubject = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: repoRoot,
          encoding: "utf8",
        }).trim();
        const lanes = opts.f0cLane.map((path) => {
          const evidence = parseNodeGenerationCiEvidence(readJson<unknown>(path));
          if (!evidence) throw new Error("invalid F0c lane evidence");
          return evidence;
        });
        const result = admitFinalBunRetirement({
          repoRoot,
          f0b: readJson<BunRetirementF0bReceipt>(opts.f0b),
          f0c: readJson<BunRetirementF0cReceipt>(opts.f0c),
          q0: readJson<BunRetirementQ0Receipt>(opts.q0),
          f0cLanes: lanes,
          retirementSubject,
          retirementReceipt: readJson<BunRetirementAdmissionReceipt>(opts.retirementReceipt),
          // The inventory is derived from the exact tracked checkout here;
          // callers cannot provide a hand-maintained all-clean list.
          surfaces: collectFinalRetirementSurfaceInventory(repoRoot),
        });
        process.stdout.write(`${JSON.stringify(result, null, opts.json ? 2 : 0)}\n`);
        process.exitCode = 0;
      } catch (error) {
        process.stderr.write(`bun-retirement-admission failed: ${String(error)}\n`);
        process.exitCode = 2;
      }
    },
  );

audit
  .command("quality")
  .description("detect hardcoded values, security risks, and technical debt markers")
  .option("--json", "JSON output")
  .option("--include-docs", "include non-archive docs in the scan")
  .option("--include-tests", "include tests in the scan")
  .option("--limit <n>", "maximum findings in text output", (value) => Number.parseInt(value, 10))
  .action(
    (opts: { json?: boolean; includeDocs?: boolean; includeTests?: boolean; limit?: number }) => {
      const result = runQualityAudit(process.cwd(), {
        includeDocs: Boolean(opts.includeDocs),
        includeTests: Boolean(opts.includeTests),
        limit: Number.isFinite(opts.limit) ? opts.limit : undefined,
      });
      if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else process.stdout.write(renderQualityAudit(result));
      process.exitCode = result.ok ? 0 : 1;
    },
  );

const branch = program.command("branch").description("read-only branch maintenance helpers");

branch
  .command("audit")
  .description("classify local branches before manual cleanup")
  .option("--json", "JSON output")
  .option("--stale-days <n>", "age threshold for stale review candidates", (value) =>
    Number.parseInt(value, 10),
  )
  .option("--limit <n>", "maximum rows in text output", (value) => Number.parseInt(value, 10))
  .action((opts: { json?: boolean; staleDays?: number; limit?: number }) => {
    try {
      const result = loadBranchAudit(process.cwd(), {
        staleDays: Number.isFinite(opts.staleDays) ? opts.staleDays : undefined,
      });
      if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else {
        process.stdout.write(
          renderBranchAudit(result, Number.isFinite(opts.limit) ? opts.limit : undefined),
        );
      }
    } catch (error) {
      process.stderr.write(`branch audit failed: ${String(error)}\n`);
      process.exitCode = 1;
    }
  });

const github = program.command("github").description("GitHub operations guards");

const githubProject = github
  .command("project")
  .description("HARNESS DB正本からGitHub Project V2へForward状態を投影する");

githubProject
  .command("sync")
  .description("Project item差分をdry-runし、--apply指定時だけ反映する")
  .requiredOption("--owner <login>", "GitHub Project owner")
  .requiredOption("--number <n>", "GitHub Project number", (value) => Number.parseInt(value, 10))
  .requiredOption("--repository <id>", "repository identity (owner/name)")
  .option("--db <path>", "harness.db path (default: .ut-tdd/harness.db)")
  .option("--plan <id>", "1 PLANだけを同期する")
  .option("--all-active", "完了・保留を除く全active PLANを同期する")
  .option("--apply", "GitHubとbinding projectionへ反映する")
  .option("--json", "JSON output")
  .action(
    (opts: {
      owner: string;
      number: number;
      repository: string;
      db?: string;
      plan?: string;
      allActive?: boolean;
      apply?: boolean;
      json?: boolean;
    }) => {
      if (!Number.isInteger(opts.number) || opts.number < 1) {
        process.stderr.write("github project sync: --number must be a positive integer\n");
        process.exitCode = 1;
        return;
      }
      if (opts.plan && opts.allActive) {
        process.stderr.write(
          "github project sync: --plan and --all-active are mutually exclusive\n",
        );
        process.exitCode = 1;
        return;
      }
      if (opts.apply && !opts.plan && !opts.allActive) {
        process.stderr.write("github project sync: --apply requires --plan or --all-active\n");
        process.exitCode = 1;
        return;
      }
      const db = openHarnessDb(opts.db ?? defaultHarnessDbPath(process.cwd()), {
        repoRoot: process.cwd(),
      });
      let outboxIds: string[] = [];
      let outboxClaimed = false;
      try {
        if (opts.apply) migrate(db);
        const projectedRows = deriveStoredForwardReadiness(db, process.cwd(), opts.repository);
        const existingProjectPlans = selectExistingProjectPlans(db, opts.repository);
        const activeRows = selectActiveProjectRows(projectedRows, existingProjectPlans);
        const rows = opts.plan
          ? projectedRows.filter((row) => row.planId === opts.plan)
          : activeRows;
        if (opts.plan && rows.length === 0) throw new Error(`PLAN not found: ${opts.plan}`);
        outboxIds = opts.apply
          ? rows.map((row) =>
              queueGithubProjection({
                db,
                repositoryId: opts.repository,
                planId: row.planId,
                planRevision: row.revision,
                operation: "project-item-upsert",
                payload: {
                  owner: opts.owner,
                  projectNumber: opts.number,
                  readiness: row.readiness,
                  currentGate: row.currentGate,
                  headSha: row.headSha,
                },
              }),
            )
          : [];
        if (opts.apply) {
          claimGithubProjection(db, outboxIds);
          outboxClaimed = true;
        }
        const result = syncForwardProject({
          rows,
          owner: opts.owner,
          projectNumber: opts.number,
          port: new GhProjectV2Adapter(),
          apply: Boolean(opts.apply),
        });
        if (opts.apply) {
          persistProjectSync({
            db,
            repositoryId: opts.repository,
            projectId: result.projectId,
            rows,
            result,
            outboxIds,
          });
        }
        if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        else
          process.stdout.write(
            `github project sync: ${result.applied ? "applied" : "dry-run"} plans=${rows.length} mutations=${result.mutations.length}\n`,
          );
      } catch (error) {
        if (opts.apply && outboxClaimed && outboxIds.length > 0)
          markGithubProjectionFailed(db, outboxIds);
        process.stderr.write(`github project sync failed: ${String(error)}\n`);
        process.exitCode = 3;
      } finally {
        db.close();
      }
    },
  );

const githubBinding = github
  .command("binding")
  .description("Issue・branch・PR・CI・review・merge観測をPLANへ結合する");

githubBinding
  .command("sync")
  .description("typed PR traceを持つGitHub PR群からlifecycle bindingを再構築する")
  .requiredOption("--repository <id>", "repository identity (owner/name)")
  .option("--db <path>", "harness.db path (default: .ut-tdd/harness.db)")
  .option("--json", "JSON output")
  .action((opts: { repository: string; db?: string; json?: boolean }) => {
    const db = openHarnessDb(opts.db ?? defaultHarnessDbPath(process.cwd()), {
      repoRoot: process.cwd(),
    });
    try {
      migrate(db);
      const result = syncRepositoryBindings({ db, repositoryId: opts.repository });
      rebuildExecutionReadiness({ db });
      if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else
        process.stdout.write(
          `github binding sync: inspected=${result.inspectedPullRequests} traced=${result.tracedPullRequests} bindings=${result.bindingIds.length} skipped=${result.skipped.length}\n`,
        );
    } catch (error) {
      process.stderr.write(`github binding sync failed: ${String(error)}\n`);
      process.exitCode = 3;
    } finally {
      db.close();
    }
  });

githubBinding
  .command("observe")
  .requiredOption("--repository <id>", "repository identity (owner/name)")
  .requiredOption("--plan <id>", "PLAN ID")
  .requiredOption("--revision <revision>", "PLAN revision/source hash")
  .requiredOption("--kind <kind>", "project_item|issue|branch|pull_request")
  .requiredOption("--object-id <id>", "provider object identity")
  .requiredOption("--state <state>", "normalized object state")
  .option("--project-item-id <id>", "Project item identity")
  .option("--url <url>", "provider URL")
  .option("--head <sha>", "subject HEAD SHA")
  .option("--json", "JSON output")
  .action(
    (opts: {
      repository: string;
      plan: string;
      revision: string;
      kind: string;
      objectId: string;
      state: string;
      projectItemId?: string;
      url?: string;
      head?: string;
      json?: boolean;
    }) => {
      if (!isManualGithubObservationKind(opts.kind)) {
        process.stderr.write(`github binding observe: unsupported kind ${opts.kind}\n`);
        process.exitCode = 1;
        return;
      }
      const db = openHarnessDb(defaultHarnessDbPath(process.cwd()), { repoRoot: process.cwd() });
      try {
        migrate(db);
        const bindingId = recordGithubBinding(db, {
          repositoryId: opts.repository,
          planId: opts.plan,
          planRevision: opts.revision,
          projectItemId: opts.projectItemId,
          objectKind: opts.kind as "project_item" | "issue" | "branch" | "pull_request",
          objectId: opts.objectId,
          objectUrl: opts.url,
          headSha: opts.head,
          state: opts.state,
        });
        const rows = rebuildExecutionReadiness({ db });
        const output = {
          ok: true,
          bindingId: bindingId ?? null,
          written: bindingId !== undefined,
          readiness: rows.find((row) => row.planId === opts.plan),
        };
        if (opts.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
        else
          process.stdout.write(
            bindingId ? `github binding observed: ${bindingId}\n` : "github binding unchanged\n",
          );
      } catch (error) {
        process.stderr.write(`github binding observe failed: ${String(error)}\n`);
        process.exitCode = 1;
      } finally {
        db.close();
      }
    },
  );

github
  .command("guard")
  .description("fail-close branch-type and commit message checks for harness-check")
  .requiredOption("--head-ref <ref>", "PR head branch ref")
  .requiredOption("--base-ref <ref>", "PR base branch ref")
  .option("--pr-title <text>", "PR title")
  .option("--pr-body-file <path>", "file containing PR body")
  .option("--commit-file <path>", "file containing one commit subject per line")
  .option("--json", "JSON output")
  .action(
    (opts: {
      headRef: string;
      baseRef: string;
      prTitle?: string;
      prBodyFile?: string;
      commitFile?: string;
      json?: boolean;
    }) => {
      const prBody =
        opts.prBodyFile && existsSync(opts.prBodyFile) ? readFileSync(opts.prBodyFile, "utf8") : "";
      const commitSubjects =
        opts.commitFile && existsSync(opts.commitFile)
          ? readFileSync(opts.commitFile, "utf8").split(/\r?\n/).filter(Boolean)
          : [];
      const result = evaluateGithubOpsGuard({
        headRef: opts.headRef,
        baseRef: opts.baseRef,
        prTitle: opts.prTitle,
        prBody,
        commitSubjects,
      });
      if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else process.stdout.write(renderGithubOpsGuard(result));
      process.exitCode = result.ok ? 0 : 1;
    },
  );

// PLAN-L7-455 (troubleshoot): 変更ファイル分類 (doc-only lane 判定、fail-close)。
// harness-check.yml の重い step (full vitest / full doctor 等) を doc-only 変更で
// skip するための判定を出す。判定不能・新種 path は必ず "full" にフォールバックする。
github
  .command("classify-changes")
  .description("git diff ベースの変更分類 (doc-only lane 判定、fail-close)")
  .requiredOption("--event-name <name>", "github.event_name")
  .requiredOption("--head-sha <sha>", "diff 対象 head SHA")
  .option("--base-sha <sha>", "pull_request の base SHA")
  .option("--before-sha <sha>", "push event の before SHA")
  .option("--github-output <path>", "GITHUB_OUTPUT へ lane=<value> を追記するファイルパス")
  .option("--json", "JSON output")
  .action(
    (opts: {
      eventName: string;
      headSha: string;
      baseSha?: string;
      beforeSha?: string;
      githubOutput?: string;
      json?: boolean;
    }) => {
      const result = runChangeLaneClassification({
        eventName: opts.eventName,
        headSha: opts.headSha,
        baseSha: opts.baseSha,
        beforeSha: opts.beforeSha,
        git: new SystemGitDiffNamesPort(process.cwd()),
      });
      if (opts.githubOutput) {
        appendFileSync(opts.githubOutput, `lane=${result.lane}\n`);
      }
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        process.stdout.write(
          `change lane: ${result.lane} (${result.reason}; range=${result.range ?? "none"}; files=${result.fileCount})\n`,
        );
      }
    },
  );

// PLAN-L7-451 W3: $GITHUB_STEP_SUMMARY 向け projection。summary 生成失敗で CI を
// red にしないため、常に exit 0 で degrade する (判定正本は gate 実測)。
github
  .command("summary")
  .description("GitHub Actions Job Summary 向け markdown を stdout へ出力 (read-only projection)")
  .option("--db <path>", "harness.db path (default: .ut-tdd/harness.db)")
  .action((opts: { db?: string }) => {
    try {
      const repoRoot = process.cwd();
      const data = collectJobSummary({
        dbPath: opts.db ?? defaultHarnessDbPath(repoRoot),
        repoRoot,
        headSha: gitHead() ?? "",
        branch: gitBranch() ?? "",
      });
      process.stdout.write(renderJobSummary(data));
    } catch (error) {
      process.stdout.write(`## UT-TDD harness summary\n\n> summary degraded: ${String(error)}\n`);
    }
  });

const githubPr = github
  .command("pr")
  .description("typed PR trace contract — <!-- ut-tdd:trace/v1 --> block (PLAN-L7-451 W4)");

githubPr
  .command("render")
  .description("PR body へ貼る trace block を生成する (手入力しない)")
  .requiredOption("--plan <planId>", "PLAN ID (PLAN-L7-451 など)")
  .requiredOption("--route-mode <mode>", "route mode (add-feature / recovery / reverse など)")
  .option("--head <sha>", "subject HEAD SHA (default: git rev-parse HEAD)")
  .option("--base <sha>", "base SHA (default: git rev-parse origin/main)")
  .option("--plan-revision <n>", "PLAN revision")
  .option("--episode-id <id>", "execution episode ID (Forward 外のみ)")
  .requiredOption("--issue-number <n>", "GitHub issue number")
  .action(
    (opts: {
      plan: string;
      routeMode: string;
      head?: string;
      base?: string;
      planRevision?: string;
      episodeId?: string;
      issueNumber: string;
    }) => {
      try {
        const resolve = (ref: string): string =>
          execFileSync("git", ["rev-parse", ref], { encoding: "utf8" }).trim();
        const block = renderPrTraceBlock({
          plan_id: opts.plan,
          route_mode: opts.routeMode,
          subject_head: opts.head ?? resolve("HEAD"),
          base_sha: opts.base ?? resolve("origin/main"),
          plan_revision: opts.planRevision,
          episode_id: opts.episodeId,
          issue_number: opts.issueNumber,
        });
        process.stdout.write(`${block}\n`);
      } catch (error) {
        process.stderr.write(`pr render failed: ${String(error)}\n`);
        process.exitCode = 1;
      }
    },
  );

githubPr
  .command("validate")
  .description("PR body の trace block を検証する (欠落・破損は fail-close)")
  .requiredOption("--body-file <path>", "PR body を書いたファイル")
  .option("--json", "JSON output")
  .action((opts: { bodyFile: string; json?: boolean }) => {
    if (!existsSync(opts.bodyFile)) {
      process.stderr.write(`pr validate: body file not found: ${opts.bodyFile}\n`);
      process.exitCode = 1;
      return;
    }
    const result = validatePrTraceBody(readFileSync(opts.bodyFile, "utf8"));
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (result.ok) {
      process.stdout.write(`pr trace — OK (plan_id=${result.fields.plan_id})\n`);
    } else {
      process.stdout.write("pr trace — FAIL\n");
      for (const finding of result.findings) {
        process.stdout.write(`  - [${finding.code}] ${finding.message}\n`);
      }
    }
    process.exitCode = result.ok ? 0 : 1;
  });

// PLAN-L7-451 W6: repository policy 監査 (read-only)。適用操作は含めない。
const githubPolicy = github
  .command("policy")
  .description("repository policy 監査 — authoring source と GitHub 現物の照合 (read-only)");

const REPOSITORY_POLICY_PATH = "docs/governance/github-repository-policy.yaml";

function fetchRulesetsViaGh(repository: string): unknown[] {
  const list = JSON.parse(
    execFileSync("gh", ["api", `repos/${repository}/rulesets?includes_parents=true`], {
      encoding: "utf8",
    }),
  ) as Array<Record<string, unknown>>;
  return list.map((entry) =>
    JSON.parse(
      execFileSync("gh", ["api", `repos/${repository}/rulesets/${String(entry.id)}`], {
        encoding: "utf8",
      }),
    ),
  );
}

githubPolicy
  .command("inspect")
  .description("GitHub 現物の Rulesets を取得して表示する")
  .action(() => {
    try {
      const policy = parseRepositoryPolicy(readFileSync(REPOSITORY_POLICY_PATH, "utf8"));
      const rulesets = fetchRulesetsViaGh(policy.repository);
      process.stdout.write(`${JSON.stringify(normalizeRulesets(rulesets), null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`policy inspect failed (gh/外部障害): ${String(error)}\n`);
      process.exitCode = 3;
    }
  });

githubPolicy
  .command("diff")
  .description("authoring source と現物の乖離を finding 列挙 (乖離 exit 1 / gh 障害 exit 3)")
  .option("--observed-file <path>", "gh を使わず観測 JSON (raw rulesets) をファイルから読む")
  .action((opts: { observedFile?: string }) => {
    let policy: ReturnType<typeof parseRepositoryPolicy>;
    try {
      policy = parseRepositoryPolicy(readFileSync(REPOSITORY_POLICY_PATH, "utf8"));
    } catch (error) {
      process.stderr.write(`policy diff failed (authoring source): ${String(error)}\n`);
      process.exitCode = 1;
      return;
    }
    let observedRaw: unknown;
    try {
      observedRaw = opts.observedFile
        ? JSON.parse(readFileSync(opts.observedFile, "utf8"))
        : fetchRulesetsViaGh(policy.repository);
    } catch (error) {
      process.stderr.write(`policy diff failed (gh/外部障害): ${String(error)}\n`);
      process.exitCode = 3;
      return;
    }
    const result = diffRepositoryPolicy(policy, normalizeRulesets(observedRaw));
    process.stdout.write(renderPolicyDiff(result));
    process.exitCode = result.ok ? 0 : 1;
  });

registerFeedbackCommands(program);
registerPrMergeCommands(program);
registerForwardWorkflowCommands(program);

program
  .command("setup")
  .description(
    "solo/team を検出・提案・確認して GitHub 設定を出し分け生成 (Phase 0-A/0-B、要件 §6.5)",
  )
  .option("--solo", "Phase 0-A (solo) を強制 (自動提案の上書き)")
  .option("--team", "Phase 0-B (team) を強制 (自動提案の上書き)")
  .option("--dry-run", "生成物一覧のみ表示 (書き込まない)")
  .option("--apply-branch-protection", "branch protection を対話下で適用 (既定は emit-only)")
  .option("--tl-team <slug>", "CODEOWNERS の TL team slug")
  .option("--qa-team <slug>", "CODEOWNERS の QA team slug")
  .option("--po-team <slug>", "CODEOWNERS の PO team slug")
  .option(
    "--consumer-runtime-input <path>",
    "sealed consumer runtime input JSON emitted by the release materializer",
  )
  .action(
    async (opts: {
      solo?: boolean;
      team?: boolean;
      dryRun?: boolean;
      applyBranchProtection?: boolean;
      tlTeam?: string;
      qaTeam?: string;
      poTeam?: string;
      consumerRuntimeInput?: string;
    }) => {
      if (opts.solo && opts.team) {
        process.stderr.write("--solo と --team は同時指定できません (どちらか一方)\n");
        process.exitCode = 1;
        return;
      }
      const teamCount = [opts.tlTeam, opts.qaTeam, opts.poTeam].filter(Boolean).length;
      if (opts.team && teamCount === 0) {
        process.stderr.write(
          "--team requires --tl-team / --qa-team / --po-team so generated CODEOWNERS never ships with unresolved team placeholders.\n",
        );
        process.exitCode = 1;
        return;
      }
      if (teamCount > 0 && teamCount < 3) {
        process.stderr.write(
          "--tl-team / --qa-team / --po-team は 3 つとも指定してください (CODEOWNERS の @TODO 混入防止)\n",
        );
        process.exitCode = 1;
        return;
      }
      const deps = nodeSetupDeps(process.cwd());
      const phase = opts.solo ? "0-A" : opts.team ? "0-B" : undefined;
      const teams =
        teamCount === 3
          ? { tl: opts.tlTeam as string, qa: opts.qaTeam as string, po: opts.poTeam as string }
          : undefined;
      let consumerRuntime: SetupArgs["consumerRuntime"];
      if (opts.consumerRuntimeInput) {
        try {
          const value = JSON.parse(readFileSync(opts.consumerRuntimeInput, "utf8")) as {
            identity?: SetupConsumerRuntimeInput["identity"];
            admission_input?: unknown;
            compiled_esm_base64?: unknown;
            node_bootstrap_receipt_base64?: unknown;
          };
          if (
            !value.identity ||
            !value.admission_input ||
            typeof value.compiled_esm_base64 !== "string" ||
            typeof value.node_bootstrap_receipt_base64 !== "string"
          )
            throw new Error(
              "identity/admission_input/compiled_esm_base64/node_bootstrap_receipt_base64 are required",
            );
          const rawAdmission = value.admission_input as Record<string, unknown>;
          const rawAggregate = rawAdmission.aggregate_input as Record<string, unknown>;
          const rawFinalTree = rawAggregate?.final_tree as Record<string, unknown>;
          const rawAttestation = rawAggregate?.attestation as Record<string, unknown>;
          const rawAttestationEntries = rawAttestation?.entries;
          if (
            !rawAggregate ||
            !rawFinalTree ||
            !Array.isArray(rawFinalTree.manifestEntries) ||
            !Array.isArray(rawFinalTree.sourcePaths) ||
            !Array.isArray(rawFinalTree.cleanPackAllowlist) ||
            !Array.isArray(rawFinalTree.channelMappings) ||
            typeof rawAggregate.repository !== "string" ||
            typeof rawAggregate.channel !== "string" ||
            !rawAttestation ||
            rawAttestation.status !== "attested" ||
            typeof rawAttestation.releaseId !== "string" ||
            typeof rawAttestation.artifactSourceCommit !== "string" ||
            typeof rawAttestation.expectedDigest !== "string" ||
            typeof rawAttestation.actualDigest !== "string" ||
            !Array.isArray(rawAttestationEntries) ||
            typeof rawAdmission.control_manifest_base64 !== "string"
          )
            throw new Error(
              "admission_input.aggregate_input/final_tree/attestation/control_manifest_base64 are required",
            );
          const attestation = {
            status: "attested" as const,
            releaseId: rawAttestation.releaseId,
            artifactSourceCommit: rawAttestation.artifactSourceCommit,
            expectedDigest: rawAttestation.expectedDigest,
            actualDigest: rawAttestation.actualDigest,
            entries: rawAttestationEntries.map((entry) => {
              const item = entry as Record<string, unknown>;
              if (
                typeof item.path !== "string" ||
                typeof item.mode !== "string" ||
                typeof item.content_base64 !== "string"
              )
                throw new Error("aggregate attestation entry is invalid");
              if (item.mode !== "100644" && item.mode !== "100755" && item.mode !== "120000")
                throw new Error("aggregate attestation entry mode is invalid");
              return {
                path: item.path,
                mode: item.mode,
                content: Buffer.from(item.content_base64, "base64"),
              };
            }),
          } satisfies Extract<ReleaseChannelAttestation, { status: "attested" }>;
          const aggregateInput = {
            repository: rawAggregate.repository,
            channel: rawAggregate.channel,
            finalTree: rawFinalTree,
          } as unknown as ReleaseAggregateAdmissionInput;
          const aggregate = await admitReleaseAggregate(aggregateInput, {
            attestChannel: async () => attestation,
          });
          if (!aggregate.ok) throw new Error(`consumer_runtime_aggregate_${aggregate.error}`);
          const admissionInput = {
            ...rawAdmission,
            plan: {
              ...aggregate.plan,
            },
            controlManifestBytes: Buffer.from(rawAdmission.control_manifest_base64, "base64"),
          } as unknown as ConsumerLocalRuntimeAdmissionInput;
          const admitted = admitConsumerLocalRuntime(admissionInput);
          if (!admitted.ok) throw new Error(`consumer_runtime_aggregate_${admitted.error}`);
          consumerRuntime = {
            identity: value.identity,
            admission: admitted.admission,
            compiled_esm: Buffer.from(value.compiled_esm_base64, "base64"),
            node_bootstrap_receipt: Buffer.from(value.node_bootstrap_receipt_base64, "base64"),
          };
        } catch (error) {
          process.stderr.write(`--consumer-runtime-input invalid: ${String(error)}\n`);
          process.exitCode = 1;
          return;
        }
      }
      const args: SetupArgs = {
        ...(phase ? { phase } : {}),
        dryRun: Boolean(opts.dryRun),
        applyBranchProtection: Boolean(opts.applyBranchProtection),
        ...(teams ? { teams } : {}),
        ...(consumerRuntime ? { consumerRuntime } : {}),
      };
      const r = await runSetupAsync(args, deps);
      process.stdout.write(`phase: ${r.phase}${args.dryRun ? " (dry-run)" : ""}\n`);
      for (const w of r.written) process.stdout.write(`  ${args.dryRun ? "·" : "+"} ${w}\n`);
      process.stdout.write(
        `branch-protection: ${
          r.branchProtection.applied ? "applied" : `skipped (${r.branchProtection.reason})`
        }\n`,
      );
      if (r.phase === "0-B" && r.branchProtection.reason === "emit-only") {
        process.stdout.write(
          "  → scripts/setup-branch-protection.sh を生成。admin 権限の人間が実行してください (本番 merge ゲート変更)\n",
        );
      }
    },
  );

const memory = program.command("memory").description("shared cross-runtime project memory");
memory
  .command("add")
  .description("write a shared memory entry under .ut-tdd/memory")
  .requiredOption("--title <title>", "memory title")
  .option("--kind <kind>", "project | feedback | reference | user", "project")
  .option("--body <text>", "memory body")
  .option("--body-file <path>", "read memory body from a UTF-8 file")
  .option("--tags <csv>", "comma-separated tags")
  .option("--notify-claude", "deliver this memory to an active Claude session immediately")
  .option("--operation-id <id>", "stable delivery operation id")
  .option("--receipt-json", "print the registration receipt as one JSON line")
  .action(
    (opts: {
      title: string;
      kind: string;
      body?: string;
      bodyFile?: string;
      tags?: string;
      notifyClaude?: boolean;
      operationId?: string;
      receiptJson?: boolean;
    }) => {
      const body = opts.bodyFile ? readFileSync(opts.bodyFile, "utf8") : (opts.body ?? "");
      const tags = opts.tags
        ? opts.tags
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean)
        : [];
      try {
        const repoRoot = requireRuntimeRepoRoot({ allowCwdFallback: true });
        const project = requireProjectMemoryRoot(repoRoot);
        const entry = writeMemory({
          repoRoot: project.canonicalProjectRoot,
          input: {
            kind: opts.kind as MemoryKind,
            title: opts.title,
            body,
            tags,
          },
        });
        process.stdout.write(`memory: wrote ${entry.source_path}\n`);
        const operationId = opts.operationId?.trim() || entry.content_hash.slice(0, 16);
        if (opts.notifyClaude) {
          const mode = detectMode();
          const originRuntime = mode.currentRuntime === "claude" ? "system" : "codex";
          const target = resolveLiveClaudeTarget(repoRoot);
          if (!target.ok) throw new Error(target.reason);
          const notification = buildClaudeProviderInboxEntry({
            memory: entry,
            projectId: project.projectId,
            operationId,
            workspaceId: target.workspaceId,
            producer: {
              provider: originRuntime === "codex" ? "codex" : "claude",
              sessionId: resolveRuntimeSessionId(),
            },
            target: { scope: "session", provider: "claude", sessionId: target.sessionId },
          });
          const deliveryPath = publishClaudeInboxEntry(repoRoot, notification);
          process.stdout.write(`memory: notified Claude via ${deliveryPath}\n`);
        }
        if (opts.receiptJson) {
          const writtenPath = join(project.canonicalProjectRoot, entry.source_path);
          const rawText = readFileSync(writtenPath, "utf8");
          const receipt = registrationReceiptFor({ entry, rawText, operationId });
          process.stdout.write(`${JSON.stringify(receipt)}\n`);
        }
      } catch (error) {
        process.stderr.write(`memory: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }
    },
  );

memory
  .command("list")
  .description("list shared memory entries (source=.ut-tdd/memory files, harness.db=index)")
  .option("--query <text>", "filter by text")
  .option("--limit <n>", "maximum rows", "20")
  .action((opts: { query?: string; limit?: string }) => {
    const result = readMemoryThroughService(process.cwd(), {
      query: opts.query,
      limit: Number(opts.limit ?? 20),
    });
    process.stdout.write(renderMemoryList(result.entries));
    process.stderr.write(renderMemoryHealth(result));
  });

memory
  .command("recall")
  .description("render shared memory context (source=.ut-tdd/memory files, harness.db=index)")
  .option("--query <text>", "filter by text")
  .option("--limit <n>", "maximum rows", "5")
  .action((opts: { query?: string; limit?: string }) => {
    const result = readMemoryThroughService(process.cwd(), {
      query: opts.query,
      limit: Number(opts.limit ?? 5),
    });
    const block = renderMemorySurface(result.entries);
    process.stdout.write(block || "memory: no entries\n");
    process.stderr.write(renderMemoryHealth(result));
  });

const elicit = program
  .command("elicit")
  .description("design-decision elicitation bound to the current V-model stage (PLAN-L7-428)");
elicit
  .command("context")
  .description(
    "resolve current stage + skill decision defaults + design coverage into an elicitation packet",
  )
  .option("--plan <plan_id>", "target PLAN (default: first ready schedule row)")
  .option("--json", "JSON output")
  .action((opts: { plan?: string; json?: boolean }) => {
    const repoRoot = process.cwd();
    const db = openHarnessDb(defaultHarnessDbPath(repoRoot), { repoRoot });
    try {
      const ctx = selectElicitationContext(db, { repoRoot, planId: opts.plan });
      process.stdout.write(
        opts.json ? `${JSON.stringify(ctx, null, 2)}\n` : renderElicitationContext(ctx),
      );
    } finally {
      db.close();
    }
  });
elicit
  .command("record")
  .description(`append an adopted design decision to ${DESIGN_DECISION_LOG_PATH}`)
  .requiredOption("--plan <plan_id>", "PLAN the decision belongs to")
  .requiredOption("--topic <text>", "what was decided (判断の種別)")
  .requiredOption("--chosen <text>", "adopted option")
  .requiredOption("--reason <text>", "why it was adopted")
  .option("--options <csv>", "comma-separated candidate options")
  .action(
    (opts: { plan: string; topic: string; chosen: string; reason: string; options?: string }) => {
      const repoRoot = process.cwd();
      let currentLocation = "";
      try {
        const db = openHarnessDb(defaultHarnessDbPath(repoRoot), { repoRoot });
        try {
          const ctx = selectElicitationContext(db, { repoRoot, planId: opts.plan });
          currentLocation = ctx.stage?.current_location ?? "";
        } finally {
          db.close();
        }
      } catch {
        // fail-open: 工程表 stage が引けなくても記録は成立させる
      }
      try {
        const record = appendDesignDecision(repoRoot, {
          planId: opts.plan,
          currentLocation,
          topic: opts.topic,
          options: opts.options?.split(",") ?? [],
          chosen: opts.chosen,
          reason: opts.reason,
          sessionId: resolveRuntimeSessionId(),
        });
        process.stdout.write(
          `elicit: recorded ${record.plan_id}${record.current_location ? ` @ ${record.current_location}` : ""} → ${DESIGN_DECISION_LOG_PATH}\n`,
        );
        process.stdout.write(
          "elicit: 正本への転記を忘れずに (PLAN 設計判断節 / ADR、governance §共通ルール 7)\n",
        );
      } catch (error) {
        process.stderr.write(`elicit: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }
    },
  );

registerDistributionCommands(program);

const context = program
  .command("context")
  .description("startup context tiering (canonical doc section routing, PLAN-L7-302)");
context
  .command("suggest")
  .description("suggest which canonical doc sections to read for a task (tier-1 dynamic load)")
  .option("--task <text>", "free-text task (classified into kind → routed sections)")
  .option("--task-file <path>", TASK_FILE_OPTION_DESCRIPTION)
  .option("--json", "JSON output")
  .action((opts: { task?: string; taskFile?: string; json?: boolean }) => {
    const taskText = resolveTaskText(opts);
    if (taskText === null) {
      process.stderr.write("context suggest requires exactly one of --task or --task-file\n");
      process.exitCode = 1;
      return;
    }
    const repoRoot = process.cwd();
    const classification = classifyTask({ text: taskText });
    const result = contextSuggest(repoRoot, classification.kind);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    if (result.fail_open) {
      process.stdout.write(
        `context suggest — kind=${result.kind}: 全文読み推奨 (${result.fail_open_reason})\n`,
      );
      return;
    }
    process.stdout.write(
      `context suggest — kind=${result.kind}: ${result.sections.length} セクション\n`,
    );
    for (const s of result.sections) {
      process.stdout.write(
        `  ${s.path}:${s.start_line}-${s.end_line}  ${s.heading}  (matched: ${s.matched})\n`,
      );
    }
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  process.stderr.write(`${String(e)}\n`);
  process.exitCode = 1;
});
