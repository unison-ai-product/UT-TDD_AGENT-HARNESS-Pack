import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { analyzeGithubCiPolicy, type GithubWorkflowDoc } from "./github-ci-policy.ts";
import {
  admitNodeGenerationAggregate,
  type NodeGenerationCiEvidence,
} from "./node-generation-ci-policy.ts";
import { analyzeRuleDrift, type RuleAdapterDocs } from "./rule-drift.ts";
import {
  analyzeRuntimePortability,
  loadRuntimePortabilityDocs,
  type RuntimePortabilityDoc,
} from "./runtime-portability.ts";
import { analyzeToolchainPin, type ToolchainPinDocs } from "./toolchain-pin.ts";

const nodeBanAuditSchemaVersion = "bun-permanent-ban.v1" as const;
const nodeBanCandidateIdSchema = z.enum([
  "CAND-NODEBOOT-020",
  "CAND-NODEBOOT-201",
  "CAND-NODEBOOT-202",
  "CAND-NODEBOOT-203",
  "CAND-NODEBOOT-204",
]);
const nodeBanDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const nodeBanRevisionSchema = z.string().regex(/^[0-9a-f]{40}$/);
const nodeBanF0cAggregateSchema = z
  .object({
    ok: z.literal(true),
    schema_version: z.literal("node-generation-aggregate.v1"),
    generation_id: z.string().min(1),
    artifact_digest: nodeBanDigestSchema,
    subject_revision: nodeBanRevisionSchema,
    workflow_revision: nodeBanRevisionSchema,
    run_id: z.string().min(1),
    run_attempt: z.number().int().positive(),
  })
  .strict();
const nodeBanFindingSchema = z
  .object({
    detector: z.enum([
      "runtime-portability",
      "github-ci-policy",
      "rule-drift",
      "toolchain-pin",
      "process-observer",
    ]),
    path: z.string().min(1),
    rule: z.string().min(1),
    detail: z.string().min(1),
  })
  .strict();
const nodeBanCoverageSchema = z
  .object({
    runtime_files: z.number().int().nonnegative(),
    workflow_files: z.number().int().nonnegative(),
    instruction_files: z.number().int().nonnegative(),
    toolchain_files: z.number().int().nonnegative(),
    process_observations: z.number().int().nonnegative(),
    gaps: z.array(z.string()),
  })
  .strict();
const nodeBanProcessObservationSchema = z
  .object({
    scope: z.enum(["status", "doctor", "test", "hook", "descendant", "download"]),
    mode: z.enum(["invocation", "absence"]),
    command: z.string().min(1),
    args: z.array(z.string()),
    shell: z.boolean(),
    outcome: z.enum(["allowed", "blocked"]),
    spawned: z.boolean(),
    reason: z.string().min(1),
  })
  .strict();
const nodeBanAuditReceiptSchema = z
  .object({
    schema_version: z.literal(nodeBanAuditSchemaVersion),
    candidate_ids: z.array(nodeBanCandidateIdSchema).min(1),
    subject_revision: nodeBanRevisionSchema,
    f0c_generation_id: z.string().min(1),
    f0c_artifact_digest: nodeBanDigestSchema,
    f0c_lane_set_digest: nodeBanDigestSchema,
    node_lane: z.enum(["linux", "windows"]),
    node_generation_id: z.string().min(1),
    node_artifact_digest: nodeBanDigestSchema,
    f0b_receipt_digest: nodeBanDigestSchema,
    runtime: z.literal("node"),
    coverage: nodeBanCoverageSchema,
    debt_inventory_count: z.number().int().nonnegative(),
    debt_inventory_digest: nodeBanDigestSchema,
    findings: z.array(nodeBanFindingSchema),
    process_observations: z.array(nodeBanProcessObservationSchema),
    qualification: z.enum(["qualified", "non_compliant", "indeterminate"]),
    evidence_digest: nodeBanDigestSchema,
    receipt_digest: nodeBanDigestSchema,
  })
  .strict();

export type NodeBanCandidateId = z.infer<typeof nodeBanCandidateIdSchema>;
export type NodeBanCoverage = z.infer<typeof nodeBanCoverageSchema>;
export type NodeBanFinding = z.infer<typeof nodeBanFindingSchema>;
export type NodeBanRuntimeScope = "status" | "doctor" | "test" | "hook" | "descendant" | "download";
export interface NodeBanProcessObservation {
  readonly scope: NodeBanRuntimeScope;
  readonly mode: "invocation" | "absence";
  readonly command: string;
  readonly args: readonly string[];
  readonly shell: boolean;
  readonly outcome: "allowed" | "blocked";
  readonly spawned: boolean;
  readonly reason: string;
}
export type NodeBanProcessClassifier = (
  command: string,
  args: readonly string[],
  shell: boolean,
) => string;
export type NodeBanAuditReceipt = z.infer<typeof nodeBanAuditReceiptSchema>;

