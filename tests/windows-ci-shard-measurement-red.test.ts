import { describe, expect, it } from "vitest";
import {
  admitWindowsShardMeasurement,
  parseMeasurementTimestamp,
  type WindowsShardMeasurementFailure,
  type WindowsShardMeasurementInput,
} from "../src/github/windows-ci-shard-measurement.ts";

const WORKFLOW = ".github/workflows/harness-check.yml";
const REGRESSION = "test — Windows full 回帰 (vitest run, windows leg)";
const HEAD = "9d150ab26cd66c3fed98bb76d9c4ebebf6cab390";
const TREE = "54cfe9736ed48b04306c4a7508187999adeef9b9";
const SNAPSHOT = "c008e3370c3a08b957260080e4f83f536103500b";
const BASE = "df51dd6e232121a79f8c2875ae8513655619ce62";

// GitHub Actions API values for the run receipts cited in #1063 comment 7007092325.
const beforeReceipts = [
  [
    "38694546173",
    "116290692263",
    "e2b68cd23c2ae86e9274abc113a9f02d4e6f63cf",
    "2026-10-15T06:57:11Z",
    "2026-10-15T07:21:24Z",
  ],
  [
    "38692344625",
    "116282306585",
    "f89fd2bc7495ddb76340d2f4be2e9ad178b75271",
    "2026-10-15T06:31:36Z",
    "2026-10-15T06:55:25Z",
  ],
  [
    "38690207164",
    "116274110324",
    "8f03e27caafdb2bdd8662030f3eef9940c0a8997",
    "2026-10-15T06:05:21Z",
    "2026-10-15T06:29:46Z",
  ],
] as const;
const afterReceipts = [
  ["harness-check-windows (1/3)", "135503269875", "2026-11-19T10:40:04Z", "2026-11-19T10:51:06Z"],
  ["harness-check-windows (2/3)", "135503270462", "2026-11-19T10:40:02Z", "2026-11-19T10:47:03Z"],
  ["harness-check-windows (3/3)", "135503269976", "2026-11-19T10:39:53Z", "2026-11-19T10:51:57Z"],
] as const;

function fixture(): WindowsShardMeasurementInput {
  const runId = "44507630599";
  const checkId = "135510073975";
  const aggregate = {
    id: checkId,
    name: "harness-check",
    runId,
    attempt: 1,
    headSha: HEAD,
    conclusion: "success",
  };
  return {
    subject: {
      pr: 1850,
      requestedHeadSha: HEAD,
      headBeforeSha: HEAD,
      headAfterSha: HEAD,
      treeSha: TREE,
    },
    before: beforeReceipts.map(([id, jobId, headSha, startedAt, completedAt]) => ({
      run: {
        id,
        attempt: 1,
        workflowPath: WORKFLOW,
        event: "push",
        branch: "main",
        headSha,
        conclusion: "success",
      },
      job: {
        id: jobId,
        name: "harness-check-windows",
        runId: id,
        attempt: 1,
        headSha,
        conclusion: "success",
        step: { name: REGRESSION, number: 8, startedAt, completedAt, conclusion: "success" },
      },
    })),
    after: {
      requiredChecks: [
        {
          id: checkId,
          name: "harness-check",
          app: "github-actions",
          headSha: HEAD,
          runId,
          jobId: checkId,
          conclusion: "success",
        },
      ],
      run: { id: runId, attempt: 1, workflowPath: WORKFLOW, headSha: HEAD, conclusion: "success" },
      aggregateJob: { ...aggregate },
      aggregateAttemptJob: { ...aggregate },
      windowsJobs: afterReceipts.map(([name, id, startedAt, completedAt]) => ({
        job: { id, name, runId, attempt: 1, headSha: HEAD, conclusion: "success" },
        step: { name: REGRESSION, number: 10, startedAt, completedAt, conclusion: "success" },
        log: { jobId: id, stepNumber: 10, snapshotSha: SNAPSHOT },
      })),
      snapshot: { commitSha: SNAPSHOT, parentShas: [BASE, HEAD], treeSha: TREE },
    },
  };
}

function staggeredFixture() {
  const input = fixture();
  const steps = input.after.windowsJobs.map(({ step }) => step);
  steps[0].startedAt = "2026-11-19T10:39:00Z";
  steps[0].completedAt = "2026-11-19T10:50:02Z";
  steps[2].startedAt = "2026-11-19T10:42:00Z";
  steps[2].completedAt = "2026-11-19T10:51:04Z";
  return input;
}

