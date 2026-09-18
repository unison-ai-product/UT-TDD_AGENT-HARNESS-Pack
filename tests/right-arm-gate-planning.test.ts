import { describe, expect, it } from "vitest";
import {
  analyzeRightArmGatePlanning as analyzeRightArmGatePlanningRaw,
  engineSwapDependencyLink,
  loadRightArmGatePlanningInput,
  type RightArmGatePlanningInput,
  type RightArmVerifyPlan,
  rightArmGatePlanningMessages,
} from "../src/lint/right-arm-gate-planning.ts";

const layers = ["L8", "L9", "L10", "L11", "L12", "L13", "L14"];
const expectedVerifyPlans = layers.map((layer) => ({
  planId: `PLAN-${layer}-01-engine-swap-${layer.toLowerCase()}`,
  layer,
  gate: `G${layer.slice(1)}`,
  governanceArtifact: `docs/process/evidence/${layer.toLowerCase()}.md`,
  evidenceManifest: `.ut-tdd/evidence/${layer.toLowerCase()}/engine-swap.json`,
}));

function analyzeRightArmGatePlanning(input: RightArmGatePlanningInput) {
  const obligations = input.expectedVerifyPlans ?? expectedVerifyPlans;
  const basePlans: RightArmVerifyPlan[] =
    input.verifyPlans ??
    (input.engineSwapPlanStatus
      ? obligations.map((obligation) => ({
          layer: obligation.layer,
          status: "draft",
          engineSwapLinked: true,
        }))
      : []);
  const verifyPlans = basePlans.map((plan) => {
    const obligation = obligations.find((entry) => entry.layer === plan.layer);
    return {
      ...plan,
      planId: plan.planId ?? obligation?.planId,
      verificationGate: plan.verificationGate ?? obligation?.gate,
      owningDesignLinked: plan.owningDesignLinked ?? true,
      parentDesign: plan.parentDesign ?? obligation?.governanceArtifact,
      generatedArtifacts: plan.generatedArtifacts ?? [
        obligation?.governanceArtifact ?? "",
        obligation?.evidenceManifest ?? "",
      ],
      governanceArtifactExists: plan.governanceArtifactExists ?? true,
    };
  });
  return analyzeRightArmGatePlanningRaw({
    ...input,
    expectedVerifyPlans: obligations,
    parentBacklinks: input.parentBacklinks ?? obligations.map((entry) => entry.planId),
    verifyPlans,
  });
}

function backlogRow(status: string, link: string): string {
  return [
    "## §1 backlog",
    "| ID | date | context | issue | candidate | status | link |",
    "|---|---|---|---|---|---|---|",
    `| **IMP-052** | 2026-06-04 | Phase1 | G8-G14 carry | doc / policy | ${status} | ${link} |`,
  ].join("\n");
}