export const NODE_BAN_CANDIDATE_IDS = [
  "CAND-NODEBOOT-020",
  "CAND-NODEBOOT-201",
  "CAND-NODEBOOT-202",
  "CAND-NODEBOOT-203",
  "CAND-NODEBOOT-204",
] as const satisfies readonly NodeBanCandidateId[];

const NODE_BAN_RUNTIME_SCOPES: readonly NodeBanRuntimeScope[] = [
  "status",
  "doctor",
  "test",
  "hook",
  "descendant",
  "download",
];

const REVISION = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export interface NodeBanGenerationBinding {
  readonly lane: "linux" | "windows";
  readonly generation_id: string;
  readonly subject_revision: string;
  readonly artifact_digest: string;
  readonly receipt_digest: string;
  readonly runtime: "node";
}

export interface NodeBanF0cAggregateBinding {
  readonly ok: true;
  readonly schema_version: "node-generation-aggregate.v1";
  readonly generation_id: string;
  readonly artifact_digest: string;
  readonly subject_revision: string;
  readonly workflow_revision: string;
  readonly run_id: string;
  readonly run_attempt: number;
}

export interface NodeBanDocuments {
  readonly runtime: readonly RuntimePortabilityDoc[];
  readonly workflows: readonly GithubWorkflowDoc[];
  readonly instructions: RuleAdapterDocs;
  readonly toolchain: ToolchainPinDocs;
  readonly debtBaseline: string | null;
}

const debtEntrySchema = z
  .object({
    finding_id: z.string().min(1),
    detector: z.string().min(1),
    path: z.string().min(1),
    owner: z.string().min(1),
    expires_after: z.string().min(1),
  })
  .strict();
const debtBaselineSchema = z
  .object({
    schema_version: z.literal("bun-migration-debt.v1"),
    inventory: z.array(debtEntrySchema),
  })
  .strict();
type BunMigrationDebtBaseline = z.infer<typeof debtBaselineSchema>;

export class BanInventory {
  readonly findings: readonly NodeBanFinding[];

  constructor(findings: readonly NodeBanFinding[]) {
    this.findings = uniqueFindings(findings);
  }
}

export class DeltaGuard {
  evaluate(inventory: BanInventory, baseline: BunMigrationDebtBaseline): NodeBanFinding[] {
    return inventory.findings.filter(
      (item) =>
        !baseline.inventory.some(
          (entry) => entry.detector === item.detector && entry.path === item.path,
        ),
    );
  }
}

export class CompliancePolicy {
  evaluate(input: {
    baseline: BunMigrationDebtBaseline | null;
    delta: readonly NodeBanFinding[];
    findings: readonly NodeBanFinding[];
    gaps: readonly string[];
  }): "qualified" | "non_compliant" | "indeterminate" {
    if (
      (input.baseline?.inventory.length ?? 0) > 0 ||
      input.delta.length > 0 ||
      input.findings.length > 0
    )
      return "non_compliant";
    if (!input.baseline || input.gaps.length > 0) return "indeterminate";
    return "qualified";
  }
}

function parseDebtBaseline(value: string | null): BunMigrationDebtBaseline | null {
  if (!value) return null;
  try {
    return debtBaselineSchema.parse(parseYaml(value));
  } catch {
    return null;
  }
}

export interface NodeBanAuditInput {
  readonly repoRoot: string;
  readonly subjectRevision: string;
  readonly f0c: NodeBanF0cAggregateBinding;
  readonly node: NodeBanGenerationBinding;
  readonly documents?: NodeBanDocuments;
  readonly f0cLanes: readonly NodeGenerationCiEvidence[];
  readonly processObservations: readonly NodeBanProcessObservation[];
  readonly observedScopes: readonly NodeBanRuntimeScope[];
  /** Runtime-specific classification is injected at the composition boundary. */
  readonly classifyProcess: NodeBanProcessClassifier;
}

export interface NodeBanAuditResult {
  readonly receipt: NodeBanAuditReceipt;
  readonly findings: readonly NodeBanFinding[];
}

export class NodeBanAuditError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "NodeBanAuditError";
    this.code = code;
  }
}

