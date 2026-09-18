import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendCutoverTransition,
  type CutoverCommandInput,
  CutoverTransitionError,
  type CutoverValidationPorts,
  cutoverAdmissionReceiptDigest,
  cutoverAdmissionRecordDigest,
  cutoverEvidenceReceiptDigest,
  cutoverEvidenceRecordDigest,
  cutoverTransitionReceiptDigest,
  initializeCutoverChain,
  projectCutoverState,
} from "../src/runtime/cutover-transition.ts";
import {
  CUTOVER_ADMISSION_PRODUCER_MAP,
  CUTOVER_EVIDENCE_REGISTRY,
  type CutoverAdmissionReceipt,
  type ImplementedCutoverEdgeId,
  type SliceEvidenceReceipt,
} from "../src/schema/cutover-transition.ts";

const roots: string[] = [];
const nodeRequire = createRequire(resolve("package.json"));
const candidate = `git-sha1:${"1".repeat(40)}`;
const producerAncestor = `git-sha1:${"2".repeat(40)}`;
const artifactDigest = `sha256:${"3".repeat(64)}`;
const l6Digest = "4".repeat(64);
const q0Digest = "5".repeat(64);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "ut-cutover-"));
  roots.push(value);
  return value;
}

function ports(overrides: Partial<CutoverValidationPorts> = {}): CutoverValidationPorts {
  return {
    attestationVerifier: { verify: () => true },
    isAncestor: () => true,
    validateReferencedReceipt: () => true,
    validateDirectReceipt: () => true,
    ...overrides,
  };
}

function attestation(authorityId: string) {
  return {
    schemaVersion: "evidence-attestation/v1" as const,
    algorithm: "hmac-sha256" as const,
    authorityId,
    keyVersion: "v1",
    signature: "test-signature",
  };
}

function admission(edgeId: ImplementedCutoverEdgeId, priorDigest: string): CutoverAdmissionReceipt {
  const authority = CUTOVER_ADMISSION_PRODUCER_MAP[edgeId];
  const core = {
    schema_version: "cutover-admission.v1" as const,
    edge_id: edgeId,
    candidate_head: candidate,
    artifact_digest: artifactDigest,
    prior_validated_receipt_digest: priorDigest,
    l6_confirmation_receipt_digest: l6Digest,
    execution_mode: "hybrid" as const,
    decision: "approved" as const,
    producer_owner_id: authority.producerOwnerId,
    attestation_producer: authority.attestationProducer,
    authority_id: authority.authorityId,
  };
  const record_digest = cutoverAdmissionRecordDigest(core);
  const signed = { ...core, record_digest, attestation: attestation(authority.authorityId) };
  return { ...signed, receipt_digest: cutoverAdmissionReceiptDigest(signed) };
}

function resignAdmission(
  receipt: CutoverAdmissionReceipt,
  authorityId: string,
): CutoverAdmissionReceipt {
  const {
    record_digest: _recordDigest,
    attestation: _attestation,
    receipt_digest: _receiptDigest,
    ...unsignedReceipt
  } = receipt;
  const unsigned = { ...unsignedReceipt, authority_id: authorityId };
  const record_digest = cutoverAdmissionRecordDigest(unsigned);
  const signed = { ...unsigned, record_digest, attestation: attestation(authorityId) };
  return { ...signed, receipt_digest: cutoverAdmissionReceiptDigest(signed) };
}

function resignAdmissionAuthorityOnly(
  receipt: CutoverAdmissionReceipt,
  authorityId: string,
): CutoverAdmissionReceipt {
  const {
    record_digest: _recordDigest,
    receipt_digest: _receiptDigest,
    ...unsignedReceipt
  } = receipt;
  const unsigned = { ...unsignedReceipt, authority_id: authorityId };
  const record_digest = cutoverAdmissionRecordDigest(unsigned);
  const signed = { ...unsigned, record_digest, attestation: receipt.attestation };
  return { ...signed, receipt_digest: cutoverAdmissionReceiptDigest(signed) };
}

