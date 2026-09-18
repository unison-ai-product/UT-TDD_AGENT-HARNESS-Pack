import { describe, expect, it } from "vitest";
import {
  type DraftArtifact,
  type DraftCleanupOperation,
  type DraftJournalCommit,
  type DraftJournalEntry,
  type DraftJournalPort,
  type DraftLedgerPort,
  type DraftPublisherPort,
  type DraftPublishToken,
  PlanDraftCleanupPendingError,
  type PlanDraftCommand,
  PlanDraftConflictError,
  PlanDraftRecoveryRequiredError,
  PlanDraftService,
} from "../src/plan-admission/plan-draft-service.ts";

type Payload = { planId: string };
type Receipt = {
  assetId: string;
  revision: number;
  certificateId: string;
  commandPayloadDigest: string;
};

const command: PlanDraftCommand<Payload> = {
  commandId: "cmd-1",
  commandPayloadDigest: "sha256:payload",
  planId: "PLAN-L7-999",
  recordedAt: "2026-07-15T00:00:00.000Z",
  payload: { planId: "PLAN-L7-999" },
  source: { path: "docs/plans/PLAN-L7-999.md", content: "source" },
  projectionPath: "docs/governance/plan-admission-receipts.json",
};

const receipt = (digest = command.commandPayloadDigest): Receipt => ({
  assetId: "asset-1",
  revision: 1,
  certificateId: "certificate-1",
  commandPayloadDigest: digest,
});
const cleanup = (): DraftCleanupOperation => ({
  operation: "finalize",
  tokenId: "staged",
  requestDigest: `sha256:${"a".repeat(64)}` as `sha256:${string}`,
  artifacts: [
    {
      path: "source",
      temporaryPath: "source.tmp",
      rollbackPath: "source.rollback",
      preimage: { kind: "absent" },
      postimage: `sha256:${"b".repeat(64)}`,
    },
    {
      path: "projection",
      temporaryPath: "projection.tmp",
      rollbackPath: "projection.rollback",
      preimage: { kind: "absent" },
      postimage: `sha256:${"c".repeat(64)}`,
    },
  ],
});

class Journal implements DraftJournalPort<Receipt> {
  entry?: DraftJournalEntry<Receipt>;
  failCommit = false;
  failCleanupPending = false;

  private readonly events: string[];

  constructor(events: string[]) {
    this.events = events;
  }

  find(): DraftJournalEntry<Receipt> | undefined {
    this.events.push("journal.find");
    return this.entry;
  }

  recordIntent(intent: { payloadDigest: string }): void {
    this.events.push("journal.intent");
    this.entry = { status: "intent", payloadDigest: intent.payloadDigest };
  }

  commit(input: DraftJournalCommit<Receipt>): void {
    const { payloadDigest: digest, receipt: committedReceipt, cleanup: operation } = input;
    this.events.push("journal.commit");
    if (this.failCommit) throw new Error("journal commit failed");
    this.entry = {
      status: "committed",
      payloadDigest: digest,
      receipt: committedReceipt,
      cleanup: { status: "pending", operation },
    };
  }

  markRecoveryRequired(_id: string, digest: string, reason: string): void {
    this.events.push(`journal.recovery:${reason}`);
    this.entry = { status: "recovery_required", payloadDigest: digest };
  }

  markCleanupPending(_id: string, digest: string, reason: string): void {
    this.events.push(`journal.cleanup:${reason}`);
    if (this.failCleanupPending) throw new Error("cleanup pending journal failed");
    if (!this.entry || this.entry.status !== "committed") throw new Error("not committed");
    this.entry = {
      ...this.entry,
      payloadDigest: digest,
      cleanup: { ...this.entry.cleanup, status: "pending", reason },
    };
  }

  completeCleanup(_id: string, digest: string): void {
    this.events.push("journal.cleanup-complete");
    if (!this.entry || this.entry.status !== "committed") throw new Error("not committed");
    this.entry = {
      ...this.entry,
      payloadDigest: digest,
      cleanup: { ...this.entry.cleanup, status: "completed" },
    };
  }
}

class Publisher implements DraftPublisherPort {
  failRestore = false;
  finalizeFailures = 0;
  failResume = false;

