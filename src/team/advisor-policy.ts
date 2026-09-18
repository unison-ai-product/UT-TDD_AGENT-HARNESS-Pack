import type { AdapterContextInjection, AdapterPlan, AdapterProvider } from "../runtime/adapter.ts";
import { buildAdapterPlan } from "../runtime/adapter.ts";
import type { ExecutionMode } from "../runtime/detect.ts";
import {
  inferTaskIntent,
  MODEL_IDS,
  type ReasoningEffort,
  type TaskIntent,
} from "./model-policy.ts";

/**
 * advisor 判断種別 (PO ルーティング仕様 2026-07-29、2026-07-14 行列を supersede):
 * - implementation / troubleshooting: 技術判断。一次相談先は Codex 最上位 (Sol)。
 * - design / progress / uiux: 設計・進行・デザイン判断。一次相談先は Claude
 *   フロンティア (Fable)、次点 Sol。
 *
 * 旧行列との差分は design の移動と progress の新設。旧行列は「設計 = 技術」と
 * 束ねていたが、PO 判断は技術 (どう作るか) と設計・進行 (何をどの順で作るか) を
 * 別軸として分ける。
 */
export const ADVISOR_DECISION_KINDS = [
  "design",
  "progress",
  "implementation",
  "troubleshooting",
  "uiux",
] as const;
export type AdvisorDecisionKind = (typeof ADVISOR_DECISION_KINDS)[number];

/**
 * 相談モード:
 * - consult: 通常の上位モデル相談 (plan / course correction)。
 * - adversarial: 敵対検証。orchestrator が既に Opus (frontier 級) の場合、
 *   同格へ相談しても追認バイアスが残るため、反証専任で判断を攻撃させる。
 */
export type AdvisorConsultationMode = "consult" | "adversarial";

export interface AdvisorRoute {
  provider: AdapterProvider;
  model: string;
  effort: ReasoningEffort;
  consultation_mode: AdvisorConsultationMode;
}

export interface AdvisorDecision {
  provider: AdapterProvider;
  model: string;
  effort: ReasoningEffort;
  consultation_mode: AdvisorConsultationMode;
  decision_kind: AdvisorDecisionKind;
  decision_kind_source: "explicit" | "inferred";
  task_intent: TaskIntent;
  current_model?: string;
  current_model_lower_than_advisor: boolean;
  reason: string;
  adapterPlan: AdapterPlan;
  /**
   * 一次相談先がレスポンスエラーになった場合の切替先 (advisor-tool の
   * advisor_tool_result_error と同じ思想: 相談失敗で全体を落とさない)。
   * claude-only 等で Codex fallback が構成できない mode では省略される。
   */
  fallback?: {
    provider: AdapterProvider;
    model: string;
    effort: ReasoningEffort;
    consultation_mode: AdvisorConsultationMode;
    adapterPlan: AdapterPlan;
  };
}

export interface AdvisorInput {
  task: string;
  mode: ExecutionMode;
  provider?: AdapterProvider;
  decisionKind?: AdvisorDecisionKind;
  currentModel?: string;
  reason?: string;
  planId?: string;
  execute?: boolean;
  contextInjection?: AdapterContextInjection;
}

/** advisor もモデル別標準 effort に従う。Sol / Fable は low。 */
const ADVISOR_EFFORT: ReasoningEffort = "low";

type OrchestratorFamily = "sonnet" | "opus" | "other";

function orchestratorFamily(currentModel: string | undefined): OrchestratorFamily {
  const normalized = (currentModel ?? "").toLowerCase();
  if (normalized.includes("opus")) return "opus";
  if (normalized.includes("sonnet")) return "sonnet";
  return "other";
}

/**
 * Codex 相談は「その時点の最上位モデル」を使う。正本は MODEL_IDS.codex.frontier
 * (SSoT — 世代更新はこの 1 箇所で反映され、advisor は自動追従する)。
 */
function codexFrontierModel(): string {
  return MODEL_IDS.codex.frontier;
}

function codexRoute(mode: AdvisorConsultationMode): AdvisorRoute {
  return {
    provider: "codex",
    model: codexFrontierModel(),
    effort: ADVISOR_EFFORT,
    consultation_mode: mode,
  };
}

function fableRoute(mode: AdvisorConsultationMode): AdvisorRoute {
  return {
    provider: "claude",
    model: MODEL_IDS.claude.fable,
    effort: ADVISOR_EFFORT,
    consultation_mode: mode,
  };
}

