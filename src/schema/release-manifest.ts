import { createHash } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";

const SHA256_DIGEST = /^sha256:([a-f0-9]{64})$/;
const RELEASE_ID = /^rel-sha256:([a-f0-9]{64})$/;
const SOURCE_COMMIT = /^[a-f0-9]{40}$/;
const ASCII = /^[\x20-\x7e]+$/;
const PUBLICATION_MODES = ["100644", "100755"] as const;

const releaseRecordSchema = z
  .object({
    materializerVersion: z.string().min(1),
    artifactSourceCommit: z.string().regex(SOURCE_COMMIT),
    artifactSetDigest: z.string().regex(SHA256_DIGEST),
  })
  .strict();

const releaseIdSchema = z.string().regex(RELEASE_ID);
const channelNameSchema = z.string().min(1);

export interface ReleaseIdentity {
  readonly releaseId: string;
  readonly materializerVersion: string;
  readonly artifactSourceCommit: string;
  readonly artifactSetDigest: string;
}

export interface PublicationArtifact {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly mode: (typeof PUBLICATION_MODES)[number];
  readonly size: number;
  readonly contentDigest: string;
}

export interface PublicationReleaseIdentity extends ReleaseIdentity {
  readonly artifactInventoryDigest: string;
  readonly releaseAssetInventoryDigest: string;
  readonly releaseRecordDigest: string;
  readonly artifacts: readonly PublicationArtifact[];
}

interface ReleaseManifestBase {
  readonly releases: Readonly<Record<string, ReleaseIdentity>>;
  readonly channels: Readonly<Record<string, string>>;
  readonly channelOrder: readonly string[];
}

export interface ReleaseManifestV1 extends ReleaseManifestBase {
  readonly schemaVersion: "v1";
}

export interface ReleaseManifestV2 extends ReleaseManifestBase {
  readonly schemaVersion: "v2";
  readonly releases: Readonly<Record<string, PublicationReleaseIdentity>>;
}

export type ReleaseManifest = ReleaseManifestV1 | ReleaseManifestV2;

export type PublicationManifestParseResult =
  | { readonly ok: true; readonly value: ReleaseManifestV2 }
  | { readonly ok: false; readonly error: "invalid_manifest" | "v1_read_only" };

export type ReleaseManifestParseResult =
  | { readonly ok: true; readonly value: ReleaseManifest }
  | { readonly ok: false; readonly error: "invalid_manifest" };

export type ReleaseChannelResolution =
  | { readonly ok: true; readonly release: ReleaseIdentity }
  | { readonly ok: false; readonly error: "unknown_channel" };

