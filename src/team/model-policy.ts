import { recommendModelEffort } from "../workflow/contracts";
import type { TeamProvider } from "./run";

/**
 * 正本モデル ID カタログ (SSoT)。tier-router の `TIER_TABLE` と本ファイルの `modelForProvider`
 * は同じ ID を二重に literal で持っていた (PLAN-L7-58 carry: typo/drift の温床)。両者がこの 1 箇所を
 * 参照することで ID 定義を一元化する。team→task は無く tier-router(task)→model-policy(team) の
 * 既存一方向 edge なので、ここに置いても循環しない。
 *
 * 価格表 (`src/state-db/token-tracker.ts`) は外部 pricing 由来の別正本 (pro/mini/nano を含む superset)
 * なので統合しない — router の roster とは関心が異なる。
 */
export const MODEL_IDS = {
  claude: {
    opus: "claude-opus-4-8",
    sonnet: "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5",
  },
  codex: {
    /** T0 フロンティア (相談/検証の最上位帯)。 */
    frontier: "gpt-5.5",
    /** T1 ワーカー専門。 */
    worker: "gpt-5.4",
    /** T2 ワーカー軽量 (原則安く)。 */
    spark: "gpt-5.3-codex-spark",
    mini: "gpt-5.4-mini",
    /** codex-family エンジン指定時の専用モデル (model-policy 専用、roster 外)。 */
    codex: "gpt-5.3-codex",
  },
} as const;

export const TASK_DIFFICULTIES = ["trivial", "simple", "standard", "complex", "critical"] as const;
export type TaskDifficulty = (typeof TASK_DIFFICULTIES)[number];

export const REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface TeamModelSelection {
  provider: TeamProvider;
  difficulty: TaskDifficulty;
  difficulty_source: "explicit" | "inferred";
  model_family: string;
  model: string;
  model_source: "explicit" | "engine" | "policy";
  reasoning_effort: ReasoningEffort;
  effort_source: "explicit" | "policy";
  evidence_path: string;
}

export type ProposalSubagentLaneName = "T2-mini" | "T2-spark" | "T1-worker" | "T0-frontier";

export interface ProposalSubagentLane {
  tier: ProposalSubagentLaneName;
  model: string;
  max_parallel: number;
  closing_authority: boolean;
  ownership: string;
  guard: string;
}

export const PROPOSAL_SUBAGENT_LANES: Record<ProposalSubagentLaneName, ProposalSubagentLane> = {
  "T2-mini": {
    tier: "T2-mini",
    model: MODEL_IDS.codex.mini,
    max_parallel: 4,
    closing_authority: false,
    ownership: "disjoint research sources, template families, or documentation sections",
    guard: "read-only or disjoint documentation/research edits; cannot reduce required coverage",
  },
  "T2-spark": {
    tier: "T2-spark",
    model: MODEL_IDS.codex.spark,
    max_parallel: 3,
    closing_authority: false,
    ownership: "disjoint low-risk files, lint rules, or targeted tests",
    guard: "owned files only; no production, security, migration, or external API changes",
  },
  "T1-worker": {
    tier: "T1-worker",
    model: MODEL_IDS.codex.worker,
    max_parallel: 2,
    closing_authority: false,
    ownership: "disjoint implementation slices with paired design and test-design updates",
    guard: "must update paired design and test-design evidence before review",
  },
  "T0-frontier": {
    tier: "T0-frontier",
    model: MODEL_IDS.codex.frontier,
    max_parallel: 1,
    closing_authority: true,
    ownership: "single judgement owner for risk, routing, or approval decision",
    guard: "requires explicit frontier approval and human/risk evidence",
  },
};

const CRITICAL_TERMS = [
  "auth",
  "authorization",
  "authentication",
  "credential",
  "incident",
  "migration",
  "payment",
  "pii",
  "production",
  "release",
  "schema",
  "secret",
  "security",
];

const COMPLEX_TERMS = [
  "adapter",
  "architecture",
  "concurrency",
  "cross",
  "database",
  "doctor",
  "integration",
  "orchestration",
  "refactor",
  "runtime",
  "subagent",
];

