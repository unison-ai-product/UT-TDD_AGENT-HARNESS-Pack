import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createProfileCatalog,
  type DocumentProfile,
  type DocumentProfileDecision,
  resolveDocumentProfile,
} from "../../src/profile/domain/resolver.ts";

const profiles: DocumentProfile[] = [
  {
    profileId: "standard",
    profileAxis: "size",
    profileRank: 20,
    description: "standard",
    defaultStatus: "standard",
    defaultDetail: "standard",
    scopePolicy: "core-plus-selected",
    rowDigest: digest("profile-standard"),
  },
  {
    profileId: "web",
    profileAxis: "product",
    profileRank: 110,
    description: "web",
    defaultStatus: "profile_controlled",
    defaultDetail: "standard",
    scopePolicy: "product-web",
    rowDigest: digest("profile-web"),
  },
  {
    profileId: "mobile",
    profileAxis: "product",
    profileRank: 120,
    description: "mobile",
    defaultStatus: "profile_controlled",
    defaultDetail: "standard",
    scopePolicy: "product-mobile",
    rowDigest: digest("profile-mobile"),
  },
];

const decisions: DocumentProfileDecision[] = [
  decision("standard-data", "standard", "DOC-L4-DATA", "adopt", "standard", "required"),
  decision("standard-security", "standard", "DOC-L4-SECURITY", "adopt", "standard", "required"),
  decision("web-data", "web", "DOC-L4-DATA", "adopt", "detailed", "required"),
  decision("mobile-data", "mobile", "DOC-L4-DATA", "adopt", "standard", "required"),
];

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function decision(
  decisionId: string,
  profileId: string,
  docTypeId: string,
  value: DocumentProfileDecision["decision"],
  detailOverride: DocumentProfileDecision["detailOverride"],
  statusOverride: DocumentProfileDecision["statusOverride"],
): DocumentProfileDecision {
  return {
    decisionId,
    profileId,
    docTypeId,
    decision: value,
    detailOverride,
    statusOverride,
    reason: `${decisionId} reason`,
    rowDigest: digest(`${decisionId} digest`),
  };
}

