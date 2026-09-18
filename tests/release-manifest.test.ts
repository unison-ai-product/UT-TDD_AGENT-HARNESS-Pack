import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  deriveArtifactInventoryDigest,
  deriveReleaseRecordDigest,
  type PublicationArtifact,
  parsePublicationManifest,
  parseReleaseManifest,
  resolveReleaseChannel,
} from "../src/schema/release-manifest.ts";

const commit = "a".repeat(40);
const artifactDigest = `sha256:${"b".repeat(64)}`;

function releaseId(materializerVersion = "v1", sourceDigest = artifactDigest): string {
  const digest = Buffer.from(sourceDigest.slice("sha256:".length), "hex");
  const payload = Buffer.concat([
    Buffer.from(materializerVersion, "ascii"),
    Buffer.from([0]),
    Buffer.from(commit, "ascii"),
    Buffer.from([0]),
    digest,
  ]);
  return `rel-sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function manifest(): Record<string, unknown> {
  const id = releaseId();
  return {
    schema_version: "v1",
    releases: {
      [id]: {
        materializerVersion: "v1",
        artifactSourceCommit: commit,
        artifactSetDigest: artifactDigest,
      },
    },
    channels: { canary: id, stable: id },
    channelOrder: ["canary", "stable"],
  };
}

function releaseRecord(): Record<string, string> {
  return (manifest().releases as Record<string, Record<string, string>>)[releaseId()];
}

function mutatedHex(value: string): string {
  const last = value.at(-1);
  return `${value.slice(0, -1)}${last === "0" ? "1" : "0"}`;
}

describe("release manifest pure domain", () => {
  const v2Artifact = {
    sourcePath: "src/cli.ts",
    destinationPath: "bin/ut-tdd.js",
    mode: "100755" as const,
    size: 12,
    contentDigest: `sha256:${"c".repeat(64)}`,
  };

  function v2Manifest(): Record<string, unknown> {
    const artifacts = [v2Artifact];
    const artifactInventoryDigest = deriveArtifactInventoryDigest(artifacts);
    const artifactSetDigest = `sha256:${"d".repeat(64)}`;
    const releaseAssetInventoryDigest = `sha256:${"e".repeat(64)}`;
    const releaseRecordDigest = deriveReleaseRecordDigest({
      materializerVersion: "v2",
      artifactSourceCommit: commit,
      artifactSetDigest,
      artifactInventoryDigest,
      releaseAssetInventoryDigest,
    });
    const id = releaseId("v2", artifactSetDigest);
    return {
      schema_version: "v2",
      releases: {
        [id]: {
          materializerVersion: "v2",
          artifactSourceCommit: commit,
          artifactSetDigest,
          artifactInventoryDigest,
          releaseAssetInventoryDigest,
          releaseRecordDigest,
          artifacts,
        },
      },
      channels: { canary: id, stable: id },
      channelOrder: ["canary", "stable"],
    };
  }

  function refreshV2Digests(record: Record<string, unknown>): void {
    const artifacts = record.artifacts as PublicationArtifact[];
    record.artifactInventoryDigest = deriveArtifactInventoryDigest(artifacts);
    record.releaseRecordDigest = deriveReleaseRecordDigest({
      materializerVersion: record.materializerVersion as string,
      artifactSourceCommit: record.artifactSourceCommit as string,
      artifactSetDigest: record.artifactSetDigest as string,
      artifactInventoryDigest: record.artifactInventoryDigest as string,
      releaseAssetInventoryDigest: record.releaseAssetInventoryDigest as string,
    });
  }

  it("U-PACKPUB-001: v2 validates explicit inventory, identity, and digests", () => {
    const parsed = parseReleaseManifest(v2Manifest());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.schemaVersion).toBe("v2");
    expect(parsed.value.releases[Object.keys(parsed.value.releases)[0]]).toMatchObject({
      artifactInventoryDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      artifacts: [v2Artifact],
    });
  });

  it("U-PACKPUB-001: pins inventory and release framing to literal golden digests", () => {
    const artifacts: PublicationArtifact[] = [
      {
        sourcePath: "src/α.ts",
        destinationPath: "bin/a.js",
        mode: "100644",
        size: 1,
        contentDigest: `sha256:${"01".repeat(32)}`,
      },
      {
        sourcePath: "src/z.ts",
        destinationPath: "bin/beta.js",
        mode: "100755",
        size: 65_537,
        contentDigest: `sha256:${"ab".repeat(32)}`,
      },
    ];
    const inventoryDigest = deriveArtifactInventoryDigest(artifacts);
    expect(inventoryDigest).toBe(
      "sha256:258b6f2740525073ce8cefe2a75e25b83c5ba4c50bbc4621351b074d8bd1af0f",
    );
    expect(
      deriveReleaseRecordDigest({
        materializerVersion: "v2.7",
        artifactSourceCommit: "0123456789abcdef0123456789abcdef01234567",
        artifactSetDigest: `sha256:${"11".repeat(32)}`,
        artifactInventoryDigest: inventoryDigest,
        releaseAssetInventoryDigest: `sha256:${"22".repeat(32)}`,
      }),
    ).toBe("sha256:706fc10f561283fccdf20eaa5dee345ffe8186dd8d909313bc8657eb4b409e27");
  });

  it("U-PACKPUB-001: v1 stays readable but is denied for new publication", () => {
    expect(parseReleaseManifest(manifest()).ok).toBe(true);
    expect(parsePublicationManifest(manifest())).toEqual({
      ok: false,
      error: "v1_read_only",
    });
  });

  it("U-PACKPUB-001: v2 rejects independent digest and artifact mutations", () => {
    const source = v2Manifest();
    const id = Object.keys(source.releases as object)[0];
    const record = (source.releases as Record<string, Record<string, unknown>>)[id];
    const mutations = [
      { artifactInventoryDigest: `sha256:${"f".repeat(64)}` },
      { releaseAssetInventoryDigest: `sha256:${"f".repeat(64)}` },
      { releaseRecordDigest: `sha256:${"f".repeat(64)}` },
      { artifacts: [{ ...v2Artifact, contentDigest: `sha256:${"f".repeat(64)}` }] },
    ];
    for (const mutation of mutations) {
      const invalid = structuredClone(source);
      Object.assign((invalid.releases as Record<string, Record<string, unknown>>)[id], mutation);
      expect(parseReleaseManifest(invalid)).toEqual({ ok: false, error: "invalid_manifest" });
    }
    const reordered = structuredClone(source);
    (reordered.releases as Record<string, Record<string, unknown>>)[id].artifacts = [
      { ...v2Artifact, destinationPath: "z.js" },
      { ...v2Artifact, destinationPath: "a.js" },
    ];
    expect(parseReleaseManifest(reordered)).toEqual({ ok: false, error: "invalid_manifest" });
    expect(record.artifacts).toEqual([v2Artifact]);

    const coordinated = structuredClone(source);
    const coordinatedRecord = (coordinated.releases as Record<string, Record<string, unknown>>)[id];
    const coordinatedArtifacts = coordinatedRecord.artifacts as PublicationArtifact[];
    coordinatedArtifacts[0] = { ...coordinatedArtifacts[0], size: 13 };
    coordinatedRecord.artifactInventoryDigest = deriveArtifactInventoryDigest(coordinatedArtifacts);
    expect(parseReleaseManifest(coordinated)).toEqual({ ok: false, error: "invalid_manifest" });
  });

  it("U-PACKPUB-001: v2 strict-decodes every schema level", () => {
    const rootUnknown = { ...v2Manifest(), unexpected: true };
    const releaseUnknown = structuredClone(v2Manifest());
    const releaseId = Object.keys(releaseUnknown.releases as object)[0];
    (releaseUnknown.releases as Record<string, Record<string, unknown>>)[releaseId].unexpected =
      true;
    const artifactUnknown = structuredClone(v2Manifest());
    const artifactId = Object.keys(artifactUnknown.releases as object)[0];
    const artifact = (
      (artifactUnknown.releases as Record<string, Record<string, unknown>>)[artifactId]
        .artifacts as Array<Record<string, unknown>>
    )[0];
    artifact.unexpected = true;
    const missingArtifacts = structuredClone(v2Manifest());
    const missingId = Object.keys(missingArtifacts.releases as object)[0];
    delete (missingArtifacts.releases as Record<string, Record<string, unknown>>)[missingId]
      .artifacts;
    const unsafeSize = structuredClone(v2Manifest());
    const unsafeId = Object.keys(unsafeSize.releases as object)[0];
    (
      (unsafeSize.releases as Record<string, Record<string, unknown>>)[unsafeId].artifacts as Array<
        Record<string, unknown>
      >
    )[0].size = Number.MAX_SAFE_INTEGER + 1;

    for (const invalid of [
      rootUnknown,
      releaseUnknown,
      artifactUnknown,
      missingArtifacts,
      unsafeSize,
    ]) {
      expect(parseReleaseManifest(invalid)).toEqual({ ok: false, error: "invalid_manifest" });
    }
  });

  it("U-PACKPUB-001: v2 binds every release identity axis independently", () => {
    const source = v2Manifest();
    const id = Object.keys(source.releases as object)[0];
    const mutations: Array<(record: Record<string, unknown>) => void> = [
      (record) => {
        record.materializerVersion = "v3";
      },
      (record) => {
        record.artifactSourceCommit = "b".repeat(40);
      },
      (record) => {
        record.artifactSetDigest = `sha256:${"a".repeat(64)}`;
      },
      (record) => {
        record.releaseAssetInventoryDigest = `sha256:${"a".repeat(64)}`;
      },
    ];
    for (const mutate of mutations) {
      const invalid = structuredClone(source);
      mutate((invalid.releases as Record<string, Record<string, unknown>>)[id]);
      expect(parseReleaseManifest(invalid)).toEqual({ ok: false, error: "invalid_manifest" });
    }

    const wrongId = structuredClone(source);
    const record = (wrongId.releases as Record<string, Record<string, unknown>>)[id];
    delete (wrongId.releases as Record<string, Record<string, unknown>>)[id];
    (wrongId.releases as Record<string, Record<string, unknown>>)[`rel-sha256:${"f".repeat(64)}`] =
      record;
    wrongId.channels = {
      canary: `rel-sha256:${"f".repeat(64)}`,
      stable: `rel-sha256:${"f".repeat(64)}`,
    };
    expect(parseReleaseManifest(wrongId)).toEqual({ ok: false, error: "invalid_manifest" });
  });

  it("U-PACKPUB-001: v2 rejects duplicate, unsorted, and unsafe artifact axes", () => {
    const cases: Array<{
      mutate: (artifacts: Array<Record<string, unknown>>) => void;
      digestable?: boolean;
    }> = [
      {
        mutate: (artifacts) => {
          artifacts[0].sourcePath = "../source";
        },
      },
      {
        mutate: (artifacts) => {
          artifacts.push({ ...artifacts[0], destinationPath: "z.js" });
        },
      },
      {
        mutate: (artifacts) => {
          artifacts.push({ ...artifacts[0], sourcePath: "src/other.ts" });
        },
      },
      {
        mutate: (artifacts) => {
          artifacts.unshift({ ...artifacts[0], sourcePath: "src/a.ts", destinationPath: "z.js" });
        },
      },
      {
        mutate: (artifacts) => {
          artifacts[0].mode = "120000";
        },
      },
      {
        mutate: (artifacts) => {
          artifacts[0].size = 1.5;
        },
        digestable: false,
      },
      {
        mutate: (artifacts) => {
          artifacts[0].size = -1;
        },
        digestable: false,
      },
      {
        mutate: (artifacts) => {
          artifacts[0].size = Number.MAX_SAFE_INTEGER + 1;
        },
      },
    ];
    for (const { mutate, digestable = true } of cases) {
      const invalid = structuredClone(v2Manifest());
      const id = Object.keys(invalid.releases as object)[0];
      const record = (invalid.releases as Record<string, Record<string, unknown>>)[id];
      mutate(record.artifacts as Array<Record<string, unknown>>);
      if (digestable) refreshV2Digests(record);
      expect(parseReleaseManifest(invalid)).toEqual({ ok: false, error: "invalid_manifest" });
    }
  });

  it("U-PACKPUB-001: v2 rejects non-ASCII materializer identity before byte framing", () => {
    const invalid = structuredClone(v2Manifest());
    const currentId = Object.keys(invalid.releases as object)[0];
    const record = (invalid.releases as Record<string, Record<string, unknown>>)[currentId];
    record.materializerVersion = "vé";
    refreshV2Digests(record);

    const aliasedId = releaseId(
      record.materializerVersion as string,
      record.artifactSetDigest as string,
    );
    delete (invalid.releases as Record<string, unknown>)[currentId];
    (invalid.releases as Record<string, unknown>)[aliasedId] = record;
    invalid.channels = { canary: aliasedId, stable: aliasedId };

    expect(parseReleaseManifest(invalid)).toEqual({ ok: false, error: "invalid_manifest" });
  });

  it("U-PACKPUB-001: v2 returns a deeply immutable snapshot", () => {
    const input = v2Manifest();
    const parsed = parsePublicationManifest(input);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const id = Object.keys(parsed.value.releases)[0];
    const release = parsed.value.releases[id];
    expect(Object.isFrozen(parsed.value)).toBe(true);
    expect(Object.isFrozen(parsed.value.releases)).toBe(true);
    expect(Object.isFrozen(release)).toBe(true);
    expect(Object.isFrozen(release.artifacts)).toBe(true);
    expect(Object.isFrozen(release.artifacts[0])).toBe(true);

    const mutableInput = input.releases as Record<string, Record<string, unknown>>;
    (mutableInput[id].artifacts as Array<Record<string, unknown>>)[0].destinationPath = "changed";
    expect((parsed.value.releases[id].artifacts[0] as PublicationArtifact).destinationPath).toBe(
      "bin/ut-tdd.js",
    );
  });

  it("U-PACKPUB-001: v2 rejects unsafe paths, symlink mode, and inherited channels", () => {
    const unsafe = [
      "../escape",
      "a/../b",
      "/absolute",
      "C:/drive",
      "\\\\unc",
      "a\\b",
      "bin/\ud800.js",
      "bin/\udc00.js",
    ];
    for (const destinationPath of unsafe) {
      const invalid = structuredClone(v2Manifest());
      const id = Object.keys(invalid.releases as object)[0];
      const artifact = (
        (invalid.releases as Record<string, Record<string, unknown>>)[id].artifacts as Array<
          Record<string, unknown>
        >
      )[0];
      artifact.destinationPath = destinationPath;
      expect(parseReleaseManifest(invalid)).toEqual({ ok: false, error: "invalid_manifest" });
    }
    const invalidSource = structuredClone(v2Manifest());
    const sourceId = Object.keys(invalidSource.releases as object)[0];
    const sourceRecord = (invalidSource.releases as Record<string, Record<string, unknown>>)[
      sourceId
    ];
    const sourceArtifacts = sourceRecord.artifacts as PublicationArtifact[];
    sourceArtifacts[0] = { ...sourceArtifacts[0], sourcePath: "src/\ud800.ts" };
    refreshV2Digests(sourceRecord);
    expect(parseReleaseManifest(invalidSource)).toEqual({ ok: false, error: "invalid_manifest" });
    const symlink = structuredClone(v2Manifest());
    const id = Object.keys(symlink.releases as object)[0];
    const symlinkRecord = (symlink.releases as Record<string, Record<string, unknown>>)[id];
    (symlinkRecord.artifacts as Array<Record<string, unknown>>)[0].mode = "120000";
    refreshV2Digests(symlinkRecord);
    expect(parseReleaseManifest(symlink)).toEqual({ ok: false, error: "invalid_manifest" });

    const inherited = structuredClone(v2Manifest());
    const channels = Object.create({ preview: id }) as Record<string, string>;
    Object.assign(channels, inherited.channels);
    inherited.channels = channels;
    expect(parseReleaseManifest(inherited)).toEqual({ ok: false, error: "invalid_manifest" });
  });

  it("U-RELMAN-001: strict schema rejects missing fields, invalid types, formats, and unknown fields", () => {
    for (const raw of [
      null,
      [],
      "manifest",
      { ...manifest(), schema_version: "v2" },
      { ...manifest(), unexpected: true },
      { ...manifest(), releases: { [releaseId()]: { ...releaseRecord(), unexpected: true } } },
      { ...manifest(), releases: undefined },
      { ...manifest(), channelOrder: undefined },
      { ...manifest(), schema_version: { version: "v1" } },
      { ...manifest(), schema_version: [] },
      { ...manifest(), schema_version: 1 },
      { ...manifest(), schema_version: null },
      { ...manifest(), releases: { invalid: releaseRecord() } },
      { ...manifest(), releases: [] },
      { ...manifest(), releases: "releases" },
      { ...manifest(), releases: 1 },
      { ...manifest(), releases: null },
      { ...manifest(), channels: { "": releaseId() } },
      { ...manifest(), channels: [] },
      { ...manifest(), channels: "channels" },
      { ...manifest(), channels: 1 },
      { ...manifest(), channels: null },
      { ...manifest(), channelOrder: { order: [] } },
      { ...manifest(), channelOrder: [""] },
      { ...manifest(), channelOrder: "channelOrder" },
      { ...manifest(), channelOrder: 1 },
      { ...manifest(), channelOrder: null },
      { ...manifest(), schema_version: "V1" },
      {
        ...manifest(),
        releases: {
          [releaseId()]: { ...releaseRecord(), artifactSourceCommit: "A".repeat(40) },
        },
      },
      {
        ...manifest(),
        releases: {
          [releaseId()]: { ...releaseRecord(), artifactSourceCommit: "a".repeat(39) },
        },
      },
      {
        ...manifest(),
        releases: {
          [releaseId()]: { ...releaseRecord(), artifactSetDigest: "sha256:" },
        },
      },
      {
        ...manifest(),
        releases: {
          [`rel-sha256:${"A".repeat(64)}`]: releaseRecord(),
        },
      },
    ]) {
      expect(parseReleaseManifest(raw)).toEqual({ ok: false, error: "invalid_manifest" });
    }
  });

  it("U-RELMAN-002: unknown channel returns unknown_channel without a release", () => {
    const parsed = parseReleaseManifest(manifest());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(resolveReleaseChannel(parsed.value, "preview")).toEqual({
      ok: false,
      error: "unknown_channel",
    });
  });

  it("U-RELMAN-007: custom channels require a complete, unique own-key channelOrder", () => {
    const valid = manifest();
    const id = releaseId();
    (valid.channels as Record<string, string>).preview = id;
    valid.channelOrder = ["canary", "preview", "stable"];
    expect(parseReleaseManifest(valid).ok).toBe(true);

    const missingOrder = manifest();
    (missingOrder.channels as Record<string, string>).preview = id;
    delete missingOrder.channelOrder;
    expect(parseReleaseManifest(missingOrder)).toEqual({
      ok: false,
      error: "invalid_manifest",
    });

    for (const order of [
      ["canary", "stable"],
      ["canary", "preview", "preview", "stable"],
      ["canary", "preview", "stable", "other"],
    ]) {
      const invalid = manifest();
      (invalid.channels as Record<string, string>).preview = id;
      invalid.channelOrder = order;
      expect(parseReleaseManifest(invalid)).toEqual({ ok: false, error: "invalid_manifest" });
    }

    const duplicateAtMatchingLength = manifest();
    (duplicateAtMatchingLength.channels as Record<string, string>).preview = id;
    duplicateAtMatchingLength.channelOrder = ["canary", "preview", "preview"];
    expect(parseReleaseManifest(duplicateAtMatchingLength)).toEqual({
      ok: false,
      error: "invalid_manifest",
    });

    const unknownReleaseReference = manifest();
    (unknownReleaseReference.channels as Record<string, string>).preview = releaseId("v2");
    unknownReleaseReference.channelOrder = ["canary", "stable", "preview"];
    expect(parseReleaseManifest(unknownReleaseReference)).toEqual({
      ok: false,
      error: "invalid_manifest",
    });
  });

  it("U-RELMAN-009: each independent release identity mutation fails closed", () => {
    const id = releaseId();
    const mutatedId = mutatedHex(id);
    const mutations = [
      {
        releases: { [mutatedId]: (manifest().releases as Record<string, unknown>)[id] },
        channels: { canary: mutatedId, stable: mutatedId },
      },
      {
        releases: {
          [id]: {
            materializerVersion: "v1",
            artifactSourceCommit: `c${commit.slice(1)}`,
            artifactSetDigest: artifactDigest,
          },
        },
      },
      {
        releases: {
          [id]: {
            materializerVersion: "v1",
            artifactSourceCommit: commit,
            artifactSetDigest: `sha256:c${"b".repeat(63)}`,
          },
        },
      },
    ];
    for (const mutation of mutations) {
      expect(parseReleaseManifest({ ...manifest(), ...mutation })).toEqual({
        ok: false,
        error: "invalid_manifest",
      });
    }
  });

  it("U-RELMAN-013: resolver pins unknown_channel and only accepts frozen own channels", () => {
    const parsed = parseReleaseManifest(manifest());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    for (const channel of ["toString", "constructor", "__proto__"]) {
      expect(resolveReleaseChannel(parsed.value, channel)).toEqual({
        ok: false,
        error: "unknown_channel",
      });
    }
    expect(Object.isFrozen(parsed.value)).toBe(true);
    expect(Object.isFrozen(parsed.value.releases)).toBe(true);
    expect(Object.isFrozen(parsed.value.channels)).toBe(true);
    expect(Object.isFrozen(parsed.value.channelOrder)).toBe(true);

    const withOwnPrototypeNames = manifest();
    const ownChannels = Object.create(null) as Record<string, string>;
    Object.assign(ownChannels, withOwnPrototypeNames.channels);
    for (const channel of ["toString", "constructor", "__proto__"]) {
      Object.defineProperty(ownChannels, channel, {
        value: releaseId(),
        enumerable: true,
      });
    }
    withOwnPrototypeNames.channels = ownChannels;
    withOwnPrototypeNames.channelOrder = [
      "canary",
      "stable",
      "toString",
      "constructor",
      "__proto__",
    ];
    const ownParsed = parseReleaseManifest(withOwnPrototypeNames);
    expect(ownParsed.ok).toBe(true);
    if (!ownParsed.ok) return;
    for (const channel of ["toString", "constructor", "__proto__"]) {
      expect(resolveReleaseChannel(ownParsed.value, channel)).toMatchObject({ ok: true });
    }
  });
});
