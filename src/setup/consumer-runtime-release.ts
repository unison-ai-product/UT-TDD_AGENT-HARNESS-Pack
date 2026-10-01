import { createHash } from "node:crypto";
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  type NodeBootstrapReceipt,
  parseNodeBootstrapReceiptBytes,
} from "../runtime/node-bootstrap.ts";
import { parseReleaseManifest } from "../schema/release-manifest.ts";
import {
  canonicalJson,
  digestConsumerRuntimeBytes,
  SAFE_PRODUCT_ID,
} from "./consumer-node-runtime.ts";
import { releaseArtifactFileNames } from "./distribution.ts";
import { digestMaterializedReleaseEntries } from "./release-materializer.ts";

const REVISION = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface ConsumerRuntimeRelease {
  readonly schema_version: "ut-tdd.consumer-runtime.v1";
  readonly release: {
    readonly tag: string;
    readonly source_revision: string;
    readonly materializer_version: string;
    readonly product_id: string;
  };
  readonly generation: {
    readonly generation_id: string;
    readonly subject_revision: string;
    readonly artifact_digest: string;
    readonly compiled_esm_digest: string;
    readonly node_bootstrap_receipt_base64: string;
  };
  readonly admission_input: {
    readonly aggregate_input: {
      readonly repository: string;
      readonly channel: string;
      readonly final_tree: {
        readonly manifestEntries: readonly { readonly path: string; readonly value: unknown }[];
        readonly sourcePaths: readonly string[];
        readonly cleanPackAllowlist: readonly string[];
        readonly channelMappings: readonly {
          readonly channel: string;
          readonly releaseId: string;
          readonly sourceRevision: string;
          readonly sourcePath: string;
          readonly destinationPath: string;
        }[];
      };
      readonly attestation: {
        readonly status: "attested";
        readonly releaseId: string;
        readonly artifactSourceCommit: string;
        readonly expectedDigest: string;
        readonly actualDigest: string;
        readonly entries: readonly {
          readonly path: string;
          readonly mode: "100644" | "100755" | "120000";
          readonly content_base64: string;
        }[];
      };
    };
    readonly control_manifest_base64: string;
  };
}

export type ConsumerRuntimeReleaseDocument = ConsumerRuntimeRelease;
export type ConsumerRuntimeReleaseAdmissionInput = ConsumerRuntimeRelease["admission_input"];

export interface VerifiedConsumerRuntimeReleaseAssets {
  readonly document: ConsumerRuntimeRelease;
  readonly compiledEsmBytes: Buffer;
  readonly receiptBytes: Buffer;
  readonly checksumBytes: Buffer;
}

export class ConsumerRuntimeReleaseValidationError extends Error {
  readonly code: "consumer_runtime_schema_invalid";

  constructor(detail = "consumer-runtime.json schema v1 is invalid") {
    super(`consumer_runtime_schema_invalid:${detail}`);
    this.code = "consumer_runtime_schema_invalid";
    this.name = "ConsumerRuntimeReleaseValidationError";
  }
}

