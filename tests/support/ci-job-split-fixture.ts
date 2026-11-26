import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { workspaceRead } from "./workspace-roots.ts";

export type ManifestEntry = {
  check_id: string;
  command: string | { uses: string; with?: Record<string, unknown> };
  condition: boolean;
  env: Record<string, unknown>;
  shell: string;
  continue_on_error: unknown;
};
export type WorkflowStep = {
  name?: string;
  id?: string;
  uses?: string;
  with?: Record<string, unknown>;
  run?: string;
  if?: string;
  env?: Record<string, unknown>;
  shell?: string;
  "continue-on-error"?: unknown;
};
export type WorkflowJob = {
  if?: string;
  env?: Record<string, unknown>;
  needs?: string[] | string;
  outputs?: Record<string, unknown>;
  "runs-on"?: string;
  steps?: WorkflowStep[];
  "continue-on-error"?: unknown;
};
export type Workflow = { env?: Record<string, unknown>; jobs: Record<string, WorkflowJob> };
const repoRoot = workspaceRead({
  id: "ci-job-split-workflow-manifest",
  mode: "head_snapshot",
  reason: "split-job oracle compares the immutable workflow and manifest from the same exact HEAD",
});
export const workflow = parseYaml(
  readFileSync(join(repoRoot, ".github", "workflows", "harness-check.yml"), "utf8"),
) as Workflow;
export const manifest = JSON.parse(
  readFileSync(join(repoRoot, "tests", "fixtures", "ci", "harness-check-contract.json"), "utf8"),
) as Record<"full" | "doc", Record<"pull_request" | "push", ManifestEntry[]>>;

export const expectedSplitJobs = [
  "classify",
  "harness-check-pr-discipline",
  "harness-check-static",
  "harness-check-linux",
];
export const expectedAggregateNeeds = [
  "classify",
  "harness-check-pr-discipline",
  "harness-check-static",
  "harness-check-linux",
  "harness-check-windows",
  "node-generation-linux",
  "node-generation-windows",
];
export const expectedJobByStep: Record<string, string> = {
  "oracle baseline ratchet (required on every PR)": "harness-check-pr-discipline",
  "classify changed files (doc lane vs full, fail-close)": "classify",
  "write harness lane evidence": "classify",
  "upload harness lane evidence": "classify",
  "branch-type guard (commitlint / poc / hotfix)": "harness-check-pr-discipline",
  "design-protection (実装 PR の設計書書き換え拒否、fail-close)": "harness-check-pr-discipline",
  "privacy scan (email の形、fail-close)": "harness-check-pr-discipline",
  "typecheck (tsc --noEmit)": "harness-check-static",
  "db rebuild (deterministic projection)": "harness-check-linux",
  "doctor (governance hard gates)": "harness-check-linux",
  "test — 全回帰 (vitest run)": "harness-check-linux",
  "doc lane checks (readability / rule-drift)": "harness-check-static",
  "doc lane source doctor": "harness-check-static",
  "lint (biome)": "harness-check-static",
  "audit quality (gate findings)": "harness-check-static",
  "job summary (UT-TDD projection)": "harness-check-linux",
};

const checkIds: Record<string, string> = {
  "oracle baseline ratchet (required on every PR)": "oracle-baseline-ratchet",
  "classify changed files (doc lane vs full, fail-close)": "classify-changed-files",
  "write harness lane evidence": "write-harness-lane-evidence",
  "upload harness lane evidence": "upload-harness-lane-evidence",
  "branch-type guard (commitlint / poc / hotfix)": "branch-type-guard",
  "design-protection (実装 PR の設計書書き換え拒否、fail-close)": "design-protection",
  "privacy scan (email の形、fail-close)": "privacy-scan",
  "typecheck (tsc --noEmit)": "typecheck-full",
  "db rebuild (deterministic projection)": "db-rebuild-full",
  "doctor (governance hard gates)": "doctor-full",
  "test — 全回帰 (vitest run)": "vitest-full",
  "doc lane checks (readability / rule-drift)": "doc-lane-checks",
  "doc lane source doctor": "doc-lane-source-doctor",
  "lint (biome)": "lint",
  "audit quality (gate findings)": "audit-quality-full",
  "job summary (UT-TDD projection)": "job-summary",
};
const preparationSteps = new Set([
  "checkout",
  "setup node (harness 実行系の正式 runtime、PLAN-L7-462 step 2)",
  "install deps (frozen)",
]);

export function linuxJobs(parsed: Workflow): [string, WorkflowJob][] {
  return Object.entries(parsed.jobs).filter(
    ([jobId, job]) =>
      (jobId === "classify" || jobId.startsWith("harness-check-")) &&
      job["runs-on"] === "ubuntu-latest",
  );
}

