export const JUDGMENT_GATES = ["G0.5", "G2", "G4", "G5", "G6", "G7", "R4"] as const;

export const REQUIRED_CHECKLIST_IDS = ["DOC", "TST", "COD", "XR", "DEP", "DUP", "MOD"] as const;

export function isNaiveSelfReviewKind(kind: string | undefined): boolean {
  return kind === "self_review" || kind === "self-review" || kind === "naive_self_review";
}
