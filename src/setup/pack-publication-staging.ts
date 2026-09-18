import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import {
  type PublicationReleaseIdentity,
  parsePublicationManifest,
  type ReleaseManifestV2,
} from "../schema/release-manifest.ts";
import {
  buildPackPublicationAssets,
  type PackPublicationAssetError,
  type SealedPublicationEntry,
} from "./pack-publication-assets.ts";

const CONTROL_MANIFEST_PATH = "release/manifest.yaml";

export type PackPublicationManifest = ReleaseManifestV2;

export interface PackPublicationCommitEntry {
  readonly path: string;
  readonly mode: "100644" | "100755";
  readonly size: number;
  readonly contentDigest: string;
  readonly kind: "artifact" | "control-manifest";
  readonly bytes: Uint8Array;
}

export interface PackPublicationReleaseAsset {
  readonly name: string;
  readonly size: number;
  readonly contentDigest: string;
  readonly bytes: Uint8Array;
}

export interface SealedPackPublicationPlan {
  readonly kind: "pack-publication-staging";
  readonly releaseId: string;
  readonly manifest: PackPublicationManifest;
  readonly controlManifestSnapshotDigest: string;
  readonly commitEntries: readonly PackPublicationCommitEntry[];
  readonly releaseAssets: readonly [PackPublicationReleaseAsset, PackPublicationReleaseAsset];
}

export interface PackPublicationStagingInput {
  readonly manifestInput: unknown;
  readonly releaseId: string;
  readonly controlManifestBytes: Uint8Array;
  readonly entries: readonly SealedPublicationEntry[];
}

export type PackPublicationStagingError =
  | "invalid_manifest"
  | "v1_read_only"
  | "unknown_release"
  | "control_manifest_mismatch"
  | "commit_entry_mismatch"
  | PackPublicationAssetError;

export type PackPublicationStagingResult =
  | { readonly ok: true; readonly plan: SealedPackPublicationPlan }
  | {
      readonly ok: false;
      readonly phase: "preflight";
      readonly error: PackPublicationStagingError;
    };

export interface PackPublicationObservation {
  readonly commitEntries: readonly PackPublicationCommitEntry[];
  readonly releaseAssets: readonly PackPublicationReleaseAsset[];
  readonly controlManifestSnapshotDigest: string;
}

export interface PackPublicationAuditPorts {
  readonly observe: () => PackPublicationObservation | Promise<PackPublicationObservation>;
}

export type PackPublicationAuditResult =
  | {
      readonly status: "attested";
      readonly releaseId: string;
      readonly controlManifestSnapshotDigest: string;
    }
  | {
      readonly status: "partial_publication";
      readonly reason:
        | "commit_entries_mismatch"
        | "release_assets_mismatch"
        | "control_manifest_mismatch";
    }
  | { readonly status: "indeterminate"; readonly reason: "observation_unavailable" };

export interface PackPublicationApplyPorts<TStage, TSnapshot> {
  readonly snapshotDestination: () => TSnapshot | Promise<TSnapshot>;
  readonly writeStaging: (plan: SealedPackPublicationPlan) => TStage | Promise<TStage>;
  readonly applyDestination: (
    stage: TStage,
    plan: SealedPackPublicationPlan,
  ) => void | Promise<void>;
  readonly discardStaging: (stage: TStage) => void | Promise<void>;
  readonly restoreDestination: (snapshot: TSnapshot) => void | Promise<void>;
}

export type PackPublicationApplyResult =
  | { readonly ok: true; readonly applied: 1 }
  | { readonly ok: false; readonly error: "unavailable"; readonly applied: 0 }
  | {
      readonly ok: false;
      readonly error: "indeterminate";
      readonly applied: "indeterminate";
    };

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([u32(bytes.length), bytes]);
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function immutableCommitEntry(input: {
  readonly path: string;
  readonly mode: "100644" | "100755";
  readonly kind: "artifact" | "control-manifest";
  readonly bytes: Uint8Array;
  readonly contentDigest: string;
}): PackPublicationCommitEntry {
  const bytes = Buffer.from(input.bytes);
  const entry = {
    path: input.path,
    mode: input.mode,
    size: bytes.length,
    contentDigest: input.contentDigest,
    kind: input.kind,
    get bytes(): Uint8Array {
      return new Uint8Array(bytes);
    },
  };
  return Object.freeze(entry);
}

