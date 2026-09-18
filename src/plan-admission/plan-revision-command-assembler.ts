import { createHash } from "node:crypto";
import { parseLegacyPlanSource } from "../plan-asset/adapters/legacy-plan-inventory.ts";
import type { BootstrapLegacyPlanRevisionInput } from "../plan-asset/ledger/plan-revision-bootstrap.ts";
import type { AppendPlanRevisionInput } from "../plan-asset/ledger/plan-revision-ledger.ts";
import { bindPlanSourceToAdmission } from "./plan-content-binding.ts";
import type { PlanDraftCommand } from "./plan-draft-service.ts";
import { evaluatePlanAdmission, type PlanAdmissionRequest } from "./policy.ts";

export interface PlanRevisionEnvironment {
  repositoryIdentity: string;
  sourceCommit: string;
  sourceBlobOid: string;
  headSource: string;
  actor: string;
}

/** CLI parserと実行domainを構造で結ぶ。plan-admissionからcliへの逆依存を作らない。 */
export interface PlanRevisionManifest {
  readonly version: 1;
  readonly command_id: string;
  readonly plan_id: string;
  readonly actor: string;
  readonly recorded_at: string;
  readonly base: {
    readonly asset_id: string;
    readonly revision: number;
    readonly revision_digest: string;
    readonly source_commit: string;
    readonly source_blob_oid: string;
    readonly source_content_digest: string;
    readonly projection_tail_digest: string;
  };
  readonly admission: {
    readonly route_signal: string;
    readonly route_mode: PlanAdmissionRequest["routeMode"];
    readonly kind: PlanAdmissionRequest["kind"];
    readonly layer: PlanAdmissionRequest["layer"];
    readonly workflow_phase?: PlanAdmissionRequest["workflowPhase"];
    readonly drive: PlanAdmissionRequest["drive"];
    readonly branch: string;
    readonly status?: PlanAdmissionRequest["status"];
    readonly sub_doc?: PlanAdmissionRequest["subDoc"];
    readonly issue?: {
      readonly provider: "github";
      readonly issue_id: number;
      readonly episode_id: string;
      readonly projection_digest: string;
    };
    readonly origin?: {
      readonly plan_id: string;
      readonly revision: number;
      readonly digest: string;
    };
    readonly transition_direction?: PlanAdmissionRequest["transitionDirection"];
    readonly implementation_disposition?: PlanAdmissionRequest["implementationDisposition"];
    readonly reentry?: {
      readonly target_plan_id: string;
      readonly target_revision: number;
      readonly phase: "forward_merge";
    };
    readonly implementation_target?: {
      readonly target_plan_id: string;
      readonly target_revision: number;
    };
    readonly escape_reason?: string;
    readonly supersedes?: readonly string[];
  };
  readonly source: { readonly path: string; readonly content: string };
  readonly projection: { readonly path: "docs/governance/plan-admission-receipts.json" };
}

export interface PlanRevisionExecutionPayload {
  admission: PlanAdmissionRequest;
  ledgerInput: AppendPlanRevisionInput | BootstrapLegacyPlanRevisionInput;
  legacy: boolean;
}

