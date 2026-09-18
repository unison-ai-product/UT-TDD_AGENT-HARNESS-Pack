import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface GithubWorkflowDoc {
  file: string;
  content: string;
  profile: "source" | "pack";
  role: "runtime" | "source_template" | "pack_template" | "setup_builtin" | "attestation_runtime";
}

export interface GithubCiPolicyViolation {
  file: string;
  profile: "source" | "pack";
  reason:
    | "missing_workflow"
    | "malformed_yaml"
    | "missing_job"
    | "missing_trigger"
    | "malformed_trigger_shape"
    | "invalid_push_main_trigger"
    | "filtered_trigger"
    | "incomplete_pull_request_types"
    | "unsupported_pull_request_type"
    | "malformed_workflow_shape"
    | "invalid_workflow_profile"
    | "duplicate_workflow_role"
    | "main_limited_pr_trigger"
    | "missing_permission"
    | "missing_concurrency"
    | "missing_step"
    | "missing_runtime_leg"
    | "missing_aggregate_gate"
    | "invalid_aggregate_needs"
    | "missing_aggregate_always"
    | "missing_aggregate_result_guard"
    | "forbidden_full_doctor"
    | "forbidden_raw_vitest"
    | "forbidden_source_full_tests"
    | "forbidden_bun_execution"
    | "forbidden_job_level_lane_skip"
    | "forbidden_lane_skip_step"
    | "missing_lane_producer"
    | "missing_doc_lane_doctor"
    | "invalid_attestation_trigger"
    | "forbidden_pull_request_input_execution";
  detail: string;
}

export interface GithubCiPolicyResult {
  checked: number;
  violations: GithubCiPolicyViolation[];
  ok: boolean;
}

interface WorkflowStep {
  "continue-on-error"?: unknown;
  env?: unknown;
  id?: string;
  name?: string;
  shell?: string;
  uses?: string;
  run?: string;
  if?: unknown;
}

interface WorkflowJob {
  "continue-on-error"?: unknown;
  env?: unknown;
  needs?: unknown;
  if?: unknown;
  "runs-on"?: unknown;
  steps?: unknown;
}

interface WorkflowYaml {
  name?: string;
  on?: unknown;
  permissions?: Record<string, unknown> | string;
  concurrency?: unknown;
  jobs?: Record<string, WorkflowJob>;
}

interface RequiredStepSpec {
  label: string;
  any: readonly string[];
}

interface ForbiddenStepSpec {
  reason: Extract<
    GithubCiPolicyViolation["reason"],
    | "forbidden_full_doctor"
    | "forbidden_raw_vitest"
    | "forbidden_source_full_tests"
    | "forbidden_bun_execution"
  >;
  detail: string;
  matches: (step: WorkflowStep) => boolean;
}

interface GithubCiProfileSpec {
  requiredSteps: readonly RequiredStepSpec[];
  forbiddenSteps: readonly ForbiddenStepSpec[];
}

const REQUIRED_PULL_REQUEST_TYPES = [
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
] as const;

const REQUIRED_CONCURRENCY_GROUP =
  "harness-check-$" + "{{ github.workflow }}-$" + "{{ github.head_ref || github.ref }}";
const REQUIRED_CANCEL_IN_PROGRESS = "$" + "{{ github.ref != 'refs/heads/main' }}";
const REQUIRED_AGGREGATE_IF = "$" + "{{ always() }}";

const PULL_REQUEST_ACTIVITY_TYPES = new Set([
  "assigned",
  "unassigned",
  "labeled",
  "unlabeled",
  "opened",
  "edited",
  "closed",
  "reopened",
  "synchronize",
  "converted_to_draft",
  "locked",
  "unlocked",
  "enqueued",
  "dequeued",
  "milestoned",
  "demilestoned",
  "ready_for_review",
  "review_requested",
  "review_request_removed",
  "auto_merge_enabled",
  "auto_merge_disabled",
]);

const SOURCE_REQUIRED_STEPS = [
  { label: "checkout@v5", any: ["actions/checkout@v5"] },
  // Issue #472 (S1-c, PLAN-L7-522): source CI の harness 実行系は node/npm route のみを
  // required step とする。setup-bun は撤去済み。tests 側の実 bun spawn は Issue #506 /
  // PR #508 で退役済みで、残存 debt は src/cli/distribution.ts の 2 件のみ
  // (Issue #134 / PLAN-L7-462 の別 exit criteria に帰属する)。
  { label: "setup-node@v4", any: ["actions/setup-node@v4"] },
  { label: "frozen install", any: ["npm ci"] },
  { label: "github guard", any: ["github guard"] },
  { label: "typecheck", any: ["npm run typecheck"] },
  { label: "db rebuild", any: ["db rebuild"] },
  { label: "full tests", any: ["npm run test"] },
  { label: "lint", any: ["npm run lint"] },
  { label: "audit quality", any: ["audit quality"] },
  { label: "full doctor", any: ["src/cli.ts doctor"] },
] as const;

const PACK_REQUIRED_STEPS = [
  { label: "checkout@v5", any: ["actions/checkout@v5"] },
  { label: "setup-node@v4", any: ["actions/setup-node@v4"] },
  { label: "frozen install", any: ["npm ci --no-audit --no-fund"] },
  { label: "typecheck", any: ["npm run typecheck"] },
  { label: "pack tests", any: ["npm run test:pack"] },
  { label: "lint", any: ["npm run lint"] },
  { label: "setup projection", any: ["node src/cli.ts setup --solo"] },
  { label: "source setup smoke doctor", any: ["node src/cli.ts doctor --setup-smoke"] },
  { label: "setup smoke doctor", any: ["node .ut-tdd/bin/ut-tdd.mjs doctor --setup-smoke"] },
] as const;

