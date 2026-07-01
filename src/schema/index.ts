/**
 * UT-TDD schema 単一正本 (ADR-001 / requirements_v1.2 §1, §7.8).
 * zod を single source とし、実行時検証 + 型推論を 1 本化する (enum drift を型で抑止)。
 * 最終同期: requirements v1.2 §1.2-§1.8 / §7.8.4
 */
import { z } from "zod";

/** §1.3 VALID_KINDS (12 種) */
export const VALID_KINDS = [
  "charter",
  "impl",
  "design",
  "poc",
  "reverse",
  "add-design",
  "add-impl",
  "refactor",
  "retrofit",
  "recovery",
  "troubleshoot",
  "research",
] as const;
export const kindSchema = z.enum(VALID_KINDS);
export type Kind = z.infer<typeof kindSchema>;

/** §1.4 VALID_LAYERS (16 種 = V2 L0-L14 + cross、V-model) */
export const VALID_LAYERS = [
  "L0", // 企画
  "L1", // 要求定義 (業務要求) ↔ L14
  "L2", // 画面設計 ↔ L10
  "L3", // 要件定義 (FR+AC) ↔ L12
  "L4", // 基本設計 ↔ L9
  "L5", // 詳細設計 ↔ L8
  "L6", // 機能設計 ↔ L7
  "L7", // 実装スプリント
  "L8", // 結合テスト
  "L9", // 総合テスト
  "L10", // UX 磨き
  "L11", // 総合レビュー + UAT
  "L12", // デプロイ + 受入
  "L13", // デプロイ後検証
  "L14", // 運用検証 + 改善
  "cross", // 横断 PLAN
] as const;
export const layerSchema = z.enum(VALID_LAYERS);
export type Layer = z.infer<typeof layerSchema>;

// L4 標準成果物カタログ = 外部設計成果物。report/batch/notification/code-value の grounding と
// 区分 (② プロダクト選択) は docs/governance/document-system-map.md §1b を正本とする。
// FE/UI 設計 doc カタログ (左腕、各 L の per-layer フロント設計 doc) の grounding は §1c を正本とする:
//   L1 screen / L2 screen-*+ui-element / L3 screen-functional / L4 ui-standard / L5 ui-detail / L6 screen-spec。
//   screen-functional/ui-detail/screen-spec は ② プロダクト選択 (UI 有時)。
//   Harness central UI body docs were populated by PLAN-L3-06 / PLAN-L5-09 / PLAN-L6-36
//   after PLAN-L4-14 registered the vocabulary first.
export const VALID_SUB_DOCS = {
  L1: ["business", "functional", "nfr", "technical", "screen"],
  L2: ["screen-list", "screen-flow", "ui-element", "wireframe"],
  L3: ["business", "functional", "nfr", "screen-functional"],
  L4: [
    "data",
    "architecture",
    "function",
    "external-if",
    "ui-standard",
    "report",
    "batch",
    "notification",
    "code-value",
  ],
  L5: ["physical-data", "module-decomposition", "internal-processing", "if-detail", "ui-detail"],
  L6: ["function-spec", "class-design", "edge-case", "screen-spec"],
} as const;
export const VALID_SUB_DOC_VALUES = [
  "business",
  "functional",
  "nfr",
  "technical",
  "screen",
  "screen-list",
  "screen-flow",
  "ui-element",
  "wireframe",
  "data",
  "architecture",
  "function",
  "external-if",
  "ui-standard",
  "report",
  "batch",
  "notification",
  "code-value",
  "physical-data",
  "module-decomposition",
  "internal-processing",
  "if-detail",
  "ui-detail",
  "function-spec",
  "class-design",
  "edge-case",
  "screen-functional",
  "screen-spec",
] as const;
export const subDocSchema = z.enum(VALID_SUB_DOC_VALUES);
export type SubDoc = z.infer<typeof subDocSchema>;

export function isValidSubDocForLayer(
  layer: string | undefined,
  subDoc: string | undefined,
): boolean {
  if (!layer || !subDoc) return false;
  return ((VALID_SUB_DOCS as Record<string, readonly string[]>)[layer] ?? []).includes(subDoc);
}

/** V-model 左右ペア (左=設計, 右=検証)。L0-L14 の設計層↔検証層の対。 */
export const V_MODEL_PAIRS: Record<string, string> = {
  L1: "L14",
  L2: "L10",
  L3: "L12",
  L4: "L9",
  L5: "L8",
  L6: "L7",
};

