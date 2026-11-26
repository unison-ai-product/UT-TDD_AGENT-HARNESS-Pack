import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import {
  type ConsumerRuntimeReleaseProducerError,
  packageConsumerRuntimeRelease,
} from "../src/cli/distribution.ts";
import {
  deriveArtifactInventoryDigest,
  deriveReleaseId,
  deriveReleaseRecordDigest,
} from "../src/schema/release-manifest.ts";
import {
  digestConsumerRuntimeBytes,
  digestMaterializedReleaseEntries,
} from "../src/setup/index.ts";
import { expect, it } from "./support/hook-bounds.ts";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function releaseManifest(sourceCommit: string): Record<string, unknown> {
  const content = Buffer.from("export const fixture = true;\n", "utf8");
  const artifacts = [
    {
      sourcePath: "src/artifact.ts",
      destinationPath: "src/artifact.ts",
      mode: "100644" as const,
      size: content.length,
      contentDigest: digestConsumerRuntimeBytes(content),
    },
  ];
  const artifactSetDigest = digestMaterializedReleaseEntries([
    { path: "src/artifact.ts", mode: "100644", content },
  ]);
  const publication = {
    materializerVersion: "1",
    artifactSourceCommit: sourceCommit,
    artifactSetDigest,
    artifactInventoryDigest: deriveArtifactInventoryDigest(artifacts),
    releaseAssetInventoryDigest: `sha256:${"c".repeat(64)}`,
    artifacts,
  };
  const releaseId = deriveReleaseId("1", sourceCommit, artifactSetDigest);
  return {
    schema_version: "v2",
    releases: {
      [releaseId]: {
        ...publication,
        releaseRecordDigest: deriveReleaseRecordDigest(publication),
      },
    },
    channels: { canary: releaseId, stable: releaseId },
    channelOrder: ["canary", "stable"],
  };
}

function commitManifest(root: string, tag: string, content: string): void {
  mkdirSync(join(root, "release"), { recursive: true });
  writeFileSync(join(root, "release", "manifest.yaml"), content, "utf8");
  git(root, "add", "--", "release/manifest.yaml");
  git(root, "commit", "--quiet", "-m", `manifest ${tag}`);
  git(root, "tag", tag);
}

it("Issue #1997: accepts a valid C2 manifest over 1 MiB and retains missing/invalid rejection", async () => {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-pack-manifest-limit-"));
  const outDir = join(root, "out");
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "artifact.ts"), "export const fixture = true;\n", "utf8");
    git(root, "init", "--quiet");
    git(root, "config", "user.email", "test@example.invalid");
    git(root, "config", "user.name", "UT test");
    git(root, "add", "--", "src/artifact.ts");
    git(root, "commit", "--quiet", "-m", "fixture artifact");
    const sourceCommit = git(root, "rev-parse", "HEAD");
    const missingTag = "v0.2.0-canary.2-missing";
    git(root, "tag", missingTag);

    const valid = stringify(releaseManifest(sourceCommit));
    const padding = 1_100_000 - Buffer.byteLength(valid) - 4;
    if (padding < 1) throw new Error("manifest fixture exceeds target size");
    const largeTag = "v0.2.0-canary.2-large";
    commitManifest(root, largeTag, `${valid}\n# ${"x".repeat(padding)}\n`);

    const invalidTag = "v0.2.0-canary.2-invalid";
    commitManifest(root, invalidTag, "schema_version: v2\n");

    for (const [tag, code] of [
      [missingTag, "consumer_runtime_release_manifest_unavailable"],
      [invalidTag, "consumer_runtime_release_manifest_invalid"],
    ] as const) {
      await expect(
        packageConsumerRuntimeRelease({
          repoRoot: root,
          tag,
          outDir,
          homeDirectory: root,
        }),
      ).rejects.toMatchObject({ code } satisfies Pick<ConsumerRuntimeReleaseProducerError, "code">);
    }

    await expect(
      packageConsumerRuntimeRelease({
        repoRoot: root,
        tag: largeTag,
        outDir,
        homeDirectory: root,
      }),
    ).rejects.toThrow("consumer runtime producer workdir is user-home scoped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
