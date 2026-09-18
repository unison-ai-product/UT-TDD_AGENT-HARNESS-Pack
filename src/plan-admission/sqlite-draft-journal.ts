import { createHash, timingSafeEqual } from "node:crypto";
import { ledgerRowDigest, migratePlanLedger } from "../plan-asset/ledger/schema.ts";
import type { HarnessDb } from "../state-db/index.ts";
import type {
  DraftCleanupOperation,
  DraftJournalCommand,
  DraftJournalEntry,
  DraftJournalPort,
  DraftReceiptBinding,
} from "./plan-draft-service.ts";

export class DraftJournalIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DraftJournalIntegrityError";
  }
}

export class DraftJournalRecoveryRequiredError extends DraftJournalIntegrityError {
  readonly ruleId = "draft-journal-legacy-cleanup-provenance-unknown" as const;

  readonly commandId: string;
  readonly reason: string;

  constructor(commandId: string, reason: string) {
    super("draft-journal-legacy-cleanup-provenance-unknown");
    this.commandId = commandId;
    this.reason = reason;
    this.name = "DraftJournalRecoveryRequiredError";
  }
}

/** SQLite v3 journal eventを正本、plan_draft_journalをcurrent projectionとして扱う。 */
export class SqliteDraftJournal implements DraftJournalPort<DraftReceiptBinding> {
  private readonly db: HarnessDb;
  private readonly now: () => string;

  constructor(db: HarnessDb, now: () => string = () => new Date().toISOString()) {
    this.db = db;
    this.now = now;
    if (!migratePlanLedger(db).ok) throw new DraftJournalIntegrityError("plan-ledger-unavailable");
  }

  find(commandId: string): DraftJournalEntry<DraftReceiptBinding> | undefined {
    this.assertIntegrity(commandId);
    let row = this.current(commandId);
    if (!row) return undefined;
    if (row.status === "intent") {
      const receipt = this.db
        .prepare("SELECT * FROM plan_admission_receipts WHERE command_id = ?")
        .get(commandId);
      if (receipt) {
        if (
          !secureEqual(String(receipt.command_payload_digest), String(row.command_payload_digest))
        )
          throw new DraftJournalIntegrityError("journal-ledger-payload-mismatch");
        this.markRecoveryRequired(
          commandId,
          String(row.command_payload_digest),
          "ledger receiptは存在するがartifact postimageを検証できないため明示recoveryが必要",
        );
        const refreshed = this.current(commandId);
        if (!refreshed) throw new DraftJournalIntegrityError("draft-journal-projection-missing");
        row = refreshed;
      }
    }
    if (row.status === "committed") {
      const ledger = this.db
        .prepare("SELECT * FROM plan_admission_receipts WHERE command_id = ?")
        .get(commandId);
      if (!ledger) throw new DraftJournalIntegrityError("draft-journal-ledger-binding-invalid");
      const cleanup = this.cleanupBinding(commandId, String(row.command_payload_digest));
      return {
        status: "committed",
        payloadDigest: String(row.command_payload_digest),
        receipt: binding(ledger),
        cleanup,
      };
    }
    return {
      status: row.status === "recovery_required" ? "recovery_required" : "intent",
      payloadDigest: String(row.command_payload_digest),
    };
  }

