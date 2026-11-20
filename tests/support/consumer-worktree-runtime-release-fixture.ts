import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  deriveArtifactInventoryDigest,
  deriveReleaseId,
  deriveReleaseRecordDigest,
  type PublicationArtifact,
  parsePublicationManifest,
} from "../../src/schema/release-manifest.ts";
import {
  canonicalJson,
  digestConsumerRuntimeBytes,
} from "../../src/setup/consumer-node-runtime.ts";
import { releaseArtifactFileNames } from "../../src/setup/distribution.ts";
import {
  derivePackPublicationAssets,
  type SealedPublicationEntry,
} from "../../src/setup/pack-publication-assets.ts";
import { deriveControlManifestSnapshotDigest } from "../../src/setup/pack-publication-staging.ts";
import { digestMaterializedReleaseEntries } from "../../src/setup/release-materializer.ts";

export const WORKTREE_RUNTIME_TAG = "v0.2.0-canary.1";
export const WORKTREE_RUNTIME_TAG_B = "v0.2.0-canary.2";
const REVISION_B = "b".repeat(40);

function sha256(bytes: Uint8Array): string {
  return digestConsumerRuntimeBytes(bytes).slice("sha256:".length);
}

export function writeReleaseFromInput(
  inputPath: string,
  releaseDir: string,
  tag = WORKTREE_RUNTIME_TAG,
) {
  const input = JSON.parse(readFileSync(inputPath, "utf8")) as {
    identity: { release_id: string; compiled_esm_digest: string };
    admission_input: {
      manifest: { materializerVersion: string; sourceRevision: string; artifactSetDigest: string };
      aggregate_input: Record<string, unknown>;
      control_manifest_base64: string;
    };
    compiled_esm_base64: string;
    node_bootstrap_receipt_base64: string;
  };
  const compiled = Buffer.from(input.compiled_esm_base64, "base64");
  const receipt = JSON.parse(
    Buffer.from(input.node_bootstrap_receipt_base64, "base64").toString("utf8"),
  ) as {
    generation_id: string;
    subject_revision: string;
  };
  const document = {
    schema_version: "ut-tdd.consumer-runtime.v1",
    release: {
      tag,
      source_revision: input.admission_input.manifest.sourceRevision,
      materializer_version: input.admission_input.manifest.materializerVersion,
      product_id: "ut-tdd",
    },
    generation: {
      generation_id: receipt.generation_id,
      subject_revision: receipt.subject_revision,
      artifact_digest: input.admission_input.manifest.artifactSetDigest,
      compiled_esm_digest: input.identity.compiled_esm_digest,
      node_bootstrap_receipt_base64: input.node_bootstrap_receipt_base64,
    },
    admission_input: {
      aggregate_input: input.admission_input.aggregate_input,
      control_manifest_base64: input.admission_input.control_manifest_base64,
    },
  };
  mkdirSync(releaseDir, { recursive: true });
  const names = releaseArtifactFileNames(tag);
  const documentBytes = Buffer.from(`${canonicalJson(document)}\n`, "utf8");
  const tarballBytes = Buffer.from("test-only release source archive\n", "utf8");
  const checksumBytes = Buffer.from(
    `${sha256(compiled)}  ${names.compiledEsm}\n${sha256(documentBytes)}  ${names.consumerRuntime}\n`,
    "utf8",
  );
  writeFileSync(join(releaseDir, names.compiledEsm), compiled);
  writeFileSync(join(releaseDir, names.consumerRuntime), documentBytes);
  writeFileSync(join(releaseDir, names.consumerChecksum), checksumBytes);
  writeFileSync(join(releaseDir, names.tarball), tarballBytes);
  writeFileSync(join(releaseDir, names.checksum), `${sha256(tarballBytes)}  ${names.tarball}\n`);
  return {
    anchor: digestConsumerRuntimeBytes(checksumBytes),
    releaseId: input.identity.release_id,
  };
}