function conditionRuns(
  condition: string | undefined,
  lane: "full" | "doc",
  event: "pull_request" | "push",
) {
  if (!condition) return true;
  const expression = condition
    .trim()
    .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .trim();
  if (expression === "always()") return true;
  if (expression === "github.event_name == 'pull_request'") return event === "pull_request";
  if (expression === 'github.event_name == "pull_request"') return event === "pull_request";
  const laneMatch = expression.match(
    /^(?:steps\.classify\.outputs\.lane|needs\.classify\.outputs\.lane) == '(full|doc)'$/,
  );
  if (laneMatch) return laneMatch[1] === lane;
  throw new Error(`unsupported harness-check condition: ${condition}`);
}

export function extractExecutionPlan(
  parsed: Workflow,
  lane: "full" | "doc",
  event: "pull_request" | "push",
): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  for (const [, job] of linuxJobs(parsed)) {
    if (!conditionRuns(job.if, lane, event)) continue;
    for (const step of job.steps ?? []) {
      if (step.name && preparationSteps.has(step.name)) continue;
      if (!step.name) throw new Error("unmanifested Linux step has no name");
      const checkId = checkIds[step.name];
      if (!checkId) throw new Error(`unmanifested Linux step: ${step.name}`);
      const condition = conditionRuns(step.if, lane, event);
      if (!condition) continue;
      const command =
        typeof step.run === "string"
          ? step.run
          : step.uses
            ? { uses: step.uses, ...(step.with ? { with: step.with } : {}) }
            : undefined;
      if (command === undefined) throw new Error(`check has no command: ${step.name}`);
      entries.push({
        check_id: checkId,
        command,
        condition,
        env: { ...parsed.env, ...job.env, ...step.env },
        shell: step.shell ?? "",
        continue_on_error: step["continue-on-error"] ?? false,
      });
    }
  }
  return entries;
}

function normalizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, normalizeKeys(item)]),
    );
  return value;
}

export function plansEqual(left: ManifestEntry[], right: ManifestEntry[]): boolean {
  const byId = (entries: ManifestEntry[]) => {
    const normalized = entries.map((entry) => normalizeKeys(entry));
    normalized.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return JSON.stringify(normalized);
  };
  return byId(left) === byId(right);
}

export function planDiffers(
  parsed: Workflow,
  lane: "full" | "doc",
  event: "pull_request" | "push",
) {
  return !plansEqual(extractExecutionPlan(parsed, lane, event), manifest[lane][event]);
}

export function cloneWorkflow(): Workflow {
  return structuredClone(workflow);
}

export function findNamedStep(
  parsed: Workflow,
  name: string,
): { jobId: string; job: WorkflowJob; index: number; step: WorkflowStep } {
  const matches = linuxJobs(parsed).flatMap(([jobId, job]) =>
    (job.steps ?? []).flatMap((step, index) =>
      step.name === name ? [{ jobId, job, index, step }] : [],
    ),
  );
  if (matches.length !== 1)
    throw new Error(`mutation precondition: ${name} matches ${matches.length}`);
  const match = matches[0];
  if (!match) throw new Error(`mutation precondition: ${name} step missing`);
  return match;
}

function targetJob(parsed: Workflow, jobId: string): WorkflowJob {
  let job = parsed.jobs[jobId];
  if (!job) {
    job = { "runs-on": "ubuntu-latest", steps: [] };
    parsed.jobs[jobId] = job;
  }
  return job;
}

function removeStep(parsed: Workflow, name: string): Workflow {
  const { job, index } = findNamedStep(parsed, name);
  const steps = job.steps;
  if (!steps) throw new Error(`mutation precondition: ${name} steps missing`);
  steps.splice(index, 1);
  return parsed;
}

function changeCondition(parsed: Workflow, name: string, value?: string): Workflow {
  const { step } = findNamedStep(parsed, name);
  if (value === undefined) delete step.if;
  else step.if = value;
  return parsed;
}

function duplicateStep(parsed: Workflow, name: string, target: string): Workflow {
  const { step } = findNamedStep(parsed, name);
  const job = targetJob(parsed, target);
  const steps = job.steps ?? [];
  job.steps = steps;
  steps.push(structuredClone(step));
  return parsed;
}

function moveStep(parsed: Workflow, name: string, target: string): Workflow {
  const { job, index, step } = findNamedStep(parsed, name);
  const steps = job.steps;
  if (!steps) throw new Error(`mutation precondition: ${name} steps missing`);
  steps.splice(index, 1);
  const destination = targetJob(parsed, target);
  const destinationSteps = destination.steps ?? [];
  destination.steps = destinationSteps;
  destinationSteps.push(step);
  return parsed;
}

