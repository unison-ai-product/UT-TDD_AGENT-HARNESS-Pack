/**
 * setup — ut-tdd setup solo/team。参加規模を検出 → solo(0-A)/team(0-B) を提案 →
 * 人間確認 → 確定 phase を記録 → phase 別の GitHub 設定を出し分け生成。
 *
 * 設計 (①): docs/design/harness/L6-function-design/setup-solo-team.md (PLAN-L6-05 add-design)。
 * テスト設計 (③): docs/test-design/harness/L7-unit-test-design.md §1.7 U-SETUP-001〜007。
 * PLAN: PLAN-L7-03-setup-solo-team (add-impl)。
 *
 * セキュリティ不変条件 (CLAUDE.md エスカレーション境界):
 *   ① token を読まない・state/docs/log に記録しない (gh 認証状態に委ねる seam)。
 *   ② branch protection の実適用は --apply + 対話 + admin/auth/confirm 全充足時のみ (非対話は封鎖)。
 *   ③ 既定は emit-only (スクリプト + 手順生成、適用は人間)。
 *   ④ 検出不能は solo に安全フォールバック (緩い側に倒す)。
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { ensureDir } from "../shared/fs.ts";
import {
  applyBranchProtection as applyBranchProtectionImpl,
  type Confirm,
  type GhRunner,
} from "./branch-protection.ts";
import {
  type ConsumerLocalRuntimeAdmission,
  isConsumerLocalRuntimeAdmission,
} from "./consumer-local-runtime-admission.ts";
import {
  buildConsumerNodeRuntimeBundle,
  buildConsumerNodeRuntimePayloads,
  type ConsumerNodeRuntimeBundle,
  type ConsumerNodeRuntimeIdentity,
  type ConsumerNodeRuntimeInstallResult,
  installConsumerNodeRuntimeOnFilesystem,
  renderConsumerNodeWrapper,
} from "./consumer-node-runtime.ts";
import {
  bootstrapProjectIdentity,
  PROJECT_IDENTITY_PATH,
  type ProjectIdentityBootstrapResult,
} from "./project-identity-bootstrap.ts";

export {
  AUTHORING_TEMPLATE_ARTIFACT_PATHS,
  AUTHORING_TEMPLATE_INVENTORY,
  type AuthoringArtifactSetValidation,
  type AuthoringInventoryValidation,
  type AuthoringProjectionError,
  type AuthoringProjectionResult,
  type AuthoringTemplateFamily,
  type AuthoringTemplateInventoryEntry,
  authoringArtifactPath,
  authoringInventoryRequiredPaths,
  authoringSourcePath,
  isAuthoringArtifactPath,
  projectTrackedTeamBlob,
  type TrackedGitBlob,
  validateAuthoringArtifactSet,
  validateAuthoringTemplateInventory,
} from "./authoring-template-inventory.ts";
export {
  admitConsumerLocalRuntime,
  applyConsumerLocalRuntime,
  type ConsumerArtifactIdentity,
  type ConsumerLocalRuntimeAdmission,
  type ConsumerLocalRuntimeAdmissionError,
  type ConsumerLocalRuntimeAdmissionInput,
  type ConsumerLocalRuntimeAdmissionResult,
  type ConsumerLocalRuntimeInstallResult,
  type ConsumerReceipt,
  type ConsumerRuntimeLayout,
  installConsumerLocalRuntime,
  isConsumerLocalRuntimeAdmission,
} from "./consumer-local-runtime-admission.ts";
export {
  buildConsumerNodeRuntimeBundle,
  buildConsumerNodeRuntimePayloads,
  bundlePathFor,
  type ConsumerNodeRuntimeBundle,
  type ConsumerNodeRuntimeBundleInput,
  type ConsumerNodeRuntimeIdentity,
  type ConsumerNodeRuntimeInstallResult,
  type ConsumerNodeRuntimePorts,
  type ConsumerNodeRuntimeReadinessInput,
  type ConsumerRuntimeDenyReason,
  createConsumerNodeRuntimeFilesystemPorts,
  digestConsumerRuntimeBytes,
  digestConsumerRuntimeValue,
  installConsumerNodeRuntime,
  installConsumerNodeRuntimeOnFilesystem,
  quarantinePathFor,
  renderConsumerNodeWrapper,
  stagingPathFor,
  validateConsumerNodeRuntimeBundle,
  validateConsumerReadiness,
} from "./consumer-node-runtime.ts";
export type { CleanDistributionPlan, ConsumerReadinessPlan, PackSyncPlan } from "./distribution.ts";
export {
  buildCleanDistributionPlan,
  buildConsumerReadinessPlan,
  buildPackSyncPlan,
  cleanDistributionArtifactPath,
  cleanDistributionSourcePath,
  DEFAULT_PACK_REPO,
  gitAddPathspecCommands,
  PACK_SAFE_TEST_SCRIPT,
  releaseArtifactFileNames,
  releaseArtifactStem,
  transformCleanDistributionArtifact,
} from "./distribution.ts";
export {
  inspectPackAuthoringEntries,
  type PackAuthoringSmokeEntry,
  type PackAuthoringSmokeResult,
  runPackAuthoringSmoke,
} from "./pack-authoring-smoke.ts";
export {
  bootstrapProjectIdentity,
  canonicalProjectIdentityBytes,
  PROJECT_IDENTITY_PATH,
  type ProjectIdentityBootstrapResult,
  type ProjectIdentityBootstrapRuleId,
  repositoryIdentityFromOrigin,
} from "./project-identity-bootstrap.ts";
export {
  admitReleaseAggregate,
  applySealedReleaseAggregate,
  type ReleaseAggregateAdmissionDependencies,
  type ReleaseAggregateAdmissionInput,
  type ReleaseAggregateAdmissionResult,
  type ReleaseAggregateApplyDependencies,
  type ReleaseAggregateApplyResult,
  type ReleaseAggregateFinalTree,
  type ReleaseAggregateFinding,
  type ReleaseChannelMapping,
  type ReleaseManifestTreeEntry,
  type SealedReleaseAggregatePlan,
} from "./release-aggregate-admission.ts";
export {
  digestMaterializedReleaseEntries,
  type MaterializedReleaseEntry,
  materializeReleaseArtifacts,
  type ReleaseEntryMode,
  type ReleaseMaterializationResult,
  type ReleaseMaterializerDependencies,
  type ReleaseSourceEntry,
} from "./release-materializer.ts";
export {
  type CanonicalCiEvidence,
  classifyRollbackApply,
  evaluatePromotionGate,
  type GateLegStatus,
  type PromotionEvidenceBinding,
  type PromotionGateInput,
  type PromotionGateReason,
  type PromotionGateResult,
  type QaGateStatus,
  type QaReleaseGateEvidence,
  type ReviewEvidenceBinding,
  type ReviewGateEvidence,
  type RollbackApplyResult,
  type RollbackCandidate,
  type RollbackGateReason,
  type RollbackPointerDelta,
  type RollbackSelectionInput,
  type RollbackSelectionResult,
  selectRollbackCandidate,
} from "./release-promotion-rollback-gate.ts";

import { BUILTIN_GITHUB_TEMPLATES, COMMON_FILES, type TemplateSet } from "./templates.ts";

export type { Confirm, GhRunner };

export type SetupPhase = "0-A" | "0-B"; // 0-A=solo / 0-B=team

/** 検出結果 (生信号、判定しない)。token は含めない。 */
export interface ProjectScale {
  ownerType: "User" | "Organization" | "unknown";
  collaborators: number | null; // 取得不可は null
  hasCodeowners: boolean;
  hasBranchProtection: boolean | null; // 取得不可は null
}

