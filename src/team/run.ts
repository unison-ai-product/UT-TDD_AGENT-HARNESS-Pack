import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  type AdapterContextInjection,
  type AdapterPlan,
  type AdapterProvider,
  buildAdapterPlan,
} from "../runtime/adapter";
import {
  type AgentSlotsDeps,
  fireSlot,
  releaseSlot,
  type Slot,
  type SlotStatus,
} from "../runtime/agent-slots";
import type { ExecutionMode } from "../runtime/detect";
import {
  mustSerialize,
  type TeamDefinition,
  type TeamMember,
  teamDefinitionSchema,
} from "../schema/team";
import { selectTeamModel, type TeamModelSelection } from "./model-policy";
import {
  dependencyFailedMessage,
  duplicateRoleProviderMessage,
  frontierBlockedMessage,
  memberNotExecutableMessage,
  serializeAfterTargetAmbiguousMessage,
  serializeAfterTargetNotFoundMessage,
  TEAM_MEMBER_PROMPT_HEADER,
  TEAM_MEMBER_RULES,
  TEAM_MEMBER_RULES_HEADER,
  TEAM_MEMBER_TASK_HEADER,
  TEAM_RUN_DRY_RUN_EXECUTION_MESSAGE,
  TEAM_RUN_NOT_EXECUTABLE_MESSAGE,
  TEAM_RUN_REQUIRES_BOTH_RUNTIMES_MESSAGE,
  TEAM_RUN_REQUIRES_CROSS_PROVIDER_REVIEW_MESSAGE,
  TEAM_RUN_REQUIRES_HYBRID_MESSAGE,
  teamDependencyCycleMessage,
} from "./run-policy";

export type TeamProvider = AdapterProvider | "local";

export interface TeamValidationResult {
  ok: boolean;
  mode: ExecutionMode;
  providers: TeamProvider[];
  messages: string[];
}

/**
 * member ごとの配置オーバーライド (PLAN-L7-75 統合)。tier-router の決定を team run へ
 * 注入するための seam。provider/model を engine 既定より優先し、T0 ゲートで止まった member は
 * blockedReason を持つ (実行不可 / fail-close)。null は engine ベース既定にフォールバックする。
 */
export interface MemberPlacement {
  provider: TeamProvider;
  model: string;
  blockedReason?: string;
}

export interface TeamMemberLaunch {
  index: number;
  role: string;
  engine: string;
  provider: TeamProvider;
  task: string;
  ownership?: string;
  prompt: string;
  model_selection: TeamModelSelection;
  serialize_after?: string;
  adapter?: AdapterPlan;
  executable: boolean;
}

export interface TeamRunPlan extends TeamValidationResult {
  team: string;
  strategy: TeamDefinition["strategy"];
  max_parallel: number;
  dry_run: boolean;
  executable: boolean;
  members: TeamMemberLaunch[];
}

export interface TeamMemberExecution {
  index: number;
  role: string;
  engine: string;
  provider: TeamProvider;
  command: string | null;
  args: string[];
  slot_id: string | null;
  exit_code: number | null;
  status: SlotStatus;
  skipped_reason?: string;
}

export interface TeamRunExecution {
  ok: boolean;
  dry_run: false;
  team: string;
  strategy: TeamDefinition["strategy"];
  executions: TeamMemberExecution[];
  messages: string[];
}

export interface TeamRunnerDeps {
  slots: AgentSlotsDeps;
  runCommand: (input: {
    command: string;
    args: string[];
    provider: AdapterProvider;
    env?: Record<string, string>;
    /** codex はプロンプトを stdin で受ける (cmd.exe shell-wrap 回避、PLAN-L7-77)。 */
    stdin?: string;
  }) => Promise<{ exitCode: number | null }>;
}

export function providerFromEngine(engine: string): TeamProvider {
  const e = engine.toLowerCase();
  if (e.startsWith("codex")) return "codex";
  if (
    e.startsWith("claude") ||
    e.startsWith("pmo-") ||
    e.includes("sonnet") ||
    e.includes("haiku") ||
    e.includes("opus")
  ) {
    return "claude";
  }
  return "local";
}