function digestHex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Verify the external anchor and the exact immutable Release asset set before any consumer write. */
export function verifyConsumerRuntimeReleaseAssets(input: {
  readonly releaseDirectory: string;
  readonly tag: string;
  readonly expectedConsumerDigest: string;
  readonly executingModulePath: string;
}): VerifiedConsumerRuntimeReleaseAssets {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.tag) ||
    basename(input.tag) !== input.tag ||
    !/^sha256:[a-f0-9]{64}$/.test(input.expectedConsumerDigest)
  )
    throw new Error("consumer_runtime_anchor_mismatch");

  const releaseDirectory = resolve(input.releaseDirectory);
  const names = releaseArtifactFileNames(input.tag);
  let checksumBytes: Buffer;
  try {
    checksumBytes = readFileSync(join(releaseDirectory, names.consumerChecksum));
  } catch {
    throw new Error("consumer_runtime_anchor_mismatch");
  }
  if (`sha256:${digestHex(checksumBytes)}` !== input.expectedConsumerDigest)
    throw new Error("consumer_runtime_anchor_mismatch");

  const expectedNames = Object.values(names).sort();
  let actualEntries: Dirent<string>[];
  try {
    actualEntries = readdirSync(releaseDirectory, { withFileTypes: true, encoding: "utf8" });
  } catch {
    throw new Error("consumer_runtime_asset_set_mismatch");
  }
  const actualNames = actualEntries.map((entry) => entry.name).sort();
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index]) ||
    actualEntries.some((entry) => !entry.isFile())
  )
    throw new Error("consumer_runtime_asset_set_mismatch");
  for (const name of expectedNames) {
    try {
      if (!statSync(join(releaseDirectory, name)).isFile())
        throw new Error("consumer_runtime_asset_set_mismatch");
    } catch {
      throw new Error("consumer_runtime_asset_set_mismatch");
    }
  }

  const checksumText = checksumBytes.toString("utf8");
  const checksumLines = checksumText.split("\n");
  const compiledLine = /^([a-f0-9]{64}) {2}(.+)$/.exec(checksumLines[0] ?? "");
  const documentLine = /^([a-f0-9]{64}) {2}(.+)$/.exec(checksumLines[1] ?? "");
  if (
    checksumLines.length !== 3 ||
    checksumLines[2] !== "" ||
    compiledLine?.[2] !== names.compiledEsm ||
    documentLine?.[2] !== names.consumerRuntime
  )
    throw new Error("consumer_runtime_checksum_invalid");

  const expectedCompiledDigest = compiledLine[1];
  const expectedDocumentDigest = documentLine[1];
  const compiledEsmBytes = readFileSync(join(releaseDirectory, names.compiledEsm));
  const documentBytes = readFileSync(join(releaseDirectory, names.consumerRuntime));
  if (
    digestHex(compiledEsmBytes) !== expectedCompiledDigest ||
    digestHex(documentBytes) !== expectedDocumentDigest
  )
    throw new Error("consumer_runtime_digest_mismatch");

  let parsed: unknown;
  try {
    parsed = JSON.parse(documentBytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("consumer_runtime_schema_invalid");
  }
  const document = validateConsumerRuntimeRelease(parsed);
  if (document.release.tag !== input.tag)
    throw new Error("consumer_runtime_release_binding_mismatch");
  if (digestConsumerRuntimeBytes(compiledEsmBytes) !== document.generation.compiled_esm_digest)
    throw new Error("consumer_runtime_self_digest_mismatch");

  const receiptBytes = Buffer.from(document.generation.node_bootstrap_receipt_base64, "base64");
  let executingBytes: Buffer;
  try {
    executingBytes = readFileSync(input.executingModulePath);
  } catch {
    throw new Error("consumer_runtime_self_digest_mismatch");
  }
  if (digestConsumerRuntimeBytes(executingBytes) !== document.generation.compiled_esm_digest)
    throw new Error("consumer_runtime_self_digest_mismatch");

  return { document, compiledEsmBytes, receiptBytes, checksumBytes };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
  );
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ConsumerRuntimeReleaseValidationError("object_required");
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new ConsumerRuntimeReleaseValidationError(`${name}_required`);
  return value;
}

function base64Value(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0))
    throw new ConsumerRuntimeReleaseValidationError(`${name}_required`);
  const text = value;
  if (allowEmpty && text.length === 0) return text;
  if (!BASE64.test(text) || Buffer.from(text, "base64").toString("base64") !== text)
    throw new ConsumerRuntimeReleaseValidationError(`${name}_base64_invalid`);
  return text;
}

/**
 * Validate the one shared schema boundary used by the producer and installer.
 * This is intentionally strict at every contract-owned object boundary.
 */