export interface PhaseRecommendation {
  phase: SetupPhase;
  reason: string;
  confidence: "high" | "low";
}

export interface GeneratedFile {
  path: string; // 対象 repo 相対 path
  category: "A" | "B"; // §9.1 種別
  purpose: string;
}

export interface GithubAction {
  kind: "branch-protection";
  script_path: string;
  applied: boolean; // 既定 false (適用は applyBranchProtection)
}

export interface SetupPlan {
  phase: SetupPhase;
  files: GeneratedFile[];
  actions: GithubAction[];
  dryRun: boolean;
  teams?: TeamSlugs; // CODEOWNERS render 用 (impl: 設計 §2.2 type に team 反映を materialize)
}

export interface SetupState {
  phase: SetupPhase;
  decidedAt: string;
  decidedBy: "flag" | "confirm" | "fallback";
  signals: ProjectScale; // 4 フィールドのみ (recordSetupState で strip)
}

export interface TeamSlugs {
  tl: string;
  qa: string;
  po: string;
}

export interface SetupArgs {
  phase?: SetupPhase;
  dryRun: boolean;
  applyBranchProtection: boolean;
  teams?: TeamSlugs;
  consumerRuntime?: SetupConsumerRuntimeInput;
}

export interface SetupResult {
  phase: SetupPhase;
  written: string[];
  branchProtection: { applied: boolean; reason: string };
  projectIdentity?: ProjectIdentityBootstrapResult;
  consumerRuntime?: SetupConsumerRuntimeInstall;
}

