import type { HarnessDb } from "../../state-db/index.ts";
import {
  AppendCommandTransaction,
  type AppendResult,
  type LedgerFaultPort,
} from "./append-command.ts";
import { ledgerRowDigest, migratePlanLedger } from "./schema.ts";
import type { LedgerTransactionPort } from "./transaction.ts";

export interface ObserveMigrationInput {
  readonly legacyPlanId: string;
  readonly assetId: string;
  readonly collisionGroup: string | null;
  readonly reason: string;
  readonly reviewPlanId: string;
  readonly repositoryIdentity: string;
  readonly identityAlgorithm: string;
  readonly identityInputJson: string;
  readonly identityDigest: string;
  readonly identityConfigPath: string;
  readonly identityConfigBlobOid: string;
  readonly identityConfigContentDigest: string;
  readonly identityConfigReceiptDigest: string;
  readonly sourceDigest: string;
  readonly commandId: string;
  readonly occurredAt: string;
  readonly expectedSequence: 0;
}

export interface RejectMigrationInput {
  readonly legacyPlanId: string;
  readonly lossFields: readonly string[];
  readonly reason: string;
  readonly reviewPlanId: string;
  readonly commandId: string;
  readonly occurredAt: string;
  readonly expectedSequence: 1;
  readonly expectedDecision: "pending";
}

export interface AdoptMigrationInput {
  readonly legacyPlanId: string;
  readonly decision: "migrated" | "rekeyed";
  readonly resolvedAlias: string;
  readonly collisionGroup: string | null;
  readonly reviewPlanId: string | null;
  readonly canonicalPayloadJson: string;
  readonly canonicalPayloadDigest: string;
  readonly bodyDigest: string;
  readonly sourcePath: string;
  readonly sourceCommit: string;
  readonly actor: string;
  readonly reason: string;
  readonly commandId: string;
  readonly occurredAt: string;
  readonly expectedSequence: 1;
  readonly expectedDecision: "pending";
}

export class LegacyMigrationLedger {
  private readonly commands: AppendCommandTransaction;

  private readonly db: HarnessDb;
  private readonly fault?: LedgerFaultPort;

  constructor(db: HarnessDb, transaction?: LedgerTransactionPort, fault?: LedgerFaultPort) {
    this.db = db;
    this.fault = fault;
    if (!migratePlanLedger(db).ok) throw new Error("plan-ledger-unavailable");
    this.commands = new AppendCommandTransaction(db, transaction, fault);
  }

  reconstruct(legacyPlanId: string):
    | {
        readonly ok: true;
        readonly state: Readonly<Record<string, unknown>>;
        readonly eventDigests: readonly string[];
        readonly payloadDigests: readonly string[];
      }
    | { readonly ok: false; readonly ruleId: string } {
    if (!migratePlanLedger(this.db).ok) return { ok: false, ruleId: "plan-ledger-unavailable" };
    const state = this.db
      .prepare("SELECT * FROM legacy_plan_migrations WHERE legacy_plan_id = ?")
      .get(legacyPlanId);
    if (!state) return { ok: false, ruleId: "plan-migration-not-found" };
    const events = this.db
      .prepare(`SELECT event_digest, command_payload_digest FROM legacy_plan_migration_events
        WHERE legacy_plan_id = ? ORDER BY sequence`)
      .all(legacyPlanId);
    return {
      ok: true,
      state: Object.freeze({ ...state }),
      eventDigests: Object.freeze(events.map((event) => String(event.event_digest))),
      payloadDigests: Object.freeze(events.map((event) => String(event.command_payload_digest))),
    };
  }

  observe(input: ObserveMigrationInput): AppendResult {
    if (!migratePlanLedger(this.db).ok) return failed("plan-ledger-unavailable");
    return this.commands.run(
      {
        commandId: input.commandId,
        commandType: "migration.observe",
        subjectKind: "legacy_migration",
        subjectKey: input.legacyPlanId,
        payload: withoutContext(input),
        recordedAt: input.occurredAt,
        resultKind: "migration_event",
        conflictRuleId: "plan-migration-command-conflict",
      },
      (payloadDigest) => this.appendObserved(input, payloadDigest),
    );
  }