const BUN_EXECUTION_PATTERN = /\b(?:bun|bunx)(?:\.(?:cmd|exe))?(?=\s|$|["'`]|@)/i;

// Issue #504: `npx bun@1.3 run build` 型は EVA-1 で、`bun` 直後に version pin `@` が続く
// ため上記の execution pattern (lookahead が空白/引用符/行末限定) を素通りしていた。`@` を
// lookahead に追加して塞ぐ。
//
// EVA-4 は `curl|wget` で `bun.sh`/`bun.com` の installer を取得し、shell へパイプする経路
// (`curl -fsSL https://bun.sh/install | bash`)。ドキュメント中の `bun.sh` 単純言及
// (例: コメント) を誤検出しないよう、curl/wget との共起と shell へのパイプを両方要求する。
const BUN_INSTALLER_PATTERN =
  /\b(?:curl|wget)\b[^\n|]*\bbun\.(?:sh|com)\/install(?:\.\w+)?\b[^\n]*\|\s*(?:bash|sh|zsh)\b/i;

const GITHUB_CI_PROFILE_SPECS: Record<GithubWorkflowDoc["profile"], GithubCiProfileSpec> = {
  source: {
    requiredSteps: SOURCE_REQUIRED_STEPS,
    forbiddenSteps: [],
  },
  pack: {
    requiredSteps: PACK_REQUIRED_STEPS,
    forbiddenSteps: [
      {
        reason: "forbidden_bun_execution",
        detail: "Pack CI must not invoke Bun, bunx, or oven-sh/setup-bun",
        matches: (step) =>
          (step.uses ?? "").includes("oven-sh/setup-bun@") ||
          BUN_EXECUTION_PATTERN.test(step.run ?? "") ||
          BUN_INSTALLER_PATTERN.test(step.run ?? ""),
      },
      {
        reason: "forbidden_full_doctor",
        detail:
          "Pack CI must use doctor --setup-smoke because Pack excludes source-only governance docs",
        matches: (step) => {
          const run = step.run ?? "";
          return run.includes(" doctor") && !run.includes("--setup-smoke");
        },
      },
      {
        reason: "forbidden_raw_vitest",
        detail: "Pack CI must use npm run test:pack instead of raw vitest run",
        matches: (step) => /\bvitest\s+run\b/.test(step.run ?? ""),
      },
      {
        reason: "forbidden_source_full_tests",
        detail: "Pack CI must use npm run test:pack instead of source full npm run test",
        matches: (step) => /\b(?:bun|npm)\s+run\s+test\b(?!:)/.test(step.run ?? ""),
      },
    ],
  },
};

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValues(value: unknown): string[] | null {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value;
  }
  return null;
}

function workflowStep(value: unknown): value is WorkflowStep {
  const step = recordValue(value);
  if (
    !step ||
    ![step.id, step.name, step.shell, step.uses, step.run].every(
      (field) => field === undefined || typeof field === "string",
    ) ||
    (step["continue-on-error"] !== undefined && typeof step["continue-on-error"] !== "boolean")
  ) {
    return false;
  }
  if (step.env !== undefined && !recordValue(step.env)) return false;
  return (typeof step.uses === "string") !== (typeof step.run === "string");
}

function stepText(step: WorkflowStep): string {
  return [step.name, step.uses, step.run].filter(Boolean).join("\n");
}

function hasStep(steps: WorkflowStep[], needles: readonly string[]): boolean {
  return steps.some((step) => {
    const text = stepText(step);
    return needles.every((needle) => text.includes(needle));
  });
}

function pushViolation(input: {
  violations: GithubCiPolicyViolation[];
  doc: GithubWorkflowDoc;
  reason: GithubCiPolicyViolation["reason"];
  detail: string;
}): void {
  input.violations.push({
    file: input.doc.file,
    profile: input.doc.profile,
    reason: input.reason,
    detail: input.detail,
  });
}

const HARNESS_LEGS = ["harness-check-linux", "harness-check-windows"] as const;
const NODE_GENERATION_LEGS = ["node-generation-linux", "node-generation-windows"] as const;
const RUNTIME_LEGS = [...HARNESS_LEGS, ...NODE_GENERATION_LEGS] as const;

// PLAN-L7-455 (troubleshoot): doc-only lane 絞り込みが検証弱化にならないことを fail-close 検査する。
// 正準の lane 条件式のみを許可し (非正準式は即 violation)、"full" 限定でしか skip してよい
// step は保守的 allowlist に限定する。allowlist 外の step (github guard / lint / checkout 等)
// が lane 条件を持つこと自体を drift として検出する。
const LANE_REFERENCE_NEEDLE = "steps.classify.outputs.lane";
const LANE_FULL_ONLY_IF = "$" + "{{ steps.classify.outputs.lane == 'full' }}";
const LANE_DOC_ONLY_IF = "$" + "{{ steps.classify.outputs.lane == 'doc' }}";
// 注意: 素朴な部分文字列一致だと "npm run test" が doc lane 専用の
// "npm run test:doc-lane" を誤って full-only allowlist に混入させる (substring collision)。
// `\b...\b(?!:)` で script suffix (`:fast` 等) 付き script 名との衝突を避ける。
const LANE_SKIPPABLE_FULL_ONLY_STEP_MATCHERS: readonly ((text: string) => boolean)[] = [
  (text) => text.includes("npm run typecheck"),
  (text) => text.includes("db rebuild"),
  (text) => /\bnpm\s+run\s+test\b(?!:)/.test(text),
  (text) => text.includes("npm run test:windows"),
  (text) => text.includes("audit quality"),
  (text) => text.includes("src/cli.ts doctor") && !text.includes("--profile source-doc-lane"),
];

function matchesLaneSkipAllowlist(text: string): boolean {
  return LANE_SKIPPABLE_FULL_ONLY_STEP_MATCHERS.some((matches) => matches(text));
}

const githubExpression = (expression: string): string => ["$", `{{ ${expression} }}`].join("");
const CLASSIFY_COMMAND = [
  "node src/cli.ts github classify-changes",
  `--event-name "${githubExpression("github.event_name")}"`,
  `--head-sha "${githubExpression("github.sha")}"`,
  `--base-sha "${githubExpression("github.event.pull_request.base.sha")}"`,
  `--before-sha "${githubExpression("github.event.before")}"`,
  '--github-output "$GITHUB_OUTPUT"',
].join(" ");

function hasCanonicalLaneProducer(run: string | undefined): boolean {
  return run !== undefined && normalizedRun(run) === CLASSIFY_COMMAND;
}

function normalizedRun(run: string | undefined): string {
  return (run ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]*\\\n[ \t]*/g, " ")
    .replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, "");
}