/** Sealed runtime input handed from the release materializer to setup. */
export interface SetupConsumerRuntimeInput {
  readonly identity: ConsumerNodeRuntimeIdentity;
  /** Same-process capability returned by admitConsumerLocalRuntime. */
  readonly admission: ConsumerLocalRuntimeAdmission;
  readonly compiled_esm: Uint8Array;
  readonly node_bootstrap_receipt: Uint8Array;
  readonly prior_bundle_digest?: string;
  readonly prior_history_tip_digest?: string;
  readonly history_sequence?: number;
  readonly prior_history?: Uint8Array;
  readonly prior_identity?: ConsumerNodeRuntimeIdentity;
  readonly prior_pointer?:
    | import("./consumer-node-runtime.ts").ConsumerNodeRuntimePriorPointer
    | null;
  readonly operation_kind?: import("./consumer-node-runtime.ts").ConsumerNodeRuntimeOperationKind;
  readonly prior_attestation?: Uint8Array;
  readonly fault?: (barrier: string) => void;
  readonly verifySealedAggregate?: () => void;
}

export interface SetupConsumerRuntimeInstall {
  readonly bundle: ConsumerNodeRuntimeBundle;
  readonly result: ConsumerNodeRuntimeInstallResult;
}

/**
 * Production setup ingress for a sealed release aggregate.  The caller must
 * provide the actual compiled bytes and the producer's NodeBootstrapReceipt;
 * setup never searches a source checkout or synthesizes a receipt.
 */
export async function installConsumerRuntimeFromSetup(
  input: SetupConsumerRuntimeInput,
): Promise<SetupConsumerRuntimeInstall> {
  if (!isConsumerLocalRuntimeAdmission(input.admission))
    throw new Error("consumer_runtime_aggregate_denied");
  const admission = input.admission;
  if (
    admission.productId !== input.identity.product_id ||
    !sameCanonicalSetupPath(admission.consumerRoot, input.identity.consumer_root) ||
    !sameCanonicalSetupPath(admission.runtimeRoot, input.identity.runtime_root) ||
    admission.identity.releaseId !== input.identity.release_id ||
    admission.identity.sourceRevision !== input.identity.subject_revision ||
    admission.identity.materializerVersion !== input.identity.materializer_version ||
    admission.identity.artifactSetDigest !== input.identity.artifact_set_digest ||
    admission.controlManifestSnapshotDigest !== input.identity.control_manifest_digest
  )
    throw new Error("consumer_runtime_identity_mismatch");
  const payloads = buildConsumerNodeRuntimePayloads(input);
  const bundle = buildConsumerNodeRuntimeBundle({
    identity: input.identity,
    ...payloads,
    ...(input.prior_bundle_digest === undefined
      ? {}
      : { prior_bundle_digest: input.prior_bundle_digest }),
    ...(input.prior_history_tip_digest === undefined
      ? {}
      : { prior_history_tip_digest: input.prior_history_tip_digest }),
    ...(input.history_sequence === undefined ? {} : { history_sequence: input.history_sequence }),
  });
  const result = await installConsumerNodeRuntimeOnFilesystem({
    identity: input.identity,
    bundle,
    payloads,
    fault: input.fault,
    verifySealedAggregate: () => {
      if (input.verifySealedAggregate) input.verifySealedAggregate();
    },
  });
  return { bundle, result };
}

/** gh 実行 seam (raw token 非依存 = gh の認証状態に委ねる)。test=mock。 */
/** 対話確認 seam。test=mock、非対話では呼ばれない。 */

/** I/O・clock・gh・confirm・templates を注入 (session-log の deps パターン踏襲)。 */
export interface SetupDeps {
  repoRoot: string;
  now: () => string;
  gh: GhRunner;
  readText: (path: string) => string | null;
  writeText: (path: string, content: string) => void;
  confirm: Confirm;
  isInteractive: boolean;
  templates: TemplateSet;
  bootstrapProjectIdentity?: () => ProjectIdentityBootstrapResult;
}

const CODEOWNERS_TARGET = join(".github", "CODEOWNERS");
const STATE_PATH = join(".ut-tdd", "state", "setup.json");
const BP_SCRIPT = join("scripts", "setup-branch-protection.sh");
const MANAGED_START = "<!-- UT-TDD:managed:start -->";
const MANAGED_END = "<!-- UT-TDD:managed:end -->";
const MERGEABLE_ADAPTER_DOCS = new Set(["AGENTS.md", "CLAUDE.md", join(".claude", "CLAUDE.md")]);

/**
 * U-SETUP-001: gh で owner 種別 / collaborator 数 / 既存 protection を読む。**never throws**。
 * gh 不在/未認証/権限不足 → unknown/null。token は読まない (gh 認証状態に委譲)。
 */