const sha256 = (value: string): string =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function finding(input: {
  detector: NodeBanFinding["detector"];
  path: string;
  rule: string;
  detail: string;
}): NodeBanFinding {
  return { ...input, path: normalizePath(input.path) };
}

function uniqueFindings(values: readonly NodeBanFinding[]): NodeBanFinding[] {
  const seen = new Set<string>();
  return values
    .filter((item) => {
      const key = stable(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) =>
      [left.detector, left.path, left.rule, left.detail]
        .join("\0")
        .localeCompare([right.detector, right.path, right.rule, right.detail].join("\0")),
    );
}

function trackedFiles(repoRoot: string, prefixes: readonly string[]): string[] {
  try {
    return execFileSync(
      "git",
      ["-C", repoRoot, "ls-files", "--cached", "--others", "--exclude-standard", "--", ...prefixes],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    )
      .split(/\r?\n/)
      .filter(Boolean)
      .map(normalizePath);
  } catch {
    const result: string[] = [];
    const visit = (directory: string): void => {
      if (!existsSync(directory)) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else result.push(normalizePath(relative(repoRoot, path)));
      }
    };
    for (const prefix of prefixes) visit(resolve(repoRoot, prefix));
    return result;
  }
}

function readOptional(repoRoot: string, path: string): string | null {
  const absolute = resolve(repoRoot, path);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
}

function loadWorkflowDocuments(repoRoot: string): GithubWorkflowDoc[] {
  const paths = trackedFiles(repoRoot, [".github/workflows", "docs/templates/github"])
    .filter((path) => /\.(?:yml|yaml)$/i.test(path))
    .filter(
      (path) => path.startsWith(".github/workflows/") || path.startsWith("docs/templates/github/"),
    );
  return [...new Set(paths)].sort().map((file) => {
    const pack = file.startsWith("docs/templates/github/");
    return {
      file,
      content: readFileSync(resolve(repoRoot, file), "utf8"),
      profile: pack ? "pack" : "source",
      role: pack ? "pack_template" : "runtime",
    };
  });
}

export function loadNodeBanDocuments(repoRoot: string = process.cwd()): NodeBanDocuments {
  const runtime = loadRuntimePortabilityDocs(repoRoot);
  const instructionSurfaces = Object.fromEntries(
    trackedFiles(repoRoot, [".claude/commands", ".github"])
      .filter(
        (path) =>
          path === ".github/PULL_REQUEST_TEMPLATE.md" ||
          (path.startsWith(".claude/commands/") && path.endsWith(".md")),
      )
      .map((path) => [path, readFileSync(resolve(repoRoot, path), "utf8")]),
  );
  const instructions: RuleAdapterDocs = {
    agents: readOptional(repoRoot, "AGENTS.md") ?? "",
    claudeProject: readOptional(repoRoot, "CLAUDE.md") ?? "",
    claudeRuntime: readOptional(repoRoot, ".claude/CLAUDE.md") ?? "",
    instructionSurfaces,
  };
  return {
    runtime,
    workflows: loadWorkflowDocuments(repoRoot),
    instructions,
    toolchain: {
      packageJson: readOptional(repoRoot, "package.json"),
      bunLock: readOptional(repoRoot, "bun.lock"),
      packageLock: readOptional(repoRoot, "package-lock.json"),
      nodeVersion: readOptional(repoRoot, ".node-version"),
    },
    debtBaseline: readOptional(repoRoot, "docs/governance/bun-migration-debt.yaml"),
  };
}

export function collectNodeBanFindings(documents: NodeBanDocuments): NodeBanFinding[] {
  const findings: NodeBanFinding[] = [];
  for (const violation of analyzeRuntimePortability([...documents.runtime]).violations) {
    if (violation.rule.toLowerCase().includes("bun")) {
      findings.push(
        finding({
          detector: "runtime-portability",
          path: violation.path,
          rule: violation.rule,
          detail: violation.message,
        }),
      );
    }
  }
  for (const violation of analyzeGithubCiPolicy([...documents.workflows]).violations) {
    if (violation.reason === "forbidden_bun_execution") {
      findings.push(
        finding({
          detector: "github-ci-policy",
          path: violation.file,
          rule: violation.reason,
          detail: violation.detail,
        }),
      );
    }
  }
  const drift = analyzeRuleDrift(documents.instructions);
  for (const violation of drift.forbiddenMarkers) {
    if (violation.marker.toLowerCase().includes("bun")) {
      findings.push(
        finding({
          detector: "rule-drift",
          path: violation.file,
          rule: violation.marker,
          detail: "forbidden Bun execution instruction",
        }),
      );
    }
  }
  for (const violation of analyzeToolchainPin(documents.toolchain).violations) {
    if (violation.rule.toLowerCase().includes("bun")) {
      findings.push(
        finding({
          detector: "toolchain-pin",
          path: "package.json",
          rule: violation.rule,
          detail: violation.detail,
        }),
      );
    }
  }
  return uniqueFindings(findings);
}

