import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalProjectIdentityBytes,
  loadTrackedProjectIdentity,
  type ProjectIdentityReceipt,
} from "../src/kernel/project-identity.ts";

const identity = "unison-ai-product/UT-TDD_AGENT-HARNESS";

function receipt(content: Uint8Array): ProjectIdentityReceipt {
  return {
    path: "ut-tdd.project.json",
    blobOid: createHash("sha1")
      .update(Buffer.from(`blob ${content.byteLength}\0`))
      .update(content)
      .digest("hex"),
    contentDigest: createHash("sha256").update(content).digest("hex"),
    sourceCommit: "a".repeat(40),
    objectFormat: "sha1",
  };
}

describe("shared project identity kernel receipt", () => {
  it("U-PA-008: accepts only an exact HEAD blob receipt", () => {
    const bytes = canonicalProjectIdentityBytes(identity);
    const loaded = loadTrackedProjectIdentity({ bytes, receipt: receipt(bytes) });
    expect(loaded).toMatchObject({
      ok: true,
      value: {
        repositoryIdentity: identity,
        schemaVersion: "ut-tdd.project/v1",
        provenance: {
          sourceCommit: "a".repeat(40),
          receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    });
  });

  const canonical = Buffer.from(canonicalProjectIdentityBytes(identity));
  const invalidCases = [
    {
      kind: "tampered",
      bytes: Buffer.concat([canonical, Buffer.from(" ")]),
      receipt: receipt(canonical),
      ruleId: "plan-repository-identity-provenance-invalid",
    },
    {
      kind: "untracked",
      bytes: canonical,
      receipt: { ...receipt(canonical), blobOid: "" },
      ruleId: "plan-repository-identity-provenance-invalid",
    },
    {
      kind: "schema",
      bytes: Buffer.from(canonical.toString("utf8").replace("ut-tdd.project/v1", "v2")),
      receipt: receipt(Buffer.from(canonical.toString("utf8").replace("ut-tdd.project/v1", "v2"))),
      ruleId: "plan-project-config-invalid",
    },
    {
      kind: "identity",
      bytes: Buffer.from(canonical.toString("utf8").replace("unison-ai-product/", "../")),
      receipt: receipt(
        Buffer.from(canonical.toString("utf8").replace("unison-ai-product/", "../")),
      ),
      ruleId: "plan-repository-identity-invalid",
    },
  ];
  it.each(invalidCases)("U-PA-008: fails closed for $kind project identity", ({
    bytes,
    receipt,
    ruleId,
  }) => {
    expect(loadTrackedProjectIdentity({ bytes, receipt })).toMatchObject({
      ok: false,
      error: { ruleId },
    });
  });
});