/**
 * §1.6 VALID_DRIVES (5 種 = 専門職のみ。PLAN-DISCOVERY-04 V7 / PLAN-REVERSE-01 R3)。
 * drive = 「その PLAN にどの専門職/専門エージェントを招集するか」(owner_role / mandatory_agents /
 * orchestration_mode を決める)。旧 9 種は mode/状況値 (scrum/reverse/poc/troubleshoot) を混在させ
 * 駆動モデル (mode、§2.5) と命名衝突していたため除去。横断駆動 kind (poc/reverse/recovery) の drive は
 * 対象 work の専門職を継承する (例: PLAN-RECOVERY-01 = fullstack)。
 */
export const VALID_DRIVES = ["be", "fe", "fullstack", "db", "agent"] as const;
export const driveSchema = z.enum(VALID_DRIVES);
export type Drive = z.infer<typeof driveSchema>;

/** §1.2 VALID_STATUSES (4 種) */
export const VALID_STATUSES = ["draft", "confirmed", "completed", "archived"] as const;
export const statusSchema = z.enum(VALID_STATUSES);
export type Status = z.infer<typeof statusSchema>;

/** §1.8 VALID_ROLES (7 種) */
export const VALID_ROLES = ["po", "tl", "qa", "aim", "uiux", "se", "docs"] as const;
export const roleSchema = z.enum(VALID_ROLES);
export type Role = z.infer<typeof roleSchema>;

/** §1.5 VALID_WORKFLOW_PHASES (10 種、Scrum / Reverse) */
export const VALID_WORKFLOW_PHASES = [
  "S0",
  "S1",
  "S2",
  "S3",
  "S4",
  "R0",
  "R1",
  "R2",
  "R3",
  "R4",
] as const;
export const workflowPhaseSchema = z.enum(VALID_WORKFLOW_PHASES);
export type WorkflowPhase = z.infer<typeof workflowPhaseSchema>;

/** §1.2.2 VALID_DECISION_OUTCOMES (kind=poc + workflow_phase=S4 専用、3 種) */
export const VALID_DECISION_OUTCOMES = ["confirmed", "rejected", "pivot"] as const;
export const decisionOutcomeSchema = z.enum(VALID_DECISION_OUTCOMES);
export type DecisionOutcome = z.infer<typeof decisionOutcomeSchema>;

/** §3.3 VALID_REVERSE_TYPES (kind=reverse の confirmed_reverse_type、5 種) */
export const VALID_REVERSE_TYPES = [
  "code",
  "design",
  "upgrade",
  "normalization",
  "fullback",
] as const;
export const reverseTypeSchema = z.enum(VALID_REVERSE_TYPES);
export type ReverseType = z.infer<typeof reverseTypeSchema>;

/** §3.1/§3.2 VALID_SCRUM_TYPES (kind=poc の scrum_type、6 種 = 仮説タイプ。S3 以降必須、§3.5) */
export const VALID_SCRUM_TYPES = [
  "hypothesis-test",
  "tech-spike",
  "design-spike",
  "perf-spike",
  "security-spike",
  "ux-spike",
] as const;
export const scrumTypeSchema = z.enum(VALID_SCRUM_TYPES);
export type ScrumType = z.infer<typeof scrumTypeSchema>;

/** §3.4 VALID_FORWARD_ROUTING (kind=reverse + R4 の forward_routing、5 種) */
export const VALID_FORWARD_ROUTING = ["L1", "L3", "L4", "L5", "gap-only"] as const;
export const forwardRoutingSchema = z.enum(VALID_FORWARD_ROUTING);
export type ForwardRouting = z.infer<typeof forwardRoutingSchema>;

/** §3.4 VALID_PROMOTION_STRATEGIES (kind=reverse + R4 の promotion_strategy、4 種) */
export const VALID_PROMOTION_STRATEGIES = [
  "reuse-as-is",
  "reuse-with-hardening",
  "redesign",
  "discard",
] as const;
export const promotionStrategySchema = z.enum(VALID_PROMOTION_STRATEGIES);
export type PromotionStrategy = z.infer<typeof promotionStrategySchema>;

