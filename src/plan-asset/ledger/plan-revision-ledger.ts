import { createHash, timingSafeEqual } from "node:crypto";
import type { HarnessDb } from "../../state-db/index.ts";
import { ledgerRowDigest, migratePlanLedger } from "./schema.ts";
import { ImmediateLedgerTransaction, type LedgerTransactionPort } from "./transaction.ts";

export interface AppendPlanRevisionInput {
  readonly commandId: string;
  readonly assetId: string;
  readonly planId: string;
  readonly baseRevision: number;
  readonly basePayloadDigest: string;
  readonly canonicalPayloadJson: string;
  /** admission_receiptを除く発行PLAN全体のcanonical digest。 */
  readonly contentDigest: string;
  readonly bodyDigest: string;
  readonly sourcePath: string;
  readonly sourceCommit: string;
  readonly actor: string;
  readonly reason: string;
  readonly routeTupleDigest: string;
  readonly certificateId: string;
  readonly occurredAt: string;
}

export type AppendPlanRevisionResult =
  | {
      readonly ok: true;
      readonly replayed: boolean;
      readonly assetId: string;
      readonly revision: number;
      readonly canonicalPayloadDigest: string;
      readonly commandPayloadDigest: string;
      readonly certificateId: string;
      readonly certificateDigest: string;
    }
  | { readonly ok: false; readonly ruleId: string };

/** Adopt済みPLAN assetのrevisionを、command receiptと同じtransactionで追記する。 */
export class PlanRevisionLedgerTransaction {
  private readonly transaction: LedgerTransactionPort;

  private readonly db: HarnessDb;

  constructor(db: HarnessDb, transaction?: LedgerTransactionPort) {
    this.db = db;
    if (!migratePlanLedger(db).ok) throw new Error("plan-ledger-unavailable");
    this.transaction = transaction ?? new ImmediateLedgerTransaction(db);
  }

  append(input: AppendPlanRevisionInput): AppendPlanRevisionResult {
    return this.transact(input, () => undefined);
  }

