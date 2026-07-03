import { existsSync } from "node:fs";
import { analyzeBackfill, backfillMessages, loadBackfillDocs } from "../lint/backfill-pairing";
import {
  analyzePlanBodySubstance,
  loadPlanBodySubstanceInput,
  planBodySubstanceMessages,
} from "../lint/plan-body-substance";
import {
  analyzePlanCompletionDrift,
  loadPlanCompletionDriftInput,
  planCompletionDriftMessages,
} from "../lint/plan-completion-drift";
import {
  analyzeForwardConvergence,
  forwardConvergenceMessages,
  legacyAuditDriftMessages,
  loadConvergenceDocs,
  loadLegacyAuditDrift,
} from "../lint/forward-convergence";
import {
  analyzePlanSupersession,
  loadSupersedePlans,
  planSupersessionMessages,
} from "../lint/plan-supersession";
import { analyzePropagation, loadPropagationDocs, propagationMessages } from "../lint/propagation";
import {
  analyzeReviewEvidence,
  loadReviewPlans,
  reviewEvidenceMessages,
} from "../lint/review-evidence";
import { analyzeScrumReverse, loadSrPlans, scrumReverseMessages } from "../lint/scrum-reverse";
import {
  analyzePlanReferenceFreshness,
  lintPlan,
  lintPlanWithGate,
  loadPlanGovernanceDocs,
  planReferenceFreshnessMessages,
} from "../plan/lint";
import type { GuardrailDecisionInput } from "../state-db/guardrail-invariants";
import { inspectGuardrailInvariants } from "../state-db/guardrail-invariants";
import { analyzePairFreeze, loadPairDocs, pairFreezeMessages } from "../vmodel/lint";

export function checkBackfillResult(repoRoot: string): { messages: string[]; ok: boolean } {
  try {
    const docs = loadBackfillDocs(repoRoot);
    const r = analyzeBackfill(docs.plans, docs.glossaryText, docs.auditedLegacyIds);
    return { messages: backfillMessages(r), ok: r.ok };
  } catch {
    return { messages: ["backfill - violation: PLAN/glossary could not be read"], ok: false };
  }
}

export function checkBackfill(repoRoot: string): string[] {
  return checkBackfillResult(repoRoot).messages;
}

export function checkScrumReverse(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["scrum-reverse - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeScrumReverse(loadSrPlans(repoRoot));
    return { messages: scrumReverseMessages(r), ok: r.ok };
  } catch {
    return { messages: ["scrum-reverse - violation: PLAN could not be read"], ok: false };
  }
}

export function checkPlanSupersession(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["plan-supersession - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzePlanSupersession(loadSupersedePlans(repoRoot));
    return { messages: planSupersessionMessages(r), ok: r.ok };
  } catch {
    return { messages: ["plan-supersession - violation: PLAN could not be read"], ok: false };
  }
}

export function checkPlanBodySubstance(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["plan-body-substance - violation: repo root could not be read"],
      ok: false,
    };
  }
  try {
    const r = analyzePlanBodySubstance(loadPlanBodySubstanceInput(repoRoot));
    return { messages: planBodySubstanceMessages(r), ok: r.ok };
  } catch {
    return { messages: ["plan-body-substance - violation: PLAN could not be read"], ok: false };
  }
}

export function checkPlanCompletionDrift(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["plan-completion-drift - violation: repo root could not be read"],
      ok: false,
    };
  }
  try {
    const r = analyzePlanCompletionDrift(loadPlanCompletionDriftInput(repoRoot));
    return { messages: planCompletionDriftMessages(r), ok: r.ok };
  } catch {
    return { messages: ["plan-completion-drift - violation: PLAN could not be read"], ok: false };
  }
}

export function checkPlanSchedule(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["plan-schedule - violation: repo root could not be read"], ok: false };
  }
  try {
    return lintPlan(undefined, repoRoot);
  } catch {
    return { messages: ["plan-schedule - violation: PLAN schedule lint could not run"], ok: false };
  }
}

export function checkPlanGovernance(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["plan-governance - violation: repo root could not be read"], ok: false };
  }
  try {
    return lintPlanWithGate(undefined, repoRoot, "governance");
  } catch {
    return {
      messages: ["plan-governance - violation: PLAN governance lint could not run"],
      ok: false,
    };
  }
}

