import { createHash } from "node:crypto";

/**
 * PLAN draft を一意に表す、永続化前の canonical command。
 *
 * admission の判断層、asset ledger の永続化層、journal の再実行境界が共有する
 * 依存中立の契約である。digest 自体を入力に含めないことで、呼び出し側が
 * 自己申告した値を正本にできなくする。
 */
export interface CanonicalPlanDraftCommand {
  readonly commandId: string;
  readonly assetId: string;
  readonly planId: string;
  readonly alias: string;
  readonly sourcePath: string;
  readonly projectionPath: string;
  readonly sourceCommit: string;
  readonly actor: string;
  readonly reason: string;
  readonly canonicalPayloadJson: string;
  readonly bodyDigest: string;
  readonly identityAlgorithm: string;
  readonly reservationId: string;
  readonly namespace: string;
  readonly ordinal: number;
  readonly leaseTokenHash: string;
  readonly expiresAt: string;
  readonly routeTupleDigest: string;
  readonly certificateId: string;
  readonly occurredAt: string;
}

export interface PlanDraftCommandDigests {
  readonly canonicalPayloadDigest: string;
  readonly commandPayloadDigest: string;
  readonly certificateDigest: string;
}

/** DB receipt、durable journal、replay fence が共有する唯一のdigest計算境界。 */
export function calculatePlanDraftCommandDigests(
  command: CanonicalPlanDraftCommand,
): PlanDraftCommandDigests {
  const canonicalPayloadDigest = sha256(command.canonicalPayloadJson);
  const commandPayloadDigest = sha256(
    stableJson({
      commandId: command.commandId,
      assetId: command.assetId,
      planId: command.planId,
      alias: command.alias,
      sourcePath: command.sourcePath,
      projectionPath: command.projectionPath,
      sourceCommit: command.sourceCommit,
      actor: command.actor,
      reason: command.reason,
      canonicalPayloadJson: command.canonicalPayloadJson,
      bodyDigest: command.bodyDigest,
      identityAlgorithm: command.identityAlgorithm,
      reservationId: command.reservationId,
      namespace: command.namespace,
      ordinal: command.ordinal,
      leaseTokenHash: command.leaseTokenHash,
      expiresAt: command.expiresAt,
      routeTupleDigest: command.routeTupleDigest,
      certificateId: command.certificateId,
      occurredAt: command.occurredAt,
      canonicalPayloadDigest,
    }),
  );
  const certificateDigest = sha256(
    stableJson({
      commandPayloadDigest,
      assetId: command.assetId,
      revision: 1,
      planId: command.planId,
      sourcePath: command.sourcePath,
      contentDigest: canonicalPayloadDigest,
      routeTupleDigest: command.routeTupleDigest,
      certificateId: command.certificateId,
    }),
  );
  return Object.freeze({ canonicalPayloadDigest, commandPayloadDigest, certificateDigest });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
