import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CanonicalPlanDraftCommand,
  calculatePlanDraftCommandDigests,
} from "../src/kernel/plan-draft-command-digest.ts";
import type { PlanDraftExecutionPayload } from "../src/plan-admission/plan-draft-command-assembler.ts";
import {
  PlanDraftLedgerAdapter,
  PlanDraftLedgerDigestMismatchError,
  type PlanDraftLedgerRejectedError,
} from "../src/plan-admission/plan-draft-ledger-adapter.ts";
import type { PlanDraftCommand } from "../src/plan-admission/plan-draft-service.ts";
import type { PlanAdmissionRequest } from "../src/plan-admission/policy.ts";
import { PlanDraftLedgerTransaction } from "../src/plan-asset/ledger/plan-draft-ledger.ts";
import { openHarnessDb } from "../src/state-db/index.ts";

const opened: ReturnType<typeof openHarnessDb>[] = [];
const admission: PlanAdmissionRequest = {
  routeSignal: "forward",
  routeMode: "forward",
  kind: "impl",
  layer: "L7",
  drive: "agent",
  branch: "work/forward-ledger-adapter",
};
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

describe("PLAN draft ledger adapter", () => {
  it("U-PADM-055: canonical payloadをledgerへ渡し、certificate digestを含むreceiptを返す", () => {
    const { adapter } = fixture();
    const payload = draft();
    const command = domainCommand(payload);
    const prepared = vi.fn();

    const receipt = adapter.transact(command, prepared);

    expect(prepared).toHaveBeenCalledOnce();
    expect(receipt).toMatchObject({
      assetId: payload.assetId,
      revision: 1,
      certificateId: payload.certificateId,
      certificateDigest: calculatePlanDraftCommandDigests(payload).certificateDigest,
      commandPayloadDigest: command.commandPayloadDigest,
    });
  });

  it("U-PADM-056: 自己申告command digestがcanonical payloadと異なる場合はwrite前にfail-closeする", () => {
    const { adapter, db } = fixture();

    expect(() =>
      adapter.transact(
        { ...domainCommand(draft()), commandPayloadDigest: "f".repeat(64) },
        vi.fn(),
      ),
    ).toThrow(PlanDraftLedgerDigestMismatchError);
    expect(totalRows(db)).toBe(0);
  });

  it("U-PADM-057: ledger denyをruleId付きtyped errorへ変換する", () => {
    const { adapter } = fixture();
    adapter.transact(domainCommand(draft()), vi.fn());
    const payload = draft({ commandId: "command:2", assetId: "asset:2" });

    expect(() => adapter.transact(domainCommand(payload), vi.fn())).toThrowError(
      expect.objectContaining<Partial<PlanDraftLedgerRejectedError>>({
        name: "PlanDraftLedgerRejectedError",
        ruleId: "plan-alias-conflict",
      }),
    );
  });

  it("U-PADM-058: onPreparedをCOMMIT前に実行し、callback throwでledger全write setをrollbackする", () => {
    const { adapter, db } = fixture();
    const observed = vi.fn(() => {
      expect(totalRows(db)).toBeGreaterThan(0);
      throw new Error("publish-stage-failed");
    });

    expect(() => adapter.transact(domainCommand(draft()), observed)).toThrow(
      "publish-stage-failed",
    );
    expect(observed).toHaveBeenCalledOnce();
    expect(totalRows(db)).toBe(0);
  });
});

function fixture() {
  const db = openHarnessDb(":memory:");
  opened.push(db);
  return { db, adapter: new PlanDraftLedgerAdapter(new PlanDraftLedgerTransaction(db)) };
}

function domainCommand(
  payload: CanonicalPlanDraftCommand,
): PlanDraftCommand<PlanDraftExecutionPayload> {
  return {
    commandId: payload.commandId,
    commandPayloadDigest: calculatePlanDraftCommandDigests(payload).commandPayloadDigest,
    planId: payload.planId,
    recordedAt: payload.occurredAt,
    payload: { canonical: payload, admission },
    source: { path: payload.sourcePath, content: payload.canonicalPayloadJson },
    projectionPath: payload.projectionPath,
  };
}

function draft(overrides: Partial<CanonicalPlanDraftCommand> = {}): CanonicalPlanDraftCommand {
  return {
    commandId: "command:1",
    assetId: "asset:1",
    planId: "PLAN-L7-999",
    alias: "PLAN-L7-999",
    sourcePath: "docs/plans/PLAN-L7-999.md",
    projectionPath: "docs/governance/plan-admission-receipts.json",
    sourceCommit: "a".repeat(40),
    actor: "codex",
    reason: "draft",
    canonicalPayloadJson: '{"title":"draft"}',
    bodyDigest: sha("body"),
    identityAlgorithm: "uuid-v5",
    reservationId: "reservation:1",
    namespace: "L7",
    ordinal: 999,
    leaseTokenHash: sha("lease"),
    expiresAt: "2026-07-16T00:00:00.000Z",
    routeTupleDigest: sha("forward|none"),
    certificateId: "certificate:1",
    occurredAt: "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
}

function totalRows(db: ReturnType<typeof openHarnessDb>): number {
  return [
    "plan_assets",
    "plan_revisions",
    "plan_alias_events",
    "plan_aliases",
    "plan_id_reservation_events",
    "plan_id_reservations",
    "plan_admission_events",
    "plan_admission_receipts",
    "append_command_receipts",
  ].reduce(
    (sum, table) => sum + Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n),
    0,
  );
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
