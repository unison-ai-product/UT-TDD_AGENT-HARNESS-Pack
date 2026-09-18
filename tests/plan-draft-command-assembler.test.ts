import { describe, expect, it } from "vitest";
import { calculatePlanDraftCommandDigests } from "../src/kernel/plan-draft-command-digest.ts";
import {
  assemblePlanDraftCommand,
  type DraftManifestV2,
  type PlanDraftEnvironmentSnapshot,
} from "../src/plan-admission/plan-draft-command-assembler.ts";
import { evaluatePlanAdmission, type PlanAdmissionRequest } from "../src/plan-admission/policy.ts";

const planId = "PLAN-L7-999-command-assembler";
const admission: PlanAdmissionRequest = {
  routeSignal: "forward",
  routeMode: "forward",
  kind: "impl",
  layer: "L7",
  drive: "agent",
  branch: "work/forward-command-assembler",
};
const decision = evaluatePlanAdmission(admission);
if (!decision.ok) throw new Error("test fixture must be admitted");

const manifest: DraftManifestV2 = {
  version: 2,
  command_id: "command:draft-999",
  plan_id: planId,
  recorded_at: "2026-07-15T00:00:00.000Z",
  admission: {
    route_signal: "forward",
    route_mode: "forward",
    kind: "impl",
    layer: "L7",
  },
  source: {
    path: `docs/plans/${planId}.md`,
    content: `---\nplan_id: ${planId}\ntitle: command assembler\nkind: impl\nlayer: L7\ndrive: agent\nroute_signal: forward\nroute_mode: forward\n---\nbody\n`,
  },
  projection: { path: "docs/governance/plan-admission-receipts.json" },
};
const environment: PlanDraftEnvironmentSnapshot = {
  assetId: "asset:draft-999",
  reservationId: "reservation:draft-999",
  certificateId: "certificate:draft-999",
  namespace: "L7",
  ordinal: 999,
  sourceCommit: "a".repeat(40),
  actor: "codex",
  reason: "forward draft",
  identityAlgorithm: "uuid-v5",
  bodyDigest: "b".repeat(64),
  routeTupleDigest: "c".repeat(64),
  leaseTokenHash: "d".repeat(64),
  expiresAt: "2026-07-16T00:00:00.000Z",
};

