import { createHash } from "node:crypto";
import { stringify } from "yaml";
import {
  deriveArtifactInventoryDigest,
  deriveReleaseId,
  deriveReleaseRecordDigest,
  type PublicationArtifact,
  type PublicationReleaseIdentity,
} from "../../src/schema/release-manifest.ts";

export const C1 = "1111111111111111111111111111111111111111";
export const CONTENT = Buffer.from("C2 domain fixture\n", "utf8");

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function previousManifest() {
  const releases: Record<string, Omit<PublicationReleaseIdentity, "releaseId">> = {};
  for (const [commit, content] of [
    ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Buffer.from("old canary\n")],
    ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", Buffer.from("old stable\n")],
    ["cccccccccccccccccccccccccccccccccccccccc", Buffer.from("old retained release\n")],
  ] as const) {
    const artifacts: PublicationArtifact[] = [
      {
        sourcePath: "README.md",
        destinationPath: "README.md",
        mode: "100644" as const,
        size: content.length,
        contentDigest: sha256(content),
      },
    ];
    const artifactSetDigest = sha256(Buffer.from(`previous:${commit}`));
    const releaseId = deriveReleaseId("1", commit, artifactSetDigest);
    const record = {
      materializerVersion: "1",
      artifactSourceCommit: commit,
      artifactSetDigest,
      artifactInventoryDigest: deriveArtifactInventoryDigest(artifacts),
      releaseAssetInventoryDigest: sha256(Buffer.from(`assets:${commit}`)),
      artifacts,
    };
    const releaseRecordDigest = deriveReleaseRecordDigest(record);
    releases[releaseId] = commit.startsWith("c")
      ? { releaseRecordDigest, ...record }
      : { ...record, releaseRecordDigest };
  }
  const [canary, stable] = Object.keys(releases);
  return {
    schema_version: "v2" as const,
    releases,
    channels: { canary, stable },
    channelOrder: ["canary", "stable"],
  };
}

export function createDomainFixture() {
  const previous = previousManifest();
  const entry = { path: "README.md", mode: "100644", content: CONTENT } as const;
  const resolution = {
    ok: true as const,
    digest: sha256(Buffer.from("resolved C1 inventory")),
    entries: [entry],
  };
  return {
    input: {
      repository: "pack-c2-domain-fixture",
      c1: C1,
      tag: "v0.0.0-canary.1",
      previousBytes: Buffer.from(stringify(previous), "utf8"),
    },
    trackedEntries: [{ path: entry.path, mode: entry.mode }],
    resolution,
    assetDigest: sha256(Buffer.from("derived asset inventory")),
  };
}
