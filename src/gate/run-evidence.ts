import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ensureDir } from "../shared/fs.ts";

export interface GateRunEvidenceInput {
  repoRoot: string;
  gateId: string;
  planId?: string | null;
  status: "passed" | "failed";
  checkedAt?: string;
  sessionId?: string | null;
  mode?: string | null;
  tier?: string | null;
  reviewKind?: string | null;
  workerModel?: string | null;
  reviewerModel?: string | null;
  checklistPath?: string | null;
  coverageSummaryPath?: string | null;
  staticApplicable?: boolean;
  source?: string;
  messages?: string[];
  checks?: GateRunEvidenceCheck[];
}

export interface GateRunEvidenceCheck {
  name: string;
  result: "passed" | "failed" | "not_applicable";
  messages: string[];
}

export interface GateRunEvidence {
  schema_version: 1;
  gate_run_id: string;
  gate_id: string;
  timestamp: string;
  plan_id: string | null;
  status: "passed" | "failed";
  checked_at: string;
  session_id: string | null;
  mode: string | null;
  tier: string | null;
  review_kind: string | null;
  worker_model: string | null;
  reviewer_model: string | null;
  checklist_path: string | null;
  coverage_summary_path: string | null;
  static_applicable: boolean;
  command: {
    name: "ut-tdd gate";
    gate_id: string;
    plan_id: string | null;
  };
  checks: GateRunEvidenceCheck[];
  source: string;
  messages: string[];
}

export interface WrittenGateRunEvidence {
  evidence: GateRunEvidence;
  path: string;
}

function compactSlug(value: string): string {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9._:-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function gateRunEvidenceDir(repoRoot: string): string {
  return join(repoRoot, ".ut-tdd", "gate_runs");
}

export function buildGateRunEvidence(input: GateRunEvidenceInput): GateRunEvidence {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const planId = input.planId?.trim() ? input.planId.trim() : null;
  const runSeed = [
    planId ?? "no-plan",
    input.gateId,
    checkedAt,
    input.sessionId ?? "",
    process.pid,
  ].join(":");
  return {
    schema_version: 1,
    gate_run_id: `gate-run:${compactSlug(input.gateId)}:${shortHash(runSeed)}`,
    gate_id: input.gateId,
    timestamp: checkedAt,
    plan_id: planId,
    status: input.status,
    checked_at: checkedAt,
    session_id: input.sessionId?.trim() ? input.sessionId.trim() : null,
    mode: input.mode ?? null,
    tier: input.tier ?? input.reviewKind ?? null,
    review_kind: input.reviewKind ?? null,
    worker_model: input.workerModel ?? null,
    reviewer_model: input.reviewerModel ?? null,
    checklist_path: input.checklistPath ?? null,
    coverage_summary_path: input.coverageSummaryPath ?? null,
    static_applicable: Boolean(input.staticApplicable),
    command: {
      name: "ut-tdd gate",
      gate_id: input.gateId,
      plan_id: planId,
    },
    checks: input.checks ?? [],
    source: input.source ?? "ut-tdd gate",
    messages: input.messages ?? [],
  };
}

export function writeGateRunEvidence(input: GateRunEvidenceInput): WrittenGateRunEvidence {
  const evidence = buildGateRunEvidence(input);
  const dir = gateRunEvidenceDir(input.repoRoot);
  ensureDir(dir, { recursive: true });
  const timestamp = compactSlug(evidence.checked_at.replace(/[:.]/g, "-"));
  const suffix = shortHash(evidence.gate_run_id);
  const absolutePath = join(dir, `${compactSlug(evidence.gate_id)}-${timestamp}-${suffix}.json`);
  writeFileSync(absolutePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return {
    evidence,
    path: relative(input.repoRoot, absolutePath).replace(/\\/g, "/"),
  };
}
