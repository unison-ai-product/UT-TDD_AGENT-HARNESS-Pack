import { createHash, timingSafeEqual } from "node:crypto";
import type { HarnessDb } from "../../state-db/index.ts";
import { ledgerRowDigest } from "./schema.ts";
import { ImmediateLedgerTransaction, type LedgerTransactionPort } from "./transaction.ts";

export type AppendResult =
  | { readonly ok: true; readonly replayed: boolean; readonly resultRef: string }
  | { readonly ok: false; readonly ruleId: string };

export interface LedgerFaultPort {
  after(boundary: string): void;
}

interface AppendCommand {
  readonly commandId: string;
  readonly commandType: string;
  readonly subjectKind: "reservation" | "legacy_migration";
  readonly subjectKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly recordedAt: string;
  readonly resultKind: "reservation_event" | "migration_event";
  readonly conflictRuleId: string;
}

export class AppendCommandTransaction {
  private readonly transaction: LedgerTransactionPort;

  private readonly db: HarnessDb;
  private readonly fault?: LedgerFaultPort;

  constructor(db: HarnessDb, transaction?: LedgerTransactionPort, fault?: LedgerFaultPort) {
    this.db = db;
    this.fault = fault;
    this.transaction = transaction ?? new ImmediateLedgerTransaction(db);
  }

  run(command: AppendCommand, append: (payloadDigest: string) => AppendResult): AppendResult {
    const payloadDigest = commandDigest(command);
    return this.transaction.run<AppendResult>(() => {
      const receipt = this.db
        .prepare("SELECT * FROM append_command_receipts WHERE command_id = ?")
        .get(command.commandId);
      if (receipt) {
        const replayed = sameDigest(String(receipt.command_payload_digest), payloadDigest);
        return {
          commit: true,
          value: replayed
            ? { ok: true, replayed: true, resultRef: String(receipt.result_ref) }
            : { ok: false, ruleId: command.conflictRuleId },
        };
      }
      const result = append(payloadDigest);
      if (!result.ok) return { commit: false, value: result };
      this.insertReceipt(command, payloadDigest, result.resultRef);
      this.fault?.after("receipt");
      return { commit: true, value: result };
    });
  }

  private insertReceipt(command: AppendCommand, payloadDigest: string, resultRef: string): void {
    const row = {
      command_id: command.commandId,
      command_type: command.commandType,
      subject_kind: command.subjectKind,
      subject_key: command.subjectKey,
      plan_asset_id: null,
      plan_revision: null,
      command_payload_digest: payloadDigest,
      result_kind: command.resultKind,
      result_ref: resultRef,
      recorded_at: command.recordedAt,
    };
    this.db
      .prepare("INSERT INTO append_command_receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(...Object.values(row), ledgerRowDigest(row, "receipt_digest"));
  }
}

function commandDigest(command: AppendCommand): string {
  const entries = Object.entries({
    commandType: command.commandType,
    subjectKind: command.subjectKind,
    subjectKey: command.subjectKey,
    ...command.payload,
  }).sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function sameDigest(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}
