import { z } from "zod";

/** The only revision representation accepted by the slice graph. */
export const gitObjectIdSchema = z
  .union([
    z.string().regex(/^git-sha1:[0-9a-f]{40}$/),
    z.string().regex(/^git-sha256:[0-9a-f]{64}$/),
  ])
  .describe("GitObjectId");

export const sliceIdSchema = z.enum(["d0", "f0a", "f0b", "f0c", "q0"]);
export const sliceDecisionSchema = z.enum(["approved", "rejected"]);
export const sliceProducerSchema = z.enum([
  "d0-design-owner",
  "f0a-toolchain-owner",
  "f0b-sealed-build-owner",
  "f0c-ci-owner",
  "q0-qualification-owner",
]);
export const receiptDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Core receipt.  The self digest is deliberately present as a field but is
 * excluded from the seven-field preimage (see `sliceAdmissionPreimage`).
 */
export const sliceAdmissionReceiptSchema = z
  .object({
    schema_version: z.literal("node-slice-admission.v1"),
    slice_id: sliceIdSchema,
    predecessor_receipt_digest: receiptDigestSchema.nullable(),
    subject_revision: gitObjectIdSchema,
    required_input_receipt_digests: z.array(receiptDigestSchema).superRefine((values, ctx) => {
      if (new Set(values).size !== values.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate-required-input" });
      }
    }),
    decision: sliceDecisionSchema,
    producer: sliceProducerSchema,
    receipt_digest: receiptDigestSchema,
  })
  .strict();

export type GitObjectId = z.infer<typeof gitObjectIdSchema>;
export type SliceId = z.infer<typeof sliceIdSchema>;
export type SliceDecision = z.infer<typeof sliceDecisionSchema>;
export type SliceProducer = z.infer<typeof sliceProducerSchema>;
export type SliceAdmissionReceipt = z.infer<typeof sliceAdmissionReceiptSchema>;

export const sliceAdmissionEnvelopeSchema = z
  .object({
    schema_version: z.literal("attested-receipt-envelope.v1"),
    record: sliceAdmissionReceiptSchema,
    producer: sliceProducerSchema,
    record_digest: receiptDigestSchema,
    attestation: z
      .object({
        schemaVersion: z.literal("evidence-attestation/v1"),
        algorithm: z.literal("hmac-sha256"),
        authorityId: z.string().min(1),
        keyVersion: z.string().min(1),
        signature: z.string().min(1),
      })
      .strict(),
    receipt_digest: receiptDigestSchema,
  })
  .strict();

export type SliceAdmissionEnvelope = z.infer<typeof sliceAdmissionEnvelopeSchema>;

export const NODE_SLICE_INPUT_REGISTRY = Object.freeze({
  d0: { predecessor: null, requiredKinds: ["ReviewBundleReceipt", "AttestedTrackedReceiptRecord"] },
  f0a: { predecessor: "d0", requiredKinds: ["f0a.static-custody"] },
  f0b: { predecessor: "f0a", requiredKinds: ["f0b.sealed-generation"] },
  f0c: { predecessor: "f0b", requiredKinds: ["f0c.os-jobs"] },
  q0: { predecessor: "f0c", requiredKinds: ["q0.authoring", "q0.runtime-no-fallback"] },
} as const);

export function sliceAdmissionPreimage(
  receipt: Omit<SliceAdmissionReceipt, "receipt_digest">,
): string {
  return JSON.stringify([
    receipt.schema_version,
    receipt.slice_id,
    receipt.predecessor_receipt_digest,
    receipt.subject_revision,
    receipt.required_input_receipt_digests,
    receipt.decision,
    receipt.producer,
  ]);
}