function immutableAsset(input: {
  readonly name: string;
  readonly size: number;
  readonly contentDigest: string;
  readonly bytes: Uint8Array;
}): PackPublicationReleaseAsset {
  const bytes = Buffer.from(input.bytes);
  return Object.freeze({
    name: input.name,
    size: input.size,
    contentDigest: input.contentDigest,
    get bytes(): Uint8Array {
      return new Uint8Array(bytes);
    },
  });
}

export function deriveControlManifestSnapshotDigest(manifest: PackPublicationManifest): string {
  const releaseIds = Object.keys(manifest.releases).sort(utf8Compare);
  const payload: Buffer[] = [
    Buffer.from("ut-tdd-pack-control-v2\0", "ascii"),
    lengthPrefixed("releases"),
    lengthPrefixed(String(releaseIds.length)),
  ];
  for (const releaseId of releaseIds) {
    const release = manifest.releases[releaseId];
    payload.push(lengthPrefixed(releaseId), lengthPrefixed(release.releaseRecordDigest));
  }
  payload.push(lengthPrefixed("channels"), lengthPrefixed(String(manifest.channelOrder.length)));
  for (const channel of manifest.channelOrder) {
    payload.push(lengthPrefixed(channel), lengthPrefixed(manifest.channels[channel]));
  }
  return sha256(Buffer.concat(payload));
}

function parseControlManifest(bytes: Uint8Array): PackPublicationManifest | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = parsePublicationManifest(parseYaml(text));
    return parsed.ok ? parsed.value : null;
  } catch {
    return null;
  }
}

function sameSemanticManifest(
  left: PackPublicationManifest,
  right: PackPublicationManifest,
): boolean {
  return deriveControlManifestSnapshotDigest(left) === deriveControlManifestSnapshotDigest(right);
}