/** Revision commandを外部状態から分離してcanonical ledger inputへ組み立てる。 */
export function assemblePlanRevisionCommand(input: {
  manifest: PlanRevisionManifest;
  admission: PlanAdmissionRequest;
  environment: PlanRevisionEnvironment;
  legacy: boolean;
}): PlanDraftCommand<PlanRevisionExecutionPayload> {
  const { manifest, admission, environment } = input;
  const bound = bindPlanSourceToAdmission({
    source: manifest.source.content,
    planId: manifest.plan_id,
    admission,
  });
  const current = canonicalPlanPayload(bound.source);
  const base = canonicalPlanPayload(environment.headSource);
  if (input.legacy) {
    const derivedAssetId = legacyAssetId(environment.repositoryIdentity, manifest.plan_id);
    if (manifest.base.asset_id !== derivedAssetId)
      throw new Error("plan-revision-legacy-asset-id-mismatch");
    if (unprefix(manifest.base.revision_digest) !== sha(base.payload))
      throw new Error("plan-revision-base-canonical-drift");
  }
  const common: AppendPlanRevisionInput = {
    commandId: manifest.command_id,
    assetId: manifest.base.asset_id,
    planId: manifest.plan_id,
    baseRevision: manifest.base.revision,
    basePayloadDigest: unprefix(manifest.base.revision_digest),
    canonicalPayloadJson: current.payload,
    contentDigest: unprefix(bound.contentDigest),
    bodyDigest: sha(current.body),
    sourcePath: manifest.source.path,
    sourceCommit: environment.sourceCommit,
    actor: environment.actor,
    reason: admission.escapeReason ?? `route:${admission.routeSignal}`,
    routeTupleDigest: sha(stableJson(admission)),
    certificateId: `certificate:${sha(manifest.command_id).slice(0, 32)}`,
    occurredAt: manifest.recorded_at,
  };
  const ledgerInput: AppendPlanRevisionInput | BootstrapLegacyPlanRevisionInput = input.legacy
    ? {
        ...common,
        repositoryIdentity: environment.repositoryIdentity,
        identityAlgorithm: "ut-tdd-plan-legacy-v1",
        identityInputJson: JSON.stringify([environment.repositoryIdentity, manifest.plan_id]),
        identityDigest: sha(JSON.stringify([environment.repositoryIdentity, manifest.plan_id])),
        baseCanonicalPayloadJson: base.payload,
        baseCanonicalPayloadDigest: sha(base.payload),
        baseBodyDigest: sha(base.body),
        baseSourcePath: manifest.source.path,
        baseSourceCommit: environment.sourceCommit,
        baseSourceBlobOid: environment.sourceBlobOid,
        baseSourceContent: environment.headSource,
        baseSourceContentDigest: sha(environment.headSource),
      }
    : common;
  const commandPayloadDigest = input.legacy
    ? bootstrapDigest(ledgerInput as BootstrapLegacyPlanRevisionInput)
    : revisionDigest(common);
  return {
    commandId: manifest.command_id,
    commandPayloadDigest,
    replayBindingDigest: planRevisionReplayBindingDigest(manifest, admission),
    planId: manifest.plan_id,
    recordedAt: manifest.recorded_at,
    payload: { admission, ledgerInput, legacy: input.legacy },
    source: { path: manifest.source.path, content: manifest.source.content },
    projectionPath: manifest.projection.path,
  };
}

/** HEAD advance後もcaller input全体をdurable receiptへ照合できるdigest。 */
export function planRevisionReplayBindingDigest(
  manifest: PlanRevisionManifest,
  admission: PlanAdmissionRequest,
): `sha256:${string}` {
  return `sha256:${sha(stableJson({ manifest, admission }))}`;
}

export function canonicalPlanPayload(source: string): { payload: string; body: string } {
  const parsed = parseLegacyPlanSource(source);
  if (!parsed) throw new Error("plan-revision-source-invalid");
  return { payload: stableJson(parsed.frontmatter), body: parsed.body };
}

/** Journalより前にcommandのadmission・source・ledger digest結合を再検証する。 */
export function validatePlanRevisionCommand(
  command: PlanDraftCommand<PlanRevisionExecutionPayload>,
): void {
  const decision = evaluatePlanAdmission(command.payload.admission);
  if (!decision.ok) throw new Error("plan-revision-command-admission-invalid");
  const ledger = command.payload.ledgerInput;
  const bound = bindPlanSourceToAdmission({
    source: command.source.content,
    planId: command.planId,
    admission: command.payload.admission,
  });
  const current = canonicalPlanPayload(bound.source);
  if (
    ledger.commandId !== command.commandId ||
    ledger.planId !== command.planId ||
    ledger.sourcePath !== command.source.path ||
    ledger.canonicalPayloadJson !== current.payload ||
    ledger.contentDigest !== unprefix(bound.contentDigest) ||
    ledger.bodyDigest !== sha(current.body) ||
    ledger.routeTupleDigest !== sha(stableJson(command.payload.admission))
  )
    throw new Error("plan-revision-command-binding-invalid");
  const expected = command.payload.legacy
    ? bootstrapDigest(ledger as BootstrapLegacyPlanRevisionInput)
    : revisionDigest(ledger as AppendPlanRevisionInput);
  if (expected !== command.commandPayloadDigest)
    throw new Error("plan-revision-command-digest-invalid");
}

function revisionDigest(input: AppendPlanRevisionInput): string {
  const canonicalPayloadDigest = sha(input.canonicalPayloadJson);
  return sha(JSON.stringify({ ...input, canonicalPayloadDigest }));
}

function bootstrapDigest(input: BootstrapLegacyPlanRevisionInput): string {
  const { assetId: _ignored, ...withoutInherited } = input as BootstrapLegacyPlanRevisionInput & {
    assetId?: string;
  };
  const assetId = legacyAssetId(input.repositoryIdentity, input.planId);
  return sha(stableJson({ ...withoutInherited, assetId }));
}

function legacyAssetId(repositoryIdentity: string, planId: string): string {
  const hash = createHash("sha256");
  for (const value of ["ut-tdd-plan-legacy-v1", repositoryIdentity, planId]) {
    const bytes = Buffer.from(value);
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length).update(bytes);
  }
  return `plan:legacy:${hash.digest("hex")}`;
}

function unprefix(value: string): string {
  return value.startsWith("sha256:") ? value.slice(7) : value;
}

export function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