function isFailCloseStep(step: WorkflowStep): boolean {
  return step["continue-on-error"] === undefined || step["continue-on-error"] === false;
}

function hasCanonicalDocLaneDoctor(step: WorkflowStep): boolean {
  return (
    step.if === LANE_DOC_ONLY_IF &&
    normalizedRun(step.run) === "node src/cli.ts doctor --profile source-doc-lane" &&
    step.shell === undefined &&
    step.env === undefined &&
    isFailCloseStep(step)
  );
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length && actual.every((key, index) => key === canonical[index])
  );
}

const step = (name: string, fields: Record<string, unknown>): Record<string, unknown> => ({
  name,
  ...fields,
});
const run = (name: string, command: string, condition?: string): Record<string, unknown> =>
  step(name, { ...(condition ? { if: condition } : {}), run: command });
const commonRuntimeSteps = [
  step("checkout", { uses: "actions/checkout@v5", with: { "fetch-depth": 0 } }),
  // Issue #472 (S1-c, PLAN-L7-522): node が harness 実行系の正式 runtime。setup-bun は撤去済み。
  step("setup node (harness 実行系の正式 runtime、PLAN-L7-462 step 2)", {
    uses: "actions/setup-node@v4",
    with: { "node-version": "24.13.0", cache: "npm" },
  }),
  run("install deps (frozen)", "npm ci --no-audit --no-fund"),
] as const;
const commonNodeGenerationSteps = [
  step("checkout", { uses: "actions/checkout@v5", with: { "fetch-depth": 0 } }),
  step("setup node (sealed generation runtime)", {
    uses: "actions/setup-node@v4",
    with: { "node-version": "24.13.0", cache: "npm" },
  }),
  run("install deps (frozen)", "npm ci --no-audit --no-fund"),
] as const;
const classifyFields = { id: "classify", run: CLASSIFY_COMMAND };
const nodeGenerationStep = (lane: (typeof NODE_GENERATION_LEGS)[number]) =>
  step(`build and verify sealed Node generation (${lane.replace("node-generation-", "")})`, {
    env: {
      NODE_GENERATION_LANE: lane.replace("node-generation-", ""),
      NODE_GENERATION_EVIDENCE_FILE: `${githubExpression("runner.temp")}/node-generation-evidence.json`,
    },
    run: "node scripts/node-generation-ci.mjs",
  });
const nodeGenerationUploadStep = (lane: (typeof NODE_GENERATION_LEGS)[number]) =>
  step(`upload sealed Node generation evidence (${lane})`, {
    uses: "actions/upload-artifact@v4",
    with: {
      name: lane,
      path: `${githubExpression("runner.temp")}/node-generation-evidence.json\ndist/node-generations`,
      "if-no-files-found": "error",
    },
  });
const RUNTIME_STEP_MANIFESTS: Record<(typeof RUNTIME_LEGS)[number], readonly object[]> = {
  "harness-check-linux": [
    ...commonRuntimeSteps,
    step("classify changed files (doc lane vs full, fail-close)", classifyFields),
    step("branch-type guard (commitlint / poc / hotfix)", {
      env: {
        HEAD_REF: githubExpression("github.head_ref || github.ref_name"),
        BASE_REF: githubExpression("github.base_ref || 'main'"),
        PR_TITLE: githubExpression(
          "github.event.pull_request.title || github.event.head_commit.message || ''",
        ),
        PR_BODY: githubExpression("github.event.pull_request.body || ''"),
      },
      run: `printf '%s\\n' "$PR_BODY" > .ut-tdd-pr-body.txt
git log --format=%s -n 20 > .ut-tdd-commit-subjects.txt
node src/cli.ts github guard --head-ref "$HEAD_REF" --base-ref "$BASE_REF" --pr-title "$PR_TITLE" --pr-body-file .ut-tdd-pr-body.txt --commit-file .ut-tdd-commit-subjects.txt`,
    }),
    // Issue #598 (一時措置): source repository の PLAN admission receipt を全実行で照合する。
    // consumer template は genesis projection 未生成のため対象外。v4 R05 で本 step と共に削除する。
    step("plan admission-check (PLAN 編集の receipt 照合、fail-close)", {
      env: {
        BASE_SHA: githubExpression("github.event.pull_request.base.sha || github.event.before"),
      },
      run: `node src/cli.ts plan admission-check --base "$BASE_SHA" --head "${githubExpression("github.sha")}"`,
    }),
    run("typecheck (tsc --noEmit)", "npm run typecheck", LANE_FULL_ONLY_IF),
    run(
      "db rebuild (deterministic projection)",
      "node src/cli.ts db rebuild --json",
      LANE_FULL_ONLY_IF,
    ),
    step("doctor (governance hard gates)", {
      if: LANE_FULL_ONLY_IF,
      env: {
        UT_TDD_DOCTOR_RESULT_FILE: `${githubExpression("runner.temp")}/ut-tdd-doctor-result.json`,
      },
      run: 'node src/cli.ts doctor --strict-green-command-digest --result-file "$UT_TDD_DOCTOR_RESULT_FILE"',
    }),
    step("test — 全回帰 (vitest run)", {
      if: LANE_FULL_ONLY_IF,
      env: {
        UT_TDD_DOCTOR_RESULT_FILE: `${githubExpression("runner.temp")}/ut-tdd-doctor-result.json`,
        UT_TDD_DOCTOR_RESULT_ROOT: githubExpression("github.workspace"),
        UT_TDD_DOCTOR_RESULT_STRICT: "1",
      },
      run: "npm run test",
    }),
    run(
      "doc lane checks (plan lint / readability / rule-drift)",
      "node src/cli.ts plan lint\nnpm run test:doc-lane",
      LANE_DOC_ONLY_IF,
    ),
    run(
      "doc lane source doctor",
      "node src/cli.ts doctor --profile source-doc-lane",
      LANE_DOC_ONLY_IF,
    ),
    run("lint (biome)", "npm run lint"),
    run(
      "audit quality (gate findings)",
      "node src/cli.ts audit quality --include-tests --limit 20",
      LANE_FULL_ONLY_IF,
    ),
    run(
      "job summary (UT-TDD projection)",
      'node src/cli.ts github summary >> "$GITHUB_STEP_SUMMARY"',
      REQUIRED_AGGREGATE_IF,
    ),
  ],
  "harness-check-windows": [
    ...commonRuntimeSteps,
    step("classify changed files (doc lane vs full, fail-close)", {
      ...classifyFields,
      shell: "bash",
    }),
    run("typecheck (tsc --noEmit)", "npm run typecheck", LANE_FULL_ONLY_IF),
    run(
      "db rebuild (deterministic projection on Windows SQLite)",
      "node src/cli.ts db rebuild --json",
      LANE_FULL_ONLY_IF,
    ),
    run(
      "test — Windows full 回帰 (vitest run, windows leg)",
      "npm run test:windows",
      LANE_FULL_ONLY_IF,
    ),
    run(
      "doc lane source checks",
      "node src/cli.ts doctor --profile source-doc-lane",
      LANE_DOC_ONLY_IF,
    ),
    run("doctor (toolchain scope)", "node src/cli.ts doctor --scope toolchain", LANE_FULL_ONLY_IF),
  ],
  "node-generation-linux": [
    ...commonNodeGenerationSteps,
    nodeGenerationStep("node-generation-linux"),
    nodeGenerationUploadStep("node-generation-linux"),
  ],
  "node-generation-windows": [
    ...commonNodeGenerationSteps,
    nodeGenerationStep("node-generation-windows"),
    nodeGenerationUploadStep("node-generation-windows"),
  ],
};

