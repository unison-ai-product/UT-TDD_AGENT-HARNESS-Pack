import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AppendPlanDraftInput,
  PlanDraftLedgerTransaction,
} from "../../src/plan-asset/ledger/plan-draft-ledger.ts";
import { migratePlanLedger } from "../../src/plan-asset/ledger/schema.ts";
import { openHarnessDb } from "../../src/state-db/index.ts";

const opened: ReturnType<typeof openHarnessDb>[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

describe("PLAN draft ledger transaction", () => {
  it("U-PA-DRAFT-001: asset/revision/alias/reservation/admissionを単一write setへ記録する", () => {
    const { db, ledger } = fixture();
    const result = ledger.append(draft());

    expect(result).toMatchObject({ ok: true, replayed: false, revision: 1 });
    expect(counts(db)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 2]);
    expect(migratePlanLedger(db)).toEqual({ ok: true, version: 7 });
    expect(db.prepare("SELECT * FROM plan_id_reservations").get()).toMatchObject({
      lease_key_version: "plan-draft-v1",
      lease_token_hash: sha("lease"),
    });
    expect(db.prepare("SELECT * FROM plan_id_reservation_events").get()).toMatchObject({
      lease_key_version: "plan-draft-v1",
      lease_token_hash: sha("lease"),
    });
    const admission = db.prepare("SELECT * FROM plan_admission_receipts").get();
    expect(admission).toMatchObject({
      plan_asset_id: "asset:draft-1",
      plan_revision: 1,
      plan_id: "PLAN-L7-999",
      content_digest: sha('{"title":"draft"}'),
    });
  });

  it("U-PA-DRAFT-002: 同一command+payloadは再演し、payload差分をconflictにする", () => {
    const { db, ledger } = fixture();
    const input = draft();
    const first = ledger.append(input);
    const replay = ledger.append(input);
    const conflict = ledger.append({ ...input, reason: "different" });

    expect(first.ok && replay).toEqual(first.ok ? { ...first, replayed: true } : first);
    expect(conflict).toEqual({ ok: false, ruleId: "plan-draft-command-conflict" });
    expect(counts(db)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 2]);
  });

  it("U-PA-DRAFT-003: 同一namespace/ordinalの競合はwinnerを一件に限定する", () => {
    const { db, ledger } = fixture();
    const winner = ledger.append(draft());
    const loser = ledger.append(
      draft({
        commandId: "command:draft-2",
        assetId: "asset:draft-2",
        alias: "PLAN-L7-1000",
        planId: "PLAN-L7-1000",
        sourcePath: "docs/plans/PLAN-L7-1000.md",
        reservationId: "reservation:draft-2",
        certificateId: "certificate:draft-2",
      }),
    );

    expect(winner.ok).toBe(true);
    expect(loser).toEqual({ ok: false, ruleId: "plan-id-reservation-conflict" });
    expect(Number(db.prepare("SELECT COUNT(*) AS n FROM plan_assets").get()?.n)).toBe(1);
  });

  it("U-PA-DRAFT-004: 中間の一意制約違反でも先行insertをrollbackする", () => {
    const { db, ledger } = fixture();
    expect(ledger.append(draft()).ok).toBe(true);

    expect(() =>
      ledger.append(
        draft({
          commandId: "command:draft-2",
          assetId: "asset:draft-2",
          alias: "PLAN-L7-1000",
          planId: "PLAN-L7-1000",
          sourcePath: "docs/plans/PLAN-L7-1000.md",
          reservationId: "reservation:draft-2",
          namespace: "L8",
          ordinal: 1000,
          certificateId: "certificate:draft-1",
        }),
      ),
    ).toThrow();
    expect(
      db.prepare("SELECT 1 FROM plan_assets WHERE asset_id = ?").get("asset:draft-2"),
    ).toBeUndefined();
    expect(counts(db)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 2]);
  });
});

function fixture() {
  const db = openHarnessDb(":memory:");
  opened.push(db);
  return { db, ledger: new PlanDraftLedgerTransaction(db) };
}

function draft(overrides: Partial<AppendPlanDraftInput> = {}): AppendPlanDraftInput {
  return {
    commandId: "command:draft-1",
    assetId: "asset:draft-1",
    planId: "PLAN-L7-999",
    alias: "PLAN-L7-999",
    sourcePath: "docs/plans/PLAN-L7-999.md",
    projectionPath: "docs/governance/plan-admission-receipts.json",
    sourceCommit: "a".repeat(40),
    actor: "codex",
    reason: "draft",
    canonicalPayloadJson: '{"title":"draft"}',
    bodyDigest: sha("draft body"),
    identityAlgorithm: "uuid-v5",
    reservationId: "reservation:draft-1",
    namespace: "L7",
    ordinal: 999,
    leaseTokenHash: sha("lease"),
    expiresAt: "2026-07-16T00:00:00.000Z",
    routeTupleDigest: sha("forward|none"),
    certificateId: "certificate:draft-1",
    occurredAt: "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
}

function counts(db: ReturnType<typeof openHarnessDb>): number[] {
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
  ].map((table) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n));
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