const SIMPLE_TERMS = ["comment", "docs", "format", "lint", "readme", "rename", "typo"];

function hasAny(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => text.includes(term));
}

export function inferTaskDifficulty(input: {
  task: string;
  role?: string;
  difficulty?: TaskDifficulty;
}): { difficulty: TaskDifficulty; source: "explicit" | "inferred" } {
  if (input.difficulty) return { difficulty: input.difficulty, source: "explicit" };

  const text = `${input.role ?? ""} ${input.task}`.toLowerCase();
  if (hasAny(text, CRITICAL_TERMS)) return { difficulty: "critical", source: "inferred" };
  if (hasAny(text, COMPLEX_TERMS)) return { difficulty: "complex", source: "inferred" };
  if (hasAny(text, SIMPLE_TERMS)) {
    return {
      difficulty: input.task.length < 80 ? "trivial" : "simple",
      source: "inferred",
    };
  }
  return { difficulty: "standard", source: "inferred" };
}

function recommendationInput(difficulty: TaskDifficulty): {
  size: "S" | "M" | "L";
  uncertainty: number;
} {
  switch (difficulty) {
    case "trivial":
      return { size: "S", uncertainty: 0.15 };
    case "simple":
      return { size: "S", uncertainty: 0.25 };
    case "standard":
      return { size: "M", uncertainty: 0.45 };
    case "complex":
      return { size: "L", uncertainty: 0.65 };
    case "critical":
      return { size: "L", uncertainty: 0.85 };
  }
}

function modelForProvider(input: { provider: TeamProvider; engine: string; modelFamily: string }): {
  model: string;
  source: "engine" | "policy";
} {
  if (input.provider === "local") return { model: "local", source: "policy" };
  if (input.provider === "codex") {
    // frontier = 最上位帯。tier-router TIER_TABLE.T0.codex (= MODEL_IDS.codex.frontier) と同一正本。
    // 旧 gpt-5.4 (= worker) は T1 (ワーカー専門) であり、claude frontier=opus(T0) との非対称を生んでいた。
    if (input.modelFamily === "frontier")
      return { model: MODEL_IDS.codex.frontier, source: "policy" };
    if (input.modelFamily === "codex") return { model: MODEL_IDS.codex.codex, source: "policy" };
    return { model: MODEL_IDS.codex.spark, source: "policy" };
  }

  const engine = input.engine.toLowerCase();
  if (engine.includes("opus")) return { model: MODEL_IDS.claude.opus, source: "engine" };
  if (engine.includes("haiku")) return { model: MODEL_IDS.claude.haiku, source: "engine" };
  if (engine.includes("sonnet")) return { model: MODEL_IDS.claude.sonnet, source: "engine" };
  if (input.modelFamily === "frontier") return { model: MODEL_IDS.claude.opus, source: "policy" };
  if (input.modelFamily === "codex") return { model: MODEL_IDS.claude.sonnet, source: "policy" };
  return { model: MODEL_IDS.claude.haiku, source: "policy" };
}

export function selectTeamModel(input: {
  provider: TeamProvider;
  role: string;
  engine: string;
  task: string;
  difficulty?: TaskDifficulty;
  model?: string;
  effort?: ReasoningEffort;
}): TeamModelSelection {
  const difficulty = inferTaskDifficulty(input);
  const recInput = recommendationInput(difficulty.difficulty);
  const recommendation = recommendModelEffort({
    task: input.task,
    drive: "agent",
    layer: "L7",
    size: recInput.size,
    uncertainty: recInput.uncertainty,
  });
  const selectedModel = modelForProvider({
    provider: input.provider,
    engine: input.engine,
    modelFamily: recommendation.model_family,
  });

  return {
    provider: input.provider,
    difficulty: difficulty.difficulty,
    difficulty_source: difficulty.source,
    model_family: recommendation.model_family,
    model: input.model ?? selectedModel.model,
    model_source: input.model ? "explicit" : selectedModel.source,
    reasoning_effort: input.effort ?? recommendation.reasoning_effort,
    effort_source: input.effort ? "explicit" : "policy",
    evidence_path: recommendation.evidence_path,
  };
}
