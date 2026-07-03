import type { AdapterContextInjection, AdapterPlan, AdapterProvider } from "../runtime/adapter";
import { buildAdapterPlan } from "../runtime/adapter";
import type { ExecutionMode } from "../runtime/detect";
import { inferTaskIntent, MODEL_IDS, type ReasoningEffort, type TaskIntent } from "./model-policy";

export interface AdvisorDecision {
  provider: AdapterProvider;
  model: string;
  effort: ReasoningEffort;
  task_intent: TaskIntent;
  current_model?: string;
  current_model_lower_than_advisor: boolean;
  reason: string;
  adapterPlan: AdapterPlan;
}

export interface AdvisorInput {
  task: string;
  mode: ExecutionMode;
  provider?: AdapterProvider;
  currentModel?: string;
  reason?: string;
  planId?: string;
  execute?: boolean;
  contextInjection?: AdapterContextInjection;
}

function providerFromModel(model: string | undefined): AdapterProvider | null {
  if (!model) return null;
  const normalized = model.toLowerCase();
  if (normalized.startsWith("gpt-") || normalized.startsWith("codex-")) return "codex";
  if (
    normalized.startsWith("claude-") ||
    normalized === "haiku" ||
    normalized === "sonnet" ||
    normalized === "opus"
  ) {
    return "claude";
  }
  return null;
}

function providerForIntent(intent: TaskIntent, mode: ExecutionMode): AdapterProvider {
  if (mode === "claude-only") return "claude";
  if (mode === "codex-only") return "codex";
  if (intent === "docs" || intent === "research" || intent === "uiux") return "claude";
  return "codex";
}

function advisorModel(provider: AdapterProvider): { model: string; effort: ReasoningEffort } {
  if (provider === "claude") return { model: MODEL_IDS.claude.opus, effort: "high" };
  return { model: MODEL_IDS.codex.frontier, effort: "xhigh" };
}

function isLowerThanAdvisor(input: {
  currentModel?: string;
  provider: AdapterProvider;
  advisorModel: string;
}): boolean {
  if (!input.currentModel) return false;
  const current = input.currentModel.toLowerCase();
  const advisor = input.advisorModel.toLowerCase();
  if (current === advisor) return false;
  if (input.provider === "claude") {
    // family 判定 (exact ID 比較は SSoT の世代更新で旧世代 sonnet/haiku を取りこぼす):
    // advisor は opus 固定なので、sonnet/haiku family は世代を問わず常に下位。
    return current.includes("sonnet") || current.includes("haiku");
  }
  return current.startsWith("gpt-") || current.startsWith("codex-");
}

function advisorPrompt(input: {
  task: string;
  taskIntent: TaskIntent;
  reason: string;
  currentModel?: string;
}): string {
  return [
    "You are an upper-model advisor for UT-TDD orchestration.",
    "Give concise judgement only. Do not edit files, run tools, or claim execution.",
    `Task intent: ${input.taskIntent}`,
    `Reason for escalation: ${input.reason}`,
    ...(input.currentModel ? [`Current orchestrator model: ${input.currentModel}`] : []),
    "",
    "Task:",
    input.task,
    "",
    "Return: judgement, key risks, missing evidence, and recommended next action.",
  ].join("\n");
}

export function buildAdvisorDecision(input: AdvisorInput): AdvisorDecision {
  const taskIntent = inferTaskIntent({ task: input.task });
  const provider =
    input.provider ??
    providerFromModel(input.currentModel) ??
    providerForIntent(taskIntent, input.mode);
  const selected = advisorModel(provider);
  const reason = input.reason?.trim() || "orchestrator is uncertain or below judgement tier";
  const prompt = advisorPrompt({
    task: input.task,
    taskIntent,
    reason,
    currentModel: input.currentModel,
  });
  const adapterPlan = buildAdapterPlan(
    {
      provider,
      role: "advisor",
      task: prompt,
      planId: input.planId,
      model: selected.model,
      effort: selected.effort,
      execute: input.execute,
      contextInjection: input.contextInjection,
    },
    input.mode,
  );

  return {
    provider,
    model: selected.model,
    effort: selected.effort,
    task_intent: taskIntent,
    ...(input.currentModel ? { current_model: input.currentModel } : {}),
    current_model_lower_than_advisor: isLowerThanAdvisor({
      currentModel: input.currentModel,
      provider,
      advisorModel: selected.model,
    }),
    reason,
    adapterPlan,
  };
}
