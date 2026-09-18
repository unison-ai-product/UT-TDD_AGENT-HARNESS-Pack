import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type {
  PublicationArtifact,
  PublicationReleaseIdentity,
} from "../src/schema/release-manifest.ts";
import {
  buildPackPublicationAssets,
  derivePackPublicationAssets,
} from "../src/setup/pack-publication-assets.ts";

const releaseId = `rel-sha256:${"1".repeat(64)}`;

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function fixture(content = Buffer.from("hi\n"), destinationPath = "a.txt") {
  const artifact: PublicationArtifact = {
    sourcePath: "src/a.txt",
    destinationPath,
    mode: "100644",
    size: content.length,
    contentDigest: digest(content),
  };
  const release: PublicationReleaseIdentity = {
    releaseId,
    materializerVersion: "v2",
    artifactSourceCommit: "a".repeat(40),
    artifactSetDigest: `sha256:${"2".repeat(64)}`,
    artifactInventoryDigest: `sha256:${"3".repeat(64)}`,
    releaseAssetInventoryDigest: `sha256:${"4".repeat(64)}`,
    releaseRecordDigest: `sha256:${"5".repeat(64)}`,
    artifacts: [artifact],
  };
  return { release, entries: [{ ...artifact, content }] };
}

describe("Pack publication deterministic assets", () => {
  it("U-PACKASSET-001: pins a single-entry archive to literal golden identities", () => {
    const result = derivePackPublicationAssets(fixture());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tarball.name).toBe(`ut-tdd-pack-${"1".repeat(64)}.tar.gz`);
    expect(result.value.checksum.name).toBe(`${result.value.tarball.name}.sha256`);
    expect(result.value.tarball.bytes.length).toBe(2_071);
    expect(result.value.tarball.contentDigest).toBe(
      "sha256:bf503b8691a3cc5e2efb1324c8f5bff6a473f661722e25ee3d2fb1cdb8b15258",
    );
    expect(result.value.checksum.bytes.toString("utf8")).toBe(
      `bf503b8691a3cc5e2efb1324c8f5bff6a473f661722e25ee3d2fb1cdb8b15258  ${result.value.tarball.name}\n`,
    );
    expect(result.value.releaseAssetInventoryDigest).toBe(
      "sha256:1be93a823dea06f2f2a306bf1662c76d93b3dc29466bd84bdca3357475fe6333",
    );
    expect(buildPackPublicationAssets(fixture())).toEqual({
      ok: false,
      error: "asset_inventory_mismatch",
    });
    const attested = buildPackPublicationAssets({
      ...fixture(),
      release: {
        ...fixture().release,
        releaseAssetInventoryDigest: result.value.releaseAssetInventoryDigest,
      },
    });
    expect(attested.ok).toBe(true);
  });

  it("U-PACKASSET-002: keeps UTF-8 ustar paths and stored-block boundaries deterministic", () => {
    const content = Buffer.alloc(65_536, 0xa5);
    const input = fixture(content, `${"p".repeat(120)}/日本語.bin`);
    const first = derivePackPublicationAssets(input);
    const second = derivePackPublicationAssets(input);
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect([...first.value.tarball.bytes.subarray(10, 15)]).toEqual([0, 255, 255, 0, 0]);
    const secondHeader = 10 + 5 + 65_535;
    expect([...first.value.tarball.bytes.subarray(secondHeader, secondHeader + 5)]).toEqual([
      1, 1, 6, 254, 249,
    ]);
  });

  it("U-PACKASSET-003: rejects identity, mode, size, content, order, and duplicate mutations", () => {
    const base = fixture();
    const mutations = [
      [{ ...base.entries[0], destinationPath: "b.txt" }],
      [{ ...base.entries[0], mode: "100755" as const }],
      [{ ...base.entries[0], size: 4 }],
      [{ ...base.entries[0], content: Buffer.from("ho\n") }],
    ];
    for (const entries of mutations) {
      expect(derivePackPublicationAssets({ release: base.release, entries })).toEqual({
        ok: false,
        error: "artifact_mismatch",
      });
    }
    const first = fixture(Buffer.from("one\n"), "a.txt");
    const secondArtifact: PublicationArtifact = {
      sourcePath: "src/b.txt",
      destinationPath: "b.txt",
      mode: "100644",
      size: 4,
      contentDigest: digest(Buffer.from("two\n")),
    };
    const secondEntry = { ...secondArtifact, content: Buffer.from("two\n") };
    const ordered = {
      release: {
        ...first.release,
        artifacts: [first.release.artifacts[0], secondArtifact],
      },
      entries: [first.entries[0], secondEntry],
    };
    expect(derivePackPublicationAssets(ordered).ok).toBe(true);
    expect(
      derivePackPublicationAssets({
        release: { ...ordered.release, artifacts: [secondArtifact, first.release.artifacts[0]] },
        entries: [secondEntry, first.entries[0]],
      }),
    ).toEqual({ ok: false, error: "artifact_mismatch" });
    expect(
      derivePackPublicationAssets({
        release: {
          ...ordered.release,
          artifacts: [first.release.artifacts[0], first.release.artifacts[0]],
        },
        entries: [first.entries[0], first.entries[0]],
      }),
    ).toEqual({ ok: false, error: "artifact_mismatch" });
    const sourceDuplicateArtifact = {
      ...secondArtifact,
      sourcePath: first.release.artifacts[0].sourcePath,
    };
    expect(
      derivePackPublicationAssets({
        release: {
          ...ordered.release,
          artifacts: [first.release.artifacts[0], sourceDuplicateArtifact],
        },
        entries: [first.entries[0], { ...sourceDuplicateArtifact, content: Buffer.from("two\n") }],
      }),
    ).toEqual({ ok: false, error: "artifact_mismatch" });
  });

  it("U-PACKASSET-004: rejects unsafe paths even when the caller bypasses manifest parsing", () => {
    const base = fixture();
    const artifact = { ...base.release.artifacts[0], destinationPath: "../escape.txt" };
    expect(
      derivePackPublicationAssets({
        release: { ...base.release, artifacts: [artifact] },
        entries: [{ ...base.entries[0], destinationPath: "../escape.txt" }],
      }),
    ).toEqual({ ok: false, error: "unsupported_path" });
  });

  it("U-PACKASSET-004: rejects ustar-unrepresentable and unsupported publication entries", () => {
    const tooLong = fixture(Buffer.from("x"), "x".repeat(101));
    expect(derivePackPublicationAssets(tooLong)).toEqual({
      ok: false,
      error: "unsupported_path",
    });
    const symlink = fixture();
    const release = {
      ...symlink.release,
      artifacts: [{ ...symlink.release.artifacts[0], mode: "120000" }],
    } as unknown as PublicationReleaseIdentity;
    expect(derivePackPublicationAssets({ release, entries: symlink.entries })).toEqual({
      ok: false,
      error: "unsupported_entry",
    });
  });

  it("U-PACKASSET-005: emits exact fixed gzip and ustar header fields", () => {
    const result = derivePackPublicationAssets(fixture());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.value.tarball.bytes.subarray(0, 10)]).toEqual([
      0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255,
    ]);
    expect(result.value.tarBytes.subarray(0, 6).toString("utf8")).toBe("a.txt\0");
    expect(result.value.tarBytes.subarray(100, 108).toString("ascii")).toBe("0100644\0");
    expect(result.value.tarBytes.subarray(108, 116).toString("ascii")).toBe("0000000\0");
    expect(result.value.tarBytes.subarray(116, 124).toString("ascii")).toBe("0000000\0");
    expect(result.value.tarBytes.subarray(124, 136).toString("ascii")).toBe("00000000003\0");
    expect(result.value.tarBytes.subarray(136, 148).toString("ascii")).toBe("00000000000\0");
    expect(result.value.tarBytes[156]).toBe(0x30);
    expect([...result.value.tarBytes.subarray(257, 265)]).toEqual([
      0x75, 0x73, 0x74, 0x61, 0x72, 0, 0x30, 0x30,
    ]);
    expect(result.value.tarBytes.subarray(512, 515).toString("utf8")).toBe("hi\n");
    expect(gunzipSync(result.value.tarball.bytes)).toEqual(result.value.tarBytes);
    expect(result.value.tarBytes.subarray(-1_024).equals(Buffer.alloc(1_024))).toBe(true);
    for (const offset of [3, 10, result.value.tarball.bytes.length - 8]) {
      const mutated = Buffer.from(result.value.tarball.bytes);
      mutated[offset] ^= 1;
      expect(digest(mutated)).not.toBe(result.value.tarball.contentDigest);
    }
  });

  it("U-PACKASSET-006: rejects missing and manifest-external entries without fallback", () => {
    const base = fixture();
    expect(derivePackPublicationAssets({ release: base.release, entries: [] })).toEqual({
      ok: false,
      error: "artifact_mismatch",
    });
    expect(
      derivePackPublicationAssets({
        release: base.release,
        entries: [...base.entries, { ...base.entries[0], destinationPath: "extra.txt" }],
      }),
    ).toEqual({ ok: false, error: "artifact_mismatch" });
  });
});
