import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  loadProjectIdentityFromHead,
  loadTrackedProjectIdentity,
  type ProjectIdentityReceipt,
} from "../../src/plan-asset/adapters/project-identity-loader.ts";

const path = "ut-tdd.project.json";
const commit = "a".repeat(40);
const text = `${JSON.stringify({
  schema_version: "ut-tdd.project/v1",
  repository_identity: "unison-ai-product/UT-TDD_AGENT-HARNESS",
})}\n`;

describe("tracked project identity", () => {
  it("U-PA-008: accepts only an exact HEAD blob receipt", () => {
    const loaded = loadTrackedProjectIdentity({ bytes: Buffer.from(text), receipt: receipt(text) });
    expect(loaded).toMatchObject({
      ok: true,
      value: {
        repositoryIdentity: "unison-ai-product/UT-TDD_AGENT-HARNESS",
        schemaVersion: "ut-tdd.project/v1",
        provenance: {
          sourceCommit: commit,
          receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    });
  });

  it.each([
    [
      "tampered",
      Buffer.from(`${text} `),
      receipt(text),
      "plan-repository-identity-provenance-invalid",
    ],
    [
      "untracked",
      Buffer.from(text),
      { ...receipt(text), blobOid: "" },
      "plan-repository-identity-provenance-invalid",
    ],
    [
      "schema",
      Buffer.from(text.replace("ut-tdd.project/v1", "v2")),
      receipt(text.replace("ut-tdd.project/v1", "v2")),
      "plan-project-config-invalid",
    ],
    [
      "identity",
      Buffer.from(text.replace("unison-ai-product/", "../")),
      receipt(text.replace("unison-ai-product/", "../")),
      "plan-repository-identity-invalid",
    ],
  ])("U-PA-008: fails closed for %s project identity", (_kind, bytes, provenance, ruleId) => {
    const loaded = loadTrackedProjectIdentity({ bytes, receipt: provenance });
    expect(loaded).toMatchObject({
      ok: false,
      error: { ruleId },
    });
  });

  it("U-PA-008: reads the real identity from the tracked HEAD blob", () => {
    expect(loadProjectIdentityFromHead({ repoRoot: process.cwd() })).toMatchObject({
      ok: true,
      value: { repositoryIdentity: "unison-ai-product/UT-TDD_AGENT-HARNESS" },
    });
  });
});

function receipt(content: string): ProjectIdentityReceipt {
  const bytes = Buffer.from(content);
  return {
    path,
    blobOid: createHash("sha1")
      .update(Buffer.from(`blob ${bytes.byteLength}\0`))
      .update(bytes)
      .digest("hex"),
    contentDigest: createHash("sha256").update(bytes).digest("hex"),
    sourceCommit: commit,
    objectFormat: "sha1",
  };
}
