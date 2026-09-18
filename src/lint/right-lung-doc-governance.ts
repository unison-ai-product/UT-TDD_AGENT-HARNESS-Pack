import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadCompiledRightArmRegistry,
  VMODEL_CONTRACT_PATH,
} from "../vmodel-contract/adapters/yaml-contract-loader.ts";

export interface RightLungDocGovernanceDoc {
  layer: string;
  gate: string;
  idPrefix: string;
  path: string;
  content: string;
}

export interface RightLungDocGovernanceInput {
  docs: RightLungDocGovernanceDoc[];
}

export interface RightLungDocGovernanceViolation {
  file: string;
  layer: string;
  gate: string;
  missing: string[];
}

export interface RightLungDocGovernanceResult {
  ok: boolean;
  checked: number;
  violations: RightLungDocGovernanceViolation[];
}

const REQUIRED_WORKFLOW_MARKERS = [
  "test_strategy",
  "test_plan",
  "test_conditions",
  "coverage_items",
  "test_procedures",
  "execution_evidence",
  "exit_criteria",
  "defect_routing",
  "verification_design",
] as const;

function loadRightLungDocDefinitions(
  repoRoot: string,
): Omit<RightLungDocGovernanceDoc, "content">[] {
  return loadCompiledRightArmRegistry(repoRoot).obligations.map((entry) => ({
    layer: entry.layer,
    gate: entry.gate,
    idPrefix: entry.caseIdPrefix,
    path: entry.governanceArtifact,
  }));
}

export function canLoadRightLungDocGovernanceInput(repoRoot = process.cwd()): boolean {
  if (!existsSync(resolve(repoRoot, VMODEL_CONTRACT_PATH))) return false;
  try {
    return loadRightLungDocDefinitions(repoRoot).every((doc) =>
      existsSync(resolve(repoRoot, doc.path)),
    );
  } catch {
    return false;
  }
}

export function loadRightLungDocGovernanceInput(
  repoRoot = process.cwd(),
): RightLungDocGovernanceInput {
  const definitions = loadRightLungDocDefinitions(repoRoot);
  return {
    docs: definitions.map((doc) => ({
      ...doc,
      content: readFileSync(resolve(repoRoot, doc.path), "utf8"),
    })),
  };
}

function missingMarkers(doc: RightLungDocGovernanceDoc): string[] {
  const workflowMarker = `${doc.gate}-WORKFLOW`;
  const workflowHeading = new RegExp(
    `^#{1,6}\\s+.*\\b${workflowMarker.replace("-", "\\-")}\\b.*$`,
    "m",
  );
  const markerMissing = workflowHeading.test(doc.content) ? [] : [workflowMarker];
  for (const marker of REQUIRED_WORKFLOW_MARKERS) {
    const fieldPattern = new RegExp(
      `^(?:${marker}:\\s*\\S|\\|\\s*\`?${marker}\`?\\s*\\|\\s*\\S)`,
      "m",
    );
    if (!fieldPattern.test(doc.content)) markerMissing.push(marker);
  }
  const idPattern = new RegExp(`^\\|[^\\n]*\\b${doc.idPrefix.replace("-", "\\-")}[A-Z0-9]`, "m");
  if (!idPattern.test(doc.content)) {
    markerMissing.push(`test_case_id_family:${doc.idPrefix}`);
  }
  return markerMissing;
}

export function analyzeRightLungDocGovernance(
  input: RightLungDocGovernanceInput,
): RightLungDocGovernanceResult {
  const violations = input.docs
    .map((doc) => ({
      file: doc.path,
      layer: doc.layer,
      gate: doc.gate,
      missing: missingMarkers(doc),
    }))
    .filter((violation) => violation.missing.length > 0);

  return {
    ok: violations.length === 0,
    checked: input.docs.length,
    violations,
  };
}

export function rightLungDocGovernanceMessages(result: RightLungDocGovernanceResult): string[] {
  if (result.ok) {
    return [`right-lung-doc-governance - OK (checked=${result.checked}, workflow markers=10)`];
  }
  return [
    `right-lung-doc-governance - violation: ${result.violations
      .map((v) => `${v.file}:${v.gate}:missing=${v.missing.join("|")}`)
      .join("; ")}`,
  ];
}
