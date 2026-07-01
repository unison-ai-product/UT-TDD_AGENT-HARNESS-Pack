/**
 * Cost-tiered provider role router (PLAN-L7-75).
 *
 * 3 archetype × 3 tier × 2 provider の対称 roster と難易度ルーターを 1 箇所に集約する。
 * task module 配下に置く (task→team は既存の一方向 edge、循環なし)。
 *
 * 不変条件 (PO 確定 2026-06-17):
 *   - archetype が tier 帯を決める: 相談 / 検証 = 上位 (T0)、ワーカー = 下位 (T1/T2)。
 *   - ワーカーは上位モデル (opus / gpt-5.5) に絶対に到達しない (原則安く、fail-close)。
 *   - T0 (opus / gpt-5.5) は明示許可ゲート: 指名 role (tl/qa/uiux) + 明示トリガでのみ発火。
 *   - 主 provider (detectMode().currentRuntime) でクロス分岐し、Codex/GPT も Claude と対称。
 */
import {
  type AdapterContextInjection,
  type AdapterPlan,
  buildAdapterPlan,
} from "../runtime/adapter";
import type { ExecutionMode, RuntimeDetection } from "../runtime/detect";
import type { TaskDifficulty } from "../team/model-policy";
import { type ClassifyTaskInput, classifyTask } from "./classify";
import {
  FRONTIER_ROLES,
  other,
  type ReviewEntry,
  ROLE_ARCHETYPE,
  resolveModel,
  reviewPolicy,
  TIER_TABLE,
  tierFor,
} from "./tier-router-policy";

export type { ReviewEntry } from "./tier-router-policy";
export {
  FRONTIER_MODELS,
  FRONTIER_ROLES,
  other,
  ROLE_ARCHETYPE,
  resolveModel,
  TIER_TABLE,
  tierFor,
} from "./tier-router-policy";

export type Provider = "claude" | "codex";
export type Archetype = "consult" | "worker" | "verify";
export type Tier = "T0" | "T1" | "T2";

/** §1.8 VALID_ROLES のうち agent 化する 5 役 (po=人間 / aim=未採用)。 */
export type RouterRole = "tl" | "qa" | "uiux" | "se" | "docs";

/** T0 発火の明示許可。explicit=false なら上位帯は block される。 */
export interface FrontierAuth {
  explicit: boolean;
}

export type RoutingStatus = "ready" | "blocked-needs-approval";

export interface RoutingDecision {
  role: RouterRole;
  archetype: Archetype;
  tier: Tier;
  provider: Provider;
  /** blocked-needs-approval のときは null。 */
  model: string | null;
  reviewEntry: ReviewEntry;
  gate: boolean;
  crossReview: boolean;
  /** 主→相手のプロバイダ切替割付 (creation=主 / judgement=相手、§7.8.7.1)。 */
  cross: CrossAssign;
  status: RoutingStatus;
  reason?: string;
  difficulty: TaskDifficulty;
  riskFlags: string[];
}

export interface RouteInput {
  role: RouterRole;
  task: ClassifyTaskInput;
}

export interface RouteOptions {
  /** 主 provider 上書き。省略時は detection.currentRuntime ?? "claude"。 */
  primary?: Provider;
  /** T0 明示許可。 */
  auth?: FrontierAuth;
}

/**
 * 難易度ルーター本体: task を分類し、role の archetype + 難易度 + risk + 主 provider から
 * RoutingDecision を返す。上位帯 (T0) は明示許可ゲートを通らないと model=null で block する。
 */
export function route(
  input: RouteInput,
  detection: RuntimeDetection,
  options: RouteOptions = {},
): RoutingDecision {
  const c = classifyTask(input.task);
  const primary: Provider = options.primary ?? (detection.currentRuntime as Provider) ?? "claude";
  const archetype = ROLE_ARCHETYPE[input.role];
  const tier = tierFor(input.role, c.difficulty, c.risk_flags);
  const policy = reviewPolicy(c.difficulty, c.risk_flags);
  // 主 provider から「創出=主 / 判断=相手」のクロス切替を自動導出 (assignCross 配線)。
  const cross = assignCross(detection, primary);
  // 役割を実 provider へ配置 (クロス接続): ワーカー=創出側(主)、相談/検証=判断側(相手)。
  const placed: Provider = archetype === "worker" ? cross.execution : cross.judgement;
  const base: Omit<RoutingDecision, "model" | "status" | "reason"> = {
    role: input.role,
    archetype,
    tier,
    provider: placed,
    reviewEntry: policy.reviewEntry,
    gate: policy.gate,
    crossReview: detection.mode === "hybrid" && policy.crossReview,
    cross,
    difficulty: c.difficulty,
    riskFlags: c.risk_flags,
  };

  // T0 = 明示許可ゲート: 指名 role + explicit auth でのみ発火 (fail-close)。
  if (tier === "T0") {
    const designated = FRONTIER_ROLES.has(input.role);
    if (!designated || !options.auth?.explicit) {
      return {
        ...base,
        model: null,
        status: "blocked-needs-approval",
        reason: designated
          ? "T0 (opus/gpt-5.5) は明示許可が必要です (--allow-frontier)。"
          : `role ${input.role} は上位帯 (T0) の指名 role ではありません。`,
      };
    }
  }

  return { ...base, model: resolveModel(input.role, tier, placed), status: "ready" };
}

