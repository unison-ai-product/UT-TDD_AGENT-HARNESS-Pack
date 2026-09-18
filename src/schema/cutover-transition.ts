import { z } from "zod";
import { gitObjectIdSchema, receiptDigestSchema } from "./node-slice-admission.ts";

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Cutover receipt preimageをRFC 8785のUTF-16 code-unit順へ固定する。 */
export function canonicalizeCutoverValue(value: unknown): string | null {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isSafeInteger(value) ? String(value) : null;
  if (Array.isArray(value)) {
    const parts = value.map(canonicalizeCutoverValue);
    return parts.some((part) => part === null) ? null : `[${parts.join(",")}]`;
  }
  if (typeof value !== "object" || value === undefined) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort(compareCodeUnits)) {
    const encoded = canonicalizeCutoverValue(record[key]);
    if (encoded === null) return null;
    parts.push(`${JSON.stringify(key)}:${encoded}`);
  }
  return `{${parts.join(",")}}`;
}

export const CUTOVER_REGISTRY_ID = "CUTOVER-EVIDENCE-REGISTRY-v1" as const;

export const cutoverEdgeIdSchema = z.enum([
  "cutover.genesis",
  "cutover.inventory-frozen.node-shadow",
  "cutover.node-shadow.node-primary",
  "cutover.node-primary.bun-removed",
  "cutover.bun-removed.sealed",
]);

export const implementedCutoverEdgeIdSchema = z.enum([
  "cutover.genesis",
  "cutover.inventory-frozen.node-shadow",
  "cutover.node-shadow.node-primary",
  "cutover.node-primary.bun-removed",
]);

export const cutoverStateSchema = z.enum([
  "inventory_frozen",
  "node_shadow",
  "node_primary",
  "bun_removed",
  "sealed",
]);

export const cutoverExecutionModeSchema = z.enum([
  "hybrid",
  "codex-only",
  "claude-only",
  "standalone",
]);

export const contentDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const evidenceAttestationSchema = z
  .object({
    schemaVersion: z.literal("evidence-attestation/v1"),
    algorithm: z.literal("hmac-sha256"),
    authorityId: z.string().min(1),
    keyVersion: z.string().min(1),
    signature: z.string().min(1),
  })
  .strict();

export const CUTOVER_ADMISSION_PRODUCER_MAP = Object.freeze({
  "cutover.genesis": {
    producerOwnerId: "cutover-genesis-authority",
    attestationProducer: "ci",
    authorityId: "ut-tdd-cutover-genesis",
    keyVersion: "v1",
  },
  "cutover.inventory-frozen.node-shadow": {
    producerOwnerId: "cutover-shadow-authority",
    attestationProducer: "ci",
    authorityId: "ut-tdd-cutover-shadow",
    keyVersion: "v1",
  },
  "cutover.node-shadow.node-primary": {
    producerOwnerId: "cutover-primary-authority",
    attestationProducer: "ci",
    authorityId: "ut-tdd-cutover-primary",
    keyVersion: "v1",
  },
  "cutover.node-primary.bun-removed": {
    producerOwnerId: "cutover-removal-authority",
    attestationProducer: "ci",
    authorityId: "ut-tdd-cutover-removal",
    keyVersion: "v1",
  },
  "cutover.bun-removed.sealed": {
    producerOwnerId: "cutover-seal-authority",
    attestationProducer: "ci",
    authorityId: "ut-tdd-cutover-seal",
    keyVersion: "v1",
  },
} as const);

export const CUTOVER_EVIDENCE_REGISTRY = Object.freeze({
  "cutover.genesis": [
    ["inventory.freeze", "inventory-freezer", "candidate-head"],
    ["review.bundle", "review-bundle-gate", "candidate-head"],
    ["admission.approved", "admission-gate", "candidate-head"],
    ["design.l6-confirmed", "l6-confirmation-gate", "candidate-head"],
  ],
  "cutover.inventory-frozen.node-shadow": [
    ["f0a.static-custody", "f0a-gate", "producer-ancestor"],
    ["f0b.sealed-generation", "f0b-gate", "producer-ancestor"],
    ["f0c.os-jobs", "f0c-gate", "producer-ancestor"],
    ["review.bundle", "review-bundle-gate", "candidate-head"],
    ["admission.approved", "admission-gate", "candidate-head"],
  ],
  "cutover.node-shadow.node-primary": [
    ["q0.authoring", "q0-authoring", "candidate-head"],
    ["q0.runtime-no-fallback", "q0-runtime", "candidate-head"],
    ["review.bundle", "review-bundle-gate", "candidate-head"],
    ["admission.approved", "admission-gate", "candidate-head"],
  ],
  "cutover.node-primary.bun-removed": [
    ["inventory.zero", "ban-audit", "candidate-head"],
    ["pack.acceptance", "pack-gate", "candidate-head"],
    ["review.bundle", "review-bundle-gate", "candidate-head"],
    ["admission.approved", "admission-gate", "candidate-head"],
  ],
  "cutover.bun-removed.sealed": [
    ["debt.plan-recovery-16.repaired", "plan-recovery-16-gate", "candidate-head"],
    ["debt.plan-l7-452.repaired", "plan-l7-452-gate", "candidate-head"],
    ["issue.153-closed", "github-evidence", "candidate-head"],
    ["aggregate.success", "aggregate-gate", "candidate-head"],
    ["review.bundle", "review-bundle-gate", "candidate-head"],
    ["admission.approved", "admission-gate", "candidate-head"],
  ],
} as const);