function canonicalSemantic(value: unknown, key = ""): unknown {
  if (typeof value === "string") return key === "run" ? normalizedRun(value) : value;
  if (Array.isArray(value)) return value.map((item) => canonicalSemantic(item));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([childKey, child]) => [childKey, canonicalSemantic(child, childKey)]),
    );
  return value;
}

function checkLaneSkipSafety(input: {
  legs: readonly (WorkflowJob | null)[];
  doc: GithubWorkflowDoc;
  violations: GithubCiPolicyViolation[];
}): void {
  for (const [index, leg] of input.legs.entries()) {
    if (!leg) continue;
    const name = RUNTIME_LEGS[index];
    if (!hasExactKeys(leg, ["runs-on", "steps"])) {
      pushViolation({
        violations: input.violations,
        doc: input.doc,
        reason: "missing_runtime_leg",
        detail: `jobs.${name} must contain only runs-on and steps`,
      });
    }
    if (leg.if !== undefined) {
      pushViolation({
        violations: input.violations,
        doc: input.doc,
        reason: "forbidden_job_level_lane_skip",
        detail: `jobs.${name} must not carry a job-level if (lane classification must stay step-scoped, never skip the whole job)`,
      });
    }
    const steps =
      Array.isArray(leg.steps) && leg.steps.every(workflowStep)
        ? (leg.steps as WorkflowStep[])
        : [];
    if (
      JSON.stringify(canonicalSemantic(steps)) !==
      JSON.stringify(canonicalSemantic(RUNTIME_STEP_MANIFESTS[name]))
    ) {
      pushViolation({
        violations: input.violations,
        doc: input.doc,
        reason: "missing_runtime_leg",
        detail: `jobs.${name}.steps must exactly match the ordered canonical semantic manifest`,
      });
    }
    if (!HARNESS_LEGS.includes(name as (typeof HARNESS_LEGS)[number])) continue;
    const producers = steps.filter((step) => step.id === "classify");
    const producer = producers[0];
    const producerKeys =
      name === "harness-check-windows" ? ["name", "id", "shell", "run"] : ["name", "id", "run"];
    if (
      producers.length !== 1 ||
      !producer ||
      !hasExactKeys(producer, producerKeys) ||
      !hasCanonicalLaneProducer(producer?.run) ||
      producer?.if !== undefined ||
      producer?.env !== undefined ||
      !isFailCloseStep(producer) ||
      (name === "harness-check-linux" && producer?.shell !== undefined) ||
      (name === "harness-check-windows" && producer?.shell !== "bash")
    ) {
      pushViolation({
        violations: input.violations,
        doc: input.doc,
        reason: "missing_lane_producer",
        detail: `jobs.${name} requires the canonical classify producer${name === "harness-check-windows" ? " with shell=bash" : " with no explicit shell"}`,
      });
    }
    const docDoctors = steps.filter((step) => step.run?.includes("source-doc-lane"));
    if (
      !docDoctors.some(hasCanonicalDocLaneDoctor) ||
      docDoctors.some((step) => !hasExactKeys(step, ["name", "if", "run"]))
    ) {
      pushViolation({
        violations: input.violations,
        doc: input.doc,
        reason: "missing_doc_lane_doctor",
        detail: `jobs.${name} doc lane requires doctor --profile source-doc-lane`,
      });
    }
    if (docDoctors.some((step) => !hasCanonicalDocLaneDoctor(step))) {
      pushViolation({
        violations: input.violations,
        doc: input.doc,
        reason: "missing_doc_lane_doctor",
        detail: `jobs.${name} contains a noncanonical source-doc-lane invocation`,
      });
    }
    const jobEnv = recordValue(leg.env);
    if (jobEnv && Object.hasOwn(jobEnv, "GITHUB_OUTPUT")) {
      pushViolation({
        violations: input.violations,
        doc: input.doc,
        reason: "missing_lane_producer",
        detail: `jobs.${name} must not override GITHUB_OUTPUT at job level`,
      });
    }
    for (const step of steps) {
      const ifValue = step.if;
      if (typeof ifValue !== "string" || !ifValue.includes(LANE_REFERENCE_NEEDLE)) continue;
      const label = step.name ?? step.run ?? step.uses ?? "(unnamed step)";
      const text = stepText(step);
      if (ifValue === LANE_FULL_ONLY_IF) {
        if (!matchesLaneSkipAllowlist(text)) {
          pushViolation({
            violations: input.violations,
            doc: input.doc,
            reason: "forbidden_lane_skip_step",
            detail: `jobs.${name} step "${label}" is conditioned on lane=='full' but is not on the doc-lane skip allowlist`,
          });
        }
        continue;
      }
      if (ifValue === LANE_DOC_ONLY_IF) {
        if (matchesLaneSkipAllowlist(text)) {
          pushViolation({
            violations: input.violations,
            doc: input.doc,
            reason: "forbidden_lane_skip_step",
            detail: `jobs.${name} step "${label}" is a required full-lane check but is conditioned on lane=='doc'`,
          });
        }
        continue;
      }
      pushViolation({
        violations: input.violations,
        doc: input.doc,
        reason: "forbidden_lane_skip_step",
        detail: `jobs.${name} step "${label}" uses a non-canonical lane condition: ${ifValue}`,
      });
    }
  }
}

