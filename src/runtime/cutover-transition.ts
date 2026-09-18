import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import {
  CUTOVER_ADMISSION_PRODUCER_MAP,
  CUTOVER_EVIDENCE_REGISTRY,
  CUTOVER_REGISTRY_ID,
  type CutoverAdmissionReceipt,
  type CutoverExecutionMode,
  type CutoverState,
  type CutoverTransitionReceipt,
  canonicalizeCutoverValue,
  cutoverAdmissionReceiptSchema,
  cutoverTransitionReceiptSchema,
  type ImplementedCutoverEdgeId,
  implementedCutoverEdgeIdSchema,
  type SliceEvidenceReceipt,
  sliceEvidenceReceiptSchema,
} from "../schema/cutover-transition.ts";

const nodeRequire = createRequire(import.meta.url);

export type CutoverFailureReason =
  | "cutover-genesis-already-initialized"
  | "cutover-chain-uninitialized"
  | "cutover-transition-invalid"
  | "cutover-revision-mismatch"
  | "cutover-admission-not-ready"
  | "cutover-chain-invalid"
  | "cutover-write-conflict"
  | "cutover-atomic-commit-failed";

export class CutoverTransitionError extends Error {
  readonly reason: CutoverFailureReason;

  constructor(reason: CutoverFailureReason) {
    super(reason);
    this.name = "CutoverTransitionError";
    this.reason = reason;
  }
}

/**
 * Cutover ledgerはPlan Assetのportを逆参照しない。ここで必要なのは署名入力を
 * 検証できる最小の構造だけであり、runtime→plan-asset edgeを持ち込まない。
 */
interface CutoverAttestationVerifier {
  verify(
    input: { readonly producer: "ci"; readonly recordDigest: string },
    attestation: {
      readonly schemaVersion: "evidence-attestation/v1";
      readonly algorithm: "hmac-sha256";
      readonly authorityId: string;
      readonly keyVersion: string;
      readonly signature: string;
    },
  ): boolean;
}

export interface CutoverValidationPorts {
  readonly attestationVerifier: CutoverAttestationVerifier;
  readonly isAncestor: (producerRevision: string, candidateRevision: string) => boolean;
  readonly validateReferencedReceipt: (
    evidence: SliceEvidenceReceipt,
    expected:
      | "review-bundle"
      | "cutover-admission"
      | "payload-object"
      | "l6-confirmation"
      | "q0-slice-admission"
      | "prior-cutover",
  ) => boolean;
  readonly validateDirectReceipt: (
    receiptDigest: string,
    expected: "l6-confirmation" | "q0-slice-admission" | "prior-cutover",
    candidateRevision: string,
  ) => boolean;
}

export interface CutoverCommandInput {
  readonly repoRoot: string;
  readonly edgeId: ImplementedCutoverEdgeId;
  readonly sequence: number;
  readonly subjectRevision: string;
  readonly artifactDigest: string;
  readonly executionMode: CutoverExecutionMode;
  readonly expectedPreviousReceiptDigest: string | null;
  readonly admissionPriorReceiptDigest: string;
  readonly evidence: readonly SliceEvidenceReceipt[];
  readonly admission: CutoverAdmissionReceipt;
  readonly ports: CutoverValidationPorts;
  readonly faultAfterReceiptInsert?: boolean;
}

export interface CutoverProjection {
  readonly state: "uninitialized" | CutoverState;
  readonly sequence: number | null;
  readonly receiptDigest: string | null;
}

const EDGE_STATES: Record<
  ImplementedCutoverEdgeId,
  { readonly previous: CutoverState | null; readonly current: CutoverState }
> = {
  "cutover.genesis": { previous: null, current: "inventory_frozen" },
  "cutover.inventory-frozen.node-shadow": {
    previous: "inventory_frozen",
    current: "node_shadow",
  },
  "cutover.node-shadow.node-primary": { previous: "node_shadow", current: "node_primary" },
  "cutover.node-primary.bun-removed": { previous: "node_primary", current: "bun_removed" },
};

