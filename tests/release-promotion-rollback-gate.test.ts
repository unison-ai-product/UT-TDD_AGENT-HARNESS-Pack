import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ReviewRequest } from "../src/feedback/review-dispatch.ts";
import { reviewReceiptDigest } from "../src/kernel/github-closure-receipt.ts";
import type { ReleaseIdentity, ReleaseManifest } from "../src/schema/release-manifest.ts";
import {
  applySealedReleaseAggregate,
  type SealedReleaseAggregatePlan,
} from "../src/setup/release-aggregate-admission.ts";
import type { MaterializedReleaseEntry } from "../src/setup/release-materializer.ts";
import {
  type CanonicalCiEvidence,
  classifyRollbackApply,
  evaluatePromotionGate,
  type PromotionGateInput,
  type QaReleaseGateEvidence,
  type ReviewGateEvidence,
  type RollbackCandidate,
  type RollbackSelectionInput,
  selectRollbackCandidate,
} from "../src/setup/release-promotion-rollback-gate.ts";

const commit = (character: string): string => character.repeat(40);
const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const planRevision = commit("d");

function release(character: string): ReleaseIdentity {
  const artifactSourceCommit = commit(character);
  const artifactSetDigest = digest(character);
  const payload = Buffer.concat([
    Buffer.from("v1", "ascii"),
    Buffer.from([0]),
    Buffer.from(artifactSourceCommit, "ascii"),
    Buffer.from([0]),
    Buffer.from(artifactSetDigest.slice("sha256:".length), "hex"),
  ]);
  return {
    releaseId: `rel-sha256:${createHash("sha256").update(payload).digest("hex")}`,
    materializerVersion: "v1",
    artifactSourceCommit,
    artifactSetDigest,
  };
}

const previous = release("b");
const current = release("a");
const entry = {
  path: "release/manifest.yaml",
  mode: "100644" as const,
  content: new Uint8Array([1]),
};
const manifest: ReleaseManifest = {
  schemaVersion: "v1",
  releases: { [previous.releaseId]: previous, [current.releaseId]: current },
  channels: { canary: previous.releaseId, stable: current.releaseId },
  channelOrder: ["canary", "stable"],
};
const mapping = {
  channel: "stable",
  releaseId: current.releaseId,
  sourceRevision: current.artifactSourceCommit,
  sourcePath: "release/current",
  destinationPath: "pack/current",
};
const plan: SealedReleaseAggregatePlan = {
  kind: "release-aggregate" as const,
  channel: "stable",
  releaseId: current.releaseId,
  sourceRevision: current.artifactSourceCommit,
  destinationPath: mapping.destinationPath,
  expectedDigest: current.artifactSetDigest,
  actualDigest: current.artifactSetDigest,
  entries: [entry],
};
const ci: CanonicalCiEvidence = {
  checkName: "harness-check",
  headSha: current.artifactSourceCommit,
  planRevision,
  legs: { linux: "success", windows: "success", aggregate: "success" },
  evidenceDigest: digest("c"),
  observedAt: "2026-08-20T00:00:00Z",
};
const qa: QaReleaseGateEvidence = {
  releaseId: current.releaseId,
  sourceRevision: current.artifactSourceCommit,
  artifactDigest: current.artifactSetDigest,
  channel: "stable",
  checks: {
    G01: "go",
    G02: "go",
    G03: "go",
    G04: "go",
    G05: "go",
    G06: "go",
    G07: "go",
    G08: "go",
  },
  evidenceDigest: digest("e"),
  observedAt: "2026-08-20T00:01:00Z",
};

function reviewSource(lane: "claim-blind" | "spec-blind"): ReviewGateEvidence["claimBlind"] {
  return {
    planId: "PLAN-L7-494",
    planRevision,
    headSha: current.artifactSourceCommit,
    reviewKind: "cross_agent",
    verdict: "PASS",
    reviewedAt: "2026-08-20T00:02:00Z",
    testsGreenAt: "2026-08-20T00:01:00Z",
    workerModel: "gpt-5.6-luna",
    reviewerModel: "claude-opus-5",
    source: "memory",
    lane,
    attackTrials: 1,
    citations: ["tests/release-promotion-rollback-gate.test.ts"],
  };
}

