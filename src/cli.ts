#!/usr/bin/env bun
/**
 * UT-TDD Agent Harness CLI (TypeScript core, ADR-001).
 * 薄い OS 別 entrypoint (scripts/ut-tdd, ut-tdd.ps1) が本 core を呼ぶ。
 * status / doctor / plan lint / vmodel lint / gate / runtime adapter を集約する。
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { parse as parseYaml } from "yaml";
import {
  catalogAutomationAssets,
  checkRosterConsistency,
  listRosterRegistry,
} from "./assets/catalog";
import { loadBranchAudit, renderBranchAudit } from "./audit/branches";
import { renderQualityAudit, runQualityAudit } from "./audit/quality";
import { adapterExecutionEnv, executeAdapterPlanForCli } from "./cli/delegation";
import { registerDistributionCommands } from "./cli/distribution";
import { registerFeedbackCommands } from "./cli/feedback";
import { runDoctor } from "./doctor";
import { computeSkillMetrics } from "./feedback/engine";
import { renderTakeoverFeedback, selectTakeoverFeedback } from "./feedback/surface";
import { evaluateGateReview, loadReviewChecklistIfPresent } from "./gate/review-tier";
import { evaluateStaticGate } from "./gate/static";
import { evaluateGithubOpsGuard, renderGithubOpsGuard } from "./github/ops-guard";
import { loadRelationGraphSourceSet } from "./graph/loader";
import {
  checkHandoverBypass,
  checkHandoverDiscipline,
  latestSessionId,
  nodeHandoverDeps,
  runHandover,
  setActivePlanCli,
} from "./handover/index";
import { loadChangedFiles, loadStagedFiles } from "./lint/change-impact";
import { computeOutstandingWork, outstandingSummaryLine } from "./lint/outstanding";
import {
  analyzeRelationImpact,
  collectRelationGraphProjection,
  exportRelationDiagram,
  type RelationDiagramAdapter,
} from "./lint/relation-graph";
import {
  inspectMcpProfile,
  listVerificationProfiles,
  nodeVerificationProbeDeps,
  probeVerificationProfile,
  recommendVerificationProfiles,
  runVerificationProfile,
  saveVerificationEvidence,
  verificationRecommendationMermaid,
} from "./lint/verification-profile";
import {
  type MemoryKind,
  renderMemoryList,
  renderMemorySurface,
  selectMemoryEntries,
  writeMemoryEntry,
} from "./memory/index";
import { lintPlanWithGate } from "./plan/lint";
import {
  type AdapterContextInjection,
  type AdapterProvider,
  buildAdapterPlan,
  buildProviderInvocation,
} from "./runtime/adapter";
import {
  type AgentGuardInput,
  evaluateAgentGuard,
  normalizeModelFamily,
  type ResolvedFamily,
} from "./runtime/agent-guard";
import { SUBAGENT_ALLOWLIST } from "./runtime/agent-guard-policy";
import {
  nodeAgentSlotsDeps,
  recordGuardFire,
  releaseOldestGuardSlot,
  sweepStaleGuardSlots,
} from "./runtime/agent-slots";
import {
  attemptsFromSessionEvents,
  evaluateAttemptEscalation,
  renderEscalationSignals,
  selectPrecedingSessionFile,
} from "./runtime/attempt-escalation";
import { detectMode, nextActionForMode, type RuntimeDetection } from "./runtime/detect";
import { scanDanglingStops } from "./runtime/forced-stop";
import {
  nodeProviderHandoverDeps,
  type ProviderRuntime,
  readProviderHandoverCurrent,
  runProviderHandover,
} from "./runtime/provider-handover";
import {
  assessReviewSession,
  isReadOnlyDelegationRole,
  reviewGuardMessages,
  summarizeStagedReview,
} from "./runtime/review-guard";
import {
  dispatch,
  nodeDeps,
  parseSessionEvents,
  recordSkillInjectionAttempt,
  resolveActivePlan,
  type SessionHookInput,
  safeName,
} from "./runtime/session-log";
import {
  evaluateWorkGuardTargets,
  extractEditTargets,
  normalizeRepoRelative,
  resolveForeignEditOverride,
} from "./runtime/work-guard";
import { findReference } from "./search/index";
import { nodeSetupDeps, runSetup, type SetupArgs } from "./setup/index";
import {
  bucketRecommendations,
  buildSkillInjectionSet,
  recommendSkillsForPlan,
  recommendSkillsForText,
  recordSkillRecommendations,
} from "./skill-engine/recommend";
import { type SkillCategory, scaffoldSkill } from "./skill-engine/scaffold";
import { defaultHarnessDbPath, openHarnessDb } from "./state-db/index";
import { harnessDbStatus } from "./state-db/maintenance";
import { migrate } from "./state-db/migration";
import {
  projectModelEvaluations,
  projectTokenUsage,
  rebuildHarnessDb,
} from "./state-db/projection-writer";
import { loadRuntimeSessionUsage, summarizeRunUsage } from "./state-db/token-tracker";
import { classifyProposalDocumentCoverage, classifyTask } from "./task/classify";
import {
  type Provider,
  type RouterRole,
  roster,
  route,
  routeTeamMembers,
  routeToAdapterPlan,
} from "./task/tier-router";
import { buildAdvisorDecision } from "./team/advisor-policy";
import { recommendTeamLaunch } from "./team/launch-policy";
import {
  buildTeamRunPlan,
  executeTeamRunPlan,
  loadTeamDefinition,
  type MemberPlacement,
} from "./team/run";
import { formatVmodelInjection, resolveVmodelInjection } from "./vmodel/injection";
import { lintVmodel } from "./vmodel/lint";
import {
  buildCommandCatalog,
  evaluateRouteCommand,
  type RouteApprovalPolicy,
  type RouteConfigViolation,
  type RouteEvalResult,
  type RouteSignalEntry,
  validateRouteConfigText,
} from "./workflow/contracts";
import { evaluateAutomationReadiness } from "./workflow/readiness";

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

/** review-guard 用: loadChangedFiles を fail-open でラップ (非 git / 一時失敗で委譲を壊さない、IMP-137)。 */
function safeLoadChangedFiles(repoRoot: string): string[] {
  try {
    return loadChangedFiles(repoRoot);
  } catch {
    // guard probe は best-effort。git が無い/失敗しても委譲本体は止めない (fail-open)。
    return [];
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
      rebuildHarnessDb({ repoRoot, db });
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

function runSessionStartSideEffects(
  repoRoot: string,
  input: SessionHookInput,
  deps: ReturnType<typeof nodeDeps>,
): void {
  try {
    scanDanglingStops(deps, input.session_id);
    sweepStaleGuardSlots(nodeAgentSlotsDeps(repoRoot));
  } catch {
    // fail-open: lifecycle maintenance must not block the runtime.
  }
  surfaceTakeoverFeedbackToStdout(repoRoot);
  surfaceMemoryToStdout(repoRoot);
  surfaceAttemptEscalationToStdout(repoRoot, input.session_id);
}

/**
 * 引き継ぎ (SessionStart) 時に **直前 session** の連続失敗ループ (Iron Law escalation) を surface
 * する (PLAN-RECOVERY-05 item 2、Q2=b)。harness.db には書かず、直前 session の jsonl ログを都度
 * 再導出する (core rebuild の入力境界を広げない)。現セッションを除いた最新 1 ファイルのみを読むため
 * 古い失敗は再浮上しない。独立した fail-open: ログ不在 / 破損で runtime を止めない。
 */
function surfaceAttemptEscalationToStdout(repoRoot: string, currentSessionId?: string): void {
  try {
    const dir = join(repoRoot, ".ut-tdd", "logs", "session");
    if (!existsSync(dir)) return;
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }));
    const currentName = currentSessionId ? `${safeName(currentSessionId)}.jsonl` : undefined;
    const preceding = selectPrecedingSessionFile(files, currentName);
    if (!preceding) return;
    const events = parseSessionEvents(readFileSync(join(dir, preceding), "utf8"));
    const signals = evaluateAttemptEscalation(attemptsFromSessionEvents(events));
    const block = renderEscalationSignals(signals);
    if (block) process.stdout.write(block);
  } catch {
    // fail-open: escalation surface は best-effort。
  }
}

