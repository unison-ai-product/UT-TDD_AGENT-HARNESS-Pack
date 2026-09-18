/**
 * 設計判断の採択記録 (append-only JSONL、PLAN-L7-428)。
 *
 * 正本は PLAN 設計判断節 / ADR (governance 正本 =
 * docs/governance/design-decision-elicitation.md §共通ルール 7)。この log は
 * feedback lifecycle と同じ「append-only log を episodic 正本、DB は projection」
 * 方針の記録面で、聞いた/採択した事実をステージ (plan_id + current_location)
 * 付きで残す。
 */

import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureDir } from "../shared/fs.ts";

export const DESIGN_DECISION_LOG_PATH = ".ut-tdd/logs/design-decisions.jsonl";

export interface DesignDecisionRecord {
  recorded_at: string;
  plan_id: string;
  current_location: string;
  topic: string;
  options: string[];
  chosen: string;
  reason: string;
  session_id: string;
}

export interface DesignDecisionInput {
  planId: string;
  currentLocation?: string;
  topic: string;
  options?: string[];
  chosen: string;
  reason: string;
  sessionId?: string;
  recordedAt?: string;
}

export function appendDesignDecision(
  repoRoot: string,
  input: DesignDecisionInput,
): DesignDecisionRecord {
  const record: DesignDecisionRecord = {
    recorded_at: input.recordedAt ?? new Date().toISOString(),
    plan_id: input.planId.trim(),
    current_location: (input.currentLocation ?? "").trim(),
    topic: input.topic.trim(),
    options: (input.options ?? []).map((option) => option.trim()).filter(Boolean),
    chosen: input.chosen.trim(),
    reason: input.reason.trim(),
    session_id: (input.sessionId ?? "").trim(),
  };
  if (!record.plan_id) throw new Error("plan_id is required");
  if (!record.topic) throw new Error("topic is required");
  if (!record.chosen) throw new Error("chosen is required");
  if (!record.reason) throw new Error("reason is required");
  const logPath = join(repoRoot, DESIGN_DECISION_LOG_PATH);
  ensureDir(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}
