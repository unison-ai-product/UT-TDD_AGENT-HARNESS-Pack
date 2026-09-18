import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  ATTESTATION_WORKFLOW_FILE,
  aggregateHarnessResultsPass,
  analyzeGithubCiPolicy,
  type GithubWorkflowDoc,
  githubCiPolicyMessages,
  loadGithubCiPolicyDocs,
  REQUIRED_AGGREGATE_COMMAND,
  resolveGithubCiRuntimeProfile,
} from "../src/lint/github-ci-policy.ts";

const AGGREGATE_ALWAYS = "$" + "{{ always() }}";
// PLAN-L7-455 (troubleshoot): doc-only lane 分岐の canonical if 条件式。
const LANE_FULL_IF = "$" + "{{ steps.classify.outputs.lane == 'full' }}";
const LANE_DOC_IF = "$" + "{{ steps.classify.outputs.lane == 'doc' }}";

const SOURCE_LEG_WORKFLOW = `
name: harness-check
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
concurrency:
  group: harness-check-\${{ github.workflow }}-\${{ github.head_ref || github.ref }}
  cancel-in-progress: \${{ github.ref != 'refs/heads/main' }}
jobs:
  harness-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - name: classify changed files
        id: classify
        run: |
          node src/cli.ts github classify-changes \
            --event-name "\${{ github.event_name }}" \
            --head-sha "\${{ github.sha }}" \
            --base-sha "\${{ github.event.pull_request.base.sha }}" \
            --before-sha "\${{ github.event.before }}" \
            --github-output "$GITHUB_OUTPUT"
      - run: bun src/cli.ts github guard
      - run: bun run typecheck
      - run: bun src/cli.ts db rebuild --json
      - run: bun run test
      - run: bun run lint
      - run: bun src/cli.ts audit quality --include-tests
      - run: bun src/cli.ts doctor
      - name: doc lane source doctor
        if: ${LANE_DOC_IF}
        run: node src/cli.ts doctor --profile source-doc-lane
`;

// PLAN-L7-455 (troubleshoot): 実運用に近い形 (classify step + full/doc lane 条件付き step) の
// runtime leg fixture。skip 可能な step は保守的 allowlist (typecheck/db rebuild/full
// tests/audit quality/full doctor) に限定し、github guard / lint は lane に依らず常に実行する。
const SOURCE_LEG_WORKFLOW_WITH_LANE = `
name: harness-check
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
concurrency:
  group: harness-check-\${{ github.workflow }}-\${{ github.head_ref || github.ref }}
  cancel-in-progress: \${{ github.ref != 'refs/heads/main' }}
jobs:
  harness-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - name: classify changed files
        id: classify
        run: |
          node src/cli.ts github classify-changes \
            --event-name "\${{ github.event_name }}" \
            --head-sha "\${{ github.sha }}" \
            --base-sha "\${{ github.event.pull_request.base.sha }}" \
            --before-sha "\${{ github.event.before }}" \
            --github-output "$GITHUB_OUTPUT"
      - run: bun src/cli.ts github guard
      - if: ${LANE_FULL_IF}
        run: bun run typecheck
      - if: ${LANE_FULL_IF}
        run: bun src/cli.ts db rebuild --json
      - if: ${LANE_FULL_IF}
        run: bun run test
      - if: ${LANE_DOC_IF}
        run: bun run test:doc-lane
      - name: doc lane source doctor
        if: ${LANE_DOC_IF}
        run: node src/cli.ts doctor --profile source-doc-lane
      - run: bun run lint
      - if: ${LANE_FULL_IF}
        run: bun src/cli.ts audit quality --include-tests
      - if: ${LANE_FULL_IF}
        run: bun src/cli.ts doctor
`;

const PACK_WORKFLOW = `
name: harness-check
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
concurrency:
  group: harness-check-\${{ github.workflow }}-\${{ github.head_ref || github.ref }}
  cancel-in-progress: \${{ github.ref != 'refs/heads/main' }}
jobs:
  harness-check:
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v4
        with:
          node-version: "24.13.0"
          cache: npm
      - run: npm ci --no-audit --no-fund
      - run: npm run typecheck
      - run: npm run test:pack
      - run: npm run lint
      - run: node src/cli.ts setup --solo
      - run: node .ut-tdd/bin/ut-tdd.mjs doctor --setup-smoke
`;

const LEGACY_SOURCE_WORKFLOW = `${SOURCE_LEG_WORKFLOW.replace("  harness-check:", "  harness-check-linux:")}
  harness-check-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - name: classify changed files
        id: classify
        shell: bash
        run: |
          node src/cli.ts github classify-changes \
            --event-name "\${{ github.event_name }}" \
            --head-sha "\${{ github.sha }}" \
            --base-sha "\${{ github.event.pull_request.base.sha }}" \
            --before-sha "\${{ github.event.before }}" \
            --github-output "$GITHUB_OUTPUT"
      - run: bun run typecheck
      - run: bun run test
      - run: bun run lint
      - name: doc lane source doctor
        if: ${LANE_DOC_IF}
        run: node src/cli.ts doctor --profile source-doc-lane
  harness-check:
    needs: [harness-check-linux, harness-check-windows]
    if: \${{ always() }}
    runs-on: ubuntu-latest
    steps:
      - name: Require Linux and Windows success
        run: ${REQUIRED_AGGREGATE_COMMAND}
`;

const LEGACY_SOURCE_WORKFLOW_WITH_LANE = `${SOURCE_LEG_WORKFLOW_WITH_LANE.replace("  harness-check:", "  harness-check-linux:")}
  harness-check-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - name: classify changed files
        id: classify
        shell: bash
        run: |
          node src/cli.ts github classify-changes \
            --event-name "\${{ github.event_name }}" \
            --head-sha "\${{ github.sha }}" \
            --base-sha "\${{ github.event.pull_request.base.sha }}" \
            --before-sha "\${{ github.event.before }}" \
            --github-output "$GITHUB_OUTPUT"
      - run: bun run typecheck
      - run: bun run test
      - run: bun run lint
      - name: doc lane source doctor
        if: ${LANE_DOC_IF}
        run: node src/cli.ts doctor --profile source-doc-lane
  harness-check:
    needs: [harness-check-linux, harness-check-windows]
    if: \${{ always() }}
    runs-on: ubuntu-latest
    steps:
      - name: Require Linux and Windows success
        run: ${REQUIRED_AGGREGATE_COMMAND}
`;

// repo 読みの入口を 1 箇所へ集約する (doctor test-repository-isolation の callsite 契約)。
const REPO_ROOT = process.cwd();
const SOURCE_WORKFLOW = readFileSync(
  join(REPO_ROOT, ".github", "workflows", "harness-check.yml"),
  "utf8",
);
const SOURCE_WORKFLOW_WITH_LANE = SOURCE_WORKFLOW;
void LEGACY_SOURCE_WORKFLOW;
void LEGACY_SOURCE_WORKFLOW_WITH_LANE;

function replaceRequired(source: string, from: string | RegExp, to: string): string {
  expect(source).toMatch(
    typeof from === "string" ? new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : from,
  );
  const mutated = source.replace(from, to);
  expect(mutated).not.toBe(source);
  return mutated;
}

function docs(source = SOURCE_WORKFLOW, pack = PACK_WORKFLOW): GithubWorkflowDoc[] {
  return [
    {
      file: ".github/workflows/harness-check.yml",
      content: source,
      profile: "source",
      role: "runtime",
    },
    {
      file: "docs/templates/github/common/harness-check.yml",
      content: SOURCE_LEG_WORKFLOW,
      profile: "source",
      role: "source_template",
    },
    {
      file: "docs/templates/github/common/pack-harness-check.yml",
      content: pack,
      profile: "pack",
      role: "pack_template",
    },
    {
      file: "setup-builtin:common/harness-check.yml",
      content: SOURCE_LEG_WORKFLOW,
      profile: "source",
      role: "setup_builtin",
    },
  ];
}

