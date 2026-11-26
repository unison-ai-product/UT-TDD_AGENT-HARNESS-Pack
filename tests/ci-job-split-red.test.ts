import { describe, expect, it } from "vitest";
import {
  aggregateMutations,
  aggregateStructureViolations,
  continueOnErrorMutations,
  continueOnErrorViolations,
  githubTrackedPreflight,
  runAggregateGate,
  trackedGithubFiles,
} from "./support/ci-job-split-aggregate.ts";
import {
  cloneWorkflow,
  expectedAggregateNeeds,
  expectedJobByStep,
  expectedSplitJobs,
  extractExecutionPlan,
  linuxJobs,
  manifest,
  mutations,
  planDiffers,
  plansEqual,
  stepPlacementViolations,
  workflow,
} from "./support/ci-job-split-fixture.ts";

function assertSplitJobs(): void {
  expect(Object.keys(workflow.jobs)).toEqual(expect.arrayContaining(expectedSplitJobs));
}

function allSuccess(): Record<string, string> {
  return Object.fromEntries(expectedAggregateNeeds.map((jobId) => [jobId, "success"]));
}

function expectAggregateExit(
  lane: string,
  results: Record<string, string>,
  status: number | "nonzero",
): void {
  const result = runAggregateGate(workflow, results, lane);
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBeNull();
  if (status === "nonzero") expect(result.status).not.toBe(0);
  else expect(result.status, `${result.stdout}${result.stderr}`).toBe(status);
}

