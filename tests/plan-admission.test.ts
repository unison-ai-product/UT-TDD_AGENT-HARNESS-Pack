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

  it("U-ISSUEBIND-002 (policy): projection_state=unprojected はForward外escapeの必須Issueを満たす (§2.1/§2.4)", () => {
    const decision = evaluatePlanAdmission({
      ...forward,
      routeSignal: "feature_addition",
      routeMode: "add-feature",
      kind: "add-design",
      layer: "L6",
      branch: "work/add-feature-admission",
      issue: {
        provider: "github",
        issueId: 690,
        episodeId: "E4-690",
        projectionState: "unprojected",
      },
      origin: { planId: "PLAN-L4-24", revision: 1, digest: "sha256:def" },
      reentry: { targetPlanId: "PLAN-L4-24", targetRevision: 2, phase: "forward_merge" },
      escapeReason: "issue binding contract",
    });
    expect(decision).toMatchObject({ ok: true, issueRequired: true });
  });

  it("CANDIDATE-U-ISSUEBIND (policy): issueId/episodeId欠落は projection_state に関わらず必須Issueを満たさない", () => {
    const decision = evaluatePlanAdmission({
      ...forward,
      routeSignal: "feature_addition",
      routeMode: "add-feature",
      kind: "add-design",
      layer: "L6",
      branch: "work/add-feature-admission",
      issue: {
        provider: "github",
        issueId: 690,
        episodeId: "",
        projectionState: "unprojected",
      },
      origin: { planId: "PLAN-L4-24", revision: 1, digest: "sha256:def" },
      reentry: { targetPlanId: "PLAN-L4-24", targetRevision: 2, phase: "forward_merge" },
      escapeReason: "issue binding contract",
    });
    expect(decision.ok).toBe(false);
    expect(decision.ok ? [] : decision.violations.map((v) => v.code)).toContain(
      "plan-admission-issue-required",
    );
  });

  it("CANDIDATE-U-ISSUEBIND (policy): projection_state=projected + digest はForward外escapeを許可する (legacy caller互換)", () => {
    const decision = evaluatePlanAdmission({
      ...forward,
      routeSignal: "feature_addition",
      routeMode: "add-feature",
      kind: "add-design",
      layer: "L6",
      branch: "work/add-feature-admission",
      issue: {
        provider: "github",
        issueId: 690,
        episodeId: "E4-690",
        projectionState: "projected",
        projectionDigest: "sha256:abc",
      },
      origin: { planId: "PLAN-L4-24", revision: 1, digest: "sha256:def" },
      reentry: { targetPlanId: "PLAN-L4-24", targetRevision: 2, phase: "forward_merge" },
      escapeReason: "issue binding contract",
    });
    expect(decision).toMatchObject({ ok: true, issueRequired: true });
  });

  it("U-ISSUEBIND-002 (policy): projection_state=unprojected と全ゼロdigestの併存はForward外escapeを拒否する (#690補正)", () => {
    // mutation: `!hasProjectionDigest` を `true` に固定すると本テストが green のまま通ってしまう
    // (unprojected+digest を admit してしまう回帰を検出できない) ため、下の projectionDigest あり
    // ケースと対で both を維持する。
    const decision = evaluatePlanAdmission({
      ...forward,
      routeSignal: "feature_addition",
      routeMode: "add-feature",
      kind: "add-design",
      layer: "L6",
      branch: "work/add-feature-admission",
      issue: {
        provider: "github",
        issueId: 690,
        episodeId: "E4-690",
        projectionState: "unprojected",
        projectionDigest: `sha256:${"0".repeat(64)}`,
      },
      origin: { planId: "PLAN-L4-24", revision: 1, digest: "sha256:def" },
      reentry: { targetPlanId: "PLAN-L4-24", targetRevision: 2, phase: "forward_merge" },
      escapeReason: "issue binding contract",
    });
    expect(decision.ok).toBe(false);
    expect(decision.ok ? [] : decision.violations.map((v) => v.code)).toContain(
      "plan-admission-issue-required",
    );
  });

  it("U-ISSUEBIND-002 (policy): projection_state=unprojected と実digestの併存はForward外escapeを拒否する (#690補正)", () => {
    // mutation: `hasProjectionDigest` の判定を削除して impliedProjectionState のみで分岐すると、
    // unprojected + 実digest が admit されてしまう。本テストはそれを検出する。
    const decision = evaluatePlanAdmission({
      ...forward,
      routeSignal: "feature_addition",
      routeMode: "add-feature",
      kind: "add-design",
      layer: "L6",
      branch: "work/add-feature-admission",
      issue: {
        provider: "github",
        issueId: 690,
        episodeId: "E4-690",
        projectionState: "unprojected",
        projectionDigest: "sha256:abc",
      },
      origin: { planId: "PLAN-L4-24", revision: 1, digest: "sha256:def" },
      reentry: { targetPlanId: "PLAN-L4-24", targetRevision: 2, phase: "forward_merge" },
      escapeReason: "issue binding contract",
    });
    expect(decision.ok).toBe(false);
    expect(decision.ok ? [] : decision.violations.map((v) => v.code)).toContain(
      "plan-admission-issue-required",
    );
  });

  it("U-ISSUEBIND-002 (policy): projection_state=unprojected と空文字projectionDigestの併存はForward外escapeを拒否する (#690補正)", () => {
    // mutation: `issue?.projectionDigest !== undefined` を `Boolean(issue?.projectionDigest)` に
    // 弱めると、空文字はfalsyなので validIssueBinding が誤ってtrueになる。本テストがそれを検出する。
    const decision = evaluatePlanAdmission({
      ...forward,
      routeSignal: "feature_addition",
      routeMode: "add-feature",
      kind: "add-design",
      layer: "L6",
      branch: "work/add-feature-admission",
      issue: {
        provider: "github",
        issueId: 690,
        episodeId: "E4-690",
        projectionState: "unprojected",
        projectionDigest: "",
      },
      origin: { planId: "PLAN-L4-24", revision: 1, digest: "sha256:def" },
      reentry: { targetPlanId: "PLAN-L4-24", targetRevision: 2, phase: "forward_merge" },
      escapeReason: "issue binding contract",
    });
    expect(decision.ok).toBe(false);
    expect(decision.ok ? [] : decision.violations.map((v) => v.code)).toContain(
      "plan-admission-issue-required",
    );
  });

  it("U-ISSUEBIND-001 (policy): projection_state=projected の全ゼロdigestはForward外escapeを拒否する (#690補正、defence in depth)", () => {
    // mutation: `!ALL_ZERO_PROJECTION_DIGEST_PATTERN.test(...)` の否定を除去すると、全ゼロdigestが
    // admit されてしまう。本テストがそれを検出する。
    const decision = evaluatePlanAdmission({
      ...forward,
      routeSignal: "feature_addition",
      routeMode: "add-feature",
      kind: "add-design",
      layer: "L6",
      branch: "work/add-feature-admission",
      issue: {
        provider: "github",
        issueId: 690,
        episodeId: "E4-690",
        projectionState: "projected",
        projectionDigest: `sha256:${"0".repeat(64)}`,
      },
      origin: { planId: "PLAN-L4-24", revision: 1, digest: "sha256:def" },
      reentry: { targetPlanId: "PLAN-L4-24", targetRevision: 2, phase: "forward_merge" },
      escapeReason: "issue binding contract",
    });
    expect(decision.ok).toBe(false);
    expect(decision.ok ? [] : decision.violations.map((v) => v.code)).toContain(
      "plan-admission-issue-required",
    );
  });
});