const claimBlind = reviewSource("claim-blind");
const specBlind = reviewSource("spec-blind");
const reviewSubject = {
  pr: 363,
  memoryId: "MEM-REVIEW-363",
  planId: "PLAN-L7-494",
  authorFamily: "codex" as const,
  reviewerFamily: "claude" as const,
};
const request: ReviewRequest = {
  memoryId: reviewSubject.memoryId,
  pr: reviewSubject.pr,
  exactHead: current.artifactSourceCommit,
  reviewRevision: planRevision,
  authorFamily: reviewSubject.authorFamily,
  requestedAt: "2026-08-20T00:00:00Z",
};
const review = {
  exactHeadSha: current.artifactSourceCommit,
  planRevision,
  request,
  d1: {
    memoryId: "MEM-REVIEW-363",
    pr: 363,
    exactHead: current.artifactSourceCommit,
    reviewRevision: planRevision,
    authorFamily: "codex",
    reviewerFamily: "claude",
    verdict: "PASS",
    state: "merge_ready",
    breaches: [],
    ageMinutes: 1,
    blocking: [],
    reasons: [],
    progressDiagnostics: [],
  },
  d2: {
    ok: true,
    pr: 363,
    headSha: current.artifactSourceCommit,
    verdict: "PASS",
    state: "merge_ready",
    reasons: [],
    authorizedEntry: {
      memoryId: "MEM-REVIEW-363",
      reviewRevision: planRevision,
      reviewerFamily: "claude",
    },
  },
  facts: {
    pr: 363,
    headSha: current.artifactSourceCommit,
    state: "OPEN",
    checksGreen: true,
    evaluatedHeadSha: current.artifactSourceCommit,
  },
  claimBlind,
  specBlind,
} as ReviewGateEvidence & { readonly request: ReviewRequest };

function promotionInput(): PromotionGateInput {
  return {
    manifest,
    currentChannel: "canary",
    currentRelease: previous,
    targetChannel: "stable",
    release: current,
    mapping,
    sealedPlan: plan,
    exactHeadSha: current.artifactSourceCommit,
    planRevision,
    expectedEvidence: {
      ...reviewSubject,
      ciEvidenceDigest: ci.evidenceDigest,
      qaEvidenceDigest: qa.evidenceDigest,
      claimBlindReceiptDigest: reviewReceiptDigest(claimBlind),
      specBlindReceiptDigest: reviewReceiptDigest(specBlind),
    },
    ci,
    qa,
    review,
    attestation: {
      status: "attested",
      releaseId: current.releaseId,
      artifactSourceCommit: current.artifactSourceCommit,
      expectedDigest: current.artifactSetDigest,
      actualDigest: current.artifactSetDigest,
      entries: [entry],
    },
  };
}

function rollbackCandidate(): RollbackCandidate {
  return {
    channel: "canary",
    release: previous,
    plan: {
      ...plan,
      channel: "canary",
      releaseId: previous.releaseId,
      sourceRevision: previous.artifactSourceCommit,
      expectedDigest: previous.artifactSetDigest,
      actualDigest: previous.artifactSetDigest,
    },
    attestation: {
      status: "attested",
      releaseId: previous.releaseId,
      artifactSourceCommit: previous.artifactSourceCommit,
      expectedDigest: previous.artifactSetDigest,
      actualDigest: previous.artifactSetDigest,
      entries: [entry],
    },
    artifactAvailable: true,
  };
}

function rollbackInput(candidates: readonly RollbackCandidate[]): RollbackSelectionInput {
  return {
    manifest,
    currentChannel: "stable",
    current,
    targetChannel: "canary",
    candidates,
    exactHeadSha: current.artifactSourceCommit,
    planRevision,
    expectedReview: {
      ...reviewSubject,
      claimBlindReceiptDigest: reviewReceiptDigest(claimBlind),
      specBlindReceiptDigest: reviewReceiptDigest(specBlind),
    },
    review,
  } as RollbackSelectionInput;
}