type Mutation = [label: string, edit: (input: WindowsShardMeasurementInput) => void];

const bindingMismatches: Mutation[] = [
  [
    "a substitute before run",
    (i) => {
      i.before[0].run.id = "38694546174";
    },
  ],
  [
    "the wrong fixed before attempt",
    (i) => {
      i.before[1].run.attempt = 2;
    },
  ],
  [
    "the wrong before workflow",
    (i) => {
      i.before[0].run.workflowPath = ".github/workflows/security.yml";
    },
  ],
  [
    "the wrong before event",
    (i) => {
      i.before[0].run.event = "pull_request";
    },
  ],
  [
    "a before job from another run",
    (i) => {
      i.before[0].job.runId = i.before[1].run.id;
    },
  ],
  [
    "the wrong before step",
    (i) => {
      i.before[0].job.step.number = 9;
    },
  ],
  [
    "a moved PR head",
    (i) => {
      i.subject.headAfterSha = BASE;
    },
  ],
  [
    "a check bound to the wrong head",
    (i) => {
      i.after.requiredChecks[0].headSha = BASE;
    },
  ],
  [
    "a check bound to a different run",
    (i) => {
      i.after.requiredChecks[0].runId = i.before[0].run.id;
    },
  ],
  [
    "a check bound to a different job",
    (i) => {
      i.after.requiredChecks[0].jobId = i.after.windowsJobs[0].job.id;
    },
  ],
  [
    "the wrong after workflow",
    (i) => {
      i.after.run.workflowPath = ".github/workflows/security.yml";
    },
  ],
  [
    "a different aggregate job in the selected attempt",
    (i) => {
      i.after.aggregateAttemptJob.id = i.after.windowsJobs[0].job.id;
    },
  ],
  [
    "an aggregate job from a different attempt",
    (i) => {
      i.after.aggregateJob.attempt = 2;
    },
  ],
  [
    "a Windows job from another run",
    (i) => {
      i.after.windowsJobs[0].job.runId = i.before[0].run.id;
    },
  ],
  [
    "a Windows job from another attempt",
    (i) => {
      i.after.windowsJobs[1].job.attempt = 2;
    },
  ],
  [
    "a duplicate Windows job ID",
    (i) => {
      i.after.windowsJobs[1].job.id = i.after.windowsJobs[0].job.id;
    },
  ],
  [
    "a log from another Windows job",
    (i) => {
      i.after.windowsJobs[2].log.jobId = i.after.windowsJobs[0].job.id;
    },
  ],
  [
    "a log from another step",
    (i) => {
      i.after.windowsJobs[2].log.stepNumber = 9;
    },
  ],
  [
    "a shard that reports another snapshot",
    (i) => {
      i.after.windowsJobs[0].log.snapshotSha = BASE;
    },
  ],
  [
    "a snapshot without the PR head as a parent",
    (i) => {
      i.after.snapshot.parentShas = [BASE, "603f806c80b8daaa907731410e4dacb3e9876c8e"];
    },
  ],
  [
    "a single-parent snapshot different from the PR head",
    (i) => {
      i.after.snapshot.parentShas = [HEAD];
    },
  ],
  [
    "a snapshot with a different tree",
    (i) => {
      i.after.snapshot.treeSha = BASE;
    },
  ],
];

const failedEvidence: Mutation[] = [
  [
    "a failed before run",
    (i) => {
      i.before[0].run.conclusion = "failure";
    },
  ],
  [
    "a failed required check",
    (i) => {
      i.after.requiredChecks[0].conclusion = "failure";
    },
  ],
  [
    "a failed after run",
    (i) => {
      i.after.run.conclusion = "failure";
    },
  ],
  [
    "a failed required aggregate job",
    (i) => {
      i.after.aggregateJob.conclusion = "failure";
    },
  ],
  [
    "a failed Windows job",
    (i) => {
      i.after.windowsJobs[0].job.conclusion = "failure";
    },
  ],
  [
    "a failed regression step",
    (i) => {
      i.after.windowsJobs[0].step.conclusion = "failure";
    },
  ],
];

