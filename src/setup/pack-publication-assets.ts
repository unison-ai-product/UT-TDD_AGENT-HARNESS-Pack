import { createHash } from "node:crypto";
import type { PublicationReleaseIdentity } from "../schema/release-manifest.ts";
import { validateAuthoringArtifactSet } from "./authoring-template-inventory.ts";

const RELEASE_ID = /^rel-sha256:([a-f0-9]{64})$/;
const SHA256 = /^sha256:([a-f0-9]{64})$/;
const TAR_BLOCK_SIZE = 512;
const STORED_BLOCK_SIZE = 65_535;

export interface SealedPublicationEntry {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly mode: "100644" | "100755";
  readonly size: number;
  readonly contentDigest: string;
  readonly content: Uint8Array;
}

export interface PublicationAsset {
  readonly name: string;
  readonly size: number;
  readonly contentDigest: string;
  readonly bytes: Buffer;
}

export interface PackPublicationAssets {
  readonly tarball: PublicationAsset;
  readonly checksum: PublicationAsset;
  readonly releaseAssetInventoryDigest: string;
  /** Exposed for byte-level attestation; remote publication must use only the two assets above. */
  readonly tarBytes: Buffer;
}

export type PackPublicationAssetError =
  | "invalid_release"
  | "artifact_mismatch"
  | "unsupported_entry"
  | "unsupported_path"
  | "asset_inventory_mismatch";

export type PackPublicationAssetResult =
  | { readonly ok: true; readonly value: PackPublicationAssets }
  | { readonly ok: false; readonly error: PackPublicationAssetError };

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function u64(value: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([u32(bytes.length), bytes]);
}

function rawDigest(value: string): Buffer | null {
  const match = SHA256.exec(value);
  return match ? Buffer.from(match[1], "hex") : null;
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/**
 * Keep this boundary defensive even though the normal caller supplies a
 * parser-produced manifest.  This function is the publication byte boundary;
 * accepting an independently-constructed identity here would otherwise let
 * an invalid path/order reach the tar writer.
 */
function validPublicationPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return false;
  if (Buffer.from(value, "utf8").toString("utf8") !== value) return false;
  if (value.includes("\\") || value.startsWith("/") || value.startsWith("//")) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  const segments = value.split("/");
  return (
    value !== "." &&
    !segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  );
}

function validateManifestArtifacts(
  artifacts:
    | readonly SealedPublicationEntry[]
    | readonly {
        readonly sourcePath: string;
        readonly destinationPath: string;
        readonly mode: string;
        readonly size: number;
        readonly contentDigest: string;
      }[],
): PackPublicationAssetError | null {
  const sources = new Set<string>();
  const destinations = new Set<string>();
  let previousDestination: Buffer | null = null;
  for (const artifact of artifacts) {
    if (
      !validPublicationPath(artifact.sourcePath) ||
      !validPublicationPath(artifact.destinationPath)
    )
      return "unsupported_path";
    if (artifact.mode !== "100644" && artifact.mode !== "100755") return "unsupported_entry";
    if (sources.has(artifact.sourcePath) || destinations.has(artifact.destinationPath))
      return "artifact_mismatch";
    const destination = Buffer.from(artifact.destinationPath, "utf8");
    if (previousDestination && Buffer.compare(previousDestination, destination) >= 0)
      return "artifact_mismatch";
    sources.add(artifact.sourcePath);
    destinations.add(artifact.destinationPath);
    previousDestination = destination;
  }
  return null;
}

function splitUstarPath(path: string): { name: Buffer; prefix: Buffer } | null {
  const whole = Buffer.from(path, "utf8");
  if (whole.length <= 100) return { name: whole, prefix: Buffer.alloc(0) };
  for (
    let separator = path.lastIndexOf("/");
    separator > 0;
    separator = path.lastIndexOf("/", separator - 1)
  ) {
    const prefix = Buffer.from(path.slice(0, separator), "utf8");
    const name = Buffer.from(path.slice(separator + 1), "utf8");
    if (prefix.length <= 155 && name.length > 0 && name.length <= 100) return { name, prefix };
  }
  return null;
}

function writeOctal(input: {
  target: Buffer;
  offset: number;
  width: number;
  value: number;
}): boolean {
  const { target, offset, width, value } = input;
  if (!Number.isSafeInteger(value) || value < 0) return false;
  const octal = value.toString(8);
  if (octal.length > width - 1) return false;
  target.write(`${octal.padStart(width - 1, "0")}\0`, offset, width, "ascii");
  return true;
}

