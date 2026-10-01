import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseLegacyPlanSource } from "../plan-asset/adapters/legacy-plan-inventory.ts";
import { loadProjectIdentityFromHead } from "../plan-asset/adapters/project-identity-loader.ts";
import { LegacyPlanRevisionBootstrapTransaction } from "../plan-asset/ledger/plan-revision-bootstrap.ts";
import {
  type AppendPlanRevisionInput,
  derivePlanRevisionDigests,
  PlanRevisionLedgerTransaction,
  replayBindingValid,
} from "../plan-asset/ledger/plan-revision-ledger.ts";
import { openPlanLedger } from "../plan-asset/ledger/schema.ts";
import type { HarnessDb } from "../state-db/index.ts";
import { NodeAtomicDraftPublisher } from "./node-atomic-draft-publisher.ts";
import { bindPlanSourceToAdmission } from "./plan-content-binding.ts";
import {
  type DraftArtifact,
  type DraftPublisherPort,
  PlanDraftCleanupPendingError,
  PlanDraftService,
} from "./plan-draft-service.ts";
import { rehydratePlanLedgerBase } from "./plan-ledger-rehydrator.ts";
import {
  assemblePlanRevisionCommand,
  canonicalPlanPayload,
  type PlanRevisionExecutionPayload,
  type PlanRevisionManifest,
  planRevisionReplayBindingDigest,
  stableJson,
  validatePlanRevisionCommand,
} from "./plan-revision-command-assembler.ts";
import {
  PlanRevisionLedgerAdapter,
  type PlanRevisionReceipt,
} from "./plan-revision-ledger-adapter.ts";
import {
  type AdmissionDecision,
  evaluatePlanAdmission,
  type PlanAdmissionRequest,
} from "./policy.ts";
import { SqliteDraftJournal } from "./sqlite-draft-journal.ts";
import { parseTrackedReceiptProjection } from "./tracked-receipt-projection.ts";
import { TrackedReceiptRenderer } from "./tracked-receipt-renderer.ts";

export interface NodePlanRevisionRunnerDeps {
  repoRoot: string;
  sourceCommit: () => string;
  sourceBlobOid: (commit: string, path: string) => string;
  readText: (path: string) => string;
  headText: (commit: string, path: string) => string;
  repositoryIdentity?: () => string;
  openDb?: () => HarnessDb;
  publisher?: () => DraftPublisherPort;
}

/** HEAD preimage、working tree CAS、ledgerを一つのrevision Sagaへ閉じるNode adapter。 */
export class NodePlanRevisionRunner {
  private readonly deps: NodePlanRevisionRunnerDeps;

  constructor(deps: NodePlanRevisionRunnerDeps) {
    this.deps = deps;
  }

