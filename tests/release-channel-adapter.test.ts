import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { parseReleaseManifest } from "../src/schema/release-manifest.ts";
import type { ReleaseArtifactResolution } from "../src/setup/release-artifact-resolver.ts";
import {
  attestReleaseChannel,
  createReleaseChannelAdapter,
  type ReleaseChannelAdapterInput,
} from "../src/setup/release-channel-adapter.ts";

const commit = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;

function releaseId(): string {
  const payload = Buffer.concat([
    Buffer.from("1", "ascii"),
    Buffer.from([0]),
    Buffer.from(commit, "ascii"),
    Buffer.from([0]),
    Buffer.from(digest.slice("sha256:".length), "hex"),
  ]);
  return `rel-sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function input(channel = "stable"): ReleaseChannelAdapterInput {
  const id = releaseId();
  const parsed = parseReleaseManifest({
    schema_version: "v1",
    releases: {
      [id]: {
        materializerVersion: "1",
        artifactSourceCommit: commit,
        artifactSetDigest: digest,
      },
    },
    channels: { stable: id },
    channelOrder: ["stable"],
  });
  if (!parsed.ok) throw new Error("fixture manifest must be valid");
  return { repository: "fixture-repository", manifest: parsed.value, channel };
}

function resolved(actualDigest = digest): ReleaseArtifactResolution {
  const id = releaseId();
  return {
    ok: true,
    releaseId: id,
    artifactSourceCommit: commit,
    artifactSetDigest: digest,
    entries: Object.freeze([
      Object.freeze({ path: "package.json", mode: "100644", content: new Uint8Array([1]) }),
    ]),
    digest: actualDigest,
  };
}

describe("U-RELMAN-006 PF-4 channel adapter", () => {
  it("attests when the selected release digest matches the materialized snapshot", async () => {
    const resolveArtifacts = vi.fn(async () => resolved());
    const result = await attestReleaseChannel(input(), { resolveArtifacts });

    expect(result).toMatchObject({
      status: "attested",
      releaseId: releaseId(),
      artifactSourceCommit: commit,
      expectedDigest: digest,
      actualDigest: digest,
    });
    expect(resolveArtifacts).toHaveBeenCalledOnce();
    expect(resolveArtifacts).toHaveBeenCalledWith({
      repository: "fixture-repository",
      release: expect.objectContaining({ artifactSourceCommit: commit }),
    });
  });

  it("preserves digest mismatch as mismatch without exposing a write port", async () => {
    const resolveArtifacts = vi.fn(async () => resolved(`sha256:${"c".repeat(64)}`));
    const adapter = createReleaseChannelAdapter({ resolveArtifacts });
    const result = await adapter(input());

    expect(result).toEqual({
      status: "mismatch",
      releaseId: releaseId(),
      artifactSourceCommit: commit,
      expectedDigest: digest,
      actualDigest: `sha256:${"c".repeat(64)}`,
    });
    expect(resolveArtifacts).toHaveBeenCalledOnce();
  });

  it("returns unavailable for unknown channels and resolver failures", async () => {
    const resolveArtifacts = vi.fn(async () => ({
      ok: false as const,
      error: "unavailable" as const,
    }));
    expect(await attestReleaseChannel(input("preview"), { resolveArtifacts })).toEqual({
      status: "unavailable",
      reason: "unknown_channel",
    });
    expect(resolveArtifacts).not.toHaveBeenCalled();

    expect(await attestReleaseChannel(input(), { resolveArtifacts })).toEqual({
      status: "unavailable",
      releaseId: releaseId(),
      reason: "unavailable",
    });
    expect(resolveArtifacts).toHaveBeenCalledOnce();
  });

  it.each([
    ["releaseId", { releaseId: "rel-drift" }],
    ["artifactSourceCommit", { artifactSourceCommit: "c".repeat(40) }],
    ["artifactSetDigest", { artifactSetDigest: `sha256:${"c".repeat(64)}` }],
  ] as const)("U-RELMAN-018: rejects resolver %s identity drift as invalid_artifact", async (_field, mutation) => {
    const resolveArtifacts = vi.fn(async () => ({ ...resolved(), ...mutation }));

    await expect(attestReleaseChannel(input(), { resolveArtifacts })).resolves.toEqual({
      status: "unavailable",
      releaseId: releaseId(),
      reason: "invalid_artifact",
    });
  });

  it("U-RELMAN-018: converts a throwing resolver port to unavailable", async () => {
    const resolveArtifacts = vi.fn(async () => {
      throw new Error("resolver port failure");
    });

    await expect(attestReleaseChannel(input(), { resolveArtifacts })).resolves.toEqual({
      status: "unavailable",
      releaseId: releaseId(),
      reason: "unavailable",
    });
  });

  it.each([
    "invalid_distribution_plan",
    "invalid_artifact",
  ] as const)("U-RELMAN-018: preserves typed resolver reason %s", async (error) => {
    const resolveArtifacts = vi.fn(async () => ({ ok: false as const, error }));

    await expect(attestReleaseChannel(input(), { resolveArtifacts })).resolves.toEqual({
      status: "unavailable",
      releaseId: releaseId(),
      reason: error,
    });
  });
});
