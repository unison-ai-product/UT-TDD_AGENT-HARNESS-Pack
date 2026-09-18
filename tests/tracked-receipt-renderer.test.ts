import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CanonicalPlanDraftCommand } from "../src/kernel/plan-draft-command-digest.ts";
import { canonicalPlanContentDigest } from "../src/plan-admission/diff-fence.ts";
import type { PlanDraftCommand } from "../src/plan-admission/plan-draft-service.ts";
import type { PlanAdmissionRequest } from "../src/plan-admission/policy.ts";
import {
  parseTrackedReceiptProjection,
  TRACKED_RECEIPT_SCHEMA,
} from "../src/plan-admission/tracked-receipt-projection.ts";
import {
  type TrackedReceiptDraftPayload,
  type TrackedReceiptDraftReceipt,
  TrackedReceiptRenderer,
} from "../src/plan-admission/tracked-receipt-renderer.ts";
import { parseLegacyPlanSource } from "../src/plan-asset/adapters/legacy-plan-inventory.ts";

const sourcePath = "docs/plans/PLAN-L7-435-drive-plan-admission-impl.md";
const projectionPath = "docs/governance/plan-admission-receipts.json";
const emptyProjection = JSON.stringify({ schema_version: TRACKED_RECEIPT_SCHEMA, records: [] });
const forward: PlanAdmissionRequest = {
  routeSignal: "forward",
  routeMode: "forward",
  kind: "impl",
  layer: "L7",
  drive: "agent",
  branch: "work/forward-renderer",
};
const receipt: TrackedReceiptDraftReceipt = {
  assetId: "plan:renderer:435",
  revision: 1,
  certificateId: "certificate-renderer-1",
  certificateDigest: "a".repeat(64),
  commandPayloadDigest: `sha256:${"b".repeat(64)}`,
};

interface EmbeddedReceipt {
  route: { signal: string; mode: string };
  binding: { content_digest: string };
  issue?: { issue_id: number; episode_id: string };
  origin?: { plan_id: string; revision: number };
  transition?: { direction: string; implementation_disposition: string };
  reentry?: { target_plan_id: string; target_revision: number };
  escape_reason?: string;
}

function command(
  admission: PlanAdmissionRequest = forward,
  payload?: TrackedReceiptDraftPayload,
  identity: { planId: string; path: string } = {
    planId: "PLAN-L7-435-drive-plan-admission-impl",
    path: sourcePath,
  },
  sourceFile = sourcePath,
): PlanDraftCommand<TrackedReceiptDraftPayload> {
  const parsed = parseLegacyPlanSource(readFileSync(sourceFile, "utf8"));
  if (!parsed) throw new Error("test source invalid");
  const content = `---\n${parsed.rawFrontmatter.replace(parsed.planId, identity.planId)}\n---\n${parsed.body}`;
  return {
    commandId: "command-renderer-1",
    commandPayloadDigest: receipt.commandPayloadDigest,
    planId: identity.planId,
    recordedAt: "2026-07-15T00:00:00.000Z",
    payload: payload ?? { admission, canonical: canonical(identity.planId, identity.path) },
    source: { path: identity.path, content },
    projectionPath,
  };
}