function resignAdmissionAttestationOnly(
  receipt: CutoverAdmissionReceipt,
  authorityId: string,
): CutoverAdmissionReceipt {
  const {
    record_digest: _recordDigest,
    receipt_digest: _receiptDigest,
    ...unsignedReceipt
  } = receipt;
  const record_digest = cutoverAdmissionRecordDigest(unsignedReceipt);
  const signed = { ...unsignedReceipt, record_digest, attestation: attestation(authorityId) };
  return { ...signed, receipt_digest: cutoverAdmissionReceiptDigest(signed) };
}

function evidenceReceipt(
  edgeId: ImplementedCutoverEdgeId,
  kind: SliceEvidenceReceipt["kind_id"],
  producer: string,
  revisionRule: "candidate-head" | "producer-ancestor",
  admissionReceipt: CutoverAdmissionReceipt,
): SliceEvidenceReceipt {
  const reference =
    kind === "review.bundle"
      ? {
          reference_kind: "review-bundle" as const,
          referenced_receipt_digest: "6".repeat(64),
          payload_object_receipt_digest: null,
          payload_digest: null,
        }
      : kind === "admission.approved"
        ? {
            reference_kind: "cutover-admission" as const,
            referenced_receipt_digest: admissionReceipt.receipt_digest,
            payload_object_receipt_digest: null,
            payload_digest: null,
          }
        : {
            reference_kind: "payload-object" as const,
            referenced_receipt_digest: null,
            payload_object_receipt_digest:
              kind === "design.l6-confirmed" ? l6Digest : "7".repeat(64),
            payload_digest: `sha256:${"8".repeat(64)}`,
          };
  const core = {
    schema_version: "cutover-evidence.v1" as const,
    edge_id: edgeId,
    kind_id: kind,
    producer_owner_id: producer,
    attestation_producer: "ci" as const,
    subject_revision: revisionRule === "candidate-head" ? candidate : producerAncestor,
    success: true,
    ...reference,
  };
  const unsigned = {
    ...core,
    record_digest: "".padStart(64, "0"),
    attestation: attestation("evidence"),
  };
  const record_digest = cutoverEvidenceRecordDigest(unsigned);
  const signed = { ...core, record_digest, attestation: attestation("evidence") };
  return { ...signed, receipt_digest: cutoverEvidenceReceiptDigest(signed) };
}

function resignEvidence(
  receipt: SliceEvidenceReceipt,
  overrides: Partial<
    Omit<SliceEvidenceReceipt, "record_digest" | "attestation" | "receipt_digest">
  >,
): SliceEvidenceReceipt {
  const {
    record_digest: _recordDigest,
    attestation: previousAttestation,
    receipt_digest: _receiptDigest,
    ...unsignedReceipt
  } = receipt;
  const unsigned = { ...unsignedReceipt, ...overrides };
  const record_digest = cutoverEvidenceRecordDigest(unsigned);
  const signed = { ...unsigned, record_digest, attestation: previousAttestation };
  return { ...signed, receipt_digest: cutoverEvidenceReceiptDigest(signed) };
}

function command(
  repoRoot: string,
  edgeId: ImplementedCutoverEdgeId,
  sequence: number,
  previous: string | null,
  overrides: Partial<CutoverCommandInput> = {},
): CutoverCommandInput {
  const prior = previous ?? q0Digest;
  const admissionReceipt = admission(edgeId, prior);
  const evidence = CUTOVER_EVIDENCE_REGISTRY[edgeId].map(([kind, producer, revisionRule]) =>
    evidenceReceipt(edgeId, kind, producer, revisionRule, admissionReceipt),
  );
  return {
    repoRoot,
    edgeId,
    sequence,
    subjectRevision: candidate,
    artifactDigest,
    executionMode: "hybrid",
    expectedPreviousReceiptDigest: previous,
    admissionPriorReceiptDigest: prior,
    evidence,
    admission: admissionReceipt,
    ports: ports(),
    ...overrides,
  };
}