  recordIntent(command: DraftJournalCommand): void {
    if (
      !command.commandId ||
      !command.planId ||
      !command.sourcePath ||
      !validTime(command.recordedAt)
    )
      throw new DraftJournalIntegrityError("draft-journal-intent-invalid");
    this.run(() => {
      const existing = this.current(command.commandId);
      if (existing) {
        if (!secureEqual(String(existing.command_payload_digest), command.payloadDigest))
          throw new DraftJournalIntegrityError("draft-journal-command-conflict");
        throw new DraftJournalIntegrityError("draft-journal-intent-already-recorded");
      }
      const event = eventRow({
        command,
        sequence: 1,
        eventKind: "intent",
        occurredAt: command.recordedAt,
      });
      this.insertEvent(event);
      const current = {
        journal_id: `journal:${command.commandId}`,
        command_id: command.commandId,
        command_payload_digest: command.payloadDigest,
        status: "intent",
        requested_plan_id: command.planId,
        requested_source_path: command.sourcePath,
        plan_asset_id: null,
        plan_revision: null,
        certificate_id: null,
        intent_recorded_at: command.recordedAt,
        completed_at: null,
        failure_reason: null,
      };
      this.db
        .prepare("INSERT INTO plan_draft_journal VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(...Object.values(current), ledgerRowDigest(current, "journal_digest"));
    });
  }

  commit(input: {
    commandId: string;
    payloadDigest: string;
    receipt: DraftReceiptBinding;
    cleanup: DraftCleanupOperation;
  }): void {
    const { commandId, payloadDigest, receipt, cleanup } = input;
    assertCleanupOperation(cleanup);
    this.transition({ commandId, payloadDigest, status: "committed", receipt, cleanup });
  }

  markRecoveryRequired(commandId: string, payloadDigest: string, reason: string): void {
    this.transition({ commandId, payloadDigest, status: "recovery_required", reason });
  }

  markCleanupPending(commandId: string, payloadDigest: string, reason: string): void {
    if (!reason) throw new DraftJournalIntegrityError("draft-journal-cleanup-reason-required");
    this.run(() => {
      const current = this.current(commandId);
      if (!current || String(current.status) !== "committed")
        throw new DraftJournalIntegrityError("draft-journal-cleanup-before-commit");
      if (!secureEqual(String(current.command_payload_digest), payloadDigest))
        throw new DraftJournalIntegrityError("draft-journal-command-conflict");
      const previous = this.latestEvent(commandId);
      if (!previous) throw new DraftJournalIntegrityError("draft-journal-projection-missing");
      const command: DraftJournalCommand = {
        commandId,
        payloadDigest,
        planId: String(current.requested_plan_id),
        sourcePath: String(current.requested_source_path),
        recordedAt: String(current.intent_recorded_at),
      };
      const receipt: DraftReceiptBinding = {
        assetId: String(current.plan_asset_id),
        revision: Number(current.plan_revision),
        certificateId: String(current.certificate_id),
        commandPayloadDigest: payloadDigest,
      };
      this.insertEvent(
        eventRow({
          command,
          sequence: Number(previous.sequence) + 1,
          eventKind: "committed",
          occurredAt: this.now(),
          receipt,
          reason,
          previousEventDigest: String(previous.event_digest),
        }),
      );
      const next = { ...current, failure_reason: reason };
      this.db
        .prepare(
          "UPDATE plan_draft_journal SET failure_reason=?, journal_digest=? WHERE command_id=?",
        )
        .run(reason, ledgerRowDigest(next, "journal_digest"), commandId);
      this.appendCleanupEvent({ commandId, payloadDigest, eventKind: "pending", reason });
    });
  }

  completeCleanup(commandId: string, payloadDigest: string): void {
    this.run(() => {
      const current = this.current(commandId);
      if (!current || String(current.status) !== "committed")
        throw new DraftJournalIntegrityError("draft-journal-cleanup-before-commit");
      if (!secureEqual(String(current.command_payload_digest), payloadDigest))
        throw new DraftJournalIntegrityError("draft-journal-command-conflict");
      const cleanup = this.cleanupBinding(commandId, payloadDigest);
      if (cleanup.status === "completed") return;
      this.appendCleanupEvent({ commandId, payloadDigest, eventKind: "completed" });
      const next = { ...current, failure_reason: null };
      this.db
        .prepare(
          "UPDATE plan_draft_journal SET failure_reason=NULL, journal_digest=? WHERE command_id=?",
        )
        .run(ledgerRowDigest(next, "journal_digest"), commandId);
    });
  }

  private transition(input: {
    commandId: string;
    payloadDigest: string;
    status: "committed" | "recovery_required";
    receipt?: DraftReceiptBinding;
    reason?: string;
    cleanup?: DraftCleanupOperation;
  }): void {
    const { commandId, payloadDigest, status, receipt, reason, cleanup } = input;
    this.run(() => {
      const current = this.current(commandId);
      if (!current) throw new DraftJournalIntegrityError("draft-journal-intent-missing");
      if (!secureEqual(String(current.command_payload_digest), payloadDigest))
        throw new DraftJournalIntegrityError("draft-journal-command-conflict");
      if (String(current.status) === status) return;
      if (String(current.status) !== "intent")
        throw new DraftJournalIntegrityError("draft-journal-transition-invalid");
      if (status === "committed") {
        if (!receipt || receipt.revision < 1 || !cleanup)
          throw new DraftJournalIntegrityError("draft-journal-receipt-invalid");
        this.assertLedgerBinding(commandId, payloadDigest, receipt);
      }
      const previous = this.latestEvent(commandId);
      if (!previous || Number(previous.sequence) !== 1)
        throw new DraftJournalIntegrityError("draft-journal-event-sequence-invalid");
      const occurredAt = this.now();
      const command: DraftJournalCommand = {
        commandId,
        payloadDigest,
        planId: String(current.requested_plan_id),
        sourcePath: String(current.requested_source_path),
        recordedAt: String(current.intent_recorded_at),
      };
      this.insertEvent(
        eventRow({
          command,
          sequence: 2,
          eventKind: status,
          occurredAt,
          receipt,
          reason,
          previousEventDigest: String(previous.event_digest),
        }),
      );
      const next = {
        journal_id: String(current.journal_id),
        command_id: commandId,
        command_payload_digest: payloadDigest,
        status,
        requested_plan_id: command.planId,
        requested_source_path: command.sourcePath,
        plan_asset_id: receipt?.assetId ?? null,
        plan_revision: receipt?.revision ?? null,
        certificate_id: receipt?.certificateId ?? null,
        intent_recorded_at: command.recordedAt,
        completed_at: occurredAt,
        failure_reason: reason ?? null,
      };
      this.db
        .prepare(
          "UPDATE plan_draft_journal SET status=?, plan_asset_id=?, plan_revision=?, certificate_id=?, completed_at=?, failure_reason=?, journal_digest=? WHERE command_id=?",
        )
        .run(
          next.status,
          next.plan_asset_id,
          next.plan_revision,
          next.certificate_id,
          next.completed_at,
          next.failure_reason,
          ledgerRowDigest(next, "journal_digest"),
          commandId,
        );
      if (status === "committed" && cleanup)
        this.appendCleanupEvent({
          commandId,
          payloadDigest,
          eventKind: "pending",
          initial: cleanup,
        });
    });
  }

  private cleanupBinding(
    commandId: string,
    payloadDigest: string,
  ): import("./plan-draft-service.ts").DraftCleanupBinding {
    const rows = this.db
      .prepare(
        "SELECT * FROM plan_draft_artifact_operation_events WHERE command_id = ? ORDER BY sequence",
      )
      .all(commandId);
    if (rows.length === 0)
      throw new DraftJournalIntegrityError("draft-journal-cleanup-binding-missing");
    const legacyUnknown = rows.find((row) => row.event_kind === "legacy_unknown");
    if (legacyUnknown) {
      const journal = this.current(commandId);
      const latestJournalEvent = this.latestEvent(commandId);
      assertLegacyUnknownOperation({
        row: legacyUnknown,
        commandId,
        payloadDigest,
        journalDigest: String(journal?.journal_digest),
        latestJournalEventDigest: String(latestJournalEvent?.event_digest),
      });
      throw new DraftJournalRecoveryRequiredError(commandId, String(legacyUnknown.failure_reason));
    }
    let previous: string | null = null;
    let operationJson: string | undefined;
    for (const [index, row] of rows.entries()) {
      if (
        Number(row.sequence) !== index + 1 ||
        row.previous_event_digest !== previous ||
        !secureEqual(String(row.command_payload_digest), payloadDigest) ||
        row.event_digest !== ledgerRowDigest(row, "event_digest") ||
        sha(String(row.operation_json)) !== String(row.operation_digest)
      )
        throw new DraftJournalIntegrityError("draft-journal-cleanup-binding-invalid");
      operationJson ??= String(row.operation_json);
      if (String(row.operation_json) !== operationJson)
        throw new DraftJournalIntegrityError("draft-journal-cleanup-operation-diverged");
      previous = String(row.event_digest);
    }
    const latest = rows.at(-1);
    if (!latest || !operationJson)
      throw new DraftJournalIntegrityError("draft-journal-cleanup-binding-missing");
    const operation = parseCleanupOperation(operationJson);
    return {
      status: latest.event_kind === "completed" ? "completed" : "pending",
      operation,
      ...(typeof latest.failure_reason === "string" && latest.failure_reason
        ? { reason: latest.failure_reason }
        : {}),
    };
  }

  private appendCleanupEvent(input: {
    commandId: string;
    payloadDigest: string;
    eventKind: "pending" | "completed";
    reason?: string;
    initial?: DraftCleanupOperation;
  }): void {
    const { commandId, payloadDigest, eventKind, reason, initial } = input;
    const previous = this.db
      .prepare(
        "SELECT * FROM plan_draft_artifact_operation_events WHERE command_id = ? ORDER BY sequence DESC LIMIT 1",
      )
      .get(commandId);
    const operationJson = initial
      ? JSON.stringify(initial)
      : String(previous?.operation_json ?? "");
    if (!operationJson)
      throw new DraftJournalIntegrityError("draft-journal-cleanup-binding-missing");
    if (previous && !secureEqual(String(previous.command_payload_digest), payloadDigest))
      throw new DraftJournalIntegrityError("draft-journal-command-conflict");
    const sequence = Number(previous?.sequence ?? 0) + 1;
    const row = {
      operation_event_id: `artifact-operation:${commandId}:${sequence}`,
      command_id: commandId,
      sequence,
      command_payload_digest: payloadDigest,
      event_kind: eventKind,
      operation_json: operationJson,
      operation_digest: sha(operationJson),
      failure_reason: reason ?? null,
      occurred_at: this.now(),
      previous_event_digest: previous?.event_digest ?? null,
    };
    this.db
      .prepare(
        "INSERT INTO plan_draft_artifact_operation_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(...Object.values(row), ledgerRowDigest(row, "event_digest"));
  }

  private assertIntegrity(commandId: string): void {
    const current = this.current(commandId);
    const events = this.db
      .prepare("SELECT * FROM plan_draft_journal_events WHERE command_id = ? ORDER BY sequence")
      .all(commandId);
    if (!current && events.length === 0) return;
    if (!current || events.length === 0)
      throw new DraftJournalIntegrityError("draft-journal-projection-missing");
    if (current.journal_digest !== ledgerRowDigest(current, "journal_digest"))
      throw new DraftJournalIntegrityError("draft-journal-current-digest-invalid");
    let previous: string | null = null;
    for (const [index, event] of events.entries()) {
      if (Number(event.sequence) !== index + 1 || event.previous_event_digest !== previous)
        throw new DraftJournalIntegrityError("draft-journal-chain-invalid");
      if (event.event_digest !== ledgerRowDigest(event, "event_digest"))
        throw new DraftJournalIntegrityError("draft-journal-event-digest-invalid");
      previous = String(event.event_digest);
    }
    const latest = events.at(-1);
    if (!latest) throw new DraftJournalIntegrityError("draft-journal-projection-missing");
    if (
      latest.event_kind !== current.status ||
      latest.command_payload_digest !== current.command_payload_digest ||
      latest.plan_asset_id !== current.plan_asset_id ||
      latest.plan_revision !== current.plan_revision ||
      latest.certificate_id !== current.certificate_id
    )
      throw new DraftJournalIntegrityError("draft-journal-projection-diverged");
  }

  private current(commandId: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM plan_draft_journal WHERE command_id = ?").get(commandId);
  }

  private assertLedgerBinding(
    commandId: string,
    payloadDigest: string,
    receipt: DraftReceiptBinding,
  ): void {
    const ledger = this.db
      .prepare("SELECT * FROM plan_admission_receipts WHERE command_id = ?")
      .get(commandId);
    if (
      !ledger ||
      !secureEqual(String(ledger.command_payload_digest), payloadDigest) ||
      !secureEqual(receipt.commandPayloadDigest, payloadDigest) ||
      String(ledger.plan_asset_id) !== receipt.assetId ||
      Number(ledger.plan_revision) !== receipt.revision ||
      String(ledger.certificate_id) !== receipt.certificateId
    )
      throw new DraftJournalIntegrityError("draft-journal-ledger-binding-invalid");
  }

  private latestEvent(commandId: string): Record<string, unknown> | undefined {
    return this.db
      .prepare(
        "SELECT * FROM plan_draft_journal_events WHERE command_id = ? ORDER BY sequence DESC LIMIT 1",
      )
      .get(commandId);
  }

  private insertEvent(row: Record<string, unknown>): void {
    this.db
      .prepare(
        "INSERT INTO plan_draft_journal_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(...Object.values(row), ledgerRowDigest(row, "event_digest"));
  }

  private run(operation: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      operation();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function assertLegacyUnknownOperation(input: {
  row: Record<string, unknown>;
  commandId: string;
  payloadDigest: string;
  journalDigest: string;
  latestJournalEventDigest: string;
}): void {
  const { row, commandId, payloadDigest, journalDigest, latestJournalEventDigest } = input;
  let operation: unknown;
  try {
    operation = JSON.parse(String(row.operation_json));
  } catch (cause) {
    const error = new DraftJournalIntegrityError("draft-journal-cleanup-binding-invalid", {
      cause,
    });
    throw error;
  }
  const value = operation as Record<string, unknown> | null;
  if (
    !value ||
    Object.keys(value).sort().join(",") !==
      "journalDigest,latestJournalEventDigest,operation,reason,sourceSchemaVersion" ||
    value.operation !== "legacy_unknown" ||
    ![4, 5].includes(Number(value.sourceSchemaVersion)) ||
    !/^[a-f0-9]{64}$/.test(journalDigest) ||
    !/^[a-f0-9]{64}$/.test(latestJournalEventDigest) ||
    value.journalDigest !== journalDigest ||
    value.latestJournalEventDigest !== latestJournalEventDigest ||
    typeof value.reason !== "string" ||
    !value.reason ||
    row.command_id !== commandId ||
    !secureEqual(String(row.command_payload_digest), payloadDigest) ||
    row.failure_reason !== value.reason
  )
    throw new DraftJournalIntegrityError("draft-journal-cleanup-binding-invalid");
}

function eventRow(input: {
  command: DraftJournalCommand;
  sequence: number;
  eventKind: "intent" | "committed" | "recovery_required";
  occurredAt: string;
  receipt?: DraftReceiptBinding;
  reason?: string;
  previousEventDigest?: string;
}): Record<string, unknown> {
  return {
    journal_event_id: `journal-event:${input.command.commandId}:${input.sequence}`,
    command_id: input.command.commandId,
    sequence: input.sequence,
    command_payload_digest: input.command.payloadDigest,
    event_kind: input.eventKind,
    requested_plan_id: input.command.planId,
    requested_source_path: input.command.sourcePath,
    plan_asset_id: input.receipt?.assetId ?? null,
    plan_revision: input.receipt?.revision ?? null,
    certificate_id: input.receipt?.certificateId ?? null,
    occurred_at: input.occurredAt,
    failure_reason: input.reason ?? null,
    previous_event_digest: input.previousEventDigest ?? null,
  };
}

function binding(row: Record<string, unknown>): DraftReceiptBinding {
  const result = {
    assetId: String(row.plan_asset_id),
    revision: Number(row.plan_revision),
    certificateId: String(row.certificate_id),
    commandPayloadDigest: String(row.command_payload_digest),
    ...(typeof row.certificate_digest === "string"
      ? { certificateDigest: row.certificate_digest }
      : {}),
  };
  if (
    !result.assetId ||
    !result.certificateId ||
    !/^[a-f0-9]{64}$/.test(result.commandPayloadDigest) ||
    !Number.isSafeInteger(result.revision) ||
    result.revision < 1
  )
    throw new DraftJournalIntegrityError("draft-journal-receipt-invalid");
  return result;
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function validTime(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function parseCleanupOperation(value: string): DraftCleanupOperation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    const error = new DraftJournalIntegrityError("draft-journal-cleanup-operation-invalid", {
      cause,
    });
    throw error;
  }
  assertCleanupOperation(parsed);
  return parsed;
}

function assertCleanupOperation(value: unknown): asserts value is DraftCleanupOperation {
  const operation = value as Partial<DraftCleanupOperation> | null;
  if (
    !operation ||
    operation.operation !== "finalize" ||
    typeof operation.tokenId !== "string" ||
    !operation.tokenId ||
    !/^sha256:[a-f0-9]{64}$/.test(String(operation.requestDigest)) ||
    !Array.isArray(operation.artifacts) ||
    operation.artifacts.length !== 2 ||
    operation.artifacts.some(
      (artifact) =>
        !artifact ||
        typeof artifact.path !== "string" ||
        typeof artifact.temporaryPath !== "string" ||
        typeof artifact.rollbackPath !== "string" ||
        !artifact.preimage ||
        !["absent", "sha256"].includes(artifact.preimage.kind) ||
        (artifact.preimage.kind === "sha256" &&
          !/^sha256:[a-f0-9]{64}$/.test(artifact.preimage.digest)) ||
        !/^sha256:[a-f0-9]{64}$/.test(String(artifact.postimage)),
    )
  )
    throw new DraftJournalIntegrityError("draft-journal-cleanup-operation-invalid");
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
