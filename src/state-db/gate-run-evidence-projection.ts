import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { normalizePath } from "../shared/source-text.ts";
import { stableId } from "../stable-id.ts";
import type { ProjectionFindingInput } from "./sqlite-projection-store.ts";

interface ProjectedGateRunEvidence {
  gate_run_id?: unknown;
  gate_id?: unknown;
  plan_id?: unknown;
  status?: unknown;
  checked_at?: unknown;
}

export interface GateRunEvidenceProjectionRow extends Record<string, unknown> {
  gate_run_id: string;
  gate_id: string;
  plan_id: null;
  status: "passed" | "failed" | "historical";
  checked_at: string;
  evidence_path: string;
}

export interface GateRunWorkflowProjectionRow extends Record<string, unknown> {
  workflow_run_id: string;
  plan_id: null;
  drive_run_id: string;
  workflow: "routine-gate";
  phase: string;
  ready_status: "passed" | "blocked";
  blocked_reason: string;
  human_required: 0;
  checked_at: string;
  gate_run_id: string;
  evidence_path: string;
}

export interface GateRunEvidenceProjection {
  gateRuns: GateRunEvidenceProjectionRow[];
  workflowRuns: GateRunWorkflowProjectionRow[];
  findings: ProjectionFindingInput[];
  legacyPlanIds: Map<string, string>;
}

interface GateRunProjectionContext {
  asString: (value: unknown) => string | null;
}

interface GateRunEvidenceReaderInput {
  repoRoot: string;
  files: string[];
  projection: GateRunEvidenceProjection;
  asString: GateRunProjectionContext["asString"];
}

const VERIFY_CUTOVER_AUDIT_PATH = ".ut-tdd/audit/A-132-l8-l14-verification-band-execution.md";
const VERIFICATION_BAND_LAYERS = ["L8", "L9", "L10", "L11", "L12", "L13", "L14"] as const;
type GateRunFindingKind = "invalid-gate-run-evidence" | "duplicate-gate-run-evidence";

function gateRunFinding(
  kind: GateRunFindingKind,
  evidencePath: string,
  subjectId = evidencePath,
): ProjectionFindingInput {
  return {
    kind,
    severity: kind === "duplicate-gate-run-evidence" ? "error" : "warn",
    subjectId,
    source: "gate-run-projection",
    evidencePath,
  };
}

function historicalGateRuns(repoRoot: string): GateRunEvidenceProjectionRow[] {
  if (!existsSync(join(repoRoot, ...VERIFY_CUTOVER_AUDIT_PATH.split("/")))) return [];
  return VERIFICATION_BAND_LAYERS.map((layer) => ({
    gate_run_id: stableId("verification-band-gate", layer),
    gate_id: `G-VERIFY.${layer}`,
    plan_id: null,
    status: "historical",
    checked_at: "",
    evidence_path: VERIFY_CUTOVER_AUDIT_PATH,
  }));
}

function readGateRunEvidence(input: GateRunEvidenceReaderInput) {
  const { repoRoot, files, projection, asString } = input;
  const parsedRows: Array<{ evidencePath: string; parsed: ProjectedGateRunEvidence }> = [];
  const filesByGateRunId = new Map<string, string[]>();
  for (const file of files) {
    const evidencePath = normalizePath(relative(repoRoot, file));
    let parsed: ProjectedGateRunEvidence;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8")) as ProjectedGateRunEvidence;
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new TypeError();
    } catch {
      projection.findings.push(gateRunFinding("invalid-gate-run-evidence", evidencePath));
      continue;
    }
    const gateRunId = asString(parsed.gate_run_id);
    const gateId = asString(parsed.gate_id);
    const status =
      parsed.status === "passed" ? "passed" : parsed.status === "failed" ? "failed" : null;
    const checkedAt = asString(parsed.checked_at);
    if (gateRunId) {
      const occurrences = filesByGateRunId.get(gateRunId) ?? [];
      occurrences.push(evidencePath);
      filesByGateRunId.set(gateRunId, occurrences);
    }
    if ([gateRunId, gateId, status, checkedAt].some((value) => !value))
      projection.findings.push(gateRunFinding("invalid-gate-run-evidence", evidencePath));
    else parsedRows.push({ evidencePath, parsed });
  }
  return { parsedRows, filesByGateRunId };
}

function duplicateGateRunEvidence(
  filesByGateRunId: Map<string, string[]>,
  projection: GateRunEvidenceProjection,
): Set<string> {
  const duplicateIds = new Set<string>();
  for (const [gateRunId, paths] of filesByGateRunId) {
    if (paths.length < 2) continue;
    duplicateIds.add(gateRunId);
    for (const evidencePath of paths) {
      projection.findings.push(
        gateRunFinding("duplicate-gate-run-evidence", evidencePath, gateRunId),
      );
    }
  }
  return duplicateIds;
}

type GateRunRowsInput = ReturnType<typeof readGateRunEvidence> & { duplicateIds: Set<string> };

function gateRunRows(projection: GateRunEvidenceProjection, evidence: GateRunRowsInput): void {
  for (const { evidencePath, parsed } of evidence.parsedRows) {
    const gateRunId = String(parsed.gate_run_id);
    if (evidence.duplicateIds.has(gateRunId)) continue;
    if (typeof parsed.plan_id === "string" && parsed.plan_id.trim()) {
      projection.legacyPlanIds.set(gateRunId, parsed.plan_id.trim());
    }
    const gateId = String(parsed.gate_id);
    const status = parsed.status as "passed" | "failed";
    const checkedAt = String(parsed.checked_at);
    projection.gateRuns.push({
      gate_run_id: gateRunId,
      gate_id: gateId,
      plan_id: null,
      status,
      checked_at: checkedAt,
      evidence_path: evidencePath,
    });
    const workflowRunId = stableId("gate-workflow", gateRunId);
    projection.workflowRuns.push({
      workflow_run_id: workflowRunId,
      plan_id: null,
      drive_run_id: "",
      workflow: "routine-gate",
      phase: gateId,
      ready_status: status === "passed" ? "passed" : "blocked",
      blocked_reason: status === "passed" ? "" : "gate run status failed",
      human_required: 0,
      checked_at: checkedAt,
      gate_run_id: gateRunId,
      evidence_path: evidencePath,
    });
  }
}

export function collectGateRunEvidenceProjection(
  repoRoot: string,
  context: GateRunProjectionContext,
): GateRunEvidenceProjection {
  const result: GateRunEvidenceProjection = {
    gateRuns: historicalGateRuns(repoRoot),
    workflowRuns: [],
    findings: [],
    legacyPlanIds: new Map(),
  };
  const dir = join(repoRoot, ".ut-tdd", "gate_runs");
  if (!existsSync(dir)) return result;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(dir, name))
    .sort();
  const evidence = readGateRunEvidence({
    repoRoot,
    files,
    projection: result,
    asString: context.asString,
  });
  const rowsInput = {
    ...evidence,
    duplicateIds: duplicateGateRunEvidence(evidence.filesByGateRunId, result),
  };
  gateRunRows(result, rowsInput);
  return result;
}
