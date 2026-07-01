import type { ExecutionMode } from "../runtime/detect";
import type { TeamDefinition, TeamMember } from "../schema/team";
import {
  inferTaskDifficulty,
  type ProposalSubagentLaneName,
  type TaskDifficulty,
} from "./model-policy";

export type TeamLaunchTrigger = "difficulty" | "risk" | "simple" | "unavailable";

export interface TeamLaunchRecommendation {
  should_launch: boolean;
  mode: ExecutionMode;
  difficulty: TaskDifficulty;
  difficulty_source: "explicit" | "inferred";
  trigger: TeamLaunchTrigger;
  reason: string;
  definition?: TeamDefinition;
}

export interface ProposalSubagentRecommendationInput {
  role: TeamMember["role"];
  tier: ProposalSubagentLaneName;
  model: string;
  purpose: string;
  parallel_slots: number;
  closing_authority: boolean;
  ownership: string;
}

const RISK_TERMS = [
  "auth",
  "authorization",
  "credential",
  "database",
  "doctor",
  "migration",
  "payment",
  "pii",
  "production",
  "release",
  "runtime",
  "schema",
  "secret",
  "security",
  "subagent",
  "windows",
];

function hasRiskTerm(task: string): boolean {
  const text = task.toLowerCase();
  return RISK_TERMS.some((term) => text.includes(term));
}

function memberWithOptionalSerialization(input: {
  role: TeamMember["role"];
  engine: string;
  task: string;
  difficulty: TaskDifficulty;
  model?: string;
  effort?: "low" | "medium" | "high";
  ownership?: string;
  serialize_after?: string;
}): TeamMember {
  const member: TeamMember = {
    role: input.role,
    engine: input.engine,
    task: input.task,
    difficulty: input.difficulty,
  };
  if (input.model) member.model = input.model;
  if (input.effort) member.effort = input.effort;
  if (input.ownership) member.ownership = input.ownership;
  if (input.serialize_after) member.serialize_after = input.serialize_after;
  return member;
}

function buildDefinition(input: { task: string; difficulty: TaskDifficulty }): TeamDefinition {
  const sequentialReview = input.difficulty === "complex" || input.difficulty === "critical";
  const members: TeamMember[] = [
    memberWithOptionalSerialization({
      role: "se",
      engine: "codex-se",
      task: input.task,
      difficulty: input.difficulty,
    }),
    memberWithOptionalSerialization({
      role: "tl",
      engine: "pmo-sonnet",
      task: sequentialReview
        ? `Review the implementation for: ${input.task}`
        : `Review plan and risks for: ${input.task}`,
      difficulty: input.difficulty,
      serialize_after: sequentialReview ? "se" : undefined,
    }),
  ];

  if (input.difficulty === "critical") {
    members.push(
      memberWithOptionalSerialization({
        role: "qa",
        engine: "claude-qa",
        task: `Verify acceptance and regression coverage for: ${input.task}`,
        difficulty: input.difficulty,
        serialize_after: "tl",
      }),
    );
  }

  return {
    name: "auto-speed-team",
    strategy: "parallel",
    max_parallel: input.difficulty === "critical" ? 3 : 2,
    members,
  };
}

function difficultyForLane(
  lane: ProposalSubagentRecommendationInput,
  fallback: TaskDifficulty,
): TaskDifficulty {
  if (lane.tier === "T2-mini" || lane.tier === "T2-spark") return "simple";
  if (lane.tier === "T1-worker") return fallback === "trivial" ? "standard" : fallback;
  return "critical";
}

function effortForLane(lane: ProposalSubagentRecommendationInput): "low" | "medium" | "high" {
  if (lane.tier === "T2-mini" || lane.tier === "T2-spark") return "low";
  if (lane.tier === "T1-worker") return "medium";
  return "high";
}

function engineForLane(lane: ProposalSubagentRecommendationInput, index: number): string {
  const suffix = `${lane.tier.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${index + 1}`;
  return `codex-${lane.role}-${suffix}`;
}