describe("Issue #1981 Red: harness-check Linux job split", () => {
  it("precondition: YAML, static manifest, Git/Bash fixtures, and current-YAML mutations are valid", () => {
    expect(githubTrackedPreflight).toMatch(/^git version /);
    expect(trackedGithubFiles.filter((path) => /branch[-_ ]protection/i.test(path))).toEqual([]);
    expect(manifest.full.pull_request).toHaveLength(14);
    expect(manifest.full.push).toHaveLength(12);
    expect(manifest.doc.pull_request).toHaveLength(11);
    expect(manifest.doc.push).toHaveLength(9);

    for (const mutated of mutations.removed)
      expect(planDiffers(mutated, "full", "pull_request")).toBe(true);
    for (const mutated of mutations.condition)
      expect(planDiffers(mutated, "full", "push")).toBe(true);
    expect(planDiffers(mutations.duplicateLint, "full", "push")).toBe(true);
    for (const mutated of mutations.inputs)
      expect(planDiffers(mutated, "full", "pull_request")).toBe(true);

    const unknown = cloneWorkflow();
    const unknownLinux = unknown.jobs["harness-check-linux"];
    if (!unknownLinux) throw new Error("precondition: Linux workflow job missing");
    const unknownSteps = unknownLinux.steps;
    if (!unknownSteps) throw new Error("precondition: Linux workflow steps missing");
    unknownSteps.push({ name: "unmanifested check", run: "true" });
    expect(() => extractExecutionPlan(unknown, "full", "pull_request")).toThrow(
      "unmanifested Linux step: unmanifested check",
    );
    const inheritedEnv = cloneWorkflow();
    const inheritedLinux = inheritedEnv.jobs["harness-check-linux"];
    if (!inheritedLinux) throw new Error("precondition: Linux workflow job missing");
    inheritedLinux.env = { CONTRACT_PROBE: "$" + "{{ github.sha }}" };
    expect(planDiffers(inheritedEnv, "full", "pull_request")).toBe(true);
  });

  it("CANDIDATE-U-CISPLIT-001: fixed pre-split manifest matches all four lane/event plans", () => {
    for (const lane of ["full", "doc"] as const) {
      for (const event of ["pull_request", "push"] as const) {
        expect(plansEqual(extractExecutionPlan(workflow, lane, event), manifest[lane][event])).toBe(
          true,
        );
      }
    }
  });

  it.fails("CANDIDATE-U-CISPLIT-002: required-check removal changes the plan after split", () => {
    for (const mutated of mutations.removed)
      expect(planDiffers(mutated, "full", "pull_request")).toBe(true);
    assertSplitJobs();
  });

  it.fails("CANDIDATE-U-CISPLIT-003: lane/event condition changes alter the plan after split", () => {
    for (const mutated of mutations.condition)
      expect(planDiffers(mutated, "full", "push")).toBe(true);
    assertSplitJobs();
  });

  it.fails("CANDIDATE-U-CISPLIT-004: duplicating a check across Linux jobs changes the plan", () => {
    expect(planDiffers(mutations.duplicateLint, "full", "push")).toBe(true);
    assertSplitJobs();
  });

  it.fails("CANDIDATE-U-CISPLIT-005: command and environment changes alter the plan after split", () => {
    for (const mutated of mutations.inputs)
      expect(planDiffers(mutated, "full", "pull_request")).toBe(true);
    assertSplitJobs();
  });

  it.fails("CANDIDATE-U-CISPLIT-006: aggregate fails for any skipped job in either lane", () => {
    const success = allSuccess();
    for (const lane of ["full", "doc"] as const) {
      expectAggregateExit(lane, success, 0);
      for (const jobId of expectedAggregateNeeds)
        expectAggregateExit(lane, { ...success, [jobId]: "skipped" }, "nonzero");
    }
  });

  it.fails("CANDIDATE-U-CISPLIT-007: aggregate rejects invalid lanes and unsuccessful classify", () => {
    const success = allSuccess();
    for (const lane of ["", "Full", "docs", "unknown"])
      expectAggregateExit(lane, success, "nonzero");
    for (const result of ["failure", "cancelled", "skipped"])
      expectAggregateExit("full", { ...success, classify: result }, "nonzero");
    expectAggregateExit("full", success, 0);
    expectAggregateExit("doc", success, 0);
  });

  it.fails("CANDIDATE-U-CISPLIT-008: aggregate fails on failure or cancellation from any job", () => {
    const success = allSuccess();
    for (const jobId of expectedAggregateNeeds) {
      for (const result of ["failure", "cancelled"])
        expectAggregateExit("full", { ...success, [jobId]: result }, "nonzero");
    }
  });

  it.fails("CANDIDATE-U-CISPLIT-009: aggregate structure and its three mutations are rejected", () => {
    for (const mutated of aggregateMutations)
      expect(aggregateStructureViolations(mutated).length).toBeGreaterThan(0);
    expect(aggregateStructureViolations(workflow)).toEqual([]);
    expect(workflow.jobs["harness-check"]).toBeDefined();
    expect(Object.keys(workflow.jobs)).toEqual(expect.arrayContaining(expectedSplitJobs));
  });

  it.fails("CANDIDATE-U-CISPLIT-010: classify runs once in its Linux job and is consumed through needs", () => {
    const calls = (parsed: typeof workflow) =>
      linuxJobs(parsed).flatMap(([jobId, job]) =>
        (job.steps ?? [])
          .filter((step) => step.run?.includes("github classify-changes"))
          .map(() => jobId),
      );
    expect(calls(mutations.duplicateClassify)).not.toEqual(["classify"]);
    assertSplitJobs();
    expect(calls(workflow)).toEqual(["classify"]);
    const classify = workflow.jobs.classify;
    if (!classify) throw new Error("precondition: classify job missing");
    const classifyStep = classify.steps?.find((step) => step.id === "classify");
    expect(classifyStep?.run).toContain("github classify-changes");
    expect(classify.outputs?.lane).toBe("$" + "{{ steps.classify.outputs.lane }}");
    for (const jobId of [
      "harness-check-pr-discipline",
      "harness-check-static",
      "harness-check-linux",
    ]) {
      const job = workflow.jobs[jobId];
      if (!job) throw new Error(`precondition: split job missing: ${jobId}`);
      expect(job.needs).toEqual(["classify"]);
      expect((job.steps ?? []).some((step) => step.if?.includes("steps.classify"))).toBe(false);
    }
    expect(JSON.stringify(workflow.jobs)).not.toMatch(/outputs\.lane\s*!=/);
  });

  it.fails("CANDIDATE-U-CISPLIT-011: step placement, handoffs, and order match the split", () => {
    expect(stepPlacementViolations(mutations.movedDoctor)).toContain(
      "job:doctor (governance hard gates):harness-check-static",
    );
    expect(stepPlacementViolations(workflow)).toEqual([]);
    for (const [stepName, jobId] of Object.entries(expectedJobByStep)) {
      const matches = linuxJobs(workflow).flatMap(([candidateJob, job]) =>
        (job.steps ?? []).filter((step) => step.name === stepName).map(() => candidateJob),
      );
      expect(matches).toEqual([jobId]);
    }
  });

  it.fails("CANDIDATE-U-CISPLIT-012: step/job continuation mutations fail while explicit false passes", () => {
    for (const mutated of continueOnErrorMutations.mutations)
      expect(continueOnErrorViolations(mutated).length).toBeGreaterThan(0);
    expect(continueOnErrorViolations(continueOnErrorMutations.explicitFalse)).toEqual([]);
    expect(continueOnErrorViolations(workflow)).toEqual([]);
    assertSplitJobs();
  });
});
