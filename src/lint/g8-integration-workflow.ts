import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export interface G8IntegrationWorkflowInput {
  repoRoot?: string;
  l8TestDesign: string;
  gatesMd: string;
  evidenceManifests: G8IntegrationEvidenceManifest[];
}

export interface G8IntegrationEvidenceCommand {
  command_id: string;
  command: string;
  runner: string;
  scope: string;
  exit_code: number;
  evidence_path: string;
  output_digest: string;
  it_ids: string[];
}

export interface G8IntegrationEvidenceCoverage {
  it_id: string;
  status: string;
  evidence_paths: string[];
  command_ids: string[];
  notes?: string;
}

export interface G8IntegrationEvidenceManifest {
  manifest_path: string;
  schema_version: string;
  gate: string;
  profile: string;
  plan_id: string;
  selected_it_ids: string[];
  mandatory_it_ids: string[];
  deferred_it_ids: string[];
  commands: G8IntegrationEvidenceCommand[];
  coverage: G8IntegrationEvidenceCoverage[];
  exit_criteria: {
    all_mandatory_passed?: boolean;
    failed_mandatory_count?: number;
    stale_defer_count?: number;
    doctor_check?: string;
  };
}

export interface G8IntegrationWorkflowResult {
  ok: boolean;
  missingWorkflowMarkers: string[];
  missingGateMarkers: string[];
  itCaseCount: number;
  manifestCount: number;
  selectedItCount: number;
  mandatoryItCount: number;
  violations: string[];
}

const WORKFLOW_MARKERS = [
  "G8-WORKFLOW",
  "test_strategy",
  "test_plan",
  "test_conditions",
  "coverage_items",
  "test_procedures",
  "execution_evidence",
  "exit_criteria",
  "defect_routing",
] as const;

const GATE_MARKERS = [
  "G8-WORKFLOW",
  "integration evidence manifest",
  "IT-* coverage",
  "exit blocks",
] as const;

const REQUIRED_IT_FAMILY_PREFIXES = ["IT-MODULE-", "IT-STATE-"] as const;
const EVIDENCE_MANIFEST_SCHEMA = "g8-integration-evidence-v1";
const EVIDENCE_DIR = ".ut-tdd/evidence/g8-integration";
const ALLOWED_EVIDENCE_PREFIXES = [".ut-tdd/evidence/", "docs/", "src/", "tests/"] as const;

type JsonRecord = Record<string, unknown>;

export function loadG8IntegrationWorkflowInput(
  repoRoot = process.cwd(),
): G8IntegrationWorkflowInput {
  return {
    repoRoot,
    l8TestDesign: readFileSync(
      resolve(repoRoot, "docs/test-design/harness/L8-integration-test-design.md"),
      "utf8",
    ),
    gatesMd: readFileSync(resolve(repoRoot, "docs/process/gates.md"), "utf8"),
    evidenceManifests: loadG8IntegrationEvidenceManifests(repoRoot),
  };
}

function missingMarkers(text: string, markers: readonly string[]): string[] {
  return markers.filter((marker) => !text.includes(marker));
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function evidenceCommands(value: unknown): G8IntegrationEvidenceCommand[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => ({
    command_id: typeof item.command_id === "string" ? item.command_id : "",
    command: typeof item.command === "string" ? item.command : "",
    runner: typeof item.runner === "string" ? item.runner : "",
    scope: typeof item.scope === "string" ? item.scope : "",
    exit_code: typeof item.exit_code === "number" ? item.exit_code : -1,
    evidence_path: typeof item.evidence_path === "string" ? item.evidence_path : "",
    output_digest: typeof item.output_digest === "string" ? item.output_digest : "",
    it_ids: stringArray(item.it_ids),
  }));
}

function evidenceCoverage(value: unknown): G8IntegrationEvidenceCoverage[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => ({
    it_id: typeof item.it_id === "string" ? item.it_id : "",
    status: typeof item.status === "string" ? item.status : "",
    evidence_paths: stringArray(item.evidence_paths),
    command_ids: stringArray(item.command_ids),
    notes: typeof item.notes === "string" ? item.notes : undefined,
  }));
}