function compositionHarness(options: { applyFault?: boolean; restoreFault?: boolean } = {}) {
  const state: { pointer: string; entries: MaterializedReleaseEntry[] } = {
    pointer: previous.releaseId,
    entries: [{ path: "pack/current", mode: "100644" as const, content: new Uint8Array([9]) }],
  };
  const before = structuredClone(state);
  const snapshotDestination = vi.fn(async () => structuredClone(state.entries));
  const writeStaging = vi.fn(async (sealedPlan: SealedReleaseAggregatePlan) => sealedPlan);
  const applyDestination = vi.fn(
    async (_stage: SealedReleaseAggregatePlan, sealedPlan: SealedReleaseAggregatePlan) => {
      state.entries = structuredClone([...sealedPlan.entries]);
      if (options.applyFault) throw new Error("apply fault");
    },
  );
  const discardStaging = vi.fn(async () => undefined);
  const restoreDestination = vi.fn(async (snapshot: readonly MaterializedReleaseEntry[]) => {
    if (options.restoreFault) throw new Error("restore fault");
    state.entries = structuredClone([...snapshot]);
  });
  const pointerWrite = vi.fn((releaseId: string) => {
    state.pointer = releaseId;
  });
  const publish = vi.fn();
  return {
    state,
    before,
    pointerWrite,
    publish,
    dependencies: {
      snapshotDestination,
      writeStaging,
      applyDestination,
      discardStaging,
      restoreDestination,
    },
  };
}

async function runPromotionComposition(input: PromotionGateInput, harness = compositionHarness()) {
  const gate = evaluatePromotionGate(input);
  if (gate.decision === "deny") return { result: gate, harness };
  const applied = classifyRollbackApply(
    await applySealedReleaseAggregate(input.sealedPlan, harness.dependencies),
  );
  if (applied.decision === "allow") {
    harness.pointerWrite(gate.releaseId);
    harness.publish(gate);
  }
  return { result: applied, harness };
}

async function runRollbackComposition(input: unknown, harness = compositionHarness()) {
  const selected = selectRollbackCandidate(input);
  if (selected.decision === "deny") return { result: selected, harness };
  const applied = classifyRollbackApply(
    await applySealedReleaseAggregate(selected.candidate.plan, harness.dependencies),
  );
  if (applied.decision === "allow") {
    harness.pointerWrite(selected.candidate.release.releaseId);
    harness.publish(selected);
  }
  return { result: applied, harness };
}

async function deniedComposition(input: PromotionGateInput) {
  return runPromotionComposition(input);
}

function expectNoEffects(run: Awaited<ReturnType<typeof deniedComposition>>): void {
  expect(run.result.decision).toBe("deny");
  expect(run.harness.dependencies.snapshotDestination).not.toHaveBeenCalled();
  expect(run.harness.dependencies.writeStaging).not.toHaveBeenCalled();
  expect(run.harness.dependencies.applyDestination).not.toHaveBeenCalled();
  expect(run.harness.dependencies.restoreDestination).not.toHaveBeenCalled();
  expect(run.harness.pointerWrite).not.toHaveBeenCalled();
  expect(run.harness.publish).not.toHaveBeenCalled();
  expect(run.harness.state).toEqual(run.harness.before);
}

