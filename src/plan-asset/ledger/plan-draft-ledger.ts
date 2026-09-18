import { createHash, timingSafeEqual } from "node:crypto";
import {
  type CanonicalPlanDraftCommand,
  calculatePlanDraftCommandDigests,
} from "../../kernel/plan-draft-command-digest.ts";
import type { HarnessDb } from "../../state-db/index.ts";
import { ledgerRowDigest, migratePlanLedger } from "./schema.ts";
import { ImmediateLedgerTransaction, type LedgerTransactionPort } from "./transaction.ts";

const PLAN_DRAFT_LEASE_KEY_VERSION = "plan-draft-v1";

export interface AppendPlanDraftInput extends CanonicalPlanDraftCommand {}

export type AppendPlanDraftResult =
  | {
      readonly ok: true;
      readonly replayed: boolean;
      readonly assetId: string;
      readonly revision: 1;
      readonly certificateId: string;
      readonly certificateDigest: string;
      readonly commandPayloadDigest: string;
    }
  | { readonly ok: false; readonly ruleId: string };

/**
 * PLAN draft のDB側write setを一つのBEGIN IMMEDIATEに閉じ込める。
 * Markdown配置はこの境界の外側なので、呼び出し側Sagaがjournalと照合して扱う。
 */
export class PlanDraftLedgerTransaction {
  private readonly transaction: LedgerTransactionPort;

  private readonly db: HarnessDb;

  constructor(db: HarnessDb, transaction?: LedgerTransactionPort) {
    this.db = db;
    if (!migratePlanLedger(db).ok) throw new Error("plan-ledger-unavailable");
    this.transaction = transaction ?? new ImmediateLedgerTransaction(db);
  }

  append(input: AppendPlanDraftInput): AppendPlanDraftResult {
    return this.transact(input, () => undefined);
  }

  transact(
    input: AppendPlanDraftInput,
    onPrepared: (receipt: Extract<AppendPlanDraftResult, { ok: true }>) => void,
  ): AppendPlanDraftResult {
    const validated = validate(input);
    if (!validated.ok) return validated;
    const { canonicalPayloadDigest, commandPayloadDigest, certificateDigest } = validated;

    return this.transaction.run<AppendPlanDraftResult>(() => {
      const replay = this.db
        .prepare("SELECT * FROM plan_admission_receipts WHERE command_id = ?")
        .get(input.commandId);
      if (replay) {
        const same = secureEqual(String(replay.command_payload_digest), commandPayloadDigest);
        const value: AppendPlanDraftResult = same
          ? {
              ok: true,
              replayed: true,
              assetId: String(replay.plan_asset_id),
              revision: 1,
              certificateId: String(replay.certificate_id),
              certificateDigest: String(replay.certificate_digest),
              commandPayloadDigest,
            }
          : { ok: false, ruleId: "plan-draft-command-conflict" };
        if (value.ok) onPrepared(value);
        return {
          commit: true,
          value,
        };
      }
      if (this.exists({ table: "plan_assets", column: "asset_id", value: input.assetId })) {
        return rejected("plan-asset-conflict");
      }
      if (
        this.exists({
          table: "plan_aliases",
          column: "alias",
          value: input.alias,
          suffix: "valid_to_revision IS NULL",
        })
      ) {
        return rejected("plan-alias-conflict");
      }
      const ordinal = this.db
        .prepare(
          "SELECT 1 FROM plan_id_reservations WHERE namespace = ? AND ordinal = ? AND status = 'active'",
        )
        .get(input.namespace, input.ordinal);
      if (ordinal) return rejected("plan-id-reservation-conflict");

      this.insertAssetAndRevision(input, canonicalPayloadDigest);
      this.insertAlias(input, commandPayloadDigest);
      this.insertReservation(input, commandPayloadDigest);
      const admissionEventId = `admission:${input.certificateId}`;
      this.insertAdmission({
        input,
        eventId: admissionEventId,
        commandPayloadDigest,
        certificateDigest,
      });
      this.insertCommandReceipt(input, commandPayloadDigest);
      const value = {
        ok: true as const,
        replayed: false,
        assetId: input.assetId,
        revision: 1 as const,
        certificateId: input.certificateId,
        certificateDigest,
        commandPayloadDigest,
      };
      onPrepared(value);
      return {
        commit: true,
        value,
      };
    });
  }

