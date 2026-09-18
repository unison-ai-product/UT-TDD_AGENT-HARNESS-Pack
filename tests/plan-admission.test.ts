import { describe, expect, it } from "vitest";
import { evaluatePlanAdmission, type PlanAdmissionRequest } from "../src/plan-admission/policy.ts";

const forward: PlanAdmissionRequest = {
  routeSignal: "forward",
  routeMode: "forward",
  kind: "design",
  layer: "L6",
  subDoc: "function-spec",
  drive: "agent",
  branch: "work/forward-admission",
};

describe("PLAN admission policy", () => {
  it("U-PADM-001: permits a normal Forward PLAN without an Issue", () => {
    expect(evaluatePlanAdmission(forward)).toMatchObject({ ok: true, issueRequired: false });
  });

  it("U-PADM-002: denies unknown or ambiguous signals instead of falling back to Forward", () => {
    const unknown = evaluatePlanAdmission({ ...forward, routeSignal: "unmapped-special-case" });
    expect(unknown).toMatchObject({ ok: false });
    expect(unknown.ok ? [] : unknown.violations.map((v) => v.code)).toContain(
      "plan-admission-unknown-signal",
    );

    const ambiguous = evaluatePlanAdmission({
      ...forward,
      routeSignal: "reverse feature_addition",
    });
    expect(ambiguous).toMatchObject({ ok: false });
  });

  it("U-PADM-003: denies an unlisted correlated tuple and wrong branch", () => {
    const decision = evaluatePlanAdmission({
      ...forward,
      routeMode: "incident",
      kind: "recovery",
      layer: "L7",
    });
    expect(decision).toMatchObject({ ok: false });
    expect(decision.ok ? [] : decision.violations.map((v) => v.code)).toContain(
      "plan-admission-tuple-forbidden",
    );
  });

  it("U-PADM-004: requires an Issue, origin, reason, and reentry for a Forward escape", () => {
    const denied = evaluatePlanAdmission({
      ...forward,
      routeSignal: "feature_addition",
      routeMode: "add-feature",
      kind: "add-design",
      layer: "L6",
      branch: "work/add-feature-admission",
    });
    expect(denied).toMatchObject({ ok: false });
    expect(denied.ok ? [] : denied.violations.map((v) => v.code)).toEqual(
      expect.arrayContaining([
        "plan-admission-issue-required",
        "plan-admission-origin-required",
        "plan-admission-reentry-required",
        "plan-admission-escape-reason-required",
      ]),
    );
  });

  it("U-PADM-005: does not exempt archived authoring", () => {
    const decision = evaluatePlanAdmission({ ...forward, status: "archived" });
    expect(decision.ok).toBe(false);
    expect(decision.ok ? [] : decision.violations.map((v) => v.code)).toContain(
      "plan-admission-archived-forbidden",
    );
  });

  it("U-PADM-006: admits redesign only for a design-to-implementation transition", () => {
    const decision = evaluatePlanAdmission({
      ...forward,
      routeSignal: "design_correction",
      routeMode: "redesign",
      kind: "design",
      layer: "L4",
      branch: "work/redesign-contract",
      issue: {
        provider: "github",
        issueId: 123,
        episodeId: "E4-123",
        projectionDigest: "sha256:abc",
      },
      origin: { planId: "PLAN-L4-24", revision: 2, digest: "sha256:def" },
      transitionDirection: "design_to_implementation",
      implementationDisposition: "discarded",
      reentry: { targetPlanId: "PLAN-L4-24", targetRevision: 3, phase: "forward_merge" },
      implementationTarget: { targetPlanId: "PLAN-L7-435", targetRevision: 1 },
      escapeReason: "audit evidence requires a design correction",
      supersedes: ["PLAN-L4-24"],
    });
    expect(decision).toMatchObject({ ok: true, issueRequired: true });
  });

  it("U-PADM-007: never treats an implementation-to-design transition as redesign", () => {
    const decision = evaluatePlanAdmission({
      ...forward,
      routeSignal: "design_correction",
      routeMode: "redesign",
      kind: "design",
      layer: "L4",
      branch: "work/redesign-contract",
      transitionDirection: "implementation_to_design",
      implementationDisposition: "preserved",
      issue: {
        provider: "github",
        issueId: 123,
        episodeId: "E4-123",
        projectionDigest: "sha256:abc",
      },
      origin: { planId: "PLAN-L4-24", revision: 2, digest: "sha256:def" },
      reentry: { targetPlanId: "PLAN-L4-24", targetRevision: 3, phase: "forward_merge" },
      implementationTarget: { targetPlanId: "PLAN-L7-435", targetRevision: 1 },
      escapeReason: "audit evidence requires a design correction",
      supersedes: ["PLAN-L4-24"],
    });
    expect(decision.ok).toBe(false);
    expect(decision.ok ? [] : decision.violations.map((v) => v.code)).toContain(
      "plan-admission-redesign-direction-required",
    );
  });

  it("U-PADM-008: admits reverse only for an implementation-to-design transition", () => {
    const decision = evaluatePlanAdmission({
      ...forward,
      routeSignal: "reverse",
      routeMode: "reverse",
      kind: "reverse",
      layer: "cross",
      workflowPhase: "R1",
      branch: "work/reverse-design-followup",
      transitionDirection: "implementation_to_design",
      implementationDisposition: "preserved",
      issue: {
        provider: "github",
        issueId: 124,
        episodeId: "E4-124",
        projectionDigest: "sha256:abc",
      },
      origin: { planId: "PLAN-L7-435", revision: 1, digest: "sha256:def" },
      reentry: { targetPlanId: "PLAN-L6-83", targetRevision: 2, phase: "forward_merge" },
      escapeReason: "implementation evidence must be reflected in design",
    });
    expect(decision).toMatchObject({ ok: true, issueRequired: true });
  });

  it("U-PADM-009: rejects a preserved implementation on redesign and a missing implementation on reverse", () => {
    const redesign = evaluatePlanAdmission({
      ...forward,
      routeSignal: "redesign",
      routeMode: "redesign",
      kind: "design",
      layer: "L4",
      branch: "work/redesign-contract",
      transitionDirection: "design_to_implementation",
      implementationDisposition: "preserved",
      issue: {
        provider: "github",
        issueId: 123,
        episodeId: "E4-123",
        projectionDigest: "sha256:abc",
      },
      origin: { planId: "PLAN-L4-24", revision: 2, digest: "sha256:def" },
      reentry: { targetPlanId: "PLAN-L4-24", targetRevision: 3, phase: "forward_merge" },
      implementationTarget: { targetPlanId: "PLAN-L7-435", targetRevision: 1 },
      escapeReason: "audit evidence requires a design correction",
      supersedes: ["PLAN-L4-24"],
    });
    expect(redesign.ok ? [] : redesign.violations.map((v) => v.code)).toContain(
      "plan-admission-redesign-no-preserved-implementation",
    );

    const reverse = evaluatePlanAdmission({
      ...forward,
      routeSignal: "reverse",
      routeMode: "reverse",
      kind: "reverse",
      layer: "cross",
      workflowPhase: "R1",
      branch: "work/reverse-design-followup",
      transitionDirection: "implementation_to_design",
      implementationDisposition: "none",
      issue: {
        provider: "github",
        issueId: 124,
        episodeId: "E4-124",
        projectionDigest: "sha256:abc",
      },
      origin: { planId: "PLAN-L7-435", revision: 1, digest: "sha256:def" },
      reentry: { targetPlanId: "PLAN-L6-83", targetRevision: 2, phase: "forward_merge" },
      escapeReason: "implementation evidence must be reflected in design",
    });
    expect(reverse.ok ? [] : reverse.violations.map((v) => v.code)).toContain(
      "plan-admission-reverse-preserved-implementation-required",
    );
  });
});