function buildMemberPrompt(
  team: TeamDefinition,
  member: TeamMember,
  selection: TeamModelSelection,
): string {
  return [
    `${TEAM_MEMBER_PROMPT_HEADER}: ${member.role}`,
    `team: ${team.name}`,
    `engine: ${member.engine}`,
    `provider: ${selection.provider}`,
    `difficulty: ${selection.difficulty}`,
    `model_family: ${selection.model_family}`,
    `selected_model: ${selection.model}`,
    `reasoning_effort: ${selection.reasoning_effort}`,
    `selection_evidence: ${selection.evidence_path}`,
    member.ownership ? `ownership: ${member.ownership}` : null,
    "",
    TEAM_MEMBER_TASK_HEADER,
    member.task,
    "",
    TEAM_MEMBER_RULES_HEADER,
    ...TEAM_MEMBER_RULES.map((rule) => `- ${rule}`),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function dependencyKey(member: TeamMemberLaunch): string {
  return `${member.role}:${member.engine}`;
}

function findDependency(
  members: TeamMemberLaunch[],
  requested: string,
): TeamMemberLaunch | null | "ambiguous" {
  const matches = members.filter(
    (member) => member.role === requested || member.engine === requested,
  );
  if (matches.length === 0) return null;
  if (matches.length > 1) return "ambiguous";
  return matches[0];
}

function orderMembersByDependencies(input: {
  members: TeamMemberLaunch[];
  messages: string[];
}): TeamMemberLaunch[] {
  const ordered: TeamMemberLaunch[] = [];
  const visiting = new Set<number>();
  const visited = new Set<number>();

  const visit = (member: TeamMemberLaunch): void => {
    if (visited.has(member.index)) return;
    if (visiting.has(member.index)) {
      input.messages.push(teamDependencyCycleMessage(dependencyKey(member)));
      return;
    }
    visiting.add(member.index);
    if (member.serialize_after) {
      const dependency = findDependency(input.members, member.serialize_after);
      if (dependency === null) {
        input.messages.push(
          serializeAfterTargetNotFoundMessage(dependencyKey(member), member.serialize_after),
        );
      } else if (dependency === "ambiguous") {
        input.messages.push(
          serializeAfterTargetAmbiguousMessage(dependencyKey(member), member.serialize_after),
        );
      } else {
        visit(dependency);
      }
    }
    visiting.delete(member.index);
    visited.add(member.index);
    if (!ordered.some((row) => row.index === member.index)) ordered.push(member);
  };

  for (const member of input.members) visit(member);
  return ordered;
}

export function loadTeamDefinition(path: string): TeamDefinition {
  if (!existsSync(path)) throw new Error(`team definition not found: ${path}`);
  return teamDefinitionSchema.parse(parseYaml(readFileSync(path, "utf8")));
}

/** member の実効 provider: placement オーバーライドがあれば優先、無ければ engine 既定。 */
function memberProvider(
  member: TeamMember,
  placement: MemberPlacement | null | undefined,
): TeamProvider {
  return placement?.provider ?? providerFromEngine(member.engine);
}

export function validateTeamRun(
  team: TeamDefinition,
  mode: ExecutionMode,
  placements?: (MemberPlacement | null)[],
): TeamValidationResult {
  const messages: string[] = [];
  if (mode !== "hybrid") messages.push(TEAM_RUN_REQUIRES_HYBRID_MESSAGE);

  const placed = team.members.map((member, index) => ({
    role: member.role,
    provider: memberProvider(member, placements?.[index]),
  }));

  const providers = [...new Set(placed.map((p) => p.provider))];
  const runtimeProviders = providers.filter((p) => p === "claude" || p === "codex");
  if (mode === "hybrid" && new Set(runtimeProviders).size < 2) {
    messages.push(TEAM_RUN_REQUIRES_BOTH_RUNTIMES_MESSAGE);
  }

  const seenRoleProvider = new Set<string>();
  const seenRoleProviderOwnership = new Set<string>();
  for (const member of placed) {
    const key = `${member.role}:${member.provider}`;
    const ownership = team.members[placed.indexOf(member)]?.ownership?.trim();
    const ownershipKey = `${key}:${ownership ?? ""}`;
    if (seenRoleProvider.has(key) && (!ownership || seenRoleProviderOwnership.has(ownershipKey))) {
      messages.push(duplicateRoleProviderMessage(key));
    }
    seenRoleProvider.add(key);
    if (ownership) seenRoleProviderOwnership.add(ownershipKey);
  }

  const workerProviders = new Set(placed.filter((m) => m.role === "se").map((m) => m.provider));
  const reviewerProviders = new Set(
    placed.filter((m) => m.role === "tl" || m.role === "qa").map((m) => m.provider),
  );
  if (mode === "hybrid" && workerProviders.size > 0 && reviewerProviders.size > 0) {
    const hasCrossProvider = [...workerProviders].some(
      (worker) =>
        worker !== "local" && [...reviewerProviders].some((reviewer) => reviewer !== worker),
    );
    if (!hasCrossProvider) {
      messages.push(TEAM_RUN_REQUIRES_CROSS_PROVIDER_REVIEW_MESSAGE);
    }
  }

  return { ok: messages.length === 0, mode, providers, messages };
}

export function buildTeamRunPlan(
  team: TeamDefinition,
  mode: ExecutionMode,
  input: {
    execute?: boolean;
    planId?: string;
    placements?: (MemberPlacement | null)[];
    contextInjection?: AdapterContextInjection;
  } = {},
): TeamRunPlan {
  const validation = validateTeamRun(team, mode, input.placements);
  const forceSequential =
    mustSerialize(team.serialization) || team.members.some((m) => m.serialize_after);
  const strategy = forceSequential ? "sequential" : team.strategy;
  const messages = [...validation.messages];

  const unorderedMembers = team.members.map((member, index): TeamMemberLaunch => {
    const placement = input.placements?.[index] ?? null;
    const blocked = placement?.blockedReason;
    const provider = memberProvider(member, placement);
    const modelSelection = selectTeamModel({
      provider,
      role: member.role,
      engine: member.engine,
      task: member.task,
      difficulty: member.difficulty,
      // placement (tier-router) のモデルを engine 既定より優先。空文字 (blocked) は無視。
      model: placement?.model || member.model,
      effort: member.effort,
    });
    const prompt = buildMemberPrompt(team, member, modelSelection);
    const adapter =
      !blocked && (provider === "claude" || provider === "codex")
        ? buildAdapterPlan(
            {
              provider,
              role: member.role,
              task: prompt,
              planId: input.planId,
              model: modelSelection.model,
              effort: modelSelection.reasoning_effort,
              execute: input.execute,
              contextInjection: input.contextInjection,
            },
            mode,
          )
        : undefined;
    return {
      index,
      role: member.role,
      engine: member.engine,
      provider,
      task: member.task,
      ownership: member.ownership,
      prompt,
      model_selection: modelSelection,
      serialize_after: member.serialize_after,
      adapter,
      executable: !blocked && Boolean(adapter?.available),
    };
  });
  const members = orderMembersByDependencies({ members: unorderedMembers, messages });

  // T0 (frontier) ゲートで止まった member は fail-close: 明示許可 (--allow-frontier) が要る。
  for (const member of members) {
    const blockedReason = input.placements?.[member.index]?.blockedReason;
    if (blockedReason) {
      messages.push(frontierBlockedMessage(`${member.role}:${member.engine}`, blockedReason));
    }
  }

  if (input.execute) {
    for (const member of members) {
      const blocked = input.placements?.[member.index]?.blockedReason;
      if (!blocked && !member.executable) {
        messages.push(memberNotExecutableMessage(`${member.role}:${member.engine}`));
      }
    }
  }

  const ok = messages.length === 0;
  return {
    ...validation,
    ok,
    strategy,
    messages,
    team: team.name,
    max_parallel: team.max_parallel,
    dry_run: !input.execute,
    executable: ok && members.every((m) => m.executable),
    members,
  };
}

async function executeMember(
  member: TeamMemberLaunch,
  deps: TeamRunnerDeps,
): Promise<TeamMemberExecution> {
  if (!member.adapter || !member.executable) {
    return {
      index: member.index,
      role: member.role,
      engine: member.engine,
      provider: member.provider,
      command: null,
      args: [],
      slot_id: null,
      exit_code: null,
      status: "failed",
    };
  }
  let slot: Slot | null = null;
  try {
    slot = fireSlot(
      { agent_kind: member.engine, role: member.role, slot_source: "team_runner" },
      deps.slots,
    );
    const run = await deps.runCommand({
      command: member.adapter.command,
      args: member.adapter.args,
      provider: member.adapter.provider,
      env: member.adapter.env,
      stdin: member.adapter.stdin,
    });
    const status: SlotStatus = run.exitCode === 0 ? "completed" : "failed";
    releaseSlot({ slotId: slot.slot_id, status, exitCode: run.exitCode }, deps.slots);
    return {
      index: member.index,
      role: member.role,
      engine: member.engine,
      provider: member.provider,
      command: member.adapter.command,
      args: member.adapter.args,
      slot_id: slot.slot_id,
      exit_code: run.exitCode,
      status,
    };
  } catch {
    if (slot) releaseSlot({ slotId: slot.slot_id, status: "failed", exitCode: null }, deps.slots);
    return {
      index: member.index,
      role: member.role,
      engine: member.engine,
      provider: member.provider,
      command: member.adapter.command,
      args: member.adapter.args,
      slot_id: slot?.slot_id ?? null,
      exit_code: null,
      status: "failed",
    };
  }
}

export async function executeTeamRunPlan(
  plan: TeamRunPlan,
  deps: TeamRunnerDeps,
): Promise<TeamRunExecution> {
  if (plan.dry_run) {
    return {
      ok: false,
      dry_run: false,
      team: plan.team,
      strategy: plan.strategy,
      executions: [],
      messages: [TEAM_RUN_DRY_RUN_EXECUTION_MESSAGE],
    };
  }
  if (!plan.ok || !plan.executable) {
    return {
      ok: false,
      dry_run: false,
      team: plan.team,
      strategy: plan.strategy,
      executions: [],
      messages: plan.messages.length > 0 ? plan.messages : [TEAM_RUN_NOT_EXECUTABLE_MESSAGE],
    };
  }

  const executions: TeamMemberExecution[] = [];
  if (plan.strategy === "parallel") {
    for (let i = 0; i < plan.members.length; i += plan.max_parallel) {
      const batch = plan.members.slice(i, i + plan.max_parallel);
      executions.push(...(await Promise.all(batch.map((member) => executeMember(member, deps)))));
    }
  } else {
    const failedDependencies = new Set<string>();
    for (const member of plan.members) {
      if (member.serialize_after && failedDependencies.has(member.serialize_after)) {
        executions.push({
          index: member.index,
          role: member.role,
          engine: member.engine,
          provider: member.provider,
          command: member.adapter?.command ?? null,
          args: member.adapter?.args ?? [],
          slot_id: null,
          exit_code: null,
          status: "failed",
          skipped_reason: dependencyFailedMessage(member.serialize_after),
        });
        failedDependencies.add(member.role);
        failedDependencies.add(member.engine);
        continue;
      }
      const execution = await executeMember(member, deps);
      executions.push(execution);
      if (execution.status !== "completed") {
        failedDependencies.add(member.role);
        failedDependencies.add(member.engine);
      }
    }
  }

  return {
    ok: executions.every((execution) => execution.status === "completed"),
    dry_run: false,
    team: plan.team,
    strategy: plan.strategy,
    executions,
    messages: [],
  };
}