  reject(input: RejectMigrationInput): AppendResult {
    if (!migratePlanLedger(this.db).ok) return failed("plan-ledger-unavailable");
    return this.commands.run(
      {
        commandId: input.commandId,
        commandType: "migration.decide",
        subjectKind: "legacy_migration",
        subjectKey: input.legacyPlanId,
        payload: withoutContext(input),
        recordedAt: input.occurredAt,
        resultKind: "migration_event",
        conflictRuleId: "plan-migration-command-conflict",
      },
      (payloadDigest) => this.appendRejected(input, payloadDigest),
    );
  }

  adopt(input: AdoptMigrationInput): AppendResult {
    if (!migratePlanLedger(this.db).ok) return failed("plan-ledger-unavailable");
    return this.commands.run(
      {
        commandId: input.commandId,
        commandType: "migration.decide",
        subjectKind: "legacy_migration",
        subjectKey: input.legacyPlanId,
        payload: withoutContext(input),
        recordedAt: input.occurredAt,
        resultKind: "migration_event",
        conflictRuleId: "plan-migration-command-conflict",
      },
      (payloadDigest) => this.appendAdopted(input, payloadDigest),
    );
  }

  private appendObserved(input: ObserveMigrationInput, payloadDigest: string): AppendResult {
    const current = this.db
      .prepare("SELECT 1 FROM legacy_plan_migrations WHERE legacy_plan_id = ?")
      .get(input.legacyPlanId);
    if (current || input.expectedSequence !== 0) return failed("plan-migration-state-conflict");
    const event = observedEvent(input, payloadDigest);
    this.db
      .prepare(`INSERT INTO legacy_plan_migration_events VALUES (${placeholders(event)})`)
      .run(...Object.values(event));
    this.fault?.after("migration-event");
    const projection = {
      migration_id: `migration:${input.legacyPlanId}`,
      legacy_plan_id: input.legacyPlanId,
      asset_id: input.assetId,
      target_asset_id: null,
      target_revision: null,
      decision: "pending",
      resolved_alias: null,
      collision_group: input.collisionGroup,
      loss_fields_json: "[]",
      reason: input.reason,
      review_plan_id: input.reviewPlanId,
      identity_digest: input.identityDigest,
      source_digest: input.sourceDigest,
      last_event_digest: event.event_digest,
    };
    this.db
      .prepare(`INSERT INTO legacy_plan_migrations VALUES (${placeholders(projection)})`)
      .run(...Object.values(projection));
    this.fault?.after("migration-current");
    return { ok: true, replayed: false, resultRef: String(event.migration_event_id) };
  }

  private appendRejected(input: RejectMigrationInput, payloadDigest: string): AppendResult {
    const current = this.db
      .prepare("SELECT * FROM legacy_plan_migrations WHERE legacy_plan_id = ?")
      .get(input.legacyPlanId);
    const first = this.db
      .prepare(
        "SELECT * FROM legacy_plan_migration_events WHERE legacy_plan_id = ? AND sequence = 1",
      )
      .get(input.legacyPlanId);
    if (!current || !first || current.decision !== input.expectedDecision) {
      return failed("plan-migration-state-conflict");
    }
    const row = {
      ...first,
      migration_event_id: `migration:${input.legacyPlanId}:event:2`,
      sequence: input.expectedSequence + 1,
      command_id: input.commandId,
      command_payload_digest: payloadDigest,
      event_kind: "decided",
      decision: "rejected",
      resolved_alias: null,
      loss_fields_json: JSON.stringify(input.lossFields),
      reason: input.reason,
      review_plan_id: input.reviewPlanId,
      occurred_at: input.occurredAt,
      event_digest: undefined,
    };
    const { event_digest: _ignored, ...eventWithoutDigest } = row;
    const event = {
      ...eventWithoutDigest,
      event_digest: ledgerRowDigest(eventWithoutDigest, "event_digest"),
    };
    this.db
      .prepare(`INSERT INTO legacy_plan_migration_events VALUES (${placeholders(event)})`)
      .run(...Object.values(event));
    this.fault?.after("migration-event");
    this.db
      .prepare(`UPDATE legacy_plan_migrations SET decision = 'rejected', resolved_alias = NULL,
        loss_fields_json = ?, reason = ?, review_plan_id = ?, last_event_digest = ? WHERE legacy_plan_id = ?`)
      .run(
        event.loss_fields_json,
        input.reason,
        input.reviewPlanId,
        event.event_digest,
        input.legacyPlanId,
      );
    this.fault?.after("migration-current");
    return { ok: true, replayed: false, resultRef: String(event.migration_event_id) };
  }