function validateBinding(input: NodeBanAuditInput): void {
  if (!REVISION.test(input.subjectRevision))
    throw new NodeBanAuditError("q0-subject-revision-invalid");
  if (!nodeBanF0cAggregateSchema.safeParse(input.f0c).success)
    throw new NodeBanAuditError("q0-f0c-prerequisite-invalid");
  if (
    !input.node ||
    typeof input.node.generation_id !== "string" ||
    typeof input.node.subject_revision !== "string" ||
    typeof input.node.artifact_digest !== "string"
  )
    throw new NodeBanAuditError("q0-node-generation-invalid");
  if (input.node.runtime !== "node") throw new NodeBanAuditError("q0-runtime-not-node");
  if (input.node.lane !== "linux" && input.node.lane !== "windows")
    throw new NodeBanAuditError("q0-node-lane-invalid");
  for (const digest of [input.f0c.artifact_digest, input.node.artifact_digest]) {
    if (!DIGEST.test(digest)) throw new NodeBanAuditError("q0-artifact-digest-invalid");
  }
  if (
    input.f0c.subject_revision !== input.subjectRevision ||
    input.node.subject_revision !== input.subjectRevision
  )
    throw new NodeBanAuditError("q0-subject-revision-mismatch");
  if (input.f0c.workflow_revision !== input.subjectRevision)
    throw new NodeBanAuditError("q0-f0c-workflow-revision-mismatch");
  if (input.f0c.artifact_digest !== input.node.artifact_digest)
    throw new NodeBanAuditError("q0-artifact-digest-mismatch");
  if (!input.f0c.generation_id || !input.node.generation_id)
    throw new NodeBanAuditError("q0-generation-id-missing");
  if (!/^[0-9a-f]{64}$/.test(input.node.receipt_digest))
    throw new NodeBanAuditError("q0-f0b-receipt-invalid");
  const laneAdmission = admitNodeGenerationAggregate({
    evidence: input.f0cLanes,
    expected: {
      workflow_revision: input.f0c.workflow_revision,
      subject_revision: input.f0c.subject_revision,
      run_id: input.f0c.run_id,
      run_attempt: input.f0c.run_attempt,
    },
  });
  if (!laneAdmission.ok) throw new NodeBanAuditError(`q0-f0c-lane-${laneAdmission.reason}`);
  if (
    laneAdmission.generation_id !== input.f0c.generation_id ||
    laneAdmission.artifact_digest !== input.f0c.artifact_digest ||
    laneAdmission.subject_revision !== input.subjectRevision
  )
    throw new NodeBanAuditError("q0-f0c-aggregate-lane-mismatch");
  // F0c's common CI generation is a run identity. Each lane's sealed generation
  // is F0b custody identity and must stay distinct; equality would erase the
  // CI-to-F0b parent/child boundary rather than prove it.
  if (
    new Set(input.f0cLanes.map((lane) => lane.sealed_generation_id)).size !==
      input.f0cLanes.length ||
    input.f0cLanes.some((lane) => lane.sealed_generation_id === input.f0c.generation_id)
  )
    throw new NodeBanAuditError("q0-f0c-sealed-generation-conflated");
  const nodeLane = input.f0cLanes.find((lane) => lane.lane === input.node.lane);
  if (!nodeLane || nodeLane.sealed_generation_id !== input.node.generation_id)
    throw new NodeBanAuditError("q0-f0b-f0c-generation-mismatch");
  if (!nodeBanProcessObservationSchema.array().safeParse(input.processObservations).success)
    throw new NodeBanAuditError("q0-process-observation-invalid");
}

function validateObservationCoverage(input: NodeBanAuditInput): void {
  const observedFromEvidence = new Set(input.processObservations.map((item) => item.scope));
  const declaredScopes = new Set(input.observedScopes);
  if (
    input.observedScopes.length !== declaredScopes.size ||
    input.observedScopes.some((scope) => !NODE_BAN_RUNTIME_SCOPES.includes(scope)) ||
    input.processObservations.length !== observedFromEvidence.size ||
    observedFromEvidence.size !== declaredScopes.size ||
    [...observedFromEvidence].some((scope) => !declaredScopes.has(scope))
  )
    throw new NodeBanAuditError("q0-runtime-observer-scope-mismatch");
}