function exactSealedEntries(
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

function packCommitEntries(
  release: PublicationReleaseIdentity,
  entries: readonly SealedPublicationEntry[],
  controlManifestBytes: Uint8Array,
): readonly PackPublicationCommitEntry[] | null {
  if (!exactSealedEntries(release, entries)) return null;
  if (release.artifacts.some((artifact) => artifact.destinationPath === CONTROL_MANIFEST_PATH))
    return null;
  const output = release.artifacts.map((artifact, index) =>
    immutableCommitEntry({
      path: artifact.destinationPath,
      mode: artifact.mode,
      kind: "artifact",
      bytes: entries[index].content,
      contentDigest: artifact.contentDigest,
    }),
  );
  const sidecar = Buffer.from(controlManifestBytes);
  output.push(
    immutableCommitEntry({
      path: CONTROL_MANIFEST_PATH,
      mode: "100644",
      kind: "control-manifest",
      bytes: sidecar,
      contentDigest: sha256(sidecar),
    }),
  );
  output.sort((left, right) => utf8Compare(left.path, right.path));
  return Object.freeze(output);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0;
}

function exactCommitEntries(
  expected: readonly PackPublicationCommitEntry[],
  actual: readonly PackPublicationCommitEntry[],
): boolean {
  return (
    expected.length === actual.length &&
    expected.every((entry, index) => {
      const observed = actual[index];
      return (
        observed !== undefined &&
        entry.path === observed.path &&
        entry.mode === observed.mode &&
        entry.size === observed.size &&
        entry.contentDigest === observed.contentDigest &&
        entry.kind === observed.kind &&
        sameBytes(entry.bytes, observed.bytes)
      );
    })
  );
}

function exactAssets(
  expected: readonly PackPublicationReleaseAsset[],
  actual: readonly PackPublicationReleaseAsset[],
): boolean {
  return (
    expected.length === actual.length &&
    expected.every((asset, index) => {
      const observed = actual[index];
      return (
        observed !== undefined &&
        asset.name === observed.name &&
        asset.size === observed.size &&
        asset.contentDigest === observed.contentDigest &&
        sameBytes(asset.bytes, observed.bytes)
      );
    })
  );
}

export function buildPackPublicationStagingPlan(
  input: PackPublicationStagingInput,
): PackPublicationStagingResult {
  const parsed = parsePublicationManifest(input.manifestInput);
  if (!parsed.ok) return { ok: false, phase: "preflight", error: parsed.error };
  const manifest = parsed.value;
  const release = manifest.releases[input.releaseId];
  if (!release) return { ok: false, phase: "preflight", error: "unknown_release" };
  const controlManifest = parseControlManifest(input.controlManifestBytes);
  if (!controlManifest || !sameSemanticManifest(manifest, controlManifest))
    return { ok: false, phase: "preflight", error: "control_manifest_mismatch" };
  const commitEntries = packCommitEntries(release, input.entries, input.controlManifestBytes);
  if (!commitEntries) return { ok: false, phase: "preflight", error: "commit_entry_mismatch" };
  const assets = buildPackPublicationAssets({ release, entries: input.entries });
  if (!assets.ok) return { ok: false, phase: "preflight", error: assets.error };
  const releaseAssets = Object.freeze([
    immutableAsset(assets.value.tarball),
    immutableAsset(assets.value.checksum),
  ]) as unknown as readonly [PackPublicationReleaseAsset, PackPublicationReleaseAsset];
  return {
    ok: true,
    plan: Object.freeze({
      kind: "pack-publication-staging" as const,
      releaseId: input.releaseId,
      manifest,
      controlManifestSnapshotDigest: deriveControlManifestSnapshotDigest(manifest),
      commitEntries,
      releaseAssets,
    }),
  };
}

export async function applySealedPackPublication<TStage, TSnapshot>(
  plan: SealedPackPublicationPlan,
  ports: PackPublicationApplyPorts<TStage, TSnapshot>,
): Promise<PackPublicationApplyResult> {
  let snapshot!: TSnapshot;
  let snapshotCaptured = false;
  let stage: TStage | undefined;
  let stagingCreated = false;
  let discarded = false;
  try {
    snapshot = await ports.snapshotDestination();
    snapshotCaptured = true;
    stage = await ports.writeStaging(plan);
    stagingCreated = true;
    await ports.applyDestination(stage, plan);
    await ports.discardStaging(stage);
    discarded = true;
    return { ok: true, applied: 1 };
  } catch {
    if (stagingCreated && !discarded) {
      try {
        await ports.discardStaging(stage as TStage);
      } catch {
        // Restore remains authoritative when stage cleanup is uncertain.
      }
    }
    if (!snapshotCaptured) return { ok: false, error: "unavailable", applied: 0 };
    try {
      await ports.restoreDestination(snapshot);
    } catch {
      return { ok: false, error: "indeterminate", applied: "indeterminate" };
    }
    return { ok: false, error: "unavailable", applied: 0 };
  }
}

export async function auditPackPublication(
  plan: SealedPackPublicationPlan,
  ports: PackPublicationAuditPorts,
): Promise<PackPublicationAuditResult> {
  let observed: PackPublicationObservation;
  try {
    observed = await ports.observe();
  } catch {
    return { status: "indeterminate", reason: "observation_unavailable" };
  }
  if (observed.controlManifestSnapshotDigest !== plan.controlManifestSnapshotDigest)
    return { status: "partial_publication", reason: "control_manifest_mismatch" };
  if (!exactCommitEntries(plan.commitEntries, observed.commitEntries))
    return { status: "partial_publication", reason: "commit_entries_mismatch" };
  if (!exactAssets(plan.releaseAssets, observed.releaseAssets))
    return { status: "partial_publication", reason: "release_assets_mismatch" };
  return {
    status: "attested",
    releaseId: plan.releaseId,
    controlManifestSnapshotDigest: plan.controlManifestSnapshotDigest,
  };
}