export function detectProjectScale(deps: SetupDeps): ProjectScale {
  const hasCodeowners = readNonEmpty(deps, join(deps.repoRoot, CODEOWNERS_TARGET));
  let ownerType: ProjectScale["ownerType"] = "unknown";
  let collaborators: number | null = null;
  let hasBranchProtection: boolean | null = null;
  try {
    // gh は repos/{owner}/{repo} placeholder を current repo に自動解決する
    const repo = deps.gh(["api", "repos/{owner}/{repo}"]);
    if (repo.ok) {
      try {
        const t = (JSON.parse(repo.stdout) as { owner?: { type?: string } })?.owner?.type;
        if (t === "User" || t === "Organization") ownerType = t;
      } catch {
        // parse 失敗 → unknown 維持
      }
      const collab = deps.gh(["api", "repos/{owner}/{repo}/collaborators"]);
      if (collab.ok) {
        try {
          const arr = JSON.parse(collab.stdout);
          if (Array.isArray(arr)) collaborators = arr.length;
        } catch {
          // 維持
        }
      }
      // protection: 200=保護あり / 404 等=なし。repo 取得できた = gh は使えるので false に確定
      hasBranchProtection = deps.gh(["api", "repos/{owner}/{repo}/branches/main/protection"]).ok;
    }
  } catch {
    // never throws — 不明信号のまま返す
  }
  return { ownerType, collaborators, hasCodeowners, hasBranchProtection };
}

/**
 * U-SETUP-002: 純関数。org / collaborators>1 / 既存 CODEOWNERS / 既存 protection → team(0-B)。
 * User かつ collaborators<=1 → solo(0-A)。不明信号 (null 単独含む) → solo(0-A) low (安全フォールバック)。
 */
export function recommendPhase(scale: ProjectScale): PhaseRecommendation {
  if (
    scale.ownerType === "Organization" ||
    (scale.collaborators ?? 0) > 1 ||
    scale.hasCodeowners ||
    scale.hasBranchProtection === true
  ) {
    return { phase: "0-B", reason: teamReason(scale), confidence: "high" };
  }
  if (scale.ownerType === "User" && scale.collaborators !== null && scale.collaborators <= 1) {
    return {
      phase: "0-A",
      reason: "個人 owner + collaborator 1 名以下 = solo",
      confidence: "high",
    };
  }
  return {
    phase: "0-A",
    reason: "信号不足 (owner/collaborator 不明)、安全側 solo に倒す",
    confidence: "low",
  };
}

function teamReason(s: ProjectScale): string {
  const why: string[] = [];
  if (s.ownerType === "Organization") why.push("org 所有");
  if ((s.collaborators ?? 0) > 1) why.push(`collaborator ${s.collaborators} 名`);
  if (s.hasCodeowners) why.push("既存 CODEOWNERS");
  if (s.hasBranchProtection === true) why.push("既存 branch protection");
  return `team 構成の信号: ${why.join(" / ")}`;
}

/**
 * U-SETUP-003: 純関数。0-A=共通(A)のみ。0-B=共通(A)+CODEOWNERS(B)+branch-protection script。
 * actions.applied は常に false (適用は applyBranchProtection)。teams は CODEOWNERS render に反映。
 */
export function planSetup(
  phase: SetupPhase,
  opts: { teams?: TeamSlugs; dryRun: boolean },
): SetupPlan {
  const files: GeneratedFile[] = COMMON_FILES.map((c) => ({ ...c.file }));
  const actions: GithubAction[] = [];
  if (phase === "0-B") {
    const teamNote = opts.teams
      ? ` (tl=${opts.teams.tl} qa=${opts.teams.qa} po=${opts.teams.po})`
      : "";
    files.push({ path: CODEOWNERS_TARGET, category: "B", purpose: `CODEOWNERS${teamNote}` });
    files.push({
      path: BP_SCRIPT,
      category: "B",
      purpose: "branch protection 適用スクリプト (emit-only)",
    });
    actions.push({ kind: "branch-protection", script_path: BP_SCRIPT, applied: false });
  }
  return {
    phase,
    files,
    actions,
    dryRun: opts.dryRun,
    ...(opts.teams ? { teams: opts.teams } : {}),
  };
}

