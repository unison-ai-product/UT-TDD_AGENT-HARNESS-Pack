import { checkCrossAgentModelPair } from "../schema/index.ts";
import { isSecretLike } from "./index.ts";

// Keep the pure invariants next to isSecretLike in state-db. The decision
// ledger imports and re-exports them through guardrail/ledger.ts.

export type GuardrailDecisionValue = "allow" | "block" | "human-required";

export interface GuardrailDecisionInput {
  plan_id: string;
  session_id: string;
  guardrail: string;
  decision: GuardrailDecisionValue;
  mode: string;
  human_signoff_required?: boolean;
  evidence_path: string;
  reviewer_model?: string;
  worker_model?: string;
}

export type GuardrailInvariantRule =
  | "secret-evidence"
  | "same-model-self-review"
  | "same-provider-cross-review"
  | "human-required-without-evidence";

export interface GuardrailInvariantViolation {
  rule: GuardrailInvariantRule;
  detail: string;
}

export interface GuardrailInvariantInspection {
  violations: GuardrailInvariantViolation[];
  normalizedDecision: GuardrailDecisionValue;
}

function normalizeDecision(input: GuardrailDecisionInput): GuardrailDecisionValue {
  if (input.reviewer_model !== undefined && input.worker_model !== undefined) {
    const modelCheck = checkCrossAgentModelPair(input.worker_model, input.reviewer_model);
    if (modelCheck.issue === "same_model" || modelCheck.issue === "same_provider") return "block";
  }
  if (input.decision === "human-required" && !input.evidence_path) return "block";
  if (input.human_signoff_required && !input.evidence_path) return "block";
  return input.decision;
}

/**
 * Pure evaluation of guardrail decision invariants. The explicit decision
 * writer rejects secret evidence and applies the normalized decision to block
 * self-review, same-provider review, and required approval without evidence.
 */
export function inspectGuardrailInvariants(
  input: GuardrailDecisionInput,
): GuardrailInvariantInspection {
  const violations: GuardrailInvariantViolation[] = [];
  if (isSecretLike(input.evidence_path)) {
    violations.push({
      rule: "secret-evidence",
      detail: "evidence_path contains a secret-like value",
    });
  }
  if (input.reviewer_model !== undefined && input.worker_model !== undefined) {
    const modelCheck = checkCrossAgentModelPair(input.worker_model, input.reviewer_model);
    if (modelCheck.issue === "same_model") {
      violations.push({
        rule: "same-model-self-review",
        detail: `reviewer_model equals worker_model (${input.reviewer_model})`,
      });
    } else if (modelCheck.issue === "same_provider") {
      violations.push({
        rule: "same-provider-cross-review",
        detail: `reviewer_model and worker_model resolve to the same provider (${modelCheck.reviewerProvider})`,
      });
    }
  }
  if (input.decision === "human-required" && !input.evidence_path) {
    violations.push({
      rule: "human-required-without-evidence",
      detail: "human-required decision lacks evidence_path",
    });
  }
  if (input.human_signoff_required && !input.evidence_path) {
    violations.push({
      rule: "human-required-without-evidence",
      detail: "human_signoff_required set without evidence_path",
    });
  }
  return { violations, normalizedDecision: normalizeDecision(input) };
}