describe("github-ci-policy lint", () => {
  it("U-CIPOL-013: accepts Linux and Windows runtime legs behind one final aggregate gate", () => {
    const result = analyzeGithubCiPolicy(docs(SOURCE_WORKFLOW));

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("U-CIPOL-014: rejects a runtime workflow without the Windows leg or final aggregate gate", () => {
    const result = analyzeGithubCiPolicy(docs(SOURCE_LEG_WORKFLOW));

    expect(result.violations).toContainEqual({
      file: ".github/workflows/harness-check.yml",
      profile: "source",
      reason: "missing_runtime_leg",
      detail: "jobs.harness-check-windows",
    });
    expect(result.violations).toContainEqual({
      file: ".github/workflows/harness-check.yml",
      profile: "source",
      reason: "missing_aggregate_gate",
      detail: "jobs.harness-check",
    });
  });

  it("U-CIPOL-015: requires the aggregate gate to depend on every runtime leg", () => {
    for (const missing of [
      "harness-check-linux",
      "harness-check-windows",
      "node-generation-linux",
      "node-generation-windows",
    ] as const) {
      const remaining = [
        "harness-check-linux",
        "harness-check-windows",
        "node-generation-linux",
        "node-generation-windows",
      ]
        .filter((leg) => leg !== missing)
        .join(", ");
      const workflow = SOURCE_WORKFLOW.replace(
        "needs: [harness-check-linux, harness-check-windows, node-generation-linux, node-generation-windows]",
        `needs: [${remaining}]`,
      );
      const result = analyzeGithubCiPolicy(docs(workflow));

      expect(result.violations).toContainEqual({
        file: ".github/workflows/harness-check.yml",
        profile: "source",
        reason: "invalid_aggregate_needs",
        detail: `harness-check.needs must equal harness-check-linux,harness-check-windows,node-generation-linux,node-generation-windows (missing=${missing})`,
      });
    }
  });

  it("U-CIPOL-016: requires always() so a failed runtime leg reaches the aggregate verdict", () => {
    const workflow = replaceRequired(
      SOURCE_WORKFLOW,
      /^[ ]{4}if: \$\{\{ always\(\) \}\}\r?\n/m,
      "",
    );
    const result = analyzeGithubCiPolicy(docs(workflow));

    expect(result.violations).toContainEqual({
      file: ".github/workflows/harness-check.yml",
      profile: "source",
      reason: "missing_aggregate_always",
      detail: `harness-check.if must equal ${AGGREGATE_ALWAYS}`,
    });
  });

  it("U-CIPOL-017: requires explicit success guards for both runtime results", () => {
    for (const missing of ["harness-check-linux", "harness-check-windows"] as const) {
      const workflow = SOURCE_WORKFLOW.replace(`\${{ needs.${missing}.result }}`, "success");
      const result = analyzeGithubCiPolicy(docs(workflow));

      expect(result.violations).toContainEqual({
        file: ".github/workflows/harness-check.yml",
        profile: "source",
        reason: "missing_aggregate_result_guard",
        detail: `aggregate verdict must require needs.${missing}.result == success`,
      });
    }
  });

  it("U-CIPOL-018: accepts only the two-leg success result matrix", () => {
    expect(
      aggregateHarnessResultsPass({
        "harness-check-linux": "success",
        "harness-check-windows": "success",
      }),
    ).toBe(true);
    for (const state of [
      "failure",
      "cancelled",
      "skipped",
      "neutral",
      "timed_out",
      "action_required",
      "unknown",
      "",
    ]) {
      expect(
        aggregateHarnessResultsPass({
          "harness-check-linux": state,
          "harness-check-windows": "success",
        }),
      ).toBe(false);
      expect(
        aggregateHarnessResultsPass({
          "harness-check-linux": "success",
          "harness-check-windows": state,
        }),
      ).toBe(false);
    }
  });

  it("U-CIPOL-019: rejects aggregate scripts that observe results without failing closed", () => {
    const echoOnly = replaceRequired(
      SOURCE_WORKFLOW,
      `run: ${REQUIRED_AGGREGATE_COMMAND}`,
      `run: echo "\${{ needs.harness-check-linux.result }} \${{ needs.harness-check-windows.result }}"`,
    );
    expect(analyzeGithubCiPolicy(docs(echoOnly)).violations).toContainEqual({
      file: ".github/workflows/harness-check.yml",
      profile: "source",
      reason: "missing_aggregate_result_guard",
      detail: "aggregate verdict must require needs.harness-check-linux.result == success",
    });

    const continueOnError = replaceRequired(
      SOURCE_WORKFLOW,
      "      - name: require harness and Node generation success",
      "      - name: require harness and Node generation success\n        continue-on-error: true",
    );
    expect(
      analyzeGithubCiPolicy(docs(continueOnError)).violations.map((violation) => violation.reason),
    ).toContain("missing_aggregate_result_guard");

    const expressionContinueOnError = replaceRequired(
      SOURCE_WORKFLOW,
      "    needs: [harness-check-linux, harness-check-windows, node-generation-linux, node-generation-windows]",
      `    continue-on-error: ${"$" + "{{ true }}"}\n    needs: [harness-check-linux, harness-check-windows, node-generation-linux, node-generation-windows]`,
    );
    expect(
      analyzeGithubCiPolicy(docs(expressionContinueOnError)).violations.map(
        (violation) => violation.reason,
      ),
    ).toContain("missing_aggregate_result_guard");
  });

  it("U-CIPOL-020: rejects wrong-platform, empty, or fail-open runtime legs", () => {
    for (const workflow of [
      SOURCE_WORKFLOW.replace("runs-on: windows-latest", "runs-on: ubuntu-latest"),
      SOURCE_WORKFLOW.replace(
        "  harness-check-windows:\n    runs-on: windows-latest\n    steps:",
        "  harness-check-windows:\n    runs-on: windows-latest\n    continue-on-error: true\n    steps:",
      ),
    ]) {
      expect(analyzeGithubCiPolicy(docs(workflow)).violations).toContainEqual({
        file: ".github/workflows/harness-check.yml",
        profile: "source",
        reason: "missing_runtime_leg",
        detail:
          "jobs.harness-check-windows must run on windows-latest with non-empty fail-close steps",
      });
    }
  });

  it("U-CIPOL-001: accepts universal source and Pack harness-check workflows", () => {
    const result = analyzeGithubCiPolicy(docs());

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(githubCiPolicyMessages(result)[0]).toContain(
      "runtime+source-template+pack-template+setup-builtin triggers",
    );
  });

  it("loads source checkouts where .github contains the source workflow", () => {
    const repo = mkdtempSync(join(tmpdir(), "ut-tdd-github-ci-policy-"));
    try {
      mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
      mkdirSync(join(repo, "docs", "templates", "github", "common"), { recursive: true });
      writeFileSync(join(repo, ".github", "workflows", "harness-check.yml"), SOURCE_WORKFLOW);
      writeFileSync(
        join(repo, "docs", "templates", "github", "common", "harness-check.yml"),
        SOURCE_WORKFLOW,
      );
      writeFileSync(
        join(repo, "docs", "templates", "github", "common", "pack-harness-check.yml"),
        PACK_WORKFLOW,
      );

      const docs = loadGithubCiPolicyDocs({
        repoRoot: repo,
        runtimeProfile: "source",
        setupBuiltinWorkflow: SOURCE_WORKFLOW,
      });
      const result = analyzeGithubCiPolicy(docs);

      expect(docs.map((doc) => [doc.file, doc.profile, doc.role])).toEqual([
        [join(".github", "workflows", "harness-check.yml"), "source", "runtime"],
        [
          join("docs", "templates", "github", "common", "harness-check.yml"),
          "source",
          "source_template",
        ],
        [
          join("docs", "templates", "github", "common", "pack-harness-check.yml"),
          "pack",
          "pack_template",
        ],
        ["setup-builtin:common/harness-check.yml", "source", "setup_builtin"],
      ]);
      expect(result.ok).toBe(true);
      expect(result.violations).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("loads Pack checkouts where .github contains the Pack workflow", () => {
    const repo = mkdtempSync(join(tmpdir(), "ut-tdd-github-ci-policy-"));
    try {
      mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
      mkdirSync(join(repo, "docs", "templates", "github", "common"), { recursive: true });
      writeFileSync(join(repo, ".github", "workflows", "harness-check.yml"), PACK_WORKFLOW);
      writeFileSync(
        join(repo, "docs", "templates", "github", "common", "harness-check.yml"),
        SOURCE_WORKFLOW,
      );
      writeFileSync(
        join(repo, "docs", "templates", "github", "common", "pack-harness-check.yml"),
        PACK_WORKFLOW,
      );

      const docs = loadGithubCiPolicyDocs({
        repoRoot: repo,
        runtimeProfile: "pack",
        setupBuiltinWorkflow: SOURCE_WORKFLOW,
      });
      const result = analyzeGithubCiPolicy(docs);

      expect(docs.map((doc) => [doc.file, doc.profile, doc.role])).toEqual([
        [join(".github", "workflows", "harness-check.yml"), "pack", "runtime"],
        [
          join("docs", "templates", "github", "common", "harness-check.yml"),
          "source",
          "source_template",
        ],
        [
          join("docs", "templates", "github", "common", "pack-harness-check.yml"),
          "pack",
          "pack_template",
        ],
        ["setup-builtin:common/harness-check.yml", "source", "setup_builtin"],
      ]);
      expect(result.ok).toBe(true);
      expect(result.violations).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("U-CIPOL-002: rejects main-limited pull_request trigger (stacked PR regression)", () => {
    const limited = SOURCE_WORKFLOW.replace(
      "  pull_request:",
      "  pull_request:\n    branches: [main]",
    );
    const result = analyzeGithubCiPolicy(docs(limited));

    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual({
      file: ".github/workflows/harness-check.yml",
      profile: "source",
      reason: "main_limited_pr_trigger",
      detail:
        "pull_request must not filter base branches: stacked PRs (base != main) would skip harness-check (PLAN-L6-82)",
    });
  });

  it("U-CIPOL-003: rejects branches-ignore filtering and missing pull_request trigger", () => {
    const ignored = PACK_WORKFLOW.replace(
      "  pull_request:",
      "  pull_request:\n    branches-ignore: [work/**]",
    );
    const withIgnore = analyzeGithubCiPolicy(docs(SOURCE_WORKFLOW, ignored));
    expect(withIgnore.violations.map((v) => v.reason)).toContain("main_limited_pr_trigger");

    const withoutPr = SOURCE_WORKFLOW.replace("  pull_request:\n", "");
    const missing = analyzeGithubCiPolicy(docs(withoutPr));
    expect(missing.violations).toContainEqual({
      file: ".github/workflows/harness-check.yml",
      profile: "source",
      reason: "missing_trigger",
      detail: "pull_request trigger (universal, all PR bases)",
    });
  });

  it("U-CIPOL-004: rejects malformed pull_request trigger shapes", () => {
    for (const value of ["false", "bogus", "[]", "0"]) {
      const malformed = SOURCE_WORKFLOW.replace("  pull_request:", `  pull_request: ${value}`);
      const result = analyzeGithubCiPolicy(docs(malformed));

      expect(result.violations).toContainEqual({
        file: ".github/workflows/harness-check.yml",
        profile: "source",
        reason: "malformed_trigger_shape",
        detail: "pull_request must be a bare/null trigger or a mapping without base filters",
      });
    }
  });

  it("U-CIPOL-005: requires a structurally valid main-only push trigger", () => {
    const unrelatedMain = SOURCE_WORKFLOW.replace(
      "  push:\n    branches: [main]\n",
      "  workflow_dispatch:\n    inputs:\n      branch:\n        default: main\n",
    );
    const missing = analyzeGithubCiPolicy(docs(unrelatedMain));
    expect(missing.violations).toContainEqual({
      file: ".github/workflows/harness-check.yml",
      profile: "source",
      reason: "missing_trigger",
      detail: "push trigger (main only)",
    });

    const wrongBranch = SOURCE_WORKFLOW.replace("branches: [main]", "branches: [work/**]");
    const invalid = analyzeGithubCiPolicy(docs(wrongBranch));
    expect(invalid.violations).toContainEqual({
      file: ".github/workflows/harness-check.yml",
      profile: "source",
      reason: "invalid_push_main_trigger",
      detail: "push must use branches: [main] with no branches-ignore",
    });
  });

  it("U-CIPOL-006: checks source template and setup builtin without profile dedupe", () => {
    const sourceTemplateDrift = docs();
    sourceTemplateDrift[1] = {
      ...sourceTemplateDrift[1],
      content: SOURCE_WORKFLOW.replace("  pull_request:", "  pull_request:\n    branches: [main]"),
    };
    expect(
      analyzeGithubCiPolicy(sourceTemplateDrift).violations.map((violation) => violation.file),
    ).toContain("docs/templates/github/common/harness-check.yml");

    const builtinDrift = docs();
    builtinDrift[3] = {
      ...builtinDrift[3],
      content: SOURCE_WORKFLOW.replace("  pull_request:", "  pull_request: false"),
    };
    expect(analyzeGithubCiPolicy(builtinDrift).violations).toContainEqual({
      file: "setup-builtin:common/harness-check.yml",
      profile: "source",
      reason: "malformed_trigger_shape",
      detail: "pull_request must be a bare/null trigger or a mapping without base filters",
    });
  });

  it("U-CIPOL-007: rejects workflow-level path filters on PR and push", () => {
    const pullRequestPaths = SOURCE_WORKFLOW.replace(
      "  pull_request:",
      "  pull_request:\n    paths: [src/**]",
    );
    expect(analyzeGithubCiPolicy(docs(pullRequestPaths)).violations).toContainEqual({
      file: ".github/workflows/harness-check.yml",
      profile: "source",
      reason: "filtered_trigger",
      detail: "pull_request must not use workflow-level paths or paths-ignore filters",
    });

    const pushPaths = SOURCE_WORKFLOW.replace(
      "    branches: [main]",
      "    branches: [main]\n    paths-ignore: [docs/**]",
    );
    expect(analyzeGithubCiPolicy(docs(pushPaths)).violations).toContainEqual({
      file: ".github/workflows/harness-check.yml",
      profile: "source",
      reason: "filtered_trigger",
      detail: "push must not use workflow-level paths or paths-ignore filters",
    });
  });

  it("U-CIPOL-008: requires complete activity types when pull_request.types is explicit", () => {
    const incomplete = SOURCE_WORKFLOW.replace(
      "  pull_request:",
      "  pull_request:\n    types: [opened]",
    );
    expect(analyzeGithubCiPolicy(docs(incomplete)).violations).toContainEqual({
      file: ".github/workflows/harness-check.yml",
      profile: "source",
      reason: "incomplete_pull_request_types",
      detail: "pull_request.types must include opened,synchronize,reopened,ready_for_review",
    });

    const complete = SOURCE_WORKFLOW.replace(
      "  pull_request:",
      "  pull_request:\n    types: [opened, synchronize, reopened, ready_for_review]",
    );
    expect(analyzeGithubCiPolicy(docs(complete)).ok).toBe(true);
  });

  it("U-CIPOL-009: rejects unknown, duplicate, and non-string activity types", () => {
    const unknown = SOURCE_WORKFLOW.replace(
      "  pull_request:",
      "  pull_request:\n    types: [opened, synchronize, reopened, ready_for_review, banana]",
    );
    expect(analyzeGithubCiPolicy(docs(unknown)).violations).toContainEqual({
      file: ".github/workflows/harness-check.yml",
      profile: "source",
      reason: "unsupported_pull_request_type",
      detail: "unknown=banana",
    });

    const duplicate = SOURCE_WORKFLOW.replace(
      "  pull_request:",
      "  pull_request:\n    types: [opened, opened, synchronize, reopened, ready_for_review]",
    );
    expect(analyzeGithubCiPolicy(docs(duplicate)).violations).toContainEqual({
      file: ".github/workflows/harness-check.yml",
      profile: "source",
      reason: "unsupported_pull_request_type",
      detail: "duplicate=opened",
    });

    const nonString = SOURCE_WORKFLOW.replace(
      "  pull_request:",
      "  pull_request:\n    types: [opened, 1]",
    );
    expect(analyzeGithubCiPolicy(docs(nonString)).violations).toContainEqual({
      file: ".github/workflows/harness-check.yml",
      profile: "source",
      reason: "malformed_trigger_shape",
      detail: "pull_request.types must be a string or string array",
    });
  });

  it("U-CIPOL-010: returns structured violations for malformed workflow containers", () => {
    for (const content of ["null", "42", "[]"]) {
      const malformed = docs();
      malformed[0] = { ...malformed[0], content };
      expect(analyzeGithubCiPolicy(malformed).violations).toContainEqual({
        file: ".github/workflows/harness-check.yml",
        profile: "source",
        reason: "malformed_workflow_shape",
        detail: "workflow root must be a mapping",
      });
    }

    const malformedJobs = SOURCE_WORKFLOW.replace(/jobs:[\s\S]*/, "jobs: []");
    expect(analyzeGithubCiPolicy(docs(malformedJobs)).violations).toContainEqual({
      file: ".github/workflows/harness-check.yml",
      profile: "source",
      reason: "malformed_workflow_shape",
      detail: "jobs must be a mapping",
    });

    const malformedJob = SOURCE_WORKFLOW.replace(
      / {2}harness-check:[\s\S]*/,
      "  harness-check: false",
    );
    expect(analyzeGithubCiPolicy(docs(malformedJob)).violations).toContainEqual({
      file: ".github/workflows/harness-check.yml",
      profile: "source",
      reason: "malformed_workflow_shape",
      detail: "jobs.harness-check must be a mapping",
    });

    for (const replacement of ["steps: {}", "steps: [bogus]"]) {
      const malformed = SOURCE_WORKFLOW.replace(/ {4}steps:[\s\S]*/, `    ${replacement}`);
      expect(analyzeGithubCiPolicy(docs(malformed)).violations).toContainEqual({
        file: ".github/workflows/harness-check.yml",
        profile: "source",
        reason: "malformed_workflow_shape",
        detail: "jobs.harness-check-linux.steps must be an array of mappings",
      });
    }

    const malformedStep = replaceRequired(
      SOURCE_WORKFLOW,
      "        uses: actions/checkout@v5",
      "        run: {}",
    );
    expect(analyzeGithubCiPolicy(docs(malformedStep)).violations).toContainEqual({
      file: ".github/workflows/harness-check.yml",
      profile: "source",
      reason: "malformed_workflow_shape",
      detail: "jobs.harness-check-linux.steps must be an array of mappings",
    });
  });

  it("U-CIPOL-011: requires permissions.contents to equal read", () => {
    const malformedPermissions = [
      SOURCE_WORKFLOW.replace("contents: read", "issues: read"),
      SOURCE_WORKFLOW.replace("contents: read", "contents: write"),
      SOURCE_WORKFLOW.replace("permissions:\n  contents: read", "permissions: read-all"),
    ];
    for (const malformed of malformedPermissions) {
      expect(analyzeGithubCiPolicy(docs(malformed)).violations).toContainEqual({
        file: ".github/workflows/harness-check.yml",
        profile: "source",
        reason: "missing_permission",
        detail: "permissions must equal {contents: read}",
      });
    }

    const overGranted = SOURCE_WORKFLOW.replace(
      "contents: read",
      "contents: read\n  issues: write",
    );
    expect(analyzeGithubCiPolicy(docs(overGranted)).violations).toContainEqual({
      file: ".github/workflows/harness-check.yml",
      profile: "source",
      reason: "missing_permission",
      detail: "permissions must equal {contents: read}",
    });

    for (const roleIndex of [0, 1, 2, 3]) {
      const malformed = docs();
      malformed[roleIndex] = {
        ...malformed[roleIndex],
        content: malformed[roleIndex].content.replace("contents: read", "issues: read"),
      };
      expect(
        analyzeGithubCiPolicy(malformed).violations.map((violation) => violation.file),
      ).toContain(malformed[roleIndex].file);
    }
  });

  it("U-CIPOL-010: rejects invalid on, step, concurrency, and role/profile shapes", () => {
    const malformedOn = SOURCE_WORKFLOW.replace(
      /on:[\s\S]*?permissions:/,
      "on: bogus\npermissions:",
    );
    expect(analyzeGithubCiPolicy(docs(malformedOn)).violations).toContainEqual({
      file: ".github/workflows/harness-check.yml",
      profile: "source",
      reason: "malformed_workflow_shape",
      detail: "on must be a mapping",
    });

    for (const step of ["{}", "{ name: bogus }"]) {
      const malformedStep = replaceRequired(
        SOURCE_WORKFLOW,
        "        uses: actions/checkout@v5",
        `        run: ${step}`,
      );
      expect(analyzeGithubCiPolicy(docs(malformedStep)).violations).toContainEqual({
        file: ".github/workflows/harness-check.yml",
        profile: "source",
        reason: "malformed_workflow_shape",
        detail: "jobs.harness-check-linux.steps must be an array of mappings",
      });
    }

    const emptyConcurrency = SOURCE_WORKFLOW.replace(
      /concurrency:[\s\S]*?jobs:/,
      "concurrency: {}\njobs:",
    );
    expect(analyzeGithubCiPolicy(docs(emptyConcurrency)).violations).toContainEqual({
      file: ".github/workflows/harness-check.yml",
      profile: "source",
      reason: "missing_concurrency",
      detail: "concurrency must preserve main-safe canonical group/cancellation expressions",
    });

    const canonicalGroup =
      "harness-check-$" + "{{ github.workflow }}-$" + "{{ github.head_ref || github.ref }}";
    const canonicalCancellation = "$" + "{{ github.ref != 'refs/heads/main' }}";
    for (const roleIndex of [0, 1, 2, 3]) {
      for (const mutate of [
        (content: string) =>
          content.replace(canonicalGroup, "harness-check-$" + "{{ github.ref }}"),
        (content: string) => content.replace(canonicalCancellation, "true"),
      ]) {
        const malformed = docs();
        malformed[roleIndex] = {
          ...malformed[roleIndex],
          content: mutate(malformed[roleIndex].content),
        };
        expect(analyzeGithubCiPolicy(malformed).violations).toContainEqual({
          file: malformed[roleIndex].file,
          profile: malformed[roleIndex].profile,
          reason: "missing_concurrency",
          detail: "concurrency must preserve main-safe canonical group/cancellation expressions",
        });
      }
    }

    const mismatched = docs();
    mismatched[2] = { ...mismatched[2], content: SOURCE_WORKFLOW, profile: "source" };
    expect(analyzeGithubCiPolicy(mismatched).violations).toContainEqual({
      file: "docs/templates/github/common/pack-harness-check.yml",
      profile: "source",
      reason: "invalid_workflow_profile",
      detail: "pack_template must use pack profile",
    });
  });

  it("U-CIPOL-012: resolves source and Pack identity from package metadata", () => {
    const repo = mkdtempSync(join(tmpdir(), "ut-tdd-github-ci-profile-"));
    try {
      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify({ utTdd: { artifactProfile: "source" } }),
      );
      expect(resolveGithubCiRuntimeProfile(repo)).toBe("source");
      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify({ utTdd: { artifactProfile: "pack" } }),
      );
      expect(resolveGithubCiRuntimeProfile(repo)).toBe("pack");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("U-CIPOL-012: uses authoritative runtime profile instead of workflow content", () => {
    const repo = mkdtempSync(join(tmpdir(), "ut-tdd-github-ci-policy-"));
    try {
      mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
      mkdirSync(join(repo, "docs", "templates", "github", "common"), { recursive: true });
      writeFileSync(join(repo, ".github", "workflows", "harness-check.yml"), PACK_WORKFLOW);
      writeFileSync(
        join(repo, "docs", "templates", "github", "common", "harness-check.yml"),
        SOURCE_WORKFLOW,
      );
      writeFileSync(
        join(repo, "docs", "templates", "github", "common", "pack-harness-check.yml"),
        PACK_WORKFLOW,
      );

      const loaded = loadGithubCiPolicyDocs({
        repoRoot: repo,
        runtimeProfile: "source",
        setupBuiltinWorkflow: SOURCE_WORKFLOW,
      });
      expect(loaded[0]?.profile).toBe("source");
      expect(analyzeGithubCiPolicy(loaded).violations).toContainEqual({
        file: join(".github", "workflows", "harness-check.yml"),
        profile: "source",
        reason: "missing_runtime_leg",
        detail: "jobs.harness-check-linux",
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects duplicate workflow roles in direct analyzer inputs", () => {
    const baseline = docs();
    const duplicate = [...baseline, { ...baseline[0], file: "duplicate-runtime.yml" }];
    expect(analyzeGithubCiPolicy(duplicate).violations).toContainEqual({
      file: ".github/workflows/harness-check.yml",
      profile: "source",
      reason: "duplicate_workflow_role",
      detail: "runtime appears 2 times",
    });
  });

  it("requires source CI to keep full doctor in the required status check", () => {
    const result = analyzeGithubCiPolicy(
      docs(
        replaceRequired(
          SOURCE_WORKFLOW,
          // PLAN-L7-461 で doctor step は envelope 書き出し付きの folded scalar になった。
          "        run: >-\n          node src/cli.ts doctor --strict-green-command-digest\n",
          "        run: echo doctor omitted\n",
        ),
      ),
    );

    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual({
      file: ".github/workflows/harness-check.yml",
      profile: "source",
      reason: "missing_runtime_leg",
      detail:
        "jobs.harness-check-linux.steps must exactly match the ordered canonical semantic manifest",
    });
  });

  it("requires Pack CI to use setup-smoke instead of source full doctor", () => {
    const pack = PACK_WORKFLOW.replace(
      "node .ut-tdd/bin/ut-tdd.mjs doctor --setup-smoke",
      "node .ut-tdd/bin/ut-tdd.mjs doctor",
    );
    const result = analyzeGithubCiPolicy(docs(SOURCE_WORKFLOW, pack));

    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual({
      file: "docs/templates/github/common/pack-harness-check.yml",
      profile: "pack",
      reason: "missing_step",
      detail: "setup smoke doctor",
    });
    expect(result.violations).toContainEqual({
      file: "docs/templates/github/common/pack-harness-check.yml",
      profile: "pack",
      reason: "forbidden_full_doctor",
      detail:
        "Pack CI must use doctor --setup-smoke because Pack excludes source-only governance docs",
    });
  });

  it("rejects raw vitest run in Pack CI because source-only tests need governance docs", () => {
    const pack = PACK_WORKFLOW.replace("npm run test:pack", "npx vitest run");
    const result = analyzeGithubCiPolicy(docs(SOURCE_WORKFLOW, pack));

    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual({
      file: "docs/templates/github/common/pack-harness-check.yml",
      profile: "pack",
      reason: "missing_step",
      detail: "pack tests",
    });
    expect(result.violations).toContainEqual({
      file: "docs/templates/github/common/pack-harness-check.yml",
      profile: "pack",
      reason: "forbidden_raw_vitest",
      detail: "Pack CI must use npm run test:pack instead of raw vitest run",
    });
  });

  it("rejects source full bun run test in Pack CI because Pack uses the safe smoke suite", () => {
    const pack = PACK_WORKFLOW.replace("npm run test:pack", "npm run test");
    const result = analyzeGithubCiPolicy(docs(SOURCE_WORKFLOW, pack));

    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual({
      file: "docs/templates/github/common/pack-harness-check.yml",
      profile: "pack",
      reason: "missing_step",
      detail: "pack tests",
    });
    expect(result.violations).toContainEqual({
      file: "docs/templates/github/common/pack-harness-check.yml",
      profile: "pack",
      reason: "forbidden_source_full_tests",
      detail: "Pack CI must use npm run test:pack instead of source full npm run test",
    });
  });

  it.each([
    ["setup-bun action", "actions/setup-node@v4", "oven-sh/setup-bun@v2"],
    ["setup-bun future action", "actions/setup-node@v4", "oven-sh/setup-bun@v3"],
    ["bun install", "npm ci --no-audit --no-fund", "bun install --frozen-lockfile"],
    ["bun run typecheck", "npm run typecheck", "bun run typecheck"],
    ["bun run test:pack", "npm run test:pack", "bun run test:pack"],
    ["bun run lint", "npm run lint", "bun run lint"],
    ["bun wrapper", "node src/cli.ts setup --solo", "bun src/cli.ts setup --solo"],
    ["bunx wrapper", "node src/cli.ts setup --solo", "bunx src/cli.ts setup --solo"],
  ])("U-PACKBUN-007: Pack CI rejects independent %s reachability mutation", (_label, from, to) => {
    const result = analyzeGithubCiPolicy(docs(SOURCE_WORKFLOW, PACK_WORKFLOW.replace(from, to)));

    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual({
      file: "docs/templates/github/common/pack-harness-check.yml",
      profile: "pack",
      reason: "forbidden_bun_execution",
      detail: "Pack CI must not invoke Bun, bunx, or oven-sh/setup-bun",
    });
  });

  // Issue #504: forbidden_bun_execution false negative repair. #502 の closing review で
  // 実測された EVA-1 (`npx bun@<version>`) / EVA-4 (`bun.sh/install` installer 経路) は、
  // 既存 required step を書き換えずに新規 Bun step を「追加」する経路なので、以下は
  // required step 群を全て健全なまま保ち、追加 step だけを注入する (issue 本文の実測手順と
  // 同じ形)。
  function packWithAppendedStep(step: string): string {
    const marker = "      - run: node .ut-tdd/bin/ut-tdd.mjs doctor --setup-smoke\n";
    expect(PACK_WORKFLOW).toContain(marker);
    return PACK_WORKFLOW.replace(marker, `${marker}      - run: ${step}\n`);
  }

  it.each([
    ["EVA-1a: npx bun@<version> run build", "npx bun@1.3 run build"],
    ["EVA-1b: npx bun@latest install", "npx bun@latest install"],
    ["EVA-1c: npx --yes bun@1.2.4 --version", "npx --yes bun@1.2.4 --version"],
  ])("U-PACKBUN-008: Pack CI rejects added %s step", (_label, step) => {
    const result = analyzeGithubCiPolicy(docs(SOURCE_WORKFLOW, packWithAppendedStep(step)));

    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual({
      file: "docs/templates/github/common/pack-harness-check.yml",
      profile: "pack",
      reason: "forbidden_bun_execution",
      detail: "Pack CI must not invoke Bun, bunx, or oven-sh/setup-bun",
    });
  });

  it.each([
    ["EVA-4a: curl | bash installer", "curl -fsSL https://bun.sh/install | bash"],
    ["EVA-4b: curl install.sh | sh installer", "curl -fsSL https://bun.sh/install.sh | sh"],
    ["EVA-4c: wget | bash installer", "wget -qO- https://bun.sh/install | bash"],
  ])("U-PACKBUN-008: Pack CI rejects added %s step", (_label, step) => {
    const result = analyzeGithubCiPolicy(docs(SOURCE_WORKFLOW, packWithAppendedStep(step)));

    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual({
      file: "docs/templates/github/common/pack-harness-check.yml",
      profile: "pack",
      reason: "forbidden_bun_execution",
      detail: "Pack CI must not invoke Bun, bunx, or oven-sh/setup-bun",
    });
  });

  it.each([
    ["npm run bundle", "npm run bundle"],
    ["cabundle mention", "echo cabundle"],
    ["bun.sh docs comment without curl/wget pipe", "echo 'see https://bun.sh for docs'"],
  ])("U-PACKBUN-008: Pack CI does not flag legitimate step: %s", (_label, step) => {
    const result = analyzeGithubCiPolicy(docs(SOURCE_WORKFLOW, packWithAppendedStep(step)));

    expect(
      result.violations.filter((violation) => violation.reason === "forbidden_bun_execution"),
    ).toEqual([]);
  });

  // PLAN-L7-455 (troubleshoot, issue #109): doc-only lane 絞り込みが検証弱化にならないことの
  // fail-close regression。実運用に近い classify step + lane 条件付き step 構成を対象にする。
  describe("PLAN-L7-455 doc-only lane skip safety", () => {
    it.each([
      ["pre-producer action swap", "actions/setup-node@v4", "actions/setup-node@v3"],
      ["post-producer run mutation", "run: npm run lint", "run: npm run lint && true"],
      [
        "install append",
        "run: npm ci --no-audit --no-fund",
        "run: npm ci --no-audit --no-fund && echo extra",
      ],
      ["doc-check mutation", "npm run test:doc-lane", "npm run test:doc-lane --changed"],
      ["with value mutation", "cache: npm", "cache: yarn"],
    ])("U-CIPOL-019a: rejects runtime step manifest mutation: %s", (_label, from, to) => {
      const result = analyzeGithubCiPolicy(docs(SOURCE_WORKFLOW_WITH_LANE.replace(from, to)));
      expect(result.violations.map((v) => v.reason)).toContain("missing_runtime_leg");
    });

    it.each([
      ["branch guard separator", "\n          git log --format=%s", " git log --format=%s"],
      ["doc checks separator", "\n          npm run test:doc-lane", " npm run test:doc-lane"],
    ])("U-CIPOL-019aa: preserves command-separator newline: %s", (_label, from, to) => {
      const result = analyzeGithubCiPolicy(docs(SOURCE_WORKFLOW_WITH_LANE.replace(from, to)));
      expect(result.violations.map((v) => v.reason)).toContain("missing_runtime_leg");
    });

    it("U-CIPOL-019ab: accepts CRLF as semantic-equivalent YAML line endings", () => {
      expect(analyzeGithubCiPolicy(docs(SOURCE_WORKFLOW_WITH_LANE.replace(/\n/g, "\r\n"))).ok).toBe(
        true,
      );
    });

    it("U-CIPOL-019ac: accepts indentation variance after explicit shell continuation", () => {
      const variant = SOURCE_WORKFLOW_WITH_LANE.replace(
        "\\\n            --event-name",
        "\\\n                 --event-name",
      );
      expect(analyzeGithubCiPolicy(docs(variant)).ok).toBe(true);
    });

    it("U-CIPOL-019b: rejects runtime step reorder", () => {
      const checkout = `      - name: checkout\n        uses: actions/checkout@v5\n        with:\n          fetch-depth: 0\n\n`;
      const setup = `      - name: setup node (harness 実行系の正式 runtime、PLAN-L7-462 step 2)\n        uses: actions/setup-node@v4\n        with:\n          node-version: "24.13.0"\n          cache: npm\n\n`;
      const result = analyzeGithubCiPolicy(
        docs(SOURCE_WORKFLOW_WITH_LANE.replace(`${checkout}${setup}`, `${setup}${checkout}`)),
      );
      expect(result.violations.map((v) => v.reason)).toContain("missing_runtime_leg");
    });

    it.each([
      ["defaults.run.shell", "defaults:\n  run:\n    shell: bash\n"],
      ["env.BASH_ENV", "env:\n  BASH_ENV: attack\n"],
      ["env.GITHUB_OUTPUT", "env:\n  GITHUB_OUTPUT: other\n"],
      ["unknown root key", "x-runtime-context: attack\n"],
    ])("U-CIPOL-020: rejects source workflow root context %s", (_label, injected) => {
      const result = analyzeGithubCiPolicy(
        docs(
          SOURCE_WORKFLOW_WITH_LANE.replace(
            "name: harness-check\n",
            `name: harness-check\n${injected}`,
          ),
        ),
      );
      expect(result.violations.map((v) => v.reason)).toContain("malformed_workflow_shape");
    });

    it.each([
      ["missing producer", "id: classify", "id: removed"],
      ["wrong id", "id: classify", "id: classify-docs"],
      ["echo spoof", "node src/cli.ts github classify-changes", 'echo "github classify-changes" #'],
      [
        "substring/no-op",
        "node src/cli.ts github classify-changes",
        "true # node src/cli.ts github classify-changes",
      ],
    ])("U-CIPOL-020a: rejects %s", (_label, from, to) => {
      const result = analyzeGithubCiPolicy(docs(SOURCE_WORKFLOW_WITH_LANE.replace(from, to)));
      expect(result.violations.map((v) => v.reason)).toContain("missing_lane_producer");
    });

    it.each([
      [
        "if false",
        "        id: classify\n        run: |",
        "        id: classify\n        if: false\n        run: |",
      ],
      [
        "lane condition",
        "        id: classify\n        run: |",
        `        id: classify\n        if: ${LANE_FULL_IF}\n        run: |`,
      ],
      [
        "step env",
        "        id: classify\n        run: |",
        "        id: classify\n        env:\n          GITHUB_OUTPUT: other\n        run: |",
      ],
      [
        "continue-on-error",
        "        id: classify\n        run: |",
        "        id: classify\n        continue-on-error: true\n        run: |",
      ],
    ])("U-CIPOL-020af: rejects producer context mutation: %s", (_label, from, to) => {
      const result = analyzeGithubCiPolicy(docs(SOURCE_WORKFLOW_WITH_LANE.replace(from, to)));
      expect(result.violations.map((v) => v.reason)).toContain("missing_lane_producer");
    });

    it("U-CIPOL-020ag: rejects job-level GITHUB_OUTPUT override", () => {
      const result = analyzeGithubCiPolicy(
        docs(
          SOURCE_WORKFLOW_WITH_LANE.replace(
            "  harness-check-linux:\n    runs-on: ubuntu-latest",
            "  harness-check-linux:\n    env:\n      GITHUB_OUTPUT: other\n    runs-on: ubuntu-latest",
          ),
        ),
      );
      expect(result.violations.map((v) => v.reason)).toContain("missing_lane_producer");
    });

    it.each([
      "defaults",
      "env",
      "container",
      "strategy",
      "permissions",
    ])("U-CIPOL-020ah: rejects runtime job execution key %s", (key) => {
      const value =
        key === "defaults"
          ? "{ run: { shell: bash } }"
          : key === "env"
            ? "{ BASH_ENV: attack }"
            : "{}";
      const result = analyzeGithubCiPolicy(
        docs(
          SOURCE_WORKFLOW_WITH_LANE.replace(
            "  harness-check-linux:\n    runs-on: ubuntu-latest",
            `  harness-check-linux:\n    ${key}: ${value}\n    runs-on: ubuntu-latest`,
          ),
        ),
      );
      expect(result.violations.map((v) => v.reason)).toContain("missing_runtime_leg");
    });

    it.each([
      "working-directory",
      "timeout-minutes",
      "unknown-key",
    ])("U-CIPOL-020ai: rejects critical producer key %s", (key) => {
      const result = analyzeGithubCiPolicy(
        docs(
          SOURCE_WORKFLOW_WITH_LANE.replace(
            "        id: classify\n        run: |",
            `        id: classify\n        ${key}: value\n        run: |`,
          ),
        ),
      );
      expect(result.violations.map((v) => v.reason)).toContain("missing_lane_producer");
    });

    it("U-CIPOL-020aj: rejects duplicate classify producer id", () => {
      const duplicate = `      - name: duplicate\n        id: classify\n        run: echo duplicate\n`;
      const result = analyzeGithubCiPolicy(
        docs(
          replaceRequired(
            SOURCE_WORKFLOW_WITH_LANE,
            "      - name: branch-type guard (commitlint / poc / hotfix)",
            `${duplicate}      - name: branch-type guard (commitlint / poc / hotfix)`,
          ),
        ),
      );
      expect(result.violations.map((v) => v.reason)).toContain("missing_lane_producer");
    });

    it.each([
      "--event-name",
      "--head-sha",
      "--base-sha",
      "--before-sha",
      "--github-output",
    ])("U-CIPOL-020aa: rejects a producer missing %s", (flag) => {
      const result = analyzeGithubCiPolicy(
        docs(SOURCE_WORKFLOW_WITH_LANE.replace(flag, "--removed-flag")),
      );
      expect(result.violations.map((v) => v.reason)).toContain("missing_lane_producer");
    });

    it.each([
      ["extra command", '\n          echo "extra"'],
      ["comment", "\n          # classify"],
      ["semicolon", "; true"],
      ["and", " && true"],
      ["or", " || true"],
      ["different output", ' "$OTHER_OUTPUT"'],
    ])("U-CIPOL-020ab: rejects canonical producer mutation: %s", (_label, suffix) => {
      const marker = '            --github-output "$GITHUB_OUTPUT"';
      const result = analyzeGithubCiPolicy(
        docs(SOURCE_WORKFLOW_WITH_LANE.replace(marker, `${marker}${suffix}`)),
      );
      expect(result.violations.map((v) => v.reason)).toContain("missing_lane_producer");
    });

    it("U-CIPOL-020ac: rejects argument reordering", () => {
      const result = analyzeGithubCiPolicy(
        docs(
          SOURCE_WORKFLOW_WITH_LANE.replace(
            `            --event-name "\${{ github.event_name }}" \\\n            --head-sha "\${{ github.sha }}"`,
            `            --head-sha "\${{ github.sha }}" \\\n            --event-name "\${{ github.event_name }}"`,
          ),
        ),
      );
      expect(result.violations.map((v) => v.reason)).toContain("missing_lane_producer");
    });

    it("U-CIPOL-020ad: rejects a Windows producer without shell=bash", () => {
      const result = analyzeGithubCiPolicy(
        docs(SOURCE_WORKFLOW_WITH_LANE.replaceAll("        shell: bash\n", "")),
      );
      expect(result.violations.map((v) => v.reason)).toContain("missing_lane_producer");
    });

    it.each([
      "bash",
      "echo {0}",
    ])("U-CIPOL-020ae: rejects Linux producer with explicit shell=%s", (shell) => {
      const result = analyzeGithubCiPolicy(
        docs(
          SOURCE_WORKFLOW_WITH_LANE.replace(
            "        id: classify\n        run: |",
            `        id: classify\n        shell: ${shell}\n        run: |`,
          ),
        ),
      );
      expect(result.violations.map((v) => v.reason)).toContain("missing_lane_producer");
    });

    it("U-CIPOL-020b: rejects a doc lane without the source-only doctor profile", () => {
      const result = analyzeGithubCiPolicy(
        docs(
          SOURCE_WORKFLOW_WITH_LANE.replace(
            "        run: node src/cli.ts doctor --profile source-doc-lane\n",
            "",
          ),
        ),
      );
      expect(result.violations.map((v) => v.reason)).toContain("missing_doc_lane_doctor");
    });

    it.each([
      [
        "echo",
        `      - name: doc lane source doctor
        if: ${LANE_DOC_IF}
        run: node src/cli.ts doctor --profile source-doc-lane`,
        `      - name: doc lane source doctor
        if: ${LANE_DOC_IF}
        run: echo "doctor --profile source-doc-lane"`,
      ],
      [
        "control operator",
        `      - name: doc lane source doctor
        if: ${LANE_DOC_IF}
        run: node src/cli.ts doctor --profile source-doc-lane`,
        `      - name: doc lane source doctor
        if: ${LANE_DOC_IF}
        run: node src/cli.ts doctor --profile source-doc-lane && true`,
      ],
      [
        "other profile",
        `      - name: doc lane source doctor
        if: ${LANE_DOC_IF}
        run: node src/cli.ts doctor --profile source-doc-lane`,
        `      - name: doc lane source doctor
        if: ${LANE_DOC_IF}
        run: node src/cli.ts doctor --profile source-full`,
      ],
      [
        "extra flag",
        `      - name: doc lane source doctor
        if: ${LANE_DOC_IF}
        run: node src/cli.ts doctor --profile source-doc-lane`,
        `      - name: doc lane source doctor
        if: ${LANE_DOC_IF}
        run: node src/cli.ts doctor --profile source-doc-lane --json`,
      ],
      [
        "env",
        `      - name: doc lane source doctor
        if: ${LANE_DOC_IF}
        run: node src/cli.ts doctor --profile source-doc-lane`,
        `      - name: doc lane source doctor
        if: ${LANE_DOC_IF}
        env:
          X: y
        run: node src/cli.ts doctor --profile source-doc-lane`,
      ],
      [
        "shell",
        `      - name: doc lane source doctor
        if: ${LANE_DOC_IF}
        run: node src/cli.ts doctor --profile source-doc-lane`,
        `      - name: doc lane source doctor
        if: ${LANE_DOC_IF}
        shell: bash
        run: node src/cli.ts doctor --profile source-doc-lane`,
      ],
      [
        "wrong if",
        `      - name: doc lane source doctor
        if: ${LANE_DOC_IF}
        run: node src/cli.ts doctor --profile source-doc-lane`,
        `      - name: doc lane source doctor
        if: false
        run: node src/cli.ts doctor --profile source-doc-lane`,
      ],
      [
        "continue-on-error",
        `      - name: doc lane source doctor
        if: ${LANE_DOC_IF}
        run: node src/cli.ts doctor --profile source-doc-lane`,
        `      - name: doc lane source doctor
        if: ${LANE_DOC_IF}
        continue-on-error: true
        run: node src/cli.ts doctor --profile source-doc-lane`,
      ],
    ])("U-CIPOL-020ba: rejects doc doctor mutation: %s", (_label, from, to) => {
      const result = analyzeGithubCiPolicy(
        docs(replaceRequired(SOURCE_WORKFLOW_WITH_LANE, from, to)),
      );
      expect(result.violations.map((v) => v.reason)).toContain("missing_doc_lane_doctor");
    });
    it("U-CIPOL-021: accepts a real-shaped workflow with canonical full/doc lane step conditions", () => {
      const result = analyzeGithubCiPolicy(docs(SOURCE_WORKFLOW_WITH_LANE));

      expect(result.ok).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it("U-CIPOL-022: 負例 — rejects a required check (github guard) hidden behind a non-allowlisted lane=='full' skip", () => {
      const guardSkipped = replaceRequired(
        SOURCE_WORKFLOW_WITH_LANE,
        "      - name: branch-type guard (commitlint / poc / hotfix)",
        `      - name: branch-type guard (commitlint / poc / hotfix)
        if: ${LANE_FULL_IF}`,
      );
      const result = analyzeGithubCiPolicy(docs(guardSkipped));

      expect(result.ok).toBe(false);
      expect(result.violations).toContainEqual({
        file: ".github/workflows/harness-check.yml",
        profile: "source",
        reason: "forbidden_lane_skip_step",
        detail:
          "jobs.harness-check-linux step \"branch-type guard (commitlint / poc / hotfix)\" is conditioned on lane=='full' but is not on the doc-lane skip allowlist",
      });
    });

    it("U-CIPOL-022b: 負例 — rejects lint (biome) hidden behind a lane=='full' skip", () => {
      const lintSkipped = replaceRequired(
        SOURCE_WORKFLOW_WITH_LANE,
        "      - name: lint (biome)\n        run: npm run lint",
        `      - name: lint (biome)
        if: ${LANE_FULL_IF}
        run: npm run lint`,
      );
      const result = analyzeGithubCiPolicy(docs(lintSkipped));

      expect(result.violations.map((violation) => violation.reason)).toContain(
        "forbidden_lane_skip_step",
      );
    });

    it("U-CIPOL-023: 負例 — rejects a required full-lane check (full doctor) mis-conditioned on lane=='doc'", () => {
      const doctorMisrouted = replaceRequired(
        SOURCE_WORKFLOW_WITH_LANE,
        // PLAN-L7-461: doctor step は if の直後に envelope 用 env を持つ。lane 条件だけを差し替える。
        `        if: ${LANE_FULL_IF}\n        # PLAN-L7-461`,
        `        if: ${LANE_DOC_IF}\n        # PLAN-L7-461`,
      );
      const result = analyzeGithubCiPolicy(docs(doctorMisrouted));

      expect(result.ok).toBe(false);
      expect(result.violations).toContainEqual({
        file: ".github/workflows/harness-check.yml",
        profile: "source",
        reason: "forbidden_lane_skip_step",
        detail:
          "jobs.harness-check-linux step \"doctor (governance hard gates)\" is a required full-lane check but is conditioned on lane=='doc'",
      });
    });

    it("U-CIPOL-024: 負例 — rejects a non-canonical lane condition expression", () => {
      const garbled = replaceRequired(
        SOURCE_WORKFLOW_WITH_LANE,
        `        if: ${LANE_FULL_IF}\n        run: npm run typecheck\n`,
        `        if: ${"$" + "{{ steps.classify.outputs.lane != 'doc' }}"}\n        run: npm run typecheck\n`,
      );
      const result = analyzeGithubCiPolicy(docs(garbled));

      expect(result.ok).toBe(false);
      expect(
        result.violations.some(
          (violation) =>
            violation.reason === "forbidden_lane_skip_step" &&
            violation.detail.includes("non-canonical lane condition"),
        ),
      ).toBe(true);
    });

    it("U-CIPOL-025: 負例 — rejects a job-level lane skip on a runtime leg (aggregate must always be reachable)", () => {
      const jobLevelSkip = SOURCE_WORKFLOW_WITH_LANE.replace(
        "  harness-check-linux:\n    runs-on: ubuntu-latest",
        `  harness-check-linux:\n    if: ${LANE_FULL_IF}\n    runs-on: ubuntu-latest`,
      );
      const result = analyzeGithubCiPolicy(docs(jobLevelSkip));

      expect(result.ok).toBe(false);
      expect(result.violations).toContainEqual({
        file: ".github/workflows/harness-check.yml",
        profile: "source",
        reason: "forbidden_job_level_lane_skip",
        detail:
          "jobs.harness-check-linux must not carry a job-level if (lane classification must stay step-scoped, never skip the whole job)",
      });
    });

    it("U-CIPOL-026: doc-lane-only steps (e.g. test:doc-lane) never trip the full-lane skip allowlist (substring-collision regression)", () => {
      // "npm run test:doc-lane" と "npm run test:fast" は "npm run test" の prefix-substring だが、
      // それぞれ doc lane 専用 / full lane 専用の別 script であり誤って allowlist に混入してはならない。
      const result = analyzeGithubCiPolicy(docs(SOURCE_WORKFLOW_WITH_LANE));
      expect(
        result.violations.some((violation) => violation.detail.includes("test:doc-lane")),
      ).toBe(false);
    });
  });

  describe("D3d attestation runtime workflow (PLAN-L7-465)", () => {
    const attestationDoc = (content: string): GithubWorkflowDoc => ({
      file: ATTESTATION_WORKFLOW_FILE,
      content,
      profile: "source",
      role: "attestation_runtime",
    });

    const VALID_ATTESTATION_WORKFLOW = readFileSync(
      join(REPO_ROOT, ATTESTATION_WORKFLOW_FILE),
      "utf8",
    );

    /** 他 role の doc を渡していない分の missing_workflow は本 oracle の対象外。 */
    const attestationViolations = (content: string) =>
      analyzeGithubCiPolicy([attestationDoc(content)]).violations.filter(
        (violation) => violation.file === ATTESTATION_WORKFLOW_FILE,
      );

    it("U-RVGHA-D3C-010: repo の D3d workflow は固定パス契約 (workflow_dispatch のみ / permission allowlist / default branch 固定 / issue+admit+attest) を満たす", () => {
      expect(attestationViolations(VALID_ATTESTATION_WORKFLOW)).toEqual([]);
    });

    it("U-RVGHA-D3C-010: PR HEAD checkout / PR 由来入力 / 過剰 permission / trigger 逸脱を fail-close する", () => {
      // 既存 fixture と同じく、GitHub 式は連結で書いて template literal 誤検知を避ける。
      const expression = (body: string) => `$${"{{"} ${body} ${"}}"}`;
      const prHeadCheckout = VALID_ATTESTATION_WORKFLOW.replace(
        expression("github.event.repository.default_branch"),
        expression("github.event.pull_request.head.sha"),
      );
      expect(
        attestationViolations(prHeadCheckout)
          .map((violation) => violation.reason)
          .sort(),
      ).toEqual(["forbidden_pull_request_input_execution", "missing_step"]);

      const prTrigger = VALID_ATTESTATION_WORKFLOW.replace(
        "on:\n  workflow_dispatch:",
        "on:\n  pull_request_target:\n  workflow_dispatch:",
      );
      expect(attestationViolations(prTrigger).map((violation) => violation.reason)).toContain(
        "invalid_attestation_trigger",
      );

      const overPermissioned = VALID_ATTESTATION_WORKFLOW.replace(
        "permissions:\n  contents: read",
        "permissions:\n  contents: write",
      );
      expect(
        attestationViolations(overPermissioned).map((violation) => violation.reason),
      ).toContain("missing_permission");

      const withoutAttestation = VALID_ATTESTATION_WORKFLOW.replace(
        "actions/attest-build-provenance@v2",
        "actions/upload-artifact@v4",
      );
      expect(
        attestationViolations(withoutAttestation).map((violation) => violation.detail),
      ).toContain("attest-build-provenance");
    });

    it("U-RVGHA-D3C-010: source profile の実 repo は固定パスの D3d workflow を必ず load し、Pack profile では対象外にする", () => {
      const sourceDocs = loadGithubCiPolicyDocs({
        repoRoot: REPO_ROOT,
        runtimeProfile: "source",
      });
      const attestation = sourceDocs.filter((doc) => doc.role === "attestation_runtime");
      expect(attestation.map((doc) => doc.file)).toEqual([ATTESTATION_WORKFLOW_FILE]);
      expect(
        analyzeGithubCiPolicy(sourceDocs).violations.filter(
          (violation) => violation.file === ATTESTATION_WORKFLOW_FILE,
        ),
      ).toEqual([]);

      const packDocs = loadGithubCiPolicyDocs({ repoRoot: REPO_ROOT, runtimeProfile: "pack" });
      expect(packDocs.some((doc) => doc.role === "attestation_runtime")).toBe(false);
    });
  });
});

// Issue #472 S1-c (PLAN-L7-522 §5.3 slice S1-c): source CI から setup-bun を撤去する。
// CANDIDATE-U-PACKBUN-005 (docs/test-design/harness/L7-pack-consumer-bun-path-removal-test-design.md):
// 実 source workflow (`.github/workflows/harness-check.yml`) の各 job step から
// `oven-sh/setup-bun` 到達と bun/bunx 実行子への trace が 0 件であることを構造的に検査する。
describe("Issue #472 S1-c: source CI Bun removal", () => {
  const BUN_EXECUTABLE_PATTERN = /\b(?:bun|bunx)(?:\.(?:cmd|exe))?\b/i;

  it("U-PACKBUN-005: real source workflow has no setup-bun install and no bun/bunx invocation trace", () => {
    const parsed = parseYaml(SOURCE_WORKFLOW) as {
      jobs: Record<string, { steps?: { uses?: string; run?: string; name?: string }[] }>;
    };
    const legs = ["harness-check-linux", "harness-check-windows"] as const;
    for (const leg of legs) {
      const steps = parsed.jobs[leg]?.steps ?? [];
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps) {
        expect(step.uses ?? "").not.toMatch(/oven-sh\/setup-bun@/i);
        expect(step.run ?? "").not.toMatch(BUN_EXECUTABLE_PATTERN);
        expect(step.name ?? "").not.toMatch(/\bbun\b/i);
      }
    }
  });
});