/**
 * 引き継ぎ (SessionStart) 時に harness.db の open feedback をエージェントへ surface する
 * (PLAN-L7-110)。stale な prose handover や、共有 working tree の都度計測ではなく、DB を
 * 正本として feedback を「受け取る」経路。独立した fail-open: Codex の並行 db rebuild と競合して
 * ロックされても、引き継ぎ維持処理 (上) も runtime も阻害しない。
 */
function surfaceTakeoverFeedbackToStdout(repoRoot: string): void {
  try {
    const db = openHarnessDb(defaultHarnessDbPath(repoRoot), { repoRoot });
    try {
      const block = renderTakeoverFeedback(selectTakeoverFeedback(db));
      if (block) process.stdout.write(block);
    } finally {
      db.close();
    }
  } catch {
    // fail-open: feedback surface は best-effort。DB 不在 / ロック / 破損で runtime を止めない。
  }
}

function surfaceMemoryToStdout(repoRoot: string): void {
  try {
    const db = openHarnessDb(defaultHarnessDbPath(repoRoot), { repoRoot });
    try {
      const block = renderMemorySurface(selectMemoryEntries(db, { limit: 5 }));
      if (block) process.stdout.write(block);
    } finally {
      db.close();
    }
  } catch {
    // fail-open: memory surface is shared context, not a runtime blocker.
  }
}

