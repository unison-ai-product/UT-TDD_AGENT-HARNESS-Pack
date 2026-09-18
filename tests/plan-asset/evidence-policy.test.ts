import { describe, expect, it } from "vitest";
import { HmacEvidenceAttestationIssuer } from "../../src/plan-asset/adapters/hmac-evidence-attestation-authority.ts";
import { EvidencePolicy } from "../../src/plan-asset/domain/evidence-policy.ts";
import {
  createRedactedCommandArgs,
  EvidenceRecord,
  type StoredEvidenceRecord,
} from "../../src/plan-asset/domain/evidence-record.ts";
import {
  captureEvidenceAttestationVerifier,
  HmacEvidenceAttestationVerifier,
} from "../../src/plan-asset/kernel/hmac-evidence-attestation-verifier.ts";

const digest = "a".repeat(64);
const commit = "b".repeat(40);
const keyMaterial = [
  {
    version: "v1",
    secret: Buffer.alloc(32, 0x2a), // test-only deterministic fixture
    producers: ["human", "po", "codex", "claude", "ci"],
  },
] as const;
const issuer = new HmacEvidenceAttestationIssuer("local-ci", "v1", keyMaterial);
const authority = new HmacEvidenceAttestationVerifier("local-ci", keyMaterial);

describe("PLAN Asset evidence policy", () => {
  it("U-PA-045: evaluates multiple typed requirements without cross-kind double counting", () => {
    const eligible = evidence("evidence:eligible", { evidenceKind: "green-test-run" });
    const gate = evidence("evidence:gate", { evidenceKind: "gate-run" });
    const wrongKind = evidence("evidence:wrong-kind", { evidenceKind: "red-test-run" });
    const expired = evidence("evidence:expired", {
      evidenceKind: "green-test-run",
      expiresAt: "2026-07-14T00:30:00Z",
    });
    const policy = EvidencePolicy.create(
      {
        policyId: "accept/v1",
        revision: 1,
        requirements: [
          {
            requirementId: "accept-green",
            requiredKind: "green-test-run",
            minCount: 1,
            maxCount: 1,
            acceptedProducers: ["ci"],
            exitRule: { kind: "exact", expected: 0 },
            claimsRule: { kind: "recorded" },
          },
          {
            requirementId: "accept-gate",
            requiredKind: "gate-run",
            minCount: 1,
            acceptedProducers: ["ci"],
            exitRule: { kind: "exact", expected: 0 },
            claimsRule: { kind: "gate-passed" },
          },
        ],
      },
      authority,
    );
    if (!policy.ok) throw new Error("policy fixture must be valid");

    expect(
      policy.value.evaluate([wrongKind, expired, gate, eligible], {
        subjectId: "plan:a",
        subjectRevision: 1,
        sourceCommit: commit,
        now: "2026-07-14T01:00:00Z",
      }),
    ).toEqual({
      usable: true,
      policyId: "accept/v1",
      policyRevision: 1,
      eligibleEvidenceIds: ["evidence:eligible", "evidence:gate"],
      rejectedEvidenceIds: ["evidence:expired", "evidence:wrong-kind"],
      missingCount: 0,
      excessCount: 0,
      violations: [],
      requirements: [
        {
          requirementId: "accept-gate",
          evidenceKind: "gate-run",
          eligibleEvidenceIds: ["evidence:gate"],
          rejectedEvidenceIds: [],
          missingCount: 0,
          excessCount: 0,
        },
        {
          requirementId: "accept-green",
          evidenceKind: "green-test-run",
          eligibleEvidenceIds: ["evidence:eligible"],
          rejectedEvidenceIds: ["evidence:expired"],
          missingCount: 0,
          excessCount: 0,
        },
      ],
    });
  });

  it("U-PA-046: rejects unbranded argv, unknown kind/producer, self-supersession, and digest drift", () => {
    const base = {
      evidenceId: "evidence:invalid",
      evidenceKind: "green-test-run" as const,
      subjectId: "plan:a",
      subjectRevision: 1,
      sourceCommit: commit,
      commandArgs: createRedactedCommandArgs(["bun", "test", "--token=secret-value"]),
      claims: { runnerId: "vitest", testIds: ["U-PA-046"] },
      outputDigest: digest,
      exitCode: 0,
      producer: "ci" as const,
      producedAt: "2026-07-14T00:00:00Z",
    };
    expect(EvidenceRecord.create({ ...base, commandArgs: ["bun", "test"] as never }).ok).toBe(
      false,
    );
    expect(EvidenceRecord.create({ ...base, evidenceKind: "unknown" as never }).ok).toBe(false);
    expect(EvidenceRecord.create({ ...base, producer: "unknown" as never }).ok).toBe(false);
    expect(EvidenceRecord.create({ ...base, supersedesEvidenceId: base.evidenceId }).ok).toBe(
      false,
    );

    const created = EvidenceRecord.create(base);
    if (!created.ok) throw new Error("evidence fixture must be valid");
    expect(created.value.commandArgs.values).toContain("--token=[REDACTED]");
    const compoundSecrets = createRedactedCommandArgs([
      "cmd",
      "--client-secret=TOPSECRET",
      "--access-token",
      "TOPSECRET2",
      "OPENAI_API_KEY=TOPSECRET3",
      "-H",
      "Authorization: Bearer TOPSECRET4",
      "https://user:TOPSECRET5@example.test/path",
      "-H",
      "Cookie: session=TOPSECRET6",
      "--header",
      "Set-Cookie: refresh=TOPSECRET7",
      "--header=X-Session-ID: TOPSECRET8",
      "APIKEY=TOPSECRET9",
      "--client-key",
      "TOPSECRET10",
      "-H",
      "X-Auth: TOPSECRET11",
      "--signing-key=TOPSECRET12",
      "AWS_ACCESS_KEY=TOPSECRET13",
      "--ssh-key",
      "TOPSECRET14",
    ]);
    expect(JSON.stringify(compoundSecrets)).not.toContain("TOPSECRET");
    expect(
      EvidenceRecord.create({
        ...base,
        commandArgs: createRedactedCommandArgs(["bun", "", "test"]),
      }).ok,
    ).toBe(false);
    expect(Object.isFrozen(created.value.claims)).toBe(true);
    expect(
      EvidenceRecord.reconstruct({
        ...created.value.toRecord(),
        outputDigest: "c".repeat(64),
      }).ok,
    ).toBe(false);

    const stored = created.value.toRecord();
    const mutations: Array<(record: StoredEvidenceRecord) => StoredEvidenceRecord> = [
      (record) => ({ ...record, evidenceId: "evidence:mutated" }),
      (record) => ({
        ...record,
        evidenceKind: "gate-run",
        claims: { gateIds: ["gate:a"], failedGateIds: [] },
      }),
      (record) => ({ ...record, subjectId: "plan:b" }),
      (record) => ({ ...record, subjectRevision: 2 }),
      (record) => ({ ...record, sourceCommit: "c".repeat(40) }),
      (record) => ({
        ...record,
        commandArgs: { schemaVersion: "redacted-argv/v1", values: ["bun", "test", "changed"] },
      }),
      (record) => ({ ...record, claims: { runnerId: "vitest", testIds: ["changed"] } }),
      (record) => ({ ...record, exitCode: 1 }),
      (record) => ({ ...record, producer: "codex" }),
      (record) => ({ ...record, producedAt: "2026-07-13T23:00:00Z" }),
      (record) => ({ ...record, expiresAt: "2026-07-15T00:00:00Z" }),
      (record) => ({ ...record, supersedesEvidenceId: "evidence:older" }),
      (record) => ({ ...record, recordDigest: "d".repeat(64) }),
    ];
    for (const mutate of mutations) {
      const reconstructed = EvidenceRecord.reconstruct(mutate(stored));
      expect(reconstructed.ok).toBe(false);
      if (!reconstructed.ok) {
        expect(reconstructed.error.ruleId).toBe("evidence-record-digest-mismatch");
      }
    }
  });

  it("U-PA-046: deep-freezes validated policy rules", () => {
    const exitRule = { kind: "exact" as const, expected: 0 };
    const claimsRule = { kind: "recorded" as const };
    const created = EvidencePolicy.create(
      {
        policyId: "immutable/v1",
        revision: 1,
        requirements: [
          {
            requirementId: "immutable-green",
            requiredKind: "green-test-run",
            minCount: 1,
            acceptedProducers: ["ci"],
            exitRule,
            claimsRule,
          },
        ],
      },
      authority,
    );
    if (!created.ok) throw new Error("policy fixture must be valid");

    expect(Object.isFrozen(created.value.requirements[0]?.exitRule)).toBe(true);
    expect(Object.isFrozen(created.value.requirements[0]?.claimsRule)).toBe(true);
    exitRule.expected = 1;
    expect(created.value.requirements[0]?.exitRule).toEqual({ kind: "exact", expected: 0 });
  });

  it("U-PA-048: accepts only evidence attested by the policy's trusted authority", () => {
    const input = {
      evidenceId: "evidence:attested-gate",
      evidenceKind: "gate-run" as const,
      subjectId: "plan:a",
      subjectRevision: 1,
      sourceCommit: commit,
      commandArgs: createRedactedCommandArgs(["ut-tdd", "gate"]),
      claims: { gateIds: ["gate:accept"], failedGateIds: [] },
      outputDigest: digest,
      exitCode: 0,
      producer: "ci" as const,
      producedAt: "2026-07-14T00:00:00Z",
    };
    const unsigned = EvidenceRecord.create(input);
    const signed = EvidenceRecord.create(input, issuer);
    const rogueAuthority = new HmacEvidenceAttestationIssuer("local-ci", "v1", [
      {
        version: "v1",
        secret: Buffer.alloc(32, 0x7f), // test-only deterministic fixture
        producers: ["ci"],
      },
    ]);
    const forged = EvidenceRecord.create(input, rogueAuthority);
    if (!unsigned.ok || !signed.ok || !forged.ok) throw new Error("evidence fixture invalid");

    const policy = EvidencePolicy.create(
      {
        policyId: "trusted-gate/v1",
        revision: 1,
        requirements: [
          {
            requirementId: "trusted-gate",
            requiredKind: "gate-run",
            minCount: 1,
            acceptedProducers: ["ci"],
            exitRule: { kind: "exact", expected: 0 },
            claimsRule: { kind: "gate-passed" },
          },
        ],
      },
      authority,
    );
    if (!policy.ok) throw new Error("policy fixture invalid");
    const context = {
      subjectId: "plan:a",
      subjectRevision: 1,
      sourceCommit: commit,
      now: "2026-07-14T01:00:00Z",
    };

    expect(policy.value.evaluate([unsigned.value], context).usable).toBe(false);
    expect(policy.value.evaluate([forged.value], context).usable).toBe(false);
    expect(policy.value.evaluate([signed.value], context).usable).toBe(true);
    const restored = EvidenceRecord.reconstruct(signed.value.toRecord());
    expect(restored.ok && policy.value.evaluate([restored.value], context).usable).toBe(true);
    expect(Object.getOwnPropertyNames(authority)).not.toEqual(
      expect.arrayContaining(["keys", "currentVersion", "authorityId"]),
    );
    expect("issue" in authority).toBe(false);
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.isFrozen(HmacEvidenceAttestationVerifier.prototype)).toBe(true);
    class ForgedVerifier extends HmacEvidenceAttestationVerifier {
      override verify(): boolean {
        return true;
      }
    }
    expect(() => new ForgedVerifier("local-ci", keyMaterial)).toThrow(
      "evidence-attestation-verifier-invalid",
    );
    const prototypeSpoof = Object.create(HmacEvidenceAttestationVerifier.prototype) as {
      verify: () => boolean;
    };
    Object.defineProperty(prototypeSpoof, "verify", { value: () => true });
    const proxySpoof = new Proxy(authority, { get: () => () => true });
    expect(captureEvidenceAttestationVerifier(prototypeSpoof as never)).toBeNull();
    expect(captureEvidenceAttestationVerifier(proxySpoof)).toBeNull();
    expect(
      EvidencePolicy.create(
        {
          policyId: "forged-verifier/v1",
          revision: 1,
          requirements: [
            {
              requirementId: "forged-verifier",
              requiredKind: "gate-run",
              minCount: 1,
              acceptedProducers: ["ci"],
              exitRule: { kind: "exact", expected: 0 },
              claimsRule: { kind: "gate-passed" },
            },
          ],
        },
        { verify: () => true } as never,
      ).ok,
    ).toBe(false);
  });

  it("U-PA-048: binds producer/digest, rejects replay, and verifies rotated historical keys", () => {
    const rotationKeys = [
      {
        version: "v1",
        secret: Buffer.alloc(32, 0x11), // test-only deterministic fixture
        producers: ["ci"] as const,
      },
      {
        version: "v2",
        secret: Buffer.alloc(32, 0x22), // test-only deterministic fixture
        producers: ["ci"] as const,
      },
    ];
    const oldIssuer = new HmacEvidenceAttestationIssuer("rotation-ci", "v1", rotationKeys);
    const currentIssuer = new HmacEvidenceAttestationIssuer("rotation-ci", "v2", rotationKeys);
    const rotationVerifier = new HmacEvidenceAttestationVerifier("rotation-ci", rotationKeys);
    const first = { producer: "ci" as const, recordDigest: "1".repeat(64) };
    const second = { producer: "ci" as const, recordDigest: "2".repeat(64) };
    const oldAttestation = oldIssuer.issue(first);
    const currentAttestation = currentIssuer.issue(second);

    expect(oldAttestation.keyVersion).toBe("v1");
    expect(currentAttestation.keyVersion).toBe("v2");
    expect(rotationVerifier.verify(first, oldAttestation)).toBe(true);
    expect(rotationVerifier.verify(second, currentAttestation)).toBe(true);
    expect(rotationVerifier.verify(second, oldAttestation)).toBe(false);
    expect(
      rotationVerifier.verify(
        { producer: "codex", recordDigest: first.recordDigest },
        oldAttestation,
      ),
    ).toBe(false);
    expect(
      rotationVerifier.verify(
        { producer: first.producer, recordDigest: "3".repeat(64) },
        oldAttestation,
      ),
    ).toBe(false);
    expect("issue" in rotationVerifier).toBe(false);
  });

  it("U-PA-046: rejects negative claims and causally reversed supersession", () => {
    const rejected = reviewEvidence("evidence:rejected", "rejected", "2026-07-14T01:00:00Z");
    const olderApproval = reviewEvidence(
      "evidence:older-approval",
      "approved",
      "2026-07-14T00:00:00Z",
      rejected.evidenceId,
    );
    const policy = EvidencePolicy.create(
      {
        policyId: "review/v1",
        revision: 1,
        requirements: [
          {
            requirementId: "independent-review-approved",
            requiredKind: "independent-review",
            minCount: 1,
            acceptedProducers: ["human"],
            exitRule: { kind: "exact", expected: 0 },
            claimsRule: { kind: "review-approved" },
          },
        ],
      },
      authority,
    );
    if (!policy.ok) throw new Error("policy fixture must be valid");
    const verdict = policy.value.evaluate([rejected, olderApproval], {
      subjectId: "plan:a",
      subjectRevision: 1,
      sourceCommit: commit,
      now: "2026-07-14T02:00:00Z",
    });
    expect(verdict.usable).toBe(false);
    expect(verdict.violations).toContain(
      "evidence-supersession-causal-order:evidence:older-approval",
    );
    expect(verdict.eligibleEvidenceIds).not.toContain("evidence:rejected");
  });

  it.each([
    { requiredKind: "unknown" as never },
    { acceptedProducers: ["unknown" as never] },
    { exitRule: { kind: "bogus" } as never },
    { claimsRule: { kind: "bogus" } as never },
  ])("U-PA-046: rejects an unknown policy discriminator", (override) => {
    expect(
      EvidencePolicy.create(
        {
          policyId: "invalid/v1",
          revision: 1,
          requirements: [
            {
              requirementId: "invalid",
              requiredKind: "green-test-run",
              minCount: 1,
              acceptedProducers: ["ci"],
              exitRule: { kind: "exact", expected: 0 },
              claimsRule: { kind: "recorded" },
              ...override,
            },
          ],
        },
        authority,
      ).ok,
    ).toBe(false);
  });

  it("U-PA-046: reduces a valid supersession chain and rejects orphan/fork/cycle graphs", () => {
    const policy = approvedReviewPolicy();
    const first = reviewEvidence("evidence:first", "approved", "2026-07-14T00:00:00Z");
    const second = reviewEvidence(
      "evidence:second",
      "approved",
      "2026-07-14T01:00:00Z",
      first.evidenceId,
    );
    const third = reviewEvidence(
      "evidence:third",
      "approved",
      "2026-07-14T02:00:00Z",
      second.evidenceId,
    );
    const context = {
      subjectId: "plan:a",
      subjectRevision: 1,
      sourceCommit: commit,
      now: "2026-07-14T04:00:00Z",
    };
    expect(policy.evaluate([first, second, third], context)).toMatchObject({
      usable: true,
      eligibleEvidenceIds: ["evidence:third"],
      rejectedEvidenceIds: ["evidence:first", "evidence:second"],
      violations: [],
    });

    const orphan = reviewEvidence(
      "evidence:orphan",
      "approved",
      "2026-07-14T03:00:00Z",
      "evidence:missing",
    );
    expect(policy.evaluate([orphan], context).violations).toContain(
      "evidence-supersession-orphan:evidence:orphan",
    );

    const forkLeft = reviewEvidence(
      "evidence:fork-left",
      "approved",
      "2026-07-14T01:00:00Z",
      first.evidenceId,
    );
    const forkRight = reviewEvidence(
      "evidence:fork-right",
      "approved",
      "2026-07-14T02:00:00Z",
      first.evidenceId,
    );
    expect(policy.evaluate([first, forkLeft, forkRight], context).violations).toContain(
      "evidence-supersession-fork:evidence:first",
    );

    const cycleA = reviewEvidence(
      "evidence:cycle-a",
      "approved",
      "2026-07-14T01:00:00Z",
      "evidence:cycle-b",
    );
    const cycleB = reviewEvidence(
      "evidence:cycle-b",
      "approved",
      "2026-07-14T02:00:00Z",
      "evidence:cycle-a",
    );
    expect(policy.evaluate([cycleA, cycleB], context).violations).toEqual(
      expect.arrayContaining([
        "evidence-supersession-cycle:evidence:cycle-a",
        "evidence-supersession-cycle:evidence:cycle-b",
      ]),
    );
  });
});