  run(input: {
    manifest: PlanRevisionManifest;
    admission: PlanAdmissionRequest;
    decision: Extract<AdmissionDecision, { ok: true }>;
  }) {
    assertAdmission(input);
    const db = this.deps.openDb?.() ?? openPlanLedger({ repoRoot: this.deps.repoRoot });
    try {
      const journal = new SqliteDraftJournal(db);
      const publisher =
        this.deps.publisher?.() ?? new NodeAtomicDraftPublisher({ rootDir: this.deps.repoRoot });
      const prior = journal.find(input.manifest.command_id);
      if (prior?.status === "committed") {
        const expectedRequest = planRevisionReplayBindingDigest(input.manifest, input.admission);
        if (!digestEqual(prior.cleanup.operation.requestDigest, expectedRequest))
          throw new Error("plan-revision-replay-request-conflict");
        assertCommittedReplayBinding({
          db,
          manifest: input.manifest,
          admission: input.admission,
          receipt: prior.receipt,
          expectedActor: input.manifest.actor,
          repositoryIdentity: requireRepositoryIdentity(this.deps.repositoryIdentity),
          baseSource: this.boundBaseSource(input.manifest),
        });
        try {
          publisher.resumeCleanup(prior.cleanup.operation);
          if (prior.cleanup.status === "pending")
            journal.completeCleanup(input.manifest.command_id, prior.payloadDigest);
        } catch (cause) {
          const pending = new PlanDraftCleanupPendingError(
            "plan-revision-replay-artifact-binding-invalid",
            prior.receipt as PlanRevisionReceipt,
            { cause },
          );
          throw pending;
        }
        return { status: "replayed" as const, receipt: prior.receipt as PlanRevisionReceipt };
      }
      const base = this.preflightBase(input.manifest);
      const snapshot = this.preflightMutable(input.manifest, base);
      const locallyAdopted = Boolean(
        db
          .prepare("SELECT 1 FROM plan_assets WHERE asset_id = ?")
          .get(input.manifest.base.asset_id),
      );
      const rehydrationRequired = needsRehydration({
        db,
        manifest: input.manifest,
        assetExists: locallyAdopted,
        projectionText: snapshot.projectionText,
        headSource: base.headSource,
      });
      const adopted = locallyAdopted || rehydrationRequired;
      const legacy =
        !adopted ||
        revisionUsesLegacyBootstrap(db, input.manifest.base.asset_id, input.manifest.command_id);
      const command = assemblePlanRevisionCommand({
        manifest: input.manifest,
        admission: input.admission,
        environment: {
          repositoryIdentity: base.repositoryIdentity,
          sourceCommit: base.sourceCommit,
          sourceBlobOid: base.sourceBlobOid,
          headSource: base.headSource,
          actor: input.manifest.actor,
        },
        legacy,
      });
      validatePlanRevisionCommand(command);
      if (rehydrationRequired)
        rehydratePlanLedgerBase({
          db,
          manifest: input.manifest,
          projectionText: snapshot.projectionText,
          sourceCommit: base.sourceCommit,
          sourceBlobOid: base.sourceBlobOid,
          source: base.headSource,
        });
      if (adopted) assertAdoptedBase(db, input.manifest);
      const renderer = new RevisionRenderer(
        new TrackedReceiptRenderer<PlanRevisionExecutionPayload>({
          read: () => snapshot.projectionText,
        }),
        snapshot.sourceByteDigest,
        snapshot.projectionByteDigest,
      );
      const service = new PlanDraftService<PlanRevisionExecutionPayload, PlanRevisionReceipt>({
        validator: { validate: validatePlanRevisionCommand },
        journal,
        publisher,
        renderer,
        ledger: new PlanRevisionLedgerAdapter(
          new PlanRevisionLedgerTransaction(db),
          new LegacyPlanRevisionBootstrapTransaction(db),
        ),
      });
      return service.execute(command);
    } finally {
      db.close();
    }
  }

  private preflightBase(manifest: PlanRevisionManifest) {
    const sourceCommit = this.deps.sourceCommit();
    if (sourceCommit !== manifest.base.source_commit)
      throw new Error("plan-revision-source-commit-drift");
    const sourceBlobOid = this.deps.sourceBlobOid(sourceCommit, manifest.source.path);
    if (sourceBlobOid !== manifest.base.source_blob_oid)
      throw new Error("plan-revision-source-blob-drift");
    const headSource = this.deps.headText(sourceCommit, manifest.source.path);
    const headDigest = prefixedSha(headSource);
    if (!digestEqual(headDigest, manifest.base.source_content_digest))
      throw new Error("plan-revision-head-content-drift");
    return {
      sourceCommit,
      sourceBlobOid,
      headSource,
      repositoryIdentity: requireRepositoryIdentity(this.deps.repositoryIdentity),
    };
  }