function manifestFromJson(manifestPath: string, raw: unknown): G8IntegrationEvidenceManifest {
  const doc = isRecord(raw) ? raw : {};
  const exitCriteria = isRecord(doc.exit_criteria) ? doc.exit_criteria : {};
  return {
    manifest_path: manifestPath,
    schema_version: typeof doc.schema_version === "string" ? doc.schema_version : "",
    gate: typeof doc.gate === "string" ? doc.gate : "",
    profile: typeof doc.profile === "string" ? doc.profile : "",
    plan_id: typeof doc.plan_id === "string" ? doc.plan_id : "",
    selected_it_ids: stringArray(doc.selected_it_ids),
    mandatory_it_ids: stringArray(doc.mandatory_it_ids),
    deferred_it_ids: stringArray(doc.deferred_it_ids),
    commands: evidenceCommands(doc.commands),
    coverage: evidenceCoverage(doc.coverage),
    exit_criteria: {
      all_mandatory_passed:
        typeof exitCriteria.all_mandatory_passed === "boolean"
          ? exitCriteria.all_mandatory_passed
          : undefined,
      failed_mandatory_count:
        typeof exitCriteria.failed_mandatory_count === "number"
          ? exitCriteria.failed_mandatory_count
          : undefined,
      stale_defer_count:
        typeof exitCriteria.stale_defer_count === "number"
          ? exitCriteria.stale_defer_count
          : undefined,
      doctor_check:
        typeof exitCriteria.doctor_check === "string" ? exitCriteria.doctor_check : undefined,
    },
  };
}

export function loadG8IntegrationEvidenceManifests(
  repoRoot = process.cwd(),
): G8IntegrationEvidenceManifest[] {
  const dir = resolve(repoRoot, EVIDENCE_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const manifestPath = `${EVIDENCE_DIR}/${name}`;
      const raw = JSON.parse(readFileSync(resolve(dir, name), "utf8")) as unknown;
      return manifestFromJson(manifestPath, raw);
    });
}

function normalizedPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function pathExistsInsideRepo(repoRoot: string | undefined, path: string): boolean {
  if (!repoRoot || !path || isAbsolute(path)) return false;
  const resolved = resolve(repoRoot, path);
  const rel = relative(repoRoot, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  return existsSync(resolved);
}

function hasAllowedEvidencePrefix(path: string): boolean {
  const normalized = normalizedPath(path);
  return ALLOWED_EVIDENCE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function validateManifest(
  manifest: G8IntegrationEvidenceManifest,
  repoRoot: string | undefined,
): string[] {
  const violations: string[] = [];
  if (manifest.schema_version !== EVIDENCE_MANIFEST_SCHEMA) {
    violations.push(`${manifest.manifest_path}: invalid schema_version`);
  }
  if (manifest.gate !== "G8") {
    violations.push(`${manifest.manifest_path}: gate must be G8`);
  }
  if (!manifest.profile || !manifest.plan_id) {
    violations.push(`${manifest.manifest_path}: profile and plan_id are required`);
  }
  if (manifest.commands.length === 0) {
    violations.push(`${manifest.manifest_path}: commands must not be empty`);
  }

  const commandIds = new Set(manifest.commands.map((command) => command.command_id));
  for (const command of manifest.commands) {
    if (!command.command_id || !command.command || !command.runner || !command.scope) {
      violations.push(`${manifest.manifest_path}: command entry has missing required fields`);
    }
    if (command.exit_code !== 0) {
      violations.push(
        `${manifest.manifest_path}: command ${command.command_id} exit_code is non-zero`,
      );
    }
    if (!/^sha256:[0-9a-f]{64}$/i.test(command.output_digest)) {
      violations.push(
        `${manifest.manifest_path}: command ${command.command_id} has invalid digest`,
      );
    }
    if (!pathExistsInsideRepo(repoRoot, command.evidence_path)) {
      violations.push(
        `${manifest.manifest_path}: command ${command.command_id} evidence_path missing`,
      );
    }
    if (!hasAllowedEvidencePrefix(command.evidence_path)) {
      violations.push(
        `${manifest.manifest_path}: command ${command.command_id} evidence_path prefix not allowed`,
      );
    }
  }

  const coverageByIt = new Map(manifest.coverage.map((entry) => [entry.it_id, entry]));
  for (const mandatoryItId of manifest.mandatory_it_ids) {
    const coverage = coverageByIt.get(mandatoryItId);
    if (!coverage) {
      violations.push(`${manifest.manifest_path}: missing coverage for ${mandatoryItId}`);
      continue;
    }
    if (coverage.status !== "passed") {
      violations.push(
        `${manifest.manifest_path}: mandatory coverage ${mandatoryItId} is not passed`,
      );
    }
    if (coverage.evidence_paths.length === 0 || coverage.command_ids.length === 0) {
      violations.push(
        `${manifest.manifest_path}: coverage ${mandatoryItId} lacks evidence paths or commands`,
      );
    }
    for (const evidencePath of coverage.evidence_paths) {
      if (!pathExistsInsideRepo(repoRoot, evidencePath)) {
        violations.push(
          `${manifest.manifest_path}: coverage ${mandatoryItId} path missing: ${evidencePath}`,
        );
      }
      if (!hasAllowedEvidencePrefix(evidencePath)) {
        violations.push(
          `${manifest.manifest_path}: coverage ${mandatoryItId} path prefix not allowed: ${evidencePath}`,
        );
      }
    }
    for (const commandId of coverage.command_ids) {
      if (!commandIds.has(commandId)) {
        violations.push(
          `${manifest.manifest_path}: coverage ${mandatoryItId} references unknown command ${commandId}`,
        );
      }
    }
  }

  if (manifest.exit_criteria.all_mandatory_passed !== true) {
    violations.push(`${manifest.manifest_path}: exit_criteria.all_mandatory_passed must be true`);
  }
  if (manifest.exit_criteria.failed_mandatory_count !== 0) {
    violations.push(`${manifest.manifest_path}: exit_criteria.failed_mandatory_count must be 0`);
  }
  if (manifest.exit_criteria.stale_defer_count !== 0) {
    violations.push(`${manifest.manifest_path}: exit_criteria.stale_defer_count must be 0`);
  }
  if (manifest.exit_criteria.doctor_check !== "g8-integration-workflow") {
    violations.push(
      `${manifest.manifest_path}: exit_criteria.doctor_check must be g8-integration-workflow`,
    );
  }
  return violations;
}

export function analyzeG8IntegrationWorkflow(
  input: G8IntegrationWorkflowInput,
): G8IntegrationWorkflowResult {
  const missingWorkflowMarkers = missingMarkers(input.l8TestDesign, WORKFLOW_MARKERS);
  const missingGateMarkers = missingMarkers(input.gatesMd, GATE_MARKERS);
  const itCaseCount = new Set([...input.l8TestDesign.matchAll(/\bIT-[A-Z0-9-]+/g)].map((m) => m[0]))
    .size;
  const selectedItIds = new Set(
    input.evidenceManifests.flatMap((manifest) => manifest.selected_it_ids),
  );
  const mandatoryItIds = new Set(
    input.evidenceManifests.flatMap((manifest) => manifest.mandatory_it_ids),
  );
  const violations: string[] = [];

  if (missingWorkflowMarkers.length > 0) {
    violations.push(
      `L8 test design is missing G8 workflow markers: ${missingWorkflowMarkers.join(", ")}`,
    );
  }
  if (missingGateMarkers.length > 0) {
    violations.push(
      `G8 gate definition is missing workflow markers: ${missingGateMarkers.join(", ")}`,
    );
  }
  if (itCaseCount < 10) {
    violations.push(
      `L8 test design has too few IT cases for a gate-significant workflow: ${itCaseCount}`,
    );
  }
  if (input.evidenceManifests.length === 0) {
    violations.push(`G8 integration evidence manifest is missing under ${EVIDENCE_DIR}`);
  }
  for (const prefix of REQUIRED_IT_FAMILY_PREFIXES) {
    if (![...selectedItIds].some((itId) => itId.startsWith(prefix))) {
      violations.push(`G8 selected IT coverage missing ${prefix} family`);
    }
    if (![...mandatoryItIds].some((itId) => itId.startsWith(prefix))) {
      violations.push(`G8 mandatory IT coverage missing ${prefix} family`);
    }
  }
  for (const manifest of input.evidenceManifests) {
    violations.push(...validateManifest(manifest, input.repoRoot));
  }

  return {
    ok: violations.length === 0,
    missingWorkflowMarkers,
    missingGateMarkers,
    itCaseCount,
    manifestCount: input.evidenceManifests.length,
    selectedItCount: selectedItIds.size,
    mandatoryItCount: mandatoryItIds.size,
    violations,
  };
}

export function g8IntegrationWorkflowMessages(result: G8IntegrationWorkflowResult): string[] {
  if (result.ok) {
    return [
      `g8-integration-workflow - OK (it_cases=${result.itCaseCount}, manifests=${result.manifestCount}, selected_it=${result.selectedItCount}, mandatory_it=${result.mandatoryItCount})`,
    ];
  }
  return [`g8-integration-workflow - violation: ${result.violations.join("; ")}`];
}

export function canLoadG8IntegrationWorkflowInput(repoRoot: string): boolean {
  return (
    existsSync(resolve(repoRoot, "docs/test-design/harness/L8-integration-test-design.md")) &&
    existsSync(resolve(repoRoot, "docs/process/gates.md"))
  );
}
