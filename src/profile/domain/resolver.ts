export type ProfileAxis = "size" | "product";
export type ProfileDecision = "adopt" | "conditional" | "skip" | "defer";
export type ProfileDetail = "lite" | "standard" | "detailed";
export type ProfileStatus = "minimal" | "standard" | "required" | "profile_controlled" | "skipped";

export interface DocumentProfile {
  readonly profileId: string;
  readonly profileAxis: ProfileAxis;
  readonly profileRank: number;
  readonly description: string;
  readonly defaultStatus: ProfileStatus;
  readonly defaultDetail: ProfileDetail;
  readonly scopePolicy: string;
  readonly rowDigest: string;
}

export interface DocumentProfileDecision {
  readonly decisionId: string;
  readonly profileId: string;
  readonly docTypeId: string;
  readonly decision: ProfileDecision;
  readonly detailOverride: ProfileDetail;
  readonly statusOverride: ProfileStatus;
  readonly reason: string;
  readonly requiredPlanId?: string;
  readonly rowDigest: string;
}

export interface ProfileFinding {
  readonly ruleId: string;
  readonly subjectId: string;
  readonly message: string;
  readonly severity: "error";
  readonly evidenceRefs: readonly string[];
}

export interface ProfileCatalog {
  readonly catalogDigest: string;
  readonly profiles: readonly DocumentProfile[];
  readonly decisions: readonly DocumentProfileDecision[];
  readonly knownDocTypeIds: readonly string[];
  readonly requiredDocTypeIds: readonly string[];
  readonly coreDocTypeIds: readonly string[];
  readonly knownCapabilityFlags: readonly string[];
}

export interface ResolvedDocumentDecision {
  readonly docTypeId: string;
  readonly decision: ProfileDecision;
  readonly detail: ProfileDetail;
  readonly status: ProfileStatus;
  readonly reason: string;
  readonly winningDecisionId: string;
  readonly appliedDecisionIds: readonly string[];
  readonly requiredPlanId?: string;
}

export interface ResolvedProfile {
  readonly selectionDigest: string;
  readonly decisions: readonly ResolvedDocumentDecision[];
  readonly applicationReceipt: readonly string[];
}

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly findings: readonly ProfileFinding[] };

export function createProfileCatalog(input: {
  readonly profiles: readonly DocumentProfile[];
  readonly decisions: readonly DocumentProfileDecision[];
  readonly knownDocTypeIds: readonly string[];
  readonly requiredDocTypeIds: readonly string[];
  readonly coreDocTypeIds: readonly string[];
  readonly knownCapabilityFlags?: readonly string[];
}): Result<ProfileCatalog> {
  const findings: ProfileFinding[] = [];
  const profiles = new Map<string, DocumentProfile>();
  const decisionIds = new Set<string>();
  const knownDocs = new Set(input.knownDocTypeIds);

  for (const profile of input.profiles) {
    validateProfile(profile, findings);
    if (profiles.has(profile.profileId))
      findings.push(finding("catalog-profile-duplicate", profile.profileId));
    else profiles.set(profile.profileId, Object.freeze({ ...profile }));
  }
  for (const decision of input.decisions) {
    validateDecision(decision, findings);
    if (decisionIds.has(decision.decisionId))
      findings.push(finding("catalog-profile-duplicate", decision.decisionId));
    decisionIds.add(decision.decisionId);
    if (!profiles.has(decision.profileId))
      findings.push(finding("profile-unknown", decision.profileId));
    if (!knownDocs.has(decision.docTypeId))
      findings.push(finding("profile-unknown", decision.docTypeId));
  }
  if (findings.length > 0) return failed(findings);
  return {
    ok: true,
    value: Object.freeze({
      catalogDigest: digestProfileCatalog(input),
      profiles: freezeRows([...profiles.values()]),
      decisions: freezeRows(input.decisions),
      knownDocTypeIds: freezeStrings(input.knownDocTypeIds),
      requiredDocTypeIds: freezeStrings(input.requiredDocTypeIds),
      coreDocTypeIds: freezeStrings(input.coreDocTypeIds),
      knownCapabilityFlags: freezeStrings(input.knownCapabilityFlags ?? []),
    }),
  };
}

