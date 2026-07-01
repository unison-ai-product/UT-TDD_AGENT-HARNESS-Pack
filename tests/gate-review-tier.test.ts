import { describe, expect, it } from "vitest";
import {
  evaluateGateReview,
  REQUIRED_CHECKLIST_IDS,
  type ReviewChecklist,
} from "../src/gate/review-tier";
import { isNaiveSelfReviewKind, JUDGMENT_GATES } from "../src/gate/review-tier-policy";

const passingChecklist = (): ReviewChecklist => ({
  items: REQUIRED_CHECKLIST_IDS.map((id) => ({ id, status: "pass", evidence: `${id} checked` })),
});

describe("gate review tier", () => {
  it("loads judgment gate policy from the externalized policy module", () => {
    expect(JUDGMENT_GATES).toContain("G4");
    expect(REQUIRED_CHECKLIST_IDS).toContain("TST");
    expect(isNaiveSelfReviewKind("self-review")).toBe(true);
  });

  it("passes hybrid judgment gate only with cross-agent distinct models", () => {
    const ok = evaluateGateReview({
      gate: "G4",
      mode: "hybrid",
      reviewKind: "cross_agent",
      workerModel: "codex:gpt-5.4",
      reviewerModel: "claude:opus",
    });
    expect(ok.passed).toBe(true);
    expect(ok.cross_agent_review).toBe("available");

    const same = evaluateGateReview({
      gate: "G4",
      mode: "hybrid",
      reviewKind: "cross_agent",
      workerModel: "codex:gpt-5.4",
      reviewerModel: "codex:gpt-5.4",
    });
    expect(same.passed).toBe(false);
    expect(same.messages.join("\n")).toContain("same_model_approval");
  });

  it("rejects same-provider different-model cross-agent review in hybrid mode", () => {
    const result = evaluateGateReview({
      gate: "G4",
      mode: "hybrid",
      reviewKind: "cross_agent",
      workerModel: "claude-opus-4-8",
      reviewerModel: "claude-sonnet-4-6",
    });
    expect(result.passed).toBe(false);
    expect(result.messages.join("\n")).toContain("different providers");
  });

  it("fails single-runtime judgment gate without checklist evidence", () => {
    const result = evaluateGateReview({ gate: "G4", mode: "codex-only" });
    expect(result.passed).toBe(false);
    expect(result.review_kind).toBe("intra_runtime_subagent");
    expect(result.cross_agent_review).toBe("unavailable");
  });

  it("passes single-runtime judgment gate with complete checklist", () => {
    const result = evaluateGateReview({
      gate: "G4",
      mode: "claude-only",
      checklist: passingChecklist(),
    });
    expect(result.passed).toBe(true);
  });

  it("keeps claude-only and codex-only judgment gate parity for the same checklist evidence", () => {
    const checklist = passingChecklist();
    const claude = evaluateGateReview({ gate: "G4", mode: "claude-only", checklist });
    const codex = evaluateGateReview({ gate: "G4", mode: "codex-only", checklist });
    expect(claude.passed).toBe(codex.passed);
    expect(claude.cross_agent_review).toBe(codex.cross_agent_review);
    expect(claude.review_kind).toBe(codex.review_kind);
    expect(claude.messages).toEqual(codex.messages);
  });

  it("fails checklist item fail and n-a without evidence", () => {
    const checklist = passingChecklist();
    checklist.items[0] = { id: "DOC", status: "n-a" };
    checklist.items[1] = { id: "TST", status: "fail", evidence: "test gap" };
    const result = evaluateGateReview({ gate: "G4", mode: "codex-only", checklist });
    expect(result.passed).toBe(false);
    expect(result.messages).toContain("checklist item n-a requires evidence: DOC");
    expect(result.messages).toContain("checklist item failed: TST");
  });

  it("rejects naive self-review as judgment-gate evidence in every mode", () => {
    const hybrid = evaluateGateReview({
      gate: "G4",
      mode: "hybrid",
      reviewKind: "self_review",
      workerModel: "codex:gpt-5.4",
      reviewerModel: "claude:opus",
    });
    const single = evaluateGateReview({
      gate: "G4",
      mode: "codex-only",
      reviewKind: "self_review",
      checklist: passingChecklist(),
    });
    const standalone = evaluateGateReview({
      gate: "G4",
      mode: "standalone",
      reviewKind: "self_review",
      humanApproved: true,
    });
    expect(hybrid.passed).toBe(false);
    expect(single.passed).toBe(false);
    expect(standalone.passed).toBe(false);
    expect(single.messages.join("\n")).toContain("self-review");
  });

  it("non-judgment gate does not require review tier", () => {
    const result = evaluateGateReview({ gate: "G3", mode: "codex-only" });
    expect(result.passed).toBe(true);
    expect(result.cross_agent_review).toBe("not-required");
  });
});