const aggregateResultExpression = (leg: (typeof RUNTIME_LEGS)[number]): string =>
  ["$", `{{ needs.${leg}.result }}`].join("");

export const REQUIRED_AGGREGATE_COMMAND = RUNTIME_LEGS.map(
  (leg) => `test "${aggregateResultExpression(leg)}" = "success"`,
).join(" && ");

export function aggregateHarnessResultsPass(results: Record<string, string>): boolean {
  return HARNESS_LEGS.every((leg) => results[leg] === "success");
}

export function aggregateNodeGenerationResultsPass(results: Record<string, string>): boolean {
  return NODE_GENERATION_LEGS.every((leg) => results[leg] === "success");
}

function checkRuntimeAggregate(input: {
  jobs: Record<string, unknown>;
  doc: GithubWorkflowDoc;
  violations: GithubCiPolicyViolation[];
}): WorkflowJob | null {
  const legs = RUNTIME_LEGS.map((name) => recordValue(input.jobs[name]) as WorkflowJob | null);
  for (const [index, leg] of legs.entries()) {
    const name = RUNTIME_LEGS[index];
    if (!leg) {
      pushViolation({
        violations: input.violations,
        doc: input.doc,
        reason: "missing_runtime_leg",
        detail: `jobs.${name}`,
      });
      continue;
    }
    const expectedRunner =
      name === "harness-check-linux" || name === "node-generation-linux"
        ? "ubuntu-latest"
        : "windows-latest";
    const validSteps =
      Array.isArray(leg.steps) && leg.steps.length > 0 && leg.steps.every(workflowStep);
    const continuesOnError =
      ![undefined, false].includes(leg["continue-on-error"] as undefined | false) ||
      (Array.isArray(leg.steps) &&
        leg.steps.some(
          (step) =>
            ![undefined, false].includes(
              recordValue(step)?.["continue-on-error"] as undefined | false,
            ),
        ));
    if (leg["runs-on"] === expectedRunner && validSteps && !continuesOnError) continue;
    pushViolation({
      violations: input.violations,
      doc: input.doc,
      reason: "missing_runtime_leg",
      detail: `jobs.${name} must run on ${expectedRunner} with non-empty fail-close steps`,
    });
  }
  checkLaneSkipSafety({ legs, doc: input.doc, violations: input.violations });
  const aggregateValue = input.jobs["harness-check"];
  const aggregate = recordValue(aggregateValue) as WorkflowJob | null;
  if (aggregateValue === undefined) {
    pushViolation({
      violations: input.violations,
      doc: input.doc,
      reason: "missing_aggregate_gate",
      detail: "jobs.harness-check",
    });
  } else if (!aggregate) {
    pushViolation({
      violations: input.violations,
      doc: input.doc,
      reason: "malformed_workflow_shape",
      detail: "jobs.harness-check must be a mapping",
    });
  } else if (aggregate.needs === undefined) {
    pushViolation({
      violations: input.violations,
      doc: input.doc,
      reason: "missing_aggregate_gate",
      detail: "jobs.harness-check",
    });
  } else {
    const needs = stringValues(aggregate.needs);
    const missing = RUNTIME_LEGS.filter((leg) => !needs?.includes(leg));
    const exact = needs?.length === RUNTIME_LEGS.length && missing.length === 0;
    if (!exact) {
      pushViolation({
        violations: input.violations,
        doc: input.doc,
        reason: "invalid_aggregate_needs",
        detail: `harness-check.needs must equal ${RUNTIME_LEGS.join(",")} (missing=${missing.join(",") || "none"})`,
      });
    }
    if (aggregate.if !== REQUIRED_AGGREGATE_IF) {
      pushViolation({
        violations: input.violations,
        doc: input.doc,
        reason: "missing_aggregate_always",
        detail: `harness-check.if must equal ${REQUIRED_AGGREGATE_IF}`,
      });
    }
    const aggregateSteps =
      Array.isArray(aggregate.steps) && aggregate.steps.every(workflowStep) ? aggregate.steps : [];
    const aggregateText = aggregateSteps.map(stepText).join("\n");
    const failCloseDisabled =
      ![undefined, false].includes(aggregate["continue-on-error"] as undefined | false) ||
      aggregateSteps.some(
        (step) => ![undefined, false].includes(step["continue-on-error"] as undefined | false),
      ) ||
      !aggregateSteps.some((step) => step.run?.trim() === REQUIRED_AGGREGATE_COMMAND) ||
      !aggregateSteps.some(
        (step) => step.run?.trim() === "node scripts/node-generation-ci-aggregate.mjs",
      );
    for (const leg of RUNTIME_LEGS) {
      if (!failCloseDisabled && aggregateText.includes(aggregateResultExpression(leg))) continue;
      pushViolation({
        violations: input.violations,
        doc: input.doc,
        reason: "missing_aggregate_result_guard",
        detail: `aggregate verdict must require needs.${leg}.result == success`,
      });
    }
  }
  return legs[0];
}

