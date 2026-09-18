import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import {
  deriveArtifactInventoryDigest,
  deriveReleaseRecordDigest,
} from "../src/schema/release-manifest.ts";
import {
  derivePackPublicationAssets,
  type SealedPublicationEntry,
} from "../src/setup/pack-publication-assets.ts";
import {
  applySealedPackPublication,
  auditPackPublication,
  buildPackPublicationStagingPlan,
  deriveControlManifestSnapshotDigest,
  type PackPublicationManifest,
  type PackPublicationObservation,
} from "../src/setup/pack-publication-staging.ts";

const sourceCommit = "a".repeat(40);
const artifactSetDigest = `sha256:${"b".repeat(64)}`;

function releaseId(): string {
  const payload = Buffer.concat([
    Buffer.from("v2", "ascii"),
    Buffer.from([0]),
    Buffer.from(sourceCommit, "ascii"),
    Buffer.from([0]),
    Buffer.from(artifactSetDigest.slice(7), "hex"),
  ]);
  return `rel-sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function rawManifest(): Record<string, unknown> {
  const content = Buffer.from("abc");
  const artifact = {
    sourcePath: "src/cli.ts",
    destinationPath: "bin/ut-tdd.js",
    mode: "100755" as const,
    size: content.length,
    contentDigest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
  };
  const artifacts = [artifact];
  const artifactInventoryDigest = deriveArtifactInventoryDigest(artifacts);
  const id = releaseId();
  const provisional = {
    releaseId: id,
    materializerVersion: "v2",
    artifactSourceCommit: sourceCommit,
    artifactSetDigest,
    artifactInventoryDigest,
    releaseAssetInventoryDigest: `sha256:${"c".repeat(64)}`,
    releaseRecordDigest: `sha256:${"d".repeat(64)}`,
    artifacts,
  };
  const assets = derivePackPublicationAssets({ release: provisional, entries: [sealedEntry()] });
  if (!assets.ok) throw new Error(assets.error);
  const releaseAssetInventoryDigest = assets.value.releaseAssetInventoryDigest;
  const releaseRecordDigest = deriveReleaseRecordDigest({
    materializerVersion: "v2",
    artifactSourceCommit: sourceCommit,
    artifactSetDigest,
    artifactInventoryDigest,
    releaseAssetInventoryDigest,
  });
  return {
    schema_version: "v2",
    releases: {
      [id]: {
        materializerVersion: "v2",
        artifactSourceCommit: sourceCommit,
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

function parsed(): PackPublicationManifest {
  const result = buildPackPublicationStagingPlan({
    manifestInput: rawManifest(),
    releaseId: releaseId(),
    controlManifestBytes: Buffer.from(stringify(rawManifest()), "utf8"),
    entries: [sealedEntry()],
  });
  if (result.ok) return result.plan.manifest;
  throw new Error(result.error);
}

function sealedEntry(): SealedPublicationEntry {
  const content = Buffer.from("abc");
  return {
    sourcePath: "src/cli.ts",
    destinationPath: "bin/ut-tdd.js",
    mode: "100755",
    size: content.length,
    contentDigest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    content,
  };
}

function input(overrides: Partial<Parameters<typeof buildPackPublicationStagingPlan>[0]> = {}) {
  return {
    manifestInput: rawManifest(),
    releaseId: releaseId(),
    controlManifestBytes: Buffer.from(stringify(rawManifest()), "utf8"),
    entries: [sealedEntry()],
    ...overrides,
  };
}

describe("local Pack publication staging/auditor", () => {
  it("U-PACKPUB-STAGE-001: seals semantic manifest, sidecar, exact commit entries and two assets", () => {
    const result = buildPackPublicationStagingPlan(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { plan } = result;
    expect(plan.kind).toBe("pack-publication-staging");
    expect(plan.commitEntries.map((entry) => entry.path)).toEqual([
      "bin/ut-tdd.js",
      "release/manifest.yaml",
    ]);
    expect(plan.releaseAssets.map((asset) => asset.name)).toHaveLength(2);
    expect(plan.releaseAssets.map((asset) => asset.name)).toEqual([
      expect.stringMatching(/^ut-tdd-pack-[a-f0-9]{64}\.tar\.gz$/),
      expect.stringMatching(/^ut-tdd-pack-[a-f0-9]{64}\.tar\.gz\.sha256$/),
    ]);
    expect(plan.controlManifestSnapshotDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.commitEntries)).toBe(true);
    expect(Object.isFrozen(plan.releaseAssets)).toBe(true);
  });

  it("U-PACKPUB-STAGE-002: uses semantic snapshot digest, not YAML formatting or map insertion order", () => {
    const first = buildPackPublicationStagingPlan(input());
    const formatted = buildPackPublicationStagingPlan({
      ...input(),
      controlManifestBytes: Buffer.from(
        `# comment\n${stringify(rawManifest(), { indent: 4 })}`,
        "utf8",
      ),
    });
    expect(first.ok && formatted.ok).toBe(true);
    if (!first.ok || !formatted.ok) return;
    expect(formatted.plan.controlManifestSnapshotDigest).toBe(
      first.plan.controlManifestSnapshotDigest,
    );
    expect(deriveControlManifestSnapshotDigest(parsed())).toBe(
      first.plan.controlManifestSnapshotDigest,
    );
  });

  it("U-PACKPUB-STAGE-002: separates release and channel digest sections", () => {
    const releaseOnly = {
      schema_version: "v2",
      releases: {
        X: { releaseRecordDigest: "D" },
      },
      channels: {},
      channelOrder: [],
    } as unknown as PackPublicationManifest;
    const channelOnly = {
      schema_version: "v2",
      releases: {},
      channels: { X: "D" },
      channelOrder: ["X"],
    } as unknown as PackPublicationManifest;

    expect(deriveControlManifestSnapshotDigest(releaseOnly)).not.toBe(
      deriveControlManifestSnapshotDigest(channelOnly),
    );
  });

  it.each([
    ["missing", []],
    ["extra", [sealedEntry(), { ...sealedEntry(), destinationPath: "bin/extra.js" }]],
    ["digest drift", [{ ...sealedEntry(), contentDigest: `sha256:${"d".repeat(64)}` }]],
    ["directory walk substitute", [{ ...sealedEntry(), sourcePath: "./src/cli.ts" }]],
  ])("U-PACKPUB-STAGE-003: fail-closes explicit inventory mutation: %s", (_label, entries) => {
    const result = buildPackPublicationStagingPlan(input({ entries }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.phase).toBe("preflight");
  });

  it("U-PACKPUB-STAGE-004: rejects a sidecar whose parsed semantic manifest differs", () => {
    const changed = rawManifest();
    const releases = changed.releases as Record<string, Record<string, unknown>>;
    releases[releaseId()].materializerVersion = "changed";
    const result = buildPackPublicationStagingPlan(
      input({ controlManifestBytes: Buffer.from(stringify(changed), "utf8") }),
    );
    expect(result).toEqual({ ok: false, phase: "preflight", error: "control_manifest_mismatch" });
  });

  it("U-PACKPUB-STAGE-005: keeps staged bytes immutable through the sealed plan", () => {
    const result = buildPackPublicationStagingPlan(input());
    if (!result.ok) throw new Error(result.error);
    const before = Buffer.from(result.plan.commitEntries[0].bytes);
    result.plan.commitEntries[0].bytes[0] ^= 0xff;
    expect(Buffer.from(result.plan.commitEntries[0].bytes)).toEqual(before);
  });

  it("U-PACKPUB-STAGE-006: applies through injected ports atomically and restores on every fault", async () => {
    const built = buildPackPublicationStagingPlan(input());
    if (!built.ok) throw new Error(built.error);
    const plan = built.plan;
    for (const fault of ["stage", "apply", "discard"] as const) {
      const events: string[] = [];
      const state = { value: "prior" };
      const result = await applySealedPackPublication(plan, {
        snapshotDestination: () => ({ value: state.value }),
        writeStaging: () => {
          events.push("stage");
          if (fault === "stage") throw new Error(fault);
          return { staged: true };
        },
        applyDestination: () => {
          events.push("apply");
          state.value = "published";
          if (fault === "apply") throw new Error(fault);
        },
        discardStaging: () => {
          events.push("discard");
          if (fault === "discard") throw new Error(fault);
        },
        restoreDestination: (snapshot) => {
          events.push("restore");
          state.value = snapshot.value;
        },
      });
      expect(result).toEqual({ ok: false, error: "unavailable", applied: 0 });
      expect(state.value).toBe("prior");
      expect(events).toContain("restore");
    }

    const restoreAbsentDestination = vi.fn<(snapshot: undefined) => void>();
    const absentResult = await applySealedPackPublication(built.plan, {
      snapshotDestination: () => undefined,
      writeStaging: () => ({ staged: true }),
      applyDestination: () => {
        throw new Error("apply-after-creating-destination");
      },
      discardStaging: vi.fn(),
      restoreDestination: restoreAbsentDestination,
    });
    expect(absentResult).toEqual({ ok: false, error: "unavailable", applied: 0 });
    expect(restoreAbsentDestination).toHaveBeenCalledOnce();
    expect(restoreAbsentDestination).toHaveBeenCalledWith(undefined);
  });

  it("U-PACKPUB-STAGE-007: applies exactly once on success", async () => {
    const built = buildPackPublicationStagingPlan(input());
    if (!built.ok) throw new Error(built.error);
    const calls = { stage: 0, apply: 0, discard: 0, restore: 0 };
    const result = await applySealedPackPublication(built.plan, {
      snapshotDestination: () => ({ value: "prior" }),
      writeStaging: () => {
        calls.stage += 1;
        return { staged: true };
      },
      applyDestination: () => {
        calls.apply += 1;
      },
      discardStaging: () => {
        calls.discard += 1;
      },
      restoreDestination: () => {
        calls.restore += 1;
      },
    });
    expect(result).toEqual({ ok: true, applied: 1 });
    expect(calls).toEqual({ stage: 1, apply: 1, discard: 1, restore: 0 });
  });

  it("U-PACKPUB-STAGE-008: performs no staging or apply when the prior snapshot is unavailable", async () => {
    const built = buildPackPublicationStagingPlan(input());
    if (!built.ok) throw new Error(built.error);
    const writeStaging = vi.fn();
    const applyDestination = vi.fn();
    const discardStaging = vi.fn();
    const restoreDestination = vi.fn();
    const result = await applySealedPackPublication(built.plan, {
      snapshotDestination: () => {
        throw new Error("snapshot-unavailable");
      },
      writeStaging,
      applyDestination,
      discardStaging,
      restoreDestination,
    });
    expect(result).toEqual({ ok: false, error: "unavailable", applied: 0 });
    expect(writeStaging).not.toHaveBeenCalled();
    expect(applyDestination).not.toHaveBeenCalled();
    expect(discardStaging).not.toHaveBeenCalled();
    expect(restoreDestination).not.toHaveBeenCalled();
  });

  it("U-PACKPUB-STAGE-009: returns indeterminate when restore cannot prove prior state", async () => {
    const built = buildPackPublicationStagingPlan(input());
    if (!built.ok) throw new Error(built.error);
    const result = await applySealedPackPublication(built.plan, {
      snapshotDestination: () => ({ value: "prior" }),
      writeStaging: () => ({ staged: true }),
      applyDestination: () => {
        throw new Error("apply-after-side-effect");
      },
      discardStaging: vi.fn(),
      restoreDestination: () => {
        throw new Error("restore-failed");
      },
    });
    expect(result).toEqual({ ok: false, error: "indeterminate", applied: "indeterminate" });
  });

  it("U-PACKPUB-STAGE-010: audits each local observation drift with its typed reason", async () => {
    const built = buildPackPublicationStagingPlan(input());
    if (!built.ok) throw new Error(built.error);
    const plan = built.plan;
    const observation: PackPublicationObservation = {
      commitEntries: plan.commitEntries,
      releaseAssets: plan.releaseAssets,
      controlManifestSnapshotDigest: plan.controlManifestSnapshotDigest,
    };
    await expect(
      auditPackPublication(plan, { observe: async () => observation }),
    ).resolves.toMatchObject({
      status: "attested",
    });

    await expect(
      auditPackPublication(plan, {
        observe: () => ({ ...observation, releaseAssets: observation.releaseAssets.slice(0, 1) }),
      }),
    ).resolves.toEqual({
      status: "partial_publication",
      reason: "release_assets_mismatch",
    });

    await expect(
      auditPackPublication(plan, {
        observe: () => ({
          ...observation,
          releaseAssets: [
            { ...observation.releaseAssets[0], contentDigest: `sha256:${"e".repeat(64)}` },
            observation.releaseAssets[1],
          ],
        }),
      }),
    ).resolves.toEqual({
      status: "partial_publication",
      reason: "release_assets_mismatch",
    });

    const driftedAssetBytes = new Uint8Array(observation.releaseAssets[0].bytes);
    driftedAssetBytes[0] ^= 0xff;
    await expect(
      auditPackPublication(plan, {
        observe: () => ({
          ...observation,
          releaseAssets: [
            { ...observation.releaseAssets[0], bytes: driftedAssetBytes },
            observation.releaseAssets[1],
          ],
        }),
      }),
    ).resolves.toEqual({
      status: "partial_publication",
      reason: "release_assets_mismatch",
    });

    await expect(
      auditPackPublication(plan, {
        observe: () => ({
          ...observation,
          controlManifestSnapshotDigest: `sha256:${"f".repeat(64)}`,
        }),
      }),
    ).resolves.toEqual({
      status: "partial_publication",
      reason: "control_manifest_mismatch",
    });

    await expect(
      auditPackPublication(plan, {
        observe: () => ({ ...observation, commitEntries: observation.commitEntries.slice(0, 1) }),
      }),
    ).resolves.toEqual({
      status: "partial_publication",
      reason: "commit_entries_mismatch",
    });
    await expect(
      auditPackPublication(plan, {
        observe: () => {
          throw new Error("unavailable");
        },
      }),
    ).resolves.toEqual({ status: "indeterminate", reason: "observation_unavailable" });
  });
});