const invalidEvidence: Mutation[] = [
  [
    "a missing before run",
    (i) => {
      i.before.pop();
    },
  ],
  [
    "a missing Windows job",
    (i) => {
      i.after.windowsJobs.pop();
    },
  ],
  [
    "ambiguous successful checks",
    (i) => {
      i.after.requiredChecks.push({ ...i.after.requiredChecks[0], id: "135510073976" });
    },
  ],
  [
    "an invalid completion timestamp",
    (i) => {
      i.after.windowsJobs[0].step.completedAt = "not-a-time";
    },
  ],
  [
    "a normalized invalid UTC calendar date",
    (i) => {
      i.after.windowsJobs[0].step.completedAt = "2026-02-30T10:51:06Z";
    },
  ],
  [
    "an empty timing interval",
    (i) => {
      i.after.windowsJobs[0].step.completedAt = i.after.windowsJobs[0].step.startedAt;
    },
  ],
];

function assertRejected(edit: Mutation[1], error: WindowsShardMeasurementFailure) {
  const input = fixture();
  edit(input);
  expect(admitWindowsShardMeasurement(input)).toEqual({ ok: false, error });
}

describe("U-CISHARD-012: Windows shard measurement evidence", () => {
  it("establishes the source receipts and the cross-shard timing premise", () => {
    const evidence = fixture();
    expect(evidence.before.map(({ run, job }) => [run.id, run.attempt, job.step.number])).toEqual([
      ["38694546173", 1, 8],
      ["38692344625", 1, 8],
      ["38690207164", 1, 8],
    ]);
    expect(
      evidence.after.windowsJobs.map(({ job, log }) => [job.id, log.jobId, log.stepNumber]),
    ).toEqual([
      ["135503269875", "135503269875", 10],
      ["135503270462", "135503270462", 10],
      ["135503269976", "135503269976", 10],
    ]);
    const staggered = staggeredFixture().after.windowsJobs.map(({ step }) => step);
    const elapsed = staggered.map(
      ({ startedAt, completedAt }) => (Date.parse(completedAt) - Date.parse(startedAt)) / 1000,
    );
    expect(elapsed).toEqual([662, 421, 544]);
    expect(staggered[0].startedAt < staggered[1].startedAt).toBe(true);
    expect(staggered[2].completedAt > staggered[0].completedAt).toBe(true);
  });

  it("U-CISHARD-012: calculates the fixed before median and the live after interval", () => {
    expect(admitWindowsShardMeasurement(fixture())).toEqual({
      ok: true,
      beforeSeconds: [1453, 1429, 1465],
      beforeMedianSeconds: 1453,
      afterElapsedSeconds: 724,
      shardSeconds: [662, 421, 724],
    });
  });

  it("U-CISHARD-012: uses different shards for the earliest start and latest end", () => {
    const evidence = staggeredFixture();
    evidence.subject.pr = 1852;
    expect(admitWindowsShardMeasurement(evidence)).toEqual({
      ok: true,
      beforeSeconds: [1453, 1429, 1465],
      beforeMedianSeconds: 1453,
      afterElapsedSeconds: 724,
      shardSeconds: [662, 421, 544],
    });
  });

  it("U-CISHARD-012: admits the PR head itself as the common snapshot", () => {
    const evidence = fixture();
    evidence.after.snapshot = {
      commitSha: HEAD,
      parentShas: ["603f806c80b8daaa907731410e4dacb3e9876c8e"],
      treeSha: TREE,
    };
    for (const { log } of evidence.after.windowsJobs) log.snapshotSha = HEAD;
    expect(admitWindowsShardMeasurement(evidence)).toMatchObject({
      ok: true,
      afterElapsedSeconds: 724,
    });
  });

  it.each(bindingMismatches)("U-CISHARD-012: refuses %s", (_label, edit) => {
    assertRejected(edit, "measurement_binding_mismatch");
  });

  it.each(failedEvidence)("U-CISHARD-012: rejects %s as unsuccessful", (_label, edit) => {
    assertRejected(edit, "measurement_not_successful");
  });

  it.each(invalidEvidence)("U-CISHARD-012: rejects %s as invalid evidence", (_label, edit) => {
    assertRejected(edit, "measurement_evidence_invalid");
  });

  it.each([
    "2026-02-30T10:51:06Z",
    "2026-11-19T24:00:00Z",
    "2026-11-19T10:60:00Z",
  ])("rejects a normalized or out-of-range UTC timestamp: %s", (value) =>
    expect(parseMeasurementTimestamp(value)).toBeNull());
});
