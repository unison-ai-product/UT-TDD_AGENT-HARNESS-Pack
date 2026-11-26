import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  cloneWorkflow,
  expectedAggregateNeeds,
  expectedJobByStep,
  findNamedStep,
  linuxJobs,
  type Workflow,
  workflow,
} from "./ci-job-split-fixture.ts";
import { workspaceRead } from "./workspace-roots.ts";

export type ShellResult = { error?: Error; status: number | null; stdout: string; stderr: string };
const AGGREGATE_ALWAYS = "$" + "{{ always() }}";

function aggregateNeeds(parsed: Workflow): string[] {
  const needs = parsed.jobs["harness-check"]?.needs;
  if (Array.isArray(needs)) return needs;
  if (typeof needs === "string") return [needs];
  throw new Error("aggregate needs precondition is missing");
}

function aggregateRun(parsed: Workflow): string {
  const step = parsed.jobs["harness-check"]?.steps?.find(
    (item) => item.name === "require harness and Node generation success",
  );
  if (typeof step?.run !== "string") throw new Error("aggregate result step missing");
  return step.run;
}

const bashExecutable = (() => {
  if (process.platform !== "win32") return "bash";
  const execPath = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
  const root = resolve(execPath, "..", "..", "..");
  const bash = [join(root, "bin", "bash.exe"), join(root, "usr", "bin", "bash.exe")].find(
    existsSync,
  );
  if (!bash) throw new Error(`Git for Windows bash.exe was not found from ${execPath}`);
  return bash;
})();
const bashPreflight = spawnSync(
  bashExecutable,
  ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", "exit 0"],
  { cwd: tmpdir(), encoding: "utf8" },
);
if (bashPreflight.error || bashPreflight.status !== 0)
  throw new Error(
    `aggregate bash preflight failed: ${bashPreflight.error ?? bashPreflight.stderr}`,
  );

