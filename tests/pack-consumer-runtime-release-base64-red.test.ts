import { createHash } from "node:crypto";
import {
  deriveArtifactInventoryDigest,
  deriveReleaseId,
  deriveReleaseRecordDigest,
} from "../src/schema/release-manifest.ts";
import {
  type ConsumerRuntimeRelease,
  ConsumerRuntimeReleaseValidationError,
  validateConsumerRuntimeRelease,
} from "../src/setup/consumer-runtime-release.ts";
import {
  digestConsumerRuntimeBytes,
  digestMaterializedReleaseEntries,
} from "../src/setup/index.ts";
import { describe, expect, it } from "./support/hook-bounds.ts";

// Issue #1565 (Red): U-PACKRT-014/015 は現状の RangeError で落ちるため it.fails。Green PR で it に戻す。
// base64Value() の BASE64 regex は ~6,000,000 文字の入力で RangeError を投げる。
// 検証対象は control_manifest_base64 (非空 base64 の入口)。valid な大入力は JSON の末尾に空白を足して作る
// (YAML として同じ値に parse されるため、受理されれば通常の検証結果が返る)。

const revision = "a".repeat(40);
const digest = digestMaterializedReleaseEntries([
  { path: "src/entry.ts", mode: "100644", content: Buffer.from("a", "utf8") },
]);
const releaseId = deriveReleaseId("1", revision, digest);
const artifacts = [
  {
    sourcePath: "releases/canary/entry.ts",
    destinationPath: "src/entry.ts",
    mode: "100644" as const,
    size: 1,
    contentDigest: digestConsumerRuntimeBytes(Buffer.from("a", "utf8")),
  },
];
const inventoryDigest = deriveArtifactInventoryDigest(artifacts);
const assetDigest = `sha256:${"c".repeat(64)}`;
const manifest = {
  schema_version: "v2" as const,
  releases: {
    [releaseId]: {
      materializerVersion: "1",
      artifactSourceCommit: revision,
      artifactSetDigest: digest,
      artifactInventoryDigest: inventoryDigest,
      releaseAssetInventoryDigest: assetDigest,
      releaseRecordDigest: deriveReleaseRecordDigest({
        materializerVersion: "1",
        artifactSourceCommit: revision,
        artifactSetDigest: digest,
        artifactInventoryDigest: inventoryDigest,
        releaseAssetInventoryDigest: assetDigest,
      }),
      artifacts,
    },
  },
  channels: { canary: releaseId, stable: releaseId },
  channelOrder: ["canary", "stable"],
};

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
};
const receiptUnsigned = {
  schema_version: 2,
  generation_id: "node-fixture",
  subject_revision: revision,
  runtime: "node",
  node: { path: "C:/toolchain/node.exe", version: "v24.13.0", sha256: "c".repeat(64) },
  npm: { cli_path: "C:/toolchain/npm-cli.js", version: "11.6.2", sha256: "d".repeat(64) },
  toolchain_provenance_sha256: "e".repeat(64),
  package_lock_sha256: "f".repeat(64),
  tsconfig_node: { path: "tsconfig.node.json", sha256: "0".repeat(64) },
  builder: { path: "scripts/build-node.mjs", policy: "compiled-esm-only", sha256: "1".repeat(64) },
  compiled_cli: { path: "ut-tdd.mjs", sha256: "b".repeat(64), local_version: "0.0.0" },
  source_graph_sha256: "3".repeat(64),
  source_files: [],
  external_dependencies: [],
  external_dependency_closure_sha256: "4".repeat(64),
};
const receipt = Buffer.from(
  JSON.stringify({
    ...receiptUnsigned,
    receipt_digest: createHash("sha256").update(canonical(receiptUnsigned)).digest("hex"),
  }),
);