  private readonly events: string[];

  constructor(events: string[]) {
    this.events = events;
  }

  stage(artifacts: readonly DraftArtifact[]): DraftPublishToken {
    this.events.push(`publisher.stage:${artifacts.map((item) => item.path).join(",")}`);
    return { id: "staged" };
  }

  publish(): void {
    this.events.push("publisher.publish");
  }

  restore(): void {
    this.events.push("publisher.restore");
    if (this.failRestore) throw new Error("restore failed");
  }

  finalize(): void {
    this.events.push("publisher.finalize");
    if (this.finalizeFailures-- > 0) throw new Error("finalize failed");
  }

  dispose(): void {
    this.events.push("publisher.dispose");
  }

  describeCleanup(
    _token: DraftPublishToken,
    requestDigest: `sha256:${string}`,
  ): DraftCleanupOperation {
    return { ...cleanup(), requestDigest };
  }

  resumeCleanup(): void {
    this.events.push("publisher.resume-cleanup");
    if (this.failResume) throw new Error("resume failed");
  }
}

function fixture(options: { ledgerFailure?: boolean; preparedDigest?: string } = {}) {
  const events: string[] = [];
  const journal = new Journal(events);
  const publisher = new Publisher(events);
  const ledger: DraftLedgerPort<Payload, Receipt> = {
    transact: (_command, onPrepared) => {
      events.push("ledger.begin");
      const prepared = receipt(options.preparedDigest);
      onPrepared(prepared);
      if (options.ledgerFailure) {
        events.push("ledger.rollback");
        throw new Error("ledger failed");
      }
      events.push("ledger.commit");
      return prepared;
    },
  };
  const service = new PlanDraftService({
    validator: { validate: () => events.push("validator.validate") },
    journal,
    publisher,
    renderer: {
      render: (draftCommand, prepared) => {
        events.push("renderer.render");
        return [
          draftCommand.source,
          { path: draftCommand.projectionPath, content: prepared.certificateId },
        ];
      },
    },
    ledger,
  });
  return { events, journal, publisher, service };
}

