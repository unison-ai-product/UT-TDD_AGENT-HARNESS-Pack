import { createHash } from "node:crypto";

export interface AuthoringReceipt {
  readonly path: string;
  readonly blobOid: string;
  readonly contentDigest: string;
  readonly sourceCommit: string;
}

export type ProvenanceFinding = {
  readonly ruleId: "catalog-provenance-invalid";
  readonly subjectId: string;
  readonly message: string;
};

export type ProvenanceResult =
  | { readonly ok: true; readonly receiptDigest: string }
  | { readonly ok: false; readonly findings: readonly ProvenanceFinding[] };

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function gitBlobOid(bytes: Uint8Array): string {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

export function verifyAuthoringProvenance(
  bundle: Readonly<Record<string, Uint8Array>>,
  receipts: readonly AuthoringReceipt[],
): ProvenanceResult {
  const findings: ProvenanceFinding[] = [];
  const receiptByPath = new Map<string, AuthoringReceipt>();
  for (const receipt of receipts) {
    if (receiptByPath.has(receipt.path)) findings.push(finding(receipt.path, "duplicate receipt"));
    receiptByPath.set(receipt.path, receipt);
  }
  const paths = [...new Set([...Object.keys(bundle), ...receiptByPath.keys()])].sort(compareBytes);
  for (const path of paths) {
    const bytes = bundle[path];
    const receipt = receiptByPath.get(path);
    if (!bytes || !receipt) {
      findings.push(finding(path, "bundle/receipt path set mismatch"));
      continue;
    }
    if (
      !/^[a-f0-9]{40}$/.test(receipt.blobOid) ||
      !/^[a-f0-9]{40}$/.test(receipt.sourceCommit) ||
      receipt.blobOid !== gitBlobOid(bytes) ||
      receipt.contentDigest !== sha256(bytes)
    ) {
      findings.push(finding(path, "blob/content/commit provenance mismatch"));
    }
  }
  if (findings.length > 0) {
    return {
      ok: false,
      findings: Object.freeze(findings.sort((a, b) => compareBytes(a.subjectId, b.subjectId))),
    };
  }
  return {
    ok: true,
    receiptDigest: createHash("sha256")
      .update(JSON.stringify([...receipts].sort((a, b) => compareBytes(a.path, b.path))))
      .digest("hex"),
  };
}

function finding(subjectId: string, message: string): ProvenanceFinding {
  return Object.freeze({ ruleId: "catalog-provenance-invalid", subjectId, message });
}

function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