function checkHarnessTriggers(input: {
  workflow: WorkflowYaml;
  doc: GithubWorkflowDoc;
  violations: GithubCiPolicyViolation[];
}): void {
  const on = recordValue(input.workflow.on);
  const push = on?.push;
  const pushRecord = recordValue(push);
  const pushBranches = pushRecord ? stringValues(pushRecord.branches) : null;
  if (push === undefined) {
    pushViolation({
      violations: input.violations,
      doc: input.doc,
      reason: "missing_trigger",
      detail: "push trigger (main only)",
    });
  } else if (pushRecord && ("paths" in pushRecord || "paths-ignore" in pushRecord)) {
    pushViolation({
      violations: input.violations,
      doc: input.doc,
      reason: "filtered_trigger",
      detail: "push must not use workflow-level paths or paths-ignore filters",
    });
  } else if (
    !pushRecord ||
    pushBranches?.length !== 1 ||
    pushBranches[0] !== "main" ||
    Object.keys(pushRecord).some((key) => key !== "branches")
  ) {
    pushViolation({
      violations: input.violations,
      doc: input.doc,
      reason: "invalid_push_main_trigger",
      detail: "push must use branches: [main] with no branches-ignore",
    });
  }

  const pullRequest = on?.pull_request;
  if (pullRequest === undefined) {
    pushViolation({
      violations: input.violations,
      doc: input.doc,
      reason: "missing_trigger",
      detail: "pull_request trigger (universal, all PR bases)",
    });
    return;
  }
  if (pullRequest === null) return;
  const pullRequestRecord = recordValue(pullRequest);
  if (!pullRequestRecord) {
    pushViolation({
      violations: input.violations,
      doc: input.doc,
      reason: "malformed_trigger_shape",
      detail: "pull_request must be a bare/null trigger or a mapping without base filters",
    });
    return;
  }
  if ("paths" in pullRequestRecord || "paths-ignore" in pullRequestRecord) {
    pushViolation({
      violations: input.violations,
      doc: input.doc,
      reason: "filtered_trigger",
      detail: "pull_request must not use workflow-level paths or paths-ignore filters",
    });
  }
  if ("branches" in pullRequestRecord || "branches-ignore" in pullRequestRecord) {
    pushViolation({
      violations: input.violations,
      doc: input.doc,
      reason: "main_limited_pr_trigger",
      detail:
        "pull_request must not filter base branches: stacked PRs (base != main) would skip harness-check (PLAN-L6-82)",
    });
  }
  const unknownKeys = Object.keys(pullRequestRecord).filter(
    (key) => !["branches", "branches-ignore", "paths", "paths-ignore", "types"].includes(key),
  );
  if (unknownKeys.length > 0) {
    pushViolation({
      violations: input.violations,
      doc: input.doc,
      reason: "malformed_trigger_shape",
      detail: `pull_request contains unsupported keys: ${unknownKeys.sort().join(",")}`,
    });
  }
  if ("types" in pullRequestRecord) {
    const types = stringValues(pullRequestRecord.types);
    if (!types) {
      pushViolation({
        violations: input.violations,
        doc: input.doc,
        reason: "malformed_trigger_shape",
        detail: "pull_request.types must be a string or string array",
      });
      return;
    }
    const unknown = [...new Set(types.filter((type) => !PULL_REQUEST_ACTIVITY_TYPES.has(type)))];
    const duplicate = [...new Set(types.filter((type, index) => types.indexOf(type) !== index))];
    if (unknown.length > 0 || duplicate.length > 0) {
      pushViolation({
        violations: input.violations,
        doc: input.doc,
        reason: "unsupported_pull_request_type",
        detail: [
          unknown.length > 0 ? `unknown=${unknown.sort().join(",")}` : "",
          duplicate.length > 0 ? `duplicate=${duplicate.sort().join(",")}` : "",
        ]
          .filter(Boolean)
          .join(";"),
      });
    }
    if (REQUIRED_PULL_REQUEST_TYPES.some((required) => !types.includes(required))) {
      pushViolation({
        violations: input.violations,
        doc: input.doc,
        reason: "incomplete_pull_request_types",
        detail: `pull_request.types must include ${REQUIRED_PULL_REQUEST_TYPES.join(",")}`,
      });
    }
  }
}

export const ATTESTATION_WORKFLOW_FILE = join(".github", "workflows", "review-attestation.yml");
const ATTESTATION_JOB = "review-attestation";
const ATTESTATION_PERMISSIONS: Readonly<Record<string, string>> = {
  contents: "read",
  "id-token": "write",
  attestations: "write",
};
/**
 * D3d workflow が pull request 由来の入力を実行資格へ昇格させないための禁止式。
 * PR HEAD checkout / PR ref 実行が 1 つでもあれば fail-close する。
 */
const PULL_REQUEST_INPUT_EXPRESSIONS = [
  "github.event.pull_request.head",
  "github.event.pull_request.merge_commit_sha",
  "github.head_ref",
] as const;
const ATTESTATION_REQUIRED_STEPS: readonly RequiredStepSpec[] = [
  { label: "checkout@v5", any: ["actions/checkout@v5"] },
  { label: "attest-build-provenance", any: ["actions/attest-build-provenance"] },
  { label: "custody issue", any: ["review-custody-runner.ts issue"] },
  { label: "custody admit", any: ["review-custody-runner.ts admit"] },
];

/**
 * D3d 専用 workflow の実行資格を検査する (PLAN-L7-465 §D3c freeze「発行・検証境界」2)。
 *
 * 固定パス 1 本だけを見る。任意 glob を使わないので、別 workflow を増やして custody を
 * 名乗ることはできない。`harness-check.yml` の step / permission / required-check 契約は
 * この検査の対象外であり、変更もしない。
 */
