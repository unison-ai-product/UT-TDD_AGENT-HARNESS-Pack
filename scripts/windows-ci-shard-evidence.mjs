import "../src/runtime/windows-hide.ts";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { WINDOWS_SHARD_IDS } from "../src/lint/windows-ci-shard-admission.ts";

const REPORT_NAME = "windows-vitest-report.json";
const ASSERTION_STATES = new Set(["passed", "failed", "pending", "skipped", "todo"]);
const SHARD_RESULTS = new Set(["success", "failure", "cancelled", "skipped"]);

export class WindowsCiEvidenceError extends Error {
  constructor(reason, affected = []) {
    super(reason);
    this.reason = reason;
    this.affected = affected;
  }
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readWindowsCiBinding(env = process.env) {
  const runId = env.GITHUB_RUN_ID;
  const runAttempt = Number(env.GITHUB_RUN_ATTEMPT);
  const workflowSha = env.GITHUB_SHA;
  if (
    !runId ||
    !Number.isSafeInteger(runAttempt) ||
    runAttempt < 1 ||
    !/^[a-f0-9]{40}$/.test(workflowSha ?? "")
  ) {
    throw new WindowsCiEvidenceError("malformed_evidence");
  }
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (headSha !== workflowSha) throw new WindowsCiEvidenceError("attempt_binding_mismatch");
  return { run_id: runId, run_attempt: runAttempt, head_sha: headSha };
}

function countWindowsTestFiles(report) {
  if (!isObject(report) || !Array.isArray(report.testResults)) {
    throw new WindowsCiEvidenceError("malformed_evidence");
  }
  const executed = new Set();
  for (const file of report.testResults) {
    if (
      !isObject(file) ||
      typeof file.name !== "string" ||
      file.name.trim().length === 0 ||
      !Array.isArray(file.assertionResults)
    ) {
      throw new WindowsCiEvidenceError("malformed_evidence");
    }
    const statuses = file.assertionResults.map((assertion) => {
      if (!isObject(assertion) || !ASSERTION_STATES.has(assertion.status)) {
        throw new WindowsCiEvidenceError("malformed_evidence");
      }
      return assertion.status;
    });
    if (statuses.some((status) => status === "passed" || status === "failed")) {
      executed.add(file.name);
    }
  }
  return executed.size;
}

function readEvidenceInput(env) {
  const directory = env.RUNNER_TEMP;
  const output = env.GITHUB_OUTPUT;
  const legOrShard = env.WINDOWS_CI_EVIDENCE_LEG;
  const hasShard = WINDOWS_SHARD_IDS.includes(legOrShard);
  if (
    !directory ||
    !isAbsolute(directory) ||
    !output ||
    !isAbsolute(output) ||
    (!hasShard && legOrShard !== "linux")
  ) {
    throw new WindowsCiEvidenceError("malformed_evidence");
  }
  const binding = readWindowsCiBinding(env);
  return { directory, output, legOrShard, hasShard, binding };
}

function writeLaneEvidence({ directory, output, legOrShard, hasShard, binding }, lane) {
  const leg = hasShard ? "windows-" + legOrShard[0] : "linux";
  if (lane !== "full" && lane !== "doc")
    throw new WindowsCiEvidenceError("malformed_evidence", [leg]);
  writeFileSync(
    join(directory, "lane-evidence.json"),
    JSON.stringify({ ...binding, leg, lane }) + "\n",
    { flag: "wx" },
  );
  appendFileSync(output, "leg=" + leg + "\n");
}

function writeShardEvidence({ directory, output, legOrShard, hasShard, binding }, result) {
  if (!hasShard || !SHARD_RESULTS.has(result)) {
    throw new WindowsCiEvidenceError("malformed_evidence");
  }
  const report = JSON.parse(readFileSync(join(directory, REPORT_NAME), "utf8"));
  const evidence = {
    ...binding,
    shard: legOrShard,
    result,
    file_count: countWindowsTestFiles(report),
  };
  writeFileSync(join(directory, "shard-evidence.json"), JSON.stringify(evidence) + "\n", {
    flag: "wx",
  });
  appendFileSync(output, "index=" + legOrShard[0] + "\n");
}

if (import.meta.main) {
  const kind = process.argv[2];
  const input = readEvidenceInput(process.env);
  if (kind === "lane") {
    writeLaneEvidence(input, process.env.WINDOWS_CI_LANE);
  } else if (kind === "shard") {
    writeShardEvidence(input, process.env.WINDOWS_CI_SHARD_RESULT);
  } else {
    throw new WindowsCiEvidenceError("malformed_evidence");
  }
}
