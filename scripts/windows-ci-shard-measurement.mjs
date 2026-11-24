import "../src/runtime/windows-hide.ts";
import { execFileSync } from "node:child_process";
import {
  admitWindowsShardMeasurement,
  parseMeasurementTimestamp,
  WINDOWS_SHARD_MEASUREMENT_BEFORE_RUNS,
  WINDOWS_SHARD_MEASUREMENT_REGRESSION_STEP as REGRESSION,
} from "../src/github/windows-ci-shard-measurement.ts";
import { readWindowsRegressionSnapshotSource } from "../src/github/windows-ci-shard-partition.ts";
import { WINDOWS_SHARD_IDS } from "../src/lint/windows-ci-shard-admission.ts";

const REQUIRED_CHECK = "harness-check";
const SHA = /^[a-f0-9]{40}$/;
const ID = /^[1-9][0-9]*$/;
const INVALID = "measurement_evidence_invalid";
const MISMATCH = "measurement_binding_mismatch";
const UNSUCCESSFUL = "measurement_not_successful";

class EvidenceError extends Error {
  constructor(message, reason = INVALID) {
    super(message);
    this.reason = reason;
  }
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
    throw new EvidenceError("cannot determine GitHub repository");
  }
  const read = (endpoint) => gh(["api", `repos/${repo}/${endpoint}`]);
  return { repo, read, json: (endpoint) => JSON.parse(read(endpoint)) };
}

function parseArgs(argv) {
  const [prFlag, pr, headFlag, head] = argv;
  if (
    argv.length !== 4 ||
    prFlag !== "--pr" ||
    !ID.test(pr) ||
    !Number.isSafeInteger(Number(pr)) ||
    headFlag !== "--head" ||
    !SHA.test(head)
  ) {
    throw new EvidenceError("usage: node scripts/windows-ci-shard-measurement.mjs --pr <n> --head <sha>");
  }
  return { pr: Number(pr), head };
}

function requiredCheck(api, head) {
  const { check_runs: checks, total_count: totalCount } = api.json(
    `commits/${head}/check-runs?check_name=${REQUIRED_CHECK}&filter=all&per_page=100`,
  );
  if (!Array.isArray(checks) || checks.length !== totalCount) {
    throw new EvidenceError("incomplete PR head check list");
  }
  const candidates = checks.filter(
    (check) => check.name === REQUIRED_CHECK && check.app?.slug === "github-actions",
  );
  const accepted = candidates.filter(
    (check) => check.status === "completed" && check.conclusion === "success",
  );
  if (accepted.length === 0 && candidates.length > 0) {
    throw new EvidenceError("no successful required check", UNSUCCESSFUL);
  }
  if (accepted.length !== 1) throw new EvidenceError("missing or ambiguous successful required check");
  const [check] = accepted;
  const url = new URL(check.details_url);
  const [owner, repo, actions, runs, runId, job, jobId, ...tail] = url.pathname.slice(1).split("/");
  if (
    url.origin !== "https://github.com" ||
    `${owner}/${repo}`.toLowerCase() !== api.repo.toLowerCase() ||
    actions !== "actions" ||
    runs !== "runs" ||
    job !== "job" ||
    !ID.test(runId) ||
    !ID.test(jobId) ||
    tail.length > 0
  ) {
    throw new EvidenceError("required check points to a different or unknown Actions job", MISMATCH);
  }
  return {
    id: String(check.id),
    name: check.name,
    app: check.app.slug,
    conclusion: check.conclusion,
    headSha: check.head_sha,
    runId,
    jobId,
  };
}

function readAttempt(api, runId, attempt) {
  const endpoint = `actions/runs/${runId}/attempts/${attempt}`;
  const run = api.json(endpoint);
  const { jobs, total_count: totalCount } = api.json(`${endpoint}/jobs?per_page=100`);
  if (!Array.isArray(jobs) || jobs.length !== totalCount) {
    throw new EvidenceError("incomplete attempt job list");
  }
  return {
    run: {
      id: String(run.id),
      attempt: run.run_attempt,
      workflowPath: run.path,
      headSha: run.head_sha,
      conclusion: run.conclusion,
      event: run.event,
      branch: run.head_branch,
    },
    jobs,
  };
}

function onlyMatching(items, predicate, description) {
  const matches = items.filter(predicate);
  if (matches.length !== 1) throw new EvidenceError(`missing or ambiguous ${description}`);
  return matches[0];
}