/**
 * ルーティング行列 (PO 仕様 2026-07-29、2026-07-14 行列を supersede):
 *
 * | 判断                           | 一次           | fallback (レスポンスエラー時) |
 * | implementation/troubleshooting | Sol            | Fable                         |
 * | design / progress / uiux       | Fable          | Sol (次点、PO 明示)           |
 *
 * orchestrator が Opus (frontier 級) の場合、相談は provider を問わず敵対検証へ
 * 切り替える (同格追認ではなく反証で価値を出す)。判定軸は相談先の provider では
 * なく orchestrator の tier なので、Fable 一次の経路でも同じ扱いにする
 * (design を Fable へ移した際に敵対検証が消えるのを防ぐ)。
 * 根拠: Fable レート制限 (project-fable-5-7-13-rate-limit) と Sol の escalation 席実測。
 */
export function resolveAdvisorRoutes(input: {
  decisionKind: AdvisorDecisionKind;
  family: OrchestratorFamily;
  mode: ExecutionMode;
  forcedProvider?: AdapterProvider;
}): { primary: AdvisorRoute; fallback?: AdvisorRoute } {
  const adversarialForOpus: AdvisorConsultationMode =
    input.family === "opus" ? "adversarial" : "consult";

  if (
    (input.mode === "claude-only" && input.forcedProvider === "codex") ||
    (input.mode === "codex-only" && input.forcedProvider === "claude")
  ) {
    throw new Error(
      `advisor-provider-mode-conflict: provider=${input.forcedProvider} mode=${input.mode}`,
    );
  }
  // 明示 provider は hybrid での一次経路を固定し、別 provider へ fallback しない。
  if (input.forcedProvider === "codex") {
    return { primary: codexRoute(adversarialForOpus) };
  }
  if (input.forcedProvider === "claude") {
    return { primary: fableRoute(adversarialForOpus) };
  }
  if (input.mode === "codex-only") {
    return { primary: codexRoute(adversarialForOpus) };
  }
  if (input.mode === "claude-only") {
    return { primary: fableRoute(adversarialForOpus) };
  }
  if (
    input.decisionKind === "design" ||
    input.decisionKind === "progress" ||
    input.decisionKind === "uiux"
  ) {
    // 設計 / 進行 / デザイン判断は Fable 一次、次点 Sol (PO 2026-07-29)。
    return { primary: fableRoute(adversarialForOpus), fallback: codexRoute(adversarialForOpus) };
  }
  // 技術判断 (implementation / troubleshooting) は Sol 一次 (PO 2026-07-29 で不変)。
  return { primary: codexRoute(adversarialForOpus), fallback: fableRoute(adversarialForOpus) };
}

const TROUBLESHOOTING_TERMS = ["bug", "crash", "debug", "error", "fail", "incident", "trouble"];

/**
 * 進行判断語。着手順・優先順位・レーン割りは「何をどの順でやるか」であって技術判断
 * ではないため、technical term (fail / error 等) を含んでいても進行側へ寄せる。
 * 実例 2026-07-29: 「CI が赤い PR を先に見るか、設計 freeze を先にやるか」は
 * troubleshooting 語を含むがレーン選択。
 */
const PROGRESS_PATTERNS = [
  /\b(?:lane|priorit\w*|sequenc\w*|schedul\w*|roadmap|backlog|triage)\b/i,
  /\bwhich\b.{0,80}\b(?:should|to)\b.{0,40}\b(?:first|next)\b/i,
  /\bwhat\b.{0,40}\b(?:should|to)\b.{0,40}\b(?:first|next)\b/i,
  /\b(?:in what order|order of|execution order|work order)\b/i,
  /(?:レーン|優先順位|着手順|段取り|どれを先|どちらを先|何から(?:始め|着手|対応|直)|次に何(?:を|から))/,
];

function inferDecisionKind(taskIntent: TaskIntent, task: string): AdvisorDecisionKind {
  if (taskIntent === "uiux") return "uiux";
  const text = task.toLowerCase();
  if (PROGRESS_PATTERNS.some((pattern) => pattern.test(text))) return "progress";
  if (TROUBLESHOOTING_TERMS.some((term) => text.includes(term))) return "troubleshooting";
  return taskIntent === "implementation" || taskIntent === "test" || taskIntent === "lightweight"
    ? "implementation"
    : "design";
}

