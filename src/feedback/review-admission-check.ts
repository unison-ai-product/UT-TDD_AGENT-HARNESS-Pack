import { isReviewFloorModel } from "../team/model-policy.ts";

// 入口の検査 (族分離・model の下限) の共有述語 (#1600)。request を書く前の受理検査と
// beginReviewAttempt が同じ判定を使い、判定を分岐させない。
export function reviewerAdmissionDenial(input: {
  authorFamily: "codex" | "claude";
  provider: "codex" | "claude";
  model: string;
}): string | undefined {
  const expectedProvider = input.authorFamily === "codex" ? "claude" : "codex";
  if (input.provider !== expectedProvider) return "same_family_reviewer_denied";
  if (typeof input.model !== "string" || !input.model.trim()) return "invalid_attempt_outcome";
  if (!isReviewFloorModel(input.provider, input.model)) return "reviewer_model_below_floor";
  return undefined;
}