function checkAttestationRuntime(input: {
  doc: GithubWorkflowDoc;
  violations: GithubCiPolicyViolation[];
}): void {
  const { doc, violations } = input;
  let parsed: unknown;
  try {
    parsed = parseYaml(doc.content);
  } catch {
    pushViolation({
      violations,
      doc,
      reason: "malformed_yaml",
      detail: "workflow YAML does not parse",
    });
    return;
  }
  const workflow = recordValue(parsed);
  if (!workflow) {
    pushViolation({
      violations,
      doc,
      reason: "malformed_workflow_shape",
      detail: "workflow root must be a mapping",
    });
    return;
  }
  const triggers = recordValue(workflow.on);
  if (!triggers || !hasExactKeys(triggers, ["workflow_dispatch"])) {
    pushViolation({
      violations,
      doc,
      reason: "invalid_attestation_trigger",
      detail: "attestation workflow must trigger on workflow_dispatch only",
    });
  }
  const permissions = recordValue(workflow.permissions);
  const permissionsExact =
    permissions !== null &&
    hasExactKeys(permissions, Object.keys(ATTESTATION_PERMISSIONS)) &&
    Object.entries(ATTESTATION_PERMISSIONS).every(([key, value]) => permissions[key] === value);
  if (!permissionsExact) {
    pushViolation({
      violations,
      doc,
      reason: "missing_permission",
      detail: "permissions must equal the attestation profile allowlist",
    });
  }
  for (const expression of PULL_REQUEST_INPUT_EXPRESSIONS) {
    if (doc.content.includes(expression)) {
      pushViolation({
        violations,
        doc,
        reason: "forbidden_pull_request_input_execution",
        detail: `attestation workflow must not consume ${expression}`,
      });
    }
  }
  if (!doc.content.includes("github.event.repository.default_branch")) {
    pushViolation({
      violations,
      doc,
      reason: "missing_step",
      detail: "checkout must pin ref to the default branch",
    });
  }
  const job = recordValue(recordValue(workflow.jobs)?.[ATTESTATION_JOB]) as WorkflowJob | null;
  if (!job) {
    pushViolation({ violations, doc, reason: "missing_job", detail: `jobs.${ATTESTATION_JOB}` });
    return;
  }
  if (!Array.isArray(job.steps) || !job.steps.every(workflowStep)) {
    pushViolation({
      violations,
      doc,
      reason: "malformed_workflow_shape",
      detail: `jobs.${ATTESTATION_JOB}.steps must be an array of mappings`,
    });
    return;
  }
  const steps = job.steps as WorkflowStep[];
  for (const spec of ATTESTATION_REQUIRED_STEPS) {
    if (!hasStep(steps, spec.any)) {
      pushViolation({ violations, doc, reason: "missing_step", detail: spec.label });
    }
  }
}

