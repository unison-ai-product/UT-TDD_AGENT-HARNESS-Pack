/**
 * 工程表 (gated layer-decomposition roadmap) schema — PLAN-DISCOVERY-05 (poc spike)。
 *
 * 大層 (実 SaaS の L7 は膨大) を「工程表」に分解し、層内ゲート (gates[]) と
 * ゲート間区間 (spans[]、1 span = 1 PLAN) として**機械登録**する第一級エンティティ。
 * 4 段階層 = 工程表 → 層内ゲート → 区間=PLAN → PLAN 内 §工程表 Steps。
 *
 * 本 schema は zod 形状 (intra-record) のみ。span.plan_id の実在 / gate 進捗 (cross-record)
 * は src/roadmap/registry.ts で検証する (frontmatter schema が intra-record に限る方針と整合)。
 *
 * 注: spike (使い捨て可)。S4 confirmed 後に Reverse で FR 起票 + frontmatter.ts 本統合する。
 */
import { z } from "zod";

/** 層内ゲート: 工程表内の中間チェックポイント (層間 G0.5-G7 / band 検証サイクルゲートの層内版)。 */
export const roadmapGateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** doctor が照合する機械検証可能な達成条件 (surface)。 */
  exit_criteria: z.string().min(1),
});

/** 区間: 2 ゲート間の 1 区間 = 1 PLAN。after_gate は "entry" (工程表入口) または gate id。 */
export const roadmapSpanSchema = z.object({
  plan_id: z.string().min(1),
  after_gate: z.string().min(1),
  before_gate: z.string().min(1),
});

/** 工程表: 対象大層 + 層内ゲート列 + 区間 (PLAN) 群。gates は層分解の最小単位なので 1 件以上。 */
export const roadmapSchema = z.object({
  layer: z.string().min(1),
  gates: z.array(roadmapGateSchema).min(1, "gates は 1 件以上 (工程表は層分解の体をなす)"),
  spans: z.array(roadmapSpanSchema).default([]),
});

export type Roadmap = z.infer<typeof roadmapSchema>;
export type RoadmapGate = z.infer<typeof roadmapGateSchema>;
export type RoadmapSpan = z.infer<typeof roadmapSpanSchema>;

/** 入口 sentinel: span.after_gate がここなら工程表入口 (どの gate より前)。 */
export const ROADMAP_ENTRY = "entry";

export interface RoadmapStructureIssue {
  kind: "unknown-gate" | "gate-order" | "duplicate-gate";
  message: string;
}

/**
 * 構造整合 (intra-record、zod 形状の先): gate id 一意 / span の after・before gate 参照実在 /
 * before_gate が after_gate より後ろ (gates[] の順序基準、entry は全 gate より前)。
 */
export function validateRoadmapStructure(roadmap: Roadmap): RoadmapStructureIssue[] {
  const issues: RoadmapStructureIssue[] = [];
  const order = new Map<string, number>();
  // entry は全 gate より前として -1 を割り当てる。これにより after_gate=entry を持つ span の
  // 順序検証 (afterIdx < beforeIdx) が自然に成立する (entry < gate[0]=0)。
  order.set(ROADMAP_ENTRY, -1);
  roadmap.gates.forEach((g, i) => {
    if (order.has(g.id)) {
      issues.push({ kind: "duplicate-gate", message: `gate id 重複: ${g.id}` });
    }
    order.set(g.id, i);
  });

  for (const span of roadmap.spans) {
    const afterIdx = order.get(span.after_gate);
    const beforeIdx = order.get(span.before_gate);
    if (afterIdx === undefined) {
      issues.push({
        kind: "unknown-gate",
        message: `span ${span.plan_id} の after_gate=${span.after_gate} が gates[] に不在`,
      });
    }
    if (beforeIdx === undefined) {
      issues.push({
        kind: "unknown-gate",
        message: `span ${span.plan_id} の before_gate=${span.before_gate} が gates[] に不在`,
      });
    }
    if (afterIdx !== undefined && beforeIdx !== undefined && beforeIdx <= afterIdx) {
      issues.push({
        kind: "gate-order",
        message: `span ${span.plan_id}: before_gate=${span.before_gate} が after_gate=${span.after_gate} より後ろでない`,
      });
    }
  }
  return issues;
}
