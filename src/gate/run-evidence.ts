import { createHash, randomUUID } from "node:crypto";
import { linkSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
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

interface GateRunPublishBoundary {
  beforeLink?: (stagedPath: string, finalPath: string) => void;
  link?: (stagedPath: string, finalPath: string) => void;
  pathDigest?: (gateRunId: string) => string;
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

export function gateRunEvidenceFilename(
  gateRunId: string,
  pathDigest?: (gateRunId: string) => string,
): string {
  const digest = pathDigest
    ? pathDigest(gateRunId)
    : createHash("sha256").update(gateRunId, "utf8").digest("hex");
  return `${digest}.json`;
}

export function buildGateRunEvidence(input: GateRunEvidenceInput): GateRunEvidence {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const planId = input.planId?.trim() ? input.planId.trim() : null;
  const runSeed = [input.gateId, checkedAt, input.sessionId ?? "", process.pid].join(":");
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

const EXISTING_EVIDENCE_SCAN_FAILED = "existing_evidence_scan_failed";

export function formatGateRunEvidenceWarning(error: unknown): string {
  const detail =
    error instanceof Error && "code" in error && error.code === EXISTING_EVIDENCE_SCAN_FAILED
      ? error.message
      : String(error);
  return `gate run evidence write failed: ${detail}`;
}

function assertGateRunIdAvailable(repoRoot: string, dir: string, gateRunId: string): void {
  const existingFiles = readdirSync(dir).filter((name) => name.endsWith(".json"));
  for (const name of existingFiles) {
    const existingPath = join(dir, name);
    let existingId: unknown;
    try {
      const existing = JSON.parse(readFileSync(existingPath, "utf8")) as {
        gate_run_id?: unknown;
      };
      existingId = existing.gate_run_id;
    } catch {
      const code = EXISTING_EVIDENCE_SCAN_FAILED;
      const relativePath = relative(repoRoot, existingPath).split(sep).join("/");
      throw Object.assign(new Error(`${code}: ${JSON.stringify(relativePath)}`), { code });
    }
    if (existingId === gateRunId) {
      const error = Object.assign(new Error("EEXIST: gate run evidence ID already exists"), {
        code: "EEXIST",
      });
      throw error;
    }
  }
}

export function writeGateRunEvidence(
  input: GateRunEvidenceInput,
  boundary?: GateRunPublishBoundary,
): WrittenGateRunEvidence {
  const evidence = buildGateRunEvidence(input);
  const dir = gateRunEvidenceDir(input.repoRoot);
  ensureDir(dir, { recursive: true });
  assertGateRunIdAvailable(input.repoRoot, dir, evidence.gate_run_id);

  const absolutePath = join(
    dir,
    gateRunEvidenceFilename(evidence.gate_run_id, boundary?.pathDigest),
  );
  const temporaryPath = join(dir, `.tmp-${randomUUID()}`);
  writeFileSync(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  boundary?.beforeLink?.(temporaryPath, absolutePath);
  const link = boundary?.link ?? linkSync;
  link(temporaryPath, absolutePath);
  try {
    unlinkSync(temporaryPath);
  } catch {
    // The complete final record is already published; readers ignore leftover temps.
  }
  return {
    evidence,
    path: relative(input.repoRoot, absolutePath).replace(/\\/g, "/"),
  };
}
