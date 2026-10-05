import { describe, expect, it, vi } from "vitest";
import type {
  PackPublicationPreparationReceipt,
  PublicationPortResult,
} from "../src/setup/pack-publication-adapter.ts";
import {
  admitPackPublication,
  derivePackPublicationAdmissionApprovalBinding,
  derivePackPublicationAdmissionIntentIdentity,
  derivePackPublicationPreparationReceiptDigest,
  PACK_PUBLICATION_ADMISSION_COVERAGE,
  type PackPublicationAdmissionConfiguration,
  type PackPublicationAdmissionInput,
  type PackPublicationAdmissionLedgerRecord,
  type PackPublicationAdmissionObserver,
} from "../src/setup/pack-publication-admission.ts";

const ok = <T>(value: T): PublicationPortResult<T> => ({ status: "attested", value });
const sha = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;
const oid = (value: string) => value.repeat(40).slice(0, 40);

const configuration: PackPublicationAdmissionConfiguration = {
  repositoryId: 424200,
  repository: "example-org/example-pack",
  targetRef: "refs/heads/main",
  rulesetId: 77,
  requiredContexts: ["pack-check"],
  casAuthorityInstallationId: 9001,
};

const receipt: PackPublicationPreparationReceipt = {
  kind: "pack-publication-preparation-receipt-v1",
  identity: {
    pullRequest: "4242",
    headOid: oid("a"),
    baseOid: oid("b"),
    treeDigest: sha("c"),
  },
  binding: { operationId: "op-adm-fixture-0001" },
  read_back_observation: { journalEventDigest: sha("d"), pullRequest: "4242" },
};

function fixture(
  overrides: Partial<PackPublicationAdmissionInput> = {},
  identity: {
    readonly operationId?: string;
    readonly pullRequest?: string;
    readonly idempotencyKey?: string;
    readonly expectedMainOid?: string;
  } = {},
): PackPublicationAdmissionInput {
  const operationId = identity.operationId ?? receipt.binding.operationId;
  const pullRequest = identity.pullRequest ?? receipt.identity.pullRequest;
  const idempotencyKey = identity.idempotencyKey ?? "idem-adm-fixture-0001";
  const treeDigest = receipt.identity.treeDigest;
  const expectedMainOid = identity.expectedMainOid ?? receipt.identity.baseOid;
  const inputReceipt: PackPublicationPreparationReceipt = {
    ...receipt,
    identity: {
      ...receipt.identity,
      pullRequest,
      treeDigest,
      baseOid: expectedMainOid,
    },
    binding: { operationId },
    read_back_observation: {
      ...receipt.read_back_observation,
      pullRequest,
    },
  };
  const intentIdentity = derivePackPublicationAdmissionIntentIdentity({
    operationId,
    repositoryId: configuration.repositoryId,
    targetRef: configuration.targetRef,
    expectedMainOid: inputReceipt.identity.baseOid,
    reviewedHead: inputReceipt.identity.headOid,
    preparationReceiptDigest: derivePackPublicationPreparationReceiptDigest(inputReceipt),
  });
  const observer = {
    repository: vi.fn(() => ok({ ...configuration })),
    pullRequest: vi.fn(() =>
      ok({
        pullRequest,
        branch: `pack/publication/${operationId}`,
        headOid: inputReceipt.identity.headOid,
        baseOid: inputReceipt.identity.baseOid,
        treeDigest,
      }),
    ),
    review: vi.fn(() =>
      ok({
        pullRequest,
        reviewedHead: inputReceipt.identity.headOid,
        conclusion: "approved" as const,
        reviewer: "reviewer-b",
        author: "author-a",
        closingReceiptDigest: sha("e"),
      }),
    ),
    checks: vi.fn(() =>
      ok({
        headOid: inputReceipt.identity.headOid,
        checks: [{ context: "pack-check", conclusion: "success" }],
      }),
    ),
    mergeBase: vi.fn(() => ok({ mergeBase: expectedMainOid })),
    staging: vi.fn(() =>
      ok({
        operationId,
        idempotencyKey,
        treeDigest,
        manifestDigest: sha("f"),
        expectedMainOid,
        branch: `pack/publication/${operationId}`,
      }),
    ),
  };
  const records: PackPublicationAdmissionLedgerRecord[] = [];
  return {
    receipt: inputReceipt,
    configuration,
    approvals: [
      {
        nonce: `apv-${operationId}`,
        operationId,
        idempotencyKey,
        intentBindingDigest: derivePackPublicationAdmissionApprovalBinding({
          nonce: `apv-${operationId}`,
          publicationIntentIdentity: intentIdentity,
        }),
        consumed: false,
        preparation: false,
      },
    ],
    observer,
    ledger: {
      read: () => records,
      appendObservation: vi.fn(),
      append: vi.fn((record: PackPublicationAdmissionLedgerRecord) => {
        records.push(record);
      }),
    },
    ...overrides,
  };
}