export function deriveReleaseId(
  materializerVersion: string,
  artifactSourceCommit: string,
  artifactSetDigest: string,
): string {
  const artifactDigest = Buffer.from(artifactSetDigest.slice("sha256:".length), "hex");
  const payload = Buffer.concat([
    Buffer.from(materializerVersion, "ascii"),
    Buffer.from([0]),
    Buffer.from(artifactSourceCommit, "ascii"),
    Buffer.from([0]),
    artifactDigest,
  ]);
  return `rel-sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function u32(value: number): Buffer {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function u64(value: number): Buffer {
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([u32(bytes.length), bytes]);
}

function digestBytes(value: string): Buffer {
  return Buffer.from(value.slice("sha256:".length), "hex");
}

export function deriveArtifactInventoryDigest(artifacts: readonly PublicationArtifact[]): string {
  const payload: Buffer[] = [
    Buffer.from("ut-tdd-pack-inventory-v2\0", "ascii"),
    u32(artifacts.length),
  ];
  for (const artifact of artifacts) {
    payload.push(
      lengthPrefixed(artifact.sourcePath),
      lengthPrefixed(artifact.destinationPath),
      lengthPrefixed(artifact.mode),
      lengthPrefixed(artifact.contentDigest),
      u64(artifact.size),
    );
  }
  return `sha256:${createHash("sha256").update(Buffer.concat(payload)).digest("hex")}`;
}

export function deriveReleaseRecordDigest(input: {
  readonly materializerVersion: string;
  readonly artifactSourceCommit: string;
  readonly artifactSetDigest: string;
  readonly artifactInventoryDigest: string;
  readonly releaseAssetInventoryDigest: string;
}): string {
  const payload = Buffer.concat([
    Buffer.from("ut-tdd-pack-release-v2\0", "ascii"),
    lengthPrefixed(input.materializerVersion),
    Buffer.from(input.artifactSourceCommit, "ascii"),
    digestBytes(input.artifactSetDigest),
    digestBytes(input.artifactInventoryDigest),
    digestBytes(input.releaseAssetInventoryDigest),
  ]);
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function hasCompleteChannelOrder(
  channels: Record<string, string>,
  channelOrder: string[],
): boolean {
  const channelNames = Object.keys(channels);
  if (channelNames.length !== channelOrder.length) return false;
  const orderedNames = new Set(channelOrder);
  return (
    orderedNames.size === channelOrder.length &&
    channelNames.every((name) => orderedNames.has(name))
  );
}

interface RawReleaseManifest {
  readonly schemaVersion: "v1" | "v2";
  readonly releases: Record<string, z.infer<typeof releaseRecordSchema>>;
  readonly channels: Record<string, string>;
  readonly channelOrder: string[];
}

const publicationArtifactSchema = z
  .object({
    sourcePath: z.string().min(1),
    destinationPath: z.string().min(1),
    mode: z.enum(PUBLICATION_MODES),
    size: z.number().int().nonnegative().safe(),
    contentDigest: z.string().regex(SHA256_DIGEST),
  })
  .strict();

const publicationRecordSchema = releaseRecordSchema
  .extend({
    artifactInventoryDigest: z.string().regex(SHA256_DIGEST),
    releaseAssetInventoryDigest: z.string().regex(SHA256_DIGEST),
    releaseRecordDigest: z.string().regex(SHA256_DIGEST),
    artifacts: z.array(publicationArtifactSchema),
  })
  .strict();

function isOwnRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(record, key));
}

function hasNoInheritedEnumerableKeys(record: Record<string, unknown>): boolean {
  for (const key in record) if (!Object.hasOwn(record, key)) return false;
  return true;
}

function validPublicationPath(value: string): boolean {
  const utf8 = Buffer.from(value, "utf8");
  return (
    value.length > 0 &&
    utf8.toString("utf8") === value &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/.test(value) &&
    !value.startsWith("//") &&
    posix.normalize(value) === value &&
    value !== "." &&
    !value.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

function validPublicationArtifacts(artifacts: readonly PublicationArtifact[]): boolean {
  const sources = new Set<string>();
  const destinations = new Set<string>();
  let previousDestination: Buffer | null = null;
  for (const artifact of artifacts) {
    if (
      !validPublicationPath(artifact.sourcePath) ||
      !validPublicationPath(artifact.destinationPath)
    )
      return false;
    if (sources.has(artifact.sourcePath) || destinations.has(artifact.destinationPath))
      return false;
    const destination = Buffer.from(artifact.destinationPath, "utf8");
    if (previousDestination && Buffer.compare(previousDestination, destination) >= 0) return false;
    sources.add(artifact.sourcePath);
    destinations.add(artifact.destinationPath);
    previousDestination = destination;
  }
  return true;
}

function parseRawManifest(input: unknown): RawReleaseManifest | null {
  if (
    !isOwnRecord(input) ||
    !hasExactKeys(input, ["schema_version", "releases", "channels", "channelOrder"])
  )
    return null;
  if (
    (input.schema_version !== "v1" && input.schema_version !== "v2") ||
    !isOwnRecord(input.releases) ||
    !isOwnRecord(input.channels) ||
    !hasNoInheritedEnumerableKeys(input.releases) ||
    !hasNoInheritedEnumerableKeys(input.channels)
  )
    return null;
  if (!Array.isArray(input.channelOrder)) return null;
  const releases = Object.create(null) as Record<string, z.infer<typeof releaseRecordSchema>>;
  for (const [releaseId, record] of Object.entries(input.releases)) {
    const parsedRecord =
      input.schema_version === "v2"
        ? publicationRecordSchema.safeParse(record)
        : releaseRecordSchema.safeParse(record);
    if (!releaseIdSchema.safeParse(releaseId).success || !parsedRecord.success) return null;
    releases[releaseId] = parsedRecord.data as z.infer<typeof releaseRecordSchema>;
  }
  const channels = Object.create(null) as Record<string, string>;
  for (const [channel, releaseId] of Object.entries(input.channels)) {
    if (
      !channelNameSchema.safeParse(channel).success ||
      typeof releaseId !== "string" ||
      !releaseIdSchema.safeParse(releaseId).success
    )
      return null;
    channels[channel] = releaseId;
  }
  if (!input.channelOrder.every((channel) => channelNameSchema.safeParse(channel).success))
    return null;
  if (
    input.schema_version === "v2" &&
    (!hasExactKeys(input.channels, ["canary", "stable"]) ||
      input.channelOrder.length !== 2 ||
      input.channelOrder[0] !== "canary" ||
      input.channelOrder[1] !== "stable")
  )
    return null;
  return {
    schemaVersion: input.schema_version,
    releases,
    channels,
    channelOrder: input.channelOrder,
  };
}

function createImmutableManifest(raw: RawReleaseManifest): ReleaseManifest | null {
  if (!hasCompleteChannelOrder(raw.channels, raw.channelOrder)) return null;
  const releases: Record<string, ReleaseIdentity> = {};
  for (const [releaseId, record] of Object.entries(raw.releases)) {
    if (
      deriveReleaseId(
        record.materializerVersion,
        record.artifactSourceCommit,
        record.artifactSetDigest,
      ) !== releaseId
    )
      return null;
    if (raw.schemaVersion === "v2") {
      const publication = record as z.infer<typeof publicationRecordSchema>;
      if (
        !ASCII.test(publication.materializerVersion) ||
        !validPublicationArtifacts(publication.artifacts) ||
        deriveArtifactInventoryDigest(publication.artifacts) !==
          publication.artifactInventoryDigest ||
        deriveReleaseRecordDigest(publication) !== publication.releaseRecordDigest
      )
        return null;
      const artifacts = publication.artifacts.map((artifact) => Object.freeze({ ...artifact }));
      releases[releaseId] = Object.freeze({
        releaseId,
        ...publication,
        artifacts: Object.freeze(artifacts),
      });
    } else {
      releases[releaseId] = Object.freeze({ releaseId, ...record });
    }
  }
  for (const releaseId of Object.values(raw.channels)) {
    if (!Object.hasOwn(releases, releaseId)) return null;
  }
  const channels = Object.freeze(Object.assign(Object.create(null), raw.channels));
  const channelOrder = Object.freeze([...raw.channelOrder]);
  if (raw.schemaVersion === "v2") {
    return Object.freeze({
      schemaVersion: "v2" as const,
      releases: Object.freeze(releases) as Readonly<Record<string, PublicationReleaseIdentity>>,
      channels,
      channelOrder,
    });
  }
  return Object.freeze({
    schemaVersion: "v1" as const,
    releases: Object.freeze(releases),
    channels,
    channelOrder,
  });
}

export function parseReleaseManifest(input: unknown): ReleaseManifestParseResult {
  const raw = parseRawManifest(input);
  if (!raw) return { ok: false, error: "invalid_manifest" };
  const manifest = createImmutableManifest(raw);
  return manifest ? { ok: true, value: manifest } : { ok: false, error: "invalid_manifest" };
}

export function parsePublicationManifest(input: unknown): PublicationManifestParseResult {
  const parsed = parseReleaseManifest(input);
  if (!parsed.ok) return parsed;
  if (parsed.value.schemaVersion !== "v2") return { ok: false, error: "v1_read_only" };
  return {
    ok: true,
    value: parsed.value,
  };
}

export function resolveReleaseChannel(
  manifest: ReleaseManifest,
  channel: string,
): ReleaseChannelResolution {
  if (!Object.hasOwn(manifest.channels, channel)) return { ok: false, error: "unknown_channel" };
  const releaseId = manifest.channels[channel];
  const release = manifest.releases[releaseId];
  return release ? { ok: true, release } : { ok: false, error: "unknown_channel" };
}
