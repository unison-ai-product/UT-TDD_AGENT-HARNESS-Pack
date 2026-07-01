import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fmValue } from "./shared";

export type BackfillReq = "required" | "conditional" | "none";

export const KIND_BACKFILL: Record<string, BackfillReq> = {
  "add-impl": "required",
  refactor: "conditional",
  retrofit: "conditional",
  troubleshoot: "conditional",
  impl: "none",
  design: "none",
  "add-design": "none",
  charter: "none",
  poc: "none",
  reverse: "none",
  recovery: "none",
};

export const CONDITIONAL_BACKFILL_DECISION_ENFORCEMENT_DATE = "2026-06-22";
export const REQUIRED_BACKFILL_BIDIRECTIONAL_ENFORCEMENT_DATE = "2026-06-23";

export const LEGACY_CONDITIONAL_BACKFILL_DEBT_PLAN_IDS = new Set<string>([
  "PLAN-L7-05-biome-debt",
  "PLAN-L7-68-provider-dispatch-portability",
  "PLAN-L7-69-encoding-corruption-expanded-guard",
  "PLAN-L7-73-claude-native-semver-resolution",
  "PLAN-L7-74-task-risk-whole-word-match",
  "PLAN-L7-76-review-remediation-reliability",
  "PLAN-L7-77-codex-stdin-prompt-dispatch",
  "PLAN-L7-78-claude-stdin-prompt-dispatch",
  "PLAN-L7-79-mcp-launcher-argv-tokenization",
  "PLAN-L7-80-session-digest-event-watermark",
  "PLAN-L7-81-codex-wrapper-parity-gate",
  "PLAN-L7-83-handover-drift-and-accumulation",
  "PLAN-L7-85-review-readonly-guard",
  "PLAN-L7-86-merged-plan-status-deliverable-scope",
  "PLAN-L7-87-merged-plan-status-kind-independent",
  "PLAN-L7-88-handover-summary-injection-cap",
  "PLAN-L7-89-plan-errata-supersession-gate",
  "PLAN-L7-90-ci-readability-gitignored-artifact",
  "PLAN-L7-91-hollow-deliverable-detection",
  "PLAN-L7-92-plan-body-substance-gate",
  "PLAN-L7-93-plan-completion-drift-gate",
  "PLAN-L7-95-lint-wiring-meta-gate",
  "PLAN-L7-96-screen-db-projection",
  "PLAN-L7-98-handover-outstanding-reconciliation",
  "PLAN-L7-99-sub-doc-catalog-drift-gate",
  "PLAN-L7-100-standard-deliverable-section-structure",
]);

export interface ParsedPlan {
  file: string;
  plan_id: string;
  kind: string;
  status: string;
  updated: string;
  backpropDecision: string;
  backpropDecisionReason: string;
  requires: string[];
  glossaryTerms: string[];
}

export interface BackfillResult {
  reverseOrphans: { plan_id: string; kind: string }[];
  reverseLinkMissing: { plan_id: string; reverse_plan_id: string }[];
  legacyAuditGaps: { plan_id: string; location: "allowlist" | "audit" }[];
  conditionalPending: { plan_id: string; kind: string }[];
  conditionalDecisionMissing: { plan_id: string; kind: string }[];
  glossaryGaps: { plan_id: string; term: string }[];
  ok: boolean;
}

export const BACKFILL_RESULT_KEYS = [
  "reverseOrphans",
  "reverseLinkMissing",
  "legacyAuditGaps",
  "conditionalPending",
  "conditionalDecisionMissing",
  "glossaryGaps",
] as const satisfies readonly (keyof Omit<BackfillResult, "ok">)[];