  private preflightMutable(
    manifest: PlanRevisionManifest,
    base: ReturnType<NodePlanRevisionRunner["preflightBase"]>,
  ) {
    const sourcePath = resolveRepoPath(this.deps.repoRoot, manifest.source.path);
    const projectionPath = resolveRepoPath(this.deps.repoRoot, manifest.projection.path);
    const sourceText = this.deps.readText(sourcePath);
    const projectionText = this.deps.readText(projectionPath);
    const sourceByteDigest = prefixedSha(sourceText);
    const projectionByteDigest = prefixedSha(projectionText);
    if (!digestEqual(sourceByteDigest, prefixedSha(base.headSource)))
      throw new Error("plan-revision-source-content-drift");
    if (!digestEqual(projectionTailDigest(projectionText), manifest.base.projection_tail_digest))
      throw new Error("plan-revision-projection-tail-drift");
    return {
      sourceCommit: base.sourceCommit,
      sourceBlobOid: base.sourceBlobOid,
      sourceByteDigest,
      projectionByteDigest,
      projectionText,
      headSource: base.headSource,
      repositoryIdentity: base.repositoryIdentity,
    };
  }

  private boundBaseSource(manifest: PlanRevisionManifest): string {
    const blob = this.deps.sourceBlobOid(manifest.base.source_commit, manifest.source.path);
    if (blob !== manifest.base.source_blob_oid) throw new Error("plan-revision-source-blob-drift");
    const source = this.deps.headText(manifest.base.source_commit, manifest.source.path);
    if (!digestEqual(prefixedSha(source), manifest.base.source_content_digest))
      throw new Error("plan-revision-head-content-drift");
    return source;
  }
}

function assertCommittedReplayBinding(binding: {
  db: HarnessDb;
  manifest: PlanRevisionManifest;
  admission: PlanAdmissionRequest;
  receipt: import("./plan-draft-service.ts").DraftReceiptBinding;
  expectedActor: string;
  repositoryIdentity: string;
  baseSource: string;
}): void {
  const { db, manifest, admission, receipt, expectedActor, repositoryIdentity, baseSource } =
    binding;
  if (receipt.assetId !== manifest.base.asset_id || receipt.revision !== manifest.base.revision + 1)
    throw new Error("plan-revision-replay-receipt-conflict");
  const revision = db
    .prepare(
      `SELECT canonical_payload_json, canonical_payload_digest, body_digest, source_path,
              source_commit, actor, reason
       FROM plan_revisions WHERE asset_id = ? AND revision = ?`,
    )
    .get(receipt.assetId, receipt.revision) as Record<string, unknown> | undefined;
  const bound = bindPlanSourceToAdmission({
    source: manifest.source.content,
    planId: manifest.plan_id,
    admission,
  });
  const desired = canonicalPlanPayload(bound.source);
  if (
    !revision ||
    String(revision.canonical_payload_json) !== desired.payload ||
    !digestEqual(String(revision.canonical_payload_digest), prefixedSha(desired.payload)) ||
    !digestEqual(String(revision.body_digest), prefixedSha(desired.body)) ||
    String(revision.source_path) !== manifest.source.path
  )
    throw new Error("plan-revision-replay-revision-conflict");
  const base = db
    .prepare(
      `SELECT canonical_payload_digest FROM plan_revisions
       WHERE asset_id = ? AND revision = ?`,
    )
    .get(receipt.assetId, manifest.base.revision);
  if (!base || !digestEqual(String(base.canonical_payload_digest), manifest.base.revision_digest))
    throw new Error("plan-revision-replay-base-conflict");
  const appendReceipt = db
    .prepare("SELECT * FROM append_command_receipts WHERE command_id = ?")
    .get(manifest.command_id) as Record<string, unknown> | undefined;
  if (!appendReceipt) throw new Error("plan-revision-replay-ledger-conflict");
  const certificateId = `certificate:${rawSha(manifest.command_id).slice(0, 32)}`;
  if (receipt.certificateId !== certificateId)
    throw new Error("plan-revision-replay-certificate-conflict");
  const contentDigest = unprefix(bound.contentDigest);
  const routeTupleDigest = rawSha(stableJson(admission));
  const ledgerInput: AppendPlanRevisionInput = {
    commandId: manifest.command_id,
    assetId: receipt.assetId,
    planId: manifest.plan_id,
    baseRevision: manifest.base.revision,
    basePayloadDigest: unprefix(manifest.base.revision_digest),
    canonicalPayloadJson: desired.payload,
    contentDigest,
    bodyDigest: rawSha(desired.body),
    sourcePath: manifest.source.path,
    sourceCommit: manifest.base.source_commit,
    actor: expectedActor,
    reason: admission.escapeReason ?? `route:${admission.routeSignal}`,
    routeTupleDigest,
    certificateId,
    occurredAt: manifest.recorded_at,
  };
  const derived = derivePlanRevisionDigests(ledgerInput);
  const legacy = revisionUsesLegacyBootstrap(db, receipt.assetId, manifest.command_id);
  const commandPayloadDigest = legacy
    ? unprefix(
        assemblePlanRevisionCommand({
          manifest,
          admission,
          environment: {
            repositoryIdentity,
            sourceCommit: manifest.base.source_commit,
            sourceBlobOid: manifest.base.source_blob_oid,
            headSource: baseSource,
            actor: expectedActor,
          },
          legacy: true,
        }).commandPayloadDigest,
      )
    : derived.commandPayloadDigest;
  if (
    !digestEqual(String(receipt.commandPayloadDigest), commandPayloadDigest) ||
    !digestEqual(String(appendReceipt.command_payload_digest), commandPayloadDigest)
  )
    throw new Error("plan-revision-replay-command-conflict");
  const certificateDigest = legacy
    ? rawSha(
        stableJson({
          commandPayloadDigest,
          assetId: receipt.assetId,
          revision: receipt.revision,
          planId: manifest.plan_id,
          contentDigest,
          routeTupleDigest,
        }),
      )
    : derived.certificateDigest;
  if (!receipt.certificateDigest || !digestEqual(receipt.certificateDigest, certificateDigest))
    throw new Error("plan-revision-replay-certificate-conflict");
  if (
    !replayBindingValid({
      db,
      input: ledgerInput,
      expected: {
        canonicalPayloadDigest: derived.canonicalPayloadDigest,
        commandPayloadDigest,
        certificateDigest,
      },
      receipt: appendReceipt,
    })
  )
    throw new Error("plan-revision-replay-ledger-conflict");
}