/**
 * §1.7 VALID_ARTIFACT_TYPES (19 種、test_design / test_code 分離済)。
 * requirements_v1.2 §1.7 全 19 種と突合済 (python_module → source_module 改名、ADR-001)。
 */
export const VALID_ARTIFACT_TYPES = [
  "design_doc",
  "adr_snapshot",
  "skill_doc",
  "markdown_doc",
  "doc_update",
  "source_module",
  "script",
  "cli_extension",
  "template",
  "test_design",
  "test_code",
  "hook",
  "schema_migration",
  "config",
  "yaml_config",
  "json_config",
  "workflow_config",
  "github_config",
  "other",
] as const;
export const artifactTypeSchema = z.enum(VALID_ARTIFACT_TYPES);
export type ArtifactType = z.infer<typeof artifactTypeSchema>;

/** §7.8.4 VALID_ORCHESTRATION_MODES (5 種、drive×layer 注入) */
export const VALID_ORCHESTRATION_MODES = [
  "pm_lead",
  "claude_judge",
  "claude_judge_codex_impl",
  "codex_impl_qa_verify",
  "claude_design_impl",
] as const;
export const orchestrationModeSchema = z.enum(VALID_ORCHESTRATION_MODES);
export type OrchestrationMode = z.infer<typeof orchestrationModeSchema>;

/** §7.8.3 mode→command 機械契約 RecommendedCommandV1 */
export const recommendedCommandV1Schema = z.object({
  schema_version: z.literal("v1"),
  command: z.string().refine((c) => c.startsWith("ut-tdd"), {
    message: "command must start with ut-tdd; legacy runtime commands are not allowed",
  }),
  args: z.record(z.string(), z.unknown()).default({}),
  safety: z.object({
    auto_apply: z.boolean().default(false),
    requires_human_approval: z.boolean().default(false),
    requires_preflight: z.boolean().default(false),
  }),
});
export type RecommendedCommandV1 = z.infer<typeof recommendedCommandV1Schema>;

export type ModelProvider = "claude" | "codex" | "unknown";

export type CrossAgentModelIssue =
  | "missing_model"
  | "same_model"
  | "same_provider"
  | "unknown_provider";

export interface CrossAgentModelCheck {
  ok: boolean;
  issue?: CrossAgentModelIssue;
  workerProvider: ModelProvider;
  reviewerProvider: ModelProvider;
}

export function modelProviderFromId(modelId: string | undefined): ModelProvider {
  const normalized = modelId?.trim().toLowerCase() ?? "";
  if (!normalized) return "unknown";
  if (
    normalized.startsWith("claude") ||
    normalized.startsWith("anthropic") ||
    normalized.includes("sonnet") ||
    normalized.includes("opus") ||
    normalized.includes("haiku")
  ) {
    return "claude";
  }
  if (normalized.startsWith("codex") || normalized.startsWith("gpt-")) {
    return "codex";
  }
  return "unknown";
}

export function checkCrossAgentModelPair(
  workerModel: string | undefined,
  reviewerModel: string | undefined,
): CrossAgentModelCheck {
  const worker = workerModel?.trim();
  const reviewer = reviewerModel?.trim();
  const workerProvider = modelProviderFromId(worker);
  const reviewerProvider = modelProviderFromId(reviewer);

  if (!worker || !reviewer) {
    return { ok: false, issue: "missing_model", workerProvider, reviewerProvider };
  }
  if (worker === reviewer) {
    return { ok: false, issue: "same_model", workerProvider, reviewerProvider };
  }
  if (workerProvider === "unknown" || reviewerProvider === "unknown") {
    return { ok: false, issue: "unknown_provider", workerProvider, reviewerProvider };
  }
  if (workerProvider === reviewerProvider) {
    return { ok: false, issue: "same_provider", workerProvider, reviewerProvider };
  }
  return { ok: true, workerProvider, reviewerProvider };
}

export function crossAgentModelIssueMessage(check: CrossAgentModelCheck): string {
  switch (check.issue) {
    case "missing_model":
      return "cross_agent review requires workerModel and reviewerModel";
    case "same_model":
      return "same_model_approval forbidden: workerModel equals reviewerModel";
    case "same_provider":
      return "cross_agent review requires different providers (claude vs codex)";
    case "unknown_provider":
      return "cross_agent review requires recognizable claude/codex provider model ids";
    default:
      return "cross_agent review model pair is invalid";
  }
}