export function validateConsumerRuntimeRelease(input: unknown): ConsumerRuntimeRelease {
  const root = record(input);
  if (!exactKeys(root, ["schema_version", "release", "generation", "admission_input"]))
    throw new ConsumerRuntimeReleaseValidationError("root_fields_invalid");
  if (root.schema_version !== "ut-tdd.consumer-runtime.v1")
    throw new ConsumerRuntimeReleaseValidationError("schema_version_invalid");

  const release = record(root.release);
  if (!exactKeys(release, ["tag", "source_revision", "materializer_version", "product_id"]))
    throw new ConsumerRuntimeReleaseValidationError("release_fields_invalid");
  const tag = stringValue(release.tag, "release.tag");
  const sourceRevision = stringValue(release.source_revision, "release.source_revision");
  const materializerVersion = stringValue(
    release.materializer_version,
    "release.materializer_version",
  );
  const productId = stringValue(release.product_id, "release.product_id");
  if (!REVISION.test(sourceRevision))
    throw new ConsumerRuntimeReleaseValidationError("release.source_revision_invalid");
  if (!SAFE_PRODUCT_ID.test(productId))
    throw new ConsumerRuntimeReleaseValidationError("release.product_id_invalid");

  const generation = record(root.generation);
  if (
    !exactKeys(generation, [
      "generation_id",
      "subject_revision",
      "artifact_digest",
      "compiled_esm_digest",
      "node_bootstrap_receipt_base64",
    ])
  )
    throw new ConsumerRuntimeReleaseValidationError("generation_fields_invalid");
  const generationId = stringValue(generation.generation_id, "generation.generation_id");
  const subjectRevision = stringValue(generation.subject_revision, "generation.subject_revision");
  const artifactDigest = stringValue(generation.artifact_digest, "generation.artifact_digest");
  const compiledEsmDigest = stringValue(
    generation.compiled_esm_digest,
    "generation.compiled_esm_digest",
  );
  const receiptBase64 = base64Value(
    generation.node_bootstrap_receipt_base64,
    "generation.node_bootstrap_receipt_base64",
  );
  if (!/^[a-z0-9._-]+$/.test(generationId) || !REVISION.test(subjectRevision))
    throw new ConsumerRuntimeReleaseValidationError("generation_identity_invalid");
  if (!DIGEST.test(artifactDigest) || !DIGEST.test(compiledEsmDigest))
    throw new ConsumerRuntimeReleaseValidationError("generation_digest_invalid");

  const admission = record(root.admission_input);
  if (!exactKeys(admission, ["aggregate_input", "control_manifest_base64"]))
    throw new ConsumerRuntimeReleaseValidationError("admission_input_fields_invalid");
  const aggregate = record(admission.aggregate_input);
  if (!exactKeys(aggregate, ["repository", "channel", "final_tree", "attestation"]))
    throw new ConsumerRuntimeReleaseValidationError("aggregate_input_fields_invalid");
  const repository = stringValue(aggregate.repository, "aggregate_input.repository");
  const channel = stringValue(aggregate.channel, "aggregate_input.channel");

  const finalTree = record(aggregate.final_tree);
  if (
    !exactKeys(finalTree, [
      "manifestEntries",
      "sourcePaths",
      "cleanPackAllowlist",
      "channelMappings",
    ])
  )
    throw new ConsumerRuntimeReleaseValidationError("final_tree_fields_invalid");
  const manifestEntries = finalTree.manifestEntries;
  const sourcePaths = finalTree.sourcePaths;
  const allowlist = finalTree.cleanPackAllowlist;
  const mappings = finalTree.channelMappings;
  if (
    !Array.isArray(manifestEntries) ||
    !Array.isArray(sourcePaths) ||
    !Array.isArray(allowlist) ||
    !Array.isArray(mappings)
  )
    throw new ConsumerRuntimeReleaseValidationError("final_tree_arrays_invalid");
  if (manifestEntries.length !== 1)
    throw new ConsumerRuntimeReleaseValidationError("manifest_entries_invalid");
  for (const entryValue of manifestEntries) {
    const entry = record(entryValue);
    if (
      !exactKeys(entry, ["path", "value"]) ||
      stringValue(entry.path, "manifestEntries.path") !== "release/manifest.yaml"
    )
      throw new ConsumerRuntimeReleaseValidationError("manifest_entry_invalid");
    if (!parseReleaseManifest(entry.value).ok)
      throw new ConsumerRuntimeReleaseValidationError("manifest_value_invalid");
  }
  const paths = (values: unknown[], name: string): string[] =>
    values.map((value) => stringValue(value, name));
  const sourcePathValues = paths(sourcePaths, "final_tree.sourcePaths");
  const allowlistValues = paths(allowlist, "final_tree.cleanPackAllowlist");
  const mappingValues = mappings.map((mappingValue) => {
    const mapping = record(mappingValue);
    if (
      !exactKeys(mapping, [
        "channel",
        "releaseId",
        "sourceRevision",
        "sourcePath",
        "destinationPath",
      ])
    )
      throw new ConsumerRuntimeReleaseValidationError("channel_mapping_fields_invalid");
    const parsed = {
      channel: stringValue(mapping.channel, "channelMappings.channel"),
      releaseId: stringValue(mapping.releaseId, "channelMappings.releaseId"),
      sourceRevision: stringValue(mapping.sourceRevision, "channelMappings.sourceRevision"),
      sourcePath: stringValue(mapping.sourcePath, "channelMappings.sourcePath"),
      destinationPath: stringValue(mapping.destinationPath, "channelMappings.destinationPath"),
    };
    if (!REVISION.test(parsed.sourceRevision))
      throw new ConsumerRuntimeReleaseValidationError("channel_mapping_revision_invalid");
    return parsed;
  });

  const attestation = record(aggregate.attestation);
  if (
    !exactKeys(attestation, [
      "status",
      "releaseId",
      "artifactSourceCommit",
      "expectedDigest",
      "actualDigest",
      "entries",
    ])
  )
    throw new ConsumerRuntimeReleaseValidationError("attestation_fields_invalid");
  if (attestation.status !== "attested")
    throw new ConsumerRuntimeReleaseValidationError("attestation_status_invalid");
  const attestationEntries = attestation.entries;
  if (!Array.isArray(attestationEntries))
    throw new ConsumerRuntimeReleaseValidationError("attestation_entries_invalid");
  const attestationValue = {
    status: "attested" as const,
    releaseId: stringValue(attestation.releaseId, "attestation.releaseId"),
    artifactSourceCommit: stringValue(
      attestation.artifactSourceCommit,
      "attestation.artifactSourceCommit",
    ),
    expectedDigest: stringValue(attestation.expectedDigest, "attestation.expectedDigest"),
    actualDigest: stringValue(attestation.actualDigest, "attestation.actualDigest"),
    entries: attestationEntries.map((entryValue) => {
      const entry = record(entryValue);
      if (!exactKeys(entry, ["path", "mode", "content_base64"]))
        throw new ConsumerRuntimeReleaseValidationError("attestation_entry_fields_invalid");
      const mode = stringValue(entry.mode, "attestation.entry.mode");
      if (mode !== "100644" && mode !== "100755" && mode !== "120000")
        throw new ConsumerRuntimeReleaseValidationError("attestation_entry_mode_invalid");
      return {
        path: stringValue(entry.path, "attestation.entry.path"),
        mode,
        content_base64: base64Value(entry.content_base64, "attestation.entry.content_base64", true),
      } as const;
    }),
  };
  if (
    !REVISION.test(attestationValue.artifactSourceCommit) ||
    !DIGEST.test(attestationValue.expectedDigest) ||
    !DIGEST.test(attestationValue.actualDigest)
  )
    throw new ConsumerRuntimeReleaseValidationError("attestation_identity_invalid");
  const controlManifestBase64 = base64Value(
    admission.control_manifest_base64,
    "control_manifest_base64",
  );
  if (subjectRevision !== sourceRevision)
    throw new ConsumerRuntimeReleaseValidationError("generation_source_revision_mismatch");

  // The receipt is part of the schema boundary: malformed sealed bytes are not
  // a valid v1 document even when their base64 wrapper is well-formed.
  let receipt: NodeBootstrapReceipt;
  try {
    receipt = parseNodeBootstrapReceiptBytes(Buffer.from(receiptBase64, "base64"));
  } catch {
    throw new ConsumerRuntimeReleaseValidationError("node_bootstrap_receipt_invalid");
  }
  if (
    receipt.generation_id !== generationId ||
    receipt.subject_revision !== sourceRevision ||
    `sha256:${receipt.compiled_cli.sha256}` !== compiledEsmDigest
  )
    throw new ConsumerRuntimeReleaseValidationError("generation_receipt_mismatch");

  const attestedEntries = attestationValue.entries.map((entry) => ({
    path: entry.path,
    mode: entry.mode,
    content: Buffer.from(entry.content_base64, "base64"),
  }));
  const computedArtifactDigest = digestMaterializedReleaseEntries(attestedEntries);
  if (
    attestationValue.expectedDigest !== attestationValue.actualDigest ||
    attestationValue.actualDigest !== computedArtifactDigest ||
    artifactDigest !== computedArtifactDigest ||
    attestationValue.artifactSourceCommit !== sourceRevision
  )
    throw new ConsumerRuntimeReleaseValidationError("aggregate_digest_mismatch");

  const manifestValue = (manifestEntries[0] as Record<string, unknown>).value;
  const parsedManifest = parseReleaseManifest(manifestValue);
  if (!parsedManifest.ok) throw new ConsumerRuntimeReleaseValidationError("manifest_value_invalid");
  let controlManifestValue: unknown;
  try {
    controlManifestValue = parseYaml(Buffer.from(controlManifestBase64, "base64").toString("utf8"));
  } catch {
    throw new ConsumerRuntimeReleaseValidationError("control_manifest_invalid");
  }
  const parsedControlManifest = parseReleaseManifest(controlManifestValue);
  if (
    !parsedControlManifest.ok ||
    canonicalJson(parsedControlManifest.value) !== canonicalJson(parsedManifest.value)
  )
    throw new ConsumerRuntimeReleaseValidationError("control_manifest_mismatch");
  const selectedReleaseId = parsedManifest.value.channels[channel];
  const selectedRelease = parsedManifest.value.releases[selectedReleaseId];
  const selectedArtifacts =
    selectedRelease && "artifacts" in selectedRelease ? selectedRelease.artifacts : undefined;
  if (
    !selectedRelease ||
    !selectedArtifacts ||
    selectedRelease.materializerVersion !== materializerVersion ||
    selectedRelease.artifactSourceCommit !== sourceRevision ||
    selectedRelease.artifactSetDigest !== computedArtifactDigest ||
    attestationValue.releaseId !== selectedReleaseId ||
    mappingValues.length !== selectedArtifacts.length ||
    sourcePathValues.length !== selectedArtifacts.length ||
    mappingValues.some(
      (mapping, index) =>
        mapping.channel !== channel ||
        mapping.releaseId !== selectedReleaseId ||
        mapping.sourceRevision !== sourceRevision ||
        mapping.sourcePath !== selectedArtifacts[index]?.sourcePath ||
        mapping.destinationPath !== selectedArtifacts[index]?.destinationPath,
    )
  )
    throw new ConsumerRuntimeReleaseValidationError("aggregate_identity_mismatch");

  return {
    schema_version: "ut-tdd.consumer-runtime.v1",
    release: {
      tag,
      source_revision: sourceRevision,
      materializer_version: materializerVersion,
      product_id: productId,
    },
    generation: {
      generation_id: generationId,
      subject_revision: subjectRevision,
      artifact_digest: artifactDigest,
      compiled_esm_digest: compiledEsmDigest,
      node_bootstrap_receipt_base64: receiptBase64,
    },
    admission_input: {
      aggregate_input: {
        repository,
        channel,
        final_tree: {
          manifestEntries:
            manifestEntries as ConsumerRuntimeRelease["admission_input"]["aggregate_input"]["final_tree"]["manifestEntries"],
          sourcePaths: sourcePathValues,
          cleanPackAllowlist: allowlistValues,
          channelMappings: mappingValues,
        },
        attestation: attestationValue,
      },
      control_manifest_base64: controlManifestBase64,
    },
  };
}