export function resolveDocumentProfile(
  catalog: ProfileCatalog,
  selection: {
    readonly sizeProfileId: string;
    readonly productProfileIds: readonly string[];
    readonly explicitDecisions: readonly DocumentProfileDecision[];
    readonly capabilityFlags: readonly string[];
  },
): Result<ResolvedProfile> {
  const findings = validateSelection(catalog, selection);
  if (findings.length > 0) return failed(findings);
  const productIds = [...new Set(selection.productProfileIds)].sort((left, right) =>
    compareProfiles(catalog, left, right),
  );
  const orderedProfileIds = [selection.sizeProfileId, ...productIds];
  const resolved = new Map<string, ResolvedDocumentDecision>();
  const receipt: string[] = [];

  for (const profileId of orderedProfileIds) {
    for (const decision of decisionsFor(catalog, profileId)) {
      applyDecision(catalog, { resolved, next: decision, explicit: false, findings });
      receipt.push(decision.decisionId);
    }
  }
  const explicit = [...selection.explicitDecisions].sort((a, b) =>
    compareBytes(a.decisionId, b.decisionId),
  );
  rejectExplicitConflicts(explicit, findings);
  for (const decision of explicit) {
    validateDecision(decision, findings);
    if (!catalog.knownDocTypeIds.includes(decision.docTypeId)) {
      findings.push(finding("profile-unknown", decision.docTypeId));
    }
    if (!profileById(catalog, decision.profileId)) {
      findings.push(finding("profile-unknown", decision.profileId));
    }
    applyDecision(catalog, { resolved, next: decision, explicit: true, findings });
    receipt.push(decision.decisionId);
  }
  for (const required of [...catalog.requiredDocTypeIds].sort()) {
    if (!resolved.has(required)) findings.push(finding("profile-decision-missing", required));
  }
  if (findings.length > 0) return failed(findings);
  return {
    ok: true,
    value: Object.freeze({
      selectionDigest: createHash("sha256")
        .update(
          JSON.stringify({
            sizeProfileId: selection.sizeProfileId,
            productProfileIds: productIds,
            catalogDigest: catalog.catalogDigest,
            explicitDecisions: explicit,
            capabilityFlags: [...new Set(selection.capabilityFlags)].sort(),
          }),
        )
        .digest("hex"),
      decisions: Object.freeze(
        [...resolved.values()].sort((a, b) => compareBytes(a.docTypeId, b.docTypeId)),
      ),
      applicationReceipt: Object.freeze(receipt),
    }),
  };
}

function applyDecision(
  catalog: ProfileCatalog,
  input: {
    resolved: Map<string, ResolvedDocumentDecision>;
    next: DocumentProfileDecision;
    explicit: boolean;
    findings: ProfileFinding[];
  },
): void {
  const { resolved, next, explicit, findings } = input;
  const current = resolved.get(next.docTypeId);
  if (current && catalog.coreDocTypeIds.includes(next.docTypeId)) {
    if (detailRank(next.detailOverride) < detailRank(current.detail)) {
      if (explicit) {
        findings.push(finding("profile-core-detail-weakened", next.docTypeId));
        return;
      }
      resolved.set(next.docTypeId, {
        ...current,
        appliedDecisionIds: Object.freeze([...current.appliedDecisionIds, next.decisionId]),
      });
      return;
    }
  }
  resolved.set(
    next.docTypeId,
    Object.freeze({
      docTypeId: next.docTypeId,
      decision: next.decision,
      detail: next.detailOverride,
      status: next.statusOverride,
      reason: next.reason,
      winningDecisionId: next.decisionId,
      appliedDecisionIds: Object.freeze([...(current?.appliedDecisionIds ?? []), next.decisionId]),
      ...(next.requiredPlanId ? { requiredPlanId: next.requiredPlanId } : {}),
    }),
  );
}

function validateSelection(
  catalog: ProfileCatalog,
  selection: {
    readonly sizeProfileId: string;
    readonly productProfileIds: readonly string[];
    readonly capabilityFlags: readonly string[];
  },
): ProfileFinding[] {
  const findings: ProfileFinding[] = [];
  if (new Set(selection.productProfileIds).size !== selection.productProfileIds.length) {
    findings.push(finding("catalog-profile-duplicate", "productProfileIds"));
  }
  const size = profileById(catalog, selection.sizeProfileId);
  if (!size || size.profileAxis !== "size")
    findings.push(finding("profile-unknown", selection.sizeProfileId));
  for (const id of [...new Set(selection.productProfileIds)].sort()) {
    const profile = profileById(catalog, id);
    if (!profile || profile.profileAxis !== "product")
      findings.push(finding("profile-unknown", id));
  }
  for (const flag of [...new Set(selection.capabilityFlags)].sort()) {
    if (!catalog.knownCapabilityFlags.includes(flag))
      findings.push(finding("profile-unknown", flag));
  }
  const selectedProducts = [...new Set(selection.productProfileIds)]
    .map((id) => profileById(catalog, id))
    .filter((profile): profile is DocumentProfile => Boolean(profile));
  for (let left = 0; left < selectedProducts.length; left++) {
    for (let right = left + 1; right < selectedProducts.length; right++) {
      if (selectedProducts[left].profileRank !== selectedProducts[right].profileRank) continue;
      const leftDecisions = decisionsFor(catalog, selectedProducts[left].profileId);
      const rightDecisions = decisionsFor(catalog, selectedProducts[right].profileId);
      for (const first of leftDecisions) {
        const second = rightDecisions.find((item) => item.docTypeId === first.docTypeId);
        if (second && decisionMeaning(first) !== decisionMeaning(second)) {
          findings.push(finding("profile-overlay-conflict", first.docTypeId));
        }
      }
    }
  }
  return findings;
}

