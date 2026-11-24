import "../src/runtime/windows-hide.ts";
import { execFileSync } from "node:child_process";
import {
  admitWindowsShardPartition,
  expectedWindowsShardFiles,
  readWindowsShardSnapshot,
} from "../src/github/windows-ci-shard-partition.ts";
import { WINDOWS_SHARD_IDS } from "../src/lint/windows-ci-shard-admission.ts";

const WINDOWS_JOB_PREFIX = "harness-check-windows";
const REGRESSION_STEP = "test — Windows full 回帰 (vitest run, windows leg)";
const WORKFLOW = ".github/workflows/harness-check.yml";
const SHA = /^[a-f0-9]{40}$/;

function numberArgument(value) {
  const number = Number(value);
  if (!/^[1-9][0-9]*$/.test(value ?? "") || !Number.isSafeInteger(number)) {
    throw new Error("expected a positive integer for run and attempt");
  }
  return number;
}

function argumentsForEvidence(argv) {
  if (argv.length !== 4 || argv[0] !== "--run" || argv[2] !== "--attempt") {
    throw new Error("usage: node scripts/windows-ci-shard-partition.mjs --run <id> --attempt <n>");
  }
  return { run: numberArgument(argv[1]), attempt: numberArgument(argv[3]) };
}

function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function evidenceApi() {
  const repo = JSON.parse(gh(["repo", "view", "--json", "nameWithOwner"])).nameWithOwner;
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error("cannot determine the GitHub repository");
  }
  const read = (endpoint) => gh(["api", `repos/${repo}/${endpoint}`]);
  return { read, json: (endpoint) => JSON.parse(read(endpoint)) };
}

function readWindowsJobs(api, { run, attempt }) {
  const endpoint = `actions/runs/${run}/attempts/${attempt}`;
  const workflow = api.json(endpoint);
  if (
    workflow.id !== run ||
    workflow.run_attempt !== attempt ||
    workflow.path !== WORKFLOW ||
    workflow.status !== "completed" ||
    !SHA.test(workflow.head_sha)
  ) {
    throw new Error("cannot bind the harness-check workflow attempt");
  }
  const { jobs, total_count: totalCount } = api.json(`${endpoint}/jobs?per_page=100`);
  if (!Array.isArray(jobs) || jobs.length !== totalCount) throw new Error("incomplete job list");
  const windows = jobs.filter((job) => job.name?.startsWith(`${WINDOWS_JOB_PREFIX} (`));
  if (windows.length !== WINDOWS_SHARD_IDS.length) throw new Error("unexpected Windows job set");
  return { windows, workflowHead: workflow.head_sha };
}

function loadSelection(api, job, shard, binding) {
  if (
    job.conclusion !== "success" ||
    job.status !== "completed" ||
    job.run_id !== binding.run ||
    job.run_attempt !== binding.attempt ||
    job.head_sha !== binding.workflowHead
  ) {
    throw new Error(`unbound or unsuccessful Windows job ${shard}`);
  }
  const steps = job.steps.filter((step) => step.name === REGRESSION_STEP);
  if (
    steps.length !== 1 ||
    steps[0].conclusion !== "success" ||
    !Number.isSafeInteger(steps[0].number) ||
    steps[0].number < 1
  ) {
    throw new Error(`missing successful Windows full regression step ${shard}`);
  }
  const [step] = steps;
  const log = api.read(`actions/jobs/${numberArgument(String(job.id))}/logs`);
  return {
    shard,
    ...readWindowsShardSnapshot(log, {
      startedAt: Date.parse(step.started_at),
      completedAt: Date.parse(step.completed_at),
    }),
  };
}

function readSnapshotBlobs(api, snapshot, workflowHead) {
  const commit = api.json(`commits/${snapshot}`);
  if (
    commit.sha !== snapshot ||
    (snapshot !== workflowHead && !commit.parents.some((parent) => parent.sha === workflowHead))
  ) {
    throw new Error("Windows snapshot is not bound to the workflow head");
  }
  const treeSha = commit.commit.tree.sha;
  if (!SHA.test(treeSha)) throw new Error("missing snapshot tree");
  const { tree, truncated, sha } = api.json(`git/trees/${treeSha}?recursive=1`);
  if (truncated || sha !== treeSha || !Array.isArray(tree))
    throw new Error("incomplete snapshot tree");
  return tree.filter((entry) => entry.type === "blob");
}

function expectedFiles(api, snapshot, workflowHead) {
  const tracked = readSnapshotBlobs(api, snapshot, workflowHead);
  const packageFile = tracked.find((entry) => entry.path === "package.json");
  if (!SHA.test(packageFile?.sha)) throw new Error("missing snapshot package.json");
  const blob = api.json(`git/blobs/${packageFile.sha}`);
  if (blob.sha !== packageFile.sha || blob.encoding !== "base64")
    throw new Error("unbound package.json");
  const { scripts } = JSON.parse(Buffer.from(blob.content, "base64").toString("utf8"));
  return expectedWindowsShardFiles(
    tracked.map((entry) => entry.path),
    scripts["test:fast"],
    scripts["test:cli"],
  );
}

function runPartitionCheck(argv) {
  const { run, attempt } = argumentsForEvidence(argv);
  const api = evidenceApi();
  const { windows, workflowHead } = readWindowsJobs(api, { run, attempt });
  const selections = WINDOWS_SHARD_IDS.map((shard) => {
    const matches = windows.filter((job) => job.name === `${WINDOWS_JOB_PREFIX} (${shard})`);
    if (matches.length !== 1) throw new Error(`missing or duplicate Windows job ${shard}`);
    return loadSelection(api, matches[0], shard, { run, attempt, workflowHead });
  });
  const source = selections[0].source;
  if (selections.some((selection) => selection.source !== source))
    throw new Error("Windows snapshots differ");
  return admitWindowsShardPartition(expectedFiles(api, source, workflowHead), selections);
}

if (import.meta.main) {
  try {
    const result = runPartitionCheck(process.argv.slice(2));
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    console.log(
      JSON.stringify({ ok: false, missing: [], unexpected: [], duplicates: [], invalidShards: [] }),
    );
    process.exitCode = 1;
  }
}
