import { createHash } from "node:crypto";
import type { EvidenceAttestationIssuerPort } from "../ports/evidence-attestation.ts";
import {
  canonicalJson,
  cloneCanonical,
  deepFreeze,
  exactKeys,
  isNonempty,
  isPlainObject,
  validIso,
} from "./evidence-canonical.ts";
import { claimsValid } from "./evidence-claims.ts";
import {
  EVIDENCE_KINDS,
  EVIDENCE_PRODUCERS,
  type EvidenceAttestation,
  type EvidenceClaims,
  type EvidenceError,
  type EvidenceExitRule,
  type EvidenceKind,
  type EvidenceProducer,
  type EvidenceRecordInput,
  type StoredEvidenceRecord,
} from "./evidence-types.ts";
import {
  isRedactedCommandArgs,
  REDACTED_ARGS_SCHEMA,
  type RedactedCommandArgs,
  restoreRedactedCommandArgs,
  storedRedactedArgsValid,
} from "./redacted-command-args.ts";

export type {
  EvidenceClaims,
  EvidenceClaimsRule,
  EvidenceError,
  EvidenceExitRule,
  EvidenceKind,
  EvidenceProducer,
  EvidenceRecordInput,
  StoredEvidenceRecord,
} from "./evidence-types.ts";
export { createRedactedCommandArgs } from "./redacted-command-args.ts";

type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export class EvidenceRecord {
  readonly evidenceId!: string;
  readonly evidenceKind!: EvidenceKind;
  readonly subjectId!: string;
  readonly subjectRevision!: number;
  readonly sourceCommit!: string;
  readonly commandArgs!: RedactedCommandArgs;
  readonly claims!: EvidenceClaims;
  readonly outputDigest!: string;
  readonly exitCode!: number;
  readonly producer!: EvidenceProducer;
  readonly producedAt!: string;
  readonly expiresAt?: string;
  readonly supersedesEvidenceId?: string;
  readonly recordDigest!: string;
  readonly attestation?: EvidenceAttestation;

  private constructor(input: ConstructorInput) {
    Object.assign(this, input);
    Object.freeze(this);
  }

  static create(
    input: EvidenceRecordInput,
    issuer?: EvidenceAttestationIssuerPort,
  ): Result<EvidenceRecord, EvidenceError> {
    const error = validateInput(input);
    if (error) return { ok: false, error };
    const claims = deepFreeze(cloneCanonical(input.claims)) as EvidenceClaims;
    const record = storedFields({ ...input, claims });
    const recordDigest = evidenceDigest(record);
    return {
      ok: true,
      value: new EvidenceRecord({
        ...record,
        commandArgs: input.commandArgs,
        expiresAt: input.expiresAt,
        supersedesEvidenceId: input.supersedesEvidenceId,
        recordDigest,
        attestation: issuer?.issue({ producer: input.producer, recordDigest }),
      }),
    };
  }

  static reconstruct(input: StoredEvidenceRecord): Result<EvidenceRecord, EvidenceError> {
    if (!storedShapeValid(input) || !storedRedactedArgsValid(input.commandArgs)) {
      return failed("evidence-record-invalid");
    }
    const commandArgs = restoreRedactedCommandArgs(input.commandArgs.values);
    if (!commandArgs) return failed("evidence-record-invalid");
    const created = EvidenceRecord.create({
      evidenceId: input.evidenceId,
      evidenceKind: input.evidenceKind,
      subjectId: input.subjectId,
      subjectRevision: input.subjectRevision,
      sourceCommit: input.sourceCommit,
      commandArgs,
      claims: input.claims,
      outputDigest: input.outputDigest,
      exitCode: input.exitCode,
      producer: input.producer,
      producedAt: input.producedAt,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      ...(input.supersedesEvidenceId ? { supersedesEvidenceId: input.supersedesEvidenceId } : {}),
    });
    if (!created.ok) return created;
    if (created.value.recordDigest !== input.recordDigest) {
      return failed("evidence-record-digest-mismatch");
    }
    return {
      ok: true,
      value: new EvidenceRecord({
        ...created.value,
        attestation: input.attestation ? deepFreeze(cloneCanonical(input.attestation)) : undefined,
      }),
    };
  }

  toRecord(): StoredEvidenceRecord {
    return Object.freeze({
      evidenceId: this.evidenceId,
      evidenceKind: this.evidenceKind,
      subjectId: this.subjectId,
      subjectRevision: this.subjectRevision,
      sourceCommit: this.sourceCommit,
      commandArgs: Object.freeze({
        schemaVersion: REDACTED_ARGS_SCHEMA,
        values: Object.freeze([...this.commandArgs.values]),
      }),
      claims: this.claims,
      outputDigest: this.outputDigest,
      exitCode: this.exitCode,
      producer: this.producer,
      producedAt: this.producedAt,
      expiresAt: this.expiresAt ?? null,
      supersedesEvidenceId: this.supersedesEvidenceId ?? null,
      recordDigest: this.recordDigest,
      attestation: this.attestation ?? null,
    });
  }

  isUsableFor(input: UsageContext): { readonly usable: boolean; readonly ruleId?: string } {
    const usable =
      this.evidenceKind === input.requiredKind &&
      this.subjectId === input.subjectId &&
      this.subjectRevision === input.subjectRevision &&
      this.sourceCommit === input.sourceCommit &&
      input.acceptedProducers.includes(this.producer) &&
      Date.parse(this.producedAt) <= Date.parse(input.now) &&
      (!this.expiresAt || Date.parse(input.now) < Date.parse(this.expiresAt)) &&
      exitMatches(this.exitCode, input.exitRule);
    return usable
      ? { usable: true }
      : { usable: false, ruleId: "evidence-stale-or-subject-mismatch" };
  }
}