function validateProfile(profile: DocumentProfile, findings: ProfileFinding[]): void {
  if (!(["size", "product"] as const).includes(profile.profileAxis)) {
    findings.push(finding("profile-authoring-enum-invalid", profile.profileId));
  }
  if (!isDetail(profile.defaultDetail) || !isStatus(profile.defaultStatus)) {
    findings.push(finding("profile-authoring-enum-invalid", profile.profileId));
  }
  if (!Number.isInteger(profile.profileRank) || !isDigest(profile.rowDigest)) {
    findings.push(finding("profile-authoring-digest-invalid", profile.profileId));
  }
}

function validateDecision(decision: DocumentProfileDecision, findings: ProfileFinding[]): void {
  if (
    !(["adopt", "conditional", "skip", "defer"] as const).includes(decision.decision) ||
    !isDetail(decision.detailOverride) ||
    !isStatus(decision.statusOverride)
  ) {
    findings.push(finding("profile-authoring-enum-invalid", decision.decisionId));
  }
  if (!decision.reason || (decision.decision === "defer" && !decision.requiredPlanId)) {
    findings.push(finding("profile-decision-missing", decision.decisionId));
  }
  if (!isDigest(decision.rowDigest)) {
    findings.push(finding("profile-authoring-digest-invalid", decision.decisionId));
  }
}

function isDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function rejectExplicitConflicts(
  decisions: readonly DocumentProfileDecision[],
  findings: ProfileFinding[],
): void {
  const byDoc = new Map<string, DocumentProfileDecision>();
  for (const decision of decisions) {
    const previous = byDoc.get(decision.docTypeId);
    if (previous) {
      findings.push(
        finding(
          previous.decisionId === decision.decisionId
            ? "catalog-profile-duplicate"
            : "profile-overlay-conflict",
          decision.docTypeId,
        ),
      );
    }
    byDoc.set(decision.docTypeId, decision);
  }
}

function decisionMeaning(decision: DocumentProfileDecision): string {
  return JSON.stringify({
    decision: decision.decision,
    detailOverride: decision.detailOverride,
    statusOverride: decision.statusOverride,
    reason: decision.reason,
    requiredPlanId: decision.requiredPlanId ?? null,
  });
}

function decisionsFor(catalog: ProfileCatalog, profileId: string): DocumentProfileDecision[] {
  return catalog.decisions
    .filter((item) => item.profileId === profileId)
    .sort(
      (a, b) => compareBytes(a.docTypeId, b.docTypeId) || compareBytes(a.decisionId, b.decisionId),
    );
}

function compareProfiles(catalog: ProfileCatalog, left: string, right: string): number {
  const a = profileById(catalog, left);
  const b = profileById(catalog, right);
  return (a?.profileRank ?? 0) - (b?.profileRank ?? 0) || compareBytes(left, right);
}

function profileById(catalog: ProfileCatalog, profileId: string): DocumentProfile | undefined {
  return catalog.profiles.find((profile) => profile.profileId === profileId);
}

function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function freezeStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort(compareBytes));
}

function freezeRows<T extends object>(values: readonly T[]): readonly Readonly<T>[] {
  return Object.freeze(values.map((value) => Object.freeze({ ...value })));
}

function digestProfileCatalog(input: {
  readonly profiles: readonly DocumentProfile[];
  readonly decisions: readonly DocumentProfileDecision[];
  readonly knownDocTypeIds: readonly string[];
  readonly requiredDocTypeIds: readonly string[];
  readonly coreDocTypeIds: readonly string[];
  readonly knownCapabilityFlags?: readonly string[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        profiles: [...input.profiles].sort((a, b) => compareBytes(a.profileId, b.profileId)),
        decisions: [...input.decisions].sort((a, b) => compareBytes(a.decisionId, b.decisionId)),
        knownDocTypeIds: [...input.knownDocTypeIds].sort(compareBytes),
        requiredDocTypeIds: [...input.requiredDocTypeIds].sort(compareBytes),
        coreDocTypeIds: [...input.coreDocTypeIds].sort(compareBytes),
        knownCapabilityFlags: [...(input.knownCapabilityFlags ?? [])].sort(compareBytes),
      }),
    )
    .digest("hex");
}

function detailRank(detail: ProfileDetail): number {
  return { lite: 0, standard: 1, detailed: 2 }[detail];
}

function isDetail(value: string): value is ProfileDetail {
  return ["lite", "standard", "detailed"].includes(value);
}

function isStatus(value: string): value is ProfileStatus {
  return ["minimal", "standard", "required", "profile_controlled", "skipped"].includes(value);
}

function finding(ruleId: string, subjectId: string): ProfileFinding {
  return Object.freeze({
    ruleId,
    subjectId,
    message: `${ruleId}: ${subjectId}`,
    severity: "error",
    evidenceRefs: Object.freeze([]),
  });
}

function failed(findings: readonly ProfileFinding[]): Result<never> {
  return {
    ok: false,
    findings: Object.freeze(
      [...findings].sort(
        (a, b) => compareBytes(a.ruleId, b.ruleId) || compareBytes(a.subjectId, b.subjectId),
      ),
    ),
  };
}

import { createHash } from "node:crypto";
