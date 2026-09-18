import { createHash } from "node:crypto";
import { stringify } from "yaml";
import { parseLegacyPlanSource } from "../plan-asset/adapters/legacy-plan-inventory.ts";
import { frontmatterSchema } from "../schema/frontmatter.ts";
import { canonicalPlanContentDigest } from "./diff-fence.ts";
import { bindPlanSourceToAdmission } from "./plan-content-binding.ts";
import type {
  DraftArtifactRendererPort,
  DraftReceiptBinding,
  PlanDraftCommand,
} from "./plan-draft-service.ts";
import type { PlanAdmissionRequest } from "./policy.ts";
import { evaluatePlanAdmission } from "./policy.ts";
import {
  parseTrackedReceiptProjection,
  TRACKED_RECEIPT_SCHEMA,
  type TrackedReceiptRecord,
  trackedReceiptRecordDigest,
} from "./tracked-receipt-projection.ts";

export interface AdmissionBearingPayload {
  readonly admission: PlanAdmissionRequest;
}

/** Rendererが必要とする最小契約。assemblerの具象payloadへ逆依存しない。 */
export interface TrackedReceiptDraftPayload extends AdmissionBearingPayload {
  readonly canonical?: unknown;
}

export interface TrackedReceiptDraftReceipt extends DraftReceiptBinding {
  readonly certificateDigest: string;
}

export interface TrackedReceiptProjectionReader {
  read(path: string): string;
}

/**
 * 確定済みledger receiptからPLAN frontmatterとGit管理projectionを同時生成する。
 * projection本文はcommand payloadから受け取らず、既存の追跡対象をreader経由で取得する。
 */
export class TrackedReceiptRenderer<
  TPayload extends AdmissionBearingPayload = TrackedReceiptDraftPayload,
> implements DraftArtifactRendererPort<TPayload, TrackedReceiptDraftReceipt>
{
  private readonly projections: TrackedReceiptProjectionReader;

  constructor(projections: TrackedReceiptProjectionReader) {
    this.projections = projections;
  }

  render(
    command: PlanDraftCommand<TPayload>,
    receipt: TrackedReceiptDraftReceipt,
  ): readonly [
    source: { path: string; content: string },
    projection: { path: string; content: string },
  ] {
    rejectCallerProjection(command.payload);
    const decision = evaluatePlanAdmission(command.payload.admission);
    if (!decision.ok) throw new Error("tracked-receipt-admission-invalid");
    const parsedSource = parseLegacyPlanSource(command.source.content);
    if (!parsedSource || parsedSource.planId !== command.planId)
      throw new Error("tracked-receipt-source-invalid");

    const decisionDigest = digest(command.payload.admission);
    const admission = command.payload.admission;
    const bound = bindPlanSourceToAdmission({
      source: command.source.content,
      planId: command.planId,
      admission,
    });
    const parsedBound = parseLegacyPlanSource(bound.source);
    if (!parsedBound) throw new Error("tracked-receipt-source-invalid");
    const baseFrontmatter = parsedBound.frontmatter;
    const contentDigest = bound.contentDigest;
    const frontmatter = {
      ...baseFrontmatter,
      admission_receipt: receiptFrontmatter({
        command,
        receipt,
        contentDigest,
        decisionDigest,
      }),
    };
    const source = {
      path: command.source.path,
      content: `---\n${stringify(frontmatter)}---\n${parsedSource.body}`,
    };

    const current = parseTrackedReceiptProjection(this.projections.read(command.projectionPath));
    if (!current.ok)
      throw new Error(`tracked-receipt-projection-invalid:${current.errors.join(",")}`);
    const previous = current.value.records.at(-1);
    const recordWithoutDigest = {
      sequence: current.value.records.length + 1,
      previousRecordDigest: previous?.recordDigest ?? null,
      commandId: command.commandId,
      receiptId: receipt.certificateId,
      receiptDigest: prefixed(receipt.certificateDigest),
      decisionDigest,
      binding: {
        path: command.source.path,
        planId: command.planId,
        assetId: receipt.assetId,
        revision: receipt.revision,
        contentDigest,
      },
    } satisfies Omit<TrackedReceiptRecord, "recordDigest">;
    const record: TrackedReceiptRecord = {
      ...recordWithoutDigest,
      recordDigest: trackedReceiptRecordDigest(recordWithoutDigest),
    };
    const projection = {
      path: command.projectionPath,
      content: `${JSON.stringify(
        {
          schema_version: TRACKED_RECEIPT_SCHEMA,
          records: [...current.value.records, record].map(toJsonRecord),
        },
        null,
        2,
      )}\n`,
    };
    selfVerify({
      command,
      receipt,
      source: source.content,
      projection: projection.content,
      decisionDigest,
      contentDigest,
    });
    return [source, projection];
  }
}

