import { recommendModelEffort } from "../workflow/contracts.ts";
import type { TeamProvider } from "./run.ts";

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
    /** Claude 5 世代フロンティア (advisor 一次相談先、2026-07 更新)。 */
    fable: "claude-fable-5",
    opus: "claude-opus-5",
    /** Sonnet 5 世代 (2026-06 更新)。coding/agentic で旧 Opus 級、価格帯は 4-6 と同一。 */
    sonnet: "claude-sonnet-5",
    haiku: "claude-haiku-4-5",
  },
  codex: {
    /** T0 フロンティア (検証/設計/相談の最上位帯)。 */
    frontier: "gpt-5.6-sol",
    /** テスト実装専門 (PO 割当 2026-07-14)。 */
    worker: "gpt-5.6-terra",
    /** 実装 / ドキュメント修正の主力 (PO 採用 2026-07-14、effort=high 基準)。 */
    luna: "gpt-5.6-luna",
    /** T2 ワーカー軽量 (軽量実装/内部探索/web検索/doc パッチ、原則安く)。 */
    spark: "gpt-5.3-codex-spark",
    mini: "gpt-5.4-mini",
    /** codex-family エンジン指定時の専用モデル (model-policy 専用、roster 外)。 */
    codex: "gpt-5.3-codex",
  },
} as const;

export const TASK_DIFFICULTIES = ["trivial", "simple", "standard", "complex", "critical"] as const;
export type TaskDifficulty = (typeof TASK_DIFFICULTIES)[number];

/**
 * オーケストラパターン分岐 — 標準パターンの想定 orchestrator モデル (PO 2026-07-14):
 * Claude Code は設計タスク時 Opus / 設計タスク完了時 Sonnet、Codex は設計タスク時 Sol /
 * 実装タスク時 Terra を想定する。想定を下回るモデル選定で走る場合は advisor 機能を多用する
 * (`advisorHeavyUseRecommended`)。worker lane の割当 (テスト実装=terra / 実装=luna) とは別軸で、
 * こちらは「orchestrator セッション自身が何で走っているか」の期待値。
 */
export const STANDARD_ORCHESTRATION_EXPECTATION = {
  claude: {
    design: MODEL_IDS.claude.opus,
    design_completion: MODEL_IDS.claude.sonnet,
  },
  codex: {
    design: MODEL_IDS.codex.frontier,
    implementation: MODEL_IDS.codex.worker,
  },
} as const;

/** モデル capability rank (family 比較用。数値が大きいほど上位帯)。 */
const MODEL_CAPABILITY_RANK: Record<string, number> = {
  [MODEL_IDS.claude.fable]: 4,
  [MODEL_IDS.claude.opus]: 3,
  [MODEL_IDS.claude.sonnet]: 2,
  [MODEL_IDS.claude.haiku]: 1,
  [MODEL_IDS.codex.frontier]: 4,
  [MODEL_IDS.codex.worker]: 2,
  [MODEL_IDS.codex.luna]: 2,
  [MODEL_IDS.codex.codex]: 1,
  [MODEL_IDS.codex.spark]: 1,
  [MODEL_IDS.codex.mini]: 1,
};

/**
 * 現在の orchestrator モデルが標準パターンの想定を下回っているか。
 * 下回る場合、判断ポイントで advisor を多用する (PO 2026-07-14)。
 * 未知モデルは fail-open せず「下回る扱い」(advisor 推奨) に倒す。
 */
export function advisorHeavyUseRecommended(input: {
  provider: "claude" | "codex";
  phase: "design" | "design_completion" | "implementation";
  currentModel: string;
}): boolean {
  const expectation = STANDARD_ORCHESTRATION_EXPECTATION[input.provider] as Record<
    string,
    string | undefined
  >;
  const expected = expectation[input.phase];
  if (!expected) return false;
  const currentRank = MODEL_CAPABILITY_RANK[input.currentModel];
  const expectedRank = MODEL_CAPABILITY_RANK[expected];
  if (currentRank === undefined || expectedRank === undefined) return true;
  return currentRank < expectedRank;
}

/**
 * レビュー 3 面 (PO 2026-07-14): 設計レビュー / 実装レビュー / ブラインドレビュー。
 * いずれも frontier 帯 (Sol / Opus 以上) を floor とし、hybrid では非作成側 provider が担う。
 * blind-review は author の主張・意図を遮断した packet で実施 (.claude/agents/blind-reviewer.md /
 * `ut-tdd codex --role blind-reviewer`)。
 */
export const REVIEW_LANES = ["design-review", "implementation-review", "blind-review"] as const;
export type ReviewLane = (typeof REVIEW_LANES)[number];

