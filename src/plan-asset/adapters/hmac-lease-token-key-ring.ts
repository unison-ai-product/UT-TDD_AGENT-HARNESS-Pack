import { createHmac } from "node:crypto";
import type { LeaseTokenKeyRingPort, LeaseTokenMac } from "../ports/lease-token-key-ring.ts";

export interface LeaseTokenKeyMaterial {
  readonly version: string;
  readonly secret: Uint8Array;
}

export class HmacLeaseTokenKeyRing implements LeaseTokenKeyRingPort {
  readonly #keys: ReadonlyMap<string, Buffer>;
  readonly #currentVersion: string;

  constructor(currentVersion: string, keyMaterial: readonly LeaseTokenKeyMaterial[]) {
    const keys = new Map<string, Buffer>();
    for (const item of keyMaterial) {
      if (!validVersion(item.version) || item.secret.byteLength < 32 || keys.has(item.version)) {
        throw new Error("lease-token-key-material-invalid");
      }
      keys.set(item.version, Buffer.from(item.secret));
    }
    if (!keys.has(currentVersion)) throw new Error("lease-token-current-key-missing");
    this.#currentVersion = currentVersion;
    this.#keys = keys;
    Object.freeze(this);
  }

  issueMac(message: Uint8Array): LeaseTokenMac {
    const mac = this.mac(this.#currentVersion, message);
    if (!mac) throw new Error("lease-token-current-key-missing");
    return { keyVersion: this.#currentVersion, mac };
  }

  recoverMac(keyVersion: string, message: Uint8Array): Uint8Array | null {
    return this.mac(keyVersion, message);
  }

  private mac(keyVersion: string, message: Uint8Array): Uint8Array | null {
    const key = this.#keys.get(keyVersion);
    return key ? createHmac("sha256", key).update(message).digest() : null;
  }
}

function validVersion(version: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(version);
}
