import { createHash } from "node:crypto";

const encoder = new TextEncoder();

function uint32be(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function uint64be(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

export function canonicalField(name: string, value: string | Uint8Array): Uint8Array {
  const nameBytes = encoder.encode(name);
  const valueBytes = typeof value === "string" ? encoder.encode(value) : value;
  return concat([
    uint32be(nameBytes.byteLength),
    nameBytes,
    uint64be(valueBytes.byteLength),
    valueBytes,
  ]);
}

export function sha256(parts: readonly Uint8Array[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}