describe("PlanDraftService", () => {
  it("U-PADM-023: intentからledger/file公開、journal commit、finalizeまでを設計順に実行する", () => {
    const f = fixture();

    expect(f.service.execute(command)).toEqual({ status: "created", receipt: receipt() });
    expect(f.events).toEqual([
      "validator.validate",
      "journal.find",
      "journal.intent",
      "ledger.begin",
      "renderer.render",
      "publisher.stage:docs/plans/PLAN-L7-999.md,docs/governance/plan-admission-receipts.json",
      "publisher.publish",
      "ledger.commit",
      "journal.commit",
      "publisher.finalize",
      "journal.cleanup-complete",
    ]);
  });

  it("U-PADM-024: committed commandを副作用なしでreplayする", () => {
    const f = fixture();
    f.journal.entry = {
      status: "committed",
      payloadDigest: command.commandPayloadDigest,
      receipt: receipt(),
      cleanup: { status: "completed", operation: cleanup() },
    };

    expect(f.service.execute(command)).toEqual({ status: "replayed", receipt: receipt() });
    expect(f.events).toEqual(["validator.validate", "journal.find", "publisher.resume-cleanup"]);
  });

  it("U-PADM-025: 同じcommand idの異なるdigestを副作用前にfail-closeする", () => {
    const f = fixture();
    f.journal.entry = {
      status: "committed",
      payloadDigest: "sha256:other",
      receipt: receipt("sha256:other"),
      cleanup: { status: "completed", operation: cleanup() },
    };

    expect(() => f.service.execute(command)).toThrow(PlanDraftConflictError);
    expect(f.events).toEqual(["validator.validate", "journal.find"]);
  });

  it("U-PADM-026: ledger failureでは公開ファイルをrestoreしてrecovery_requiredにする", () => {
    const f = fixture({ ledgerFailure: true });

    expect(() => f.service.execute(command)).toThrow(PlanDraftRecoveryRequiredError);
    expect(f.events).toEqual([
      "validator.validate",
      "journal.find",
      "journal.intent",
      "ledger.begin",
      "renderer.render",
      "publisher.stage:docs/plans/PLAN-L7-999.md,docs/governance/plan-admission-receipts.json",
      "publisher.publish",
      "ledger.rollback",
      "publisher.restore",
      "publisher.dispose",
      "journal.recovery:draft失敗。artifactはrestore済み: ledger failed",
    ]);
    expect(f.journal.entry?.status).toBe("recovery_required");
  });

  it("U-PADM-027: journal commit failureでは確定済みDB/fileを戻さずrecovery_requiredにする", () => {
    const f = fixture();
    f.journal.failCommit = true;

    expect(() => f.service.execute(command)).toThrow(PlanDraftRecoveryRequiredError);
    expect(f.events).toEqual([
      "validator.validate",
      "journal.find",
      "journal.intent",
      "ledger.begin",
      "renderer.render",
      "publisher.stage:docs/plans/PLAN-L7-999.md,docs/governance/plan-admission-receipts.json",
      "publisher.publish",
      "ledger.commit",
      "journal.commit",
      "publisher.dispose",
      "journal.recovery:ledger/file公開後にjournal commit失敗: journal commit failed",
    ]);
    expect(f.events).not.toContain("publisher.restore");
    expect(f.events).not.toContain("publisher.finalize");
  });

  it("U-PADM-059: ledger receiptのdigest不一致を公開前にfail-closeしてrecovery_requiredにする", () => {
    const f = fixture({ preparedDigest: "sha256:other" });

    expect(() => f.service.execute(command)).toThrow(PlanDraftRecoveryRequiredError);
    expect(f.events).toEqual([
      "validator.validate",
      "journal.find",
      "journal.intent",
      "ledger.begin",
      "journal.recovery:draft失敗。artifact変更なし: ledger receiptのcommand digestがintentと一致しません",
    ]);
  });

  it("U-PADM-060: restore失敗を記録し、次回の自動再実行を拒否する", () => {
    const f = fixture({ ledgerFailure: true });
    f.publisher.failRestore = true;

    expect(() => f.service.execute(command)).toThrow(/restore\/resource解放に失敗/);
    const firstRun = [...f.events];
    expect(() => f.service.execute(command)).toThrow(/自動再実行できません/);
    expect(f.events.slice(firstRun.length)).toEqual(["validator.validate", "journal.find"]);
  });

  it("U-PADM-061: finalize通常例外は同じtokenから再開して論理成功を返す", () => {
    const f = fixture();
    f.publisher.finalizeFailures = 1;

    expect(f.service.execute(command)).toEqual({ status: "created", receipt: receipt() });
    expect(f.events.slice(-3)).toEqual([
      "publisher.finalize",
      "publisher.finalize",
      "journal.cleanup-complete",
    ]);
    expect(f.service.execute(command)).toEqual({ status: "replayed", receipt: receipt() });
  });

  it("U-PADM-062: 継続するfinalize障害をdurable cleanup-pendingとして遮断する", () => {
    const f = fixture();
    f.publisher.finalizeFailures = 2;

    expect(() => f.service.execute(command)).toThrow(PlanDraftCleanupPendingError);
    expect(f.journal.entry).toMatchObject({
      status: "committed",
      cleanup: { status: "pending", reason: expect.stringContaining("artifact cleanup未完了") },
    });
    expect(f.events).toContain("publisher.dispose");
    const beforeReplay = [...f.events];
    expect(f.service.execute(command)).toEqual({ status: "replayed", receipt: receipt() });
    expect(f.events.slice(beforeReplay.length)).toEqual([
      "validator.validate",
      "journal.find",
      "publisher.resume-cleanup",
      "journal.cleanup-complete",
    ]);
  });

  it("U-PADM-071: cleanup-pending記録失敗は全障害をcauseに保持する", () => {
    const f = fixture();
    f.publisher.finalizeFailures = 2;
    f.journal.failCleanupPending = true;

    let failure: unknown;
    try {
      f.service.execute(command);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(PlanDraftCleanupPendingError);
    expect((failure as Error).cause).toBeInstanceOf(AggregateError);
    expect(((failure as Error).cause as AggregateError).errors).toMatchObject([
      { message: "finalize failed" },
      { message: "finalize failed" },
      { message: "cleanup pending journal failed" },
    ]);
  });
});
