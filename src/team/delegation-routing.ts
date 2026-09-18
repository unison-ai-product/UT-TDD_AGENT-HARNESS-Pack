import { SUBAGENT_ALLOWLIST } from "../runtime/agent-guard-policy.ts";
import { READ_ONLY_DELEGATION_ROLES } from "../runtime/review-guard.ts";
import {
  MODEL_EFFORT_LADDER,
  MODEL_IDS,
  REVIEW_LANE_MODELS,
  type ReviewLane,
  selectTeamModel,
} from "./model-policy.ts";

/**
 * 正規委譲経路 (`ut-tdd codex/claude --role`) の role 検証 + model/effort routing
 * (PLAN-L7-255 スコープ 1)。
 *
 * A-177 F-4 で確認された倒立 — policy (`selectTeamModel`) は実装済みだが正規委譲経路が
 * role→model/effort マッピング無しで素通りし、blind-reviewer ですら worker 既定モデルに
 * 流れる — を解消する。判断ゲート role は REVIEW_LANE_MODELS (frontier/opus) へ固定し、
 * worker role は selectTeamModel の intent 推定に委ねる。明示 `--model`/`--effort` は常に優先。
 */

/**
 * subagent 名形の判断ゲート role (.claude/CLAUDE.md の opus-floor gate subagent 群)。
 * allowlist 合流 (SUBAGENT_ALLOWLIST) で role として許可されるため、短縮形
 * (qa/tl/security) と同様に frontier reviewer tier へ固定しないと worker tier へ
 * 落ちる (2026-07-16 クロスレビュー指摘 1)。
 */
const GATE_SUBAGENT_ROLES = ["ut-tdd-tl", "qa-test", "security-audit"] as const;

/** 判断ゲート role (review/verify)。frontier reviewer tier へ固定する (PO 原則 2026-07-08)。 */
export const REVIEW_GATE_ROLES: ReadonlySet<string> = new Set([
  ...READ_ONLY_DELEGATION_ROLES,
  ...GATE_SUBAGENT_ROLES,
]);

/** 実 repo で使用実績のある worker/連絡 role (grep docs/CLAUDE.md/AGENTS.md 2026-07-16)。 */
const WORKER_DELEGATION_ROLES = ["se", "po", "pm", "docs", "advisor", "tl-advisor"] as const;

/**
 * 許可 role = 判断ゲート role + worker role + subagent 名 (subagent と同名 role での委譲を許容)。
 * 未知 role は fail-close (agent-guard rule 1 と対称、A-177 F-4)。
 */
export const DELEGATION_ROLE_ALLOWLIST: ReadonlySet<string> = new Set([
  ...READ_ONLY_DELEGATION_ROLES,
  ...WORKER_DELEGATION_ROLES,
  ...SUBAGENT_ALLOWLIST,
]);

export type DelegationProvider = "claude" | "codex";

export interface DelegationRoutingInput {
  provider: DelegationProvider;
  role: string;
  task: string;
  /** 明示 --model (常に優先)。 */
  model?: string;
  /** 明示 --effort (常に優先)。 */
  effort?: string;
}

export type DelegationRouting =
  | {
      ok: true;
      model: string;
      effort: string;
      model_source: "explicit" | "review-lane" | "policy";
      effort_source: "explicit" | "ladder" | "policy";
      review_lane?: ReviewLane;
      task_intent?: string;
    }
  | { ok: false; message: string };

function normalizeRole(role: string): string {
  return role.trim().toLowerCase();
}

function reviewLaneForRole(role: string): ReviewLane {
  if (role.startsWith("blind")) return "blind-review";
  return "implementation-review";
}

function ladderBaseEffort(model: string, fallback: string): string {
  return MODEL_EFFORT_LADDER[model]?.base ?? fallback;
}

export function resolveDelegationRouting(input: DelegationRoutingInput): DelegationRouting {
  const role = normalizeRole(input.role);
  if (!DELEGATION_ROLE_ALLOWLIST.has(role)) {
    const allowed = [...DELEGATION_ROLE_ALLOWLIST].sort().join(" ");
    return {
      ok: false,
      message:
        `[ut-tdd-delegation] BLOCK: role=${input.role} is not a registered delegation role.\n` +
        `Allowed: ${allowed}`,
    };
  }

  // 判断ゲート role: 族内の frontier reviewer tier へ固定 (review は worker tier に流さない)。
  if (REVIEW_GATE_ROLES.has(role)) {
    const lane = reviewLaneForRole(role);
    const model = input.model ?? REVIEW_LANE_MODELS[lane][input.provider];
    // REVIEW_LANE_MODELS は常に ladder に載るが、明示 --model が ladder 外
    // (例: 新モデル ID) の場合のみこの fallback に到達する。
    const fallbackEffort = input.provider === "codex" ? "middle" : "high";
    const effort = input.effort ?? ladderBaseEffort(model, fallbackEffort);
    return {
      ok: true,
      model,
      effort,
      model_source: input.model ? "explicit" : "review-lane",
      effort_source: input.effort ? "explicit" : "ladder",
      review_lane: lane,
    };
  }

  // worker role: 既存 policy (intent/difficulty 推定 + effort ladder) に委ねる。
  const selection = selectTeamModel({
    provider: input.provider,
    role,
    engine: "",
    task: input.task,
    model: input.model,
    effort: input.effort as never,
  });
  return {
    ok: true,
    model: selection.model,
    effort: selection.reasoning_effort,
    model_source: input.model ? "explicit" : "policy",
    effort_source: input.effort ? "explicit" : "policy",
    task_intent: selection.task_intent,
  };
}

/** MODEL_IDS 再輸出 (テスト/呼出し側の重複 import 回避)。 */
export { MODEL_IDS };
