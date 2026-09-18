import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GitAuthoringProvenance } from "../../src/disposition/adapters/git-authoring-provenance.ts";
import { verifyAuthoringProvenance } from "../../src/disposition/domain/authoring-provenance.ts";

describe("Git authoring provenance adapter", () => {
  it("binds tracked working bytes to the Git index blob and HEAD", async () => {
    const path = "docs/governance/vmodel-source-manifest.md";
    const receipts = await new GitAuthoringProvenance(process.cwd()).receipts([path]);
    expect(verifyAuthoringProvenance({ [path]: readFileSync(path) }, receipts)).toMatchObject({
      ok: true,
    });
  });

  it("rejects an untracked authoring path", () => {
    expect(() =>
      new GitAuthoringProvenance(process.cwd()).receipts(["docs/not-tracked-authoring.md"]),
    ).toThrow("catalog-provenance-invalid");
  });
});
