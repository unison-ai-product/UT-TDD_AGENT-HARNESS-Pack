// Issue #1063: Windows shard matrix と証跡の workflow 契約。
import { WINDOWS_SHARD_IDS } from "./windows-ci-shard-admission.ts";

export const githubExpression = (expression: string): string =>
  ["$", `{{ ${expression} }}`].join("");

const lane = githubExpression("steps.classify.outputs.lane");
const full = githubExpression("steps.classify.outputs.lane == 'full'");
const shard = githubExpression("matrix.shard");
const temp = githubExpression("runner.temp");
const attempt = githubExpression("github.run_attempt");
const evidenceDirectory = `${temp}/windows-ci-evidence`;
const pairRetirementEnv = {
  PAIR_RETIREMENT_EVENT_NAME: githubExpression("github.event_name"),
  PAIR_RETIREMENT_BASE_SHA: githubExpression("github.event.pull_request.base.sha"),
  PAIR_RETIREMENT_HEAD_SHA: githubExpression("github.event.pull_request.head.sha"),
};

export const LINUX_FULL_REGRESSION_ENV = {
  UT_TDD_DOCTOR_RESULT_FILE: `${temp}/ut-tdd-doctor-result.json`,
  UT_TDD_DOCTOR_RESULT_ROOT: githubExpression("github.workspace"),
  ...pairRetirementEnv,
};

const reportCommand = [
  "$report = Join-Path $env:RUNNER_TEMP 'windows-vitest-report.json'",
  "if (Test-Path -LiteralPath $report) { throw 'Vitest report path already exists' }",
  "npm run test:windows -- --shard=" +
    shard +
    ' --reporter=default --reporter=json "--outputFile=$report"',
].join("\n");

export function harnessLaneEvidenceSteps(leg: "linux" | "windows"): readonly object[] {
  return [
    {
      name: "write harness lane evidence",
      id: "lane-evidence",
      env: { WINDOWS_CI_LANE: lane, WINDOWS_CI_EVIDENCE_LEG: leg === "windows" ? shard : leg },
      run: "node scripts/windows-ci-shard-evidence.mjs lane",
    },
    {
      name: "upload harness lane evidence",
      uses: "actions/upload-artifact@v4",
      with: {
        name: `harness-lane-${githubExpression("steps.lane-evidence.outputs.leg")}-attempt-${attempt}`,
        path: `${temp}/lane-evidence.json`,
        "if-no-files-found": "error",
      },
    },
  ];
}

export const WINDOWS_SHARD_REGRESSION_STEPS = [
  {
    name: "test — Windows full 回帰 (vitest run, windows leg)",
    id: "windows-full-regression",
    if: full,
    env: pairRetirementEnv,
    run: reportCommand,
  },
  {
    name: "write Windows shard evidence",
    id: "shard-evidence",
    if: full,
    env: {
      WINDOWS_CI_EVIDENCE_LEG: shard,
      WINDOWS_CI_SHARD_RESULT: githubExpression("steps.windows-full-regression.outcome"),
    },
    run: "node scripts/windows-ci-shard-evidence.mjs shard",
  },
  {
    name: "upload Windows shard evidence",
    if: full,
    uses: "actions/upload-artifact@v4",
    with: {
      name: `windows-shard-${githubExpression("steps.shard-evidence.outputs.index")}-attempt-${attempt}`,
      path: `${temp}/shard-evidence.json`,
      "if-no-files-found": "error",
    },
  },
] as const;

export function harnessAggregateSteps(requiredCommand: string): readonly object[] {
  return [
    { name: "checkout", uses: "actions/checkout@v5", with: { "fetch-depth": 0 } },
    {
      name: "setup node (aggregate admission runtime)",
      uses: "actions/setup-node@v4",
      with: { "node-version": "24.22.3" },
    },
    {
      name: "download Node generation evidence",
      uses: "actions/download-artifact@v4",
      with: { pattern: "node-generation-*", path: "node-generation-evidence" },
    },
    { name: "require harness and Node generation success", run: requiredCommand },
    {
      name: "admit exact Node generation run",
      run: "node scripts/node-generation-ci-aggregate.mjs",
      env: { NODE_GENERATION_EVIDENCE_DIR: "node-generation-evidence" },
    },
    {
      name: "download harness lane evidence",
      uses: "actions/download-artifact@v4",
      with: {
        pattern: "harness-lane-*-attempt-*",
        path: evidenceDirectory,
        "merge-multiple": false,
      },
    },
    {
      name: "download Windows shard evidence",
      uses: "actions/download-artifact@v4",
      with: {
        pattern: "windows-shard-*-attempt-*",
        path: evidenceDirectory,
        "merge-multiple": false,
      },
    },
    {
      name: "admit Windows shard evidence",
      run: 'node scripts/windows-ci-shard-aggregate.mjs --evidence-dir "$RUNNER_TEMP/windows-ci-evidence"',
    },
  ];
}

const WINDOWS_SHARD_STRATEGY = JSON.stringify({
  "fail-fast": false,
  matrix: { shard: WINDOWS_SHARD_IDS },
});

/** runtime leg の job キー集合と strategy の違反。strategy は harness-check-windows だけが持つ。 */
export function runtimeLegShapeProblems(name: string, leg: object): string[] {
  const sharded = name === "harness-check-windows";
  const expected = sharded ? ["runs-on", "steps", "strategy"] : ["runs-on", "steps"];
  const actual = Object.keys(leg).sort();
  const problems: string[] = [];
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i]))
    problems.push(
      `jobs.${name} must contain only ${sharded ? "runs-on, strategy and steps" : "runs-on and steps"}`,
    );
  if (
    sharded &&
    JSON.stringify((leg as { strategy?: unknown }).strategy) !== WINDOWS_SHARD_STRATEGY
  )
    problems.push(
      `jobs.${name}.strategy must be fail-fast false with matrix.shard exactly 1/3, 2/3, 3/3`,
    );
  return problems;
}