export const cutoverAdmissionReceiptSchema = z
  .object({
    schema_version: z.literal("cutover-admission.v1"),
    edge_id: cutoverEdgeIdSchema,
    candidate_head: gitObjectIdSchema,
    artifact_digest: contentDigestSchema,
    prior_validated_receipt_digest: receiptDigestSchema,
    l6_confirmation_receipt_digest: receiptDigestSchema,
    execution_mode: cutoverExecutionModeSchema,
    decision: z.enum(["approved", "rejected"]),
    producer_owner_id: z.string().min(1),
    attestation_producer: z.literal("ci"),
    authority_id: z.string().min(1),
    record_digest: receiptDigestSchema,
    attestation: evidenceAttestationSchema,
    receipt_digest: receiptDigestSchema,
  })
  .strict();

export const cutoverEvidenceKindSchema = z.enum([
  "inventory.freeze",
  "review.bundle",
  "admission.approved",
  "design.l6-confirmed",
  "f0a.static-custody",
  "f0b.sealed-generation",
  "f0c.os-jobs",
  "q0.authoring",
  "q0.runtime-no-fallback",
  "inventory.zero",
  "pack.acceptance",
  "debt.plan-recovery-16.repaired",
  "debt.plan-l7-452.repaired",
  "issue.153-closed",
  "aggregate.success",
]);

export const sliceEvidenceReceiptSchema = z
  .object({
    schema_version: z.literal("cutover-evidence.v1"),
    edge_id: cutoverEdgeIdSchema,
    kind_id: cutoverEvidenceKindSchema,
    producer_owner_id: z.string().min(1),
    attestation_producer: z.literal("ci"),
    subject_revision: gitObjectIdSchema,
    success: z.boolean(),
    reference_kind: z.enum(["review-bundle", "cutover-admission", "payload-object"]),
    referenced_receipt_digest: receiptDigestSchema.nullable(),
    payload_object_receipt_digest: receiptDigestSchema.nullable(),
    payload_digest: contentDigestSchema.nullable(),
    record_digest: receiptDigestSchema,
    attestation: evidenceAttestationSchema,
    receipt_digest: receiptDigestSchema,
  })
  .strict();

export const cutoverTransitionReceiptSchema = z
  .object({
    schema_version: z.literal("cutover-transition.v1"),
    registry_id: z.literal(CUTOVER_REGISTRY_ID),
    transition_id: implementedCutoverEdgeIdSchema,
    sequence: z.number().int().nonnegative().safe(),
    subject_revision: gitObjectIdSchema,
    previous_state: cutoverStateSchema.nullable(),
    current_state: cutoverStateSchema,
    evidence_set_digest: receiptDigestSchema,
    review_digest: receiptDigestSchema,
    admission_digest: receiptDigestSchema,
    previous_receipt_digest: receiptDigestSchema.nullable(),
    receipt_digest: receiptDigestSchema,
  })
  .strict();

export type CutoverEdgeId = z.infer<typeof cutoverEdgeIdSchema>;
export type ImplementedCutoverEdgeId = z.infer<typeof implementedCutoverEdgeIdSchema>;
export type CutoverState = z.infer<typeof cutoverStateSchema>;
export type CutoverExecutionMode = z.infer<typeof cutoverExecutionModeSchema>;
export type CutoverAdmissionReceipt = z.infer<typeof cutoverAdmissionReceiptSchema>;
export type SliceEvidenceReceipt = z.infer<typeof sliceEvidenceReceiptSchema>;
export type CutoverTransitionReceipt = z.infer<typeof cutoverTransitionReceiptSchema>;
