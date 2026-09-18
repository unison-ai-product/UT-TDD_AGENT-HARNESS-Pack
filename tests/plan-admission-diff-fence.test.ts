import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  type AdmissionReceiptProjection,
  analyzePlanAdmissionDiff,
  canonicalPlanContentDigest,
} from "../src/plan-admission/diff-fence.ts";

const path = "docs/plans/PLAN-L7-99-admission-fixture.md";

function plan(receipt = true, body = "# Fixture\n"): string {
  const fm: Record<string, unknown> = {
    plan_id: "PLAN-L7-99-admission-fixture",
    title: "fixture",
    kind: "impl",
    layer: "L7",
    drive: "agent",
    status: "draft",
    parent_design: "docs/plans/PLAN-L6-83-drive-plan-admission-contract.md",
    route_signal: "forward",
    route_mode: "forward",
    agent_slots: [{ role: "se", slot_label: "SE" }],
    generates: [],
    dependencies: { parent: null, requires: [], blocks: [] },
  };
  const unsigned = `---\n${stringify(fm)}---\n${body}`;
  if (receipt) {
    fm.admission_receipt = {
      schema_version: "v2",
      receipt_id: "pa-fixture",
      command_id: "cmd-fixture",
      admitted_at: "2026-07-15T00:00:00.000Z",
      source_digest: "sha256:0123456789abcdef",
      decision_digest: "sha256:fedcba9876543210",
      receipt_digest: "sha256:9999999999999999",
      binding: {
        path,
        plan_id: fm.plan_id,
        asset_id: "plan:l7:99",
        revision: 1,
        content_digest: canonicalPlanContentDigest(unsigned),
      },
      route: { signal: "forward", mode: "forward" },
    };
  }
  return `---\n${stringify(fm)}---\n${body}`;
}

function projection(content: string): AdmissionReceiptProjection {
  const digest = canonicalPlanContentDigest(content);
  if (!digest) throw new Error("fixture PLAN must produce a canonical digest");
  return {
    commandId: "cmd-fixture",
    receiptId: "pa-fixture",
    receiptDigest: "sha256:9999999999999999",
    decisionDigest: "sha256:fedcba9876543210",
    binding: {
      path,
      planId: "PLAN-L7-99-admission-fixture",
      assetId: "plan:l7:99",
      revision: 1,
      contentDigest: digest,
    },
  };
}

describe("PLAN admission diff fence", () => {
  it("U-PADM-012: permits a new PLAN only when its receipt is bound to the tracked projection", () => {
    const content = plan();
    const result = analyzePlanAdmissionDiff({
      base: [],
      head: [{ path, content }],
      changes: [{ kind: "added", path }],
      receipts: { lookup: (id) => (id === "cmd-fixture" ? projection(content) : undefined) },
    });
    expect(result).toEqual({ ok: true, findings: [] });
  });

  it("U-PADM-013: rejects missing receipt, stale receipt, and direct delete", () => {
    const old = plan();
    const noReceipt = plan(false);
    const missing = analyzePlanAdmissionDiff({
      base: [],
      head: [{ path, content: noReceipt }],
      changes: [{ kind: "added", path }],
      receipts: { lookup: () => undefined },
    });
    expect(missing.findings[0]?.code).toBe("plan-admission-receipt-missing");
    const stale = analyzePlanAdmissionDiff({
      base: [{ path, content: old }],
      head: [{ path, content: `${old}\nchanged` }],
      changes: [{ kind: "modified", path }],
      receipts: { lookup: () => projection(old) },
    });
    expect(stale.findings[0]?.code).toBe("plan-admission-receipt-stale");
    const deleted = analyzePlanAdmissionDiff({
      base: [{ path, content: old }],
      head: [],
      changes: [{ kind: "deleted", path }],
      receipts: { lookup: () => undefined },
    });
    expect(deleted.findings[0]?.code).toBe("plan-admission-direct-delete");
  });
});