/** 内部 helper (独立契約でない、U-SETUP-004 に内包): plan + templates → {path, content}[]。token 非埋込。 */
function renderArtifacts(
  plan: SetupPlan,
  templates: TemplateSet,
): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  for (const f of plan.files) {
    const name = templateNameFor(f.path);
    let content = templates[name] ?? BUILTIN_GITHUB_TEMPLATES[name] ?? "";
    if (f.path === join(".ut-tdd", "bin", "ut-tdd.mjs")) content = renderConsumerNodeWrapper();
    if (f.path === CODEOWNERS_TARGET && plan.teams) {
      content = content
        .replace(/\{\{TL_TEAM\}\}/g, plan.teams.tl)
        .replace(/\{\{QA_TEAM\}\}/g, plan.teams.qa)
        .replace(/\{\{PO_TEAM\}\}/g, plan.teams.po);
    }
    out.push({ path: f.path, content });
  }
  return out;
}

function templateNameFor(targetPath: string): string {
  const common = COMMON_FILES.find((entry) => entry.file.path === targetPath);
  if (common) return common.template;
  if (targetPath === CODEOWNERS_TARGET) return "team/CODEOWNERS";
  if (targetPath === BP_SCRIPT) return "team/setup-branch-protection.sh";
  if (targetPath === "AGENTS.md") return "adapter/AGENTS.md";
  if (targetPath === "CLAUDE.md") return "adapter/CLAUDE.md";
  if (targetPath === join(".claude", "CLAUDE.md")) return "adapter/.claude/CLAUDE.md";
  if (targetPath === join(".claude", "settings.json")) return "adapter/.claude/settings.json";
  return `common/${basename(targetPath)}`;
}

function mergeManagedBlock(existing: string | null, rendered: string): string | null {
  if (existing === null) return rendered;
  const start = rendered.indexOf(MANAGED_START);
  const end = rendered.indexOf(MANAGED_END);
  if (start === -1 || end === -1 || end < start) return null;
  const managed = rendered.slice(start, end + MANAGED_END.length);
  const existingStart = existing.indexOf(MANAGED_START);
  const existingEnd = existing.indexOf(MANAGED_END);
  if (existingStart !== -1 && existingEnd !== -1 && existingEnd >= existingStart) {
    const next =
      existing.slice(0, existingStart) + managed + existing.slice(existingEnd + MANAGED_END.length);
    return next.endsWith("\n") ? next : `${next}\n`;
  }
  const prefix = existing.endsWith("\n") ? existing : `${existing}\n`;
  return `${prefix}\n${managed}\n`;
}

/** U-SETUP-004: render setup artifacts and write unless dry-run. */
export function emitSetup(plan: SetupPlan, templates: TemplateSet, deps: SetupDeps): string[] {
  const rendered = renderArtifacts(plan, templates);
  if (plan.dryRun) return rendered.map((r) => r.path);
  const written: string[] = [];
  for (const r of rendered) {
    const abs = join(deps.repoRoot, r.path);
    const existing = deps.readText(abs);
    const exists = existing !== null;
    if (exists && MERGEABLE_ADAPTER_DOCS.has(r.path)) {
      const merged = mergeManagedBlock(existing, r.content);
      if (merged === null) continue;
      if (merged !== existing) {
        deps.writeText(abs, merged);
        written.push(r.path);
      }
      continue;
    }
    if (exists) {
      // confirm は isInteractive 時のみ (nodeConfirm の blocking readSync が、stdin が開いたまま
      // 無音の非対話環境 (CI runner / tool shell) で無限待ちになる)。非対話は既存保護 = skip が
      // 既定 (非破壊導入の invariant、PLAN-L7-361)。
      if (deps.isInteractive !== true) continue;
      if (!deps.confirm(`${r.path} は既存です。上書きしますか？`)) continue;
    }
    deps.writeText(abs, r.content);
    written.push(r.path);
  }
  return written;
}

/**
 * U-SETUP-005: setup.json を上書き (単一ファイル = 確定値 SSoT、append しない)。
 * signals は 4 フィールドのみ strip (認証情報混入経路を遮断)。
 */
export function recordSetupState(state: SetupState, deps: SetupDeps): void {
  const stripped: SetupState = {
    phase: state.phase,
    decidedAt: state.decidedAt,
    decidedBy: state.decidedBy,
    signals: {
      ownerType: state.signals.ownerType,
      collaborators: state.signals.collaborators,
      hasCodeowners: state.signals.hasCodeowners,
      hasBranchProtection: state.signals.hasBranchProtection,
    },
  };
  deps.writeText(join(deps.repoRoot, STATE_PATH), `${JSON.stringify(stripped, null, 2)}\n`);
}

/**
 * U-SETUP-006: apply≠true → emit-only (既定)。isInteractive≠true → non-interactive で gh 非実行。
 * 対話下でのみ gh 認証 + admin + 人間 confirm 全充足で gh api 実行。欠落 → 実行せず emit-only に戻す。
 */
export function applyBranchProtection(
  plan: SetupPlan,
  deps: SetupDeps,
  opts: { apply: boolean },
): { applied: boolean; reason: string } {
  return applyBranchProtectionImpl(plan, deps, opts);
}

