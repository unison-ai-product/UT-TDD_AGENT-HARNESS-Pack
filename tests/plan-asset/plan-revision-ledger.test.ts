import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AppendPlanRevisionInput,
  derivePlanRevisionDigests,
  PlanRevisionLedgerTransaction,
  replayBindingFailures,
} from "../../src/plan-asset/ledger/plan-revision-ledger.ts";
import { ledgerRowDigest, migratePlanLedger } from "../../src/plan-asset/ledger/schema.ts";
import { openHarnessDb } from "../../src/state-db/index.ts";

const opened: ReturnType<typeof openHarnessDb>[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

describe("PLAN revision ledger transaction", () => {
  it.each([
    ["sourceCommit", { sourceCommit: "c".repeat(40) }],
    ["actor", { actor: "forged" }],
    ["reason", { reason: "forged" }],
    ["occurredAt", { occurredAt: "2026-07-17T00:00:01.000Z" }],
  ] as const)("U-PA-REV-037: %s改変は保存receiptと独立したcommand digest再導出で検出可能", (_field, change) => {
    const original = derivePlanRevisionDigests(revision());
    const changed = derivePlanRevisionDigests(revision(change));

    expect(changed.commandPayloadDigest).not.toBe(original.commandPayloadDigest);
    expect(changed.certificateDigest).not.toBe(original.certificateDigest);
  });

  it("U-PA-REV-001: adopt済みassetへN+1 revisionとreceiptをatomic appendする", () => {
    const { db, ledger } = fixture();
    const result = ledger.append(revision());

    expect(result).toMatchObject({ ok: true, replayed: false, revision: 2 });
    expect(Number(db.prepare("SELECT COUNT(*) AS n FROM plan_revisions").get()?.n)).toBe(2);
    expect(Number(db.prepare("SELECT COUNT(*) AS n FROM plan_admission_events").get()?.n)).toBe(1);
    expect(Number(db.prepare("SELECT COUNT(*) AS n FROM plan_admission_receipts").get()?.n)).toBe(
      1,
    );
    expect(db.prepare("SELECT * FROM append_command_receipts").get()).toMatchObject({
      command_type: "plan.revise",
      subject_key: "plan:adopted:2",
      plan_revision: 2,
      result_kind: "admission_certificate",
      result_ref: "certificate:revise-1",
    });
  });

  it("U-PA-REV-002: active aliasをplanIdとassetへ一意束縛する", () => {
    const { db, ledger } = fixture();

    expect(ledger.append(revision({ planId: "PLAN-L4-999" }))).toEqual({
      ok: false,
      ruleId: "plan-revision-alias-binding-invalid",
    });
    expect(Number(db.prepare("SELECT COUNT(*) AS n FROM plan_revisions").get()?.n)).toBe(1);
  });

  it("U-PA-REV-003: stale base revisionとbase digest差分をfail-closeする", () => {
    const { db, ledger } = fixture();

    expect(ledger.append(revision({ baseRevision: 0 }))).toEqual({
      ok: false,
      ruleId: "plan-revision-input-invalid",
    });
    expect(ledger.append(revision({ basePayloadDigest: sha("wrong") }))).toEqual({
      ok: false,
      ruleId: "plan-revision-base-digest-mismatch",
    });
    expect(ledger.append(revision()).ok).toBe(true);
    expect(ledger.append(revision({ commandId: "command:revise-2" }))).toEqual({
      ok: false,
      ruleId: "plan-revision-stale",
    });
    expect(Number(db.prepare("SELECT COUNT(*) AS n FROM plan_revisions").get()?.n)).toBe(2);
  });

  it("U-PA-REV-004: 同一command+payloadを再演し、payload差分をconflictにする", () => {
    const { db, ledger } = fixture();
    const input = revision();
    const first = ledger.append(input);

    expect(db.prepare("SELECT recorded_at FROM plan_admission_receipts").get()).toEqual({
      recorded_at: input.occurredAt,
    });
    if (!first.ok) throw new Error("initial revision append failed");
    const receipt = db
      .prepare("SELECT * FROM append_command_receipts WHERE command_id = ?")
      .get(input.commandId);
    expect(
      replayBindingFailures({
        db,
        input,
        expected: first,
        receipt: receipt as Record<string, unknown>,
      }),
    ).toEqual([]);
    expect(ledger.append(input)).toEqual(first.ok ? { ...first, replayed: true } : first);
    expect(ledger.append({ ...input, reason: "different" })).toEqual({
      ok: false,
      ruleId: "plan-revision-command-conflict",
    });
    expect(Number(db.prepare("SELECT COUNT(*) AS n FROM plan_revisions").get()?.n)).toBe(2);
  });

  it("U-PA-REV-005: prepared callback failureで全write setをrollbackする", () => {
    const { db, ledger } = fixture();

    expect(() =>
      ledger.transact(revision(), () => {
        throw new Error("publish-failed");
      }),
    ).toThrow("publish-failed");
    expect(Number(db.prepare("SELECT COUNT(*) AS n FROM plan_revisions").get()?.n)).toBe(1);
    expect(Number(db.prepare("SELECT COUNT(*) AS n FROM append_command_receipts").get()?.n)).toBe(
      0,
    );
    expect(Number(db.prepare("SELECT COUNT(*) AS n FROM plan_admission_events").get()?.n)).toBe(0);
  });

  it.each([
    ["append_command_receipts", "receipt_digest", "0".repeat(64)],
    ["plan_admission_events", "event_digest", "0".repeat(64)],
    ["plan_admission_receipts", "content_digest", "0".repeat(64)],
    ["plan_revisions", "canonical_payload_digest", "0".repeat(64)],
  ])("U-PA-REV-006: replay時の%s改ざんをfail-closeする", (table, column, value) => {
    const { db, ledger } = fixture();
    const input = revision();
    expect(ledger.append(input)).toMatchObject({ ok: true });
    const guards = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND sql LIKE ?")
      .all(`%UPDATE ON ${table}%`) as Array<{ name: string }>;
    for (const guard of guards) db.exec(`DROP TRIGGER ${guard.name}`);
    db.prepare(`UPDATE ${table} SET ${column} = ?`).run(value);
    expect(ledger.append(input)).toEqual({
      ok: false,
      ruleId: "plan-revision-receipt-binding-invalid",
    });
  });
});

function fixture() {
  const db = openHarnessDb(":memory:");
  opened.push(db);
  expect(migratePlanLedger(db)).toEqual({ ok: true, version: 7 });
  db.prepare("INSERT INTO plan_assets VALUES (?, ?, ?, ?)").run(
    "plan:adopted",
    "2026-07-15T00:00:00.000Z",
    "a".repeat(40),
    "legacy-adopt-v1",
  );
  db.prepare("INSERT INTO plan_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "plan:adopted",
    1,
    '{"title":"v1"}',
    sha('{"title":"v1"}'),
    sha("body-v1"),
    "docs/plans/PLAN-L4-31.md",
    "a".repeat(40),
    "migration",
    "adopt",
    "2026-07-15T00:00:00.000Z",
  );
  const aliasEvent = {
    alias_event_id: "alias:plan:adopted:1",
    asset_id: "plan:adopted",
    sequence: 1,
    command_id: "command:adopt-alias",
    command_payload_digest: sha("adopt-alias-command"),
    event_kind: "assigned",
    alias: "PLAN-L4-31",
    revision: 1,
    reason: "adopt",
    occurred_at: "2026-07-15T00:00:00.000Z",
  };
  const aliasEventDigest = ledgerRowDigest(aliasEvent, "event_digest");
  db.prepare("INSERT INTO plan_alias_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    ...Object.values(aliasEvent),
    aliasEventDigest,
  );
  db.prepare("INSERT INTO plan_aliases VALUES (?, ?, ?, ?, ?, ?)").run(
    "alias-current:plan:adopted",
    "plan:adopted",
    "PLAN-L4-31",
    1,
    null,
    aliasEventDigest,
  );
  expect(migratePlanLedger(db)).toEqual({ ok: true, version: 7 });
  const ledger = new PlanRevisionLedgerTransaction(db);
  return { db, ledger };
}

function revision(overrides: Partial<AppendPlanRevisionInput> = {}): AppendPlanRevisionInput {
  return {
    commandId: "command:revise-1",
    assetId: "plan:adopted",
    planId: "PLAN-L4-31",
    baseRevision: 1,
    basePayloadDigest: sha('{"title":"v1"}'),
    canonicalPayloadJson: '{"title":"v2"}',
    contentDigest: sha("canonical issued plan v2"),
    bodyDigest: sha("body-v2"),
    sourcePath: "docs/plans/PLAN-L4-31.md",
    sourceCommit: "b".repeat(40),
    actor: "codex",
    reason: "redesign",
    routeTupleDigest: sha("redesign|forward_merge"),
    certificateId: "certificate:revise-1",
    occurredAt: "2026-07-17T00:00:00.000Z",
    ...overrides,
  };
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
