import { createHash, timingSafeEqual } from "node:crypto";
import type { HarnessDb } from "../../state-db/index.ts";
import { deriveLegacyAssetId } from "../adapters/legacy-plan-adapter.ts";
import { parseLegacyPlanSource } from "../adapters/legacy-plan-inventory.ts";
import { PlanAsset } from "../domain/plan-asset.ts";
import {
  type AppendPlanRevisionInput,
  type AppendPlanRevisionResult,
  replayBindingValid,
} from "./plan-revision-ledger.ts";
import { ledgerRowDigest, migratePlanLedger } from "./schema.ts";
import { ImmediateLedgerTransaction, type LedgerTransactionPort } from "./transaction.ts";

export interface BootstrapLegacyPlanRevisionInput
  extends Omit<AppendPlanRevisionInput, "assetId" | "basePayloadDigest"> {
  readonly repositoryIdentity: string;
  readonly identityAlgorithm: "ut-tdd-plan-legacy-v1";
  readonly identityInputJson: string;
  readonly identityDigest: string;
  readonly baseCanonicalPayloadJson: string;
  readonly baseCanonicalPayloadDigest: string;
  readonly baseBodyDigest: string;
  readonly baseSourcePath: string;
  readonly baseSourceCommit: string;
  readonly baseSourceBlobOid: string;
  readonly baseSourceContent: string;
  readonly baseSourceContentDigest: string;
}

type BootstrapBoundary =
  | "plan-asset"
  | "base-revision"
  | "base-provenance"
  | "alias-event"
  | "alias-current"
  | "next-revision"
  | "admission-event"
  | "admission-receipt"
  | "receipt";

export interface LegacyPlanRevisionBootstrapFaultPort {
  after(boundary: BootstrapBoundary): void;
}

/** Legacy PLANのlossless rev1 adoptionとrev2追記を一つのledger transactionで確定する。 */
export class LegacyPlanRevisionBootstrapTransaction {
  private readonly transaction: LedgerTransactionPort;

  private readonly db: HarnessDb;
  private readonly fault?: LegacyPlanRevisionBootstrapFaultPort;

  constructor(
    db: HarnessDb,
    transaction?: LedgerTransactionPort,
    fault?: LegacyPlanRevisionBootstrapFaultPort,
  ) {
    this.db = db;
    this.fault = fault;
    if (!migratePlanLedger(db).ok) throw new Error("plan-ledger-unavailable");
    this.transaction = transaction ?? new ImmediateLedgerTransaction(db);
  }

  bootstrap(input: BootstrapLegacyPlanRevisionInput): AppendPlanRevisionResult {
    return this.transact(input, () => undefined);
  }

  transact(
    input: BootstrapLegacyPlanRevisionInput,
    onPrepared: (result: Extract<AppendPlanRevisionResult, { ok: true }>) => void,
  ): AppendPlanRevisionResult {
    const validated = validateBootstrap(input);
    if (!validated.ok) return validated;
    return this.transaction.run(() => {
      const replay = this.replay(input, validated);
      if (replay) {
        if (replay.ok) onPrepared(replay);
        return { commit: replay.ok, value: replay };
      }
      if (this.hasActiveAlias(input.planId))
        return rejected("plan-revision-bootstrap-alias-conflict");
      if (this.db.prepare("SELECT 1 FROM plan_assets WHERE asset_id = ?").get(validated.assetId)) {
        return rejected("plan-revision-bootstrap-asset-conflict");
      }
      const domain = createRevisedAsset(input, validated.assetId);
      if (!domain.ok) return rejected(domain.ruleId);

      this.appendAssetAndRevisions(input, validated);
      this.appendAdmissionAndReceipt(input, validated);
      const value = {
        ok: true as const,
        replayed: false,
        assetId: validated.assetId,
        revision: 2,
        canonicalPayloadDigest: validated.canonicalPayloadDigest,
        commandPayloadDigest: validated.commandPayloadDigest,
        certificateId: input.certificateId,
        certificateDigest: validated.certificateDigest,
      };
      onPrepared(value);
      return { commit: true, value };
    });
  }

  private hasActiveAlias(planId: string): boolean {
    return (
      this.db
        .prepare("SELECT asset_id FROM plan_aliases WHERE alias = ? AND valid_to_revision IS NULL")
        .all(planId).length > 0
    );
  }

