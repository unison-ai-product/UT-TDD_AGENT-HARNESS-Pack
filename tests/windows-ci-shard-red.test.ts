import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  aggregateHarnessResultsPass,
  analyzeGithubCiPolicy,
  type GithubWorkflowDoc,
} from "../src/lint/github-ci-policy.ts";

// Issue #1063: Windows leg の vitest 3 shard 契約 (function-spec.md「Windows leg の vitest 3 shard 契約」)。
// 各 oracle は「契約に沿った 3 shard workflow (COMPLIANT)」に変異を 1 つだけ足し、
// 変異が policy の判定を変えること (COMPLIANT に無い violation が増えること) を 1 条件として確かめる。

type Step = Record<string, unknown> & { name?: string; run?: string; if?: string };
type Job = Record<string, unknown> & { steps?: Step[]; strategy?: Record<string, unknown> };
type Workflow = { jobs: Record<string, Job> };

const WINDOWS = "harness-check-windows";
const TEST_STEP = "test — Windows full 回帰 (vitest run, windows leg)";
const EXPR_OPEN = "$" + "{{ ";
const EXPR_CLOSE = " }}";
const SHARD_ARGUMENT = `--shard=${EXPR_OPEN}matrix.shard${EXPR_CLOSE}`;
const SOURCE = readFileSync(".github/workflows/harness-check.yml", "utf8");

function baseWorkflow(): Workflow {
  return parseYaml(SOURCE) as Workflow;
}

function job(workflow: Workflow, name: string): Job {
  const found = workflow.jobs[name];
  if (!found) throw new Error(`fixture must contain job ${name}`);
  return found;
}

function testStep(workflow: Workflow): Step {
  const step = job(workflow, WINDOWS).steps?.find((candidate) => candidate.name === TEST_STEP);
  if (!step) throw new Error("fixture must contain the Windows test step");
  return step;
}

function compliantWorkflow(): Workflow {
  const workflow = baseWorkflow();
  job(workflow, WINDOWS).strategy = {
    "fail-fast": false,
    matrix: { shard: ["1/3", "2/3", "3/3"] },
  };
  return workflow;
}

function changeTestCommand(workflow: Workflow, previous: string, replacement: string): void {
  const step = testStep(workflow);
  if (!step.run?.includes(previous)) throw new Error(`fixture must contain ${previous}`);
  step.run = step.run.replace(previous, replacement);
}

function mutated(mutator: (workflow: Workflow) => unknown): Workflow {
  const workflow = compliantWorkflow();
  mutator(workflow);
  return workflow;
}

function doc(workflow: Workflow): GithubWorkflowDoc {
  return {
    file: ".github/workflows/harness-check.yml",
    content: stringifyYaml(workflow),
    profile: "source",
    role: "runtime",
  };
}

interface Finding {
  reason: string;
  detail: string;
}

function findings(workflow: Workflow): Finding[] {
  return analyzeGithubCiPolicy([doc(workflow)]).violations.map(({ reason, detail }) => ({
    reason,
    detail,
  }));
}

const key = (finding: Finding): string => `${finding.reason}|${finding.detail}`;

/** 変異だけが増やした violation (COMPLIANT に既にある violation は数えない)。 */
function addedBy(workflow: Workflow): Finding[] {
  const known = new Set(findings(compliantWorkflow()).map(key));
  return findings(workflow).filter((finding) => !known.has(key(finding)));
}

function addedReasons(workflow: Workflow): string[] {
  return addedBy(workflow).map((finding) => finding.reason);
}

function strategyOf(workflow: Workflow): Record<string, unknown> {
  const strategy = job(workflow, WINDOWS).strategy;
  if (!strategy) throw new Error("COMPLIANT must carry a strategy");
  return strategy;
}

function matrixOf(workflow: Workflow): Record<string, unknown> {
  return strategyOf(workflow).matrix as Record<string, unknown>;
}

type Mutant = readonly [label: string, mutator: (workflow: Workflow) => unknown];