export function checkPlanReferenceFreshnessAdvisory(repoRoot: string): string[] {
  if (!existsSync(repoRoot)) return [];
  try {
    const freshness = analyzePlanReferenceFreshness(loadPlanGovernanceDocs(repoRoot), repoRoot);
    return planReferenceFreshnessMessages(freshness).map((message) => `doctor: ${message}`);
  } catch {
    return ["doctor: plan-reference-freshness - advisory: skipped (PLAN refs could not be read)"];
  }
}

export function checkForwardConvergence(repoRoot: string): { messages: string[]; ok: boolean } {
  try {
    const docs = loadConvergenceDocs(repoRoot);
    const r = analyzeForwardConvergence(docs.plans, docs.roadmapSpanIds, docs.reverseReferencedIds);
    return { messages: forwardConvergenceMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["forward-convergence — violation: PLAN を読めず spine-外集約を検査できない"],
      ok: false,
    };
  }
}

export function checkForwardConvergenceAudit(repoRoot: string): {
  messages: string[];
  ok: boolean;
} {
  try {
    const r = loadLegacyAuditDrift(repoRoot);
    return { messages: legacyAuditDriftMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["forward-convergence-audit — violation: legacy debt audit を検査できない"],
      ok: false,
    };
  }
}

export function checkPropagation(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["propagation - violation: repo root could not be read"], ok: false };
  }
  try {
    const d = loadPropagationDocs(repoRoot);
    const r = analyzePropagation(d.conceptText, d.requirementsText);
    return { messages: propagationMessages(r), ok: r.ok };
  } catch {
    return { messages: ["propagation - violation: governance docs could not be read"], ok: false };
  }
}

export function checkPairFreeze(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["pair-freeze - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzePairFreeze(loadPairDocs(repoRoot));
    return { messages: pairFreezeMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["pair-freeze - violation: design/test-design docs could not be read"],
      ok: false,
    };
  }
}

export function checkReviewEvidence(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["review-evidence - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeReviewEvidence(loadReviewPlans(repoRoot));
    return { messages: reviewEvidenceMessages(r), ok: r.ok };
  } catch {
    return { messages: ["review-evidence - violation: PLAN could not be read"], ok: false };
  }
}

export function checkGuardrailInvariants(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["guardrail-invariants - violation: repo root could not be read"],
      ok: false,
    };
  }
  try {
    const plans = loadReviewPlans(repoRoot);
    const violations: {
      rule: string;
      planId: string;
      reviewerModel?: string;
      workerModel?: string;
    }[] = [];
    for (const plan of plans) {
      if (plan.status === "archived") continue;
      for (const entry of plan.crossEntries) {
        const reviewerModel = entry.reviewer_model?.trim() || undefined;
        const workerModel = entry.worker_model?.trim() || undefined;
        const input: GuardrailDecisionInput = {
          plan_id: plan.plan_id,
          session_id: "",
          guardrail: "review-evidence",
          decision: "allow",
          mode: "review",
          evidence_path: plan.file,
          reviewer_model: reviewerModel,
          worker_model: workerModel,
        };
        const inspection = inspectGuardrailInvariants(input);
        for (const v of inspection.violations) {
          if (
            (v.rule === "same-model-self-review" || v.rule === "same-provider-cross-review") &&
            entry.review_kind !== "cross_agent"
          ) {
            continue;
          }
          violations.push({
            rule: v.rule,
            planId: plan.plan_id,
            reviewerModel,
            workerModel,
          });
        }
      }
    }
    if (violations.length === 0) {
      return {
        messages: ["guardrail-invariants — OK (review_evidence 全 entry でインバリアント違反なし)"],
        ok: true,
      };
    }
    return {
      messages: violations.map(
        (v) =>
          `guardrail-invariants - violation: rule=${v.rule} plan_id=${v.planId} reviewer=${v.reviewerModel ?? "(none)"} worker=${v.workerModel ?? "(none)"}`,
      ),
      ok: false,
    };
  } catch {
    return {
      messages: ["guardrail-invariants - violation: PLAN review_evidence could not be read"],
      ok: false,
    };
  }
}
