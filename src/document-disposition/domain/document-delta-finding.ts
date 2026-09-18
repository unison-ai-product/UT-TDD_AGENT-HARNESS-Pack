import { canonicalField, sha256 } from "./canonical-frame.ts";
import type { DocumentDelta, DocumentMemberIdentity } from "./document-delta.ts";
import { compareUtf8 } from "./document-delta-reducer.ts";

export interface DocumentDeltaFinding {
  readonly findingId: string;
  readonly ruleId: "doc-delta-unregistered";
  readonly kind: DocumentDelta["kind"] | "chain";
  readonly subjectIdentity: string;
  readonly reasonCode: string;
  readonly sequence: number;
  readonly evidenceDigest: string;
}

export interface DocumentDeltaFindingContext {
  readonly baselineSnapshotDigest: string;
  readonly finalSnapshotDigest: string;
  readonly expectedDeltaChainDigest: string;
  readonly policyRevision: string;
}

export function createDocumentDeltaFinding(args: {
  readonly context: DocumentDeltaFindingContext;
  readonly kind: DocumentDeltaFinding["kind"];
  readonly subjectIdentity: string;
  readonly reasonCode: string;
  readonly sequence?: number;
  readonly before?: DocumentMemberIdentity;
  readonly after?: DocumentMemberIdentity;
}): DocumentDeltaFinding {
  const { context, kind, subjectIdentity, reasonCode, sequence = 0, before, after } = args;
  const evidenceDigest = sha256([
    canonicalField("baseline_snapshot_digest", context.baselineSnapshotDigest),
    canonicalField("final_snapshot_digest", context.finalSnapshotDigest),
    canonicalField("delta_chain_digest", context.expectedDeltaChainDigest),
    canonicalField("reason_code", reasonCode),
    canonicalField("sequence", String(sequence)),
    canonicalField("operation_kind", kind),
    canonicalField("from_path", before?.path ?? ""),
    canonicalField("to_path", after?.path ?? ""),
    canonicalField("before_blob_oid", before?.blobOid ?? ""),
    canonicalField("before_content_digest", before?.contentDigest ?? ""),
    canonicalField("after_blob_oid", after?.blobOid ?? ""),
    canonicalField("after_content_digest", after?.contentDigest ?? ""),
    canonicalField("policy_revision", context.policyRevision),
  ]);
  const findingId = `document-delta-finding:sha256:${sha256([
    canonicalField("rule_id", "doc-delta-unregistered"),
    canonicalField("subject_identity", subjectIdentity),
    canonicalField("evidence_digest", evidenceDigest),
  ])}`;
  return {
    findingId,
    ruleId: "doc-delta-unregistered",
    kind,
    subjectIdentity,
    reasonCode,
    sequence,
    evidenceDigest,
  };
}

export function stableDocumentDeltaFindings(
  findings: DocumentDeltaFinding[],
): DocumentDeltaFinding[] {
  return findings.sort(
    (left, right) =>
      compareUtf8(left.kind, right.kind) ||
      compareUtf8(left.subjectIdentity, right.subjectIdentity) ||
      left.sequence - right.sequence ||
      compareUtf8(left.findingId, right.findingId),
  );
}