export function runAggregateGate(
  parsed: Workflow,
  results: Record<string, string>,
  lane: string,
): ShellResult {
  const bind = (value: unknown): string => {
    if (typeof value !== "string") return String(value ?? "");
    const bound = value.replace(
      /\$\{\{\s*(needs\.([a-z0-9-]+)\.result|needs\.classify\.outputs\.lane)\s*\}\}/g,
      (_expression, reference: string, jobId: string | undefined) => {
        if (reference === "needs.classify.outputs.lane") return lane;
        if (!jobId || !(jobId in results))
          throw new Error(`aggregate fixture missing result: ${jobId}`);
        const result = results[jobId];
        if (result === undefined) throw new Error(`aggregate fixture missing result: ${jobId}`);
        return result;
      },
    );
    if (/\$\{\{/.test(bound))
      throw new Error(`aggregate fixture has an unbound expression: ${value}`);
    return bound;
  };
  const aggregate = parsed.jobs["harness-check"];
  if (!aggregate) throw new Error("aggregate job is missing");
  const step = aggregate.steps?.find(
    (item) => item.name === "require harness and Node generation success",
  );
  if (!step || typeof step.run !== "string") throw new Error("aggregate result step missing");
  const env = Object.fromEntries(
    Object.entries({ ...parsed.env, ...aggregate.env, ...step.env }).map(([key, value]) => [
      key,
      bind(value),
    ]),
  );
  const result = spawnSync(
    bashExecutable,
    ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", bind(aggregateRun(parsed))],
    { cwd: tmpdir(), encoding: "utf8", env: { ...process.env, ...env } },
  );
  return {
    error: result.error,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function aggregateStructureViolations(parsed: Workflow): string[] {
  const problems: string[] = [];
  const job = parsed.jobs["harness-check"];
  if (!job) return ["aggregate-job-id"];
  if (job.if !== AGGREGATE_ALWAYS) problems.push("aggregate-always");
  const needs = Array.isArray(job.needs)
    ? job.needs
    : typeof job.needs === "string"
      ? [job.needs]
      : [];
  if (JSON.stringify([...needs].sort()) !== JSON.stringify([...expectedAggregateNeeds].sort()))
    problems.push("aggregate-needs");
  return problems;
}

function aggregateContractFixture(parsed: Workflow): Workflow {
  const aggregate = parsed.jobs["harness-check"];
  if (!aggregate) throw new Error("aggregate fixture precondition is missing");
  aggregate.if = AGGREGATE_ALWAYS;
  aggregate.needs = [...expectedAggregateNeeds];
  return parsed;
}

function aggregateWithoutAlways(parsed: Workflow): Workflow {
  const job = parsed.jobs["harness-check"];
  if (!job?.if) throw new Error("mutation precondition: aggregate if missing");
  delete job.if;
  return parsed;
}

function aggregateWithoutNeed(parsed: Workflow): Workflow {
  const needs = parsed.jobs["harness-check"]?.needs;
  if (!Array.isArray(needs) || !needs.includes("harness-check-linux"))
    throw new Error("mutation precondition: aggregate harness-check-linux need missing");
  const aggregate = parsed.jobs["harness-check"];
  if (!aggregate) throw new Error("mutation precondition: aggregate job missing");
  aggregate.needs = needs.filter((jobId) => jobId !== "harness-check-linux");
  return parsed;
}

function renameAggregate(parsed: Workflow): Workflow {
  const job = parsed.jobs["harness-check"];
  if (!job) throw new Error("mutation precondition: aggregate job missing");
  delete parsed.jobs["harness-check"];
  parsed.jobs["harness-check-final"] = job;
  return parsed;
}

function addContinueOnError(
  parsed: Workflow,
  kind: "job" | "step",
  target: string,
  value: unknown,
): Workflow {
  if (kind === "job") {
    let job = parsed.jobs[target];
    if (!job) {
      job = { "runs-on": "ubuntu-latest", steps: [] };
      parsed.jobs[target] = job;
    }
    job["continue-on-error"] = value;
  } else findNamedStep(parsed, target).step["continue-on-error"] = value;
  return parsed;
}

export function continueOnErrorViolations(parsed: Workflow): string[] {
  const problems: string[] = [];
  for (const [jobId, job] of Object.entries(parsed.jobs)) {
    if (job["continue-on-error"] !== undefined && job["continue-on-error"] !== false)
      problems.push(`job:${jobId}`);
  }
  for (const [jobId, job] of linuxJobs(parsed)) {
    for (const step of job.steps ?? []) {
      if (!step.name || !Object.hasOwn(expectedJobByStep, step.name)) continue;
      if (step["continue-on-error"] !== undefined && step["continue-on-error"] !== false)
        problems.push(`step:${jobId}:${step.name}`);
    }
  }
  return problems;
}

export function aggregateMutationFixtures() {
  return [
    aggregateWithoutAlways(aggregateContractFixture(cloneWorkflow())),
    aggregateWithoutNeed(aggregateContractFixture(cloneWorkflow())),
    renameAggregate(aggregateContractFixture(cloneWorkflow())),
  ];
}

export function continueOnErrorMutationFixtures() {
  const mutations = [
    addContinueOnError(cloneWorkflow(), "step", "lint (biome)", true),
    addContinueOnError(
      cloneWorkflow(),
      "step",
      "branch-type guard (commitlint / poc / hotfix)",
      true,
    ),
    addContinueOnError(cloneWorkflow(), "job", "harness-check-static", true),
    addContinueOnError(cloneWorkflow(), "job", "harness-check-linux", true),
    addContinueOnError(cloneWorkflow(), "job", "harness-check-pr-discipline", true),
  ];
  const explicitFalse = addContinueOnError(
    addContinueOnError(cloneWorkflow(), "job", "harness-check-linux", false),
    "step",
    "lint (biome)",
    false,
  );
  return { mutations, explicitFalse };
}

export const aggregateMutations = aggregateMutationFixtures();
export const continueOnErrorMutations = continueOnErrorMutationFixtures();
export const githubTrackedPreflight = execFileSync("git", ["--version"], {
  encoding: "utf8",
}).trim();
const repoRoot = workspaceRead({
  id: "ci-job-split-tracked-github-files",
  mode: "head_snapshot",
  reason: "aggregate oracle checks tracked GitHub workflow files from the immutable exact HEAD",
});
export const trackedGithubFiles = execFileSync("git", ["ls-files", ".github"], {
  cwd: repoRoot,
  encoding: "utf8",
})
  .split(/\r?\n/)
  .filter(Boolean);

const aggregatePreflight = runAggregateGate(
  workflow,
  Object.fromEntries(aggregateNeeds(workflow).map((jobId) => [jobId, "success"])),
  "full",
);
if (aggregatePreflight.error || aggregatePreflight.status !== 0)
  throw new Error(
    `current aggregate fixture failed: ${aggregatePreflight.error ?? aggregatePreflight.stderr}`,
  );