describe("right-arm gate planning lint", () => {
  it("fails when G8-G14 carry is still unplanned", () => {
    const result = analyzeRightArmGatePlanning({
      gatesMd:
        "注: G8-G14 の機械検証条件は概念定義に留まる。G8-G14 機械化 PLAN は未起票のまま = carry。",
      backlogMd: backlogRow("observed", "gates.md §1 注記から本 IMP を参照"),
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toContain(
      "IMP-052 is still observed instead of routed to a concrete PLAN",
    );
    expect(result.violations).toContain("G8-G14 mechanization carry has no PLAN reference");
    expect(result.violations).toContain(
      "docs/process/gates.md still marks G8-G14 mechanization as unplanned",
    );
  });

  it("passes when IMP-052 is routed to concrete PLAN references", () => {
    const result = analyzeRightArmGatePlanning({
      gatesMd:
        "注: G8-G14 の機械検証条件は PLAN-L7-130-right-arm-gate-planning / PLAN-REVERSE-130-right-arm-gate-planning で起票済み。",
      backlogMd: backlogRow(
        "implemented",
        "PLAN-L7-130-right-arm-gate-planning / PLAN-REVERSE-130-right-arm-gate-planning",
      ),
      engineSwapPlanStatus: "draft",
      engineSwapProgramExitStatus: "in_progress",
    });

    expect(result.ok).toBe(true);
    expect(result.planRefs).toEqual([
      "PLAN-L7-130-right-arm-gate-planning",
      "PLAN-REVERSE-130-right-arm-gate-planning",
    ]);
    expect(rightArmGatePlanningMessages(result)[0]).toContain("IN-PROGRESS");
  });

  it("fails when the contract names expected PLAN identities that are still missing", () => {
    const base = {
      gatesMd:
        "注: G8-G14 の機械検証条件は PLAN-L7-130-right-arm-gate-planning / PLAN-REVERSE-130-right-arm-gate-planning で起票済み。",
      backlogMd: backlogRow(
        "implemented",
        "PLAN-L7-130-right-arm-gate-planning / PLAN-REVERSE-130-right-arm-gate-planning",
      ),
      verifyPlans: [
        { layer: "L8", status: "confirmed", engineSwapLinked: true },
        { layer: "L9", status: "confirmed", engineSwapLinked: true },
      ],
      engineSwapProgramExitStatus: "in_progress",
    };
    const draft = analyzeRightArmGatePlanning({ ...base, engineSwapPlanStatus: "draft" });
    expect(draft.ok).toBe(false);
    expect(draft.missingPlannedVerifyLayers).toEqual(["L10", "L11", "L12", "L13", "L14"]);
    expect(draft.missingCompletedVerifyLayers).toEqual(["L10", "L11", "L12", "L13", "L14"]);
    expect(rightArmGatePlanningMessages(draft)[0]).toContain("violation");
    expect(draft.violations.join(" ")).toContain("expected verify PLAN is missing");

    const confirmed = analyzeRightArmGatePlanning({
      ...base,
      engineSwapPlanStatus: "confirmed",
    });
    expect(confirmed.ok).toBe(false);
    expect(confirmed.violations[0]).toContain("expected verify PLAN is missing");
  });

  it("does not claim completion from unrelated, archived, or draft verify PLANs", () => {
    const layers = ["L8", "L9", "L10", "L11", "L12", "L13", "L14"];
    const base = {
      gatesMd:
        "注: G8-G14 は PLAN-L7-130-right-arm-gate-planning / PLAN-REVERSE-130-right-arm-gate-planning で起票済み。",
      backlogMd: backlogRow(
        "implemented",
        "PLAN-L7-130-right-arm-gate-planning / PLAN-REVERSE-130-right-arm-gate-planning",
      ),
      engineSwapPlanStatus: "draft",
      engineSwapProgramExitStatus: "in_progress",
    };
    const unrelated = analyzeRightArmGatePlanning({
      ...base,
      verifyPlans: layers.map((layer) => ({
        layer,
        status: "confirmed",
        engineSwapLinked: false,
      })),
    });
    expect(unrelated.engineSwapState).toBe("in_progress");
    expect(unrelated.missingPlannedVerifyLayers).toEqual(layers);
    expect(unrelated.missingCompletedVerifyLayers).toEqual(layers);

    const inactive = analyzeRightArmGatePlanning({
      ...base,
      verifyPlans: layers.map((layer, index) => ({
        layer,
        status: index % 2 === 0 ? "archived" : "draft",
        engineSwapLinked: true,
      })),
    });
    expect(inactive.engineSwapState).toBe("in_progress");
    expect(inactive.missingCompletedVerifyLayers).toEqual(layers);

    const readyButDesignDraft = analyzeRightArmGatePlanning({
      ...base,
      verifyPlans: layers.map((layer) => ({
        layer,
        status: "confirmed",
        engineSwapLinked: true,
      })),
    });
    expect(readyButDesignDraft.ok).toBe(true);
    expect(readyButDesignDraft.engineSwapState).toBe("in_progress");
    expect(readyButDesignDraft.missingPlannedVerifyLayers).toEqual([]);
    expect(readyButDesignDraft.missingCompletedVerifyLayers).toEqual([]);
    expect(rightArmGatePlanningMessages(readyButDesignDraft)[0]).toContain("IN-PROGRESS");
  });

  it("fails closed for a missing, unknown, or archived engine-swap design status", () => {
    const base = {
      gatesMd:
        "G8-G14 は PLAN-L7-130-right-arm-gate-planning / PLAN-REVERSE-130-right-arm-gate-planning で起票済み。",
      backlogMd: backlogRow(
        "implemented",
        "PLAN-L7-130-right-arm-gate-planning / PLAN-REVERSE-130-right-arm-gate-planning",
      ),
      verifyPlans: ["L8", "L9", "L10", "L11", "L12", "L13", "L14"].map((layer) => ({
        layer,
        status: "confirmed",
        engineSwapLinked: true,
      })),
      engineSwapProgramExitStatus: "in_progress",
    };
    for (const status of [null, "banana", "archived"] as const) {
      const result = analyzeRightArmGatePlanning({ ...base, engineSwapPlanStatus: status });
      expect(result.ok, String(status)).toBe(false);
      expect(result.engineSwapState, String(status)).not.toBe("complete");
    }
  });

  it("separates design freeze obligations from program acceptance evidence", () => {
    const layers = ["L8", "L9", "L10", "L11", "L12", "L13", "L14"];
    const base = {
      gatesMd:
        "G8-G14 は PLAN-L7-130-right-arm-gate-planning / PLAN-REVERSE-130-right-arm-gate-planning で起票済み。",
      backlogMd: backlogRow(
        "implemented",
        "PLAN-L7-130-right-arm-gate-planning / PLAN-REVERSE-130-right-arm-gate-planning",
      ),
      engineSwapPlanStatus: "confirmed",
      verifyPlans: layers.map((layer) => ({
        layer,
        status: "draft",
        engineSwapLinked: true,
      })),
    };
    const executing = analyzeRightArmGatePlanning({
      ...base,
      engineSwapProgramExitStatus: "in_progress",
    });
    expect(executing.ok).toBe(true);
    expect(executing.engineSwapState).toBe("in_progress");
    expect(executing.missingPlannedVerifyLayers).toEqual([]);
    expect(executing.missingCompletedVerifyLayers).toEqual(layers);

    const prematureAccept = analyzeRightArmGatePlanning({
      ...base,
      engineSwapProgramExitStatus: "accepted",
    });
    expect(prematureAccept.ok).toBe(false);
    expect(prematureAccept.violations.join(" ")).toContain("program is accepted");

    const accepted = analyzeRightArmGatePlanning({
      ...base,
      engineSwapProgramExitStatus: "accepted",
      verifyPlans: layers.map((layer) => ({
        layer,
        status: "confirmed",
        engineSwapLinked: true,
      })),
    });
    expect(accepted.ok).toBe(true);
    expect(accepted.engineSwapState).toBe("complete");

    for (const status of ["draft", "banana", "archived"] as const) {
      const invalidTransition = analyzeRightArmGatePlanning({
        ...base,
        engineSwapPlanStatus: status,
        engineSwapProgramExitStatus: "accepted",
        verifyPlans: layers.map((layer) => ({
          layer,
          status: "confirmed",
          engineSwapLinked: true,
        })),
      });
      expect(invalidTransition.ok, status).toBe(false);
      expect(invalidTransition.engineSwapState, status).not.toBe("complete");
    }
  });

  it("recognizes engine-swap linkage only in structured dependency fields", () => {
    const incidental = [
      "---",
      "dependencies:",
      "  parent: PLAN-OTHER",
      "  requires: []",
      "  references: []",
      "---",
      "本文で PLAN-L4-24-declarative-vmodel-contract-right-arm を否定的に言及する。",
    ].join("\n");
    const linked = incidental.replace(
      "  references: []",
      "  references:\n    - docs/plans/PLAN-L4-24-declarative-vmodel-contract-right-arm.md",
    );
    expect(engineSwapDependencyLink(incidental)).toBe(false);
    expect(engineSwapDependencyLink(linked)).toBe(true);
  });

  it("rejects a self-declared verify PLAN that does not match the contract obligation", () => {
    const result = analyzeRightArmGatePlanning({
      gatesMd:
        "G8-G14 は PLAN-L7-130-right-arm-gate-planning / PLAN-REVERSE-130-right-arm-gate-planning で起票済み。",
      backlogMd: backlogRow(
        "implemented",
        "PLAN-L7-130-right-arm-gate-planning / PLAN-REVERSE-130-right-arm-gate-planning",
      ),
      engineSwapPlanStatus: "draft",
      engineSwapProgramExitStatus: "in_progress",
      parentBacklinks: [],
      verifyPlans: [
        {
          layer: "L8",
          status: "draft",
          engineSwapLinked: true,
          verificationGate: "G9",
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toContain("verification_gate=G9");
    expect(result.violations.join(" ")).toContain("parent-backlink=missing");
    expect(result.missingPlannedVerifyLayers).toContain("L8");
  });

  it("rejects an L11 pair exception whose verify PLAN omits a required backlink", () => {
    const obligations = expectedVerifyPlans.map((entry) =>
      entry.layer === "L11"
        ? {
            ...entry,
            requiredBacklinks: [
              "PLAN-L1-07-vmodel-engine-swap-requirements-delta",
              "PLAN-L4-24-declarative-vmodel-contract-right-arm",
            ],
          }
        : entry,
    );
    const result = analyzeRightArmGatePlanning({
      gatesMd:
        "G8-G14 は PLAN-L7-130-right-arm-gate-planning / PLAN-REVERSE-130-right-arm-gate-planning で起票済み。",
      backlogMd: backlogRow(
        "implemented",
        "PLAN-L7-130-right-arm-gate-planning / PLAN-REVERSE-130-right-arm-gate-planning",
      ),
      engineSwapPlanStatus: "draft",
      engineSwapProgramExitStatus: "in_progress",
      expectedVerifyPlans: obligations,
      verifyPlans: obligations.map((entry) => ({
        layer: entry.layer,
        status: "draft",
        engineSwapLinked: true,
        dependencyPlanIds:
          entry.layer === "L11" ? ["PLAN-L4-24-declarative-vmodel-contract-right-arm"] : [],
      })),
    });

    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toContain(
      "required-backlink=PLAN-L1-07-vmodel-engine-swap-requirements-delta",
    );
  });

  it("validates the live expected PLAN identities, backlinks, gates, and governance artifacts", () => {
    const result = analyzeRightArmGatePlanning(loadRightArmGatePlanningInput(process.cwd()));

    expect(result.violations.filter((value) => value.includes("contract mismatch"))).toEqual([]);
    expect(result.missingPlannedVerifyLayers).toEqual([]);
  });
});