function evidence(
  evidenceId: string,
  overrides: Partial<{
    evidenceKind: "green-test-run" | "red-test-run" | "gate-run";
    expiresAt: string;
  }> = {},
): EvidenceRecord {
  const evidenceKind = overrides.evidenceKind ?? "green-test-run";
  const created = EvidenceRecord.create(
    {
      evidenceId,
      evidenceKind,
      subjectId: "plan:a",
      subjectRevision: 1,
      sourceCommit: commit,
      commandArgs: createRedactedCommandArgs(["bun", "test"]),
      claims:
        evidenceKind === "red-test-run"
          ? {
              expectedFindingIds: ["red:expected"],
              observedFindingIds: ["red:expected"],
              todoCount: 0,
              skipCount: 0,
            }
          : evidenceKind === "gate-run"
            ? { gateIds: ["gate:accept"], failedGateIds: [] }
            : { runnerId: "vitest", testIds: ["U-PA-045"] },
      outputDigest: digest,
      exitCode: 0,
      producer: "ci",
      producedAt: "2026-07-14T00:00:00Z",
      expiresAt: overrides.expiresAt,
    },
    issuer,
  );
  if (!created.ok) throw new Error("evidence fixture must be valid");
  return created.value;
}

function reviewEvidence(
  evidenceId: string,
  verdict: "approved" | "rejected",
  producedAt: string,
  supersedesEvidenceId?: string,
): EvidenceRecord {
  const created = EvidenceRecord.create(
    {
      evidenceId,
      evidenceKind: "independent-review",
      subjectId: "plan:a",
      subjectRevision: 1,
      sourceCommit: commit,
      commandArgs: createRedactedCommandArgs(["ut-tdd", "review"]),
      claims: { verdict, reviewerId: "reviewer:a", reviewedAt: producedAt },
      outputDigest: digest,
      exitCode: 0,
      producer: "human",
      producedAt,
      supersedesEvidenceId,
    },
    issuer,
  );
  if (!created.ok) throw new Error("review evidence fixture must be valid");
  return created.value;
}

function approvedReviewPolicy(): EvidencePolicy {
  const created = EvidencePolicy.create(
    {
      policyId: "review/v1",
      revision: 1,
      requirements: [
        {
          requirementId: "independent-review-approved",
          requiredKind: "independent-review",
          minCount: 1,
          acceptedProducers: ["human"],
          exitRule: { kind: "exact", expected: 0 },
          claimsRule: { kind: "review-approved" },
        },
      ],
    },
    authority,
  );
  if (!created.ok) throw new Error("policy fixture must be valid");
  return created.value;
}
