import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { normalizePath } from "../lint/shared";
import type { HarnessDb } from "./index";

export interface RuntimeSessionLogProjection {
  ts?: string;
  session_id?: string;
  plan_id?: string | null;
  event_type?: string;
  tool?: string;
  target?: string;
  outcome?: string;
}

export interface RuntimeProjectedPlan {
  planId: string;
  kind: string;
  layer: string;
  drive: string;
  status: string;
  updatedAt: string;
}

export interface RuntimeProjectionEvent {
  table: string;
  id: string;
  row: Record<string, unknown>;
}

export interface RuntimeProjectionDeps {
  stableId: (prefix: string, value: string) => string;
  resolvePlanId: (planId: string) => string;
  recordProjectionEvent: (db: HarnessDb, event: RuntimeProjectionEvent) => void;
}

export interface RuntimeTestRunProjectionInput {
  db: HarnessDb;
  plans: Map<string, RuntimeProjectedPlan>;
  event: RuntimeSessionLogProjection;
  evidencePath: string;
  deps: RuntimeProjectionDeps;
}

export interface RuntimeGuardrailDecisionProjectionInput {
  db: HarnessDb;
  plans: Map<string, RuntimeProjectedPlan>;
  event: RuntimeSessionLogProjection;
  evidencePath: string;
  deps: RuntimeProjectionDeps;
}

export interface RuntimeSkillInvocationProjectionInput {
  db: HarnessDb;
  plans: Map<string, RuntimeProjectedPlan>;
  event: RuntimeSessionLogProjection;
  evidencePath: string;
  deps: RuntimeProjectionDeps & {
    skillScore: (plan: RuntimeProjectedPlan, asset: Record<string, unknown>) => number;
  };
}

function verificationVerbFromSessionTarget(event: RuntimeSessionLogProjection): string | null {
  if (event.event_type !== "tool_use" || event.tool !== "Bash") return null;
  const match = String(event.target ?? "").match(/^Bash \(([^)]+)\)$/);
  if (!match) return null;
  const verb = match[1];
  return ["doctor", "eslint", "lint", "test", "tsc", "vitest"].includes(verb) ? verb : null;
}

export function projectRuntimeTestRunFromSessionEvent(input: RuntimeTestRunProjectionInput): void {
  const { db, event, evidencePath, deps } = input;
  if (!event.session_id || !event.plan_id || !event.ts) return;
  const verb = verificationVerbFromSessionTarget(event);
  if (!verb) return;
  const planId = deps.resolvePlanId(event.plan_id);
  const status = event.outcome === "error" ? "failed" : "passed";
  const testRunId = deps.stableId(
    "test-run-runtime",
    `${event.session_id}:${planId}:${event.ts}:${verb}:${event.outcome ?? ""}`,
  );
  deps.recordProjectionEvent(db, {
    table: "test_runs",
    id: testRunId,
    row: {
      test_run_id: testRunId,
      session_id: event.session_id,
      plan_id: planId,
      command: event.target ?? `Bash (${verb})`,
      runner: verb === "doctor" ? "ut-tdd" : "bun",
      runtime: "hook-session-log",
      os: "",
      shell: "bash",
      scope: "runtime-hook",
      started_at: event.ts,
      completed_at: event.ts,
      exit_code: status === "passed" ? 0 : 1,
      evidence_path: evidencePath,
      output_digest: "",
      green_definition_id: "",
      status,
    },
  });
}

export function projectRuntimeGuardrailDecisionFromSessionEvent(
  input: RuntimeGuardrailDecisionProjectionInput,
): void {
  const { db, event, evidencePath, deps } = input;
  if (!event.session_id || !event.plan_id || !event.ts) return;
  if (event.event_type !== "forced_stop") return;
  const planId = deps.resolvePlanId(event.plan_id);
  const guardrailDecisionId = deps.stableId(
    "guardrail-runtime",
    `${event.session_id}:${planId}:${event.ts}:forced-stop:${event.outcome ?? ""}`,
  );
  deps.recordProjectionEvent(db, {
    table: "guardrail_decisions",
    id: guardrailDecisionId,
    row: {
      guardrail_decision_id: guardrailDecisionId,
      plan_id: planId,
      session_id: event.session_id,
      guardrail: "forced-stop",
      decision: "block",
      mode: "runtime-hook",
      human_signoff_required: 0,
      evidence_path: evidencePath,
      decided_at: event.ts,
    },
  });
}

function skillVerbFromSessionTarget(event: RuntimeSessionLogProjection): boolean {
  return (
    event.event_type === "tool_use" && event.tool === "Bash" && event.target === "Bash (skill)"
  );
}

export function projectRuntimeSkillInvocationFromSessionEvent(
  input: RuntimeSkillInvocationProjectionInput,
): void {
  const { db, plans, event, deps } = input;
  if (!event.session_id || !event.plan_id || !event.ts) return;
  if (!skillVerbFromSessionTarget(event)) return;
  const planId = deps.resolvePlanId(event.plan_id);
  const plan = plans.get(planId);
  if (!plan) return;
  const assets = db
    .prepare("SELECT * FROM automation_assets WHERE asset_type = ? ORDER BY asset_id")
    .all("skill")
    .filter((asset) => !String(asset.skill_type ?? "").startsWith("skill-map"));
  const ranked = assets
    .map((asset) => ({ asset, score: deps.skillScore(plan, asset) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        String(a.asset.asset_id ?? "").localeCompare(String(b.asset.asset_id ?? "")),
    )
    .slice(0, 5);
  for (const entry of ranked) {
    const skillId = String(entry.asset.asset_id ?? "");
    const invId = deps.stableId(
      "skill-inv-runtime",
      `${event.session_id}:${planId}:${event.ts}:${skillId}`,
    );
    deps.recordProjectionEvent(db, {
      table: "skill_invocations",
      id: invId,
      row: {
        skill_invocation_id: invId,
        session_id: event.session_id,
        plan_id: planId,
        skill_id: skillId,
        layer: plan.layer,
        drive: plan.drive,
        fired_at: event.ts,
        source: "runtime-hook:skill-suggest",
        accepted: event.outcome === "error" ? 0 : 1,
      },
    });
  }
}

export function projectRuntimeSkillInvocationsFromSessionLogs(input: {
  repoRoot: string;
  db: HarnessDb;
  plans: Map<string, RuntimeProjectedPlan>;
  deps: RuntimeSkillInvocationProjectionInput["deps"];
}): void {
  const { repoRoot, db, plans, deps } = input;
  const sessionDir = join(repoRoot, ".ut-tdd", "logs", "session");
  if (!existsSync(sessionDir)) return;
  for (const file of readdirSync(sessionDir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()) {
    const path = join(sessionDir, file);
    const relPath = normalizePath(relative(repoRoot, path));
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      let event: RuntimeSessionLogProjection;
      try {
        event = JSON.parse(line) as RuntimeSessionLogProjection;
      } catch {
        continue;
      }
      projectRuntimeSkillInvocationFromSessionEvent({
        db,
        plans,
        event,
        evidencePath: relPath,
        deps,
      });
    }
  }
}