interface StatementResult {
  readonly changes?: number;
}

interface Statement {
  run(...params: unknown[]): StatementResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface Database {
  exec(sql: string): unknown;
  prepare(sql: string): Statement;
  close(): void;
}

interface StoredRow {
  readonly sequence: number;
  readonly receipt_digest: string;
  readonly payload: string;
  readonly evidence_json: string;
  readonly admission_json: string;
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function frame(value: unknown): Buffer {
  const canonical = canonicalizeCutoverValue(value);
  if (canonical === null) throw new CutoverTransitionError("cutover-admission-not-ready");
  const bytes = Buffer.from(canonical, "utf8");
  return Buffer.concat([Buffer.from(`${bytes.length}:`, "ascii"), bytes]);
}

function framedDigest(values: readonly unknown[]): string {
  return sha256(Buffer.concat(values.map(frame)));
}

export function cutoverAdmissionRecordDigest(
  receipt: Omit<CutoverAdmissionReceipt, "record_digest" | "attestation" | "receipt_digest">,
): string {
  return framedDigest([
    [
      receipt.schema_version,
      receipt.edge_id,
      receipt.candidate_head,
      receipt.artifact_digest,
      receipt.prior_validated_receipt_digest,
      receipt.l6_confirmation_receipt_digest,
      receipt.execution_mode,
      receipt.decision,
      receipt.producer_owner_id,
      receipt.attestation_producer,
      receipt.authority_id,
    ],
  ]);
}

export function cutoverAdmissionReceiptDigest(
  receipt: Omit<CutoverAdmissionReceipt, "receipt_digest">,
): string {
  return framedDigest([
    [
      receipt.schema_version,
      receipt.edge_id,
      receipt.candidate_head,
      receipt.artifact_digest,
      receipt.prior_validated_receipt_digest,
      receipt.l6_confirmation_receipt_digest,
      receipt.execution_mode,
      receipt.decision,
      receipt.producer_owner_id,
      receipt.attestation_producer,
      receipt.authority_id,
      receipt.record_digest,
      receipt.attestation,
    ],
  ]);
}

export function cutoverEvidenceRecordDigest(
  receipt: Omit<SliceEvidenceReceipt, "record_digest" | "attestation" | "receipt_digest">,
): string {
  return framedDigest([
    [
      receipt.schema_version,
      receipt.edge_id,
      receipt.kind_id,
      receipt.producer_owner_id,
      receipt.attestation_producer,
      receipt.subject_revision,
      receipt.success,
      receipt.reference_kind,
      receipt.referenced_receipt_digest,
      receipt.payload_object_receipt_digest,
      receipt.payload_digest,
    ],
  ]);
}

export function cutoverEvidenceReceiptDigest(
  receipt: Omit<SliceEvidenceReceipt, "receipt_digest">,
): string {
  return framedDigest([
    [
      receipt.schema_version,
      receipt.edge_id,
      receipt.kind_id,
      receipt.producer_owner_id,
      receipt.attestation_producer,
      receipt.subject_revision,
      receipt.success,
      receipt.reference_kind,
      receipt.referenced_receipt_digest,
      receipt.payload_object_receipt_digest,
      receipt.payload_digest,
      receipt.record_digest,
      receipt.attestation,
    ],
  ]);
}

export function cutoverTransitionReceiptDigest(
  receipt: Omit<CutoverTransitionReceipt, "receipt_digest">,
): string {
  return framedDigest([
    [
      receipt.schema_version,
      receipt.registry_id,
      receipt.transition_id,
      receipt.sequence,
      receipt.subject_revision,
      receipt.previous_state,
      receipt.current_state,
      receipt.evidence_set_digest,
      receipt.review_digest,
      receipt.admission_digest,
      receipt.previous_receipt_digest,
    ],
  ]);
}

function expectedReferenceKind(
  kind: SliceEvidenceReceipt["kind_id"],
): SliceEvidenceReceipt["reference_kind"] {
  if (kind === "review.bundle") return "review-bundle";
  if (kind === "admission.approved") return "cutover-admission";
  return "payload-object";
}

function referenceShapeValid(evidence: SliceEvidenceReceipt): boolean {
  if (evidence.reference_kind === "payload-object")
    return (
      evidence.referenced_receipt_digest === null &&
      evidence.payload_object_receipt_digest !== null &&
      evidence.payload_digest !== null
    );
  return (
    evidence.referenced_receipt_digest !== null &&
    evidence.payload_object_receipt_digest === null &&
    evidence.payload_digest === null
  );
}

function validateEvidence(input: CutoverCommandInput): readonly SliceEvidenceReceipt[] {
  const registry = CUTOVER_EVIDENCE_REGISTRY[input.edgeId];
  if (input.evidence.length !== registry.length)
    throw new CutoverTransitionError("cutover-admission-not-ready");
  const ordered: SliceEvidenceReceipt[] = [];
  const seen = new Set<string>();
  for (let ordinal = 0; ordinal < registry.length; ordinal += 1) {
    const row = registry[ordinal];
    const evidence = input.evidence.find((candidate) => candidate.kind_id === row[0]);
    if (!evidence || !sliceEvidenceReceiptSchema.safeParse(evidence).success)
      throw new CutoverTransitionError("cutover-admission-not-ready");
    const duplicateKey = [
      evidence.edge_id,
      evidence.kind_id,
      evidence.producer_owner_id,
      evidence.attestation_producer,
      evidence.subject_revision,
      evidence.receipt_digest,
    ].join("\0");
    if (seen.has(duplicateKey)) throw new CutoverTransitionError("cutover-admission-not-ready");
    seen.add(duplicateKey);
    if (
      evidence.edge_id !== input.edgeId ||
      evidence.producer_owner_id !== row[1] ||
      evidence.attestation_producer !== "ci" ||
      evidence.success !== true ||
      evidence.reference_kind !== expectedReferenceKind(evidence.kind_id) ||
      !referenceShapeValid(evidence) ||
      evidence.record_digest !== cutoverEvidenceRecordDigest(evidence) ||
      evidence.receipt_digest !== cutoverEvidenceReceiptDigest(evidence) ||
      !input.ports.attestationVerifier.verify(
        { producer: "ci", recordDigest: evidence.record_digest },
        evidence.attestation,
      )
    )
      throw new CutoverTransitionError("cutover-admission-not-ready");
    if (row[2] === "candidate-head") {
      if (evidence.subject_revision !== input.subjectRevision)
        throw new CutoverTransitionError("cutover-revision-mismatch");
    } else if (!input.ports.isAncestor(evidence.subject_revision, input.subjectRevision)) {
      throw new CutoverTransitionError("cutover-revision-mismatch");
    }
    const expectedReference =
      evidence.kind_id === "review.bundle"
        ? "review-bundle"
        : evidence.kind_id === "admission.approved"
          ? "cutover-admission"
          : "payload-object";
    if (!input.ports.validateReferencedReceipt(evidence, expectedReference))
      throw new CutoverTransitionError("cutover-admission-not-ready");
    ordered.push(evidence);
  }
  if (new Set(ordered.map((evidence) => evidence.kind_id)).size !== registry.length)
    throw new CutoverTransitionError("cutover-admission-not-ready");
  return ordered;
}

function validateAdmission(input: CutoverCommandInput): void {
  const receipt = input.admission;
  const expected = CUTOVER_ADMISSION_PRODUCER_MAP[input.edgeId];
  if (
    !cutoverAdmissionReceiptSchema.safeParse(receipt).success ||
    receipt.edge_id !== input.edgeId ||
    receipt.candidate_head !== input.subjectRevision ||
    receipt.artifact_digest !== input.artifactDigest ||
    receipt.execution_mode !== input.executionMode ||
    receipt.decision !== "approved" ||
    receipt.prior_validated_receipt_digest !== input.admissionPriorReceiptDigest ||
    receipt.producer_owner_id !== expected.producerOwnerId ||
    receipt.attestation_producer !== expected.attestationProducer ||
    receipt.authority_id !== expected.authorityId ||
    receipt.attestation.authorityId !== expected.authorityId ||
    receipt.attestation.keyVersion !== expected.keyVersion ||
    receipt.record_digest !== cutoverAdmissionRecordDigest(receipt) ||
    receipt.receipt_digest !== cutoverAdmissionReceiptDigest(receipt) ||
    !input.ports.attestationVerifier.verify(
      { producer: "ci", recordDigest: receipt.record_digest },
      receipt.attestation,
    ) ||
    !input.ports.validateDirectReceipt(
      receipt.l6_confirmation_receipt_digest,
      "l6-confirmation",
      input.subjectRevision,
    ) ||
    !input.ports.validateDirectReceipt(
      receipt.prior_validated_receipt_digest,
      input.edgeId === "cutover.genesis" ? "q0-slice-admission" : "prior-cutover",
      input.subjectRevision,
    )
  )
    throw new CutoverTransitionError("cutover-admission-not-ready");
  const admissionEvidence = input.evidence.find(
    (evidence) => evidence.kind_id === "admission.approved",
  );
  const l6Evidence = input.evidence.find((evidence) => evidence.kind_id === "design.l6-confirmed");
  if (
    admissionEvidence?.referenced_receipt_digest !== receipt.receipt_digest ||
    (input.edgeId === "cutover.genesis" &&
      l6Evidence?.payload_object_receipt_digest !== receipt.l6_confirmation_receipt_digest)
  )
    throw new CutoverTransitionError("cutover-admission-not-ready");
}

function evidenceSetDigest(
  edgeId: ImplementedCutoverEdgeId,
  evidence: readonly SliceEvidenceReceipt[],
): string {
  return framedDigest(
    evidence.map((item, ordinal) => [
      item.schema_version,
      CUTOVER_REGISTRY_ID,
      edgeId,
      ordinal,
      item.edge_id,
      item.kind_id,
      item.producer_owner_id,
      item.attestation_producer,
      item.subject_revision,
      item.receipt_digest,
      item.success,
    ]),
  );
}

function buildReceipt(input: CutoverCommandInput): CutoverTransitionReceipt {
  if (!implementedCutoverEdgeIdSchema.safeParse(input.edgeId).success)
    throw new CutoverTransitionError("cutover-transition-invalid");
  const evidence = validateEvidence(input);
  validateAdmission(input);
  const states = EDGE_STATES[input.edgeId];
  const review = evidence.find((item) => item.kind_id === "review.bundle");
  const admission = evidence.find((item) => item.kind_id === "admission.approved");
  if (!review || !admission) throw new CutoverTransitionError("cutover-admission-not-ready");
  const unsigned = {
    schema_version: "cutover-transition.v1" as const,
    registry_id: CUTOVER_REGISTRY_ID,
    transition_id: input.edgeId,
    sequence: input.sequence,
    subject_revision: input.subjectRevision,
    previous_state: states.previous,
    current_state: states.current,
    evidence_set_digest: evidenceSetDigest(input.edgeId, evidence),
    review_digest: review.receipt_digest,
    admission_digest: admission.receipt_digest,
    previous_receipt_digest: input.expectedPreviousReceiptDigest,
  };
  return { ...unsigned, receipt_digest: cutoverTransitionReceiptDigest(unsigned) };
}

export function projectCutoverState(
  receipts: readonly CutoverTransitionReceipt[],
): CutoverProjection {
  if (receipts.length === 0) return { state: "uninitialized", sequence: null, receiptDigest: null };
  let previous: CutoverTransitionReceipt | undefined;
  for (const receipt of receipts) {
    const states = EDGE_STATES[receipt.transition_id];
    if (
      !cutoverTransitionReceiptSchema.safeParse(receipt).success ||
      !states ||
      receipt.sequence !== (previous ? previous.sequence + 1 : 0) ||
      receipt.previous_receipt_digest !== (previous?.receipt_digest ?? null) ||
      receipt.previous_state !== (previous?.current_state ?? null) ||
      receipt.previous_state !== states.previous ||
      receipt.current_state !== states.current ||
      receipt.receipt_digest !== cutoverTransitionReceiptDigest(receipt)
    )
      throw new CutoverTransitionError("cutover-chain-invalid");
    previous = receipt;
  }
  if (!previous) throw new CutoverTransitionError("cutover-chain-invalid");
  return {
    state: previous.current_state,
    sequence: previous.sequence,
    receiptDigest: previous.receipt_digest,
  };
}

function openDatabase(repoRoot: string): Database {
  const path = resolve(repoRoot, ".ut-tdd", "ledger", "cutover-ledger.db");
  mkdirSync(dirname(path), { recursive: true });
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (path: string) => Database;
  };
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  db.exec(
    "CREATE TABLE IF NOT EXISTS cutover_receipts (sequence INTEGER PRIMARY KEY, receipt_digest TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, evidence_json TEXT NOT NULL, admission_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS cutover_head (singleton INTEGER PRIMARY KEY CHECK(singleton=1), sequence INTEGER NOT NULL, receipt_digest TEXT NOT NULL, version INTEGER NOT NULL);",
  );
  return db;
}

function loadReceipts(
  db: Database,
  repoRoot: string,
  ports: CutoverValidationPorts,
): CutoverTransitionReceipt[] {
  return db
    .prepare(
      "SELECT sequence, receipt_digest, payload, evidence_json, admission_json FROM cutover_receipts ORDER BY sequence",
    )
    .all()
    .map((row) => {
      const stored = row as StoredRow;
      try {
        const receipt = cutoverTransitionReceiptSchema.parse(JSON.parse(stored.payload));
        const admission = cutoverAdmissionReceiptSchema.parse(JSON.parse(stored.admission_json));
        const evidenceJson = JSON.parse(stored.evidence_json) as unknown;
        if (!Array.isArray(evidenceJson)) throw new CutoverTransitionError("cutover-chain-invalid");
        const evidence = evidenceJson.map((item) => sliceEvidenceReceiptSchema.parse(item));
        if (
          receipt.sequence !== stored.sequence ||
          receipt.receipt_digest !== stored.receipt_digest
        )
          throw new CutoverTransitionError("cutover-chain-invalid");
        const rebuilt = buildReceipt({
          repoRoot,
          edgeId: receipt.transition_id,
          sequence: receipt.sequence,
          subjectRevision: receipt.subject_revision,
          artifactDigest: admission.artifact_digest,
          executionMode: admission.execution_mode,
          expectedPreviousReceiptDigest: receipt.previous_receipt_digest,
          admissionPriorReceiptDigest: admission.prior_validated_receipt_digest,
          evidence,
          admission,
          ports,
        });
        if (JSON.stringify(rebuilt) !== JSON.stringify(receipt))
          throw new CutoverTransitionError("cutover-chain-invalid");
        return receipt;
      } catch {
        throw new CutoverTransitionError("cutover-chain-invalid");
      }
    });
}

function appendAtomically(input: CutoverCommandInput, genesis: boolean): CutoverTransitionReceipt {
  // Keep an unimplemented (but structurally valid) sealed edge from reaching the
  // state table.  `input.edgeId` is external runtime input despite its static type.
  if (!implementedCutoverEdgeIdSchema.safeParse(input.edgeId).success)
    throw new CutoverTransitionError("cutover-transition-invalid");
  const db = openDatabase(input.repoRoot);
  try {
    db.exec("BEGIN IMMEDIATE");
    const receipts = loadReceipts(db, input.repoRoot, input.ports);
    const projection = projectCutoverState(receipts);
    if (genesis) {
      if (receipts.length !== 0)
        throw new CutoverTransitionError("cutover-genesis-already-initialized");
      if (input.sequence !== 0 || input.expectedPreviousReceiptDigest !== null)
        throw new CutoverTransitionError("cutover-transition-invalid");
    } else {
      if (receipts.length === 0) throw new CutoverTransitionError("cutover-chain-uninitialized");
      if (
        input.sequence !== (projection.sequence ?? -1) + 1 ||
        input.expectedPreviousReceiptDigest !== projection.receiptDigest
      )
        throw new CutoverTransitionError("cutover-write-conflict");
      if (EDGE_STATES[input.edgeId].previous !== projection.state)
        throw new CutoverTransitionError("cutover-transition-invalid");
      // 非 genesis の admission prior closure は呼び出し側の申告値ではなく、同一 transaction 内で
      // 確定した ledger の直前 receipt に束縛する (PLAN §4: 以後は直前 cutover receipt を prior に要求する)。
      if (input.admissionPriorReceiptDigest !== projection.receiptDigest)
        throw new CutoverTransitionError("cutover-admission-not-ready");
    }
    const receipt = buildReceipt(input);
    db.prepare(
      "INSERT INTO cutover_receipts(sequence, receipt_digest, payload, evidence_json, admission_json) VALUES (?, ?, ?, ?, ?)",
    ).run(
      receipt.sequence,
      receipt.receipt_digest,
      JSON.stringify(receipt),
      JSON.stringify(input.evidence),
      JSON.stringify(input.admission),
    );
    if (input.faultAfterReceiptInsert)
      throw new CutoverTransitionError("cutover-atomic-commit-failed");
    if (genesis) {
      db.prepare(
        "INSERT INTO cutover_head(singleton, sequence, receipt_digest, version) VALUES (1, ?, ?, 1)",
      ).run(receipt.sequence, receipt.receipt_digest);
    } else {
      const head = db
        .prepare("SELECT sequence, receipt_digest, version FROM cutover_head WHERE singleton=1")
        .get() as { sequence: number; receipt_digest: string; version: number } | undefined;
      if (
        !head ||
        head.sequence !== projection.sequence ||
        head.receipt_digest !== projection.receiptDigest
      )
        throw new CutoverTransitionError("cutover-write-conflict");
      const result = db
        .prepare(
          "UPDATE cutover_head SET sequence=?, receipt_digest=?, version=version+1 WHERE singleton=1 AND sequence=? AND receipt_digest=? AND version=?",
        )
        .run(
          receipt.sequence,
          receipt.receipt_digest,
          head.sequence,
          head.receipt_digest,
          head.version,
        );
      if (result.changes !== 1) throw new CutoverTransitionError("cutover-write-conflict");
    }
    db.exec("COMMIT");
    return receipt;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // A successful COMMIT or failed BEGIN leaves no open transaction.
    }
    if (error instanceof CutoverTransitionError) throw error;
    throw new CutoverTransitionError("cutover-atomic-commit-failed");
  } finally {
    db.close();
  }
}

export function initializeCutoverChain(input: CutoverCommandInput): CutoverTransitionReceipt {
  if (input.edgeId !== "cutover.genesis")
    throw new CutoverTransitionError("cutover-transition-invalid");
  return appendAtomically(input, true);
}

export function appendCutoverTransition(input: CutoverCommandInput): CutoverTransitionReceipt {
  if (input.edgeId === "cutover.genesis")
    throw new CutoverTransitionError("cutover-transition-invalid");
  return appendAtomically(input, false);
}