describe("TrackedReceiptRenderer", () => {
  it("U-PADM-051: receiptをsourceへbindし、検証済みhash chain recordをappendする", () => {
    const renderer = new TrackedReceiptRenderer({ read: () => emptyProjection });

    const [source, projection] = renderer.render(command(), receipt);

    const parsedSource = parseLegacyPlanSource(source.content);
    const embedded = parsedSource?.frontmatter.admission_receipt as EmbeddedReceipt;
    const parsedProjection = parseTrackedReceiptProjection(projection.content);
    expect(parsedProjection.ok).toBe(true);
    if (!parsedProjection.ok) return;
    const record = parsedProjection.value.lookup("command-renderer-1");
    expect(embedded.route).toEqual({ signal: "forward", mode: "forward" });
    expect(embedded.binding.content_digest).toBe(canonicalPlanContentDigest(source.content));
    expect(record?.binding).toEqual({
      path: sourcePath,
      planId: command().planId,
      assetId: receipt.assetId,
      revision: 1,
      contentDigest: embedded.binding.content_digest,
    });
    expect(parsedProjection.value.records[0]?.previousRecordDigest).toBeNull();
  });

  it("U-PADM-052: Forward外のIssue・origin・transition・reentry・escapeを欠落なく埋め込む", () => {
    const reverse: PlanAdmissionRequest = {
      routeSignal: "reverse",
      routeMode: "reverse",
      kind: "reverse",
      layer: "cross",
      workflowPhase: "R0",
      drive: "agent",
      branch: "work/reverse-renderer",
      issue: {
        provider: "github",
        issueId: 65,
        episodeId: "episode-65",
        projectionDigest: `sha256:${"c".repeat(64)}`,
      },
      origin: { planId: "PLAN-L7-100-origin", revision: 2, digest: `sha256:${"d".repeat(64)}` },
      transitionDirection: "implementation_to_design",
      implementationDisposition: "preserved",
      reentry: { targetPlanId: "PLAN-L6-100-reentry", targetRevision: 3, phase: "forward_merge" },
      escapeReason: "PoC実装を設計へ引き戻す",
    };
    const renderer = new TrackedReceiptRenderer({ read: () => emptyProjection });

    const [source] = renderer.render(
      command(
        reverse,
        {
          admission: reverse,
          canonical: canonical(
            "PLAN-REVERSE-435-drive-plan-admission-backfill",
            "docs/plans/PLAN-REVERSE-435-drive-plan-admission-backfill.md",
          ),
        },
        {
          planId: "PLAN-REVERSE-435-drive-plan-admission-backfill",
          path: "docs/plans/PLAN-REVERSE-435-drive-plan-admission-backfill.md",
        },
        "docs/plans/PLAN-REVERSE-435-drive-plan-admission-backfill.md",
      ),
      receipt,
    );

    const embedded = parseLegacyPlanSource(source.content)?.frontmatter
      .admission_receipt as EmbeddedReceipt;
    expect(embedded.issue).toMatchObject({ issue_id: 65, episode_id: "episode-65" });
    expect(embedded.origin).toMatchObject({ plan_id: "PLAN-L7-100-origin", revision: 2 });
    expect(embedded.transition).toEqual({
      direction: "implementation_to_design",
      implementation_disposition: "preserved",
    });
    expect(embedded.reentry).toMatchObject({
      target_plan_id: "PLAN-L6-100-reentry",
      target_revision: 3,
    });
    expect(embedded.escape_reason).toBe("PoC実装を設計へ引き戻す");
  });

  it("U-PADM-053: caller supplied projectionと壊れた既存chainをfail-closeする", () => {
    const renderer = new TrackedReceiptRenderer({ read: () => emptyProjection });
    expect(() =>
      renderer.render(
        command(forward, {
          admission: forward,
          canonical: canonical(command().planId, sourcePath),
          projection: "forged",
        } as never),
        receipt,
      ),
    ).toThrow("caller-projection-forbidden");

    const broken = new TrackedReceiptRenderer({ read: () => "{}" });
    expect(() => broken.render(command(), receipt)).toThrow("projection-invalid");
  });
});

function canonical(planId: string, path: string): CanonicalPlanDraftCommand {
  return {
    commandId: "command-renderer-1",
    assetId: receipt.assetId,
    planId,
    alias: planId,
    sourcePath: path,
    projectionPath,
    sourceCommit: "a".repeat(40),
    actor: "codex",
    reason: "draft",
    canonicalPayloadJson: "{}",
    bodyDigest: "b".repeat(64),
    identityAlgorithm: "sha256-v1",
    reservationId: "reservation-renderer-1",
    namespace: "L7",
    ordinal: 435,
    leaseTokenHash: "c".repeat(64),
    expiresAt: "2026-07-16T00:00:00.000Z",
    routeTupleDigest: "d".repeat(64),
    certificateId: receipt.certificateId,
    occurredAt: "2026-07-15T00:00:00.000Z",
  };
}