function withObservation(
  overrides: Partial<PackPublicationAdmissionObserver>,
): PackPublicationAdmissionInput {
  const input = fixture();
  return { ...input, observer: { ...input.observer, ...overrides } };
}

async function expectAdmissionDeny(
  input: PackPublicationAdmissionInput,
  reason: string,
): Promise<Awaited<ReturnType<typeof admitPackPublication>>> {
  const result = await admitPackPublication(input);
  expect(result).toMatchObject({
    ok: false,
    status: "denied",
    reason,
    remoteWrites: 0,
    approvalConsumes: 0,
  });
  expect(input.ledger.appendObservation).not.toHaveBeenCalled();
  expect(input.ledger.append).not.toHaveBeenCalled();
  return result;
}

describe("Pack publication admission observation binding", () => {
  it("U-PACKPUB-ADM-101 declares the bounded candidate coverage explicitly", () => {
    expect(PACK_PUBLICATION_ADMISSION_COVERAGE.implemented).toEqual([
      "CANDIDATE-PACKPUB-ADM-001",
      "CANDIDATE-PACKPUB-ADM-002",
      "CANDIDATE-PACKPUB-ADM-003",
      "CANDIDATE-PACKPUB-ADM-004",
      "CANDIDATE-PACKPUB-ADM-005",
      "CANDIDATE-PACKPUB-ADM-006",
      "CANDIDATE-PACKPUB-ADM-007",
      "CANDIDATE-PACKPUB-ADM-008",
      "CANDIDATE-PACKPUB-ADM-009",
      "CANDIDATE-PACKPUB-ADM-010",
      "CANDIDATE-PACKPUB-ADM-011",
      "CANDIDATE-PACKPUB-ADM-012",
      "CANDIDATE-PACKPUB-ADM-013",
      "CANDIDATE-PACKPUB-ADM-014",
      "CANDIDATE-PACKPUB-ADM-015",
      "CANDIDATE-PACKPUB-ADM-020",
      "CANDIDATE-PACKPUB-ADM-036",
      "CANDIDATE-PACKPUB-ADM-040",
      "CANDIDATE-PACKPUB-ADM-042",
      "CANDIDATE-PACKPUB-ADM-048",
      "CANDIDATE-PACKPUB-ADM-057",
    ]);
    expect(PACK_PUBLICATION_ADMISSION_COVERAGE.deferred).toEqual([
      "CANDIDATE-PACKPUB-ADM-016..019",
      "CANDIDATE-PACKPUB-ADM-021..035",
      "CANDIDATE-PACKPUB-ADM-037..039",
      "CANDIDATE-PACKPUB-ADM-041",
      "CANDIDATE-PACKPUB-ADM-043..047",
      "CANDIDATE-PACKPUB-ADM-049..056",
      "CANDIDATE-PACKPUB-ADM-058..070",
    ]);
  });

  it("U-PACKPUB-ADM-048 admits a complete read-only observation and appends provenance only", async () => {
    const input = fixture();
    const result = await admitPackPublication(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe("admitted");
    expect(result.record.sequence).toBe(1);
    expect(result.remoteWrites).toBe(0);
    expect(result.approvalConsumes).toBe(0);
    expect(input.ledger.appendObservation).toHaveBeenCalledTimes(1);
    expect(input.ledger.append).toHaveBeenCalledTimes(1);
  });

  it("U-PACKPUB-ADM-102 links the next admission record to the prior digest and journals the same bundle", async () => {
    const firstInput = fixture();
    const first = await admitPackPublication(firstInput);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const secondInput = fixture(
      { ledger: firstInput.ledger },
      {
        operationId: "op-adm-fixture-0002",
        pullRequest: "4243",
        idempotencyKey: "idem-adm-fixture-0002",
      },
    );
    const second = await admitPackPublication(secondInput);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.record.sequence).toBe(first.record.sequence + 1);
    expect(second.record.previousRecordDigest).toBe(first.record.recordDigest);
    expect(secondInput.ledger.appendObservation).toHaveBeenLastCalledWith({
      recordDigest: second.record.recordDigest,
      observationBundleDigest: second.record.observationBundleDigest,
      operationId: second.record.operationId,
    });
    expect(secondInput.ledger.append).toHaveBeenLastCalledWith(second.record);
    expect(second.remoteWrites).toBe(0);
    expect(second.approvalConsumes).toBe(0);
    expect(second.record).not.toHaveProperty("casToken");
    expect(second.record).not.toHaveProperty("executionReceipt");
  });

  it("U-PACKPUB-ADM-103 rejects malformed receipts before calling any observer", async () => {
    const input = fixture({ receipt: { kind: "malformed" } });
    const result = await admitPackPublication(input);
    expect(result).toMatchObject({
      ok: false,
      status: "denied",
      reason: "admission_receipt_invalid",
      remoteWrites: 0,
    });
    expect(input.observer.repository).not.toHaveBeenCalled();
  });

  it("U-PACKPUB-ADM-036 denies a missing preparation receipt before calling any observer", async () => {
    const input = fixture({ receipt: undefined });
    const result = await admitPackPublication(input);
    expect(result).toMatchObject({
      ok: false,
      status: "denied",
      reason: "admission_receipt_missing",
      remoteWrites: 0,
      approvalConsumes: 0,
    });
    expect(input.observer.repository).not.toHaveBeenCalled();
    expect(input.observer.pullRequest).not.toHaveBeenCalled();
    expect(input.observer.review).not.toHaveBeenCalled();
    expect(input.observer.checks).not.toHaveBeenCalled();
    expect(input.observer.mergeBase).not.toHaveBeenCalled();
    expect(input.observer.staging).not.toHaveBeenCalled();
  });

  it("U-PACKPUB-ADM-007 denies a review-head mutation without consuming approval or writing remotely", async () => {
    const input = fixture({
      observer: {
        ...fixture().observer,
        review: vi.fn(() =>
          ok({
            pullRequest: "4242",
            reviewedHead: oid("9"),
            conclusion: "approved" as const,
            reviewer: "reviewer-b",
            author: "author-a",
            closingReceiptDigest: sha("e"),
          }),
        ),
      },
    });
    const result = await admitPackPublication(input);
    expect(result).toMatchObject({
      ok: false,
      status: "denied",
      reason: "admission_review_head_mismatch",
      remoteWrites: 0,
      approvalConsumes: 0,
    });
    expect(input.ledger.append).not.toHaveBeenCalled();
  });

  it("U-PACKPUB-ADM-001 denies a different observed PR number", async () => {
    const input = withObservation({
      pullRequest: vi.fn(() =>
        ok({
          pullRequest: "4243",
          branch: "pack/publication/op-adm-fixture-0001",
          headOid: receipt.identity.headOid,
          baseOid: receipt.identity.baseOid,
          treeDigest: receipt.identity.treeDigest,
        }),
      ),
    });
    expect(await expectAdmissionDeny(input, "admission_pr_mismatch")).toMatchObject({
      reason: "admission_pr_mismatch",
    });
  });

  it("U-PACKPUB-ADM-002 denies a different observed PR head", async () => {
    const input = withObservation({
      pullRequest: vi.fn(() =>
        ok({
          pullRequest: "4242",
          branch: "pack/publication/op-adm-fixture-0001",
          headOid: oid("9"),
          baseOid: receipt.identity.baseOid,
          treeDigest: receipt.identity.treeDigest,
        }),
      ),
    });
    expect(await expectAdmissionDeny(input, "admission_head_mismatch")).toMatchObject({
      reason: "admission_head_mismatch",
    });
  });

  it("U-PACKPUB-ADM-003 denies a different observed PR base", async () => {
    const input = withObservation({
      pullRequest: vi.fn(() =>
        ok({
          pullRequest: "4242",
          branch: "pack/publication/op-adm-fixture-0001",
          headOid: receipt.identity.headOid,
          baseOid: oid("9"),
          treeDigest: receipt.identity.treeDigest,
        }),
      ),
    });
    expect(await expectAdmissionDeny(input, "admission_base_mismatch")).toMatchObject({
      reason: "admission_base_mismatch",
    });
  });

  it("U-PACKPUB-ADM-004 denies a different merge base", async () => {
    const input = withObservation({ mergeBase: vi.fn(() => ok({ mergeBase: oid("9") })) });
    expect(await expectAdmissionDeny(input, "admission_merge_base_mismatch")).toMatchObject({
      reason: "admission_merge_base_mismatch",
    });
  });

  it("U-PACKPUB-ADM-005 denies a review for another PR", async () => {
    const input = withObservation({
      review: vi.fn(() =>
        ok({
          pullRequest: "4243",
          reviewedHead: receipt.identity.headOid,
          conclusion: "approved" as const,
          reviewer: "reviewer-b",
          author: "author-a",
          closingReceiptDigest: sha("e"),
        }),
      ),
    });
    expect(await expectAdmissionDeny(input, "admission_review_pr_mismatch")).toMatchObject({
      reason: "admission_review_pr_mismatch",
    });
  });

  it("U-PACKPUB-ADM-006 denies malformed reviewed-head OIDs before equality", async () => {
    for (const reviewedHead of [
      "a".repeat(39),
      "A".repeat(40),
      "a".repeat(64),
      `g${"a".repeat(39)}`,
    ]) {
      const input = withObservation({
        review: vi.fn(() =>
          ok({
            pullRequest: "4242",
            reviewedHead,
            conclusion: "approved" as const,
            reviewer: "reviewer-b",
            author: "author-a",
            closingReceiptDigest: sha("e"),
          }),
        ),
      });
      expect(await expectAdmissionDeny(input, "admission_review_head_invalid")).toMatchObject({
        reason: "admission_review_head_invalid",
      });
    }
  });

  it("U-PACKPUB-ADM-008 denies a non-approved review", async () => {
    const input = withObservation({
      review: vi.fn(() =>
        ok({
          pullRequest: "4242",
          reviewedHead: receipt.identity.headOid,
          conclusion: "changes_requested" as const,
          reviewer: "reviewer-b",
          author: "author-a",
          closingReceiptDigest: sha("e"),
        }),
      ),
    });
    expect(await expectAdmissionDeny(input, "admission_review_not_approved")).toMatchObject({
      reason: "admission_review_not_approved",
    });
  });

  it("U-PACKPUB-ADM-009 denies malformed closing receipt digests", async () => {
    for (const closingReceiptDigest of [
      `sha256:${"e".repeat(63)}`,
      `sha1:${"e".repeat(64)}`,
      `sha256:${"E".repeat(64)}`,
      `sha256:g${"e".repeat(63)}`,
    ]) {
      const input = withObservation({
        review: vi.fn(() =>
          ok({
            pullRequest: "4242",
            reviewedHead: receipt.identity.headOid,
            conclusion: "approved" as const,
            reviewer: "reviewer-b",
            author: "author-a",
            closingReceiptDigest,
          }),
        ),
      });
      expect(await expectAdmissionDeny(input, "admission_review_receipt_invalid")).toMatchObject({
        reason: "admission_review_receipt_invalid",
      });
    }
  });

  it("U-PACKPUB-ADM-010 denies checks observed for another head", async () => {
    const input = withObservation({
      checks: vi.fn(() =>
        ok({
          headOid: oid("9"),
          checks: [{ context: "pack-check", conclusion: "success" }],
        }),
      ),
    });
    expect(await expectAdmissionDeny(input, "admission_checks_head_mismatch")).toMatchObject({
      reason: "admission_checks_head_mismatch",
    });
  });

  it("U-PACKPUB-ADM-011 denies an empty observed required-check set", async () => {
    const input = withObservation({
      repository: vi.fn(() => ok({ ...configuration, requiredContexts: [] })),
    });
    expect(await expectAdmissionDeny(input, "admission_checks_missing")).toMatchObject({
      reason: "admission_checks_missing",
    });
  });

  it("U-PACKPUB-ADM-012 denies a failed required check", async () => {
    const input = withObservation({
      checks: vi.fn(() =>
        ok({
          headOid: receipt.identity.headOid,
          checks: [{ context: "pack-check", conclusion: "failure" }],
        }),
      ),
    });
    expect(await expectAdmissionDeny(input, "admission_check_not_success")).toMatchObject({
      reason: "admission_check_not_success",
    });
  });

  it("U-PACKPUB-ADM-040 keeps observer failure indeterminate", async () => {
    const base = fixture();
    const input = fixture({
      observer: {
        ...base.observer,
        review: vi.fn(() => ({ status: "unavailable" as const, reason: "timeout" })),
      },
    });
    const result = await admitPackPublication(input);
    expect(result).toMatchObject({
      ok: false,
      status: "indeterminate",
      reason: "timeout",
      remoteWrites: 0,
      approvalConsumes: 0,
    });
    expect(input.observer.review).toHaveBeenCalledTimes(1);
    expect(input.observer.checks).not.toHaveBeenCalled();
    expect(input.ledger.appendObservation).not.toHaveBeenCalled();
    expect(input.ledger.append).not.toHaveBeenCalled();
  });

  it("U-PACKPUB-ADM-042 treats a nonnumeric observed ruleset ID as indeterminate", async () => {
    const base = fixture();
    const input = fixture({
      observer: {
        ...base.observer,
        repository: vi.fn(() => ok({ ...configuration, rulesetId: "77" as unknown as number })),
      },
    });
    const result = await admitPackPublication(input);
    expect(result).toMatchObject({
      ok: false,
      status: "indeterminate",
      reason: "repository_observation_schema_invalid",
      remoteWrites: 0,
      approvalConsumes: 0,
    });
    expect(input.observer.repository).toHaveBeenCalledTimes(1);
    expect(input.observer.pullRequest).not.toHaveBeenCalled();
    expect(input.observer.review).not.toHaveBeenCalled();
    expect(input.observer.checks).not.toHaveBeenCalled();
    expect(input.observer.mergeBase).not.toHaveBeenCalled();
    expect(input.observer.staging).not.toHaveBeenCalled();
    expect(input.ledger.appendObservation).not.toHaveBeenCalled();
    expect(input.ledger.append).not.toHaveBeenCalled();
  });

  it("U-PACKPUB-ADM-104 uses the sealed staging expected-main OID, not a caller-supplied OID", async () => {
    const baseInput = fixture();
    const expectedMainOid = receipt.identity.baseOid;
    const callerSuppliedExpectedMainOid = oid("9");
    const input = Object.assign(baseInput, {
      expectedMainOid: callerSuppliedExpectedMainOid,
    });

    const result = await admitPackPublication(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(input.observer.mergeBase).toHaveBeenCalledWith({
      headOid: receipt.identity.headOid,
      expectedMainOid,
    });
    expect(result.record.sealed.expectedMainOid).toBe(expectedMainOid);
    expect(result.record.publicationIntentIdentity).toBe(
      derivePackPublicationAdmissionIntentIdentity({
        operationId: receipt.binding.operationId,
        repositoryId: configuration.repositoryId,
        targetRef: configuration.targetRef,
        expectedMainOid,
        reviewedHead: receipt.identity.headOid,
        preparationReceiptDigest: derivePackPublicationPreparationReceiptDigest(receipt),
      }),
    );
    expect(result.record.sealed.expectedMainOid).not.toBe(callerSuppliedExpectedMainOid);

    type CallerCanSetExpectedMainOid = "expectedMainOid" extends keyof PackPublicationAdmissionInput
      ? true
      : false;
    const callerCanSetExpectedMainOid: CallerCanSetExpectedMainOid = false;
    expect(callerCanSetExpectedMainOid).toBe(false);
  });

  it("U-PACKPUB-ADM-105 rejects an approval whose observed intent binding was changed", async () => {
    const input = fixture({
      approvals: [{ ...fixture().approvals[0], intentBindingDigest: sha("9") }],
    });
    const result = await admitPackPublication(input);
    expect(result).toMatchObject({
      ok: false,
      status: "denied",
      reason: "admission_approval_binding_mismatch",
      remoteWrites: 0,
      approvalConsumes: 0,
    });
  });

  it("U-PACKPUB-ADM-057 changes the approval binding when only the approval nonce changes", () => {
    const publicationIntentIdentity = sha("8");
    const first = derivePackPublicationAdmissionApprovalBinding({
      nonce: "apv-adm-fixture-0001",
      publicationIntentIdentity,
    });
    const second = derivePackPublicationAdmissionApprovalBinding({
      nonce: "apv-adm-fixture-0002",
      publicationIntentIdentity,
    });

    expect(publicationIntentIdentity).toBe(sha("8"));
    expect(first).not.toBe(second);
  });

  it("U-PACKPUB-ADM-013 rejects a reused operation ID with a different observation bundle", async () => {
    const seeded = fixture();
    expect((await admitPackPublication(seeded)).status).toBe("admitted");
    vi.mocked(seeded.ledger.append).mockClear();
    vi.mocked(seeded.ledger.appendObservation).mockClear();

    const input = fixture(
      { ledger: seeded.ledger },
      {
        operationId: "op-adm-fixture-0001",
        idempotencyKey: "idem-adm-fixture-0002",
        pullRequest: "4243",
      },
    );
    await expectAdmissionDeny(input, "admission_operation_replay");
  });

  it("U-PACKPUB-ADM-014 rejects a reused idempotency key with a different observation bundle", async () => {
    const seeded = fixture();
    expect((await admitPackPublication(seeded)).status).toBe("admitted");
    vi.mocked(seeded.ledger.append).mockClear();
    vi.mocked(seeded.ledger.appendObservation).mockClear();

    const input = fixture(
      { ledger: seeded.ledger },
      {
        operationId: "op-adm-fixture-0002",
        idempotencyKey: "idem-adm-fixture-0001",
        pullRequest: "4243",
      },
    );
    await expectAdmissionDeny(input, "admission_idempotency_replay");
  });

  it("U-PACKPUB-ADM-015 rejects reusing a PR under a different operation", async () => {
    const seeded = fixture();
    expect((await admitPackPublication(seeded)).status).toBe("admitted");
    vi.mocked(seeded.ledger.append).mockClear();
    vi.mocked(seeded.ledger.appendObservation).mockClear();

    const input = fixture(
      { ledger: seeded.ledger },
      { operationId: "op-adm-fixture-0002", idempotencyKey: "idem-adm-fixture-0002" },
    );
    await expectAdmissionDeny(input, "admission_pr_replay");
  });

  it("U-PACKPUB-ADM-020 rejects a reused PR with a different expected main OID", async () => {
    const seeded = fixture();
    expect((await admitPackPublication(seeded)).status).toBe("admitted");
    vi.mocked(seeded.ledger.append).mockClear();
    vi.mocked(seeded.ledger.appendObservation).mockClear();

    const input = fixture(
      { ledger: seeded.ledger },
      {
        operationId: "op-adm-fixture-0002",
        idempotencyKey: "idem-adm-fixture-0002",
        expectedMainOid: oid("9"),
      },
    );
    await expectAdmissionDeny(input, "admission_pr_expected_main_conflict");
  });
});