export function revisionUsesLegacyBootstrap(
  db: HarnessDb,
  assetId: string,
  commandId: string,
): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1
         FROM legacy_plan_bootstrap_provenance provenance
         JOIN append_command_receipts receipt
           ON receipt.plan_asset_id = provenance.asset_id
          AND receipt.command_id = ?
          AND receipt.plan_revision = provenance.revision + 1
         WHERE provenance.asset_id = ? AND provenance.revision = 1`,
      )
      .get(commandId, assetId),
  );
}

class RevisionRenderer {
  private readonly delegate: TrackedReceiptRenderer<PlanRevisionExecutionPayload>;
  private readonly sourceDigest: `sha256:${string}`;
  private readonly projectionDigest: `sha256:${string}`;

  constructor(
    delegate: TrackedReceiptRenderer<PlanRevisionExecutionPayload>,
    sourceDigest: `sha256:${string}`,
    projectionDigest: `sha256:${string}`,
  ) {
    this.delegate = delegate;
    this.sourceDigest = sourceDigest;
    this.projectionDigest = projectionDigest;
  }

  render(
    command: import("./plan-draft-service.ts").PlanDraftCommand<PlanRevisionExecutionPayload>,
    receipt: PlanRevisionReceipt,
  ): readonly [DraftArtifact, DraftArtifact] {
    if (!receipt.certificateDigest) throw new Error("plan-revision-receipt-incomplete");
    const [source, projection] = this.delegate.render(
      command,
      receipt as PlanRevisionReceipt & { certificateDigest: string },
    );
    return [
      { ...source, expectedPreimage: { kind: "sha256", digest: this.sourceDigest } },
      { ...projection, expectedPreimage: { kind: "sha256", digest: this.projectionDigest } },
    ];
  }
}

export function createNodePlanRevisionRunner(repoRoot: string): NodePlanRevisionRunner {
  return new NodePlanRevisionRunner({
    repoRoot,
    sourceCommit: () => git(repoRoot, ["rev-parse", "HEAD"]),
    sourceBlobOid: (commit, path) => git(repoRoot, ["rev-parse", `${commit}:${path}`]),
    headText: (commit, path) =>
      execFileSync("git", ["-C", repoRoot, "show", `${commit}:${path}`], { encoding: "utf8" }),
    repositoryIdentity: () => {
      const identity = loadProjectIdentityFromHead({ repoRoot });
      if (!identity.ok) throw new Error(identity.error.ruleId);
      return identity.value.repositoryIdentity;
    },
    readText: (path) => readFileSync(path, "utf8"),
  });
}

function projectionTailDigest(text: string): `sha256:${string}` {
  const parsed = parseTrackedReceiptProjection(text);
  if (!parsed.ok) throw new Error(`plan-revision-projection-invalid:${parsed.errors.join(",")}`);
  return normalizeDigest(parsed.value.records.at(-1)?.recordDigest ?? prefixedSha("null"));
}

function assertAdmission(input: {
  manifest: PlanRevisionManifest;
  admission: PlanAdmissionRequest;
  decision: Extract<AdmissionDecision, { ok: true }>;
}): void {
  const expectedAdmission = admissionFromManifest(input.manifest);
  if (stableJson(expectedAdmission) !== stableJson(input.admission))
    throw new Error("plan-revision-manifest-admission-mismatch");
  const evaluated = evaluatePlanAdmission(input.admission);
  if (!evaluated.ok) throw new Error("plan-revision-admission-invalid");
  if (stableJson(evaluated) !== stableJson(input.decision))
    throw new Error("plan-revision-admission-decision-mismatch");
}

function admissionFromManifest(manifest: PlanRevisionManifest): PlanAdmissionRequest {
  const value = manifest.admission;
  return {
    routeSignal: value.route_signal,
    routeMode: value.route_mode,
    kind: value.kind,
    layer: value.layer,
    drive: value.drive,
    branch: value.branch,
    ...(value.workflow_phase ? { workflowPhase: value.workflow_phase } : {}),
    ...(value.status ? { status: value.status } : {}),
    ...(value.sub_doc ? { subDoc: value.sub_doc } : {}),
    ...(value.issue
      ? {
          issue: {
            provider: value.issue.provider,
            issueId: value.issue.issue_id,
            episodeId: value.issue.episode_id,
            projectionState: value.issue.projection_state,
            ...(value.issue.projection_state === "projected"
              ? { projectionDigest: value.issue.projection_digest }
              : {}),
          },
        }
      : {}),
    ...(value.origin
      ? {
          origin: {
            planId: value.origin.plan_id,
            revision: value.origin.revision,
            digest: value.origin.digest,
          },
        }
      : {}),
    ...(value.transition_direction ? { transitionDirection: value.transition_direction } : {}),
    ...(value.implementation_disposition
      ? { implementationDisposition: value.implementation_disposition }
      : {}),
    ...(value.reentry
      ? {
          reentry: {
            targetPlanId: value.reentry.target_plan_id,
            targetRevision: value.reentry.target_revision,
            phase: value.reentry.phase,
          },
        }
      : {}),
    ...(value.implementation_target
      ? {
          implementationTarget: {
            targetPlanId: value.implementation_target.target_plan_id,
            targetRevision: value.implementation_target.target_revision,
          },
        }
      : {}),
    ...(value.escape_reason ? { escapeReason: value.escape_reason } : {}),
    ...(value.supersedes ? { supersedes: value.supersedes } : {}),
  };
}

function assertAdoptedBase(db: HarnessDb, manifest: PlanRevisionManifest): void {
  const aliases = db
    .prepare(
      `SELECT asset_id FROM plan_aliases
       WHERE alias = ? AND valid_to_revision IS NULL`,
    )
    .all(manifest.plan_id) as Array<{ asset_id: string }>;
  if (aliases.length !== 1 || aliases[0]?.asset_id !== manifest.base.asset_id)
    throw new Error("plan-revision-alias-binding-invalid");
  const latest = db
    .prepare(
      `SELECT revision, canonical_payload_digest FROM plan_revisions
       WHERE asset_id = ? ORDER BY revision DESC LIMIT 1`,
    )
    .get(manifest.base.asset_id) as
    | { revision: number; canonical_payload_digest: string }
    | undefined;
  if (
    !latest ||
    Number(latest.revision) !== manifest.base.revision ||
    !digestEqual(latest.canonical_payload_digest, manifest.base.revision_digest)
  )
    throw new Error("plan-revision-ledger-base-drift");
}

function needsRehydration(input: {
  db: HarnessDb;
  manifest: PlanRevisionManifest;
  assetExists: boolean;
  projectionText: string;
  headSource: string;
}): boolean {
  const { db, manifest, assetExists, projectionText, headSource } = input;
  if (!assetExists) {
    // Rehydration eligibility is gated by the HEAD embedded admission_receipt
    // proving a live tracked-projection record, never by asset id prefix or
    // manifest self-report (PLAN-RECOVERY-16 rev 5 §correction). Any deeper
    // integrity/lineage mismatch is fail-close inside rehydratePlanLedgerBase,
    // not a silent fallback here.
    return projectionHasEmbeddedReceiptRecord(projectionText, headSource);
  }
  const latest = db
    .prepare(
      "SELECT revision FROM plan_revisions WHERE asset_id = ? ORDER BY revision DESC LIMIT 1",
    )
    .get(manifest.base.asset_id);
  return !latest || Number(latest.revision) < manifest.base.revision;
}

function projectionHasEmbeddedReceiptRecord(projectionText: string, headSource: string): boolean {
  const parsedSource = parseLegacyPlanSource(headSource);
  const embeddedReceipt = parsedSource?.frontmatter.admission_receipt;
  // Absent authority (no admission_receipt key, or unparseable source) permits
  // the legacy fallback. A present-but-malformed admission_receipt is not
  // absence -- it is a corrupt authority and must fail closed rather than
  // silently falling back (PLAN-RECOVERY-16 rev 5 §2).
  if (embeddedReceipt === undefined) return false;
  if (typeof embeddedReceipt !== "object" || embeddedReceipt === null)
    throw new Error("plan-revision-rehydration-receipt-mismatch");
  const receiptId = (embeddedReceipt as Record<string, unknown>).receipt_id;
  if (typeof receiptId !== "string" || receiptId.length === 0)
    throw new Error("plan-revision-rehydration-receipt-mismatch");
  const parsed = parseTrackedReceiptProjection(projectionText);
  if (!parsed.ok) throw new Error(`plan-revision-projection-invalid:${parsed.errors.join(",")}`);
  return parsed.value.records.some((record) => record.receiptId === receiptId);
}

function requireRepositoryIdentity(provider: (() => string) | undefined): string {
  const identity = provider?.().trim();
  if (!identity) throw new Error("plan-revision-repository-identity-required");
  return identity;
}

function normalizeDigest(value: string): `sha256:${string}` {
  return (value.startsWith("sha256:") ? value : `sha256:${value}`) as `sha256:${string}`;
}
function prefixedSha(value: string): `sha256:${string}` {
  return `sha256:${rawSha(value)}`;
}
function rawSha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function unprefix(value: string): string {
  return value.startsWith("sha256:") ? value.slice(7) : value;
}
function digestEqual(left: string, right: string): boolean {
  return normalizeDigest(left) === normalizeDigest(right);
}
function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}
function resolveRepoPath(root: string, path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").includes(".."))
    throw new Error("plan-revision-path-invalid");
  return `${root.replaceAll("\\", "/").replace(/\/$/, "")}/${normalized}`;
}