export function normalizeTerm(term: string): string {
  return term.split(/\s*\/\s*|\s*[(（]/u)[0].trim();
}

export function parseRequires(content: string): string[] {
  const m = content.match(/^\s*requires:\s*\n((?:\s+-\s+.+\n?)*)/m);
  if (!m) return [];
  return [...m[1].matchAll(/-\s+(.+?)\s*$/gm)].map((x) => x[1]).filter((s) => s && s !== "[]");
}

export function parseGlossaryTerms(content: string): string[] {
  const sec = content.match(
    /(?:^|\n)#{2,}\s*(?:§|ﾂｧ)?6\b[^\n]*(?:用語更新|逕ｨ隱樊峩譁ｰ)[^\n]*\n([\s\S]*?)(?=\n#{1,6}\s|$)/,
  );
  if (!sec) return [];
  return [...sec[1].matchAll(/^\s*-\s*\*\*(.+?)\*\*/gm)].map((x) => x[1].trim());
}

export function parseConditionalBackfillAuditPlanIds(content: string): Set<string> {
  return new Set(
    [...content.matchAll(/^\|\s*(PLAN-[A-Za-z0-9-]+)\s*\|/gm)].map((match) => match[1]),
  );
}

export function parsePlan(file: string, content: string): ParsedPlan {
  return {
    file,
    plan_id: fmValue(content, "plan_id") ?? file.replace(/\.md$/, ""),
    kind: fmValue(content, "kind") ?? "unknown",
    status: fmValue(content, "status") ?? "unknown",
    updated: fmValue(content, "updated") ?? fmValue(content, "created") ?? "",
    backpropDecision: fmValue(content, "backprop_decision") ?? "",
    backpropDecisionReason: fmValue(content, "backprop_decision_reason") ?? "",
    requires: parseRequires(content),
    glossaryTerms: parseGlossaryTerms(content),
  };
}

export function hasNoBackpropDecision(plan: ParsedPlan): boolean {
  return (
    plan.backpropDecision === "not_required" && plan.backpropDecisionReason.trim().length >= 10
  );
}

export function requiresConditionalBackfillDecision(plan: ParsedPlan): boolean {
  if ((plan.updated || "") < CONDITIONAL_BACKFILL_DECISION_ENFORCEMENT_DATE) return false;
  return !LEGACY_CONDITIONAL_BACKFILL_DEBT_PLAN_IDS.has(plan.plan_id);
}

export function requiresBidirectionalBackfillLink(plan: ParsedPlan): boolean {
  return (plan.updated || "") >= REQUIRED_BACKFILL_BIDIRECTIONAL_ENFORCEMENT_DATE;
}

function normalizedPlanRef(ref: string): string {
  const normalized = ref.replaceAll("\\", "/");
  const basename = normalized.split("/").at(-1) ?? normalized;
  return basename.endsWith(".md") ? basename.slice(0, -3) : basename;
}

function refMatchesPlan(ref: string, plan: ParsedPlan): boolean {
  const normalized = ref.replaceAll("\\", "/");
  return (
    normalized.endsWith(`/${plan.plan_id}.md`) ||
    normalized === `${plan.plan_id}.md` ||
    normalized === plan.plan_id
  );
}

export function analyzeBackfill(
  plans: ParsedPlan[],
  glossaryText: string,
  auditedLegacyIds?: Set<string>,
): BackfillResult {
  const active = plans.filter((p) => p.status !== "archived");
  const reverseRequires = new Set<string>();
  const reverseBackfillers = new Map<string, string[]>();

  for (const p of active) {
    if (p.kind !== "reverse") continue;
    for (const r of p.requires) {
      reverseRequires.add(r);
      const refId = normalizedPlanRef(r);
      reverseBackfillers.set(refId, [...(reverseBackfillers.get(refId) ?? []), p.plan_id]);
    }
  }

  const isBackfilled = (plan: ParsedPlan): boolean =>
    [...reverseRequires].some((r) => refMatchesPlan(r, plan));

  const reverseOrphans: { plan_id: string; kind: string }[] = [];
  const reverseLinkMissing: { plan_id: string; reverse_plan_id: string }[] = [];
  const legacyAuditGaps: { plan_id: string; location: "allowlist" | "audit" }[] = [];
  const conditionalPending: { plan_id: string; kind: string }[] = [];
  const conditionalDecisionMissing: { plan_id: string; kind: string }[] = [];

  for (const p of active) {
    const req = KIND_BACKFILL[p.kind] ?? "none";
    if (req === "none") continue;
    if (isBackfilled(p)) {
      if (req === "required" && requiresBidirectionalBackfillLink(p)) {
        const ownRequires = new Set(p.requires.map(normalizedPlanRef));
        for (const reverseId of reverseBackfillers.get(p.plan_id) ?? []) {
          if (!ownRequires.has(reverseId)) {
            reverseLinkMissing.push({ plan_id: p.plan_id, reverse_plan_id: reverseId });
          }
        }
      }
      continue;
    }
    if (req === "required") reverseOrphans.push({ plan_id: p.plan_id, kind: p.kind });
    else if (hasNoBackpropDecision(p)) continue;
    else if (requiresConditionalBackfillDecision(p)) {
      conditionalDecisionMissing.push({ plan_id: p.plan_id, kind: p.kind });
    } else {
      conditionalPending.push({ plan_id: p.plan_id, kind: p.kind });
    }
  }

  const glossaryGaps: { plan_id: string; term: string }[] = [];
  for (const p of active) {
    for (const term of p.glossaryTerms) {
      const core = normalizeTerm(term);
      if (!glossaryText.includes(core)) glossaryGaps.push({ plan_id: p.plan_id, term });
    }
  }

  if (auditedLegacyIds) {
    for (const planId of LEGACY_CONDITIONAL_BACKFILL_DEBT_PLAN_IDS) {
      if (!auditedLegacyIds.has(planId))
        legacyAuditGaps.push({ plan_id: planId, location: "audit" });
    }
    for (const planId of auditedLegacyIds) {
      if (!LEGACY_CONDITIONAL_BACKFILL_DEBT_PLAN_IDS.has(planId)) {
        legacyAuditGaps.push({ plan_id: planId, location: "allowlist" });
      }
    }
  }

  return {
    reverseOrphans,
    reverseLinkMissing,
    legacyAuditGaps,
    conditionalPending,
    conditionalDecisionMissing,
    glossaryGaps,
    ok:
      reverseOrphans.length === 0 &&
      reverseLinkMissing.length === 0 &&
      legacyAuditGaps.length === 0 &&
      conditionalDecisionMissing.length === 0 &&
      glossaryGaps.length === 0,
  };
}

export interface BackfillDocs {
  plans: ParsedPlan[];
  glossaryText: string;
  auditedLegacyIds: Set<string>;
}

export function loadBackfillDocs(repoRoot: string = process.cwd()): BackfillDocs {
  const plansDir = join(repoRoot, "docs", "plans");
  const plans: ParsedPlan[] = [];
  for (const f of readdirSync(plansDir)) {
    if (!f.endsWith(".md")) continue;
    plans.push(parsePlan(f, readFileSync(join(plansDir, f), "utf8")));
  }
  const concept = readFileSync(
    join(repoRoot, "docs", "governance", "ut-tdd-agent-harness-concept_v3.1.md"),
    "utf8",
  );
  const glossaryText =
    concept.match(/#\s*(?:§|ﾂｧ)10[\s\S]*?(?=\n#\s*(?:§|ﾂｧ)11|$)/)?.[0] ?? concept;
  const audit = readFileSync(
    join(repoRoot, "docs", "governance", "conditional-backfill-decision-audit-2026-06-22.md"),
    "utf8",
  );
  return { plans, glossaryText, auditedLegacyIds: parseConditionalBackfillAuditPlanIds(audit) };
}

export function backfillMessages(result: BackfillResult): string[] {
  const msgs: string[] = [];
  if (result.reverseOrphans.length > 0) {
    const ids = result.reverseOrphans.map((o) => o.plan_id).join(", ");
    msgs.push(
      `backfill - violation: add-impl without Reverse backfill ${result.reverseOrphans.length}件 (${ids})`,
    );
  }
  if (result.reverseLinkMissing.length > 0) {
    const ids = result.reverseLinkMissing
      .map((o) => `${o.plan_id}->${o.reverse_plan_id}`)
      .join(", ");
    msgs.push(
      `backfill - violation: required add-impl missing bidirectional Reverse requires ${result.reverseLinkMissing.length}件 (${ids})`,
    );
  }
  if (result.legacyAuditGaps.length > 0) {
    const ids = result.legacyAuditGaps.map((o) => `${o.plan_id}:${o.location}`).join(", ");
    msgs.push(
      `backfill - violation: legacy conditional backfill audit drift ${result.legacyAuditGaps.length}件 (${ids})`,
    );
  }
  if (result.glossaryGaps.length > 0) {
    const gaps = result.glossaryGaps.map((g) => `${g.term}(${g.plan_id})`).join(", ");
    msgs.push(
      `backfill - violation: glossary terms not merged ${result.glossaryGaps.length}件 (${gaps})`,
    );
  }
  if (result.conditionalDecisionMissing.length > 0) {
    const ids = result.conditionalDecisionMissing.map((o) => o.plan_id).join(", ");
    msgs.push(
      `backfill - violation: conditional kind without Reverse/no-backprop decision ${result.conditionalDecisionMissing.length}件 (${ids})`,
    );
  }
  if (result.conditionalPending.length > 0) {
    const ids = result.conditionalPending.map((o) => o.plan_id).join(", ");
    msgs.push(
      `backfill - note: conditional kind may require Reverse ${result.conditionalPending.length}件 (${ids})`,
    );
  }
  if (msgs.length === 0) msgs.push("backfill - OK (Reverse orphans 0 / glossary gaps 0)");
  return msgs;
}