  private appendAssetAndRevisions(
    input: BootstrapLegacyPlanRevisionInput,
    value: ValidBootstrap,
  ): void {
    this.db
      .prepare("INSERT INTO plan_assets VALUES (?, ?, ?, ?)")
      .run(value.assetId, input.occurredAt, input.baseSourceCommit, input.identityAlgorithm);
    this.fault?.after("plan-asset");
    this.db
      .prepare("INSERT INTO plan_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        value.assetId,
        1,
        input.baseCanonicalPayloadJson,
        input.baseCanonicalPayloadDigest,
        input.baseBodyDigest,
        input.baseSourcePath,
        input.baseSourceCommit,
        "legacy-bootstrap",
        input.reason,
        input.occurredAt,
      );
    this.fault?.after("base-revision");
    const provenance = {
      asset_id: value.assetId,
      revision: 1,
      source_path: input.baseSourcePath,
      source_commit: input.baseSourceCommit,
      source_blob_oid: input.baseSourceBlobOid,
      source_content_digest: input.baseSourceContentDigest,
      repository_identity: input.repositoryIdentity,
      identity_algorithm: input.identityAlgorithm,
      identity_input_json: input.identityInputJson,
      identity_digest: input.identityDigest,
      recorded_at: input.occurredAt,
    };
    this.db
      .prepare(
        "INSERT INTO legacy_plan_bootstrap_provenance VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(...Object.values(provenance), ledgerRowDigest(provenance, "provenance_digest"));
    this.fault?.after("base-provenance");
    const aliasEvent = {
      alias_event_id: `alias:${input.commandId}:1`,
      asset_id: value.assetId,
      sequence: 1,
      command_id: input.commandId,
      command_payload_digest: value.commandPayloadDigest,
      event_kind: "assigned",
      alias: input.planId,
      revision: 1,
      reason: "legacy bootstrap",
      occurred_at: input.occurredAt,
    };
    const eventDigest = ledgerRowDigest(aliasEvent, "event_digest");
    this.db
      .prepare("INSERT INTO plan_alias_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(...Object.values(aliasEvent), eventDigest);
    this.fault?.after("alias-event");
    this.db
      .prepare("INSERT INTO plan_aliases VALUES (?, ?, ?, ?, ?, ?)")
      .run(`alias-current:${value.assetId}`, value.assetId, input.planId, 1, null, eventDigest);
    this.fault?.after("alias-current");
    this.db
      .prepare("INSERT INTO plan_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        value.assetId,
        2,
        input.canonicalPayloadJson,
        value.canonicalPayloadDigest,
        input.bodyDigest,
        input.sourcePath,
        input.sourceCommit,
        input.actor,
        input.reason,
        input.occurredAt,
      );
    this.fault?.after("next-revision");
  }

  private appendAdmissionAndReceipt(
    input: BootstrapLegacyPlanRevisionInput,
    value: ValidBootstrap,
  ): void {
    const eventId = `admission:${input.certificateId}`;
    const admission = {
      admission_event_id: eventId,
      command_id: input.commandId,
      command_payload_digest: value.commandPayloadDigest,
      event_kind: "admitted",
      plan_asset_id: value.assetId,
      plan_revision: 2,
      plan_id: input.planId,
      source_path: input.sourcePath,
      content_digest: input.contentDigest,
      route_tuple_digest: input.routeTupleDigest,
      certificate_id: input.certificateId,
      certificate_digest: value.certificateDigest,
      occurred_at: input.occurredAt,
    };
    this.db
      .prepare(
        "INSERT INTO plan_admission_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(...Object.values(admission), ledgerRowDigest(admission, "event_digest"));
    this.fault?.after("admission-event");
    this.db
      .prepare("INSERT INTO plan_admission_receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        input.certificateId,
        eventId,
        input.commandId,
        value.commandPayloadDigest,
        value.assetId,
        2,
        input.planId,
        input.sourcePath,
        input.contentDigest,
        input.routeTupleDigest,
        value.certificateDigest,
        input.occurredAt,
      );
    this.fault?.after("admission-receipt");
    const receipt = {
      command_id: input.commandId,
      command_type: "plan.revise",
      subject_kind: "plan_revision",
      subject_key: `${value.assetId}:2`,
      plan_asset_id: value.assetId,
      plan_revision: 2,
      command_payload_digest: value.commandPayloadDigest,
      result_kind: "admission_certificate",
      result_ref: input.certificateId,
      recorded_at: input.occurredAt,
    };
    this.db
      .prepare("INSERT INTO append_command_receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(...Object.values(receipt), ledgerRowDigest(receipt, "receipt_digest"));
    this.fault?.after("receipt");
  }

  private replay(
    input: BootstrapLegacyPlanRevisionInput,
    expected: ValidBootstrap,
  ): AppendPlanRevisionResult | undefined {
    const receipt = this.db
      .prepare("SELECT * FROM append_command_receipts WHERE command_id = ?")
      .get(input.commandId);
    if (!receipt) return undefined;
    if (!secureEqual(String(receipt.command_payload_digest), expected.commandPayloadDigest)) {
      return { ok: false, ruleId: "plan-revision-command-conflict" };
    }
    if (
      !replayBindingValid({
        db: this.db,
        input: {
          ...input,
          assetId: expected.assetId,
          basePayloadDigest: input.baseCanonicalPayloadDigest,
        },
        expected,
        receipt,
      }) ||
      !this.bootstrapBindingValid(input, expected)
    ) {
      return { ok: false, ruleId: "plan-revision-receipt-binding-invalid" };
    }
    return {
      ok: true,
      replayed: true,
      assetId: expected.assetId,
      revision: 2,
      canonicalPayloadDigest: expected.canonicalPayloadDigest,
      commandPayloadDigest: expected.commandPayloadDigest,
      certificateId: input.certificateId,
      certificateDigest: expected.certificateDigest,
    };
  }

  private bootstrapBindingValid(
    input: BootstrapLegacyPlanRevisionInput,
    expected: ValidBootstrap,
  ): boolean {
    const asset = this.db
      .prepare("SELECT * FROM plan_assets WHERE asset_id = ?")
      .get(expected.assetId);
    if (
      !asset ||
      !matches(asset, {
        asset_id: expected.assetId,
        created_at: input.occurredAt,
        created_source_commit: input.baseSourceCommit,
        identity_algorithm: input.identityAlgorithm,
      })
    )
      return false;
    const base = this.db
      .prepare("SELECT * FROM plan_revisions WHERE asset_id = ? AND revision = 1")
      .get(expected.assetId);
    if (
      !base ||
      !matches(base, {
        asset_id: expected.assetId,
        revision: 1,
        canonical_payload_json: input.baseCanonicalPayloadJson,
        canonical_payload_digest: input.baseCanonicalPayloadDigest,
        body_digest: input.baseBodyDigest,
        source_path: input.baseSourcePath,
        source_commit: input.baseSourceCommit,
        actor: "legacy-bootstrap",
        reason: input.reason,
        created_at: input.occurredAt,
      })
    )
      return false;
    const provenance = this.db
      .prepare("SELECT * FROM legacy_plan_bootstrap_provenance WHERE asset_id = ? AND revision = 1")
      .get(expected.assetId);
    const expectedProvenance = {
      asset_id: expected.assetId,
      revision: 1,
      source_path: input.baseSourcePath,
      source_commit: input.baseSourceCommit,
      source_blob_oid: input.baseSourceBlobOid,
      source_content_digest: input.baseSourceContentDigest,
      repository_identity: input.repositoryIdentity,
      identity_algorithm: input.identityAlgorithm,
      identity_input_json: input.identityInputJson,
      identity_digest: input.identityDigest,
      recorded_at: input.occurredAt,
    };
    if (
      !provenance ||
      !matches(provenance, expectedProvenance) ||
      provenance.provenance_digest !== ledgerRowDigest(provenance, "provenance_digest")
    )
      return false;
    const aliasEventId = `alias:${input.commandId}:1`;
    const aliasEvent = this.db
      .prepare("SELECT * FROM plan_alias_events WHERE alias_event_id = ?")
      .get(aliasEventId);
    const expectedAliasEvent = {
      alias_event_id: aliasEventId,
      asset_id: expected.assetId,
      sequence: 1,
      command_id: input.commandId,
      command_payload_digest: expected.commandPayloadDigest,
      event_kind: "assigned",
      alias: input.planId,
      revision: 1,
      reason: "legacy bootstrap",
      occurred_at: input.occurredAt,
    };
    if (
      !aliasEvent ||
      !matches(aliasEvent, expectedAliasEvent) ||
      aliasEvent.event_digest !== ledgerRowDigest(aliasEvent, "event_digest")
    )
      return false;
    const alias = this.db
      .prepare("SELECT * FROM plan_aliases WHERE alias = ? AND valid_to_revision IS NULL")
      .get(input.planId);
    return Boolean(
      alias &&
        matches(alias, {
          alias_id: `alias-current:${expected.assetId}`,
          asset_id: expected.assetId,
          alias: input.planId,
          valid_from_revision: 1,
          valid_to_revision: null,
          last_event_digest: aliasEvent.event_digest,
        }),
    );
  }
}

function matches(row: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => row[key] === value);
}

interface ValidBootstrap {
  readonly ok: true;
  readonly assetId: string;
  readonly canonicalPayloadDigest: string;
  readonly commandPayloadDigest: string;
  readonly certificateDigest: string;
}

function validateBootstrap(
  input: BootstrapLegacyPlanRevisionInput,
): ValidBootstrap | { readonly ok: false; readonly ruleId: string } {
  if (
    input.identityAlgorithm !== "ut-tdd-plan-legacy-v1" ||
    input.identityInputJson !== JSON.stringify([input.repositoryIdentity, input.planId]) ||
    !secureEqual(input.identityDigest, sha(input.identityInputJson)) ||
    input.baseRevision !== 1 ||
    !validSha(input.baseBodyDigest) ||
    !validSha(input.baseSourceContentDigest) ||
    !validGitOid(input.baseSourceCommit) ||
    !validGitOid(input.baseSourceBlobOid) ||
    input.baseSourcePath !== input.sourcePath
  ) {
    return { ok: false, ruleId: "plan-revision-bootstrap-input-invalid" };
  }
  if (
    !parseCanonicalJson(input.baseCanonicalPayloadJson) ||
    !parseCanonicalJson(input.canonicalPayloadJson)
  ) {
    return { ok: false, ruleId: "plan-revision-payload-invalid" };
  }
  if (!secureEqual(input.baseCanonicalPayloadDigest, sha(input.baseCanonicalPayloadJson))) {
    return { ok: false, ruleId: "plan-revision-bootstrap-base-digest-mismatch" };
  }
  if (!secureEqual(input.baseSourceContentDigest, sha(input.baseSourceContent))) {
    return { ok: false, ruleId: "plan-revision-bootstrap-source-preimage-mismatch" };
  }
  const source = parseLegacyPlanSource(input.baseSourceContent);
  if (
    !source ||
    source.planId !== input.planId ||
    canonical(source.frontmatter) !== input.baseCanonicalPayloadJson ||
    !secureEqual(sha(source.body), input.baseBodyDigest)
  ) {
    return { ok: false, ruleId: "plan-revision-bootstrap-source-payload-mismatch" };
  }
  if (!validCommonInput(input)) return { ok: false, ruleId: "plan-revision-input-invalid" };
  const assetId = deriveLegacyAssetId(input.repositoryIdentity, input.planId);
  const canonicalPayloadDigest = sha(input.canonicalPayloadJson);
  const commandPayloadDigest = sha(canonical({ ...input, assetId }));
  const certificateDigest = sha(
    canonical({
      commandPayloadDigest,
      assetId,
      revision: 2,
      planId: input.planId,
      contentDigest: input.contentDigest,
      routeTupleDigest: input.routeTupleDigest,
    }),
  );
  return { ok: true, assetId, canonicalPayloadDigest, commandPayloadDigest, certificateDigest };
}

function validCommonInput(input: BootstrapLegacyPlanRevisionInput): boolean {
  return Boolean(
    input.commandId &&
      input.planId &&
      validSha(input.baseCanonicalPayloadDigest) &&
      validSha(input.bodyDigest) &&
      validSha(input.contentDigest) &&
      input.sourcePath &&
      input.sourceCommit &&
      input.actor &&
      input.reason &&
      validSha(input.routeTupleDigest) &&
      input.certificateId &&
      !Number.isNaN(Date.parse(input.occurredAt)),
  );
}

function createRevisedAsset(
  input: BootstrapLegacyPlanRevisionInput,
  assetId: string,
): { ok: true } | { ok: false; ruleId: string } {
  const created = PlanAsset.create({
    assetId,
    alias: input.planId,
    payload: JSON.parse(input.baseCanonicalPayloadJson) as Record<string, unknown>,
    bodyDigest: input.baseBodyDigest,
  });
  if (!created.ok) return { ok: false, ruleId: created.error.ruleId };
  const revised = created.value.revise({
    baseRevision: input.baseRevision,
    alias: input.planId,
    payload: JSON.parse(input.canonicalPayloadJson) as Record<string, unknown>,
    bodyDigest: input.bodyDigest,
    actor: input.actor,
    reason: input.reason,
  });
  return revised.ok ? { ok: true } : { ok: false, ruleId: revised.error.ruleId };
}

function parseCanonicalJson(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      canonical(parsed) === value
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function validGitOid(value: string): boolean {
  return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);
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