  private exists(input: {
    table: string;
    column: string;
    value: string;
    suffix?: string;
  }): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM ${input.table} WHERE ${input.column} = ? AND ${input.suffix ?? "1 = 1"}`,
        )
        .get(input.value),
    );
  }

  private insertAssetAndRevision(input: AppendPlanDraftInput, payloadDigest: string): void {
    this.db
      .prepare("INSERT INTO plan_assets VALUES (?, ?, ?, ?)")
      .run(input.assetId, input.occurredAt, input.sourceCommit, input.identityAlgorithm);
    this.db
      .prepare("INSERT INTO plan_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        input.assetId,
        1,
        input.canonicalPayloadJson,
        payloadDigest,
        input.bodyDigest,
        input.sourcePath,
        input.sourceCommit,
        input.actor,
        input.reason,
        input.occurredAt,
      );
  }

  private insertAlias(input: AppendPlanDraftInput, commandDigest: string): string {
    const eventId = `alias:${input.assetId}:1`;
    const event = {
      alias_event_id: eventId,
      asset_id: input.assetId,
      sequence: 1,
      command_id: input.commandId,
      command_payload_digest: commandDigest,
      event_kind: "assigned",
      alias: input.alias,
      revision: 1,
      reason: input.reason,
      occurred_at: input.occurredAt,
    };
    const digest = ledgerRowDigest(event, "event_digest");
    this.db
      .prepare("INSERT INTO plan_alias_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(...Object.values(event), digest);
    this.db
      .prepare("INSERT INTO plan_aliases VALUES (?, ?, ?, ?, ?, ?)")
      .run(`alias-current:${input.assetId}`, input.assetId, input.alias, 1, null, digest);
    return eventId;
  }

  private insertReservation(input: AppendPlanDraftInput, commandDigest: string): string {
    const eventId = `reservation:${input.reservationId}:1`;
    const reservationCommandId = `${input.commandId}:reservation`;
    const event = {
      reservation_event_id: eventId,
      reservation_id: input.reservationId,
      sequence: 1,
      command_id: reservationCommandId,
      command_payload_digest: commandDigest,
      event_kind: "reserved",
      namespace: input.namespace,
      ordinal: input.ordinal,
      asset_id: input.assetId,
      lease_key_version: PLAN_DRAFT_LEASE_KEY_VERSION,
      lease_token_hash: input.leaseTokenHash,
      occurred_at: input.occurredAt,
      expires_at: input.expiresAt,
    };
    const digest = ledgerRowDigest(event, "event_digest");
    this.db
      .prepare(
        `INSERT INTO plan_id_reservation_events
          (reservation_event_id, reservation_id, sequence, command_id,
           command_payload_digest, event_kind, namespace, ordinal, asset_id,
           lease_key_version, lease_token_hash, occurred_at, expires_at, event_digest)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...Object.values(event), digest);
    this.db
      .prepare(
        `INSERT INTO plan_id_reservations
          (reservation_id, namespace, ordinal, asset_id, lease_key_version,
           lease_token_hash, status, reserved_at, expires_at, closed_at, last_event_digest)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.reservationId,
        input.namespace,
        input.ordinal,
        input.assetId,
        PLAN_DRAFT_LEASE_KEY_VERSION,
        input.leaseTokenHash,
        "active",
        input.occurredAt,
        input.expiresAt,
        null,
        digest,
      );
    const receipt = {
      command_id: reservationCommandId,
      command_type: "reservation.reserve",
      subject_kind: "reservation",
      subject_key: input.reservationId,
      plan_asset_id: null,
      plan_revision: null,
      command_payload_digest: commandDigest,
      result_kind: "reservation_event",
      result_ref: eventId,
      recorded_at: input.occurredAt,
    };
    this.db
      .prepare("INSERT INTO append_command_receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(...Object.values(receipt), ledgerRowDigest(receipt, "receipt_digest"));
    return eventId;
  }

  private insertAdmission(args: {
    input: AppendPlanDraftInput;
    eventId: string;
    commandPayloadDigest: string;
    certificateDigest: string;
  }): void {
    const { input, eventId, commandPayloadDigest, certificateDigest } = args;
    const event = {
      admission_event_id: eventId,
      command_id: input.commandId,
      command_payload_digest: commandPayloadDigest,
      event_kind: "admitted",
      plan_asset_id: input.assetId,
      plan_revision: 1,
      plan_id: input.planId,
      source_path: input.sourcePath,
      content_digest: createHash("sha256").update(input.canonicalPayloadJson).digest("hex"),
      route_tuple_digest: input.routeTupleDigest,
      certificate_id: input.certificateId,
      certificate_digest: certificateDigest,
      occurred_at: input.occurredAt,
    };
    const eventDigest = ledgerRowDigest(event, "event_digest");
    this.db
      .prepare(
        "INSERT INTO plan_admission_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(...Object.values(event), eventDigest);
    this.db
      .prepare("INSERT INTO plan_admission_receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        input.certificateId,
        eventId,
        input.commandId,
        commandPayloadDigest,
        input.assetId,
        1,
        input.planId,
        input.sourcePath,
        event.content_digest,
        input.routeTupleDigest,
        certificateDigest,
        input.occurredAt,
      );
  }

  private insertCommandReceipt(input: AppendPlanDraftInput, commandDigest: string): void {
    const row = {
      command_id: input.commandId,
      command_type: "plan.draft",
      subject_kind: "plan_revision",
      subject_key: `${input.assetId}:1`,
      plan_asset_id: input.assetId,
      plan_revision: 1,
      command_payload_digest: commandDigest,
      result_kind: "admission_certificate",
      result_ref: input.certificateId,
      recorded_at: input.occurredAt,
    };
    this.db
      .prepare("INSERT INTO append_command_receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(...Object.values(row), ledgerRowDigest(row, "receipt_digest"));
  }
}

function validate(input: AppendPlanDraftInput):
  | {
      readonly ok: true;
      readonly canonicalPayloadDigest: string;
      readonly commandPayloadDigest: string;
      readonly certificateDigest: string;
    }
  | { readonly ok: false; readonly ruleId: string } {
  if (
    !input.commandId ||
    !input.assetId ||
    !input.planId ||
    !input.alias ||
    !input.sourcePath ||
    !input.projectionPath ||
    !input.certificateId ||
    !Number.isSafeInteger(input.ordinal) ||
    input.ordinal < 1 ||
    !validSha(input.bodyDigest) ||
    !validSha(input.leaseTokenHash) ||
    !validSha(input.routeTupleDigest) ||
    Number.isNaN(Date.parse(input.occurredAt)) ||
    Number.isNaN(Date.parse(input.expiresAt)) ||
    Date.parse(input.expiresAt) <= Date.parse(input.occurredAt)
  )
    return { ok: false, ruleId: "plan-draft-input-invalid" };
  try {
    JSON.parse(input.canonicalPayloadJson);
  } catch {
    return { ok: false, ruleId: "plan-draft-payload-invalid" };
  }
  const { canonicalPayloadDigest, commandPayloadDigest, certificateDigest } =
    calculatePlanDraftCommandDigests(input);
  return { ok: true, canonicalPayloadDigest, commandPayloadDigest, certificateDigest };
}

function validSha(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function rejected(ruleId: string): { commit: false; value: AppendPlanDraftResult } {
  return { commit: false, value: { ok: false, ruleId } };
}