export function analyzeGithubCiPolicy(docs: GithubWorkflowDoc[]): GithubCiPolicyResult {
  const violations: GithubCiPolicyViolation[] = [];
  for (const doc of docs) {
    const expectedProfile =
      doc.role === "pack_template"
        ? "pack"
        : doc.role === "source_template" ||
            doc.role === "setup_builtin" ||
            doc.role === "attestation_runtime"
          ? "source"
          : doc.profile;
    if (doc.profile !== expectedProfile) {
      pushViolation({
        violations,
        doc,
        reason: "invalid_workflow_profile",
        detail: `${doc.role} must use ${expectedProfile} profile`,
      });
      continue;
    }
    if (doc.role === "attestation_runtime") {
      // D3d workflow は harness-check とは別契約 (required check ではなく receipt producer)。
      // 汎用 runtime 検査へ落とさず、専用の実行資格検査だけを当てる。
      checkAttestationRuntime({ doc, violations });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = parseYaml(doc.content);
    } catch {
      pushViolation({
        violations,
        doc,
        reason: "malformed_yaml",
        detail: "workflow YAML does not parse",
      });
      continue;
    }
    const workflowRecord = recordValue(parsed);
    if (!workflowRecord) {
      pushViolation({
        violations,
        doc,
        reason: "malformed_workflow_shape",
        detail: "workflow root must be a mapping",
      });
      continue;
    }
    const workflow = workflowRecord as WorkflowYaml;
    if (
      doc.role === "runtime" &&
      doc.profile === "source" &&
      !hasExactKeys(workflowRecord, ["name", "on", "permissions", "concurrency", "jobs"])
    ) {
      pushViolation({
        violations,
        doc,
        reason: "malformed_workflow_shape",
        detail:
          "source runtime workflow root must contain only name, on, permissions, concurrency, and jobs",
      });
    }
    if (workflowRecord.on !== undefined && !recordValue(workflowRecord.on)) {
      pushViolation({
        violations,
        doc,
        reason: "malformed_workflow_shape",
        detail: "on must be a mapping",
      });
      continue;
    }
    const jobsValue = workflowRecord.jobs;
    const jobs = recordValue(jobsValue);
    if (!jobs) {
      pushViolation({
        violations,
        doc,
        reason: jobsValue === undefined ? "missing_job" : "malformed_workflow_shape",
        detail: jobsValue === undefined ? "jobs.harness-check" : "jobs must be a mapping",
      });
      continue;
    }
    const requiresRuntimeAggregate = doc.role === "runtime" && doc.profile === "source";
    const jobValue = jobs?.[requiresRuntimeAggregate ? "harness-check-linux" : "harness-check"];
    const job = requiresRuntimeAggregate
      ? checkRuntimeAggregate({ jobs, doc, violations })
      : (recordValue(jobValue) as WorkflowJob | null);
    if (!job) {
      pushViolation({
        violations,
        doc,
        reason: jobValue === undefined ? "missing_job" : "malformed_workflow_shape",
        detail:
          jobValue === undefined
            ? `jobs.${requiresRuntimeAggregate ? "harness-check-linux" : "harness-check"}`
            : `jobs.${requiresRuntimeAggregate ? "harness-check-linux" : "harness-check"} must be a mapping`,
      });
      continue;
    }
    checkHarnessTriggers({ workflow, doc, violations });
    const permissions = recordValue(workflow.permissions);
    if (
      permissions?.contents !== "read" ||
      Object.keys(permissions).some((key) => key !== "contents")
    ) {
      pushViolation({
        violations,
        doc,
        reason: "missing_permission",
        detail: "permissions must equal {contents: read}",
      });
    }
    const concurrency = recordValue(workflow.concurrency);
    if (
      concurrency?.group !== REQUIRED_CONCURRENCY_GROUP ||
      concurrency["cancel-in-progress"] !== REQUIRED_CANCEL_IN_PROGRESS
    ) {
      pushViolation({
        violations,
        doc,
        reason: "missing_concurrency",
        detail: "concurrency must preserve main-safe canonical group/cancellation expressions",
      });
    }

    if (!Array.isArray(job.steps) || !job.steps.every(workflowStep)) {
      pushViolation({
        violations,
        doc,
        reason: "malformed_workflow_shape",
        detail: `jobs.${requiresRuntimeAggregate ? "harness-check-linux" : "harness-check"}.steps must be an array of mappings`,
      });
      continue;
    }
    const steps = job.steps as WorkflowStep[];
    if (doc.role === "source_template" || doc.role === "setup_builtin") continue;
    const profileSpec = GITHUB_CI_PROFILE_SPECS[doc.profile];
    for (const spec of profileSpec.requiredSteps) {
      if (!hasStep(steps, spec.any)) {
        pushViolation({ violations, doc, reason: "missing_step", detail: spec.label });
      }
    }

    for (const spec of profileSpec.forbiddenSteps) {
      if (steps.some(spec.matches)) {
        pushViolation({
          violations,
          doc,
          reason: spec.reason,
          detail: spec.detail,
        });
      }
    }
  }

  /**
   * `missing_workflow` は「doc set が実運用の完全な 4 役構成を与えられたとき」だけ要求する。
   * 部分 fixture で 1〜2 個だけ渡した場合に fixture 意図を壊さないため。
   * D3d 実在は source 完全セットでの `loadGithubCiPolicyDocs` 通し検査で担保し、内容契約は
   * `checkAttestationRuntime` が fail-close する。
   */
  const baseRoles = ["runtime", "source_template", "pack_template", "setup_builtin"] as const;
  const requiredRoles =
    baseRoles.every((role) => docs.some((doc) => doc.role === role)) &&
    docs.length >= baseRoles.length
      ? ([...baseRoles] as typeof baseRoles)
      : ([] as const);
  for (const role of requiredRoles) {
    const roleCount = docs.filter((doc) => doc.role === role).length;
    if (roleCount === 0) {
      pushViolation({
        violations,
        doc: {
          file: role,
          profile: role === "pack_template" ? "pack" : "source",
          role,
          content: "",
        },
        reason: "missing_workflow",
        detail: `${role} harness-check workflow`,
      });
    } else if (roleCount > 1) {
      const first = docs.find((doc) => doc.role === role);
      if (!first) continue;
      pushViolation({
        violations,
        doc: first,
        reason: "duplicate_workflow_role",
        detail: `${role} appears ${roleCount} times`,
      });
    }
  }

  return { checked: docs.length, violations, ok: violations.length === 0 };
}

export interface LoadGithubCiPolicyDocsInput {
  repoRoot?: string;
  setupBuiltinWorkflow?: string;
  runtimeProfile: GithubWorkflowDoc["profile"];
}

export function resolveGithubCiRuntimeProfile(repoRoot: string): GithubWorkflowDoc["profile"] {
  const parsed = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    utTdd?: { artifactProfile?: unknown };
  };
  const profile = parsed.utTdd?.artifactProfile;
  if (profile !== "source" && profile !== "pack") {
    throw new Error("package.json utTdd.artifactProfile must be source or pack");
  }
  return profile;
}

export function loadGithubCiPolicyDocs(input: LoadGithubCiPolicyDocsInput): GithubWorkflowDoc[] {
  const repoRoot = input.repoRoot ?? process.cwd();
  const candidates: GithubWorkflowDoc[] = [];
  const addCandidate = (
    relativeFile: string,
    role: GithubWorkflowDoc["role"],
    profile: GithubWorkflowDoc["profile"],
  ) => {
    const absoluteFile = join(repoRoot, relativeFile);
    if (!existsSync(absoluteFile)) return;
    const content = readFileSync(absoluteFile, "utf8");
    candidates.push({
      file: relativeFile,
      content,
      profile,
      role,
    });
  };
  addCandidate(join(".github", "workflows", "harness-check.yml"), "runtime", input.runtimeProfile);
  if (input.runtimeProfile === "source") {
    addCandidate(ATTESTATION_WORKFLOW_FILE, "attestation_runtime", "source");
  }
  addCandidate(
    join("docs", "templates", "github", "common", "harness-check.yml"),
    "source_template",
    "source",
  );
  addCandidate(
    join("docs", "templates", "github", "common", "pack-harness-check.yml"),
    "pack_template",
    "pack",
  );
  if (input.setupBuiltinWorkflow !== undefined) {
    candidates.push({
      file: "setup-builtin:common/harness-check.yml",
      content: input.setupBuiltinWorkflow,
      profile: "source",
      role: "setup_builtin",
    });
  }
  return candidates;
}

export function githubCiPolicyMessages(result: GithubCiPolicyResult): string[] {
  if (result.ok) {
    return [
      `github-ci-policy - OK (checked=${result.checked}, runtime+source-template+pack-template+setup-builtin triggers)`,
    ];
  }
  const sample = result.violations
    .slice(0, 8)
    .map((v) => `${v.file}:${v.reason}:${v.detail}`)
    .join(", ");
  return [`github-ci-policy - violation ${result.violations.length} (${sample})`];
}