describe("PLAN draft command assembler", () => {
  it("U-PADM-047: 同じ明示入力からcanonical/service commandを決定論的に組み立てる", () => {
    const first = assemblePlanDraftCommand({ manifest, admission, decision, environment });
    const second = assemblePlanDraftCommand({ manifest, admission, decision, environment });

    expect(second).toEqual(first);
    expect(first.command.commandPayloadDigest).toBe(
      calculatePlanDraftCommandDigests(first.canonical).commandPayloadDigest,
    );
    expect(first.command.payload).toEqual({ canonical: first.canonical, admission });
    expect(first.canonical).toMatchObject({
      planId,
      sourcePath: manifest.source.path,
      sourceCommit: environment.sourceCommit,
      namespace: "L7",
      ordinal: 999,
      assetId: environment.assetId,
      reservationId: environment.reservationId,
      certificateId: environment.certificateId,
      bodyDigest: environment.bodyDigest,
      routeTupleDigest: environment.routeTupleDigest,
      leaseTokenHash: environment.leaseTokenHash,
      expiresAt: environment.expiresAt,
    });
  });

  it.each([
    [
      "source plan ID",
      {
        source: {
          ...manifest.source,
          content: manifest.source.content.replace(planId, "PLAN-L7-998-wrong"),
        },
      },
      environment,
    ],
    [
      "source path",
      { source: { ...manifest.source, path: "docs/plans/PLAN-L7-998-wrong.md" } },
      environment,
    ],
    ["namespace", {}, { ...environment, namespace: "L6" }],
    ["ordinal", {}, { ...environment, ordinal: 998 }],
  ] as const)("U-PADM-048: %s不一致をfail-closeする", (_label, manifestPatch, snapshot) => {
    expect(() =>
      assemblePlanDraftCommand({
        manifest: { ...manifest, ...manifestPatch },
        admission,
        decision,
        environment: snapshot,
      }),
    ).toThrow();
  });

  it("U-PADM-049: manifestのdigest自己申告をcommandに混入させない", () => {
    const claimed = { ...manifest, command_payload_digest: "f".repeat(64) };
    const baseline = assemblePlanDraftCommand({ manifest, admission, decision, environment });
    const withClaim = assemblePlanDraftCommand({
      manifest: claimed,
      admission,
      decision,
      environment,
    });

    expect(withClaim).toEqual(baseline);
  });

  it("U-PADM-050: admission decisionとrequestのtuple不一致を拒否する", () => {
    const mismatched = { ...admission, layer: "L6" as const };

    expect(() =>
      assemblePlanDraftCommand({ manifest, admission: mismatched, decision, environment }),
    ).toThrow("plan-draft-admission-decision-mismatch");

    expect(() =>
      assemblePlanDraftCommand({
        manifest,
        admission,
        decision: { ...decision, issueRequired: !decision.issueRequired },
        environment,
      }),
    ).toThrow("plan-draft-admission-decision-mismatch");
  });

  it("U-PADM-063: Recovery IDをRecovery tupleと予約identityへ束縛する", () => {
    const recoveryPlanId = "PLAN-RECOVERY-70-doctor-slo";
    const recoveryAdmission: PlanAdmissionRequest = {
      routeSignal: "regression_dev",
      routeMode: "recovery",
      kind: "recovery",
      layer: "cross",
      drive: "agent",
      branch: "work/recovery-doctor-slo",
      issue: {
        provider: "github",
        issueId: 70,
        episodeId: "episode:70",
        projectionDigest: "a".repeat(64),
      },
      origin: { planId: "PLAN-L7-442-doctor-singleton-guard", revision: 1, digest: "b".repeat(64) },
      reentry: {
        targetPlanId: "PLAN-L6-70-source-catalog-profile-resolver-contracts",
        targetRevision: 1,
        phase: "forward_merge",
      },
      escapeReason: "doctor local SLO regression",
    };
    const recoveryDecision = evaluatePlanAdmission(recoveryAdmission);
    if (!recoveryDecision.ok) throw new Error("recovery fixture must be admitted");
    const recoveryManifest: DraftManifestV2 = {
      ...manifest,
      command_id: "command:recovery-70",
      plan_id: recoveryPlanId,
      source: {
        path: `docs/plans/${recoveryPlanId}.md`,
        content: `---\nplan_id: ${recoveryPlanId}\ntitle: Recovery 70\nkind: recovery\nlayer: cross\ndrive: agent\nroute_signal: regression_dev\nroute_mode: recovery\n---\nbody\n`,
      },
    };
    const assembled = assemblePlanDraftCommand({
      manifest: recoveryManifest,
      admission: recoveryAdmission,
      decision: recoveryDecision,
      environment: { ...environment, namespace: "RECOVERY", ordinal: 70 },
    });
    expect(assembled.canonical).toMatchObject({
      planId: recoveryPlanId,
      namespace: "RECOVERY",
      ordinal: 70,
    });
  });

  it.each([
    ["kind", "recovery", "impl"],
    ["layer", "cross", "L7"],
    ["drive", "agent", "human"],
    ["route_signal", "regression_dev", "forward"],
    ["route_mode", "recovery", "forward"],
    ["workflow_phase", "", "workflow_phase: R3\n"],
  ])("U-PADM-065: source %sとRecovery Admissionの混用を副作用前にfail-closeする", (field, expected, replacement) => {
    const recoveryPlanId = "PLAN-RECOVERY-70-doctor-slo";
    const recoveryAdmission: PlanAdmissionRequest = {
      routeSignal: "regression_dev",
      routeMode: "recovery",
      kind: "recovery",
      layer: "cross",
      drive: "agent",
      branch: "work/recovery-doctor-slo",
      issue: {
        provider: "github",
        issueId: 70,
        episodeId: "episode:70",
        projectionDigest: "a".repeat(64),
      },
      origin: { planId: "PLAN-L7-442-doctor-singleton-guard", revision: 1, digest: "b".repeat(64) },
      reentry: {
        targetPlanId: "PLAN-L6-70-source-catalog-profile-resolver-contracts",
        targetRevision: 1,
        phase: "forward_merge",
      },
      escapeReason: "doctor local SLO regression",
    };
    const recoveryDecision = evaluatePlanAdmission(recoveryAdmission);
    if (!recoveryDecision.ok) throw new Error("recovery fixture must be admitted");
    const canonicalSource = `---\nplan_id: ${recoveryPlanId}\ntitle: Mixed\nkind: recovery\nlayer: cross\ndrive: agent\nroute_signal: regression_dev\nroute_mode: recovery\n---\nbody\n`;
    const identityOnlyMismatch: DraftManifestV2 = {
      ...manifest,
      plan_id: recoveryPlanId,
      source: {
        path: `docs/plans/${recoveryPlanId}.md`,
        content: canonicalSource
          .replace("kind: recovery", "kind: impl")
          .replace("layer: cross", "layer: L7")
          .replace("route_signal: regression_dev", "route_signal: forward")
          .replace("route_mode: recovery", "route_mode: forward"),
      },
    };
    expect(() =>
      assemblePlanDraftCommand({
        manifest: identityOnlyMismatch,
        admission,
        decision,
        environment: { ...environment, namespace: "RECOVERY", ordinal: 70 },
      }),
    ).toThrow("plan-draft-source-admission-mismatch");

    const sourceContent =
      field === "workflow_phase"
        ? canonicalSource.replace("---\nbody", `${replacement}---\nbody`)
        : canonicalSource.replace(`${field}: ${expected}`, `${field}: ${replacement}`);
    const mixedManifest: DraftManifestV2 = {
      ...manifest,
      plan_id: recoveryPlanId,
      source: {
        path: `docs/plans/${recoveryPlanId}.md`,
        content: sourceContent,
      },
    };

    expect(() =>
      assemblePlanDraftCommand({
        manifest: mixedManifest,
        admission: recoveryAdmission,
        decision: recoveryDecision,
        environment: { ...environment, namespace: "RECOVERY", ordinal: 70 },
      }),
    ).toThrow("plan-draft-source-admission-mismatch");
  });
});
