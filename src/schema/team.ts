/**
 * team 定義 schema (`.ut-tdd/teams/*.yaml`) — Layer-2 オーケストレーション設定 (IMP-050/049)。
 * ADR-001 準拠で TS-native に実装し、zod を single source として
 * 実行時検証 + 型推論を 1 本化する (frontmatter schema と同方針)。
 *
 * 直列化 3 条件 (IMP-049): タスクを直列実行すべきか並列でよいかの機械判定キー。
 *   - file_conflict: 同一ファイルを書く (編集衝突)
 *   - downstream_dependency: 後段タスクが前段の成果物に依存
 *   - shared_state: 共有 state (DB / current-plan 等) を変更
 * いずれか true → 直列化必須。すべて false → 並列投入可 (.claude/CLAUDE.md 上限 8)。
 */
import { z } from "zod";
import { roleSchema } from "./index";

/** 実行戦略。default=sequential (安全側)。 */
export const VALID_TEAM_STRATEGIES = ["sequential", "parallel"] as const;
export const teamStrategySchema = z.enum(VALID_TEAM_STRATEGIES);
export type TeamStrategy = z.infer<typeof teamStrategySchema>;

export const MAX_TEAM_PARALLEL = 8;

export const taskDifficultySchema = z.enum([
  "trivial",
  "simple",
  "standard",
  "complex",
  "critical",
]);
export type TaskDifficulty = z.infer<typeof taskDifficultySchema>;

export const reasoningEffortSchema = z.enum(["low", "medium", "middle", "high", "xhigh"]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

export const modelOverrideSchema = z
  .string()
  .min(1)
  .refine(
    (model) =>
      /^(?:gpt|claude|codex)-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model) ||
      ["haiku", "sonnet", "opus", "local"].includes(model),
    {
      message:
        "model must be a known provider model id or family alias: gpt-*, claude-*, codex-*, haiku, sonnet, opus, or local",
    },
  );
export type ModelOverride = z.infer<typeof modelOverrideSchema>;

/** 直列化 3 条件 (IMP-049)。1 つでも true なら直列化必須。 */
export const serializationReasonSchema = z.object({
  file_conflict: z.boolean().default(false),
  downstream_dependency: z.boolean().default(false),
  shared_state: z.boolean().default(false),
});
export type SerializationReason = z.infer<typeof serializationReasonSchema>;

export const teamMemberSchema = z.object({
  role: roleSchema,
  /** 委譲先エンジン (codex-tl / codex-se / pmo-sonnet 等)。agent_kind として slot に記録。 */
  engine: z.string().min(1),
  task: z.string().min(1),
  difficulty: taskDifficultySchema.optional(),
  model: modelOverrideSchema.optional(),
  effort: reasoningEffortSchema.optional(),
  ownership: z.string().optional(),
  /** この member を前段に直列化する理由 (parallel 戦略でも個別に直列化指定可)。 */
  serialize_after: z.string().optional(),
});
export type TeamMember = z.infer<typeof teamMemberSchema>;

export const teamDefinitionSchema = z.object({
  name: z.string().min(1),
  strategy: teamStrategySchema.default("sequential"),
  /** 並列上限 (strategy=parallel 時)。既定は .claude/CLAUDE.md と整合の 8。 */
  max_parallel: z.number().int().positive().max(MAX_TEAM_PARALLEL).default(MAX_TEAM_PARALLEL),
  /** チーム全体の直列化判定根拠 (3 条件)。 */
  serialization: serializationReasonSchema.optional(),
  members: z.array(teamMemberSchema).min(1),
});
export type TeamDefinition = z.infer<typeof teamDefinitionSchema>;

/**
 * 直列化必須かを判定 (IMP-049 の機械支援)。3 条件のいずれか true → true。
 * undefined (条件未記録) → false (並列可、ただし PLAN §工程表 で根拠明記が規約)。
 */
export function mustSerialize(reason: SerializationReason | undefined): boolean {
  if (!reason) return false;
  return reason.file_conflict || reason.downstream_dependency || reason.shared_state;
}