function coverage(
  documents: NodeBanDocuments,
  observations: readonly NodeBanProcessObservation[],
  observedScopes: readonly NodeBanRuntimeScope[],
): NodeBanCoverage {
  const toolchainFiles = [
    documents.toolchain.packageJson,
    documents.toolchain.bunLock,
    documents.toolchain.packageLock,
    documents.toolchain.nodeVersion,
  ].filter((value): value is string => typeof value === "string" && value.length > 0).length;
  const instructionFiles = [
    documents.instructions.agents,
    documents.instructions.claudeProject,
    documents.instructions.claudeRuntime,
  ].filter((value) => typeof value === "string" && value.length > 0).length;
  const instructionSurfaceFiles = Object.keys(
    documents.instructions.instructionSurfaces ?? {},
  ).length;
  const gaps: string[] = [];
  if (documents.runtime.length === 0) gaps.push("runtime-files");
  if (documents.workflows.length === 0) gaps.push("workflow-files");
  if (instructionFiles < 3 || instructionSurfaceFiles === 0) gaps.push("instruction-files");
  if (toolchainFiles < 3) gaps.push("toolchain-files");
  if (observations.length === 0) gaps.push("process-observations");
  if (!parseDebtBaseline(documents.debtBaseline)) gaps.push("debt-baseline");
  gaps.push(
    ...NODE_BAN_RUNTIME_SCOPES.filter((scope) => !new Set(observedScopes).has(scope)).map(
      (scope) => `runtime-image:${scope}`,
    ),
  );
  return {
    runtime_files: documents.runtime.length,
    workflow_files: documents.workflows.length,
    instruction_files: instructionFiles + instructionSurfaceFiles,
    toolchain_files: toolchainFiles,
    process_observations: observations.length,
    gaps,
  };
}

function processFindings(
  observations: readonly NodeBanProcessObservation[],
  classifyProcess: NodeBanProcessClassifier,
): NodeBanFinding[] {
  return observations.flatMap((observation) => {
    if (observation.mode === "absence") {
      if (observation.scope !== "descendant" && observation.scope !== "download") {
        return [
          finding({
            detector: "process-observer",
            path: observation.scope,
            rule: "invalid-absence-proof",
            detail: "absence proof is only valid for descendant/download ports",
          }),
        ];
      }
      return observation.spawned || observation.outcome !== "allowed"
        ? [
            finding({
              detector: "process-observer",
              path: observation.scope,
              rule: "forbidden-process-execution",
              detail: `absence proof violated; spawned=${observation.spawned}`,
            }),
          ]
        : [];
    }
    const reason = classifyProcess(observation.command, observation.args, observation.shell);
    const expected = reason === "node-only" ? "allowed" : "blocked";
    if (observation.outcome !== expected || (observation.spawned && expected === "blocked")) {
      return [
        finding({
          detector: "process-observer",
          path: observation.command,
          rule: "forbidden-process-execution",
          detail: `${reason}; spawned=${observation.spawned}`,
        }),
      ];
    }
    return [];
  });
}

function evidencePreimage(receipt: Omit<NodeBanAuditReceipt, "receipt_digest">): string {
  return stable(receipt);
}

function makeReceipt(input: NodeBanAuditInput, documents: NodeBanDocuments): NodeBanAuditReceipt {
  const observations = input.processObservations
    .map((item) => ({ ...item, args: [...item.args] }))
    .sort((left, right) => stable(left).localeCompare(stable(right)));
  const baseline = parseDebtBaseline(documents.debtBaseline);
  const base = {
    schema_version: nodeBanAuditSchemaVersion,
    candidate_ids: [...NODE_BAN_CANDIDATE_IDS],
    subject_revision: input.subjectRevision,
    f0c_generation_id: input.f0c.generation_id,
    f0c_artifact_digest: input.f0c.artifact_digest,
    f0c_lane_set_digest: sha256(stable(input.f0cLanes)),
    node_lane: input.node.lane,
    node_generation_id: input.node.generation_id,
    node_artifact_digest: input.node.artifact_digest,
    f0b_receipt_digest: `sha256:${input.node.receipt_digest}`,
    runtime: "node" as const,
    coverage: coverage(documents, observations, input.observedScopes),
    debt_inventory_count: baseline?.inventory.length ?? 0,
    debt_inventory_digest: sha256(stable(baseline?.inventory ?? [])),
    findings: uniqueFindings([
      ...collectNodeBanFindings(documents),
      ...processFindings(observations, input.classifyProcess),
    ]),
    process_observations: observations,
  };
  const inventory = new BanInventory(base.findings);
  const delta = baseline ? new DeltaGuard().evaluate(inventory, baseline) : base.findings;
  const qualification = new CompliancePolicy().evaluate({
    baseline,
    delta,
    findings: base.findings,
    gaps: base.coverage.gaps,
  });
  const evidence_digest = sha256(stable({ ...base, qualification }));
  const unsigned = { ...base, qualification, evidence_digest } as Omit<
    NodeBanAuditReceipt,
    "receipt_digest"
  >;
  return nodeBanAuditReceiptSchema.parse({
    ...unsigned,
    receipt_digest: sha256(evidencePreimage(unsigned)),
  });
}

