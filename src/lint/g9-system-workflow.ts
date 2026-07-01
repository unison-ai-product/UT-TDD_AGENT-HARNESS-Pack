import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export interface G9SystemWorkflowInput {
  repoRoot?: string;
  l9TestDesign: string;
  gatesMd: string;
  evidenceManifests: G9SystemEvidenceManifest[];
}

export interface G9SystemEvidenceCommand {
  command_id: string;
  command: string;
  runner: string;
  scope: string;
  exit_code: number;
  evidence_path: string;
  output_digest: string;
  st_ids: string[];
}

export interface G9SystemEvidenceCoverage {
  st_id: string;
  status: string;
  evidence_paths: string[];
  command_ids: string[];
  notes?: string;
}

export interface G9SystemEvidenceManifest {
  manifest_path: string;
  schema_version: string;
  gate: string;
  profile: string;
  plan_id: string;
  selected_st_ids: string[];
  mandatory_st_ids: string[];
  deferred_st_ids: string[];
  commands: G9SystemEvidenceCommand[];
  coverage: G9SystemEvidenceCoverage[];
  exit_criteria: {
    all_mandatory_passed?: boolean;
    failed_mandatory_count?: number;
    stale_defer_count?: number;
    doctor_check?: string;
  };
}

export interface G9SystemWorkflowResult {
  ok: boolean;
  missingWorkflowMarkers: string[];
  missingGateMarkers: string[];
  stCaseCount: number;
  manifestCount: number;
  selectedStCount: number;
  mandatoryStCount: number;
  violations: string[];
}

const WORKFLOW_MARKERS = [
  "G9-WORKFLOW",
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
  "G9-WORKFLOW",
  "system evidence manifest",
  "ST-* coverage",
  "exit blocks",
] as const;

const REQUIRED_ST_FAMILY_PREFIXES = [
  "ST-DATA-",
  "ST-ARCH-",
  "ST-FUNC-",
  "ST-ASSET-",
  "ST-EXT-",
] as const;
const EVIDENCE_MANIFEST_SCHEMA = "g9-system-evidence-v1";
const EVIDENCE_DIR = ".ut-tdd/evidence/g9-system";
const ALLOWED_EVIDENCE_PREFIXES = [
  ".github/workflows/",
  ".ut-tdd/evidence/",
  "docs/",
  "src/",
  "tests/",
] as const;
const ST_ROW_ID_RE = /^\|\s*\*{0,2}(ST-[A-Z]+-[A-Za-z0-9-]+)/;

type JsonRecord = Record<string, unknown>;

export function loadG9SystemWorkflowInput(repoRoot = process.cwd()): G9SystemWorkflowInput {
  return {
    repoRoot,
    l9TestDesign: readFileSync(
      resolve(repoRoot, "docs/test-design/harness/L9-system-test-design.md"),
      "utf8",
    ),
    gatesMd: readFileSync(resolve(repoRoot, "docs/process/gates.md"), "utf8"),
    evidenceManifests: loadG9SystemEvidenceManifests(repoRoot),
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

function evidenceCommands(value: unknown): G9SystemEvidenceCommand[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => ({
    command_id: typeof item.command_id === "string" ? item.command_id : "",
    command: typeof item.command === "string" ? item.command : "",
    runner: typeof item.runner === "string" ? item.runner : "",
    scope: typeof item.scope === "string" ? item.scope : "",
    exit_code: typeof item.exit_code === "number" ? item.exit_code : -1,
    evidence_path: typeof item.evidence_path === "string" ? item.evidence_path : "",
    output_digest: typeof item.output_digest === "string" ? item.output_digest : "",
    st_ids: stringArray(item.st_ids),
  }));
}

function evidenceCoverage(value: unknown): G9SystemEvidenceCoverage[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => ({
    st_id: typeof item.st_id === "string" ? item.st_id : "",
    status: typeof item.status === "string" ? item.status : "",
    evidence_paths: stringArray(item.evidence_paths),
    command_ids: stringArray(item.command_ids),
    notes: typeof item.notes === "string" ? item.notes : undefined,
  }));
}

