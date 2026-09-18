import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gitBlobOid } from "../../src/disposition/domain/authoring-provenance.ts";
import {
  loadTrackedDocumentProfileCatalog,
  type ProfileAuthoringBundle,
} from "../../src/profile/adapters/tracked-profile-loader.ts";

const profilePath = "docs/governance/vmodel-document-scale-profiles.md";
const catalogPath = "docs/governance/vmodel-document-catalog.md";

function trackedBundle(): ProfileAuthoringBundle {
  return {
    [profilePath]: readFileSync(profilePath),
    [catalogPath]: readFileSync(catalogPath),
  };
}

function receipts(bundle: ProfileAuthoringBundle) {
  return Object.entries(bundle).map(([path, bytes]) => ({
    path,
    blobOid: gitBlobOid(bytes),
    contentDigest: createHash("sha256").update(bytes).digest("hex"),
    sourceCommit: "a".repeat(40),
  }));
}

describe("tracked document profile loader", () => {
  it("U-PROFILE-001: loads the declared 3 size and 5 product profiles losslessly", () => {
    const bundle = trackedBundle();
    const result = loadTrackedDocumentProfileCatalog(bundle, receipts(bundle));
    expect(result.sourcePath).toBe(profilePath);
    expect(result.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.catalog.profiles).toHaveLength(8);
    expect(
      result.catalog.profiles.filter((profile) => profile.profileAxis === "size"),
    ).toHaveLength(3);
    expect(
      result.catalog.profiles.filter((profile) => profile.profileAxis === "product"),
    ).toHaveLength(5);
    expect(result.catalog.decisions).toHaveLength(26);
    expect(
      result.catalog.profiles.find((profile) => profile.profileId === "enterprise"),
    ).toMatchObject({
      profileAxis: "size",
      profileRank: 30,
      description:
        "監査・保守・拡張前提。core と選択product文書を詳細化し、deferをPLANへ接続する。",
      defaultStatus: "required",
      defaultDetail: "detailed",
      scopePolicy: "audit-ready",
    });
    expect(
      result.catalog.profiles.every((profile) => /^[a-f0-9]{64}$/.test(profile.rowDigest)),
    ).toBe(true);
    expect(
      result.catalog.decisions.every((decision) => /^[a-f0-9]{64}$/.test(decision.rowDigest)),
    ).toBe(true);
    expect(result.catalog.knownDocTypeIds).toContain("DOC-L4-SECURITY");
    expect(result.catalog.coreDocTypeIds).toContain("DOC-L4-SECURITY");
  });

  it("rejects a decision whose doc type has no catalog master", () => {
    const bundle = trackedBundle();
    bundle[profilePath] = Buffer.from(
      bundle[profilePath].toString().replace("`DOC-L4-DATA`", "`DOC-UNKNOWN`"),
    );
    expect(() => loadTrackedDocumentProfileCatalog(bundle, receipts(bundle))).toThrow(
      /profile-unknown/,
    );
  });

  it("fails closed on malformed tracked authoring", () => {
    const bundle = trackedBundle();
    bundle[profilePath] = Buffer.from(
      bundle[profilePath].toString().replace("| `profile_id` |", "| `unknown` |"),
    );
    expect(() => loadTrackedDocumentProfileCatalog(bundle, receipts(bundle))).toThrow(
      /catalog-authoring-schema-invalid/,
    );
  });

  it("derives profile and decision counts from the tracked manifest", () => {
    const bundle = trackedBundle();
    bundle[profilePath] = Buffer.from(
      bundle[profilePath]
        .toString()
        .replace("| `profile_count` | `8` |", "| `profile_count` | `7` |"),
    );
    expect(() => loadTrackedDocumentProfileCatalog(bundle, receipts(bundle))).toThrow(
      /catalog-authoring-count-invalid/,
    );
  });
});
