import { canonicalField, sha256 } from "./canonical-frame.ts";

export interface DocumentMemberIdentity {
  readonly path: string;
  readonly blobOid: string;
  readonly contentDigest: string;
}

interface DocumentDeltaBase {
  readonly ledgerId: string;
  readonly fromSnapshotDigest: string;
  readonly toSnapshotDigest: string;
  readonly decisionDigest: string;
  readonly previousEventDigest: string | null;
  readonly eventDigest: string;
}

export type DocumentDeltaPayload =
  | {
      readonly deltaId: string;
      readonly sequence: number;
      readonly kind: "add";
      readonly after: DocumentMemberIdentity;
    }
  | {
      readonly deltaId: string;
      readonly sequence: number;
      readonly kind: "modify" | "rename";
      readonly before: DocumentMemberIdentity;
      readonly after: DocumentMemberIdentity;
    }
  | {
      readonly deltaId: string;
      readonly sequence: number;
      readonly kind: "delete";
      readonly before: DocumentMemberIdentity;
    };

export type DocumentDeltaDraft = DocumentDeltaPayload extends infer Delta
  ? Delta extends DocumentDeltaPayload
    ? Delta & Omit<DocumentDeltaBase, "eventDigest">
    : never
  : never;

export type DocumentDelta = DocumentDeltaDraft & { readonly eventDigest: string };

export const beforeOf = (delta: DocumentDelta): DocumentMemberIdentity | undefined =>
  delta.kind === "add" ? undefined : delta.before;

export const afterOf = (delta: DocumentDelta): DocumentMemberIdentity | undefined =>
  delta.kind === "delete" ? undefined : delta.after;

export function validDocumentMemberPath(path: string): boolean {
  if (
    path.length === 0 ||
    path !== path.normalize("NFC") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/")
  ) {
    return false;
  }
  const segments = path.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export function validDocumentMemberIdentity(
  member: DocumentMemberIdentity | undefined,
): member is DocumentMemberIdentity {
  return Boolean(
    member &&
      validDocumentMemberPath(member.path) &&
      member.blobOid.trim().length > 0 &&
      member.contentDigest.trim().length > 0,
  );
}

function assertMember(member: DocumentMemberIdentity | undefined): void {
  if (!validDocumentMemberIdentity(member)) {
    throw new TypeError("document-delta-member-invalid");
  }
}

function assertDeltaDraft(delta: DocumentDeltaDraft): void {
  if (
    !Number.isSafeInteger(delta.sequence) ||
    delta.sequence < 1 ||
    delta.deltaId.trim().length === 0 ||
    delta.ledgerId.trim().length === 0 ||
    delta.fromSnapshotDigest.trim().length === 0 ||
    delta.toSnapshotDigest.trim().length === 0 ||
    delta.decisionDigest.trim().length === 0
  ) {
    throw new TypeError("document-delta-identity-invalid");
  }
  if (delta.kind !== "add") assertMember(delta.before);
  if (delta.kind !== "delete") assertMember(delta.after);
}

function eventFrame(delta: DocumentDeltaDraft): readonly Uint8Array[] {
  const before = delta.kind === "add" ? undefined : delta.before;
  const after = delta.kind === "delete" ? undefined : delta.after;
  return [
    canonicalField("delta_id", delta.deltaId),
    canonicalField("ledger_id", delta.ledgerId),
    canonicalField("sequence", String(delta.sequence)),
    canonicalField("kind", delta.kind),
    canonicalField("from_snapshot_digest", delta.fromSnapshotDigest),
    canonicalField("to_snapshot_digest", delta.toSnapshotDigest),
    canonicalField("from_path", before?.path ?? ""),
    canonicalField("to_path", after?.path ?? ""),
    canonicalField("before_blob_oid", before?.blobOid ?? ""),
    canonicalField("before_content_digest", before?.contentDigest ?? ""),
    canonicalField("after_blob_oid", after?.blobOid ?? ""),
    canonicalField("after_content_digest", after?.contentDigest ?? ""),
    canonicalField("decision_digest", delta.decisionDigest),
    canonicalField("previous_event_digest", delta.previousEventDigest ?? ""),
  ];
}

export const documentDeltaEventDigest = (delta: DocumentDeltaDraft): string =>
  sha256(eventFrame(delta));

export function createDocumentDeltaEvent(delta: DocumentDeltaDraft): DocumentDelta {
  assertDeltaDraft(delta);
  return { ...delta, eventDigest: documentDeltaEventDigest(delta) } as DocumentDelta;
}

export function documentDeltaChainDigest(input: {
  readonly ledgerId: string;
  readonly baselineSnapshotDigest: string;
  readonly policyRevision: string;
  readonly deltas: readonly DocumentDelta[];
}): string {
  let digest = sha256([
    canonicalField("ledger_id", input.ledgerId),
    canonicalField("baseline_snapshot_digest", input.baselineSnapshotDigest),
    canonicalField("policy_revision", input.policyRevision),
  ]);
  for (const delta of [...input.deltas].sort(
    (left, right) =>
      left.sequence - right.sequence ||
      (left.eventDigest < right.eventDigest ? -1 : left.eventDigest > right.eventDigest ? 1 : 0),
  )) {
    digest = sha256([
      canonicalField("previous_chain_digest", digest),
      canonicalField("event_digest", delta.eventDigest),
    ]);
  }
  return digest;
}