export function createSmallAttestationInput(sourcePath: string, outputPath: string): void {
  const input = JSON.parse(readFileSync(sourcePath, "utf8")) as {
    identity: Record<string, string>;
    admission_input: {
      manifest: Record<string, string>;
      receipt: Record<string, string>;
      aggregate_input: {
        final_tree: {
          manifestEntries: { path: string; value: unknown }[];
          channelMappings: Record<string, string>[];
        };
        attestation: {
          status: "attested";
          releaseId: string;
          artifactSourceCommit: string;
          expectedDigest: string;
          actualDigest: string;
          entries: { path: string; mode: string; content_base64: string }[];
        };
      };
      control_manifest_base64: string;
    };
  };
  const sourceRevision = input.admission_input.manifest.sourceRevision;
  const bytes = Buffer.from("consumer worktree runtime fixture artifact\n", "utf8");
  const entry = { path: "src/entry.ts", mode: "100644" as const, content: bytes };
  const artifactSetDigest = digestMaterializedReleaseEntries([entry]);
  const releaseId = deriveReleaseId("1", sourceRevision, artifactSetDigest);
  const publicationEntry = {
    sourcePath: "releases/stable/entry.ts",
    destinationPath: entry.path,
    mode: entry.mode,
    size: bytes.length,
    contentDigest: digestConsumerRuntimeBytes(bytes),
    content: bytes,
  };
  const publicationArtifacts = [
    {
      sourcePath: publicationEntry.sourcePath,
      destinationPath: publicationEntry.destinationPath,
      mode: publicationEntry.mode,
      size: publicationEntry.size,
      contentDigest: publicationEntry.contentDigest,
    },
  ];
  const publicationBase = {
    materializerVersion: "1",
    artifactSourceCommit: sourceRevision,
    artifactSetDigest,
    artifactInventoryDigest: deriveArtifactInventoryDigest(publicationArtifacts),
    releaseAssetInventoryDigest: `sha256:${"0".repeat(64)}`,
    releaseRecordDigest: `sha256:${"0".repeat(64)}`,
    artifacts: publicationArtifacts,
  };
  const assets = derivePackPublicationAssets({
    release: { releaseId, ...publicationBase },
    entries: [publicationEntry],
  });
  if (!assets.ok) throw new Error(`small Release fixture assets invalid: ${assets.error}`);
  const publicationRelease = {
    ...publicationBase,
    releaseAssetInventoryDigest: assets.value.releaseAssetInventoryDigest,
  };
  const manifest = {
    schema_version: "v2" as const,
    releases: {
      [releaseId]: {
        ...publicationRelease,
        releaseRecordDigest: deriveReleaseRecordDigest(publicationRelease),
      },
    },
    channels: { canary: releaseId, stable: releaseId },
    channelOrder: ["canary", "stable"],
  };
  const manifestEntry = input.admission_input.aggregate_input.final_tree.manifestEntries[0];
  if (!manifestEntry) throw new Error("Release fixture manifest entry is missing");
  manifestEntry.value = manifest;
  for (const mapping of input.admission_input.aggregate_input.final_tree.channelMappings) {
    mapping.releaseId = releaseId;
    mapping.sourceRevision = sourceRevision;
  }
  input.admission_input.aggregate_input.attestation = {
    status: "attested",
    releaseId,
    artifactSourceCommit: sourceRevision,
    expectedDigest: artifactSetDigest,
    actualDigest: artifactSetDigest,
    entries: [{ path: entry.path, mode: entry.mode, content_base64: bytes.toString("base64") }],
  };
  input.admission_input.manifest.releaseId = releaseId;
  input.admission_input.manifest.artifactSetDigest = artifactSetDigest;
  input.admission_input.receipt.releaseId = releaseId;
  input.admission_input.receipt.artifactSetDigest = artifactSetDigest;
  input.admission_input.control_manifest_base64 = Buffer.from(
    stringifyYaml(manifest),
    "utf8",
  ).toString("base64");
  input.identity.release_id = releaseId;
  input.identity.artifact_set_digest = artifactSetDigest;
  const parsedManifest = parsePublicationManifest(manifest);
  if (!parsedManifest.ok)
    throw new Error(`small Release control manifest invalid: ${parsedManifest.error}`);
  input.identity.control_manifest_digest = deriveControlManifestSnapshotDigest(
    parsedManifest.value,
  );
  writeFileSync(outputPath, `${JSON.stringify(input)}\n`);
}

