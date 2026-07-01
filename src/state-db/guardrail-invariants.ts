import { checkCrossAgentModelPair } from "../schema";
import { isSecretLike } from "./index";

// Pure guardrail-decision invariant logic. Lives in state-db (next to the
// guardrail_decisions table + the isSecretLike/upsert primitives it relies on)
// so BOTH consumers can share one source of truth without a module cycle:
//   - src/guardrail/ledger.ts (write path, fail-close) re-exports these.
//   - src/state-db/projection-writer.ts (projection advisory, warn-first)
//     imports them directly.
// state-db must not import guardrail/ (that would re-introduce the
// guardrail <-> state-db cycle the dependency-drift gate forbids).

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
 * Pure, side-effect-free evaluation of the guardrail invariants. Single source
 * of truth shared by two paths so they cannot diverge:
 *   - recordGuardrailDecision (write path): fail-close — throws on secret,
 *     blocks on self-review / human-required-without-evidence.
 *   - projectGuardrailInvariantAdvisories (projection path): warn-first /
 *     non-blocking — surfaces the same violations as advisory findings without
 *     changing any authz outcome.
 * See PLAN-L7-52 C-1 (option C: projection-based, non-API, Phase 0 advisory).
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