function expectReason(action: () => unknown, reason: string): void {
  try {
    action();
    throw new Error("expected cutover failure");
  } catch (error) {
    expect(error).toBeInstanceOf(CutoverTransitionError);
    expect((error as CutoverTransitionError).reason).toBe(reason);
  }
}

function overwriteStoredEvidence(
  repoRoot: string,
  evidence: readonly SliceEvidenceReceipt[],
): void {
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (
      path: string,
    ) => {
      prepare(sql: string): { run(...params: unknown[]): unknown };
      close(): void;
    };
  };
  const db = new DatabaseSync(resolve(repoRoot, ".ut-tdd", "ledger", "cutover-ledger.db"));
  try {
    db.prepare("UPDATE cutover_receipts SET evidence_json=? WHERE sequence=0").run(
      JSON.stringify(evidence),
    );
  } finally {
    db.close();
  }
}

function overwriteStoredHead(repoRoot: string, sequence: number, receiptDigest: string): void {
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (
      path: string,
    ) => {
      prepare(sql: string): { run(...params: unknown[]): unknown };
      close(): void;
    };
  };
  const db = new DatabaseSync(resolve(repoRoot, ".ut-tdd", "ledger", "cutover-ledger.db"));
  try {
    db.prepare("UPDATE cutover_head SET sequence=?, receipt_digest=? WHERE singleton=1").run(
      sequence,
      receiptDigest,
    );
  } finally {
    db.close();
  }
}

function storedReceiptCount(repoRoot: string): number {
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (
      path: string,
    ) => {
      prepare(sql: string): { get(): unknown };
      close(): void;
    };
  };
  const db = new DatabaseSync(resolve(repoRoot, ".ut-tdd", "ledger", "cutover-ledger.db"));
  try {
    return (db.prepare("SELECT COUNT(*) AS count FROM cutover_receipts").get() as { count: number })
      .count;
  } finally {
    db.close();
  }
}

function evidenceForAdmission(
  evidence: readonly SliceEvidenceReceipt[],
  admissionReceipt: CutoverAdmissionReceipt,
): SliceEvidenceReceipt[] {
  return evidence.map((item) =>
    item.kind_id === "admission.approved"
      ? resignEvidence(item, { referenced_receipt_digest: admissionReceipt.receipt_digest })
      : item,
  );
}