export function runNodeBanAudit(input: NodeBanAuditInput): NodeBanAuditResult {
  validateBinding(input);
  validateObservationCoverage(input);
  const documents = input.documents ?? loadNodeBanDocuments(input.repoRoot);
  const receipt = makeReceipt(input, documents);
  return { receipt, findings: receipt.findings };
}

export function verifyNodeBanAuditReceipt(
  value: unknown,
  expected: Pick<
    NodeBanAuditInput,
    "subjectRevision" | "f0c" | "node" | "f0cLanes" | "classifyProcess"
  >,
): NodeBanAuditReceipt {
  const receipt = nodeBanAuditReceiptSchema.parse(value);
  try {
    validateBinding({
      repoRoot: "",
      subjectRevision: expected.subjectRevision,
      f0c: expected.f0c,
      node: expected.node,
      f0cLanes: expected.f0cLanes,
      processObservations: [],
      observedScopes: ["status"],
      classifyProcess: expected.classifyProcess,
    });
  } catch {
    throw new NodeBanAuditError("q0-receipt-binding-mismatch");
  }
  if (stable(receipt.candidate_ids) !== stable(NODE_BAN_CANDIDATE_IDS))
    throw new NodeBanAuditError("q0-candidate-set-mismatch");
  if (
    receipt.subject_revision !== expected.subjectRevision ||
    receipt.f0c_generation_id !== expected.f0c.generation_id ||
    receipt.f0c_artifact_digest !== expected.f0c.artifact_digest ||
    receipt.f0c_lane_set_digest !== sha256(stable(expected.f0cLanes)) ||
    receipt.node_lane !== expected.node.lane ||
    receipt.node_generation_id !== expected.node.generation_id ||
    receipt.node_artifact_digest !== expected.node.artifact_digest ||
    receipt.f0b_receipt_digest !== `sha256:${expected.node.receipt_digest}`
  )
    throw new NodeBanAuditError("q0-receipt-binding-mismatch");
  const { receipt_digest, ...unsigned } = receipt;
  if (sha256(evidencePreimage(unsigned)) !== receipt_digest)
    throw new NodeBanAuditError("q0-receipt-digest-mismatch");
  const { evidence_digest, ...evidence } = unsigned;
  if (sha256(stable(evidence)) !== evidence_digest)
    throw new NodeBanAuditError("q0-evidence-digest-mismatch");
  if (
    receipt.coverage.process_observations !== receipt.process_observations.length ||
    receipt.process_observations.length === 0
  )
    throw new NodeBanAuditError("q0-process-coverage-mismatch");
  const expectedQualification =
    receipt.findings.length > 0 ||
    processFindings(receipt.process_observations, expected.classifyProcess).length > 0
      ? "non_compliant"
      : receipt.debt_inventory_count > 0
        ? "non_compliant"
        : receipt.coverage.gaps.length > 0
          ? "indeterminate"
          : "qualified";
  if (receipt.qualification !== expectedQualification)
    throw new NodeBanAuditError("q0-qualification-mismatch");
  return receipt;
}

export function nodeBanAuditMessages(result: NodeBanAuditResult): string[] {
  const { receipt } = result;
  return [
    `node-ban-audit - ${receipt.qualification}`,
    `subject=${receipt.subject_revision} generation=${receipt.node_generation_id}`,
    `checked=${receipt.coverage.runtime_files} runtime/${receipt.coverage.workflow_files} workflow files; findings=${receipt.findings.length}; gaps=${receipt.coverage.gaps.length}`,
  ];
}
