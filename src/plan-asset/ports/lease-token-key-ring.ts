export interface LeaseTokenMac {
  readonly keyVersion: string;
  readonly mac: Uint8Array;
}

export interface LeaseTokenKeyRingPort {
  issueMac(message: Uint8Array): LeaseTokenMac;
  recoverMac(keyVersion: string, message: Uint8Array): Uint8Array | null;
}