  private appendAdopted(input: AdoptMigrationInput, payloadDigest: string): AppendResult {
    const migrated = input.decision === "migrated";
    if (
      (migrated && (input.collisionGroup !== null || input.reviewPlanId !== null)) ||
      (!migrated && (!input.collisionGroup || !input.reviewPlanId))
    ) {
      return failed("plan-migration-decision-invalid");
    }
    const state = this.pendingState(input.legacyPlanId, input.expectedDecision);
    if (!state) return failed("plan-migration-state-conflict");
    const assetId = String(state.current.asset_id);
    this.db
      .prepare("INSERT INTO plan_assets VALUES (?, ?, ?, ?)")
      .run(assetId, input.occurredAt, input.sourceCommit, String(state.first.identity_algorithm));
    this.fault?.after("plan-asset");
    this.db
      .prepare("INSERT INTO plan_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        assetId,
        1,
        input.canonicalPayloadJson,
        input.canonicalPayloadDigest,
        input.bodyDigest,
        input.sourcePath,
        input.sourceCommit,
        input.actor,
        input.reason,
        input.occurredAt,
      );
    this.fault?.after("plan-revision");
    const alias = aliasEvent(assetId, input, payloadDigest);
    this.db
      .prepare("INSERT INTO plan_alias_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(...Object.values(alias));
    this.fault?.after("alias-event");
    this.db
      .prepare("INSERT INTO plan_aliases VALUES (?, ?, ?, ?, ?, ?)")
      .run(`alias:${assetId}:1`, assetId, input.resolvedAlias, 1, null, alias.event_digest);
    this.fault?.after("alias-current");
    const event = decisionEvent(state.first, {
      commandId: input.commandId,
      payloadDigest,
      decision: input.decision,
      resolvedAlias: input.resolvedAlias,
      collisionGroup: input.collisionGroup,
      lossFieldsJson: "[]",
      reason: input.reason,
      reviewPlanId: input.reviewPlanId,
      occurredAt: input.occurredAt,
      targetAssetId: assetId,
      targetRevision: 1,
    });
    this.insertDecision(event);
    this.fault?.after("migration-event");
    this.db
      .prepare(`UPDATE legacy_plan_migrations SET target_asset_id = ?, target_revision = 1,
      decision = ?, resolved_alias = ?, collision_group = ?, loss_fields_json = '[]',
      reason = ?, review_plan_id = ?, last_event_digest = ? WHERE legacy_plan_id = ?`)
      .run(
        assetId,
        input.decision,
        input.resolvedAlias,
        input.collisionGroup,
        input.reason,
        input.reviewPlanId,
        event.event_digest,
        input.legacyPlanId,
      );
    this.fault?.after("migration-current");
    return { ok: true, replayed: false, resultRef: String(event.migration_event_id) };
  }

  private pendingState(legacyPlanId: string, expected: "pending") {
    const current = this.db
      .prepare("SELECT * FROM legacy_plan_migrations WHERE legacy_plan_id = ?")
      .get(legacyPlanId);
    const first = this.db
      .prepare(
        "SELECT * FROM legacy_plan_migration_events WHERE legacy_plan_id = ? AND sequence = 1",
      )
      .get(legacyPlanId);
    return current && first && current.decision === expected ? { current, first } : null;
  }

  private insertDecision(event: Readonly<Record<string, unknown>>): void {
    this.db
      .prepare(`INSERT INTO legacy_plan_migration_events VALUES (${placeholders(event)})`)
      .run(...Object.values(event));
  }
}

function observedEvent(input: ObserveMigrationInput, payloadDigest: string) {
  const row = {
    migration_event_id: `migration:${input.legacyPlanId}:event:1`,
    legacy_plan_id: input.legacyPlanId,
    sequence: 1,
    command_id: input.commandId,
    command_payload_digest: payloadDigest,
    event_kind: "observed",
    asset_id: input.assetId,
    target_asset_id: null,
    target_revision: null,
    decision: "pending",
    resolved_alias: null,
    collision_group: input.collisionGroup,
    loss_fields_json: "[]",
    reason: input.reason,
    review_plan_id: input.reviewPlanId,
    repository_identity: input.repositoryIdentity,
    identity_algorithm: input.identityAlgorithm,
    identity_input_json: input.identityInputJson,
    identity_digest: input.identityDigest,
    identity_config_path: input.identityConfigPath,
    identity_config_blob_oid: input.identityConfigBlobOid,
    identity_config_content_digest: input.identityConfigContentDigest,
    identity_config_receipt_digest: input.identityConfigReceiptDigest,
    source_digest: input.sourceDigest,
    occurred_at: input.occurredAt,
  };
  return Object.freeze({ ...row, event_digest: ledgerRowDigest(row, "event_digest") });
}

function decisionEvent(
  first: Readonly<Record<string, unknown>>,
  input: {
    commandId: string;
    payloadDigest: string;
    decision: "migrated" | "rekeyed";
    resolvedAlias: string;
    collisionGroup: string | null;
    lossFieldsJson: string;
    reason: string;
    reviewPlanId: string | null;
    occurredAt: string;
    targetAssetId: string;
    targetRevision: number;
  },
) {
  const row = {
    ...first,
    migration_event_id: `migration:${String(first.legacy_plan_id)}:event:2`,
    sequence: 2,
    command_id: input.commandId,
    command_payload_digest: input.payloadDigest,
    event_kind: "decided",
    target_asset_id: input.targetAssetId,
    target_revision: input.targetRevision,
    decision: input.decision,
    resolved_alias: input.resolvedAlias,
    collision_group: input.collisionGroup,
    loss_fields_json: input.lossFieldsJson,
    reason: input.reason,
    review_plan_id: input.reviewPlanId,
    occurred_at: input.occurredAt,
    event_digest: undefined,
  };
  const { event_digest: _ignored, ...withoutDigest } = row;
  return Object.freeze({
    ...withoutDigest,
    event_digest: ledgerRowDigest(withoutDigest, "event_digest"),
  });
}

function aliasEvent(assetId: string, input: AdoptMigrationInput, payloadDigest: string) {
  const row = {
    alias_event_id: `alias-event:${assetId}:1`,
    asset_id: assetId,
    sequence: 1,
    command_id: `${input.commandId}:alias`,
    command_payload_digest: payloadDigest,
    event_kind: "assigned",
    alias: input.resolvedAlias,
    revision: 1,
    reason: input.reason,
    occurred_at: input.occurredAt,
  };
  return Object.freeze({ ...row, event_digest: ledgerRowDigest(row, "event_digest") });
}

function withoutContext(
  input: ObserveMigrationInput | RejectMigrationInput | AdoptMigrationInput,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => key !== "commandId" && key !== "occurredAt"),
  );
}

function placeholders(row: object): string {
  return Object.keys(row)
    .map(() => "?")
    .join(",");
}

function failed(ruleId: string): AppendResult {
  return { ok: false, ruleId };
}