export interface CrossAssign {
  execution: Provider;
  judgement: Provider;
  review_kind: "cross_agent" | "intra_runtime_subagent";
}

/**
 * クロス分岐: 主 provider で創出、hybrid なら判断を相手 provider にフリップ
 * (§7.8.7.1 機能分散 MUST)。単一 runtime では同 runtime + intra_runtime_subagent fallback。
 */
export function assignCross(detection: RuntimeDetection, worker?: Provider): CrossAssign {
  const primary: Provider = worker ?? (detection.currentRuntime as Provider) ?? "claude";
  if (detection.mode === "hybrid") {
    // 連携状態 (hybrid): 実装 (創出) と検証 (判断) を明示的に別 provider にする (PO 指示)。
    const assignment: CrossAssign = {
      execution: primary,
      judgement: other(primary),
      review_kind: "cross_agent",
    };
    if (assignment.execution === assignment.judgement) {
      throw new Error("invariant violation: hybrid は実装と検証を別 provider にする必要があります");
    }
    return assignment;
  }
  const only: Provider = detection.mode === "codex-only" ? "codex" : "claude";
  return { execution: only, judgement: only, review_kind: "intra_runtime_subagent" };
}

/** role が router 管理対象 (5 役) か。po=人間 / aim=未採用 は false (engine fallback)。 */
export function isRouterRole(role: string): role is RouterRole {
  return role in ROLE_ARCHETYPE;
}

export interface TeamMemberRouting {
  index: number;
  role: string;
  /** router 管理 role なら true。false は engine ベース fallback (po/aim 等)。 */
  routed: boolean;
  decision?: RoutingDecision;
}

/**
 * team member 群を router に通し、各 member の配置決定 (provider / model / T0 ゲート) を返す。
 * これを team run の placement オーバーライドへ流し込むと、チーム実行が主→相手のクロス配置
 * (ワーカー=主 / 相談・検証=相手) と原則安くの tier モデルで駆動される (PLAN-L7-75 §2 統合)。
 * router 非対象 role (po/aim) は routed=false で engine ベースに委ねる。
 */
export function routeTeamMembers(
  members: { role: string; task: string }[],
  detection: RuntimeDetection,
  options: RouteOptions = {},
): TeamMemberRouting[] {
  return members.map((member, index) => {
    if (!isRouterRole(member.role)) return { index, role: member.role, routed: false };
    return {
      index,
      role: member.role,
      routed: true,
      decision: route({ role: member.role, task: { text: member.task } }, detection, options),
    };
  });
}

export interface RosterBinding {
  role: RouterRole;
  archetype: Archetype;
  claude: string;
  codex: string;
}

/**
 * 対称 roster ビュー (5 role × 2 provider = 10 binding)。Claude と Codex/GPT を同一 role・
 * 同一 archetype で両建てする (GPT も Claude と同じ設定)。ワーカーは既定 tier (T2)、相談/検証は T0。
 */
export function roster(): RosterBinding[] {
  return (Object.keys(ROLE_ARCHETYPE) as RouterRole[]).map((role) => {
    const tier: Tier = ROLE_ARCHETYPE[role] === "worker" ? "T2" : "T0";
    return {
      role,
      archetype: ROLE_ARCHETYPE[role],
      claude: TIER_TABLE[tier].claude,
      codex: TIER_TABLE[tier].codex,
    };
  });
}

/**
 * 決定 → 実行層ブリッジ (接続)。RoutingDecision を、配置済み provider の adapter 実行プラン
 * (command / args / available) へ変換する。blocked (T0 未承認) は実行不可なので null を返す
 * (fail-close)。これが難易度ルーターの決定を team/provider dispatch へ繋ぐ接続点。
 */
export function routeToAdapterPlan(
  decision: RoutingDecision,
  task: string,
  options: { mode: ExecutionMode; contextInjection?: AdapterContextInjection },
): AdapterPlan | null {
  if (decision.status !== "ready" || decision.model === null) return null;
  return buildAdapterPlan(
    {
      provider: decision.provider,
      role: decision.role,
      task,
      model: decision.model,
      contextInjection: options.contextInjection,
    },
    options.mode,
  );
}