function buildProposalDefinition(input: {
  task: string;
  difficulty: TaskDifficulty;
  lanes: ProposalSubagentRecommendationInput[];
}): TeamDefinition {
  const members: TeamMember[] = [];
  let firstParallelEngine: string | undefined;
  for (const lane of input.lanes) {
    if (lane.closing_authority) continue;
    const slots = lane.closing_authority ? 1 : Math.max(1, lane.parallel_slots);
    for (let i = 0; i < slots; i += 1) {
      const engine = engineForLane(lane, i);
      if (!lane.closing_authority && firstParallelEngine === undefined) {
        firstParallelEngine = engine;
      }
      const ownership = slots === 1 ? lane.ownership : `${lane.ownership}; shard ${i + 1}/${slots}`;
      members.push(
        memberWithOptionalSerialization({
          role: lane.role,
          engine,
          task: `${lane.purpose}: ${input.task}`,
          difficulty: difficultyForLane(lane, input.difficulty),
          model: lane.model,
          effort: effortForLane(lane),
          ownership,
          serialize_after: lane.closing_authority ? firstParallelEngine : undefined,
        }),
      );
    }
  }
  if (firstParallelEngine) {
    members.push(
      memberWithOptionalSerialization({
        role: "tl",
        engine: "pmo-sonnet",
        task: `Cross-provider review of proposal lane outputs for: ${input.task}`,
        difficulty: input.difficulty === "critical" ? "critical" : "standard",
        effort: input.difficulty === "critical" ? "high" : "medium",
        ownership: "single cross-provider review of mini/spark outputs and coverage guardrails",
        serialize_after: firstParallelEngine,
      }),
    );
  }

  return {
    name: "proposal-coverage-team",
    strategy: "parallel",
    max_parallel: Math.min(8, Math.max(1, members.filter((m) => !m.serialize_after).length)),
    members,
  };
}

export function recommendTeamLaunch(input: {
  task: string;
  mode: ExecutionMode;
  difficulty?: TaskDifficulty;
  proposalSubagents?: ProposalSubagentRecommendationInput[];
}): TeamLaunchRecommendation {
  const difficulty = inferTaskDifficulty({
    task: input.task,
    difficulty: input.difficulty,
  });
  if (input.mode !== "hybrid") {
    return {
      should_launch: false,
      mode: input.mode,
      difficulty: difficulty.difficulty,
      difficulty_source: difficulty.source,
      trigger: "unavailable",
      reason: `team launch requires hybrid mode; current mode=${input.mode}`,
    };
  }

  const risk = hasRiskTerm(input.task);
  if (input.proposalSubagents && input.proposalSubagents.length > 0) {
    return {
      should_launch: input.mode === "hybrid",
      mode: input.mode,
      difficulty: difficulty.difficulty,
      difficulty_source: difficulty.source,
      trigger: input.mode === "hybrid" ? "difficulty" : "unavailable",
      reason:
        input.mode === "hybrid"
          ? "proposal document coverage recommends parallel mini/spark subagent lanes with ownership guards"
          : `team launch requires hybrid mode; current mode=${input.mode}`,
      definition:
        input.mode === "hybrid"
          ? buildProposalDefinition({
              task: input.task,
              difficulty: difficulty.difficulty,
              lanes: input.proposalSubagents,
            })
          : undefined,
    };
  }

  const launchByDifficulty =
    difficulty.difficulty === "standard" ||
    difficulty.difficulty === "complex" ||
    difficulty.difficulty === "critical";
  if (!risk && !launchByDifficulty) {
    return {
      should_launch: false,
      mode: input.mode,
      difficulty: difficulty.difficulty,
      difficulty_source: difficulty.source,
      trigger: "simple",
      reason: `single-agent execution is sufficient for ${difficulty.difficulty} task`,
    };
  }

  const trigger: TeamLaunchTrigger = risk ? "risk" : "difficulty";
  return {
    should_launch: true,
    mode: input.mode,
    difficulty: difficulty.difficulty,
    difficulty_source: difficulty.source,
    trigger,
    reason:
      trigger === "risk"
        ? "task matches risk terms that require cross-provider worker/reviewer coverage"
        : `task difficulty ${difficulty.difficulty} requires cross-provider team coverage`,
    definition: buildDefinition({ task: input.task, difficulty: difficulty.difficulty }),
  };
}