export function buildConsumerRuntimeRelease(input: {
  readonly tag: string;
  readonly productId: string;
  readonly materializerVersion?: string;
  readonly sourceRevision: string;
  readonly generation: NodeBootstrapReceipt;
  readonly artifactDigest: string;
  readonly compiledEsmBytes: Uint8Array;
  readonly receiptBytes: Uint8Array;
  readonly admissionInput: ConsumerRuntimeReleaseAdmissionInput;
}): ConsumerRuntimeRelease {
  let receipt: NodeBootstrapReceipt;
  try {
    receipt = parseNodeBootstrapReceiptBytes(input.receiptBytes);
  } catch {
    throw new ConsumerRuntimeReleaseValidationError("node_bootstrap_receipt_invalid");
  }
  if (
    receipt.generation_id !== input.generation.generation_id ||
    receipt.subject_revision !== input.sourceRevision ||
    `sha256:${receipt.compiled_cli.sha256}` !== digestConsumerRuntimeBytes(input.compiledEsmBytes)
  )
    throw new ConsumerRuntimeReleaseValidationError("generation_receipt_mismatch");
  return {
    schema_version: "ut-tdd.consumer-runtime.v1",
    release: {
      tag: input.tag,
      source_revision: input.sourceRevision,
      materializer_version: input.materializerVersion ?? "1",
      product_id: input.productId,
    },
    generation: {
      generation_id: input.generation.generation_id,
      subject_revision: input.sourceRevision,
      artifact_digest: input.artifactDigest,
      compiled_esm_digest: digestConsumerRuntimeBytes(input.compiledEsmBytes),
      node_bootstrap_receipt_base64: Buffer.from(input.receiptBytes).toString("base64"),
    },
    admission_input: {
      ...input.admissionInput,
    },
  };
}

export function serializeConsumerRuntimeReleaseDocument(document: ConsumerRuntimeRelease): Buffer {
  return Buffer.from(`${canonicalJson(document)}\n`, "utf8");
}