function documentWith(controlManifestBase64: string): ConsumerRuntimeRelease {
  return {
    schema_version: "ut-tdd.consumer-runtime.v1",
    release: {
      tag: "v0.2.0-canary.2",
      source_revision: revision,
      materializer_version: "1",
      product_id: "ut-tdd",
    },
    generation: {
      generation_id: "node-fixture",
      subject_revision: revision,
      artifact_digest: digest,
      compiled_esm_digest: `sha256:${"b".repeat(64)}`,
      node_bootstrap_receipt_base64: receipt.toString("base64"),
    },
    admission_input: {
      aggregate_input: {
        repository: "fixture/pack",
        channel: "canary",
        final_tree: {
          manifestEntries: [{ path: "release/manifest.yaml", value: manifest }],
          sourcePaths: ["releases/canary/entry.ts"],
          cleanPackAllowlist: ["release/manifest.yaml", "src/entry.ts"],
          channelMappings: [
            {
              channel: "canary",
              releaseId,
              sourceRevision: revision,
              sourcePath: "releases/canary/entry.ts",
              destinationPath: "src/entry.ts",
            },
          ],
        },
        attestation: {
          status: "attested",
          releaseId,
          artifactSourceCommit: revision,
          expectedDigest: digest,
          actualDigest: digest,
          entries: [{ path: "src/entry.ts", mode: "100644", content_base64: "YQ==" }],
        },
      },
      control_manifest_base64: controlManifestBase64,
    },
  } as ConsumerRuntimeRelease;
}

// base64 文字列長が約 chars になるよう、JSON の末尾へ空白を足した valid な control manifest を作る。
function paddedControlManifest(chars: number): string {
  const json = JSON.stringify(manifest);
  const bytes = Math.floor((chars / 4) * 3) - json.length;
  return Buffer.from(json + " ".repeat(bytes), "utf8").toString("base64");
}

function controlManifestError(controlManifestBase64: string): unknown {
  try {
    validateConsumerRuntimeRelease(documentWith(controlManifestBase64));
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("consumer runtime release base64 validation on large input (Issue #1565)", () => {
  it("U-PACKRT-014: accepts a ~6,000,000 char valid base64 value without RangeError", () => {
    const large = paddedControlManifest(6_000_000);
    expect(large.length).toBeGreaterThanOrEqual(5_999_000);
    expect(controlManifestError(large)).toBeUndefined();
  });

  it("U-PACKRT-015: still fails closed for a ~6,000,000 char invalid base64 value", () => {
    const invalid = `${paddedControlManifest(6_000_000).slice(0, -4)}@@@@`;
    const error = controlManifestError(invalid);
    expect(error).toBeInstanceOf(ConsumerRuntimeReleaseValidationError);
    expect((error as Error).message).toContain("control_manifest_base64_base64_invalid");
  });

  it("U-PACKRT-016: keeps the canonical round-trip and strict format rules", () => {
    const valid = paddedControlManifest(4_000);
    expect(controlManifestError(valid)).toBeUndefined();
    // 正当な control manifest (3001 byte、末尾 `==`) の最後の有効文字だけを、未使用の下位 4 bit だけが違う文字に変える。
    // decode した bytes は同じで、正規表現も通るが、round-trip (re-encode) が元の文字列に戻らない。
    const json = JSON.stringify(manifest);
    const padded = Buffer.from(json + " ".repeat(3001 - json.length), "utf8").toString("base64");
    expect(padded.endsWith("==")).toBe(true);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const nonCanonical = `${padded.slice(0, -3)}${alphabet[alphabet.indexOf(padded.at(-3) as string) ^ 1]}==`;
    expect(Buffer.from(nonCanonical, "base64").equals(Buffer.from(padded, "base64"))).toBe(true);
    expect(Buffer.from(nonCanonical, "base64").toString("base64")).not.toBe(nonCanonical);
    for (const bad of [nonCanonical, valid.slice(0, -1), `${valid}=`, valid.replace(/.$/, "-")]) {
      const error = controlManifestError(bad);
      expect(error, bad.slice(-6)).toBeInstanceOf(ConsumerRuntimeReleaseValidationError);
      expect((error as Error).message, bad.slice(-6)).toContain(
        "control_manifest_base64_base64_invalid",
      );
    }
  });

  it("U-PACKRT-017: still accepts the 3,000,000 char boundary", () => {
    expect(controlManifestError(paddedControlManifest(3_000_000))).toBeUndefined();
  });
});
