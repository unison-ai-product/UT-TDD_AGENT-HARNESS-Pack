import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type AuthoringReceipt,
  gitBlobOid,
  verifyAuthoringProvenance,
} from "../../src/disposition/domain/authoring-provenance.ts";

const bytes = new TextEncoder().encode("authored\n");
const commit = "a".repeat(40);

function receipt(path = "docs/source.md", content = bytes): AuthoringReceipt {
  return {
    path,
    blobOid: gitBlobOid(content),
    contentDigest: createHash("sha256").update(content).digest("hex"),
    sourceCommit: commit,
  };
}

describe("authoring provenance receipt", () => {
  it("accepts an exact tracked blob receipt deterministically", () => {
    const first = verifyAuthoringProvenance({ "docs/source.md": bytes }, [receipt()]);
    const second = verifyAuthoringProvenance({ "docs/source.md": bytes }, [receipt()]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ok: true,
      receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it.each([
    "tampered",
    "missing",
    "extra",
    "invalid-commit",
    "duplicate",
  ])("fails closed for %s provenance", (kind) => {
    const bundle: Record<string, Uint8Array> = { "docs/source.md": bytes };
    let receipts = [receipt()];
    if (kind === "tampered") bundle["docs/source.md"] = new TextEncoder().encode("changed\n");
    if (kind === "missing") receipts = [];
    if (kind === "extra") receipts.push(receipt("docs/extra.md"));
    if (kind === "invalid-commit") receipts = [{ ...receipt(), sourceCommit: "working-tree" }];
    if (kind === "duplicate") receipts.push(receipt());
    expect(verifyAuthoringProvenance(bundle, receipts)).toMatchObject({
      ok: false,
      findings: [{ ruleId: "catalog-provenance-invalid" }],
    });
  });
});