const program = new Command();
program
  .name("ut-tdd")
  .description("UT-TDD Agent Harness (TypeScript core, ADR-001)")
  .version("0.1.0");

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
    if (opts.json) {
      // 既存 6 フィールド (camelCase 公開契約) に nextAction + outstanding を additive に付加する
      // (A-138 ITEM-1、PLAN-L7-84、IMP-139、taxonomy=current)。判断ゲートの進め方 + 未了量を提示。
      process.stdout.write(`${JSON.stringify({ ...d, nextAction, outstanding }, null, 2)}\n`);
    } else {
      process.stdout.write(
        `mode: ${d.mode}  (claude=${d.claude}, codex=${d.codex}, current=${d.currentRuntime ?? "-"})\n`,
      );
      process.stdout.write(`next: ${nextAction}\n`);
      process.stdout.write(`${outstandingSummaryLine(outstanding)}\n`);
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
  .action(
    (opts: {
      strictTelemetryProvenance?: boolean;
      strictGreenCommandDigest?: boolean;
      setupSmoke?: boolean;
    }) => {
      const r = runDoctor(undefined, {
        strictTelemetryProvenance: opts.strictTelemetryProvenance === true,
        strictGreenCommandDigest: opts.strictGreenCommandDigest === true,
        setupSmoke: opts.setupSmoke === true,
      });
      for (const m of r.messages) process.stdout.write(`${m}\n`);
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

const session = program.command("session").description("session-log runtime events");
session
  .command("start")
  .description("record SessionStart through the shared session-log core")
  .option("--session <id>", SESSION_OPTION_DESCRIPTION)
  .action((opts: { session?: string }) => {
    const input = readHookInput(HOOK_EVENT_SESSION_START, opts.session);
    const repoRoot = process.cwd();
    const deps = nodeDeps(repoRoot, gitBranch, gitHead);
    runSessionStartSideEffects(repoRoot, input, deps);
    dispatch(input, deps, HOOK_EVENT_SESSION_START);
    process.stdout.write(`session-log: start ${input.session_id ?? "ut-tdd-cli"}\n`);
  });

session
  .command("summary")
  .description("compress session events into PLAN digest and surface handover discipline warnings")
  .option("--session <id>", SESSION_OPTION_DESCRIPTION)
  .action((opts: { session?: string }) => {
    const input = readHookInput("Stop", opts.session);
    dispatch(input, nodeDeps(process.cwd(), gitBranch, gitHead), "Stop");
    writeHandoverWarnings();
    process.stdout.write(`session-log: summary ${input.session_id ?? "ut-tdd-cli"}\n`);
  });

const hook = program.command("hook").description("package-local hook entrypoints");
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
      dispatch(
        {
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
        },
        nodeDeps(process.cwd(), gitBranch, gitHead),
        "PostToolUse",
      );
      process.stdout.write(`session-log: post-tool-use ${input.session_id ?? "ut-tdd-cli"}\n`);
    },
  );

hook
  .command("agent-guard")
  .description("PreToolUse(Agent|Task): enforce subagent allowlist and declared model family")
  .action(() => {
    const repoRoot = process.cwd();
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
  .description("PreToolUse(Edit|Write|MultiEdit/apply_patch|write_file): block foreign edits")
  .action(() => {
    const repoRoot = process.cwd();
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
    const released = releaseOldestGuardSlot(nodeAgentSlotsDeps(process.cwd()));
    process.stdout.write(
      released
        ? `agent-slots: released ${released.slot_id} (${released.agent_kind})\n`
        : "agent-slots: no running guard slot to release\n",
    );
  });

const guard = program.command("guard").description("manual guard checks for non-hooked runtimes");
guard
  .command("preflight")
  .description("run work-guard before hosted/API edits that cannot execute repo-local Codex hooks")
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
    const r = rebuildHarnessDb({ repoRoot: process.cwd() });
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
  });

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
        mkdirSync(dirname(absolute), { recursive: true });
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

program
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
      const doctor = runDoctor();
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
    const doctor = runDoctor();
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
      checks: ["bun run src\\cli.ts doctor", "bun run src\\cli.ts db status --json"],
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
  mkdirSync(auditDir, { recursive: true });
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
  .action(
    (opts: {
      signal: string;
      env?: string;
      driftType?: string;
      findingType?: string;
      routeMap?: string;
      format?: string;
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
      if (opts.format === "json") {
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
      const mode = opts.mode ?? detectMode().mode;
      const decision = buildAdvisorDecision({
        task,
        mode,
        provider: opts.provider as AdapterProvider | undefined,
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
            `advisor: provider=${decision.provider} model=${decision.model} effort=${decision.effort} intent=${decision.task_intent} lower=${decision.current_model_lower_than_advisor} dry-run\n`,
          );
          process.stdout.write(`  - ${decision.reason}\n`);
          process.stdout.write(
            `  - dispatch: command=${decision.adapterPlan.command} args=[${decision.adapterPlan.args.join(" ")}]\n`,
          );
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
      const output = {
        ...decision,
        adapterPlan: {
          ...decision.adapterPlan,
          ...execution,
          dry_run: false,
        },
      };
      if (opts.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      else {
        process.stdout.write(
          `advisor executed: provider=${decision.provider} model=${decision.model} exit=${execution.exit_code ?? "null"}\n`,
        );
      }
      process.exitCode = execution.exit_code ?? 1;
    },
  );

function runtimeCommand(provider: AdapterProvider): Command {
  return (
    program
      .command(provider)
      .description(`${provider} runtime adapter command`)
      .requiredOption("--role <role>", "delegation role")
      .option("--task <text>", "task text")
      .option("--task-file <path>", TASK_FILE_OPTION_DESCRIPTION)
      .option("--plan <id>", "PLAN id")
      // PLAN-L7-255: per-call model/effort 注入。config.toml / settings の既定 model を
      // 呼び出し単位で上書きし、spark/mini 級の軽量 lane を governed 経路で使えるようにする。
      .option("--model <model>", "provider model override for this call")
      .option("--effort <level>", "provider reasoning effort override for this call")
      .option("--execute", "execute provider CLI instead of dry-run")
      .option("--json", "JSON output")
      .action(
        (opts: {
          role: string;
          task?: string;
          taskFile?: string;
          plan?: string;
          model?: string;
          effort?: string;
          execute?: boolean;
          json?: boolean;
        }) => {
          const task = resolveTaskText(opts);
          if (!task) {
            process.stderr.write("adapter requires exactly one of --task or --task-file\n");
            process.exitCode = 1;
            return;
          }
          const mode = detectMode().mode;
          const contextInjection = resolveSkillContextInjection(opts.plan);
          const plan = buildAdapterPlan(
            {
              provider,
              role: opts.role,
              task,
              planId: opts.plan,
              model: opts.model,
              effort: opts.effort,
              execute: Boolean(opts.execute),
              contextInjection,
            },
            mode,
          );
          if (!plan.available) {
            process.stderr.write(`${plan.messages.join("\n")}\n`);
            process.exitCode = 1;
            return;
          }
          // dry-run (非 execute) は plan JSON を出して終了。plan.dry_run は execute=false ゆえ true。
          // --json は出力形式であって実行抑止ではない (team run と同契約)。--execute --json は
          // 実行まで進み、末尾で実行結果 JSON (dry_run=false, exit_code) を返す。
          if (!opts.execute) {
            process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
            return;
          }
          const jsonOut = Boolean(opts.json);
          const sessionId = `${provider}-${Date.now()}`;
          const repoRoot = process.cwd();
          const deps = nodeDeps(repoRoot, gitBranch, gitHead);
          const startInput: SessionHookInput = {
            hook_event_name: HOOK_EVENT_SESSION_START,
            session_id: sessionId,
            ...(opts.plan ? { plan_id: opts.plan } : {}),
          };
          runSessionStartSideEffects(repoRoot, startInput, deps);
          dispatch(startInput, deps, HOOK_EVENT_SESSION_START);
          // review-guard (IMP-137): read-only (相談/検証) ロールの委譲 session が working tree を
          // 変更したら検知するため、spawn 前の変更パスを snapshot する。
          const guardActive = isReadOnlyDelegationRole(opts.role);
          const treeBefore = guardActive ? safeLoadChangedFiles(repoRoot) : [];
          const invocation = buildProviderInvocation({
            provider,
            command: plan.command,
            args: plan.args,
          });
          const child = spawnSync(invocation.command, invocation.args, {
            // Provider prompts are passed through stdin; argv carries only fixed
            // command flags so shell metacharacters and tool markup stay inert.
            // codex はプロンプトを stdin で受ける (plan.stdin)。cmd.exe shell-wrap が
            // 引数の改行/メタ文字を切り詰めるのを回避する (PLAN-L7-77)。
            input: plan.stdin,
            // json 時は provider の stdout を fd 2 (stderr) へ逃がし、parent stdout を実行結果 JSON
            // 専用に保つ (機械パース可能性を守る)。非 json は従来どおり stdout を inherit。
            stdio:
              plan.stdin === undefined
                ? ["inherit", jsonOut ? 2 : "inherit", "inherit"]
                : ["pipe", jsonOut ? 2 : "inherit", "inherit"],
            env: adapterExecutionEnv(provider, plan.env),
            shell: invocation.shell ?? false,
            windowsVerbatimArguments: invocation.windowsVerbatimArguments ?? false,
          });
          if (child.error) {
            // spawn 自体の失敗 (ENOENT 等) は status=null のまま沈黙するため理由を surface する (A-128 F-5 / IMP-130(d))。
            process.stderr.write(`${provider}: failed to launch (${String(child.error)})\n`);
          }
          if (guardActive) {
            // read-only 委譲が tree を変更したら warning で surface する (検知/隔離、IMP-137)。
            // exit code は変えない (レビュー成果は有効でも、混入を staged 前に弾く規律へ繋ぐ)。
            const assessment = assessReviewSession({
              role: opts.role,
              before: treeBefore,
              after: safeLoadChangedFiles(repoRoot),
            });
            for (const m of reviewGuardMessages(assessment)) process.stderr.write(`${m}\n`);
          }
          dispatch(
            {
              hook_event_name: "PostToolUse",
              session_id: sessionId,
              ...(opts.plan ? { plan_id: opts.plan } : {}),
              tool_name: provider,
              tool_input: { command: `${plan.command} ${plan.args.join(" ")}` },
              tool_response: { outcome: child.status === 0 ? "ok" : "error" },
            },
            deps,
            "PostToolUse",
          );
          dispatch(
            {
              hook_event_name: "Stop",
              session_id: sessionId,
              ...(opts.plan ? { plan_id: opts.plan } : {}),
            },
            deps,
            "Stop",
          );
          writeHandoverWarnings();
          if (jsonOut) {
            // 実行が起きたことを正直に反映する実行結果 JSON。plan.dry_run は execute=true ゆえ false。
            // signal 終了時は exit_code=null になるため signal も併記する (機械判定が exit/signal を区別できる)。
            process.stdout.write(
              `${JSON.stringify(
                {
                  ...plan,
                  executed: true,
                  exit_code: child.status ?? null,
                  signal: child.signal ?? null,
                },
                null,
                2,
              )}\n`,
            );
          }
          process.exitCode = child.status ?? 1;
        },
      )
  );
}

runtimeCommand("codex");
runtimeCommand("claude");

program
  .command("gate <id>")
  .description("mode-aware gate review-tier and deterministic static checks")
  .option("--mode <mode>", MODE_OVERRIDE_OPTION_DESCRIPTION)
  .option("--review-kind <kind>", "cross_agent / intra_runtime_subagent / human")
  .option("--worker-model <model>", "worker provider/model id")
  .option("--reviewer-model <model>", "reviewer provider/model id")
  .option("--checklist <path>", "YAML checklist evidence for single-runtime review")
  .option("--coverage-summary <path>", "coverage/coverage-summary.json evidence for G7")
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
      if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else {
        process.stdout.write(
          `gate ${id}: ${result.passed ? "passed" : "failed"} mode=${result.mode} review=${result.review_kind ?? "-"} cross_agent_review=${result.cross_agent_review} static=${staticGate.applicable ? (staticGate.passed ? "passed" : "failed") : "n-a"}\n`,
        );
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
        const sessionDeps = nodeDeps(repoRoot, gitBranch, gitHead);
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
              runSessionStartSideEffects(repoRoot, startInput, sessionDeps);
              dispatch(startInput, sessionDeps, HOOK_EVENT_SESSION_START);
              const invocation = buildProviderInvocation({ provider, command, args });
              const ioMode = opts.json ? "ignore" : "inherit";
              const child = spawn(invocation.command, invocation.args, {
                cwd: repoRoot,
                env: adapterExecutionEnv(provider, env),
                // Provider prompts are passed through stdin; argv carries only fixed
                // command flags so shell metacharacters and tool markup stay inert.
                // codex はプロンプトを stdin で受ける (cmd.exe shell-wrap 回避、PLAN-L7-77)。
                stdio: stdin === undefined ? ioMode : ["pipe", ioMode, ioMode],
                shell: invocation.shell ?? false,
                windowsVerbatimArguments: invocation.windowsVerbatimArguments ?? false,
              });
              if (stdin !== undefined) {
                child.stdin?.write(stdin);
                child.stdin?.end();
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

registerFeedbackCommands(program);

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
  .action(
    (opts: {
      solo?: boolean;
      team?: boolean;
      dryRun?: boolean;
      applyBranchProtection?: boolean;
      tlTeam?: string;
      qaTeam?: string;
      poTeam?: string;
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
      const args: SetupArgs = {
        ...(phase ? { phase } : {}),
        dryRun: Boolean(opts.dryRun),
        applyBranchProtection: Boolean(opts.applyBranchProtection),
        ...(teams ? { teams } : {}),
      };
      const r = runSetup(args, deps);
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
  .action(
    (opts: { title: string; kind: string; body?: string; bodyFile?: string; tags?: string }) => {
      const body = opts.bodyFile ? readFileSync(opts.bodyFile, "utf8") : (opts.body ?? "");
      const tags = opts.tags
        ? opts.tags
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean)
        : [];
      try {
        const entry = writeMemoryEntry(process.cwd(), {
          kind: opts.kind as MemoryKind,
          title: opts.title,
          body,
          tags,
        });
        process.stdout.write(`memory: wrote ${entry.source_path}\n`);
      } catch (error) {
        process.stderr.write(`memory: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }
    },
  );

memory
  .command("list")
  .description("list shared memory entries from harness.db")
  .option("--query <text>", "filter by text")
  .option("--limit <n>", "maximum rows", "20")
  .action((opts: { query?: string; limit?: string }) => {
    const db = openHarnessDb(defaultHarnessDbPath(process.cwd()), { repoRoot: process.cwd() });
    try {
      process.stdout.write(
        renderMemoryList(
          selectMemoryEntries(db, { query: opts.query, limit: Number(opts.limit ?? 20) }),
        ),
      );
    } finally {
      db.close();
    }
  });

memory
  .command("recall")
  .description("render shared memory context from harness.db")
  .option("--query <text>", "filter by text")
  .option("--limit <n>", "maximum rows", "5")
  .action((opts: { query?: string; limit?: string }) => {
    const db = openHarnessDb(defaultHarnessDbPath(process.cwd()), { repoRoot: process.cwd() });
    try {
      const block = renderMemorySurface(
        selectMemoryEntries(db, { query: opts.query, limit: Number(opts.limit ?? 5) }),
      );
      process.stdout.write(block || "memory: no entries\n");
    } finally {
      db.close();
    }
  });

registerDistributionCommands(program);

program.parseAsync(process.argv).catch((e: unknown) => {
  process.stderr.write(`${String(e)}\n`);
  process.exitCode = 1;
});