function doctorEnvMutation(parsed: Workflow): Workflow {
  const { step } = findNamedStep(parsed, "doctor (governance hard gates)");
  if (!step.env?.UT_TDD_DOCTOR_RESULT_FILE)
    throw new Error("mutation precondition: doctor env missing");
  delete step.env.UT_TDD_DOCTOR_RESULT_FILE;
  return parsed;
}

function vitestEnvMutation(parsed: Workflow): Workflow {
  const { step } = findNamedStep(parsed, "test — 全回帰 (vitest run)");
  if (!step.env?.PAIR_RETIREMENT_BASE_SHA)
    throw new Error("mutation precondition: vitest env missing");
  step.env.PAIR_RETIREMENT_BASE_SHA = "$" + "{{ github.sha }}";
  return parsed;
}

function auditCommandMutation(parsed: Workflow): Workflow {
  const { step } = findNamedStep(parsed, "audit quality (gate findings)");
  if (typeof step.run !== "string" || !step.run.includes("--limit 20"))
    throw new Error("mutation precondition: audit command missing --limit 20");
  step.run = step.run.replace("--limit 20", "--limit 21");
  return parsed;
}

export function stepPlacementViolations(parsed: Workflow): string[] {
  const problems: string[] = [];
  const found = new Map<string, { jobId: string; step: WorkflowStep; index: number }>();
  for (const [jobId, job] of linuxJobs(parsed)) {
    for (const [index, step] of (job.steps ?? []).entries()) {
      if (step.name && Object.hasOwn(expectedJobByStep, step.name)) {
        if (found.has(step.name)) problems.push(`duplicate:${step.name}`);
        else found.set(step.name, { jobId, step, index });
      }
    }
  }
  for (const [name, expectedJob] of Object.entries(expectedJobByStep)) {
    const actual = found.get(name);
    if (!actual) problems.push(`missing:${name}`);
    else if (actual.jobId !== expectedJob) problems.push(`job:${name}:${actual.jobId}`);
  }
  const write = found.get("write harness lane evidence");
  const upload = found.get("upload harness lane evidence");
  if (write && upload && (write.jobId !== upload.jobId || write.index >= upload.index))
    problems.push("lane-evidence-order-or-job");
  const doctor = found.get("doctor (governance hard gates)");
  const test = found.get("test — 全回帰 (vitest run)");
  const rebuild = found.get("db rebuild (deterministic projection)");
  const summary = found.get("job summary (UT-TDD projection)");
  if (rebuild && doctor && rebuild.jobId === doctor.jobId && rebuild.index >= doctor.index)
    problems.push("db-rebuild-doctor-order");
  if (doctor && test && doctor.jobId === test.jobId && doctor.index >= test.index)
    problems.push("doctor-test-order");
  if (test && summary && test.jobId === summary.jobId && test.index >= summary.index)
    problems.push("test-summary-order");
  if (doctor && test) {
    const resultFile = doctor.step.env?.UT_TDD_DOCTOR_RESULT_FILE;
    if (doctor.jobId !== test.jobId) problems.push("doctor-test-job");
    if (!resultFile || resultFile !== test.step.env?.UT_TDD_DOCTOR_RESULT_FILE)
      problems.push("doctor-test-result-file");
    if (!doctor.step.run?.includes("$UT_TDD_DOCTOR_RESULT_FILE"))
      problems.push("doctor-result-file-not-consumed");
  }
  return problems;
}

export function mutationFixtures() {
  const removed = [
    removeStep(cloneWorkflow(), "privacy scan (email の形、fail-close)"),
    removeStep(cloneWorkflow(), "lint (biome)"),
    removeStep(cloneWorkflow(), "doctor (governance hard gates)"),
    removeStep(cloneWorkflow(), "audit quality (gate findings)"),
  ];
  const condition = [
    changeCondition(
      cloneWorkflow(),
      "typecheck (tsc --noEmit)",
      "$" + "{{ needs.classify.outputs.lane == 'doc' }}",
    ),
    changeCondition(
      cloneWorkflow(),
      "design-protection (実装 PR の設計書書き換え拒否、fail-close)",
    ),
  ];
  const duplicateLint = duplicateStep(
    cloneWorkflow(),
    "lint (biome)",
    "harness-check-pr-discipline",
  );
  const inputs = [
    doctorEnvMutation(cloneWorkflow()),
    vitestEnvMutation(cloneWorkflow()),
    auditCommandMutation(cloneWorkflow()),
  ];
  const duplicateClassify = duplicateStep(
    cloneWorkflow(),
    "classify changed files (doc lane vs full, fail-close)",
    "harness-check-static",
  );
  const movedDoctor = moveStep(
    cloneWorkflow(),
    "doctor (governance hard gates)",
    "harness-check-static",
  );
  return { removed, condition, duplicateLint, inputs, duplicateClassify, movedDoctor };
}

export const mutations = mutationFixtures();