export const REVIEW_LANE_MODELS: Record<ReviewLane, { claude: string; codex: string }> = {
  "design-review": { claude: MODEL_IDS.claude.opus, codex: MODEL_IDS.codex.frontier },
  "implementation-review": { claude: MODEL_IDS.claude.opus, codex: MODEL_IDS.codex.frontier },
  "blind-review": { claude: MODEL_IDS.claude.opus, codex: MODEL_IDS.codex.frontier },
};

/**
 * プランエージェント (PO 2026-07-14): 一次 = Fable、Fable 不在 (レート制限/エラー) 時は
 * Sol へフォールバック。
 */
export const PLAN_AGENT_MODELS = {
  primary: MODEL_IDS.claude.fable,
  fallback: MODEL_IDS.codex.frontier,
} as const;

/**
 * モデル別 effort 基準ラダー (PO 2026-07-28 改定)。base が既定 effort、shallow は「回答が浅い」
 * と orchestrator が判断した時の引き上げ先。escalate は shallow でもなお浅い時の
 * モデル乗り換え先。上位モデルほど低 effort で足り、下位帯 (spark/mini) は effort で
 * 能力を補う逆傾斜。
 *
 * base: Sol / Fable = low、Opus / Terra / Sonnet = middle、Luna / spark / mini = high。
 * haiku は未指定のため Claude 既定 (high)。
 *
 * **`xhigh` はラダーの基準値・shallow 値として使わない** (PO 2026-07-28:
 * 「xhigh 以上はモデル上げたほうがいい」)。改定前は mini の base と Opus の shallow が
 * `xhigh` で、深さを effort で買おうとしていた。現在は行き止まりを作らず全帯に escalate
 * (モデル上げ) を持たせている。明示 `--effort xhigh` は引き続き有効 (UI/UX 例外、
 * PO 2026-07-08) — 禁止するのは既定としての採用のみ。
 */
export const MODEL_EFFORT_LADDER: Record<
  string,
  {
    base: ReasoningEffort;
    shallow?: ReasoningEffort;
    escalate?: { model: string; effort: ReasoningEffort };
  }
> = {
  [MODEL_IDS.codex.frontier]: { base: "low", shallow: "middle" },
  [MODEL_IDS.codex.worker]: {
    base: "middle",
    shallow: "high",
    escalate: { model: MODEL_IDS.codex.frontier, effort: "low" },
  },
  [MODEL_IDS.codex.luna]: {
    base: "high",
    escalate: { model: MODEL_IDS.codex.frontier, effort: "low" },
  },
  [MODEL_IDS.codex.spark]: {
    base: "high",
    escalate: { model: MODEL_IDS.codex.worker, effort: "middle" },
  },
  [MODEL_IDS.codex.mini]: {
    base: "high",
    escalate: { model: MODEL_IDS.codex.worker, effort: "middle" },
  },
  [MODEL_IDS.claude.fable]: {
    base: "low",
    shallow: "middle",
    escalate: { model: MODEL_IDS.codex.frontier, effort: "low" },
  },
  [MODEL_IDS.claude.opus]: {
    base: "middle",
    shallow: "high",
    escalate: { model: MODEL_IDS.codex.frontier, effort: "low" },
  },
  [MODEL_IDS.claude.sonnet]: {
    base: "middle",
    shallow: "high",
    escalate: { model: MODEL_IDS.claude.opus, effort: "middle" },
  },
};

/**
 * 「回答が浅い」時の次段。まず同モデルで shallow effort へ、それでも浅ければ escalate
 * (モデル乗り換え) へ。次段が無ければ null (それ以上は advisor / 人間判断)。
 *
 * base=high 帯 (luna / spark / mini) は shallow を持たない — そこから深さを買うなら
 * `xhigh` ではなくモデル上げが PO 方針 (2026-07-28) なので、base から直接 escalate する。
 */
export function escalateShallowResponse(input: {
  model: string;
  currentEffort: ReasoningEffort;
}): { model: string; effort: ReasoningEffort } | null {
  const ladder = MODEL_EFFORT_LADDER[input.model];
  if (!ladder) return null;
  if (ladder.shallow && input.currentEffort === ladder.base) {
    return { model: input.model, effort: ladder.shallow };
  }
  const escalateFrom = ladder.shallow ?? ladder.base;
  if (ladder.escalate && input.currentEffort === escalateFrom) {
    return ladder.escalate;
  }
  return null;
}