// policy が strategy / --shard を照合するので、変異は判定を変える。
function redMutants(id: string, mutants: readonly Mutant[]): void {
  for (const [label, mutator] of mutants) {
    it(`${id}: rejects ${label}`, () => {
      expect(addedBy(mutated(mutator)).length).toBeGreaterThan(0);
    });
  }
}

describe("Issue #1063 Windows leg 3 shard contract (登録 + Red)", () => {
  it("CANDIDATE-U-CISHARD-001: accepts the exact 3 shard matrix workflow", () => {
    expect(findings(compliantWorkflow())).toEqual([]);
  });

  redMutants("CANDIDATE-U-CISHARD-001", [
    ["2 shards", (w) => (matrixOf(w).shard = ["1/3", "2/3"])],
    ["4 shards", (w) => (matrixOf(w).shard = ["1/3", "2/3", "3/3", "4/3"])],
    ["2/4 instead of 2/3", (w) => (matrixOf(w).shard = ["1/3", "2/4", "3/3"])],
    ["reordered shards", (w) => (matrixOf(w).shard = ["3/3", "2/3", "1/3"])],
    ["matrix include", (w) => (matrixOf(w).include = [{ shard: "4/3" }])],
    ["matrix exclude", (w) => (matrixOf(w).exclude = [{ shard: "2/3" }])],
    [
      "dynamic matrix (fromJSON)",
      (w) => (matrixOf(w).shard = `${EXPR_OPEN}fromJSON(needs.plan.outputs.shards)${EXPR_CLOSE}`),
    ],
  ]);

  redMutants("CANDIDATE-U-CISHARD-002", [
    ["fail-fast true", (w) => (strategyOf(w)["fail-fast"] = true)],
    ["fail-fast removed", (w) => delete strategyOf(w)["fail-fast"]],
  ]);

  // 002 のうち、今日すでに成り立つ skip 禁止は対照 (it) として固定する。
  it("CANDIDATE-U-CISHARD-002: keeps rejecting a job-level if on the Windows leg", () => {
    const reasons = addedReasons(mutated((w) => (job(w, WINDOWS).if = "github.ref == 'main'")));
    expect(reasons).toContain("forbidden_job_level_lane_skip");
  });

  it("CANDIDATE-U-CISHARD-002: keeps rejecting a shard-conditional skip on the test step", () => {
    const reasons = addedReasons(
      mutated((w) => {
        testStep(w).if =
          `${EXPR_OPEN}steps.classify.outputs.lane == 'full' && matrix.shard != '2/3'${EXPR_CLOSE}`;
      }),
    );
    expect(reasons).toContain("forbidden_lane_skip_step");
  });

  it("CANDIDATE-U-CISHARD-002: keeps rejecting continue-on-error on the Windows leg", () => {
    const added = addedBy(mutated((w) => (job(w, WINDOWS)["continue-on-error"] = true)));
    expect(added.length).toBeGreaterThan(0);
  });

  redMutants("CANDIDATE-U-CISHARD-003", [
    ["test step without --shard", (w) => changeTestCommand(w, SHARD_ARGUMENT, "")],
    ["fixed --shard=1/3", (w) => changeTestCommand(w, SHARD_ARGUMENT, "--shard=1/3")],
    ["--shard with a space separator", (w) => changeTestCommand(w, "--shard=", "--shard ")],
  ]);

  it("CANDIDATE-U-CISHARD-003: keeps rejecting raw vitest in place of the sealed runner", () => {
    const added = addedBy(
      mutated((w) => changeTestCommand(w, "npm run test:windows --", "npx vitest run")),
    );
    expect(added.length).toBeGreaterThan(0);
  });

  redMutants("CANDIDATE-U-CISHARD-004", [
    [
      "an extra key (timeout-minutes) on the Windows leg",
      (w) => (job(w, WINDOWS)["timeout-minutes"] = 60),
    ],
  ]);

  for (const other of ["harness-check-linux", "node-generation-linux", "node-generation-windows"]) {
    it(`CANDIDATE-U-CISHARD-004: keeps rejecting a strategy on ${other}`, () => {
      const added = addedBy(
        mutated((w) => (job(w, other).strategy = { matrix: { shard: ["1/3", "2/3", "3/3"] } })),
      );
      expect(
        added.some(
          (finding) => finding.reason === "missing_runtime_leg" && finding.detail.includes(other),
        ),
      ).toBe(true);
    });
  }

  it("U-CISHARD-010: rejects a shard argument on the Linux regression step", () => {
    const workflow = mutated((candidate) => {
      const step = job(candidate, "harness-check-linux").steps?.find(
        (entry) => entry.name === "test — 全回帰 (vitest run)",
      );
      if (step?.run !== "npm run test") throw new Error("fixture must contain the Linux test step");
      step.run = "npm run test -- --shard=1/3";
    });
    expect(
      addedBy(workflow).some(
        ({ reason, detail }) =>
          reason === "missing_runtime_leg" && detail.includes("harness-check-linux.steps"),
      ),
    ).toBe(true);
  });

  it("requires the Windows evidence upload on every full shard", () => {
    const workflow = mutated((candidate) => {
      const windows = job(candidate, WINDOWS);
      windows.steps = windows.steps?.filter(({ name }) => name !== "upload Windows shard evidence");
    });
    expect(addedReasons(workflow)).toContain("missing_runtime_leg");
  });

  it("requires the aggregate to download shard evidence before admission", () => {
    const workflow = mutated((candidate) => {
      const steps = job(candidate, "harness-check").steps ?? [];
      const download = steps.findIndex(({ name }) => name === "download Windows shard evidence");
      if (download < 0) throw new Error("fixture must contain the Windows evidence download");
      steps.push(...steps.splice(download, 1));
    });
    expect(addedReasons(workflow)).toContain("missing_aggregate_result_guard");
  });

  describe("CANDIDATE-U-CISHARD-005: aggregate keeps requiring every runtime leg", () => {
    const windowsGuard = `test "${EXPR_OPEN}needs.${WINDOWS}.result${EXPR_CLOSE}" = "success"`;
    const aggregateRun = (w: Workflow): Step => {
      const step = job(w, "harness-check").steps?.find((candidate) => candidate.run);
      if (!step) throw new Error("aggregate must carry a run step");
      return step;
    };

    it("CANDIDATE-U-CISHARD-005: rejects an aggregate without the Windows result guard", () => {
      const reasons = addedReasons(
        mutated((w) => {
          const step = aggregateRun(w);
          step.run = String(step.run).replace(`${windowsGuard} && `, "");
        }),
      );
      expect(reasons).toContain("missing_aggregate_result_guard");
    });

    it("CANDIDATE-U-CISHARD-005: rejects an aggregate that relaxes success to != failure", () => {
      const reasons = addedReasons(
        mutated((w) => {
          const step = aggregateRun(w);
          step.run = String(step.run).replace(
            windowsGuard,
            windowsGuard.replace(" = ", " != ").replace('"success"', '"failure"'),
          );
        }),
      );
      expect(reasons).toContain("missing_aggregate_result_guard");
    });

    it("CANDIDATE-U-CISHARD-005: rejects an aggregate without always()", () => {
      const reasons = addedReasons(mutated((w) => delete job(w, "harness-check").if));
      expect(reasons).toContain("missing_aggregate_always");
    });

    it("CANDIDATE-U-CISHARD-005: rejects an aggregate that stops needing the Windows leg", () => {
      const reasons = addedReasons(
        mutated((w) => {
          const aggregate = job(w, "harness-check");
          aggregate.needs = (aggregate.needs as string[]).filter((need) => need !== WINDOWS);
        }),
      );
      expect(reasons).toContain("invalid_aggregate_needs");
    });

    it.each([
      "failure",
      "cancelled",
      "skipped",
      undefined,
    ])("CANDIDATE-U-CISHARD-005: does not pass when the Windows matrix result is %s", (windowsResult) => {
      const results: Record<string, string> = {
        "harness-check-linux": "success",
        ...(windowsResult === undefined ? {} : { [WINDOWS]: windowsResult }),
      };
      expect(aggregateHarnessResultsPass(results)).toBe(false);
    });
  });
});
