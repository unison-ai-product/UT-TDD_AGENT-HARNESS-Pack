import { createHmac, timingSafeEqual } from "node:crypto";
import type { EvidenceAttestation, EvidenceProducer } from "../domain/evidence-types.ts";
import type {
  EvidenceAttestationInput,
  EvidenceAttestationVerifierPort,
} from "../ports/evidence-attestation.ts";

export interface EvidenceVerifierKeyMaterial {
  readonly version: string;
  readonly secret: Uint8Array;
  readonly producers: readonly EvidenceProducer[];
}

export type CapturedEvidenceAttestationVerifier = (
  input: EvidenceAttestationInput,
  attestation: EvidenceAttestation,
) => boolean;

type StoredKey = {
  readonly secret: Buffer;
  readonly producers: ReadonlySet<EvidenceProducer>;
};

const captures = new WeakMap<object, CapturedEvidenceAttestationVerifier>();

export class HmacEvidenceAttestationVerifier implements EvidenceAttestationVerifierPort {
  readonly #authorityId: string;
  readonly #keys: ReadonlyMap<string, StoredKey>;

  constructor(authorityId: string, keyMaterial: readonly EvidenceVerifierKeyMaterial[]) {
    if (new.target !== HmacEvidenceAttestationVerifier || !validIdentifier(authorityId)) {
      throw new Error("evidence-attestation-verifier-invalid");
    }
    const keys = new Map<string, StoredKey>();
    for (const item of keyMaterial) {
      if (
        !validIdentifier(item.version) ||
        item.secret.byteLength < 32 ||
        item.producers.length === 0 ||
        new Set(item.producers).size !== item.producers.length ||
        keys.has(item.version)
      ) {
        throw new Error("evidence-attestation-key-material-invalid");
      }
      keys.set(item.version, {
        secret: Buffer.from(item.secret),
        producers: new Set(item.producers),
      });
    }
    if (keys.size === 0) throw new Error("evidence-attestation-key-material-invalid");
    this.#authorityId = authorityId;
    this.#keys = keys;
    captures.set(this, HmacEvidenceAttestationVerifier.prototype.verify.bind(this));
    Object.freeze(this);
  }

  verify(input: EvidenceAttestationInput, attestation: EvidenceAttestation): boolean {
    if (
      attestation.schemaVersion !== "evidence-attestation/v1" ||
      attestation.algorithm !== "hmac-sha256" ||
      attestation.authorityId !== this.#authorityId ||
      !/^[A-Za-z0-9_-]{43}$/.test(attestation.signature)
    )
      return false;
    const key = this.#keys.get(attestation.keyVersion);
    if (!key?.producers.has(input.producer)) return false;
    const actual = Buffer.from(attestation.signature, "base64url");
    const expected = createHmac("sha256", key.secret)
      .update(frame(this.#authorityId, attestation.keyVersion, input))
      .digest();
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}

Object.freeze(HmacEvidenceAttestationVerifier.prototype);

export function captureEvidenceAttestationVerifier(
  candidate: EvidenceAttestationVerifierPort,
): CapturedEvidenceAttestationVerifier | null {
  return captures.get(candidate) ?? null;
}

function frame(authorityId: string, keyVersion: string, input: EvidenceAttestationInput): Buffer {
  const fields = [
    "ut-tdd-evidence-attestation/v1",
    "evidence-attestation/v1",
    "hmac-sha256",
    authorityId,
    keyVersion,
    input.producer,
    input.recordDigest,
  ];
  const parts: Buffer[] = [];
  for (const field of fields) {
    const value = Buffer.from(field, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(value.length);
    parts.push(length, value);
  }
  return Buffer.concat(parts);
}

function validIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}