function manifestFromJson(manifestPath: string, raw: unknown): G9SystemEvidenceManifest {
  const doc = isRecord(raw) ? raw : {};
  const exitCriteria = isRecord(doc.exit_criteria) ? doc.exit_criteria : {};
  return {
    manifest_path: manifestPath,
    schema_version: typeof doc.schema_version === "string" ? doc.schema_version : "",
    gate: typeof doc.gate === "string" ? doc.gate : "",
    profile: typeof doc.profile === "string" ? doc.profile : "",
    plan_id: typeof doc.plan_id === "string" ? doc.plan_id : "",
    selected_st_ids: stringArray(doc.selected_st_ids),
    mandatory_st_ids: stringArray(doc.mandatory_st_ids),
    deferred_st_ids: stringArray(doc.deferred_st_ids),
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

export function loadG9SystemEvidenceManifests(
  repoRoot = process.cwd(),
): G9SystemEvidenceManifest[] {
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

function extractDesignedStIds(l9TestDesign: string): string[] {
  return [
    ...new Set(
      l9TestDesign
        .split(/\r?\n/)
        .map((line) => line.match(ST_ROW_ID_RE)?.[1])
        .filter((id): id is string => Boolean(id)),
    ),
  ].sort();
}

function validateManifest(
  manifest: G9SystemEvidenceManifest,
  repoRoot: string | undefined,
): string[] {
  const violations: string[] = [];
  if (manifest.schema_version !== EVIDENCE_MANIFEST_SCHEMA) {
    violations.push(`${manifest.manifest_path}: invalid schema_version`);
  }
  if (manifest.gate !== "G9") {
    violations.push(`${manifest.manifest_path}: gate must be G9`);
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

  const coverageBySt = new Map(manifest.coverage.map((entry) => [entry.st_id, entry]));
  for (const mandatoryStId of manifest.mandatory_st_ids) {
    const coverage = coverageBySt.get(mandatoryStId);
    if (!coverage) {
      violations.push(`${manifest.manifest_path}: missing coverage for ${mandatoryStId}`);
      continue;
    }
    if (coverage.status !== "passed") {
      violations.push(
        `${manifest.manifest_path}: mandatory coverage ${mandatoryStId} is not passed`,
      );
    }
    if (coverage.evidence_paths.length === 0 || coverage.command_ids.length === 0) {
      violations.push(
        `${manifest.manifest_path}: coverage ${mandatoryStId} lacks evidence paths or commands`,
      );
    }
    for (const evidencePath of coverage.evidence_paths) {
      if (!pathExistsInsideRepo(repoRoot, evidencePath)) {
        violations.push(
          `${manifest.manifest_path}: coverage ${mandatoryStId} path missing: ${evidencePath}`,
        );
      }
      if (!hasAllowedEvidencePrefix(evidencePath)) {
        violations.push(
          `${manifest.manifest_path}: coverage ${mandatoryStId} path prefix not allowed: ${evidencePath}`,
        );
      }
    }
    for (const commandId of coverage.command_ids) {
      if (!commandIds.has(commandId)) {
        violations.push(
          `${manifest.manifest_path}: coverage ${mandatoryStId} references unknown command ${commandId}`,
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
  if (manifest.exit_criteria.doctor_check !== "g9-system-workflow") {
    violations.push(
      `${manifest.manifest_path}: exit_criteria.doctor_check must be g9-system-workflow`,
    );
  }
  return violations;
}

export function analyzeG9SystemWorkflow(input: G9SystemWorkflowInput): G9SystemWorkflowResult {
  const missingWorkflowMarkers = missingMarkers(input.l9TestDesign, WORKFLOW_MARKERS);
  const missingGateMarkers = missingMarkers(input.gatesMd, GATE_MARKERS);
  const designedStIds = extractDesignedStIds(input.l9TestDesign);
  const stCaseCount = designedStIds.length;
  const selectedStIds = new Set(
    input.evidenceManifests.flatMap((manifest) => manifest.selected_st_ids),
  );
  const mandatoryStIds = new Set(
    input.evidenceManifests.flatMap((manifest) => manifest.mandatory_st_ids),
  );
  const deferredStIds = new Set(
    input.evidenceManifests.flatMap((manifest) => manifest.deferred_st_ids),
  );
  const coveredDesignedStIds = new Set([...mandatoryStIds, ...deferredStIds]);
  const violations: string[] = [];

  if (missingWorkflowMarkers.length > 0) {
    violations.push(
      `L9 test design is missing G9 workflow markers: ${missingWorkflowMarkers.join(", ")}`,
    );
  }
  if (missingGateMarkers.length > 0) {
    violations.push(
      `G9 gate definition is missing workflow markers: ${missingGateMarkers.join(", ")}`,
    );
  }
  if (stCaseCount < 10) {
    violations.push(
      `L9 test design has too few ST cases for a gate-significant workflow: ${stCaseCount}`,
    );
  }
  if (input.evidenceManifests.length === 0) {
    violations.push(`G9 system evidence manifest is missing under ${EVIDENCE_DIR}`);
  }
  for (const stId of designedStIds) {
    if (!coveredDesignedStIds.has(stId)) {
      violations.push(`G9 designed ST row lacks mandatory/deferred evidence: ${stId}`);
    }
  }
  for (const stId of [...mandatoryStIds]) {
    if (!selectedStIds.has(stId)) {
      violations.push(`G9 mandatory ST row is not selected: ${stId}`);
    }
  }
  for (const stId of [...deferredStIds]) {
    if (!designedStIds.includes(stId)) {
      violations.push(`G9 deferred ST row is not defined in L9 design: ${stId}`);
    }
  }
  for (const prefix of REQUIRED_ST_FAMILY_PREFIXES) {
    if (![...selectedStIds].some((stId) => stId.startsWith(prefix))) {
      violations.push(`G9 selected ST coverage missing ${prefix} family`);
    }
    if (![...mandatoryStIds].some((stId) => stId.startsWith(prefix))) {
      violations.push(`G9 mandatory ST coverage missing ${prefix} family`);
    }
  }
  for (const manifest of input.evidenceManifests) {
    violations.push(...validateManifest(manifest, input.repoRoot));
  }

  return {
    ok: violations.length === 0,
    missingWorkflowMarkers,
    missingGateMarkers,
    stCaseCount,
    manifestCount: input.evidenceManifests.length,
    selectedStCount: selectedStIds.size,
    mandatoryStCount: mandatoryStIds.size,
    violations,
  };
}

export function g9SystemWorkflowMessages(result: G9SystemWorkflowResult): string[] {
  if (result.ok) {
    return [
      `g9-system-workflow - OK (st_cases=${result.stCaseCount}, manifests=${result.manifestCount}, selected_st=${result.selectedStCount}, mandatory_st=${result.mandatoryStCount})`,
    ];
  }
  return [`g9-system-workflow - violation: ${result.violations.join("; ")}`];
}

export function canLoadG9SystemWorkflowInput(repoRoot: string): boolean {
  return (
    existsSync(resolve(repoRoot, "docs/test-design/harness/L9-system-test-design.md")) &&
    existsSync(resolve(repoRoot, "docs/process/gates.md"))
  );
}