function tarHeader(entry: SealedPublicationEntry): Buffer | null {
  const path = splitUstarPath(entry.destinationPath);
  if (!path) return null;
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  path.name.copy(header, 0);
  Buffer.from(`0${entry.mode}\0`, "ascii").copy(header, 100);
  if (
    !writeOctal({ target: header, offset: 108, width: 8, value: 0 }) ||
    !writeOctal({ target: header, offset: 116, width: 8, value: 0 }) ||
    !writeOctal({ target: header, offset: 124, width: 12, value: entry.content.length }) ||
    !writeOctal({ target: header, offset: 136, width: 12, value: 0 })
  )
    return null;
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  Buffer.from("ustar\0", "ascii").copy(header, 257);
  Buffer.from("00", "ascii").copy(header, 263);
  if (
    !writeOctal({ target: header, offset: 329, width: 8, value: 0 }) ||
    !writeOctal({ target: header, offset: 337, width: 8, value: 0 })
  )
    return null;
  path.prefix.copy(header, 345);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const encoded = checksum.toString(8);
  if (encoded.length > 6) return null;
  header.write(encoded.padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function createTar(entries: readonly SealedPublicationEntry[]): Buffer | null {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = tarHeader(entry);
    if (!header) return null;
    const content = Buffer.from(entry.content);
    chunks.push(header, content);
    const padding = (TAR_BLOCK_SIZE - (content.length % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(TAR_BLOCK_SIZE * 2));
  return Buffer.concat(chunks);
}

let crcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1)
        value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crcTable[index] = value >>> 0;
    }
  }
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function fixedGzip(bytes: Uint8Array): Buffer {
  const source = Buffer.from(bytes);
  const chunks: Buffer[] = [Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255])];
  if (source.length === 0) chunks.push(Buffer.from([1, 0, 0, 255, 255]));
  for (let offset = 0; offset < source.length; offset += STORED_BLOCK_SIZE) {
    const length = Math.min(STORED_BLOCK_SIZE, source.length - offset);
    const header = Buffer.alloc(5);
    header[0] = offset + length === source.length ? 1 : 0;
    header.writeUInt16LE(length, 1);
    header.writeUInt16LE(~length & 0xffff, 3);
    chunks.push(header, source.subarray(offset, offset + length));
  }
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(source), 0);
  trailer.writeUInt32LE(source.length >>> 0, 4);
  chunks.push(trailer);
  return Buffer.concat(chunks);
}

export function deriveReleaseAssetInventoryDigest(assets: readonly PublicationAsset[]): string {
  const ordered = [...assets].sort((left, right) => utf8Compare(left.name, right.name));
  const payload: Buffer[] = [Buffer.from("ut-tdd-pack-assets-v2\0", "ascii"), u32(ordered.length)];
  for (const asset of ordered) {
    const digest = rawDigest(asset.contentDigest);
    if (!digest) throw new Error("invalid asset digest");
    payload.push(lengthPrefixed(asset.name), u64(asset.size), digest);
  }
  return sha256(Buffer.concat(payload));
}

function exactEntries(
  release: PublicationReleaseIdentity,
  entries: readonly SealedPublicationEntry[],
): boolean {
  if (release.artifacts.length !== entries.length) return false;
  return release.artifacts.every((artifact, index) => {
    const entry = entries[index];
    return (
      entry !== undefined &&
      artifact.sourcePath === entry.sourcePath &&
      artifact.destinationPath === entry.destinationPath &&
      artifact.mode === entry.mode &&
      artifact.size === entry.size &&
      artifact.contentDigest === entry.contentDigest &&
      entry.size === entry.content.length &&
      sha256(entry.content) === entry.contentDigest
    );
  });
}

export function derivePackPublicationAssets(input: {
  readonly release: PublicationReleaseIdentity;
  readonly entries: readonly SealedPublicationEntry[];
}): PackPublicationAssetResult {
  const releaseMatch = RELEASE_ID.exec(input.release.releaseId);
  if (!releaseMatch) return { ok: false, error: "invalid_release" };
  const authoringSet = validateAuthoringArtifactSet(
    input.entries.map((entry) => entry.destinationPath),
  );
  if (!authoringSet.ok || input.entries.some((entry) => entry.sourcePath.startsWith(".ut-tdd/")))
    return { ok: false, error: "artifact_mismatch" };
  const manifestError = validateManifestArtifacts(input.release.artifacts);
  if (manifestError) return { ok: false, error: manifestError };
  if (!exactEntries(input.release, input.entries)) return { ok: false, error: "artifact_mismatch" };
  if (input.entries.some((entry) => splitUstarPath(entry.destinationPath) === null))
    return { ok: false, error: "unsupported_path" };

  const tarBytes = createTar(input.entries);
  if (!tarBytes) return { ok: false, error: "unsupported_entry" };
  const tarballBytes = fixedGzip(tarBytes);
  const tarballName = `ut-tdd-pack-${releaseMatch[1]}.tar.gz`;
  const tarball: PublicationAsset = Object.freeze({
    name: tarballName,
    size: tarballBytes.length,
    contentDigest: sha256(tarballBytes),
    bytes: Buffer.from(tarballBytes),
  });
  const checksumBytes = Buffer.from(
    `${tarball.contentDigest.slice("sha256:".length)}  ${tarballName}\n`,
    "ascii",
  );
  const checksum: PublicationAsset = Object.freeze({
    name: `${tarballName}.sha256`,
    size: checksumBytes.length,
    contentDigest: sha256(checksumBytes),
    bytes: Buffer.from(checksumBytes),
  });
  const releaseAssetInventoryDigest = deriveReleaseAssetInventoryDigest([tarball, checksum]);
  return {
    ok: true,
    value: Object.freeze({
      tarball,
      checksum,
      releaseAssetInventoryDigest,
      tarBytes: Buffer.from(tarBytes),
    }),
  };
}

export function buildPackPublicationAssets(input: {
  readonly release: PublicationReleaseIdentity;
  readonly entries: readonly SealedPublicationEntry[];
}): PackPublicationAssetResult {
  const derived = derivePackPublicationAssets(input);
  if (!derived.ok) return derived;
  if (derived.value.releaseAssetInventoryDigest !== input.release.releaseAssetInventoryDigest)
    return { ok: false, error: "asset_inventory_mismatch" };
  return derived;
}
