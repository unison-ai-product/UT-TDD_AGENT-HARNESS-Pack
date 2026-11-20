import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { normalizePath } from "../shared/source-text.ts";
import type { HarnessDb } from "./index.ts";

export interface RuntimeSessionLogProjection {
  ts?: string;
  session_id?: string;
  plan_id?: string | null;
  event_type?: string;
  tool?: string;
  target?: string;
  outcome?: string;
}

export interface RuntimeProjectionEvent {
  table: string;
  id: string;
  row: Record<string, unknown>;
}

export interface RuntimeProjectionDeps {
  stableId: (prefix: string, value: string) => string;
  recordProjectionEvent: (db: HarnessDb, event: RuntimeProjectionEvent) => void;
}

export interface RuntimeTestRunProjectionInput {
  db: HarnessDb;
  event: RuntimeSessionLogProjection;
  evidencePath: string;
  lineNumber: number;
  deps: RuntimeProjectionDeps;
}

export interface RuntimeGuardrailDecisionProjectionInput {
  db: HarnessDb;
  event: RuntimeSessionLogProjection;
  evidencePath: string;
  lineNumber: number;
  deps: RuntimeProjectionDeps;
}

export interface RuntimeSkillInvocationProjectionInput {
  db: HarnessDb;
  event: RuntimeSessionLogProjection;
  evidencePath: string;
  lineNumber: number;
  deps: RuntimeProjectionDeps;
}

function verificationVerbFromSessionTarget(event: RuntimeSessionLogProjection): string | null {
  if (event.event_type !== "tool_use" || !["Bash", "PowerShell"].includes(event.tool ?? "")) {
    return null;
  }
  const match = String(event.target ?? "").match(/^(?:Bash|PowerShell) \(([^)]+)\)$/);
  if (!match) return null;
  const verb = match[1];
  return ["doctor", "eslint", "lint", "test", "tsc", "vitest"].includes(verb) ? verb : null;
}

export function projectRuntimeTestRunFromSessionEvent(input: RuntimeTestRunProjectionInput): void {
  const { db, event, evidencePath, lineNumber, deps } = input;
  if (!event.session_id || !event.ts) return;
  const verb = verificationVerbFromSessionTarget(event);
  if (!verb) return;
  const shell = event.tool === "PowerShell" ? "powershell" : "bash";
  const status = event.outcome === "error" ? "failed" : "passed";
  const testRunId = deps.stableId("test-run-runtime", `${evidencePath}:${lineNumber}`);
  deps.recordProjectionEvent(db, {
    table: "test_runs",
    id: testRunId,
    row: {
      test_run_id: testRunId,
      session_id: event.session_id,
      plan_id: null,
      command: event.target ?? `${event.tool} (${verb})`,
      runner: "node",
      runtime: "hook-session-log",
      os: "",
      shell,
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
  const { db, event, evidencePath, lineNumber, deps } = input;
  if (!event.session_id || !event.ts) return;
  if (event.event_type !== "forced_stop") return;
  const guardrailDecisionId = deps.stableId("guardrail-runtime", `${evidencePath}:${lineNumber}`);
  deps.recordProjectionEvent(db, {
    table: "guardrail_decisions",
    id: guardrailDecisionId,
    row: {
      guardrail_decision_id: guardrailDecisionId,
      plan_id: null,
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
  const { db, event, evidencePath, lineNumber, deps } = input;
  if (!event.session_id || !event.ts) return;
  if (!skillVerbFromSessionTarget(event)) return;
  const invId = deps.stableId("skill-inv-runtime", `${evidencePath}:${lineNumber}`);
  deps.recordProjectionEvent(db, {
    table: "skill_invocations",
    id: invId,
    row: {
      skill_invocation_id: invId,
      session_id: event.session_id,
      plan_id: null,
      skill_id: null,
      layer: null,
      drive: null,
      fired_at: event.ts,
      source: "runtime-hook:skill-suggest",
      accepted: event.outcome === "error" ? 0 : 1,
    },
  });
}

export function projectRuntimeSkillInvocationsFromSessionLogs(input: {
  repoRoot: string;
  db: HarnessDb;
  deps: RuntimeSkillInvocationProjectionInput["deps"];
}): void {
  const { repoRoot, db, deps } = input;
  const sessionDir = join(repoRoot, ".ut-tdd", "logs", "session");
  if (!existsSync(sessionDir)) return;
  for (const file of readdirSync(sessionDir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()) {
    const path = join(sessionDir, file);
    const relPath = normalizePath(relative(repoRoot, path));
    for (const [index, line] of readFileSync(path, "utf8").split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      let event: RuntimeSessionLogProjection;
      try {
        event = JSON.parse(line) as RuntimeSessionLogProjection;
      } catch {
        continue;
      }
      projectRuntimeSkillInvocationFromSessionEvent({
        db,
        event,
        evidencePath: relPath,
        lineNumber: index + 1,
        deps,
      });
    }
  }
}