interface UsageContext {
  readonly requiredKind: EvidenceKind;
  readonly subjectId: string;
  readonly subjectRevision: number;
  readonly sourceCommit: string;
  readonly now: string;
  readonly acceptedProducers: readonly EvidenceProducer[];
  readonly exitRule: EvidenceExitRule;
}

type ConstructorInput = Omit<
  StoredEvidenceRecord,
  "expiresAt" | "supersedesEvidenceId" | "attestation"
> & {
  readonly commandArgs: RedactedCommandArgs;
  readonly expiresAt?: string;
  readonly supersedesEvidenceId?: string;
  readonly attestation?: EvidenceAttestation;
};

function validateInput(input: EvidenceRecordInput): EvidenceError | null {
  const invalid =
    !isNonempty(input.evidenceId) ||
    !isNonempty(input.subjectId) ||
    !Number.isSafeInteger(input.subjectRevision) ||
    input.subjectRevision < 1 ||
    !/^[a-f0-9]{40}$/.test(input.sourceCommit) ||
    !/^[a-f0-9]{64}$/.test(input.outputDigest) ||
    !isRedactedCommandArgs(input.commandArgs) ||
    input.commandArgs.values.length === 0 ||
    !Number.isSafeInteger(input.exitCode) ||
    !EVIDENCE_KINDS.includes(input.evidenceKind) ||
    !EVIDENCE_PRODUCERS.includes(input.producer) ||
    !validIso(input.producedAt) ||
    !validExpiry(input.producedAt, input.expiresAt) ||
    (input.supersedesEvidenceId !== undefined && !isNonempty(input.supersedesEvidenceId)) ||
    input.supersedesEvidenceId === input.evidenceId ||
    !claimsValid(input.evidenceKind, input.claims);
  return invalid ? { ruleId: "evidence-invalid", message: "evidence input rejected" } : null;
}

function validExpiry(producedAt: string, expiresAt?: string): boolean {
  return (
    expiresAt === undefined ||
    (validIso(expiresAt) && Date.parse(expiresAt) > Date.parse(producedAt))
  );
}

function storedFields(input: EvidenceRecordInput & { readonly claims: EvidenceClaims }) {
  return {
    evidenceId: input.evidenceId,
    evidenceKind: input.evidenceKind,
    subjectId: input.subjectId,
    subjectRevision: input.subjectRevision,
    sourceCommit: input.sourceCommit,
    commandArgs: { schemaVersion: REDACTED_ARGS_SCHEMA, values: [...input.commandArgs.values] },
    claims: input.claims,
    outputDigest: input.outputDigest,
    exitCode: input.exitCode,
    producer: input.producer,
    producedAt: input.producedAt,
    expiresAt: input.expiresAt ?? null,
    supersedesEvidenceId: input.supersedesEvidenceId ?? null,
  };
}

function evidenceDigest(record: ReturnType<typeof storedFields>): string {
  return createHash("sha256")
    .update("ut-tdd-evidence-record/v1\0")
    .update(canonicalJson(record))
    .digest("hex");
}

function storedShapeValid(input: StoredEvidenceRecord): boolean {
  return (
    isPlainObject(input) &&
    exactKeys(input, [
      "evidenceId",
      "evidenceKind",
      "subjectId",
      "subjectRevision",
      "sourceCommit",
      "commandArgs",
      "claims",
      "outputDigest",
      "exitCode",
      "producer",
      "producedAt",
      "expiresAt",
      "supersedesEvidenceId",
      "recordDigest",
      "attestation",
    ]) &&
    /^[a-f0-9]{64}$/.test(String(input.recordDigest)) &&
    attestationValid(input.attestation)
  );
}

function attestationValid(value: unknown): value is EvidenceAttestation | null {
  if (value === null) return true;
  if (!isPlainObject(value)) return false;
  return (
    exactKeys(value, ["schemaVersion", "algorithm", "authorityId", "keyVersion", "signature"]) &&
    value.schemaVersion === "evidence-attestation/v1" &&
    value.algorithm === "hmac-sha256" &&
    /^[A-Za-z0-9_-]+$/.test(String(value.authorityId)) &&
    /^[A-Za-z0-9_-]+$/.test(String(value.keyVersion)) &&
    /^[A-Za-z0-9_-]{43}$/.test(String(value.signature))
  );
}

function exitMatches(exitCode: number, rule: EvidenceExitRule): boolean {
  return (
    rule.kind === "any" || (rule.kind === "nonzero" ? exitCode !== 0 : exitCode === rule.expected)
  );
}

function failed(ruleId: string): { readonly ok: false; readonly error: EvidenceError } {
  return { ok: false, error: { ruleId, message: "evidence record rejected" } };
}