/**
 * U-SETUP-007: orchestration。phase = フラグ > confirm(recommend(detect)) > fallback(solo)。
 * 確定 → record → plan → emit → (apply は opt-in)。非対話+フラグ無し → 0-A。
 * invariant: --apply-branch-protection は対話のみ有効 (applyBranchProtection の precondition が保証)。
 * invariant: dryRun=true は副作用ゼロ (state 非書込・remote 非適用、branchProtection.reason="dry-run")。
 */
export function runSetup(args: SetupArgs, deps: SetupDeps): SetupResult {
  // Dry-run is side-effect free, including the identity bootstrap write.
  const projectIdentity = args.dryRun ? undefined : deps.bootstrapProjectIdentity?.();
  // Identity is a project binding input, not the owner of the rest of setup.
  // A typed denial must be reported to the caller while the non-identity setup
  // artifacts still follow their normal, non-destructive orchestration. This
  // keeps remote-less local repositories usable without weakening identity
  // read/create fail-close behavior.
  const scale = detectProjectScale(deps);
  let phase: SetupPhase;
  let decidedBy: SetupState["decidedBy"];
  if (args.phase) {
    phase = args.phase;
    decidedBy = "flag";
  } else if (deps.isInteractive) {
    const rec = recommendPhase(scale);
    const ok = deps.confirm(
      `検出: owner=${scale.ownerType}, collaborators=${scale.collaborators ?? "?"}, ` +
        `CODEOWNERS=${scale.hasCodeowners ? "あり" : "なし"} → 推奨 ${rec.phase} (${rec.reason})。` +
        `${rec.phase === "0-B" ? "team" : "solo"} 設定を生成しますか？`,
    );
    phase = ok ? rec.phase : "0-A";
    decidedBy = "confirm";
  } else {
    phase = "0-A"; // 非対話 + フラグ無し → 安全フォールバック
    decidedBy = "fallback";
  }

  // dry-run は副作用ゼロ契約 (CLI help「書き込まない」)。state 書込も remote 適用も行わない。
  // emit は plan.dryRun で既に非書込だが、record/apply は dryRun を見ないため runSetup 側で封鎖する。
  if (!args.dryRun) {
    recordSetupState({ phase, decidedAt: deps.now(), decidedBy, signals: scale }, deps);
  }
  const plan = planSetup(phase, { teams: args.teams, dryRun: args.dryRun });
  const emitted = emitSetup(plan, deps.templates, deps);
  const written =
    projectIdentity?.ok && projectIdentity.created ? [projectIdentity.path, ...emitted] : emitted;
  const branchProtection = args.dryRun
    ? { applied: false, reason: "dry-run" }
    : applyBranchProtection(plan, deps, { apply: args.applyBranchProtection });
  return { phase, written, branchProtection, ...(projectIdentity ? { projectIdentity } : {}) };
}

/** Async composition root used when setup is supplied a sealed runtime input. */
export async function runSetupAsync(args: SetupArgs, deps: SetupDeps): Promise<SetupResult> {
  if (!args.consumerRuntime || args.dryRun) return runSetup(args, deps);
  assertSetupRuntimeRoot(args.consumerRuntime.identity, deps.repoRoot);
  const setupSnapshot = captureSetupFiles(deps.repoRoot);
  const runtimeSnapshot = captureRuntimeTree(args.consumerRuntime.identity.runtime_root);
  // Admission and publication happen before setup emits any consumer files.
  // A denied/failed runtime must not leave a seemingly-installed wrapper or
  // setup state behind for the CLI to discover.
  try {
    const consumerRuntime = await installConsumerRuntimeFromSetup(args.consumerRuntime);
    if (!consumerRuntime.result.ok) throw new Error(consumerRuntime.result.reason);
    const result = runSetup(args, deps);
    return { ...result, consumerRuntime };
  } catch (error) {
    let setupRestoreError: unknown;
    let runtimeRestoreError: unknown;
    try {
      restoreSetupFiles(setupSnapshot);
    } catch (restoreError) {
      setupRestoreError = restoreError;
    }
    try {
      restoreRuntimeTree(args.consumerRuntime.identity.runtime_root, runtimeSnapshot);
    } catch (restoreError) {
      runtimeRestoreError = restoreError;
    }
    if (setupRestoreError !== undefined || runtimeRestoreError !== undefined) {
      throw new Error(
        `consumer_runtime_indeterminate:setup=${String(setupRestoreError)};runtime=${String(runtimeRestoreError)};primary=${String(error)}`,
      );
    }
    throw error;
  }
}