function isLowerThanAdvisor(input: {
  currentModel?: string;
  advisorProvider: AdapterProvider;
  advisorModel: string;
}): boolean {
  if (!input.currentModel) return false;
  const current = input.currentModel.toLowerCase();
  const advisor = input.advisorModel.toLowerCase();
  if (current === advisor) return false;
  if (input.advisorProvider === "claude") {
    // family 判定 (exact ID 比較は SSoT の世代更新で旧世代を取りこぼす):
    // advisor が fable の場合 opus/sonnet/haiku family は世代を問わず下位。
    if (advisor.includes("fable")) {
      return current.includes("opus") || current.includes("sonnet") || current.includes("haiku");
    }
    return current.includes("sonnet") || current.includes("haiku");
  }
  // advisor が Codex frontier (Sol) の場合: GPT/Codex 系 current は frontier 未満、
  // Claude 系 current は frontier 級 (fable/opus) を除き下位 (sonnet/haiku)。
  return (
    current.startsWith("gpt-") ||
    current.startsWith("codex-") ||
    current.includes("sonnet") ||
    current.includes("haiku")
  );
}

function advisorPrompt(input: {
  task: string;
  taskIntent: TaskIntent;
  decisionKind: AdvisorDecisionKind;
  consultationMode: AdvisorConsultationMode;
  reason: string;
  currentModel?: string;
}): string {
  const roleLines =
    input.consultationMode === "adversarial"
      ? [
          "You are an adversarial verifier for UT-TDD orchestration.",
          "The orchestrator is already a frontier-class model; do not rubber-stamp.",
          "Actively try to refute its judgement: hunt for wrong assumptions, missing",
          "evidence, unverified claims, and failure modes. If the judgement survives",
          "your attack, say so explicitly and state what evidence made it survive.",
        ]
      : [
          "You are an upper-model advisor for UT-TDD orchestration.",
          "Give concise judgement only. Do not edit files, run tools, or claim execution.",
        ];
  return [
    ...roleLines,
    `Decision kind: ${input.decisionKind}`,
    `Task intent: ${input.taskIntent}`,
    `Reason for escalation: ${input.reason}`,
    ...(input.currentModel ? [`Current orchestrator model: ${input.currentModel}`] : []),
    "",
    "Task:",
    input.task,
    "",
    input.consultationMode === "adversarial"
      ? "Return: strongest counter-arguments, unverified assumptions, missing evidence, and a survive/refuted verdict with rationale."
      : "Return: judgement, key risks, missing evidence, and recommended next action.",
  ].join("\n");
}

export function buildAdvisorDecision(input: AdvisorInput): AdvisorDecision {
  const taskIntent = inferTaskIntent({ task: input.task });
  const decisionKind = input.decisionKind ?? inferDecisionKind(taskIntent, input.task);
  const family = orchestratorFamily(input.currentModel);
  const routes = resolveAdvisorRoutes({
    decisionKind,
    family,
    mode: input.mode,
    forcedProvider: input.provider,
  });
  const reason = input.reason?.trim() || "orchestrator is uncertain or below judgement tier";

  const buildPlan = (route: AdvisorRoute): AdapterPlan =>
    buildAdapterPlan(
      {
        provider: route.provider,
        role: "advisor",
        task: advisorPrompt({
          task: input.task,
          taskIntent,
          decisionKind,
          consultationMode: route.consultation_mode,
          reason,
          currentModel: input.currentModel,
        }),
        planId: input.planId,
        model: route.model,
        effort: route.effort,
        execute: input.execute,
        contextInjection: input.contextInjection,
      },
      input.mode,
    );

  const primaryPlan = buildPlan(routes.primary);
  const fallback = routes.fallback
    ? {
        provider: routes.fallback.provider,
        model: routes.fallback.model,
        effort: routes.fallback.effort,
        consultation_mode: routes.fallback.consultation_mode,
        adapterPlan: buildPlan(routes.fallback),
      }
    : undefined;

  return {
    provider: routes.primary.provider,
    model: routes.primary.model,
    effort: routes.primary.effort,
    consultation_mode: routes.primary.consultation_mode,
    decision_kind: decisionKind,
    decision_kind_source: input.decisionKind ? "explicit" : "inferred",
    task_intent: taskIntent,
    ...(input.currentModel ? { current_model: input.currentModel } : {}),
    current_model_lower_than_advisor: isLowerThanAdvisor({
      currentModel: input.currentModel,
      advisorProvider: routes.primary.provider,
      advisorModel: routes.primary.model,
    }),
    reason,
    adapterPlan: primaryPlan,
    ...(fallback ? { fallback } : {}),
  };
}
