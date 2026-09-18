import { createHash } from "node:crypto";
import { parseLegacyPlanSource } from "../plan-asset/adapters/legacy-plan-inventory.ts";
import { ledgerRowDigest } from "../plan-asset/ledger/schema.ts";
import { ImmediateLedgerTransaction } from "../plan-asset/ledger/transaction.ts";
import type { HarnessDb } from "../state-db/index.ts";
import { canonicalPlanContentDigest } from "./diff-fence.ts";
import { type PlanRevisionManifest, stableJson } from "./plan-revision-command-assembler.ts";
import {
  parseTrackedReceiptProjection,
  type TrackedReceiptRecord,
} from "./tracked-receipt-projection.ts";

export interface PlanLedgerRehydrationInput {
  readonly db: HarnessDb;
  readonly manifest: PlanRevisionManifest;
  readonly projectionText: string;
  readonly sourceCommit: string;
  readonly sourceBlobOid: string;
  readonly source: string;
}

/**
 * Git管理projectionをauthority、worktree-local ledgerをcacheとしてterminal revisionだけ復元する。
 * 全bindingを先に検証し、validation failureではDBへ一切書かない。
 */
export function rehydratePlanLedgerBase(input: PlanLedgerRehydrationInput): void {
  const prepared = prepare(input);
  new ImmediateLedgerTransaction(input.db).run(() => {
    const current = localState(input.db, input.manifest);
    if (
      current.latestRevision !== prepared.expectedPriorRevision ||
      current.assetExists !== prepared.assetExists ||
      current.activeAliasAssetId !== prepared.activeAliasAssetId
    )
      throw new Error("plan-revision-rehydration-local-state-drift");

    if (!current.assetExists)
      input.db
        .prepare("INSERT INTO plan_assets VALUES (?, ?, ?, ?)")
        .run(
          prepared.assetId,
          prepared.occurredAt,
          prepared.sourceCommit,
          "tracked-projection-rehydration-v1",
        );
    input.db
      .prepare("INSERT INTO plan_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        prepared.assetId,
        prepared.revision,
        prepared.canonicalPayload,
        unprefix(prepared.canonicalPayloadDigest),
        unprefix(prepared.bodyDigest),
        prepared.sourcePath,
        prepared.sourceCommit,
        "tracked-projection",
        `rehydrate:${prepared.receiptId}`,
        prepared.occurredAt,
      );
    if (current.activeAliasAssetId === undefined) {
      input.db
        .prepare("INSERT INTO plan_alias_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(...Object.values(prepared.aliasEvent), prepared.aliasEventDigest);
      input.db
        .prepare("INSERT INTO plan_aliases VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          prepared.aliasId,
          prepared.assetId,
          prepared.planId,
          prepared.revision,
          null,
          prepared.aliasEventDigest,
        );
    }
    return { commit: true, value: undefined };
  });
}

function prepare(input: PlanLedgerRehydrationInput) {
  const { manifest } = input;
  const state = localState(input.db, manifest);
  if (state.latestRevision !== undefined && state.latestRevision >= manifest.base.revision)
    throw new Error("plan-revision-rehydration-base-not-newer");
  if (state.activeAliasAssetId !== undefined && state.activeAliasAssetId !== manifest.base.asset_id)
    throw new Error("plan-revision-rehydration-alias-mismatch");

  if (input.sourceCommit !== manifest.base.source_commit)
    throw new Error("plan-revision-rehydration-source-commit-mismatch");
  if (input.sourceBlobOid !== manifest.base.source_blob_oid)
    throw new Error("plan-revision-rehydration-source-blob-mismatch");
  if (!digestEqual(sha(input.source), manifest.base.source_content_digest))
    throw new Error("plan-revision-rehydration-source-digest-mismatch");

  const parsed = parseLegacyPlanSource(input.source);
  if (!parsed) throw new Error("plan-revision-rehydration-source-invalid");
  if (parsed.planId !== manifest.plan_id)
    throw new Error("plan-revision-rehydration-plan-id-mismatch");
  const embeddedReceipt = parsed.frontmatter.admission_receipt;
  if (!isRecord(embeddedReceipt)) throw new Error("plan-revision-rehydration-receipt-missing");
  const embeddedBinding = embeddedReceipt.binding;
  if (!isRecord(embeddedBinding)) throw new Error("plan-revision-rehydration-receipt-mismatch");
  // The embedded receipt (not the caller-declared manifest.base fields) is
  // the ground truth for *which* asset/plan/path/revision this rehydration
  // targets. The manifest is only cross-checked against it below, never used
  // to pre-filter candidates (PLAN-RECOVERY-16 rev 5 §correction: manifest
  // self-report must not be the selection basis).
  if (embeddedBinding.plan_id !== manifest.plan_id)
    throw new Error("plan-revision-rehydration-plan-id-mismatch");
  if (embeddedBinding.path !== manifest.source.path)
    throw new Error("plan-revision-rehydration-path-mismatch");
  if (embeddedBinding.asset_id !== manifest.base.asset_id)
    throw new Error("plan-revision-rehydration-asset-mismatch");
  if (embeddedBinding.revision !== manifest.base.revision)
    throw new Error("plan-revision-rehydration-revision-mismatch");

  const projection = parseTrackedReceiptProjection(input.projectionText);
  if (!projection.ok)
    throw new Error(`plan-revision-rehydration-projection-invalid:${projection.errors.join(",")}`);

  const matches = projection.value.records.filter((record) =>
    embeddedReceiptMatchesRecord(embeddedReceipt, record),
  );
  if (matches.length === 0) {
    // A projection record with this receipt_id but mismatched binding fields
    // is an integrity violation (tampered lineage), not authority absence.
    // Authority absence — no record with this receipt_id at all — is the
    // only condition that falls back to the legacy bootstrap path.
    const receiptIdExists = projection.value.records.some(
      (record) => record.receiptId === embeddedReceipt.receipt_id,
    );
    throw new Error(
      receiptIdExists
        ? "plan-revision-rehydration-receipt-mismatch"
        : "plan-revision-rehydration-projection-missing",
    );
  }
  if (matches.length > 1) throw new Error("plan-revision-rehydration-projection-ambiguous");
  const record = matches[0];
  if (!record) throw new Error("plan-revision-rehydration-projection-missing");

  // Lineage: a PLAN may have later records under a superseding asset for the
  // same plan_id/path. The embedded-receipt match is only authoritative for
  // rehydration if it is also the most recent record recorded for this
  // plan_id/path across every asset; otherwise this would resurrect a stale
  // lineage instead of the live one.
  const lineage = projection.value.records.filter(
    (candidate) =>
      candidate.binding.planId === manifest.plan_id &&
      candidate.binding.path === manifest.source.path,
  );
  const latestLineageSequence = Math.max(...lineage.map((candidate) => candidate.sequence));
  if (record.sequence !== latestLineageSequence)
    throw new Error("plan-revision-rehydration-lineage-ambiguous");

  const contentDigest = canonicalPlanContentDigest(input.source);
  if (!contentDigest || !digestEqual(contentDigest, record.binding.contentDigest))
    throw new Error("plan-revision-rehydration-content-digest-mismatch");

  const receiptFreeFrontmatter = { ...parsed.frontmatter };
  delete receiptFreeFrontmatter.admission_receipt;
  const canonicalPayload = stableJson(receiptFreeFrontmatter);
  const canonicalPayloadDigest = sha(canonicalPayload);
  const bodyDigest = sha(parsed.body);
  if (!digestEqual(canonicalPayloadDigest, manifest.base.revision_digest))
    throw new Error("plan-revision-rehydration-canonical-digest-mismatch");

  const admittedAt = receiptAdmittedAt(embeddedReceipt);
  const commandId = `plan-rehydrate-alias:${unprefix(record.recordDigest)}`;
  const aliasEvent = {
    alias_event_id: `alias-event:rehydrate:${unprefix(record.recordDigest)}`,
    asset_id: manifest.base.asset_id,
    sequence: nextAliasSequence(input.db, manifest.base.asset_id),
    command_id: commandId,
    command_payload_digest: unprefix(
      sha(
        stableJson({
          assetId: manifest.base.asset_id,
          planId: manifest.plan_id,
          revision: manifest.base.revision,
          recordDigest: record.recordDigest,
        }),
      ),
    ),
    event_kind: "assigned",
    alias: manifest.plan_id,
    revision: manifest.base.revision,
    reason: `rehydrate:${record.receiptId}`,
    occurred_at: admittedAt,
  };
  return {
    assetId: manifest.base.asset_id,
    planId: manifest.plan_id,
    revision: manifest.base.revision,
    receiptId: record.receiptId,
    sourcePath: manifest.source.path,
    sourceCommit: manifest.base.source_commit,
    canonicalPayload,
    canonicalPayloadDigest,
    bodyDigest,
    occurredAt: admittedAt,
    assetExists: state.assetExists,
    activeAliasAssetId: state.activeAliasAssetId,
    expectedPriorRevision: state.latestRevision,
    aliasId: `alias:rehydrate:${rawSha(`${manifest.plan_id}\0${manifest.base.asset_id}`)}`,
    aliasEvent,
    aliasEventDigest: ledgerRowDigest(aliasEvent, "event_digest"),
  };
}

function localState(db: HarnessDb, manifest: PlanRevisionManifest) {
  const assetExists = Boolean(
    db.prepare("SELECT 1 FROM plan_assets WHERE asset_id = ?").get(manifest.base.asset_id),
  );
  const latest = db
    .prepare(
      "SELECT revision FROM plan_revisions WHERE asset_id = ? ORDER BY revision DESC LIMIT 1",
    )
    .get(manifest.base.asset_id);
  const aliases = db
    .prepare("SELECT asset_id FROM plan_aliases WHERE alias = ? AND valid_to_revision IS NULL")
    .all(manifest.plan_id);
  if (aliases.length > 1) throw new Error("plan-revision-rehydration-alias-ambiguous");
  return {
    assetExists,
    latestRevision: latest ? Number(latest.revision) : undefined,
    activeAliasAssetId: aliases[0] ? String(aliases[0].asset_id) : undefined,
  };
}

/**
 * HEAD embedded admission_receiptと1件のtracked projection recordが全項目
 * (receipt identity + full binding) で一致するかを判定する。選択の唯一の根拠
 * であり (manifestの自己申告ではない)、per-field比較なのでpartial matchを
 * 誤って採用しない。
 */
function embeddedReceiptMatchesRecord(value: unknown, record: TrackedReceiptRecord): boolean {
  if (!isRecord(value)) return false;
  const binding = value.binding;
  if (!isRecord(binding)) return false;
  return (
    value.receipt_id === record.receiptId &&
    value.command_id === record.commandId &&
    value.receipt_digest === record.receiptDigest &&
    value.decision_digest === record.decisionDigest &&
    value.source_digest === record.binding.contentDigest &&
    binding.path === record.binding.path &&
    binding.plan_id === record.binding.planId &&
    binding.asset_id === record.binding.assetId &&
    binding.revision === record.binding.revision &&
    binding.content_digest === record.binding.contentDigest
  );
}

function receiptAdmittedAt(value: unknown): string {
  if (
    !isRecord(value) ||
    typeof value.admitted_at !== "string" ||
    Number.isNaN(Date.parse(value.admitted_at))
  )
    throw new Error("plan-revision-rehydration-receipt-time-invalid");
  return value.admitted_at;
}

function nextAliasSequence(db: HarnessDb, assetId: string): number {
  const row = db
    .prepare("SELECT MAX(sequence) AS sequence FROM plan_alias_events WHERE asset_id = ?")
    .get(assetId);
  return Number(row?.sequence ?? 0) + 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha(value: string): `sha256:${string}` {
  return `sha256:${rawSha(value)}`;
}

function rawSha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function unprefix(value: string): string {
  return value.startsWith("sha256:") ? value.slice(7) : value;
}

function digestEqual(left: string, right: string): boolean {
  return unprefix(left) === unprefix(right);
}