/** Compare an admitted path with its identity across Windows 8.3/case/realpath forms. */
function sameCanonicalSetupPath(left: string, right: string): boolean {
  try {
    return canonicalSetupPath(left) === canonicalSetupPath(right);
  } catch {
    return false;
  }
}

function canonicalSetupPath(path: string): string {
  let current = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new Error("consumer_runtime_external_path");
    suffix.unshift(basename(current));
    current = parent;
  }
  return resolve(realpathSync.native(current), ...suffix);
}

function assertSetupRuntimeRoot(identity: ConsumerNodeRuntimeIdentity, repoRoot: string): void {
  const expectedRoot = resolve(repoRoot);
  const expectedRuntime = resolve(expectedRoot, ".ut-tdd", "runtime");
  if (
    resolve(identity.consumer_root) !== expectedRoot ||
    resolve(identity.runtime_root) !== expectedRuntime
  )
    throw new Error("consumer_runtime_external_path");
  try {
    const rootReal = realpathSync.native(expectedRoot);
    const identityRootReal = realpathSync.native(identity.consumer_root);
    if (rootReal !== identityRootReal) throw new Error("consumer_runtime_external_path");
    if (existsSync(identity.runtime_root)) {
      const runtimeReal = realpathSync.native(identity.runtime_root);
      if (!containedReal(rootReal, runtimeReal)) throw new Error("consumer_runtime_external_path");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "consumer_runtime_external_path") throw error;
    throw new Error("consumer_runtime_external_path");
  }
}