describe("document profile resolver", () => {
  it("U-PROFILE-002: repeated resolution preserves decisions and digest independent of product order", () => {
    const catalog = createProfileCatalog({
      profiles,
      decisions,
      knownDocTypeIds: ["DOC-L4-DATA", "DOC-L4-SECURITY"],
      requiredDocTypeIds: ["DOC-L4-DATA", "DOC-L4-SECURITY"],
      coreDocTypeIds: ["DOC-L4-DATA", "DOC-L4-SECURITY"],
    });
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;

    const explicitDecisions = [
      decision("explicit-data-detail", "standard", "DOC-L4-DATA", "adopt", "detailed", "required"),
    ];

    const first = resolveDocumentProfile(catalog.value, {
      sizeProfileId: "standard",
      productProfileIds: ["web", "mobile"],
      explicitDecisions,
      capabilityFlags: [],
    });
    const second = resolveDocumentProfile(catalog.value, {
      sizeProfileId: "standard",
      productProfileIds: ["mobile", "web"],
      explicitDecisions,
      capabilityFlags: [],
    });
    expect(first).toEqual(second);
    expect(first.ok && first.value.selectionDigest).toMatch(/^[a-f0-9]{64}$/);
    if (!first.ok) return;
    expect(first.value.decisions.find((item) => item.docTypeId === "DOC-L4-DATA")).toMatchObject({
      winningDecisionId: "explicit-data-detail",
      detail: "detailed",
    });
    expect(first.value.applicationReceipt).toContain("explicit-data-detail");

    const withoutExplicit = resolveDocumentProfile(catalog.value, {
      sizeProfileId: "standard",
      productProfileIds: ["web", "mobile"],
      explicitDecisions: [],
      capabilityFlags: [],
    });
    expect(withoutExplicit.ok).toBe(true);
    if (withoutExplicit.ok) {
      expect(withoutExplicit.value.selectionDigest).not.toBe(first.value.selectionDigest);
    }
  });

  it("preserves every master field and rejects invalid enum or FK", () => {
    const valid = createProfileCatalog({
      profiles,
      decisions,
      knownDocTypeIds: ["DOC-L4-DATA", "DOC-L4-SECURITY"],
      requiredDocTypeIds: [],
      coreDocTypeIds: [],
    });
    expect(
      valid.ok && valid.value.profiles.find((profile) => profile.profileId === "standard"),
    ).toEqual(profiles[0]);

    const invalid = createProfileCatalog({
      profiles: [{ ...profiles[0], profileAxis: "unknown" as "size" }],
      decisions: [decision("orphan", "missing", "DOC-MISSING", "adopt", "standard", "required")],
      knownDocTypeIds: ["DOC-L4-DATA"],
      requiredDocTypeIds: [],
      coreDocTypeIds: [],
    });
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.findings.map((finding) => finding.ruleId)).toEqual([
      "profile-authoring-enum-invalid",
      "profile-unknown",
      "profile-unknown",
    ]);

    const enumMutations = [
      { profiles: [{ ...profiles[0], defaultDetail: "unknown" as "lite" }], decisions: [] },
      { profiles: [{ ...profiles[0], defaultStatus: "unknown" as "required" }], decisions: [] },
      {
        profiles: [profiles[0]],
        decisions: [{ ...decisions[0], decision: "unknown" as "adopt" }],
      },
      {
        profiles: [profiles[0]],
        decisions: [{ ...decisions[0], detailOverride: "unknown" as "lite" }],
      },
      {
        profiles: [profiles[0]],
        decisions: [{ ...decisions[0], statusOverride: "unknown" as "required" }],
      },
    ];
    for (const mutation of enumMutations) {
      const result = createProfileCatalog({
        ...mutation,
        knownDocTypeIds: ["DOC-L4-DATA"],
        requiredDocTypeIds: [],
        coreDocTypeIds: [],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.findings[0]?.ruleId).toBe("profile-authoring-enum-invalid");
    }
  });

  it("U-PROFILE-003: rejects unknown selection and capability", () => {
    const catalog = createProfileCatalog({
      profiles,
      decisions,
      knownDocTypeIds: ["DOC-L4-DATA", "DOC-L4-SECURITY"],
      requiredDocTypeIds: [],
      coreDocTypeIds: [],
      knownCapabilityFlags: ["browser"],
    });
    if (!catalog.ok) throw new Error("fixture must be valid");
    const result = resolveDocumentProfile(catalog.value, {
      sizeProfileId: "missing",
      productProfileIds: [],
      explicitDecisions: [],
      capabilityFlags: ["unknown"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.findings.map((finding) => finding.subjectId)).toEqual(["missing", "unknown"]);

    const explicit = resolveDocumentProfile(catalog.value, {
      sizeProfileId: "standard",
      productProfileIds: [],
      capabilityFlags: [],
      explicitDecisions: [
        decision("unknown-explicit", "missing", "DOC-MISSING", "adopt", "standard", "required"),
      ],
    });
    expect(explicit.ok).toBe(false);
    if (!explicit.ok) {
      expect(explicit.findings.map((finding) => finding.subjectId)).toEqual([
        "DOC-MISSING",
        "missing",
      ]);
    }
  });

  it("U-PROFILE-004: rejects duplicate identity and same-precedence conflict", () => {
    const duplicate = createProfileCatalog({
      profiles,
      decisions: [decisions[0], decisions[0]],
      knownDocTypeIds: ["DOC-L4-DATA", "DOC-L4-SECURITY"],
      requiredDocTypeIds: [],
      coreDocTypeIds: [],
    });
    expect(duplicate.ok).toBe(false);

    const catalog = createProfileCatalog({
      profiles,
      decisions,
      knownDocTypeIds: ["DOC-L4-DATA", "DOC-L4-SECURITY"],
      requiredDocTypeIds: [],
      coreDocTypeIds: [],
    });
    if (!catalog.ok) throw new Error("fixture must be valid");
    const result = resolveDocumentProfile(catalog.value, {
      sizeProfileId: "standard",
      productProfileIds: [],
      capabilityFlags: [],
      explicitDecisions: [
        decision("explicit-a", "standard", "DOC-L4-DATA", "adopt", "detailed", "required"),
        decision("explicit-b", "standard", "DOC-L4-DATA", "skip", "lite", "skipped"),
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.findings[0]?.ruleId).toBe("profile-overlay-conflict");
  });

  it("U-PROFILE-005: does not invent a missing required slot and cannot weaken core detail", () => {
    const catalog = createProfileCatalog({
      profiles,
      decisions: decisions.filter((item) => item.docTypeId !== "DOC-L4-SECURITY"),
      knownDocTypeIds: ["DOC-L4-DATA", "DOC-L4-SECURITY"],
      requiredDocTypeIds: ["DOC-L4-DATA", "DOC-L4-SECURITY"],
      coreDocTypeIds: ["DOC-L4-DATA", "DOC-L4-SECURITY"],
    });
    if (!catalog.ok) throw new Error("fixture must be valid");
    const missing = resolveDocumentProfile(catalog.value, {
      sizeProfileId: "standard",
      productProfileIds: [],
      explicitDecisions: [],
      capabilityFlags: [],
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.findings[0]?.ruleId).toBe("profile-decision-missing");
    }

    const complete = createProfileCatalog({
      profiles,
      decisions,
      knownDocTypeIds: ["DOC-L4-DATA", "DOC-L4-SECURITY"],
      requiredDocTypeIds: ["DOC-L4-DATA", "DOC-L4-SECURITY"],
      coreDocTypeIds: ["DOC-L4-DATA", "DOC-L4-SECURITY"],
    });
    if (!complete.ok) throw new Error("fixture must be valid");
    const weakened = resolveDocumentProfile(complete.value, {
      sizeProfileId: "standard",
      productProfileIds: [],
      capabilityFlags: [],
      explicitDecisions: [
        decision("weaken", "standard", "DOC-L4-SECURITY", "adopt", "lite", "required"),
      ],
    });
    expect(weakened.ok).toBe(false);
    if (!weakened.ok) expect(weakened.findings[0]?.ruleId).toBe("profile-core-detail-weakened");
  });

  it("catalog snapshot is runtime immutable and semantic changes alter selection digest", () => {
    const first = createProfileCatalog({
      profiles,
      decisions,
      knownDocTypeIds: ["DOC-L4-DATA", "DOC-L4-SECURITY"],
      requiredDocTypeIds: [],
      coreDocTypeIds: [],
    });
    if (!first.ok) throw new Error("fixture must be valid");
    expect(Object.isFrozen(first.value.profiles)).toBe(true);
    expect(Object.isFrozen(first.value.profiles[0])).toBe(true);
    const changed = createProfileCatalog({
      profiles,
      decisions: decisions.map((item) =>
        item.decisionId === "standard-data" ? { ...item, reason: "meaning changed" } : item,
      ),
      knownDocTypeIds: ["DOC-L4-DATA", "DOC-L4-SECURITY"],
      requiredDocTypeIds: [],
      coreDocTypeIds: [],
    });
    if (!changed.ok) throw new Error("fixture must be valid");
    const selection = {
      sizeProfileId: "standard",
      productProfileIds: [] as string[],
      explicitDecisions: [] as DocumentProfileDecision[],
      capabilityFlags: [] as string[],
    };
    const firstResolved = resolveDocumentProfile(first.value, selection);
    const changedResolved = resolveDocumentProfile(changed.value, selection);
    expect(firstResolved.ok && changedResolved.ok).toBe(true);
    if (firstResolved.ok && changedResolved.ok) {
      expect(firstResolved.value.selectionDigest).not.toBe(changedResolved.value.selectionDigest);
    }
  });
});