describe("S3 promotion / rollback pure gate", () => {
  it("U-RELMAN-003: canonical CI/QA/review欠落・subject driftをtyped denyしside effect 0", async () => {
    expect(evaluatePromotionGate(promotionInput()).decision).toBe("allow");
    const allowed = await runPromotionComposition(promotionInput());
    expect(allowed.result.decision).toBe("allow");
    expect(allowed.harness.dependencies.applyDestination).toHaveBeenCalledOnce();
    expect(allowed.harness.pointerWrite).toHaveBeenCalledOnce();
    expect(allowed.harness.publish).toHaveBeenCalledOnce();
    const passWeakClaim = { ...claimBlind, verdict: "PASS-WEAK", attackTrials: 3 };
    const passWeakSpec = { ...specBlind, verdict: "PASS-WEAK", attackTrials: 3 };
    const independentVerdicts: PromotionGateInput[] = [
      { ...promotionInput(), review: { ...review, d1: { ...review.d1, verdict: "PASS-WEAK" } } },
      { ...promotionInput(), review: { ...review, d2: { ...review.d2, verdict: "PASS-WEAK" } } },
      {
        ...promotionInput(),
        review: { ...review, claimBlind: passWeakClaim },
        expectedEvidence: {
          ...promotionInput().expectedEvidence,
          claimBlindReceiptDigest: reviewReceiptDigest(passWeakClaim),
        },
      },
      {
        ...promotionInput(),
        review: { ...review, specBlind: passWeakSpec },
        expectedEvidence: {
          ...promotionInput().expectedEvidence,
          specBlindReceiptDigest: reviewReceiptDigest(passWeakSpec),
        },
      },
    ];
    for (const independent of independentVerdicts) {
      expect(evaluatePromotionGate(independent).decision).toBe("allow");
    }
    expect(evaluatePromotionGate({ ...promotionInput(), ci: undefined })).toMatchObject({
      decision: "deny",
      reason: "ci_missing",
    });
    expect(evaluatePromotionGate({ ...promotionInput(), qa: undefined })).toMatchObject({
      decision: "deny",
      reason: "qa_missing",
    });
    expect(evaluatePromotionGate({ ...promotionInput(), review: undefined })).toMatchObject({
      decision: "deny",
      reason: "review_missing",
    });

    const shiftedHead = commit("f");
    const shiftedClaim = { ...claimBlind, headSha: shiftedHead };
    const shiftedSpec = { ...specBlind, headSha: shiftedHead };
    const staleReview: ReviewGateEvidence = {
      ...review,
      exactHeadSha: shiftedHead,
      request: { ...request, exactHead: shiftedHead },
      d1: { ...review.d1, exactHead: shiftedHead },
      d2: { ...review.d2, headSha: shiftedHead },
      facts: { ...review.facts, headSha: shiftedHead, evaluatedHeadSha: shiftedHead },
      claimBlind: shiftedClaim,
      specBlind: shiftedSpec,
    };
    const stale: PromotionGateInput = {
      ...promotionInput(),
      exactHeadSha: shiftedHead,
      ci: { ...ci, headSha: shiftedHead },
      review: staleReview,
      expectedEvidence: {
        ...promotionInput().expectedEvidence,
        claimBlindReceiptDigest: reviewReceiptDigest(shiftedClaim),
        specBlindReceiptDigest: reviewReceiptDigest(shiftedSpec),
      },
    };
    expect(evaluatePromotionGate(stale).decision).toBe("allow");

    const drift = await deniedComposition({
      ...promotionInput(),
      ci: { ...ci, headSha: shiftedHead },
    });
    expect(drift.result).toMatchObject({ decision: "deny", reason: "identity_mismatch" });
    expectNoEffects(drift);

    const shiftedClaimOnly = { ...claimBlind, headSha: shiftedHead };
    const shiftedSpecOnly = { ...specBlind, headSha: shiftedHead };
    const subjectMutations: PromotionGateInput[] = [
      { ...promotionInput(), review: { ...review, d1: { ...review.d1, exactHead: shiftedHead } } },
      { ...promotionInput(), review: { ...review, d2: { ...review.d2, headSha: shiftedHead } } },
      {
        ...promotionInput(),
        review: { ...review, facts: { ...review.facts, headSha: shiftedHead } },
      },
      {
        ...promotionInput(),
        review: { ...review, claimBlind: shiftedClaimOnly },
        expectedEvidence: {
          ...promotionInput().expectedEvidence,
          claimBlindReceiptDigest: reviewReceiptDigest(shiftedClaimOnly),
        },
      },
      {
        ...promotionInput(),
        review: { ...review, specBlind: shiftedSpecOnly },
        expectedEvidence: {
          ...promotionInput().expectedEvidence,
          specBlindReceiptDigest: reviewReceiptDigest(shiftedSpecOnly),
        },
      },
    ];
    for (const mutation of subjectMutations) {
      const subjectRun = await deniedComposition(mutation);
      expect(subjectRun.result).toMatchObject({ decision: "deny", reason: "identity_mismatch" });
      expectNoEffects(subjectRun);
    }
  });

  it("U-RELMAN-004: 同じrollback入力は同一pointer delta/digestへ収束しapply 0", () => {
    const input = rollbackInput([rollbackCandidate()]);
    const first = selectRollbackCandidate(input);
    const second = selectRollbackCandidate(input);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ decision: "allow", pointerDelta: { channel: "stable" } });
    expect(first).not.toHaveProperty("apply");
  });

  it("U-RELMAN-005: rollback選択結果はGit commandを生成・実行しない", () => {
    const result = selectRollbackCandidate(rollbackInput([rollbackCandidate()]));
    expect(result.decision).toBe("allow");
    expect(result).not.toHaveProperty("command");
  });

  it("U-RELMAN-008: runtime上のQA no-goをcastなしで拒否しprior stateを維持", async () => {
    const noGo: QaReleaseGateEvidence = { ...qa, checks: { ...qa.checks, G04: "no-go" } };
    const run = await deniedComposition({ ...promotionInput(), qa: noGo });
    expect(run.result).toMatchObject({ decision: "deny", reason: "qa_no_go" });
    expectNoEffects(run);
  });

  it("U-RELMAN-010: D2 merge_readyなしではpromotion/rollbackを拒否しPF5 port 0", async () => {
    const d2Mutations: ReviewGateEvidence[] = [
      { ...review, d2: { ...review.d2, ok: false } },
      { ...review, d2: { ...review.d2, state: "in_review" } },
      { ...review, d2: { ...review.d2, reasons: ["review_pending"] } },
    ];
    for (const notReady of d2Mutations) {
      const run = await deniedComposition({ ...promotionInput(), review: notReady });
      expect(run.result).toMatchObject({ decision: "deny", reason: "review_missing" });
      expectNoEffects(run);
      const rollbackRun = await runRollbackComposition({
        ...rollbackInput([rollbackCandidate()]),
        review: notReady,
      });
      expect(rollbackRun.result).toMatchObject({ decision: "deny", reason: "invalid_input" });
      expectNoEffects(rollbackRun);
    }
    const rollbackRun = await runRollbackComposition({
      ...rollbackInput([rollbackCandidate()]),
      review: { ...review, d2: undefined },
    });
    expect(rollbackRun.result).toMatchObject({ decision: "deny", reason: "invalid_input" });
    expectNoEffects(rollbackRun);
  });

  it("U-RELMAN-019: release/source/digest/materializer/channelの各identity driftを拒否", async () => {
    const inputs: PromotionGateInput[] = [
      { ...promotionInput(), release: { ...current, releaseId: previous.releaseId } },
      {
        ...promotionInput(),
        mapping: { ...mapping, sourceRevision: previous.artifactSourceCommit },
      },
      { ...promotionInput(), qa: { ...qa, artifactDigest: previous.artifactSetDigest } },
      { ...promotionInput(), release: { ...current, materializerVersion: "v2" } },
      { ...promotionInput(), mapping: { ...mapping, channel: "canary" } },
    ];
    for (const input of inputs) {
      const run = await deniedComposition(input);
      expect(run.result).toMatchObject({ decision: "deny", reason: "identity_mismatch" });
      expectNoEffects(run);
    }
  });

  it("U-RELMAN-020: evidence unavailable/stale/digest driftをprecedenceどおりfail-close", async () => {
    const cases: Array<[PromotionGateInput, string]> = [
      [{ ...promotionInput(), ci: { ...ci, evidenceDigest: digest("f") } }, "identity_mismatch"],
      [{ ...promotionInput(), qa: { ...qa, evidenceDigest: digest("f") } }, "identity_mismatch"],
      [
        {
          ...promotionInput(),
          expectedEvidence: {
            ...promotionInput().expectedEvidence,
            claimBlindReceiptDigest: "0".repeat(64),
          },
        },
        "identity_mismatch",
      ],
      [
        { ...promotionInput(), qa: { ...qa, observedAt: "2026-08-19T23:59:59Z" } },
        "identity_mismatch",
      ],
      [
        { ...promotionInput(), sealedPlan: { ...plan, actualDigest: previous.artifactSetDigest } },
        "identity_mismatch",
      ],
      [
        {
          ...promotionInput(),
          review: { ...review, facts: { ...review.facts, evaluatedHeadSha: commit("f") } },
        },
        "identity_mismatch",
      ],
      [
        { ...promotionInput(), attestation: { status: "unavailable", reason: "unavailable" } },
        "attestation_unavailable",
      ],
    ];
    for (const [input, reason] of cases) {
      const run = await deniedComposition(input);
      expect(run.result).toMatchObject({ decision: "deny", reason });
      expectNoEffects(run);
    }
    const splicedReviews: ReviewGateEvidence[] = [
      { ...review, d1: { ...review.d1, pr: 999 } },
      { ...review, d2: { ...review.d2, pr: 888 } },
      { ...review, facts: { ...review.facts, pr: 777 } },
      {
        ...review,
        d2: {
          ...review.d2,
          authorizedEntry: {
            memoryId: "MEM-OTHER",
            reviewRevision: planRevision,
            reviewerFamily: "claude",
          },
        },
      },
      {
        ...review,
        d2: {
          ...review.d2,
          authorizedEntry: {
            memoryId: "MEM-REVIEW-363",
            reviewRevision: commit("f"),
            reviewerFamily: "claude",
          },
        },
      },
      {
        ...review,
        d2: {
          ...review.d2,
          authorizedEntry: {
            memoryId: "MEM-REVIEW-363",
            reviewRevision: planRevision,
            reviewerFamily: "codex",
          },
        },
      },
      { ...review, d1: { ...review.d1, authorFamily: "claude" } },
      { ...review, d1: { ...review.d1, reviewerFamily: "codex" } },
    ];
    for (const spliced of splicedReviews) {
      expect(evaluatePromotionGate({ ...promotionInput(), review: spliced })).toMatchObject({
        decision: "deny",
        reason: "identity_mismatch",
      });
    }
    const splicedClaim = { ...claimBlind, planId: "PLAN-OTHER" };
    const splicedSpec = { ...specBlind, planId: "PLAN-OTHER" };
    const foreignPlanRevision = commit("f");
    const coherentSplice: ReviewGateEvidence = {
      ...review,
      request: { ...review.request, reviewRevision: foreignPlanRevision },
      d1: {
        ...review.d1,
        pr: 999,
        memoryId: "MEM-OTHER",
        reviewRevision: foreignPlanRevision,
      },
      d2: {
        ...review.d2,
        pr: 999,
        authorizedEntry: {
          memoryId: "MEM-OTHER",
          reviewRevision: foreignPlanRevision,
          reviewerFamily: "claude",
        },
      },
      facts: { ...review.facts, pr: 999 },
      claimBlind: splicedClaim,
      specBlind: splicedSpec,
    };
    expect(
      evaluatePromotionGate({
        ...promotionInput(),
        review: coherentSplice,
        expectedEvidence: {
          ...promotionInput().expectedEvidence,
          pr: 999,
          memoryId: "MEM-OTHER",
          planId: "PLAN-OTHER",
          claimBlindReceiptDigest: reviewReceiptDigest(splicedClaim),
          specBlindReceiptDigest: reviewReceiptDigest(splicedSpec),
        },
      }),
    ).toMatchObject({ decision: "deny", reason: "identity_mismatch" });

    // revision-only splice: every other review identity remains canonical.  This
    // independent case must kill the source mutant that removes the direct
    // request.reviewRevision -> subject.planRevision binding.
    const revisionOnlyForeign = commit("e");
    const revisionOnlySplice: ReviewGateEvidence = {
      ...review,
      request: { ...review.request, reviewRevision: revisionOnlyForeign },
      d1: { ...review.d1, reviewRevision: revisionOnlyForeign },
      d2: {
        ...review.d2,
        authorizedEntry: {
          memoryId: reviewSubject.memoryId,
          reviewRevision: revisionOnlyForeign,
          reviewerFamily: reviewSubject.reviewerFamily,
        },
      },
    };
    const revisionOnlyInput = { ...promotionInput(), review: revisionOnlySplice };
    expect(evaluatePromotionGate(revisionOnlyInput)).toMatchObject({
      decision: "deny",
      reason: "identity_mismatch",
    });
    expectNoEffects(await deniedComposition(revisionOnlyInput));

    const otherPlanClaim = { ...claimBlind, planId: "PLAN-OTHER" };
    expect(
      evaluatePromotionGate({
        ...promotionInput(),
        review: { ...review, claimBlind: otherPlanClaim },
        expectedEvidence: {
          ...promotionInput().expectedEvidence,
          claimBlindReceiptDigest: reviewReceiptDigest(otherPlanClaim),
        },
      }),
    ).toMatchObject({ decision: "deny", reason: "identity_mismatch" });
    const wrongWorker = { ...claimBlind, workerModel: "claude-sonnet-5" };
    const wrongReviewer = { ...specBlind, reviewerModel: "gpt-5.6-sol" };
    for (const [changedReview, expectedEvidence] of [
      [
        { ...review, claimBlind: wrongWorker },
        {
          ...promotionInput().expectedEvidence,
          claimBlindReceiptDigest: reviewReceiptDigest(wrongWorker),
        },
      ],
      [
        { ...review, specBlind: wrongReviewer },
        {
          ...promotionInput().expectedEvidence,
          specBlindReceiptDigest: reviewReceiptDigest(wrongReviewer),
        },
      ],
    ] as const) {
      expect(
        evaluatePromotionGate({ ...promotionInput(), review: changedReview, expectedEvidence }),
      ).toMatchObject({ decision: "deny", reason: "identity_mismatch" });
    }
    const claimInWrongLane = { ...claimBlind, lane: "spec-blind" as const };
    expect(
      evaluatePromotionGate({
        ...promotionInput(),
        review: { ...review, claimBlind: claimInWrongLane },
        expectedEvidence: {
          ...promotionInput().expectedEvidence,
          claimBlindReceiptDigest: reviewReceiptDigest(claimInWrongLane),
        },
      }),
    ).toMatchObject({ decision: "deny", reason: "identity_mismatch" });
    const mismatchAttestation = {
      status: "mismatch" as const,
      releaseId: current.releaseId,
      artifactSourceCommit: current.artifactSourceCommit,
      expectedDigest: current.artifactSetDigest,
      actualDigest: current.artifactSetDigest,
    };
    const nonAttestedIdentityMutations = [
      { ...mismatchAttestation, releaseId: previous.releaseId },
      { ...mismatchAttestation, artifactSourceCommit: previous.artifactSourceCommit },
      { ...mismatchAttestation, expectedDigest: previous.artifactSetDigest },
      { ...mismatchAttestation, actualDigest: previous.artifactSetDigest },
    ];
    for (const attestation of nonAttestedIdentityMutations) {
      expect(evaluatePromotionGate({ ...promotionInput(), attestation })).toMatchObject({
        decision: "deny",
        reason: "identity_mismatch",
      });
    }
    const precedenceCases: Array<[unknown, string]> = [
      [{ ...promotionInput(), exactHeadSha: "bad", ci: undefined }, "invalid_input"],
      [
        {
          ...promotionInput(),
          ci: undefined,
          mapping: { ...mapping, releaseId: previous.releaseId },
        },
        "identity_mismatch",
      ],
      [{ ...promotionInput(), ci: undefined, qa: undefined }, "ci_missing"],
    ];
    for (const [input, reason] of precedenceCases) {
      expect(evaluatePromotionGate(input)).toMatchObject({
        decision: "deny",
        reason,
      });
    }
    const malformedReviews: unknown[] = [
      { ...review, request: null },
      { ...review, request: { ...request, pr: "363" } },
      { ...review, d1: { ...review.d1, blocking: null } },
      { ...review, d1: { ...review.d1, breaches: null } },
      { ...review, d1: { ...review.d1, reasons: null } },
      { ...review, d1: { ...review.d1, progressDiagnostics: null } },
      { ...review, d2: { ...review.d2, reasons: null } },
      { ...review, facts: { ...review.facts, checksGreen: "true" } },
      { ...review, claimBlind: { ...claimBlind, verdict: null } },
      { ...review, claimBlind: { ...claimBlind, citations: null } },
      { ...review, specBlind: { ...specBlind, citations: [null] } },
      {
        ...review,
        d2: {
          ...review.d2,
          authorizedEntry: {
            memoryId: reviewSubject.memoryId,
            reviewRevision: planRevision,
            reviewerFamily: null,
          },
        },
      },
    ];
    for (const malformed of malformedReviews) {
      const input = { ...promotionInput(), review: malformed };
      expect(() => evaluatePromotionGate(input)).not.toThrow();
      expect(evaluatePromotionGate(input)).toMatchObject({
        decision: "deny",
        reason: "invalid_input",
      });
    }
    const malformedPlans: unknown[] = [
      { ...plan, kind: "other" },
      { ...plan, destinationPath: null },
      { ...plan, entries: null },
      { ...plan, entries: [{ ...entry, path: null }] },
      { ...plan, entries: [{ ...entry, mode: "100600" }] },
      { ...plan, entries: [{ ...entry, content: [1] }] },
    ];
    for (const sealedPlan of malformedPlans) {
      expect(evaluatePromotionGate({ ...promotionInput(), sealedPlan })).toMatchObject({
        decision: "deny",
        reason: "invalid_input",
      });
    }
    const oldObservation: PromotionGateInput = {
      ...promotionInput(),
      ci: { ...ci, observedAt: "2020-01-01T00:00:00Z" },
      qa: { ...qa, observedAt: "2020-01-01T00:00:00Z" },
    };
    expect(evaluatePromotionGate(oldObservation).decision).toBe("allow");
  });

  it("U-RELMAN-021: rollback候補の0/複数/attestation/identity/artifact可用性を拒否", async () => {
    const candidate = rollbackCandidate();
    expect(selectRollbackCandidate(rollbackInput([]))).toMatchObject({
      decision: "deny",
      reason: "candidate_missing",
    });
    expect(selectRollbackCandidate(rollbackInput([candidate, candidate]))).toMatchObject({
      decision: "deny",
      reason: "candidate_ambiguous",
    });
    expect(
      selectRollbackCandidate(rollbackInput([{ ...candidate, attestation: undefined }])),
    ).toMatchObject({ decision: "deny", reason: "attestation_missing" });
    expect(
      selectRollbackCandidate(rollbackInput([{ ...candidate, release: current }])),
    ).toMatchObject({ decision: "deny", reason: "identity_mismatch" });
    expect(
      selectRollbackCandidate(rollbackInput([{ ...candidate, artifactAvailable: undefined }])),
    ).toMatchObject({ decision: "deny", reason: "artifact_unavailable" });
    expect(() =>
      selectRollbackCandidate({
        ...rollbackInput([]),
        candidates: [null],
      } as unknown as RollbackSelectionInput),
    ).not.toThrow();
    expect(
      selectRollbackCandidate({
        ...rollbackInput([]),
        candidates: [null],
      } as unknown as RollbackSelectionInput),
    ).toMatchObject({ decision: "deny", reason: "invalid_input" });
    expect(
      selectRollbackCandidate(
        rollbackInput([
          {
            ...candidate,
            attestation: {
              status: "mismatch",
              releaseId: current.releaseId,
              artifactSourceCommit: current.artifactSourceCommit,
              expectedDigest: current.artifactSetDigest,
              actualDigest: current.artifactSetDigest,
            },
          },
        ]),
      ),
    ).toMatchObject({ decision: "deny", reason: "identity_mismatch" });
    const deniedRollbackInputs: unknown[] = [
      rollbackInput([]),
      rollbackInput([candidate, candidate]),
      rollbackInput([{ ...candidate, attestation: undefined }]),
      rollbackInput([{ ...candidate, release: current }]),
      rollbackInput([{ ...candidate, artifactAvailable: undefined }]),
      { ...rollbackInput([]), candidates: [null] },
      rollbackInput([
        {
          ...candidate,
          attestation: {
            status: "mismatch",
            releaseId: current.releaseId,
            artifactSourceCommit: current.artifactSourceCommit,
            expectedDigest: current.artifactSetDigest,
            actualDigest: current.artifactSetDigest,
          },
        },
      ]),
    ];
    for (const deniedInput of deniedRollbackInputs) {
      const denied = await runRollbackComposition(deniedInput);
      expect(denied.result.decision).toBe("deny");
      expectNoEffects(denied);
    }
    const invalidRun = await runRollbackComposition({
      ...rollbackInput([]),
      candidates: [null],
    });
    expect(invalidRun.result).toMatchObject({ decision: "deny", reason: "invalid_input" });
    expectNoEffects(invalidRun);
  });

  it("U-RELMAN-022: PF5 injected restore faultをrollback_failed/indeterminateへ分類", async () => {
    const harness = compositionHarness({ applyFault: true, restoreFault: true });
    const run = await runRollbackComposition(rollbackInput([rollbackCandidate()]), harness);
    expect(run.result).toEqual({
      decision: "indeterminate",
      reason: "rollback_failed",
      sideEffects: "none",
    });
    expect(harness.dependencies.applyDestination).toHaveBeenCalledOnce();
    expect(harness.dependencies.restoreDestination).toHaveBeenCalledOnce();
    expect(harness.publish).not.toHaveBeenCalled();
    expect(harness.pointerWrite).not.toHaveBeenCalled();
    expect(harness.state).not.toEqual(harness.before);
  });

  it("U-RELMAN-023: 非隣接/旧pointer/unknown targetを拒否しwrite/publish 0", async () => {
    const nonAdjacent: ReleaseManifest = {
      ...manifest,
      channels: { ...manifest.channels, beta: previous.releaseId },
      channelOrder: ["canary", "beta", "stable"],
    };
    const cases = [
      { ...promotionInput(), manifest: nonAdjacent },
      { ...promotionInput(), currentRelease: current },
      { ...promotionInput(), targetChannel: "unknown" },
    ];
    for (const input of cases) {
      const run = await deniedComposition(input);
      expect(run.result.decision).toBe("deny");
      expectNoEffects(run);
    }
  });
});
