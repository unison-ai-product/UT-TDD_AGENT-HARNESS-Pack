import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  DraftJournalIntegrityError,
  DraftJournalRecoveryRequiredError,
  SqliteDraftJournal,
} from "../src/plan-admission/sqlite-draft-journal.ts";
import { PlanDraftLedgerTransaction } from "../src/plan-asset/ledger/plan-draft-ledger.ts";
import { openHarnessDb } from "../src/state-db/index.ts";

const opened: ReturnType<typeof openHarnessDb>[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

const intent = {
  commandId: "command:draft-1",
  payloadDigest: "a".repeat(64),
  planId: "PLAN-L7-999",
  sourcePath: "docs/plans/PLAN-L7-999.md",
  recordedAt: "2026-07-15T00:00:00.000Z",
};
const receipt = { assetId: "asset:draft-1", revision: 1, certificateId: "certificate:draft-1" };
const boundReceipt = (commandPayloadDigest: string, certificateDigest?: string) => ({
  ...receipt,
  commandPayloadDigest,
  ...(certificateDigest ? { certificateDigest } : {}),
});
const cleanup = () => ({
  operation: "finalize" as const,
  tokenId: "token-1",
  requestDigest: `sha256:${"a".repeat(64)}` as const,
  artifacts: [
    {
      path: "docs/plans/a.md",
      temporaryPath: "docs/plans/a.tmp",
      rollbackPath: "docs/plans/a.rollback",
      preimage: { kind: "absent" as const },
      postimage: `sha256:${"b".repeat(64)}` as const,
    },
    {
      path: "docs/governance/plan-admission-receipts.json",
      temporaryPath: "docs/governance/p.tmp",
      rollbackPath: "docs/governance/p.rollback",
      preimage: { kind: "absent" as const },
      postimage: `sha256:${"c".repeat(64)}` as const,
    },
  ] as const,
});

describe("SqliteDraftJournal", () => {
  it("U-PADM-028: intentとcommitをappend-only eventへ残しcurrentを投影する", () => {
    const { db, journal } = fixture();
    const result = new PlanDraftLedgerTransaction(db).append(draft());
    if (!result.ok) throw new Error(result.ruleId);
    const boundIntent = { ...intent, payloadDigest: result.commandPayloadDigest };
    journal.recordIntent(boundIntent);
    journal.commit({
      commandId: boundIntent.commandId,
      payloadDigest: boundIntent.payloadDigest,
      receipt: boundReceipt(boundIntent.payloadDigest),
      cleanup: cleanup(),
    });

    expect(journal.find(intent.commandId)).toEqual({
      status: "committed",
      payloadDigest: boundIntent.payloadDigest,
      receipt: boundReceipt(boundIntent.payloadDigest, result.certificateDigest),
      cleanup: { status: "pending", operation: cleanup() },
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM plan_draft_journal_events").get()?.n).toBe(2);
    expect(() =>
      db.exec("DELETE FROM plan_draft_journal_events WHERE command_id = 'command:draft-1'"),
    ).toThrow(/append-only/);
  });

  it("U-PADM-029: command再利用競合とrecovery_requiredからの自動遷移をfail-closeする", () => {
    const { journal } = fixture();
    journal.recordIntent(intent);
    expect(() => journal.recordIntent({ ...intent, payloadDigest: "b".repeat(64) })).toThrow(
      /command-conflict/,
    );
    journal.markRecoveryRequired(intent.commandId, intent.payloadDigest, "restore済み");
    expect(journal.find(intent.commandId)).toEqual({
      status: "recovery_required",
      payloadDigest: intent.payloadDigest,
    });
    expect(() =>
      journal.commit({
        commandId: intent.commandId,
        payloadDigest: intent.payloadDigest,
        receipt: boundReceipt(intent.payloadDigest),
        cleanup: cleanup(),
      }),
    ).toThrow(/transition-invalid/);
  });

  it("U-PADM-030: crash後のintentとledger receiptを自動commitせずrecovery_requiredへ遮断する", () => {
    const db = openHarnessDb(":memory:");
    opened.push(db);
    const result = new PlanDraftLedgerTransaction(db).append(draft());
    if (!result.ok) throw new Error(result.ruleId);
    const journal = new SqliteDraftJournal(db, () => "2026-07-15T00:01:00.000Z");
    journal.recordIntent({ ...intent, payloadDigest: result.commandPayloadDigest });

    expect(journal.find(intent.commandId)).toEqual({
      status: "recovery_required",
      payloadDigest: result.commandPayloadDigest,
    });
    expect(db.prepare("SELECT status FROM plan_draft_journal").get()?.status).toBe(
      "recovery_required",
    );
  });

  it("U-PADM-031: currentまたはeventの改ざんをdigest/chainで遮断する", () => {
    const { db, journal } = fixture();
    journal.recordIntent(intent);
    db.exec("UPDATE plan_draft_journal SET requested_plan_id = 'PLAN-L7-TAMPER'");
    expect(() => journal.find(intent.commandId)).toThrow(DraftJournalIntegrityError);

    const second = fixture();
    second.journal.recordIntent(intent);
    second.db.exec("DROP TRIGGER trg_plan_draft_journal_events_no_update");
    second.db.exec("UPDATE plan_draft_journal_events SET requested_plan_id = 'PLAN-L7-TAMPER'");
    expect(() => second.journal.find(intent.commandId)).toThrow(DraftJournalIntegrityError);
  });

  it("U-PADM-063: commit後のcleanup-pendingをappend-only eventとcurrentへ永続化する", () => {
    const { db, journal } = fixture();
    const result = new PlanDraftLedgerTransaction(db).append(draft());
    if (!result.ok) throw new Error(result.ruleId);
    const boundIntent = { ...intent, payloadDigest: result.commandPayloadDigest };
    const committed = boundReceipt(boundIntent.payloadDigest);
    journal.recordIntent(boundIntent);
    journal.commit({
      commandId: boundIntent.commandId,
      payloadDigest: boundIntent.payloadDigest,
      receipt: committed,
      cleanup: cleanup(),
    });

    journal.markCleanupPending(
      boundIntent.commandId,
      boundIntent.payloadDigest,
      "artifact cleanup未完了",
    );

    expect(journal.find(boundIntent.commandId)).toEqual({
      status: "committed",
      payloadDigest: boundIntent.payloadDigest,
      receipt: boundReceipt(boundIntent.payloadDigest, result.certificateDigest),
      cleanup: { status: "pending", operation: cleanup(), reason: "artifact cleanup未完了" },
    });
    expect(
      db
        .prepare(
          "SELECT sequence, event_kind, failure_reason FROM plan_draft_journal_events ORDER BY sequence DESC LIMIT 1",
        )
        .get(),
    ).toEqual({ sequence: 3, event_kind: "committed", failure_reason: "artifact cleanup未完了" });
  });

  it("U-PADM-064: 別process相当のjournal instanceがdurable cleanup operationを再開・完了できる", () => {
    const { db, journal } = fixture();
    const result = new PlanDraftLedgerTransaction(db).append(draft());
    if (!result.ok) throw new Error(result.ruleId);
    const boundIntent = { ...intent, payloadDigest: result.commandPayloadDigest };
    journal.recordIntent(boundIntent);
    journal.commit({
      commandId: boundIntent.commandId,
      payloadDigest: boundIntent.payloadDigest,
      receipt: boundReceipt(boundIntent.payloadDigest),
      cleanup: cleanup(),
    });
    journal.markCleanupPending(boundIntent.commandId, boundIntent.payloadDigest, "process exit");

    const restarted = new SqliteDraftJournal(db, () => "2026-07-15T00:02:00.000Z");
    expect(restarted.find(boundIntent.commandId)).toMatchObject({
      cleanup: { status: "pending", operation: cleanup(), reason: "process exit" },
    });
    restarted.completeCleanup(boundIntent.commandId, boundIntent.payloadDigest);
    expect(restarted.find(boundIntent.commandId)).toMatchObject({
      cleanup: { status: "completed", operation: cleanup() },
    });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM plan_draft_artifact_operation_events").get()?.n,
    ).toBe(3);
  });

  it.each([
    4, 5,
  ] as const)("U-PADM-069: v%s committed journalのcleanup不明状態をtyped recovery-requiredで遮断する", (version) => {
    const { db, journal } = fixture();
    const result = new PlanDraftLedgerTransaction(db).append(draft());
    if (!result.ok) throw new Error(result.ruleId);
    const boundIntent = { ...intent, payloadDigest: result.commandPayloadDigest };
    journal.recordIntent(boundIntent);
    journal.commit({
      commandId: boundIntent.commandId,
      payloadDigest: boundIntent.payloadDigest,
      receipt: boundReceipt(boundIntent.payloadDigest),
      cleanup: cleanup(),
    });
    downgradeCleanupSchema(db, version);

    const restarted = new SqliteDraftJournal(db);
    let failure: unknown;
    try {
      restarted.find(boundIntent.commandId);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DraftJournalRecoveryRequiredError);
    expect(failure).toMatchObject({
      ruleId: "draft-journal-legacy-cleanup-provenance-unknown",
      commandId: boundIntent.commandId,
      reason: "旧schemaにはartifact cleanup provenanceが存在せず完了状態を証明できない",
    });
    expect(db.prepare("SELECT event_kind FROM plan_draft_artifact_operation_events").get()).toEqual(
      { event_kind: "legacy_unknown" },
    );
  });
});

function downgradeCleanupSchema(db: ReturnType<typeof openHarnessDb>, version: 4 | 5): void {
  // v7 (sealed lineage) のオブジェクトも落とさないと v4/v5 の版チェックが不一致になる
  for (const table of [
    "plan_lineage_migration_certificates",
    "sealed_plan_lineages",
    "genesis_issue_custody",
  ]) {
    db.exec(`DROP TRIGGER trg_${table}_no_update`);
    db.exec(`DROP TRIGGER trg_${table}_no_delete`);
    db.exec(`DROP TABLE ${table}`);
  }
  db.exec("DROP TRIGGER trg_plan_draft_artifact_operation_events_no_update");
  db.exec("DROP TRIGGER trg_plan_draft_artifact_operation_events_no_delete");
  db.exec("DROP INDEX idx_plan_draft_artifact_operations_command");
  db.exec("DROP TABLE plan_draft_artifact_operation_events");
  if (version === 4) {
    db.exec("DROP TRIGGER trg_legacy_plan_bootstrap_provenance_no_update");
    db.exec("DROP TRIGGER trg_legacy_plan_bootstrap_provenance_no_delete");
    db.exec("DROP INDEX idx_legacy_bootstrap_source_blob");
    db.exec("DROP TABLE legacy_plan_bootstrap_provenance");
  }
  db.setUserVersion(version);
}

function fixture() {
  const db = openHarnessDb(":memory:");
  opened.push(db);
  return { db, journal: new SqliteDraftJournal(db, () => "2026-07-15T00:01:00.000Z") };
}

function draft() {
  return {
    commandId: intent.commandId,
    assetId: receipt.assetId,
    planId: intent.planId,
    alias: intent.planId,
    sourcePath: intent.sourcePath,
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
    certificateId: receipt.certificateId,
    occurredAt: intent.recordedAt,
  };
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