function containedReal(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`);
}

type SetupFileSnapshot = { readonly bytes: Buffer; readonly mode: number } | null;
type SetupDirectorySnapshot = { readonly exists: boolean; readonly mode?: number };
type SetupSnapshot = {
  readonly files: ReadonlyMap<string, SetupFileSnapshot>;
  readonly directories: ReadonlyMap<string, SetupDirectorySnapshot>;
};
type RuntimeTreeEntry =
  | { readonly kind: "directory"; readonly mode: number }
  | { readonly kind: "file"; readonly bytes: Buffer; readonly mode: number };
type RuntimeTreeSnapshot = { readonly entries: ReadonlyMap<string, RuntimeTreeEntry> } | null;

function setupTargetPaths(): readonly string[] {
  const paths = new Set<string>([PROJECT_IDENTITY_PATH, STATE_PATH]);
  for (const phase of ["0-A", "0-B"] as const)
    for (const file of planSetup(phase, { dryRun: false }).files) paths.add(file.path);
  return [...paths];
}

function captureSetupFiles(repoRoot: string): SetupSnapshot {
  const files = new Map<string, SetupFileSnapshot>();
  const directories = new Map<string, SetupDirectorySnapshot>();
  for (const relativePath of setupTargetPaths()) {
    const path = resolve(repoRoot, relativePath);
    if (!existsSync(path)) {
      files.set(path, null);
    } else {
      const stat = statSync(path);
      if (!stat.isFile()) throw new Error("consumer_runtime_setup_snapshot");
      files.set(path, { bytes: readFileSync(path), mode: stat.mode & 0o777 });
    }
    let parent = dirname(path);
    while (parent !== resolve(repoRoot) && parent !== dirname(parent)) {
      if (!directories.has(parent)) {
        if (!existsSync(parent)) directories.set(parent, { exists: false });
        else {
          const stat = statSync(parent);
          if (!stat.isDirectory()) throw new Error("consumer_runtime_setup_snapshot");
          directories.set(parent, { exists: true, mode: stat.mode & 0o777 });
        }
      }
      parent = dirname(parent);
    }
  }
  return { files, directories };
}

function restoreSetupFiles(snapshot: SetupSnapshot): void {
  for (const [path, value] of snapshot.files) {
    if (value === null) {
      rmSync(path, { recursive: true, force: true });
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value.bytes, { mode: value.mode });
    chmodSync(path, value.mode);
  }
  for (const [path, value] of [...snapshot.directories.entries()].sort(
    ([left], [right]) => right.length - left.length,
  )) {
    if (!value.exists) {
      if (existsSync(path) && statSync(path).isDirectory() && readdirSync(path).length === 0)
        rmSync(path, { recursive: false, force: true });
      continue;
    }
    mkdirSync(path, { recursive: true });
    chmodSync(path, value.mode ?? 0o755);
  }
}

function captureRuntimeTree(root: string): RuntimeTreeSnapshot {
  if (!existsSync(root)) return null;
  const rootStat = statSync(root);
  if (!rootStat.isDirectory()) throw new Error("consumer_runtime_setup_snapshot");
  const entries = new Map<string, RuntimeTreeEntry>();
  entries.set("", { kind: "directory", mode: rootStat.mode & 0o777 });
  const visit = (path: string, relativePath: string): void => {
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      const childRelative = join(relativePath, name);
      const stat = statSync(child);
      if (stat.isDirectory()) {
        entries.set(childRelative, { kind: "directory", mode: stat.mode & 0o777 });
        visit(child, childRelative);
      } else if (stat.isFile())
        entries.set(childRelative, {
          kind: "file",
          bytes: readFileSync(child),
          mode: stat.mode & 0o777,
        });
      else throw new Error("consumer_runtime_setup_snapshot");
    }
  };
  visit(root, "");
  return { entries };
}

function restoreRuntimeTree(root: string, snapshot: RuntimeTreeSnapshot): void {
  makeRuntimeTreeWritable(root);
  rmSync(root, { recursive: true, force: true });
  if (snapshot === null) return;
  // Recreate the topology writable first. Sealed bundle directories are
  // intentionally read-only (0555); applying those modes before restoring
  // their files makes the rollback fail on POSIX.
  mkdirSync(root, { recursive: true, mode: 0o755 });
  for (const [relativePath, value] of [...snapshot.entries.entries()]
    .filter(([path, entry]) => path !== "" && entry.kind === "directory")
    .sort(([left], [right]) => left.length - right.length)) {
    if (value.kind !== "directory") continue;
    const path = join(root, relativePath);
    mkdirSync(path, { recursive: false, mode: 0o755 });
  }
  for (const [relativePath, value] of snapshot.entries) {
    if (value.kind !== "file") continue;
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value.bytes, { mode: value.mode });
    chmodSync(path, value.mode);
  }
  for (const [relativePath, value] of snapshot.entries) {
    if (value.kind !== "directory") continue;
    chmodSync(join(root, relativePath), value.mode);
  }
}

function makeRuntimeTreeWritable(path: string): void {
  if (!existsSync(path)) return;
  const stat = statSync(path);
  if (stat.isDirectory()) {
    chmodSync(path, 0o755);
    for (const name of readdirSync(path)) makeRuntimeTreeWritable(join(path, name));
  } else if (stat.isFile()) chmodSync(path, 0o644);
}

// ── node 実 deps (real I/O / gh / confirm / templates) ──────────────────────

function readNonEmpty(deps: SetupDeps, path: string): boolean {
  const t = deps.readText(path);
  return t !== null && t.trim().length > 0;
}

/** gh CLI 実行。失敗 (不在/未認証/非0) は {ok:false}。token は扱わない (gh 認証に委譲)。 */
export function nodeGh(args: string[]): { ok: boolean; stdout: string } {
  try {
    const stdout = execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { ok: true, stdout };
  } catch (e) {
    const stdout = (e as { stdout?: string })?.stdout;
    return { ok: false, stdout: typeof stdout === "string" ? stdout : "" };
  }
}

/** 対話確認 (isInteractive 時のみ呼ばれる)。stdin から 1 行同期読取。 */
function nodeConfirm(message: string): boolean {
  process.stderr.write(`${message} [y/N] `);
  try {
    const buf = Buffer.alloc(16);
    const n = readSync(0, buf, 0, 16, null);
    const ans = buf.toString("utf8", 0, n).trim().toLowerCase();
    return ans === "y" || ans === "yes";
  } catch {
    return false;
  }
}

/** docs/templates/github/{common,team}/ 配下を TemplateSet (相対名→内容) に読み込む。 */
export function loadTemplates(repoRoot: string): TemplateSet {
  const set: TemplateSet = { ...BUILTIN_GITHUB_TEMPLATES };
  const walk = (root: string, dir: string, prefix = ""): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(root, abs, prefix);
      else set[`${prefix}${relative(root, abs).split(sep).join("/")}`] = readFileSync(abs, "utf8");
    }
  };
  const githubRoot = join(repoRoot, "docs", "templates", "github");
  walk(githubRoot, githubRoot);
  const adapterRoot = join(repoRoot, "docs", "templates", "adapter");
  walk(adapterRoot, adapterRoot, "adapter/");
  return set;
}

export function nodeSetupDeps(repoRoot: string): SetupDeps {
  return {
    repoRoot,
    now: () => new Date().toISOString(),
    gh: nodeGh,
    readText: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
    writeText: (p, c) => {
      ensureDir(dirname(p), { recursive: true });
      writeFileSync(p, c);
    },
    confirm: nodeConfirm,
    isInteractive: Boolean(process.stdin.isTTY) && Boolean(process.stderr.isTTY) && !process.env.CI,
    templates: loadTemplates(repoRoot),
    bootstrapProjectIdentity: () => bootstrapProjectIdentity(repoRoot),
  };
}
