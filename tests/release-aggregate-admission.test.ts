import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  deriveArtifactInventoryDigest,
  deriveReleaseId,
  deriveReleaseRecordDigest,
} from "../src/schema/release-manifest.ts";
import { derivePackPublicationAssets } from "../src/setup/pack-publication-assets.ts";
import {
  admitReleaseAggregate,
  applySealedReleaseAggregate,
  type ReleaseAggregateAdmissionInput,
  type ReleaseAggregateFinalTree,
  type SealedReleaseAggregatePlan,
} from "../src/setup/release-aggregate-admission.ts";
import type { ReleaseChannelAttestation } from "../src/setup/release-channel-adapter.ts";
import { digestMaterializedReleaseEntries } from "../src/setup/release-materializer.ts";

const revision = "a".repeat(40);
const expectedDigest = `sha256:${"b".repeat(64)}`;
const destinationPath = "src/entry.ts";
const sourcePath = "releases/stable/entry.ts";

function releaseId(): string {
  const payload = Buffer.concat([
    Buffer.from("1", "ascii"),
    Buffer.from([0]),
    Buffer.from(revision, "ascii"),
    Buffer.from([0]),
    Buffer.from(expectedDigest.slice("sha256:".length), "hex"),
  ]);
  return `rel-sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function manifest(): Record<string, unknown> {
  const id = releaseId();
  return {
    schema_version: "v1",
    releases: {
      [id]: {
        materializerVersion: "1",
        artifactSourceCommit: revision,
        artifactSetDigest: expectedDigest,
      },
    },
    channels: { stable: id },
    channelOrder: ["stable"],
  };
}

function manifestWithBothChannels(): Record<string, unknown> {
  const id = releaseId();
  return {
    schema_version: "v1",
    releases: {
      [id]: {
        materializerVersion: "1",
        artifactSourceCommit: revision,
        artifactSetDigest: expectedDigest,
      },
    },
    channels: { canary: id, stable: id },
    channelOrder: ["canary", "stable"],
  };
}

function finalTree(overrides: Partial<ReleaseAggregateFinalTree> = {}): ReleaseAggregateFinalTree {
  return {
    manifestEntries: [{ path: "release/manifest.yaml", value: manifest() }],
    sourcePaths: [sourcePath],
    cleanPackAllowlist: ["release/manifest.yaml", destinationPath],
    channelMappings: [
      {
        channel: "stable",
        releaseId: releaseId(),
        sourceRevision: revision,
        sourcePath,
        destinationPath,
      },
    ],
    ...overrides,
  };
}

function input(overrides: Partial<ReleaseAggregateFinalTree> = {}): ReleaseAggregateAdmissionInput {
  return { repository: "fixture-repository", channel: "stable", finalTree: finalTree(overrides) };
}

function attested(
  overrides: Partial<
    Omit<Extract<ReleaseChannelAttestation, { status: "attested" }>, "status">
  > = {},
): Extract<ReleaseChannelAttestation, { status: "attested" }> {
  return {
    status: "attested",
    releaseId: releaseId(),
    artifactSourceCommit: revision,
    expectedDigest,
    actualDigest: expectedDigest,
    entries: Object.freeze([
      Object.freeze({ path: destinationPath, mode: "100644", content: new Uint8Array([1, 2, 3]) }),
    ]),
    ...overrides,
  };
}

function admittedPlan(): Promise<Extract<SealedReleaseAggregatePlan, { schemaVersion: "v1" }>> {
  return admitReleaseAggregate(input(), { attestChannel: vi.fn(async () => attested()) }).then(
    (result) => {
      if (!result.ok) throw new Error(result.error);
      if (result.plan.schemaVersion !== "v1") throw new Error("expected v1 fixture plan");
      return result.plan;
    },
  );
}

const v2Revision = "c".repeat(40);
const v2Entries = [
  { path: "src/a.ts", mode: "100644" as const, content: new TextEncoder().encode("artifact-a") },
  { path: "src/b.ts", mode: "100644" as const, content: new TextEncoder().encode("artifact-b") },
  { path: "src/c.ts", mode: "100644" as const, content: new TextEncoder().encode("artifact-c") },
];
const v2SourcePaths = ["releases/stable/a.ts", "releases/stable/b.ts", "releases/stable/c.ts"];
const v2Digest = digestMaterializedReleaseEntries(v2Entries);
const v2ReleaseId = deriveReleaseId("1", v2Revision, v2Digest);
const v2PublicationEntries = v2Entries.map((entry, index) => ({
  sourcePath: v2SourcePaths[index] as string,
  destinationPath: entry.path,
  mode: entry.mode,
  size: entry.content.length,
  contentDigest: `sha256:${createHash("sha256").update(entry.content).digest("hex")}`,
  content: entry.content,
}));
const v2PublicationBase = {
  materializerVersion: "1",
  artifactSourceCommit: v2Revision,
  artifactSetDigest: v2Digest,
  artifactInventoryDigest: deriveArtifactInventoryDigest(v2PublicationEntries),
  releaseAssetInventoryDigest: `sha256:${"0".repeat(64)}`,
  releaseRecordDigest: `sha256:${"0".repeat(64)}`,
  artifacts: v2PublicationEntries.map(
    ({ sourcePath, destinationPath, mode, size, contentDigest }) => ({
      sourcePath,
      destinationPath,
      mode,
      size,
      contentDigest,
    }),
  ),
};
const v2PublicationAssets = derivePackPublicationAssets({
  release: { releaseId: v2ReleaseId, ...v2PublicationBase },
  entries: v2PublicationEntries,
});
if (!v2PublicationAssets.ok) throw new Error(v2PublicationAssets.error);
const v2ReleaseRecord = {
  ...v2PublicationBase,
  releaseAssetInventoryDigest: v2PublicationAssets.value.releaseAssetInventoryDigest,
};
const v2Manifest = {
  schema_version: "v2",
  releases: {
    [v2ReleaseId]: {
      ...v2ReleaseRecord,
      releaseRecordDigest: deriveReleaseRecordDigest(v2ReleaseRecord),
    },
  },
  channels: { canary: v2ReleaseId, stable: v2ReleaseId },
  channelOrder: ["canary", "stable"],
};
const v2Mappings = v2Entries.map((entry, index) => ({
  channel: "stable",
  releaseId: v2ReleaseId,
  sourceRevision: v2Revision,
  sourcePath: v2SourcePaths[index] as string,
  destinationPath: entry.path,
}));

function v2FinalTree(
  overrides: Partial<ReleaseAggregateFinalTree> = {},
): ReleaseAggregateFinalTree {
  return {
    manifestEntries: [{ path: "release/manifest.yaml", value: v2Manifest }],
    sourcePaths: v2SourcePaths,
    cleanPackAllowlist: ["release/manifest.yaml", ...v2Entries.map((entry) => entry.path)],
    channelMappings: v2Mappings,
    ...overrides,
  };
}

function v2Input(
  overrides: Partial<ReleaseAggregateFinalTree> = {},
  channel: "stable" | "canary" = "stable",
): ReleaseAggregateAdmissionInput {
  return { repository: "fixture-repository", channel, finalTree: v2FinalTree(overrides) };
}

function v2Attested(
  overrides: Partial<
    Omit<Extract<ReleaseChannelAttestation, { status: "attested" }>, "status">
  > = {},
): Extract<ReleaseChannelAttestation, { status: "attested" }> {
  return {
    status: "attested",
    releaseId: v2ReleaseId,
    artifactSourceCommit: v2Revision,
    expectedDigest: v2Digest,
    actualDigest: v2Digest,
    entries: v2Entries,
    ...overrides,
  };
}

describe("PF-5 release aggregate admission", () => {
  it.each([
    "stable",
    "canary",
  ] as const)("CANDIDATE-U-RELAGGV2-001: ordered v2 N=3 inventory seals without scalar destination on %s", async (channel) => {
    const channelMappings = v2Mappings.map((mapping) => ({ ...mapping, channel }));
    const attestChannel = vi.fn(async () => v2Attested());
    const result = await admitReleaseAggregate(v2Input({ channelMappings }, channel), {
      attestChannel,
    });
    expect(attestChannel).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Reflect.get(result.plan, "schemaVersion")).toBe("v2");
    expect(Object.hasOwn(result.plan, "destinationPath")).toBe(false);
    expect(result.plan.entries.map((entry) => entry.path)).toEqual(
      v2Entries.map((entry) => entry.path),
    );
  });

  it.each([
    ["zero mappings", { channelMappings: [] }],
    ["N-1 mappings", { channelMappings: v2Mappings.slice(0, 2) }],
    [
      "N+1 mappings",
      {
        sourcePaths: [...v2SourcePaths, "releases/stable/d.ts"],
        cleanPackAllowlist: [
          "release/manifest.yaml",
          ...v2Entries.map((entry) => entry.path),
          "src/d.ts",
        ],
        channelMappings: [
          ...v2Mappings,
          {
            channel: "stable",
            releaseId: v2ReleaseId,
            sourceRevision: v2Revision,
            sourcePath: "releases/stable/d.ts",
            destinationPath: "src/d.ts",
          },
        ],
      },
    ],
    [
      "duplicate mapping replacing a distinct entry",
      { channelMappings: [v2Mappings[0], v2Mappings[1], v2Mappings[1]] },
    ],
    ["mapping order swap", { channelMappings: [v2Mappings[1], v2Mappings[0], v2Mappings[2]] }],
    [
      "destination outside allowlist",
      {
        channelMappings: [
          v2Mappings[0],
          v2Mappings[1],
          { ...v2Mappings[2], destinationPath: "src/not-allowed.ts" },
        ],
      },
    ],
    [
      "one mapping belongs to another declared channel",
      {
        channelMappings: [v2Mappings[0], { ...v2Mappings[1], channel: "__other__" }, v2Mappings[2]],
      },
    ],
    [
      "release ID mismatch",
      {
        channelMappings: [
          v2Mappings[0],
          { ...v2Mappings[1], releaseId: deriveReleaseId("1", "d".repeat(40), v2Digest) },
          v2Mappings[2],
        ],
      },
    ],
    [
      "source revision mismatch",
      {
        channelMappings: [
          v2Mappings[0],
          { ...v2Mappings[1], sourceRevision: "d".repeat(40) },
          v2Mappings[2],
        ],
      },
    ],
    [
      "source path outside source inventory",
      {
        channelMappings: [
          v2Mappings[0],
          { ...v2Mappings[1], sourcePath: "releases/stable/unlisted.ts" },
          v2Mappings[2],
        ],
      },
    ],
  ] as const)("CANDIDATE-U-RELAGGV2-003: %s is rejected before attestation", async (_name, mutation) => {
    for (const channel of ["stable", "canary"] as const) {
      const otherChannel = channel === "stable" ? "canary" : "stable";
      const overrides: Partial<ReleaseAggregateFinalTree> = {
        ...mutation,
        channelMappings: mutation.channelMappings.map((mapping) => ({
          ...mapping,
          channel: mapping.channel === "__other__" ? otherChannel : channel,
        })),
      };
      const attestChannel = vi.fn(async () => v2Attested());
      const result = await admitReleaseAggregate(v2Input(overrides, channel), { attestChannel });
      expect(result).toEqual({ ok: false, phase: "preflight", error: "missing_channel_mapping" });
      expect(attestChannel).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["missing attested entry", v2Entries.slice(0, 2)],
    ["attested path order swap", [v2Entries[1], v2Entries[0], v2Entries[2]]],
    [
      "attested destination path mismatch",
      [v2Entries[0], { ...v2Entries[1], path: "src/wrong.ts" }, v2Entries[2]],
    ],
  ] as const)("CANDIDATE-U-RELAGGV2-004: %s is rejected after attestation", async (_name, entries) => {
    for (const channel of ["stable", "canary"] as const) {
      const channelMappings = v2Mappings.map((mapping) => ({ ...mapping, channel }));
      const attestChannel = vi.fn(async () => v2Attested({ entries }));
      const result = await admitReleaseAggregate(v2Input({ channelMappings }, channel), {
        attestChannel,
      });
      expect(result).toEqual({ ok: false, phase: "resolve", error: "invalid_artifact" });
      expect(attestChannel).toHaveBeenCalledOnce();
    }
  });

  it.each([
    "stable",
    "canary",
  ] as const)("CANDIDATE-U-RELAGGV2-005: v1 keeps exactly-one mapping and scalar destination on %s", async (channel) => {
    const baseTree = finalTree();
    const oneMappingTree = {
      ...baseTree,
      manifestEntries: [{ path: "release/manifest.yaml", value: manifestWithBothChannels() }],
      channelMappings: baseTree.channelMappings.map((mapping) => ({ ...mapping, channel })),
    };
    const normal = await admitReleaseAggregate(
      { repository: "fixture-repository", channel, finalTree: oneMappingTree },
      { attestChannel: vi.fn(async () => attested()) },
    );
    expect(normal.ok).toBe(true);
    if (normal.ok) {
      expect(Reflect.get(normal.plan, "schemaVersion")).toBe("v1");
      if (normal.plan.schemaVersion !== "v1") throw new Error("expected v1 fixture plan");
      expect(normal.plan.destinationPath).toBe(destinationPath);
    }

    const secondDestination = "src/second.ts";
    const attestChannel = vi.fn(async () => attested());
    const multiple = await admitReleaseAggregate(
      {
        repository: "fixture-repository",
        channel,
        finalTree: {
          ...oneMappingTree,
          sourcePaths: [sourcePath, "releases/stable/second.ts"],
          cleanPackAllowlist: ["release/manifest.yaml", destinationPath, secondDestination],
          channelMappings: [
            ...oneMappingTree.channelMappings,
            {
              channel,
              releaseId: releaseId(),
              sourceRevision: revision,
              sourcePath: "releases/stable/second.ts",
              destinationPath: secondDestination,
            },
          ],
        },
      },
      { attestChannel },
    );
    expect(multiple).toEqual({ ok: false, phase: "preflight", error: "missing_channel_mapping" });
    expect(attestChannel).not.toHaveBeenCalled();
  });

  it("U-RELMAN-014: final-tree predicate A/B/C failures stop before resolver and writes", async () => {
    const cases: Array<[string, Partial<ReleaseAggregateFinalTree>, string]> = [
      ["manifest uniqueness", { manifestEntries: [] }, "invalid_manifest"],
      [
        "clean allowlist control manifest",
        { cleanPackAllowlist: [destinationPath] },
        "invalid_allowlist",
      ],
      [
        "selected revision copy mapping cardinality",
        { channelMappings: [] },
        "missing_channel_mapping",
      ],
      [
        "selected revision release identity",
        {
          channelMappings: [
            {
              channel: "stable",
              releaseId: `rel-sha256:${"c".repeat(64)}`,
              sourceRevision: revision,
              sourcePath,
              destinationPath,
            },
          ],
        },
        "missing_channel_mapping",
      ],
      [
        "selected revision source commit",
        {
          channelMappings: [
            {
              channel: "stable",
              releaseId: releaseId(),
              sourceRevision: "c".repeat(40),
              sourcePath,
              destinationPath,
            },
          ],
        },
        "missing_channel_mapping",
      ],
      [
        "selected revision format",
        {
          channelMappings: [
            {
              channel: "stable",
              releaseId: releaseId(),
              sourceRevision: "not-a-revision",
              sourcePath,
              destinationPath,
            },
          ],
        },
        "missing_channel_mapping",
      ],
      [
        "selected revision source path",
        {
          channelMappings: [
            {
              channel: "stable",
              releaseId: releaseId(),
              sourceRevision: revision,
              sourcePath: "releases/stable/missing.ts",
              destinationPath,
            },
          ],
        },
        "missing_channel_mapping",
      ],
      [
        "selected revision source path format",
        {
          channelMappings: [
            {
              channel: "stable",
              releaseId: releaseId(),
              sourceRevision: revision,
              sourcePath: "../outside.ts",
              destinationPath,
            },
          ],
        },
        "missing_channel_mapping",
      ],
      [
        "selected revision destination allowlist",
        {
          channelMappings: [
            {
              channel: "stable",
              releaseId: releaseId(),
              sourceRevision: revision,
              sourcePath,
              destinationPath: "src/not-allowed.ts",
            },
          ],
        },
        "missing_channel_mapping",
      ],
      [
        "selected revision destination path format",
        {
          channelMappings: [
            {
              channel: "stable",
              releaseId: releaseId(),
              sourceRevision: revision,
              sourcePath,
              destinationPath: "../outside.ts",
            },
          ],
        },
        "missing_channel_mapping",
      ],
    ];

    for (const [, mutation, error] of cases) {
      const attestChannel = vi.fn(async () => attested());
      const result = await admitReleaseAggregate(input(mutation), { attestChannel });
      expect(result).toEqual({ ok: false, phase: "preflight", error });
      expect(attestChannel).not.toHaveBeenCalled();
    }

    const duplicateManifest = vi.fn(async () => attested());
    const duplicate = await admitReleaseAggregate(
      input({
        manifestEntries: [
          { path: "release/manifest.yaml", value: manifest() },
          { path: "release/manifest.yaml", value: manifest() },
        ],
      }),
      { attestChannel: duplicateManifest },
    );
    expect(duplicate).toEqual({ ok: false, phase: "preflight", error: "invalid_manifest" });
    expect(duplicateManifest).not.toHaveBeenCalled();
  });

  it("U-RELMAN-015: schema-invalid manifest is typed and has no resolver call", async () => {
    const attestChannel = vi.fn(async () => attested());
    const result = await admitReleaseAggregate(
      input({
        manifestEntries: [{ path: "release/manifest.yaml", value: { schema_version: "v2" } }],
      }),
      { attestChannel },
    );
    expect(result).toEqual({ ok: false, phase: "preflight", error: "invalid_manifest" });
    expect(attestChannel).not.toHaveBeenCalled();
  });

  it("U-RELMAN-016: unknown channel is preserved and has no resolver call", async () => {
    const attestChannel = vi.fn(async () => attested());
    const result = await admitReleaseAggregate(
      { ...input(), channel: "preview" },
      { attestChannel },
    );
    expect(result).toEqual({ ok: false, phase: "preflight", error: "unknown_channel" });
    expect(attestChannel).not.toHaveBeenCalled();
  });

  it("keeps resolver mismatch/unavailable typed and seals only an attested snapshot", async () => {
    const mismatch = await admitReleaseAggregate(input(), {
      attestChannel: vi.fn(async () => ({
        status: "mismatch" as const,
        releaseId: releaseId(),
        artifactSourceCommit: revision,
        expectedDigest,
        actualDigest: `sha256:${"c".repeat(64)}`,
      })),
    });
    expect(mismatch).toEqual({ ok: false, phase: "resolve", error: "mismatch" });

    const unavailable = await admitReleaseAggregate(input(), {
      attestChannel: vi.fn(async () => ({
        status: "unavailable" as const,
        releaseId: releaseId(),
        reason: "unavailable" as const,
      })),
    });
    expect(unavailable).toEqual({ ok: false, phase: "resolve", error: "unavailable" });

    const plan = await admittedPlan();
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.entries)).toBe(true);
    const entry = plan.entries[0];
    const bytes = [...entry.content];
    entry.content[0] = 99;
    expect([...entry.content]).toEqual(bytes);
    expect(plan.expectedDigest).toBe(expectedDigest);
    expect(plan.actualDigest).toBe(expectedDigest);
    expect(plan.releaseId).toBe(releaseId());
    expect(plan.sourceRevision).toBe(revision);
    expect(plan.destinationPath).toBe(destinationPath);

    const invalidIdentity = await admitReleaseAggregate(input(), {
      attestChannel: vi.fn(async () => attested({ artifactSourceCommit: "c".repeat(40) })),
    });
    expect(invalidIdentity).toEqual({ ok: false, phase: "resolve", error: "invalid_artifact" });

    const alternateDestination = "src/alternate.ts";
    const alternate = await admitReleaseAggregate(
      input({
        cleanPackAllowlist: ["release/manifest.yaml", alternateDestination],
        channelMappings: [
          {
            channel: "stable",
            releaseId: releaseId(),
            sourceRevision: revision,
            sourcePath,
            destinationPath: alternateDestination,
          },
        ],
      }),
      { attestChannel: vi.fn(async () => attested()) },
    );
    if (!alternate.ok) throw new Error(alternate.error);
    if (alternate.plan.schemaVersion !== "v1") throw new Error("expected v1 fixture plan");
    expect(alternate.plan.destinationPath).toBe(alternateDestination);
  });

  it("U-RELMAN-017: every staging/apply fault restores prior state and publishes zero", async () => {
    const faults = ["stage-before", "stage-after", "apply-before", "apply-after"] as const;
    for (const fault of faults) {
      const destination = new Map([[destinationPath, "prior"]]);
      const prior = new Map(destination);
      let stageWrites = 0;
      let applyCalls = 0;
      let discardCalls = 0;
      let restoreCalls = 0;
      const result = await applySealedReleaseAggregate(await admittedPlan(), {
        snapshotDestination: () =>
          Object.freeze([
            Object.freeze({
              path: destinationPath,
              mode: "100644",
              content: new Uint8Array(Buffer.from(destination.get(destinationPath) ?? "")),
            }),
          ]),
        writeStaging: () => {
          stageWrites += 1;
          if (fault === "stage-before" || fault === "stage-after") throw new Error(fault);
          return { staged: true };
        },
        applyDestination: () => {
          applyCalls += 1;
          if (fault === "apply-before") throw new Error(fault);
          destination.set(destinationPath, "published");
          if (fault === "apply-after") throw new Error(fault);
        },
        discardStaging: () => {
          discardCalls += 1;
        },
        restoreDestination: () => {
          restoreCalls += 1;
          destination.clear();
          for (const [path, content] of prior) destination.set(path, content);
        },
      });
      expect(result).toEqual({ ok: false, error: "unavailable", applied: 0 });
      expect(stageWrites).toBe(1);
      expect(applyCalls).toBe(fault.startsWith("apply") ? 1 : 0);
      expect(discardCalls).toBe(fault.startsWith("apply") ? 1 : 0);
      expect(restoreCalls).toBe(1);
      expect(destination).toEqual(prior);
    }

    const publishedDestination = new Map([[destinationPath, "prior"]]);
    const rollbackFailed = await applySealedReleaseAggregate(await admittedPlan(), {
      snapshotDestination: () => [],
      writeStaging: () => ({ staged: true }),
      applyDestination: () => {
        publishedDestination.set(destinationPath, "published");
        throw new Error("apply-after");
      },
      discardStaging: () => undefined,
      restoreDestination: () => {
        throw new Error("restore-failed");
      },
    });
    expect(rollbackFailed).toEqual({
      ok: false,
      error: "rollback_failed",
      applied: "indeterminate",
    });
    expect(publishedDestination.get(destinationPath)).toBe("published");

    const discardFailureDestination = new Map([[destinationPath, "prior"]]);
    const discardRollbackFailed = await applySealedReleaseAggregate(await admittedPlan(), {
      snapshotDestination: () => [],
      writeStaging: () => ({ staged: true }),
      applyDestination: () => {
        discardFailureDestination.set(destinationPath, "published");
      },
      discardStaging: () => {
        throw new Error("discard-failed");
      },
      restoreDestination: () => {
        throw new Error("restore-failed");
      },
    });
    expect(discardRollbackFailed).toEqual({
      ok: false,
      error: "rollback_failed",
      applied: "indeterminate",
    });
    expect(discardFailureDestination.get(destinationPath)).toBe("published");

    const destination = new Map([[destinationPath, "prior"]]);
    let applyCalls = 0;
    let discardCalls = 0;
    const result = await applySealedReleaseAggregate(await admittedPlan(), {
      snapshotDestination: () => [],
      writeStaging: () => ({ staged: true }),
      applyDestination: () => {
        applyCalls += 1;
        destination.set(destinationPath, "published");
      },
      discardStaging: () => {
        discardCalls += 1;
      },
      restoreDestination: () => undefined,
    });
    expect(result).toEqual({ ok: true, applied: 1 });
    expect(applyCalls).toBe(1);
    expect(discardCalls).toBe(1);
    expect(destination.get(destinationPath)).toBe("published");
  });
});