  transact(
    input: AppendPlanRevisionInput,
    onPrepared: (result: Extract<AppendPlanRevisionResult, { ok: true }>) => void,
  ): AppendPlanRevisionResult {
    const validated = validate(input);
    if (!validated.ok) return validated;

    return this.transaction.run(() => {
      const replay = this.db
        .prepare("SELECT * FROM append_command_receipts WHERE command_id = ?")
        .get(input.commandId);
      if (replay) {
        const value: AppendPlanRevisionResult = !secureEqual(
          String(replay.command_payload_digest),
          validated.commandPayloadDigest,
        )
          ? { ok: false, ruleId: "plan-revision-command-conflict" }
          : replayBindingValid({ db: this.db, input, expected: validated, receipt: replay })
            ? {
                ok: true,
                replayed: true,
                assetId: String(replay.plan_asset_id),
                revision: Number(replay.plan_revision),
                canonicalPayloadDigest: validated.canonicalPayloadDigest,
                commandPayloadDigest: validated.commandPayloadDigest,
                certificateId: String(replay.result_ref),
                certificateDigest: validated.certificateDigest,
              }
            : { ok: false, ruleId: "plan-revision-receipt-binding-invalid" };
        if (value.ok) onPrepared(value);
        return { commit: true, value };
      }

      const latest = this.db
        .prepare(
          "SELECT revision, canonical_payload_digest FROM plan_revisions WHERE asset_id = ? ORDER BY revision DESC LIMIT 1",
        )
        .get(input.assetId);
      if (!latest) return rejected("plan-asset-not-found");
      const alias = this.db
        .prepare("SELECT asset_id FROM plan_aliases WHERE alias = ? AND valid_to_revision IS NULL")
        .all(input.planId);
      if (alias.length !== 1 || String(alias[0].asset_id) !== input.assetId) {
        return rejected("plan-revision-alias-binding-invalid");
      }
      if (Number(latest.revision) !== input.baseRevision) return rejected("plan-revision-stale");
      if (!secureEqual(String(latest.canonical_payload_digest), input.basePayloadDigest)) {
        return rejected("plan-revision-base-digest-mismatch");
      }

      const revision = input.baseRevision + 1;
      this.db
        .prepare("INSERT INTO plan_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          input.assetId,
          revision,
          input.canonicalPayloadJson,
          validated.canonicalPayloadDigest,
          input.bodyDigest,
          input.sourcePath,
          input.sourceCommit,
          input.actor,
          input.reason,
          input.occurredAt,
        );
      const admissionEventId = `admission:${input.certificateId}`;
      const admission = {
        admission_event_id: admissionEventId,
        command_id: input.commandId,
        command_payload_digest: validated.commandPayloadDigest,
        event_kind: "admitted",
        plan_asset_id: input.assetId,
        plan_revision: revision,
        plan_id: input.planId,
        source_path: input.sourcePath,
        content_digest: input.contentDigest,
        route_tuple_digest: input.routeTupleDigest,
        certificate_id: input.certificateId,
        certificate_digest: validated.certificateDigest,
        occurred_at: input.occurredAt,
      };
      this.db
        .prepare(
          "INSERT INTO plan_admission_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(...Object.values(admission), ledgerRowDigest(admission, "event_digest"));
      this.db
        .prepare("INSERT INTO plan_admission_receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          input.certificateId,
          admissionEventId,
          input.commandId,
          validated.commandPayloadDigest,
          input.assetId,
          revision,
          input.planId,
          input.sourcePath,
          input.contentDigest,
          input.routeTupleDigest,
          validated.certificateDigest,
          input.occurredAt,
        );
      const receipt = {
        command_id: input.commandId,
        command_type: "plan.revise",
        subject_kind: "plan_revision",
        subject_key: `${input.assetId}:${revision}`,
        plan_asset_id: input.assetId,
        plan_revision: revision,
        command_payload_digest: validated.commandPayloadDigest,
        result_kind: "admission_certificate",
        result_ref: input.certificateId,
        recorded_at: input.occurredAt,
      };
      this.db
        .prepare("INSERT INTO append_command_receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(...Object.values(receipt), ledgerRowDigest(receipt, "receipt_digest"));
      const value = {
        ok: true as const,
        replayed: false,
        assetId: input.assetId,
        revision,
        canonicalPayloadDigest: validated.canonicalPayloadDigest,
        commandPayloadDigest: validated.commandPayloadDigest,
        certificateId: input.certificateId,
        certificateDigest: validated.certificateDigest,
      };
      onPrepared(value);
      return { commit: true, value };
    });
  }
}

export interface ValidRevision {
  readonly canonicalPayloadDigest: string;
  readonly commandPayloadDigest: string;
  readonly certificateDigest: string;
}

/** 永続値を参照せず、revision inputだけから全digest連鎖を導出する。 */
export function derivePlanRevisionDigests(input: AppendPlanRevisionInput): ValidRevision {
  const canonicalPayloadDigest = sha(input.canonicalPayloadJson);
  const commandPayloadDigest = sha(JSON.stringify({ ...input, canonicalPayloadDigest }));
  const certificateDigest = sha(
    JSON.stringify({
      commandPayloadDigest,
      assetId: input.assetId,
      revision: input.baseRevision + 1,
      planId: input.planId,
      contentDigest: input.contentDigest,
      routeTupleDigest: input.routeTupleDigest,
    }),
  );
  return { canonicalPayloadDigest, commandPayloadDigest, certificateDigest };
}

export interface ReplayBindingInput {
  readonly db: HarnessDb;
  readonly input: AppendPlanRevisionInput;
  readonly expected: ValidRevision;
  readonly receipt: Record<string, unknown>;
}

/** Replayはcommand digestだけでなく、永続化した全bindingを再証明する。 */
export function replayBindingValid(binding: ReplayBindingInput): boolean {
  return replayBindingFailures(binding).length === 0;
}

/** binding不一致を列単位で返し、fail-close判定の診断可能性を保つ。 */
export function replayBindingFailures(binding: ReplayBindingInput): readonly string[] {
  const { db, input, expected, receipt } = binding;
  const failures: string[] = [];
  const revision = input.baseRevision + 1;
  const eventId = `admission:${input.certificateId}`;
  const expectedReceipt = {
    command_id: input.commandId,
    command_type: "plan.revise",
    subject_kind: "plan_revision",
    subject_key: `${input.assetId}:${revision}`,
    plan_asset_id: input.assetId,
    plan_revision: revision,
    command_payload_digest: expected.commandPayloadDigest,
    result_kind: "admission_certificate",
    result_ref: input.certificateId,
    recorded_at: input.occurredAt,
  };
  failures.push(...rowDifferences("receipt", receipt, expectedReceipt));
  if (receipt.receipt_digest !== ledgerRowDigest(receipt, "receipt_digest")) {
    failures.push("receipt.receipt_digest");
  }

  const expectedAdmission = {
    admission_event_id: eventId,
    command_id: input.commandId,
    command_payload_digest: expected.commandPayloadDigest,
    event_kind: "admitted",
    plan_asset_id: input.assetId,
    plan_revision: revision,
    plan_id: input.planId,
    source_path: input.sourcePath,
    content_digest: input.contentDigest,
    route_tuple_digest: input.routeTupleDigest,
    certificate_id: input.certificateId,
    certificate_digest: expected.certificateDigest,
    occurred_at: input.occurredAt,
  };
  const event = db
    .prepare("SELECT * FROM plan_admission_events WHERE command_id = ?")
    .get(input.commandId);
  if (!event) failures.push("event.missing");
  else {
    failures.push(...rowDifferences("event", event, expectedAdmission));
    if (event.event_digest !== ledgerRowDigest(event, "event_digest")) {
      failures.push("event.event_digest");
    }
  }
  const admission = db
    .prepare("SELECT * FROM plan_admission_receipts WHERE command_id = ?")
    .get(input.commandId);
  const expectedAdmissionReceipt = {
    certificate_id: input.certificateId,
    admission_event_id: eventId,
    command_id: input.commandId,
    command_payload_digest: expected.commandPayloadDigest,
    plan_asset_id: input.assetId,
    plan_revision: revision,
    plan_id: input.planId,
    source_path: input.sourcePath,
    content_digest: input.contentDigest,
    route_tuple_digest: input.routeTupleDigest,
    certificate_digest: expected.certificateDigest,
    recorded_at: input.occurredAt,
  };
  if (!admission) failures.push("admission.missing");
  else failures.push(...rowDifferences("admission", admission, expectedAdmissionReceipt));
  const stored = db
    .prepare("SELECT * FROM plan_revisions WHERE asset_id = ? AND revision = ?")
    .get(input.assetId, revision);
  const expectedRevision = {
    asset_id: input.assetId,
    revision,
    canonical_payload_json: input.canonicalPayloadJson,
    canonical_payload_digest: expected.canonicalPayloadDigest,
    body_digest: input.bodyDigest,
    source_path: input.sourcePath,
    source_commit: input.sourceCommit,
    actor: input.actor,
    reason: input.reason,
    created_at: input.occurredAt,
  };
  if (!stored) failures.push("revision.missing");
  else failures.push(...rowDifferences("revision", stored, expectedRevision));
  return failures;
}

function rowDifferences(
  prefix: string,
  row: Record<string, unknown>,
  expected: Record<string, unknown>,
): string[] {
  return Object.entries(expected)
    .filter(([key, value]) => row[key] !== value)
    .map(([key]) => `${prefix}.${key}`);
}

function validate(input: AppendPlanRevisionInput):
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
    !Number.isSafeInteger(input.baseRevision) ||
    input.baseRevision < 1 ||
    !validSha(input.basePayloadDigest) ||
    !validSha(input.contentDigest) ||
    !validSha(input.bodyDigest) ||
    !input.sourcePath ||
    !input.sourceCommit ||
    !input.actor ||
    !input.reason ||
    !validSha(input.routeTupleDigest) ||
    !input.certificateId ||
    Number.isNaN(Date.parse(input.occurredAt))
  )
    return { ok: false, ruleId: "plan-revision-input-invalid" };
  try {
    JSON.parse(input.canonicalPayloadJson);
  } catch {
    return { ok: false, ruleId: "plan-revision-payload-invalid" };
  }
  return { ok: true, ...derivePlanRevisionDigests(input) };
}

function validSha(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function rejected(ruleId: string): { commit: false; value: AppendPlanRevisionResult } {
  return { commit: false, value: { ok: false, ruleId } };
}