function receiptFrontmatter(input: {
  command: PlanDraftCommand<AdmissionBearingPayload>;
  receipt: TrackedReceiptDraftReceipt;
  contentDigest: string;
  decisionDigest: string;
}): Record<string, unknown> {
  const { admission } = input.command.payload;
  return {
    schema_version: "v2",
    receipt_id: input.receipt.certificateId,
    command_id: input.command.commandId,
    admitted_at: input.command.recordedAt,
    source_digest: input.contentDigest,
    decision_digest: input.decisionDigest,
    receipt_digest: prefixed(input.receipt.certificateDigest),
    binding: {
      path: input.command.source.path,
      plan_id: input.command.planId,
      asset_id: input.receipt.assetId,
      revision: input.receipt.revision,
      content_digest: input.contentDigest,
    },
    route: { signal: admission.routeSignal, mode: admission.routeMode },
    ...(admission.issue
      ? {
          issue: {
            provider: admission.issue.provider,
            issue_id: admission.issue.issueId,
            episode_id: admission.issue.episodeId,
            projection_digest: admission.issue.projectionDigest,
          },
        }
      : {}),
    ...(admission.origin
      ? {
          origin: {
            plan_id: admission.origin.planId,
            revision: admission.origin.revision,
            digest: admission.origin.digest,
          },
        }
      : {}),
    ...(admission.transitionDirection || admission.implementationDisposition
      ? {
          transition: {
            direction: admission.transitionDirection,
            implementation_disposition: admission.implementationDisposition,
            ...(admission.implementationTarget
              ? {
                  implementation_target: {
                    target_plan_id: admission.implementationTarget.targetPlanId,
                    target_revision: admission.implementationTarget.targetRevision,
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(admission.reentry
      ? {
          reentry: {
            target_plan_id: admission.reentry.targetPlanId,
            target_revision: admission.reentry.targetRevision,
            phase: admission.reentry.phase,
          },
        }
      : {}),
    ...(admission.escapeReason ? { escape_reason: admission.escapeReason } : {}),
    ...(admission.supersedes ? { supersedes: [...admission.supersedes] } : {}),
  };
}

function toJsonRecord(record: TrackedReceiptRecord): Record<string, unknown> {
  return {
    sequence: record.sequence,
    previous_record_digest: record.previousRecordDigest,
    record_digest: record.recordDigest,
    command_id: record.commandId,
    receipt_id: record.receiptId,
    receipt_digest: record.receiptDigest,
    decision_digest: record.decisionDigest,
    binding: {
      path: record.binding.path,
      plan_id: record.binding.planId,
      asset_id: record.binding.assetId,
      revision: record.binding.revision,
      content_digest: record.binding.contentDigest,
    },
  };
}

function selfVerify(input: {
  command: PlanDraftCommand<AdmissionBearingPayload>;
  receipt: TrackedReceiptDraftReceipt;
  source: string;
  projection: string;
  decisionDigest: string;
  contentDigest: string;
}): void {
  const { command, receipt, source, projection, decisionDigest, contentDigest } = input;
  const parsedSource = parseLegacyPlanSource(source);
  const validated = frontmatterSchema.safeParse(parsedSource?.frontmatter);
  const parsedProjection = parseTrackedReceiptProjection(projection);
  const projected = parsedProjection.ok
    ? parsedProjection.value.lookup(command.commandId)
    : undefined;
  const embedded = validated.success ? validated.data.admission_receipt : undefined;
  if (
    !validated.success ||
    canonicalPlanContentDigest(source) !== contentDigest ||
    !parsedProjection.ok ||
    !embedded ||
    embedded.receipt_id !== receipt.certificateId ||
    embedded.decision_digest !== decisionDigest ||
    embedded.binding.content_digest !== contentDigest ||
    !projected ||
    projected.receiptId !== embedded.receipt_id ||
    projected.receiptDigest !== embedded.receipt_digest ||
    projected.decisionDigest !== embedded.decision_digest ||
    projected.binding.path !== embedded.binding.path ||
    projected.binding.planId !== embedded.binding.plan_id ||
    projected.binding.assetId !== embedded.binding.asset_id ||
    projected.binding.revision !== embedded.binding.revision ||
    projected.binding.contentDigest !== embedded.binding.content_digest
  )
    throw new Error(
      `tracked-receipt-self-verification-failed:${validated.success ? "binding" : validated.error.issues.map((issue) => issue.message).join(",")}`,
    );
}

function rejectCallerProjection(payload: AdmissionBearingPayload): void {
  if (Object.keys(payload).some((key) => key.toLowerCase().includes("projection")))
    throw new Error("tracked-receipt-caller-projection-forbidden");
}

function prefixed(value: string): string {
  return value.startsWith("sha256:") ? value : `sha256:${value}`;
}

function digest(value: unknown): string {
  return prefixed(createHash("sha256").update(stableJson(value)).digest("hex"));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