export function createVersionBInput(sourcePath: string, outputPath: string) {
  const input = JSON.parse(readFileSync(sourcePath, "utf8")) as {
    identity: Record<string, string>;
    admission_input: {
      manifest: {
        materializerVersion: string;
        releaseId: string;
        sourceRevision: string;
        artifactSetDigest: string;
      };
      receipt: Record<string, string>;
      aggregate_input: {
        final_tree: {
          manifestEntries: { path: string; value: unknown }[];
          channelMappings: Record<string, string>[];
        };
        attestation: {
          status: "attested";
          releaseId: string;
          artifactSourceCommit: string;
          expectedDigest: string;
          actualDigest: string;
          entries: { path: string; mode: string; content_base64: string }[];
        };
      };
      control_manifest_base64: string;
    };
    node_bootstrap_receipt_base64: string;
  };
  const releaseId = deriveReleaseId(
    input.admission_input.manifest.materializerVersion,
    REVISION_B,
    input.admission_input.manifest.artifactSetDigest,
  );
  const manifest = JSON.parse(
    JSON.stringify(
      parseYaml(
        Buffer.from(input.admission_input.control_manifest_base64, "base64").toString("utf8"),
      ),
    ),
  ) as {
    schema_version: "v2";
    releases: Record<string, Record<string, unknown>>;
    channels: Record<string, string>;
    channelOrder: string[];
  };
  const original = manifest.releases[input.admission_input.manifest.releaseId];
  if (!original) throw new Error("version A publication record is missing");
  const artifacts = original.artifacts as PublicationArtifact[];
  const sealedEntries: SealedPublicationEntry[] = artifacts.map((artifact) => {
    const attested = input.admission_input.aggregate_input.attestation.entries.find(
      (entry) => entry.path === artifact.destinationPath,
    );
    if (!attested) throw new Error(`version A attestation is missing ${artifact.destinationPath}`);
    return { ...artifact, content: Buffer.from(attested.content_base64, "base64") };
  });
  const publicationB = { ...original, artifactSourceCommit: REVISION_B } as Record<
    string,
    string | number | readonly unknown[]
  >;
  const assetsB = derivePackPublicationAssets({
    release: {
      releaseId,
      materializerVersion: String(publicationB.materializerVersion),
      artifactSourceCommit: REVISION_B,
      artifactSetDigest: String(publicationB.artifactSetDigest),
      artifactInventoryDigest: String(publicationB.artifactInventoryDigest),
      releaseAssetInventoryDigest: String(publicationB.releaseAssetInventoryDigest),
      releaseRecordDigest: String(publicationB.releaseRecordDigest),
      artifacts,
    },
    entries: sealedEntries,
  });
  if (!assetsB.ok) throw new Error(`version B Release assets invalid: ${assetsB.error}`);
  publicationB.releaseAssetInventoryDigest = assetsB.value.releaseAssetInventoryDigest;
  publicationB.releaseRecordDigest = deriveReleaseRecordDigest({
    materializerVersion: String(publicationB.materializerVersion),
    artifactSourceCommit: REVISION_B,
    artifactSetDigest: String(publicationB.artifactSetDigest),
    artifactInventoryDigest: String(publicationB.artifactInventoryDigest),
    releaseAssetInventoryDigest: String(publicationB.releaseAssetInventoryDigest),
  });
  delete manifest.releases[input.admission_input.manifest.releaseId];
  manifest.releases[releaseId] = publicationB;
  for (const channel of Object.keys(manifest.channels)) manifest.channels[channel] = releaseId;
  input.admission_input.manifest.releaseId = releaseId;
  input.admission_input.manifest.sourceRevision = REVISION_B;
  input.admission_input.receipt.releaseId = releaseId;
  input.admission_input.receipt.sourceRevision = REVISION_B;
  for (const mapping of input.admission_input.aggregate_input.final_tree.channelMappings) {
    mapping.releaseId = releaseId;
    mapping.sourceRevision = REVISION_B;
  }
  input.admission_input.aggregate_input.attestation.releaseId = releaseId;
  input.admission_input.aggregate_input.attestation.artifactSourceCommit = REVISION_B;
  const manifestEntry = input.admission_input.aggregate_input.final_tree.manifestEntries[0];
  if (!manifestEntry) throw new Error("version A manifest entry is missing");
  manifestEntry.value = manifest;
  input.admission_input.control_manifest_base64 = Buffer.from(
    stringifyYaml(manifest),
    "utf8",
  ).toString("base64");
  const oldReceipt = JSON.parse(
    Buffer.from(input.node_bootstrap_receipt_base64, "base64").toString("utf8"),
  ) as Record<string, unknown>;
  const { receipt_digest: _oldDigest, ...receiptUnsigned } = oldReceipt;
  receiptUnsigned.subject_revision = REVISION_B;
  const receiptDigest = createHash("sha256").update(canonicalJson(receiptUnsigned)).digest("hex");
  input.node_bootstrap_receipt_base64 = Buffer.from(
    JSON.stringify({ ...receiptUnsigned, receipt_digest: receiptDigest }),
  ).toString("base64");
  input.identity.release_id = releaseId;
  input.identity.subject_revision = REVISION_B;
  const parsedManifest = parsePublicationManifest(manifest);
  if (!parsedManifest.ok)
    throw new Error(`version B control manifest invalid: ${parsedManifest.error}`);
  input.identity.control_manifest_digest = deriveControlManifestSnapshotDigest(
    parsedManifest.value,
  );
  writeFileSync(outputPath, `${JSON.stringify(input)}\n`);
  return { releaseId, inputPath: outputPath };
}
