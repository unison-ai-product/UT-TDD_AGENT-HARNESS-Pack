import { createHmac } from "node:crypto";
import type { EvidenceAttestation, EvidenceProducer } from "../domain/evidence-types.ts";
import type {
  EvidenceAttestationInput,
  EvidenceAttestationIssuerPort,
} from "../ports/evidence-attestation.ts";

export interface EvidenceAuthorityKeyMaterial {
  readonly version: string;
  readonly secret: Uint8Array;
  readonly producers: readonly EvidenceProducer[];
}

type StoredKey = {
  readonly secret: Buffer;
  readonly producers: ReadonlySet<EvidenceProducer>;
};

type EvidenceMacInput = {
  readonly authorityId: string;
  readonly keyVersion: string;
  readonly evidence: EvidenceAttestationInput;
  readonly secret: Buffer;
};

/** Signing capability. Never pass this object to policy evaluation code. */
export class HmacEvidenceAttestationIssuer implements EvidenceAttestationIssuerPort {
  readonly #authorityId: string;
  readonly #currentVersion: string;
  readonly #keys: ReadonlyMap<string, StoredKey>;

  constructor(
    authorityId: string,
    currentVersion: string,
    keyMaterial: readonly EvidenceAuthorityKeyMaterial[],
  ) {
    this.#authorityId = validAuthority(authorityId);
    this.#currentVersion = validVersion(currentVersion);
    this.#keys = buildKeys(keyMaterial);
    if (!this.#keys.has(currentVersion))
      throw new Error("evidence-attestation-current-key-missing");
    Object.freeze(this);
  }

  issue(input: EvidenceAttestationInput): EvidenceAttestation {
    const key = this.#keys.get(this.#currentVersion);
    if (!key?.producers.has(input.producer)) {
      throw new Error("evidence-attestation-producer-not-authorized");
    }
    return Object.freeze({
      schemaVersion: "evidence-attestation/v1",
      algorithm: "hmac-sha256",
      authorityId: this.#authorityId,
      keyVersion: this.#currentVersion,
      signature: mac({
        authorityId: this.#authorityId,
        keyVersion: this.#currentVersion,
        evidence: input,
        secret: key.secret,
      }).toString("base64url"),
    });
  }
}

function buildKeys(
  keyMaterial: readonly EvidenceAuthorityKeyMaterial[],
): ReadonlyMap<string, StoredKey> {
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
  return keys;
}

function mac(input: EvidenceMacInput): Buffer {
  return createHmac("sha256", input.secret)
    .update(
      frame([
        "ut-tdd-evidence-attestation/v1",
        "evidence-attestation/v1",
        "hmac-sha256",
        input.authorityId,
        input.keyVersion,
        input.evidence.producer,
        input.evidence.recordDigest,
      ]),
    )
    .digest();
}

function frame(fields: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  for (const field of fields) {
    const value = Buffer.from(field, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(value.length);
    parts.push(length, value);
  }
  return Buffer.concat(parts);
}

function validAuthority(value: string): string {
  if (!validIdentifier(value)) throw new Error("evidence-attestation-authority-invalid");
  return value;
}

function validVersion(value: string): string {
  if (!validIdentifier(value)) throw new Error("evidence-attestation-authority-invalid");
  return value;
}

function validIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}