describe("PLAN-L6-93 cutover prefix", () => {
  it("U-CUTOVER-001 initializes genesis exactly once and projects committed state", () => {
    const repoRoot = root();
    expect(projectCutoverState([])).toEqual({
      state: "uninitialized",
      sequence: null,
      receiptDigest: null,
    });
    const receipt = initializeCutoverChain(command(repoRoot, "cutover.genesis", 0, null));
    expect(projectCutoverState([receipt])).toEqual({
      state: "inventory_frozen",
      sequence: 0,
      receiptDigest: receipt.receipt_digest,
    });
    expectReason(
      () => initializeCutoverChain(command(repoRoot, "cutover.genesis", 0, null)),
      "cutover-genesis-already-initialized",
    );
  });

  it("U-CUTOVER-002 folds only the four adjacent prefix edges", () => {
    const repoRoot = root();
    const receipts = [initializeCutoverChain(command(repoRoot, "cutover.genesis", 0, null))];
    for (const edge of [
      "cutover.inventory-frozen.node-shadow",
      "cutover.node-shadow.node-primary",
      "cutover.node-primary.bun-removed",
    ] as const) {
      receipts.push(
        appendCutoverTransition(
          command(repoRoot, edge, receipts.length, receipts.at(-1)?.receipt_digest ?? null),
        ),
      );
    }
    expect(projectCutoverState(receipts).state).toBe("bun_removed");
  });

  it("U-CUTOVER-003 rejects wrong evidence owner and non-ancestor evidence", () => {
    const repoRoot = root();
    expectReason(
      () =>
        appendCutoverTransition(
          command(repoRoot, "cutover.inventory-frozen.node-shadow", 1, "a".repeat(64)),
        ),
      "cutover-chain-uninitialized",
    );
    const initialized = initializeCutoverChain(command(repoRoot, "cutover.genesis", 0, null));
    const validNext = command(
      repoRoot,
      "cutover.inventory-frozen.node-shadow",
      1,
      initialized.receipt_digest,
    );
    const wrongOwner = validNext.evidence.map((entry, index) =>
      index === 0 ? resignEvidence(entry, { producer_owner_id: "wrong-owner" }) : entry,
    );
    expectReason(
      () => appendCutoverTransition({ ...validNext, evidence: wrongOwner }),
      "cutover-admission-not-ready",
    );
    expectReason(
      () =>
        appendCutoverTransition({
          ...command(
            repoRoot,
            "cutover.inventory-frozen.node-shadow",
            1,
            initialized.receipt_digest,
          ),
          ports: ports({ isAncestor: () => false }),
        }),
      "cutover-revision-mismatch",
    );
    expect(projectCutoverState([initialized]).state).toBe("inventory_frozen");
  });

  it("U-CUTOVER-004 rejects wrong admission authority and untrusted attestation", () => {
    const repoRoot = root();
    const base = command(repoRoot, "cutover.genesis", 0, null);
    const wrongAuthority = resignAdmissionAuthorityOnly(base.admission, "wrong");
    expectReason(
      () =>
        initializeCutoverChain({
          ...base,
          admission: wrongAuthority,
          evidence: evidenceForAdmission(base.evidence, wrongAuthority),
        }),
      "cutover-admission-not-ready",
    );

    const wrongAttestation = resignAdmissionAttestationOnly(base.admission, "wrong-attestation");
    expectReason(
      () =>
        initializeCutoverChain({
          ...base,
          admission: wrongAttestation,
          evidence: evidenceForAdmission(base.evidence, wrongAttestation),
        }),
      "cutover-admission-not-ready",
    );
    expect(projectCutoverState([]).state).toBe("uninitialized");

    const modeDrift = resignAdmission(
      { ...base.admission, execution_mode: "codex-only" },
      base.admission.authority_id,
    );
    expectReason(
      () =>
        initializeCutoverChain({
          ...base,
          admission: modeDrift,
          evidence: evidenceForAdmission(base.evidence, modeDrift),
        }),
      "cutover-admission-not-ready",
    );

    const priorDrift = resignAdmission(
      { ...base.admission, prior_validated_receipt_digest: "9".repeat(64) },
      base.admission.authority_id,
    );
    const evidenceForPriorDrift = evidenceForAdmission(base.evidence, priorDrift);
    expectReason(
      () =>
        initializeCutoverChain({
          ...base,
          admission: priorDrift,
          evidence: evidenceForPriorDrift,
        }),
      "cutover-admission-not-ready",
    );
    expectReason(
      () =>
        initializeCutoverChain({
          ...base,
          ports: ports({
            attestationVerifier: {
              verify: (_input, value) => value.authorityId !== base.admission.authority_id,
            },
          }),
        }),
      "cutover-admission-not-ready",
    );
  });

  it("U-CUTOVER-005 rejects skip, stale head, replay, and an actual CAS loser without append", () => {
    const repoRoot = root();
    const genesis = initializeCutoverChain(command(repoRoot, "cutover.genesis", 0, null));
    expectReason(
      () =>
        appendCutoverTransition(
          command(repoRoot, "cutover.node-shadow.node-primary", 1, genesis.receipt_digest),
        ),
      "cutover-transition-invalid",
    );
    const shadow = appendCutoverTransition(
      command(repoRoot, "cutover.inventory-frozen.node-shadow", 1, genesis.receipt_digest),
    );
    const staleContender = command(
      repoRoot,
      "cutover.node-shadow.node-primary",
      2,
      shadow.receipt_digest,
    );
    const primary = appendCutoverTransition(staleContender);
    expectReason(() => appendCutoverTransition(staleContender), "cutover-write-conflict");
    expect(storedReceiptCount(repoRoot)).toBe(3);
    expectReason(
      () =>
        appendCutoverTransition(
          command(repoRoot, "cutover.inventory-frozen.node-shadow", 3, primary.receipt_digest),
        ),
      "cutover-transition-invalid",
    );
    expect(projectCutoverState([genesis, shadow, primary]).state).toBe("node_primary");
  });

  it("rejects an unsupported sealed edge before any ledger write", () => {
    const repoRoot = root();
    const genesis = initializeCutoverChain(command(repoRoot, "cutover.genesis", 0, null));
    expectReason(
      () =>
        appendCutoverTransition({
          ...command(repoRoot, "cutover.node-primary.bun-removed", 1, genesis.receipt_digest),
          edgeId: "cutover.bun-removed.sealed" as unknown as ImplementedCutoverEdgeId,
        }),
      "cutover-transition-invalid",
    );
    expect(storedReceiptCount(repoRoot)).toBe(1);
  });

  it("U-CUTOVER-006 detects independent receipt digest mutation", () => {
    const repoRoot = root();
    const base = command(repoRoot, "cutover.genesis", 0, null);
    const mutated = base.evidence.map((entry, index) =>
      index === 0 ? { ...entry, payload_digest: `sha256:${"9".repeat(64)}` } : entry,
    );
    expectReason(
      () => initializeCutoverChain({ ...base, evidence: mutated }),
      "cutover-admission-not-ready",
    );
    expect(projectCutoverState([]).state).toBe("uninitialized");

    const admissionRecordMutation = {
      ...base.admission,
      record_digest: "f".repeat(64),
    };
    const admissionRecordMutationWithReceipt = {
      ...admissionRecordMutation,
      receipt_digest: cutoverAdmissionReceiptDigest(admissionRecordMutation),
    };
    expectReason(
      () =>
        initializeCutoverChain({
          ...base,
          admission: admissionRecordMutationWithReceipt,
          evidence: evidenceForAdmission(base.evidence, admissionRecordMutationWithReceipt),
        }),
      "cutover-admission-not-ready",
    );

    const admissionReceiptMutation = {
      ...base.admission,
      receipt_digest: "e".repeat(64),
    };
    expectReason(
      () =>
        initializeCutoverChain({
          ...base,
          admission: admissionReceiptMutation,
          evidence: evidenceForAdmission(base.evidence, admissionReceiptMutation),
        }),
      "cutover-admission-not-ready",
    );

    const receipt = initializeCutoverChain(command(root(), "cutover.genesis", 0, null));
    expect(() => projectCutoverState([{ ...receipt, receipt_digest: "f".repeat(64) }])).toThrow(
      "cutover-chain-invalid",
    );

    const storedRoot = root();
    const storedCommand = command(storedRoot, "cutover.genesis", 0, null);
    const storedGenesis = initializeCutoverChain(storedCommand);
    const storedMutation = storedCommand.evidence.map((entry, index) =>
      index === 0 ? { ...entry, success: false } : entry,
    );
    overwriteStoredEvidence(storedRoot, storedMutation);
    expectReason(
      () =>
        appendCutoverTransition(
          command(
            storedRoot,
            "cutover.inventory-frozen.node-shadow",
            1,
            storedGenesis.receipt_digest,
          ),
        ),
      "cutover-chain-invalid",
    );
  });

  it("U-CUTOVER-007 produces deterministic framed digests", () => {
    const first = initializeCutoverChain(command(root(), "cutover.genesis", 0, null));
    const second = initializeCutoverChain(command(root(), "cutover.genesis", 0, null));
    expect(first).toEqual(second);
    const { receipt_digest: _receiptDigest, ...unsigned } = first;
    expect(first.receipt_digest).toBe(cutoverTransitionReceiptDigest(unsigned));

    const base = command(root(), "cutover.genesis", 0, null).admission;
    const reorderedAttestation = {
      signature: base.attestation.signature,
      keyVersion: base.attestation.keyVersion,
      authorityId: base.attestation.authorityId,
      algorithm: base.attestation.algorithm,
      schemaVersion: base.attestation.schemaVersion,
    };
    expect(cutoverAdmissionReceiptDigest({ ...base, attestation: reorderedAttestation })).toBe(
      base.receipt_digest,
    );
  });

  it("U-CUTOVER-008 rolls back a fault after receipt insert", () => {
    const repoRoot = root();
    expectReason(
      () =>
        initializeCutoverChain({
          ...command(repoRoot, "cutover.genesis", 0, null),
          faultAfterReceiptInsert: true,
        }),
      "cutover-atomic-commit-failed",
    );
    expect(initializeCutoverChain(command(repoRoot, "cutover.genesis", 0, null)).sequence).toBe(0);
  });

  it("U-CUTOVER-009 fails closed when L6/Q0 reference authority is absent", () => {
    const repoRoot = root();
    const base = command(repoRoot, "cutover.genesis", 0, null);
    expectReason(
      () =>
        initializeCutoverChain({ ...base, ports: ports({ validateDirectReceipt: () => false }) }),
      "cutover-admission-not-ready",
    );
    expectReason(
      () =>
        initializeCutoverChain({
          ...base,
          ports: ports({ validateReferencedReceipt: () => false }),
        }),
      "cutover-admission-not-ready",
    );

    const sliceAdmissionReplay = base.evidence.map((item) =>
      item.kind_id === "admission.approved"
        ? resignEvidence(item, { referenced_receipt_digest: q0Digest })
        : item,
    );
    expectReason(
      () => initializeCutoverChain({ ...base, evidence: sliceAdmissionReplay }),
      "cutover-admission-not-ready",
    );
    expect(projectCutoverState([]).state).toBe("uninitialized");
  });
  it("U-CUTOVER-003 rejects a registry-kind mutation and an evidence-count mutation with every other field re-signed", () => {
    const base = command(root(), "cutover.genesis", 0, null);
    // kind_id だけを別の登録 kind へ差し替える (reference shape は同じ kind 同士を選び、digest は再署名する)。
    // registry の kind 照合以外は全て正当なので、ここで落ちるのは kind 照合だけである。
    const pair = base.evidence.flatMap((a) =>
      base.evidence
        .filter((b) => b.kind_id !== a.kind_id && b.reference_kind === a.reference_kind)
        .map((b) => [a, b] as const),
    )[0];
    if (!pair) throw new Error("registry must hold two kinds with the same reference shape");
    const [target, donor] = pair;
    const kindMutation = base.evidence.map((item) =>
      item === target ? resignEvidence(item, { kind_id: donor.kind_id }) : item,
    );
    expectReason(
      () => initializeCutoverChain({ ...base, evidence: kindMutation }),
      "cutover-admission-not-ready",
    );
    // 件数だけを変える: 1 件欠落 / 正当な 1 件の重複追加。どちらも registry 件数照合で落ちる。
    expectReason(
      () => initializeCutoverChain({ ...base, evidence: base.evidence.slice(1) }),
      "cutover-admission-not-ready",
    );
    expectReason(
      () => initializeCutoverChain({ ...base, evidence: [...base.evidence, base.evidence[0]] }),
      "cutover-admission-not-ready",
    );
    expect(initializeCutoverChain(base).sequence).toBe(0);
  });

  it("U-CUTOVER-006 rejects a re-signed exit-success mutation and a direct head projection edit", () => {
    const base = command(root(), "cutover.genesis", 0, null);
    // success=false を record/receipt digest ごと再署名する。digest 照合は通るので、
    // ここで落ちるのは exit-success 述語だけである (述語を削ると本 case が Red になる)。
    const successMutation = base.evidence.map((item, index) =>
      index === 0 ? resignEvidence(item, { success: false }) : item,
    );
    expectReason(
      () => initializeCutoverChain({ ...base, evidence: successMutation }),
      "cutover-admission-not-ready",
    );

    // projection (cutover_head) を直接書き換えても authority は生まれず、fork も隠せない。
    const editedRoot = root();
    const genesis = initializeCutoverChain(command(editedRoot, "cutover.genesis", 0, null));
    overwriteStoredHead(editedRoot, 1, "f".repeat(64));
    expectReason(
      () =>
        appendCutoverTransition(
          command(editedRoot, "cutover.inventory-frozen.node-shadow", 1, genesis.receipt_digest),
        ),
      "cutover-write-conflict",
    );
    expect(storedReceiptCount(editedRoot)).toBe(1);

    const forkedRoot = root();
    const forkedGenesis = initializeCutoverChain(command(forkedRoot, "cutover.genesis", 0, null));
    overwriteStoredHead(forkedRoot, 0, "a".repeat(64));
    expectReason(
      () =>
        appendCutoverTransition(
          command(
            forkedRoot,
            "cutover.inventory-frozen.node-shadow",
            1,
            forkedGenesis.receipt_digest,
          ),
        ),
      "cutover-write-conflict",
    );
    expect(storedReceiptCount(forkedRoot)).toBe(1);
  });
  it("U-CUTOVER-003 rejects a candidate-head row whose subject is swapped to the producer ancestor, and U-CUTOVER-005 rejects an artifact digest that differs from the admission", () => {
    const base = command(root(), "cutover.genesis", 0, null);
    // candidate-head rule の row の subject_revision だけを producer ancestor へ入れ替え、digest を再署名する。
    // isAncestor port は true のままなので、ここで落ちるのは candidate-head の等値照合だけである。
    const candidateRows = CUTOVER_EVIDENCE_REGISTRY["cutover.genesis"]
      .filter(([, , rule]) => rule === "candidate-head")
      .map(([kind]) => kind);
    if (candidateRows.length === 0)
      throw new Error("genesis registry must hold a candidate-head row");
    const swappedSubject = base.evidence.map((item) =>
      item.kind_id === candidateRows[0]
        ? resignEvidence(item, { subject_revision: producerAncestor })
        : item,
    );
    expectReason(
      () => initializeCutoverChain({ ...base, evidence: swappedSubject }),
      "cutover-revision-mismatch",
    );
    // command の artifact digest だけを admission と食い違わせる。admission 自体は正当に署名されたまま。
    expectReason(
      () => initializeCutoverChain({ ...base, artifactDigest: `sha256:${"9".repeat(64)}` }),
      "cutover-admission-not-ready",
    );
    expect(initializeCutoverChain(base).sequence).toBe(0);
  });
  it("U-CUTOVER-004 rejects a non-genesis admission whose prior closure is self-consistent but not the ledger head", () => {
    const repoRoot = root();
    const genesis = initializeCutoverChain(command(repoRoot, "cutover.genesis", 0, null));
    const next = command(
      repoRoot,
      "cutover.inventory-frozen.node-shadow",
      1,
      genesis.receipt_digest,
    );
    // 正当に署名された admission を、head ではない prior (fork 側 / 古い receipt) で再署名し、command 側の
    // 申告値もそれに合わせる。申告値どうしの自己整合は成立するので、ここで落ちるのは ledger head との照合だけである。
    const stalePrior = "9".repeat(64);
    const replayedAdmission = resignAdmission(
      { ...next.admission, prior_validated_receipt_digest: stalePrior },
      next.admission.authority_id,
    );
    expectReason(
      () =>
        appendCutoverTransition({
          ...next,
          admissionPriorReceiptDigest: stalePrior,
          admission: replayedAdmission,
          evidence: evidenceForAdmission(next.evidence, replayedAdmission),
        }),
      "cutover-admission-not-ready",
    );
    expect(storedReceiptCount(repoRoot)).toBe(1);
    expect(appendCutoverTransition(next).sequence).toBe(1);
  });
});
