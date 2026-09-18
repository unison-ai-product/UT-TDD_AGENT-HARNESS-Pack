import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type {
  PersistedProviderJudgment,
  ProviderEvidenceReadResult,
  ProviderJudgmentAttemptIdentity,
  ProviderJudgmentEvidencePort,
  ProviderJudgmentWriteResult,
  VerifiedProviderInvocation,
} from "../ports/provider-judgment-evidence.ts";
import {
  type ProviderJudgmentPayload,
  providerJudgmentIdentityDigest,
} from "../provider-judgment.ts";

const DIGEST = /^[0-9a-f]{64}$/;

interface EvidenceEnvelope {
  readonly schema_version: "d3b-provider-evidence-envelope/v1";
  readonly identity: ProviderJudgmentAttemptIdentity;
  readonly provider: "claude" | "codex";
  readonly model: string;
  readonly evidence_base64: string;
}

function decodeEnvelope(bytes: string): EvidenceEnvelope | null {
  try {
    const value = JSON.parse(bytes) as Record<string, unknown>;
    const keys = Object.keys(value).sort();
    const expected = ["evidence_base64", "identity", "model", "provider", "schema_version"];
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
      return null;
    }
    if (value.schema_version !== "d3b-provider-evidence-envelope/v1") return null;
    if (value.provider !== "claude" && value.provider !== "codex") return null;
    if (typeof value.model !== "string" || value.model.length === 0) return null;
    if (typeof value.evidence_base64 !== "string") return null;
    if (value.identity === null || typeof value.identity !== "object") return null;
    return value as unknown as EvidenceEnvelope;
  } catch {
    return null;
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function sameAttemptIdentity(
  left: ProviderJudgmentAttemptIdentity,
  right: ProviderJudgmentAttemptIdentity,
): boolean {
  return (
    left.repository === right.repository &&
    left.prNumber === right.prNumber &&
    left.headSha === right.headSha &&
    left.requestMemoryId === right.requestMemoryId &&
    left.requestDigest === right.requestDigest &&
    left.reviewRevision === right.reviewRevision &&
    left.attempt === right.attempt &&
    left.authorFamily === right.authorFamily &&
    left.invocationNonce === right.invocationNonce
  );
}

function parsePayload(bytes: Uint8Array): ProviderJudgmentPayload | null {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as ProviderJudgmentPayload;
  } catch {
    return null;
  }
}

/** File-backed adapter. Provider evidence と judgment の root は呼出側が固定する。 */
export class FileProviderJudgmentEvidenceAdapter implements ProviderJudgmentEvidencePort {
  readonly #evidenceRoot: string;
  readonly #judgmentsRoot: string;
  readonly #verifiedInvocation: VerifiedProviderInvocation;

  constructor(input: {
    readonly evidenceRoot: string;
    readonly judgmentsRoot: string;
    readonly verifiedInvocation: VerifiedProviderInvocation;
  }) {
    this.#evidenceRoot = input.evidenceRoot;
    this.#judgmentsRoot = input.judgmentsRoot;
    this.#verifiedInvocation = input.verifiedInvocation;
  }

  async read(identity: ProviderJudgmentAttemptIdentity): Promise<ProviderEvidenceReadResult> {
    if (!DIGEST.test(identity.requestDigest) || !Number.isSafeInteger(identity.attempt)) {
      return { status: "provider_failure", detail: "invalid evidence identity" };
    }
    const path = join(
      this.#evidenceRoot,
      identity.requestDigest,
      "attempts",
      `attempt-${identity.attempt}`,
      "evidence.json",
    );
    if (!existsSync(path)) return { status: "missing" };
    let envelope: EvidenceEnvelope | null;
    try {
      envelope = decodeEnvelope(readFileSync(path, "utf8"));
    } catch {
      return { status: "provider_failure", detail: "evidence read failed" };
    }
    if (envelope === null)
      return { status: "provider_failure", detail: "evidence envelope invalid" };
    if (
      JSON.stringify(envelope.identity) !== JSON.stringify(identity) ||
      !sameAttemptIdentity(identity, this.#verifiedInvocation) ||
      envelope.provider !== this.#verifiedInvocation.provider ||
      envelope.model !== this.#verifiedInvocation.model
    ) {
      return { status: "provider_failure", detail: "verified invocation mismatch" };
    }
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(Buffer.from(envelope.evidence_base64, "base64"));
    } catch {
      return { status: "provider_failure", detail: "evidence bytes invalid" };
    }
    return {
      status: "available",
      identity: envelope.identity,
      provider: envelope.provider,
      model: envelope.model,
      bytes,
    };
  }

  async write(judgment: PersistedProviderJudgment): Promise<ProviderJudgmentWriteResult> {
    if (!DIGEST.test(judgment.identityDigest) || !DIGEST.test(judgment.judgmentDigest)) {
      return { status: "failed" };
    }
    mkdirSync(this.#judgmentsRoot, { recursive: true });
    const lock = join(this.#judgmentsRoot, `.${judgment.identityDigest}.lock`);
    try {
      mkdirSync(lock);
    } catch {
      return { status: "failed" };
    }
    const target = join(this.#judgmentsRoot, `${judgment.judgmentDigest}.json`);
    const temporary = join(
      this.#judgmentsRoot,
      `.${judgment.judgmentDigest}.${process.pid}.${Date.now()}.tmp`,
    );
    try {
      for (const name of readdirSync(this.#judgmentsRoot)) {
        if (!DIGEST.test(name.slice(0, -5)) || !name.endsWith(".json")) continue;
        const existing = Uint8Array.from(readFileSync(join(this.#judgmentsRoot, name)));
        const payload = parsePayload(existing);
        if (
          payload !== null &&
          providerJudgmentIdentityDigest(payload) === judgment.identityDigest
        ) {
          return sameBytes(existing, judgment.bytes)
            ? { status: "replay" }
            : { status: "conflict" };
        }
      }
      let descriptor: number | null = null;
      try {
        descriptor = openSync(temporary, "wx", 0o600);
        writeSync(descriptor, judgment.bytes);
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = null;
        linkSync(temporary, target);
        unlinkSync(temporary);
        return { status: "written" };
      } catch {
        if (descriptor !== null) closeSync(descriptor);
        if (existsSync(temporary)) unlinkSync(temporary);
        if (existsSync(target)) {
          const existing = Uint8Array.from(readFileSync(target));
          return sameBytes(existing, judgment.bytes)
            ? { status: "replay" }
            : { status: "conflict" };
        }
        return { status: "failed" };
      }
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
}
