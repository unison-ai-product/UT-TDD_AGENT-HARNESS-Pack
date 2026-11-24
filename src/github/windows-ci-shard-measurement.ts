const SHA = /^[a-f0-9]{40}$/;
const ID = /^[1-9][0-9]*$/;

export const WINDOWS_SHARD_MEASUREMENT_BEFORE_RUNS = [
  { id: "38694546173", jobId: "116290692263", headSha: "e2b68cd23c2ae86e9274abc113a9f02d4e6f63cf" },
  { id: "38692344625", jobId: "116282306585", headSha: "f89fd2bc7495ddb76340d2f4be2e9ad178b75271" },
  { id: "38690207164", jobId: "116274110324", headSha: "8f03e27caafdb2bdd8662030f3eef9940c0a8997" },
] as const;
export const WINDOWS_SHARD_MEASUREMENT_WORKFLOW_PATH = ".github/workflows/harness-check.yml";
export const WINDOWS_SHARD_MEASUREMENT_REGRESSION_STEP =
  "test — Windows full 回帰 (vitest run, windows leg)";

export function parseMeasurementTimestamp(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

interface MeasurementRun {
  id: string;
  attempt: number;
  workflowPath: string;
  conclusion: string;
  headSha: string;
}

interface MeasurementJob {
  id: string;
  name: string;
  runId: string;
  attempt: number;
  conclusion: string;
  headSha: string;
}

interface RegressionStep {
  number: number;
  name: string;
  conclusion: string;
  startedAt: string;
  completedAt: string;
}

export interface WindowsShardMeasurementInput {
  subject: {
    pr: number;
    requestedHeadSha: string;
    headBeforeSha: string;
    headAfterSha: string;
    treeSha: string;
  };
  before: Array<{
    run: MeasurementRun & { event: string; branch: string };
    job: MeasurementJob & { step: RegressionStep };
  }>;
  after: {
    requiredChecks: Array<{
      id: string;
      name: string;
      app: string;
      conclusion: string;
      headSha: string;
      runId: string;
      jobId: string;
    }>;
    run: MeasurementRun;
    aggregateJob: MeasurementJob;
    aggregateAttemptJob: MeasurementJob;
    windowsJobs: Array<{
      job: MeasurementJob;
      step: RegressionStep;
      log: { jobId: string; stepNumber: number; snapshotSha: string };
    }>;
    snapshot: { commitSha: string; parentShas: string[]; treeSha: string };
  };
}

export type WindowsShardMeasurementFailure =
  | "measurement_evidence_invalid"
  | "measurement_binding_mismatch"
  | "measurement_not_successful";

export type WindowsShardMeasurementResult =
  | {
      ok: true;
      beforeSeconds: number[];
      beforeMedianSeconds: number;
      afterElapsedSeconds: number;
      shardSeconds: number[];
    }
  | { ok: false; error: WindowsShardMeasurementFailure };

const INVALID = { ok: false, error: "measurement_evidence_invalid" } as const;
const MISMATCH = { ok: false, error: "measurement_binding_mismatch" } as const;
const UNSUCCESSFUL = { ok: false, error: "measurement_not_successful" } as const;

function validId(value: string): boolean {
  return ID.test(value);
}

function validSha(value: string): boolean {
  return SHA.test(value);
}

function stepDuration(step: RegressionStep): number | null {
  const started = parseMeasurementTimestamp(step.startedAt);
  const completed = parseMeasurementTimestamp(step.completedAt);
  if (started === null || completed === null || completed <= started) return null;
  return (completed - started) / 1000;
}

type RejectedMeasurement = Extract<WindowsShardMeasurementResult, { ok: false }>;

function measureBefore(
  before: WindowsShardMeasurementInput["before"],
): number[] | RejectedMeasurement {
  const beforeSeconds: number[] = [];
  for (const [index, expected] of WINDOWS_SHARD_MEASUREMENT_BEFORE_RUNS.entries()) {
    const evidence = before[index];
    if (!evidence) return INVALID;
    const { run, job } = evidence;
    if (
      !validId(run.id) ||
      !validId(job.id) ||
      !validId(job.runId) ||
      !Number.isSafeInteger(run.attempt) ||
      !Number.isSafeInteger(job.attempt)
    ) {
      return INVALID;
    }
    if (
      run.id !== expected.id ||
      run.attempt !== 1 ||
      run.workflowPath !== WINDOWS_SHARD_MEASUREMENT_WORKFLOW_PATH ||
      run.event !== "push" ||
      run.branch !== "main" ||
      run.headSha !== expected.headSha ||
      job.id !== expected.jobId ||
      job.name !== "harness-check-windows" ||
      job.runId !== run.id ||
      job.attempt !== run.attempt ||
      job.headSha !== run.headSha ||
      job.step.name !== WINDOWS_SHARD_MEASUREMENT_REGRESSION_STEP ||
      job.step.number !== 8
    ) {
      return MISMATCH;
    }
    const seconds = stepDuration(job.step);
    if (seconds === null) return INVALID;
    beforeSeconds.push(seconds);
  }
  return beforeSeconds;
}

function checkAggregateBinding(
  after: WindowsShardMeasurementInput["after"],
  requestedHeadSha: string,
): RejectedMeasurement | null {
  const [check] = after.requiredChecks;
  const { run, aggregateJob, aggregateAttemptJob, snapshot } = after;
  if (
    !validId(check.id) ||
    !validId(check.runId) ||
    !validId(check.jobId) ||
    !validId(run.id) ||
    !validId(aggregateJob.id) ||
    !validId(aggregateJob.runId) ||
    !validId(aggregateAttemptJob.id) ||
    !validId(aggregateAttemptJob.runId) ||
    !validSha(snapshot.commitSha) ||
    !validSha(snapshot.treeSha) ||
    snapshot.parentShas.some((sha) => !validSha(sha))
  ) {
    return INVALID;
  }
  if (
    check.name !== "harness-check" ||
    check.app !== "github-actions" ||
    check.headSha !== requestedHeadSha ||
    check.runId !== run.id ||
    check.id !== check.jobId ||
    check.jobId !== aggregateJob.id ||
    run.workflowPath !== WINDOWS_SHARD_MEASUREMENT_WORKFLOW_PATH ||
    run.headSha !== requestedHeadSha ||
    aggregateJob.name !== "harness-check" ||
    aggregateJob.runId !== run.id ||
    aggregateJob.headSha !== run.headSha ||
    aggregateAttemptJob.id !== aggregateJob.id ||
    aggregateAttemptJob.name !== aggregateJob.name ||
    aggregateAttemptJob.runId !== run.id ||
    aggregateAttemptJob.attempt !== aggregateJob.attempt ||
    aggregateAttemptJob.headSha !== run.headSha ||
    !Number.isSafeInteger(run.attempt) ||
    run.attempt < 1 ||
    !Number.isSafeInteger(aggregateJob.attempt) ||
    aggregateJob.attempt !== run.attempt
  ) {
    return MISMATCH;
  }
  return null;
}

export function admitWindowsShardMeasurement(
  input: WindowsShardMeasurementInput,
): WindowsShardMeasurementResult {
  const { subject, before, after } = input;
  if (
    !subject ||
    !after?.snapshot ||
    !Number.isSafeInteger(subject.pr) ||
    subject.pr < 1 ||
    !validSha(subject.requestedHeadSha) ||
    !validSha(subject.headBeforeSha) ||
    !validSha(subject.headAfterSha) ||
    !validSha(subject.treeSha) ||
    !Array.isArray(before) ||
    before.length !== WINDOWS_SHARD_MEASUREMENT_BEFORE_RUNS.length ||
    !Array.isArray(after.requiredChecks) ||
    after.requiredChecks.length !== 1 ||
    !Array.isArray(after.windowsJobs) ||
    after.windowsJobs.length !== 3 ||
    !Array.isArray(after.snapshot.parentShas)
  ) {
    return INVALID;
  }
  if (
    subject.requestedHeadSha !== subject.headBeforeSha ||
    subject.requestedHeadSha !== subject.headAfterSha
  ) {
    return MISMATCH;
  }

  const beforeSeconds = measureBefore(before);
  if (!Array.isArray(beforeSeconds)) return beforeSeconds;

  const aggregateError = checkAggregateBinding(after, subject.requestedHeadSha);
  if (aggregateError) return aggregateError;
  const [check] = after.requiredChecks;
  const { run, aggregateJob, aggregateAttemptJob, windowsJobs, snapshot } = after;

  const shardSeconds: number[] = [];
  let earliestStart = Infinity;
  let latestEnd = -Infinity;
  const seenJobs = new Set<string>();
  const sortedJobs = [...windowsJobs].sort((left, right) =>
    left.job.name.localeCompare(right.job.name),
  );
  const expectedNames = [1, 2, 3].map((shard) => `harness-check-windows (${shard}/3)`);
  for (const [index, { job, step, log }] of sortedJobs.entries()) {
    if (!validId(job.id) || !validId(job.runId) || !Number.isSafeInteger(job.attempt))
      return INVALID;
    if (
      job.name !== expectedNames[index] ||
      seenJobs.has(job.id) ||
      job.runId !== run.id ||
      job.attempt !== run.attempt ||
      job.headSha !== run.headSha ||
      step.name !== WINDOWS_SHARD_MEASUREMENT_REGRESSION_STEP ||
      !Number.isSafeInteger(step.number) ||
      step.number < 1 ||
      step.number !== log.stepNumber ||
      log.jobId !== job.id ||
      log.snapshotSha !== snapshot.commitSha
    ) {
      return MISMATCH;
    }
    seenJobs.add(job.id);
    const start = parseMeasurementTimestamp(step.startedAt);
    const end = parseMeasurementTimestamp(step.completedAt);
    if (start === null || end === null || end <= start) return INVALID;
    earliestStart = Math.min(earliestStart, start);
    latestEnd = Math.max(latestEnd, end);
    shardSeconds.push((end - start) / 1000);
  }
  if (snapshot.treeSha !== subject.treeSha) return MISMATCH;
  if (
    snapshot.commitSha !== subject.requestedHeadSha &&
    (snapshot.parentShas.length < 2 || !snapshot.parentShas.includes(subject.requestedHeadSha))
  ) {
    return MISMATCH;
  }

  if (
    before.some(
      ({ run: itemRun, job }) =>
        itemRun.conclusion !== "success" ||
        job.conclusion !== "success" ||
        job.step.conclusion !== "success",
    ) ||
    check.conclusion !== "success" ||
    run.conclusion !== "success" ||
    aggregateJob.conclusion !== "success" ||
    aggregateAttemptJob.conclusion !== "success" ||
    windowsJobs.some(
      ({ job, step }) => job.conclusion !== "success" || step.conclusion !== "success",
    )
  ) {
    return UNSUCCESSFUL;
  }

  const orderedBefore = [...beforeSeconds].sort((a, b) => a - b);
  const beforeMedianSeconds = orderedBefore[1];
  return {
    ok: true,
    beforeSeconds,
    beforeMedianSeconds,
    afterElapsedSeconds: (latestEnd - earliestStart) / 1000,
    shardSeconds,
  };
}