export const REASONING_EFFORTS = ["low", "medium", "middle", "high", "xhigh"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const TASK_INTENTS = [
  "docs",
  "research",
  "implementation",
  "test",
  "design",
  "lightweight",
  "review",
  "uiux",
  "general",
] as const;
export type TaskIntent = (typeof TASK_INTENTS)[number];

export interface TeamModelSelection {
  provider: TeamProvider;
  difficulty: TaskDifficulty;
  difficulty_source: "explicit" | "inferred";
  model_family: string;
  model: string;
  model_source: "explicit" | "engine" | "policy";
  reasoning_effort: ReasoningEffort;
  effort_source: "explicit" | "policy";
  task_intent: TaskIntent;
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
    // 実装帯の主力は luna (PO 2026-07-14)。terra はテスト実装専門席として roster に残る。
    model: MODEL_IDS.codex.luna,
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
const RESEARCH_TERMS = ["research", "source", "sources", "survey", "market", "web"];
const IMPLEMENTATION_TERMS = [
  "implement",
  "implementation",
  "code",
  "src",
  "fix",
  "build",
  "実装",
  "修正",
  "コード",
];
const TEST_TERMS = [
  "test",
  "tests",
  "testing",
  "vitest",
  "tdd",
  "oracle",
  "fixture",
  "red-green",
  "テスト",
];
const DESIGN_TERMS = ["design", "architecture", "spec", "adr", "contract", "設計"];
const REVIEW_TERMS = [
  "review",
  "verify",
  "audit",
  "judge",
  "acceptance",
  "レビュー",
  "検証",
  "監査",
];
const UIUX_TERMS = ["ui", "ux", "screen", "visual", "wireframe", "mock", "frontend"];
const DOC_TERMS = ["docs", "doc", "readme", "governance", "release notes", "changelog"];
const TEST_ACTION_TERMS = [
  "write",
  "create",
  "add",
  "implement",
  "run",
  "test",
  "testing",
  "書く",
  "作成",
  "追加",
  "実装",
  "実行",
];
const REVIEW_ACTION_TERMS = ["review", "verify", "audit", "judge", "レビュー", "検証", "監査"];
const IMPLEMENTATION_ACTION_TERMS = ["implement", "implementation", "fix", "build", "実装", "修正"];

function hasAny(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => {
    if (containsNonAscii(term)) return text.includes(term);
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "u").test(text);
  });
}

function startsWithAny(text: string, terms: readonly string[]): boolean {
  const normalized = text.trimStart();
  return terms.some((term) =>
    containsNonAscii(term)
      ? normalized.startsWith(term)
      : new RegExp(`^${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^a-z0-9])`, "u").test(
          normalized,
        ),
  );
}