function jobReceipt(job) {
  return {
    id: String(job.id),
    name: job.name,
    runId: String(job.run_id),
    attempt: job.run_attempt,
    conclusion: job.conclusion,
    headSha: job.head_sha,
  };
}

function stepReceipt(job) {
  const step = onlyMatching(job.steps, (candidate) => candidate.name === REGRESSION, REGRESSION);
  return {
    name: step.name,
    number: step.number,
    conclusion: step.conclusion,
    startedAt: step.started_at,
    completedAt: step.completed_at,
  };
}

function readBefore(api, id) {
  const { run, jobs } = readAttempt(api, id, 1);
  const job = onlyMatching(jobs, (item) => item.name === "harness-check-windows", "before job");
  return { run, job: { ...jobReceipt(job), step: stepReceipt(job) } };
}

function readShard(api, item) {
  const job = jobReceipt(item);
  const step = stepReceipt(item);
  if (job.conclusion !== "success" || step.conclusion !== "success") {
    throw new EvidenceError("Windows job or regression step was unsuccessful", UNSUCCESSFUL);
  }
  if (!ID.test(job.id) || !Number.isSafeInteger(step.number) || step.number < 1) {
    throw new EvidenceError("invalid Windows job or regression step identity");
  }
  const startedAt = parseMeasurementTimestamp(step.startedAt);
  const completedAt = parseMeasurementTimestamp(step.completedAt);
  if (startedAt === null || completedAt === null || completedAt <= startedAt) {
    throw new EvidenceError("invalid Windows regression step time range");
  }
  const log = api.read(`actions/jobs/${job.id}/logs`);
  const snapshotSha = readWindowsRegressionSnapshotSource(log, { startedAt, completedAt });
  return { job, step, log: { jobId: job.id, stepNumber: step.number, snapshotSha } };
}

function readCommit(api, sha) {
  if (!SHA.test(sha)) throw new EvidenceError("invalid Git commit ID");
  const commit = api.json(`commits/${sha}`);
  if (commit.sha !== sha) throw new EvidenceError("Git commit identity differs", MISMATCH);
  return {
    commitSha: commit.sha,
    parentShas: commit.parents.map((parent) => parent.sha),
    treeSha: commit.commit.tree.sha,
  };
}

function readAfter(api, head) {
  const check = requiredCheck(api, head);
  const aggregateJob = jobReceipt(api.json(`actions/jobs/${check.jobId}`));
  if (!Number.isSafeInteger(aggregateJob.attempt) || aggregateJob.attempt < 1) {
    throw new EvidenceError("invalid aggregate attempt number");
  }
  const { run, jobs } = readAttempt(api, check.runId, aggregateJob.attempt);
  const aggregateAttemptJob = jobReceipt(
    onlyMatching(jobs, (item) => String(item.id) === check.jobId, "aggregate attempt job"),
  );
  const shards = jobs.filter((item) => item.name?.startsWith("harness-check-windows ("));
  if (shards.length !== WINDOWS_SHARD_IDS.length) throw new EvidenceError("unexpected Windows job set");
  const windowsJobs = WINDOWS_SHARD_IDS.map((id) => {
    const name = `harness-check-windows (${id})`;
    return readShard(api, onlyMatching(shards, (item) => item.name === name, name));
  });
  return {
    requiredChecks: [check],
    run,
    aggregateJob,
    aggregateAttemptJob,
    windowsJobs,
    snapshot: readCommit(api, windowsJobs[0].log.snapshotSha),
  };
}

function measure(argv) {
  const { pr, head } = parseArgs(argv);
  const api = evidenceApi();
  const pull = () => {
    const value = api.json(`pulls/${pr}`);
    if (value.number !== pr || value.head?.sha !== head) {
      throw new EvidenceError("PR number or head differs from the requested subject", MISMATCH);
    }
    return value.head.sha;
  };
  const headBeforeSha = pull();
  const { treeSha } = readCommit(api, head);
  const before = WINDOWS_SHARD_MEASUREMENT_BEFORE_RUNS.map(({ id }) => readBefore(api, id));
  const after = readAfter(api, head);
  const headAfterSha = pull();
  return admitWindowsShardMeasurement({
    subject: { pr, requestedHeadSha: head, headBeforeSha, headAfterSha, treeSha },
    before,
    after,
  });
}

let result;
try {
  result = measure(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  result = { ok: false, error: error instanceof EvidenceError ? error.reason : INVALID };
}
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.ok ? 0 : 1;