function containsNonAscii(value: string): boolean {
  return [...value].some((character) => (character.codePointAt(0) ?? 0) > 0x7f);
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

function modelForProvider(input: {
  provider: TeamProvider;
  engine: string;
  modelFamily: string;
  intent: TaskIntent;
  difficulty: TaskDifficulty;
}): {
  model: string;
  source: "engine" | "policy";
} {
  const cheap = input.difficulty === "trivial" || input.difficulty === "simple";
  if (input.provider === "local") return { model: "local", source: "policy" };
  if (input.provider === "codex") {
    // task-kind 割当 (PO 2026-07-14): 検証/設計=sol、テスト実装=terra、実装/doc修正=luna、
    // 軽量実装/内部探索/web検索/doc パッチ=spark or mini。
    // intent 割当はdifficulty由来modelFamilyより優先する — task-kind が正本。
    if (input.intent === "review" || input.intent === "design")
      return { model: MODEL_IDS.codex.frontier, source: "policy" };
    if (input.intent === "test") return { model: MODEL_IDS.codex.worker, source: "policy" };
    if (input.intent === "research") return { model: MODEL_IDS.codex.mini, source: "policy" };
    if (input.intent === "docs")
      return { model: cheap ? MODEL_IDS.codex.mini : MODEL_IDS.codex.luna, source: "policy" };
    if (input.intent === "implementation")
      return { model: cheap ? MODEL_IDS.codex.spark : MODEL_IDS.codex.luna, source: "policy" };
    // intent不明のcritical/complexだけをfrontierへ上げる。risk相談はadvisor gateで分離する。
    if (input.modelFamily === "frontier")
      return { model: MODEL_IDS.codex.frontier, source: "policy" };
    if (input.modelFamily === "codex") return { model: MODEL_IDS.codex.codex, source: "policy" };
    return { model: MODEL_IDS.codex.spark, source: "policy" };
  }

  // task-kind 割当 (PO 2026-07-14): フロントデザイン/設計 doc 作成=opus、
  // UI デザイン実装/doc 修正=sonnet、web 検索/doc パッチ=haiku。
  if (input.intent === "design" || input.intent === "review")
    return { model: MODEL_IDS.claude.opus, source: "policy" };
  if (input.intent === "uiux" || input.intent === "implementation" || input.intent === "test")
    return { model: MODEL_IDS.claude.sonnet, source: "policy" };
  if (input.intent === "docs")
    return { model: cheap ? MODEL_IDS.claude.haiku : MODEL_IDS.claude.sonnet, source: "policy" };
  if (input.intent === "research") return { model: MODEL_IDS.claude.haiku, source: "policy" };
  const engine = input.engine.toLowerCase();
  if (engine.includes("opus")) return { model: MODEL_IDS.claude.opus, source: "engine" };
  if (engine.includes("haiku")) return { model: MODEL_IDS.claude.haiku, source: "engine" };
  if (engine.includes("sonnet")) return { model: MODEL_IDS.claude.sonnet, source: "engine" };
  if (input.modelFamily === "frontier") return { model: MODEL_IDS.claude.opus, source: "policy" };
  if (input.modelFamily === "codex") return { model: MODEL_IDS.claude.sonnet, source: "policy" };
  return { model: MODEL_IDS.claude.haiku, source: "policy" };
}

export function inferTaskIntent(input: {
  role?: string;
  engine?: string;
  task: string;
  difficulty?: TaskDifficulty;
}): TaskIntent {
  const text = `${input.role ?? ""} ${input.engine ?? ""} ${input.task}`.toLowerCase();
  const task = input.task.toLowerCase();
  if (hasAny(task, UIUX_TERMS)) return "uiux";
  if (startsWithAny(task, REVIEW_ACTION_TERMS)) return "review";
  if (startsWithAny(task, IMPLEMENTATION_ACTION_TERMS)) return "implementation";
  const testImplementation =
    hasAny(task, TEST_TERMS) &&
    (startsWithAny(task, TEST_ACTION_TERMS) || hasAny(task, TEST_ACTION_TERMS.slice(7)));
  if (testImplementation) return "test";
  if (hasAny(task, DOC_TERMS)) return "docs";
  if (input.role === "uiux") return "uiux";
  if (input.role === "qa") return "review";
  if (input.role === "docs") return "docs";
  if (hasAny(text, REVIEW_TERMS)) return "review";
  if (hasAny(text, TEST_TERMS)) return "test";
  if (hasAny(text, DESIGN_TERMS)) return "design";
  if (hasAny(text, RESEARCH_TERMS)) return "research";
  if (hasAny(text, IMPLEMENTATION_TERMS)) return "implementation";
  if (
    input.difficulty === "trivial" ||
    input.difficulty === "simple" ||
    hasAny(text, SIMPLE_TERMS)
  ) {
    return "lightweight";
  }
  return "general";
}

function policyEffort(input: {
  provider: TeamProvider;
  model: string;
  difficulty: TaskDifficulty;
  intent: TaskIntent;
  fallback: ReasoningEffort;
}): ReasoningEffort {
  // UI/UX は xhigh (PO 指示 2026-07-08、ラダー未改定の task-kind 例外)。
  if (input.intent === "uiux") return "xhigh";
  // モデル別 effort 基準ラダー (PO 指示 2026-07-14) が最優先の既定。
  const ladder = MODEL_EFFORT_LADDER[input.model];
  if (ladder) return ladder.base;
  // ラダー外 (haiku / local / custom) は従来既定。
  if (input.intent === "review") return "high";
  if (input.intent === "design") return "high";
  if (input.difficulty === "critical") return "high";
  if (
    input.intent === "implementation" ||
    input.intent === "test" ||
    input.intent === "lightweight"
  ) {
    return "middle";
  }
  if (input.difficulty === "complex") return input.provider === "codex" ? "high" : "high";
  if (input.provider === "codex") return "middle";
  if (input.provider === "claude") return "high";
  return input.fallback;
}

export function selectTeamModel(input: {
  provider: TeamProvider;
  role: string;
  engine: string;
  task: string;
  difficulty?: TaskDifficulty;
  intent?: TaskIntent;
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
  const taskIntent =
    input.intent ??
    inferTaskIntent({
      role: input.role,
      engine: input.engine,
      task: input.task,
      difficulty: difficulty.difficulty,
    });
  const selectedModel = modelForProvider({
    provider: input.provider,
    engine: input.engine,
    modelFamily: recommendation.model_family,
    intent: taskIntent,
    difficulty: difficulty.difficulty,
  });
  const model = input.model ?? selectedModel.model;

  return {
    provider: input.provider,
    difficulty: difficulty.difficulty,
    difficulty_source: difficulty.source,
    model_family: recommendation.model_family,
    model,
    model_source: input.model ? "explicit" : selectedModel.source,
    reasoning_effort:
      input.effort ??
      policyEffort({
        provider: input.provider,
        model,
        difficulty: difficulty.difficulty,
        intent: taskIntent,
        fallback: recommendation.reasoning_effort,
      }),
    effort_source: input.effort ? "explicit" : "policy",
    task_intent: taskIntent,
    evidence_path: recommendation.evidence_path,
  };
}
