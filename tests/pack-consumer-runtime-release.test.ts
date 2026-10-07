import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { projectTrackedTeamBlob } from "../src/setup/authoring-template-inventory.ts";
import * as setupApi from "../src/setup/index.ts";

const installerExecutionRoot = resolve(process.cwd());

import {
  assertProducerPathsOutsideHome,
  type ConsumerRuntimeReleaseProducerError,
  collectDistributionCandidatePaths,
  packageConsumerRuntimeRelease,
  resolveConsumerRuntimeReleaseSourceBinding,
} from "../src/cli/distribution.ts";
import {
  type NodeGeneration,
  type NodeGenerationBuildInput,
  parseNodeBootstrapReceiptBytes,
  REVIEWED_NODE_VERSION,
  REVIEWED_NPM_VERSION,
} from "../src/runtime/node-bootstrap.ts";
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
  AUTHORING_TEMPLATE_ARTIFACT_PATHS,
  buildCleanDistributionPlan,
  cleanDistributionSourcePath,
  digestConsumerRuntimeBytes,
  digestMaterializedReleaseEntries,
  releaseArtifactFileNames,
  transformCleanDistributionArtifact,
} from "../src/setup/index.ts";
import {
  createLocalGitObjectReader,
  resolveReleaseArtifacts,
} from "../src/setup/release-artifact-resolver.ts";
import { materializeReleaseArtifacts } from "../src/setup/release-materializer.ts";

const revision = "a".repeat(40);
const digest = digestMaterializedReleaseEntries([
  { path: "src/entry.ts", mode: "100644", content: Buffer.from("a", "utf8") },
]);
const compiledDigest = `sha256:${"b".repeat(64)}`;
const releaseId = deriveReleaseId("1", revision, digest);
const publicationArtifacts = [
  {
    sourcePath: "releases/canary/entry.ts",
    destinationPath: "src/entry.ts",
    mode: "100644" as const,
    size: 1,
    contentDigest: digestConsumerRuntimeBytes(Buffer.from("a", "utf8")),
  },
];
const artifactInventoryDigest = deriveArtifactInventoryDigest(publicationArtifacts);
const releaseRecordDigest = deriveReleaseRecordDigest({
  materializerVersion: "1",
  artifactSourceCommit: revision,
  artifactSetDigest: digest,
  artifactInventoryDigest,
  releaseAssetInventoryDigest: `sha256:${"c".repeat(64)}`,
});
const manifest = {
  schema_version: "v2" as const,
  releases: {
    [releaseId]: {
      materializerVersion: "1",
      artifactSourceCommit: revision,
      artifactSetDigest: digest,
      artifactInventoryDigest,
      releaseAssetInventoryDigest: `sha256:${"c".repeat(64)}`,
      releaseRecordDigest,
      artifacts: publicationArtifacts,
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

function fixtureGit(root: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

interface RawGitTreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly bytes: Buffer;
}

interface TarReadbackEntry {
  readonly path: string;
  readonly mode: "100644" | "100755";
  readonly bytes: Buffer;
}

function readRawGitTree(root: string, revision: string): Map<string, RawGitTreeEntry> {
  const records = execFileSync("git", ["ls-tree", "-r", "-z", "--full-tree", revision], {
    cwd: root,
    encoding: "buffer",
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const treeEntries: { mode: string; objectId: string; path: string }[] = [];
  const paths = new Set<string>();
  for (const record of records) {
    const match = /^(\d{6}) blob ([a-f0-9]{40})\t(.+)$/.exec(record);
    if (!match) throw new Error(`unexpected raw Git tree record: ${record}`);
    if (paths.has(match[3])) throw new Error(`duplicate raw Git tree path: ${match[3]}`);
    paths.add(match[3]);
    treeEntries.push({ mode: match[1], objectId: match[2], path: match[3] });
  }

  const objectIds = [...new Set(treeEntries.map((entry) => entry.objectId))];
  if (objectIds.length === 0) return new Map();
  const batch = execFileSync("git", ["cat-file", "--batch"], {
    cwd: root,
    input: Buffer.from(`${objectIds.join("\n")}\n`, "ascii"),
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
  const blobs = new Map<string, Buffer>();
  let offset = 0;
  for (const expectedObjectId of objectIds) {
    const headerEnd = batch.indexOf(0x0a, offset);
    if (headerEnd < 0) throw new Error("raw Git batch response is missing a header terminator");
    const header = batch.subarray(offset, headerEnd).toString("ascii");
    const match = /^([a-f0-9]{40}) blob (0|[1-9][0-9]*)$/.exec(header);
    if (!match || match[1] !== expectedObjectId)
      throw new Error(`unexpected raw Git batch header: ${header}`);
    const size = Number(match[2]);
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (!Number.isSafeInteger(size) || contentEnd >= batch.length)
      throw new Error(`invalid raw Git batch blob size: ${header}`);
    if (batch[contentEnd] !== 0x0a)
      throw new Error(`raw Git batch blob delimiter missing: ${expectedObjectId}`);
    const bytes = Buffer.from(batch.subarray(contentStart, contentEnd));
    const actualObjectId = createHash("sha1")
      .update(Buffer.from(`blob ${size}\0`, "ascii"))
      .update(bytes)
      .digest("hex");
    if (actualObjectId !== expectedObjectId)
      throw new Error(`raw Git batch blob hash mismatch: ${expectedObjectId}`);
    blobs.set(expectedObjectId, bytes);
    offset = contentEnd + 1;
  }
  if (offset !== batch.length) throw new Error("raw Git batch response has trailing bytes");

  const entries = new Map<string, RawGitTreeEntry>();
  for (const entry of treeEntries) {
    const bytes = blobs.get(entry.objectId);
    if (!bytes) throw new Error(`raw Git batch blob missing: ${entry.objectId}`);
    entries.set(entry.path, { path: entry.path, mode: entry.mode, bytes });
  }
  return entries;
}

function readTarEntries(tarballBytes: Uint8Array): TarReadbackEntry[] {
  const archive = gunzipSync(tarballBytes);
  const entries: TarReadbackEntry[] = [];
  let offset = 0;
  let longName: string | undefined;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const readString = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const parseOctal = (start: number, length: number) => {
      const value = readString(start, length).trim();
      return value ? Number.parseInt(value, 8) : 0;
    };
    const size = parseOctal(124, 12);
    const type = header[156] ?? 0;
    const name = readString(0, 100);
    const prefix = readString(345, 155);
    const rawPath = longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = undefined;
    const contentStart = offset + 512;
    const content = archive.subarray(contentStart, contentStart + size);
    if (type === 0x4c) {
      longName = content.toString("utf8").replace(/[\0\n]+$/, "");
    } else if (type === 0x78) {
      const pathRecord = content
        .toString("utf8")
        .split("\n")
        .find((line) => line.includes(" path="));
      if (pathRecord) longName = pathRecord.slice(pathRecord.indexOf(" path=") + 6);
    } else if (type === 0 || type === 0x30 || type === 0x37) {
      const path = rawPath.replace(/^\.\//, "");
      if (path && !path.endsWith("/")) {
        const mode = parseOctal(100, 8) & 0o111 ? "100755" : "100644";
        entries.push({ path, mode, bytes: Buffer.from(content) });
      }
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function releaseManifestForFixture(artifactSourceCommit: string): Record<string, unknown> {
  const content = Buffer.from("export const fixture = true;\n", "utf8");
  const publicationArtifacts = [
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
  const publicationBase = {
    materializerVersion: "1",
    artifactSourceCommit,
    artifactSetDigest,
    artifactInventoryDigest: deriveArtifactInventoryDigest(publicationArtifacts),
    releaseAssetInventoryDigest: `sha256:${"c".repeat(64)}`,
    artifacts: publicationArtifacts,
  };
  const releaseId = deriveReleaseId("1", artifactSourceCommit, artifactSetDigest);
  return {
    schema_version: "v2",
    releases: {
      [releaseId]: {
        ...publicationBase,
        releaseRecordDigest: deriveReleaseRecordDigest(publicationBase),
      },
    },
    channels: { canary: releaseId, stable: releaseId },
    channelOrder: ["canary", "stable"],
  };
}

function createReleaseBindingFixture(
  variant: "normal" | "tag-at-c1" | "side-branch" | "second-parent" | "src-mutation" | "schema",
): { root: string; tag: string; c1: string; c2: string | null; side?: string } {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-packrt-011-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "artifact.ts"), "export const fixture = true;\n", "utf8");
  fixtureGit(root, ["init", "--quiet"]);
  fixtureGit(root, ["config", "user.email", "test@example.invalid"]);
  fixtureGit(root, ["config", "user.name", "UT test"]);
  fixtureGit(root, ["add", "--", "."]);
  fixtureGit(root, ["commit", "--quiet", "-m", "fixture artifact"]);
  const c1 = fixtureGit(root, ["rev-parse", "HEAD"]);
  const tag = "v0.2.0-canary.2";
  if (variant === "tag-at-c1") {
    fixtureGit(root, ["tag", tag]);
    return { root, tag, c1, c2: null };
  }

  if (variant === "side-branch" || variant === "second-parent") {
    fixtureGit(root, ["checkout", "-qb", "side"]);
    writeFileSync(join(root, "side.txt"), "side branch\n", "utf8");
    fixtureGit(root, ["add", "--", "side.txt"]);
    fixtureGit(root, ["commit", "--quiet", "-m", "side artifact"]);
    const sideArtifact = fixtureGit(root, ["rev-parse", "HEAD"]);
    if (variant === "side-branch") {
      fixtureGit(root, ["checkout", "-qb", "release", c1]);
      mkdirSync(join(root, "release"), { recursive: true });
      writeFileSync(
        join(root, "release", "manifest.yaml"),
        stringify(releaseManifestForFixture(sideArtifact)),
        "utf8",
      );
      fixtureGit(root, ["add", "--", "release/manifest.yaml"]);
      fixtureGit(root, ["commit", "--quiet", "-m", "release manifest"]);
    } else {
      fixtureGit(root, ["checkout", "-qb", "release", c1]);
      fixtureGit(root, ["checkout", "side"]);
      mkdirSync(join(root, "release"), { recursive: true });
      writeFileSync(
        join(root, "release", "manifest.yaml"),
        stringify(releaseManifestForFixture(sideArtifact)),
        "utf8",
      );
      fixtureGit(root, ["add", "--", "release/manifest.yaml"]);
      fixtureGit(root, ["commit", "--quiet", "-m", "side manifest"]);
      fixtureGit(root, ["checkout", "release"]);
      fixtureGit(root, ["merge", "--no-ff", "--no-edit", "side"]);
    }
  } else {
    fixtureGit(root, ["checkout", "-qb", "release", c1]);
    mkdirSync(join(root, "release"), { recursive: true });
    writeFileSync(
      join(root, "release", "manifest.yaml"),
      variant === "schema" ? "schema_version: v2\n" : stringify(releaseManifestForFixture(c1)),
      "utf8",
    );
    if (variant === "src-mutation") {
      writeFileSync(
        join(root, "src", "release-mutation.ts"),
        "export const changed = true;\n",
        "utf8",
      );
      fixtureGit(root, ["add", "--", "release/manifest.yaml", "src/release-mutation.ts"]);
    } else {
      fixtureGit(root, ["add", "--", "release/manifest.yaml"]);
    }
    fixtureGit(root, ["commit", "--quiet", "-m", "release manifest"]);
  }
  const c2 = fixtureGit(root, ["rev-parse", "HEAD"]);
  fixtureGit(root, ["tag", tag]);
  return { root, tag, c1, c2 };
}

interface ProducerFixture {
  root: string;
  tag: string;
  c1: string;
}

async function createProducerFixture(
  fullInventory = true,
  tag = "v0.2.0-canary.2",
  includeReleaseManifest = true,
): Promise<ProducerFixture> {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-packrt-producer-"));
  const repositoryRoot = resolve(process.cwd());
  const sourcePaths = collectDistributionCandidatePaths(repositoryRoot);
  const artifactPaths = [
    "README.md",
    "LICENSE",
    "NOTICE",
    "package.json",
    ".node-version",
    "src/cli.ts",
    "src/setup/index.ts",
    "docs/templates/adapter/AGENTS.md",
    "docs/templates/adapter/CLAUDE.md",
    "docs/templates/adapter/.codex/config.toml",
    "docs/templates/adapter/.codex/hooks.json",
    "docs/templates/adapter/.claude/CLAUDE.md",
    "docs/templates/adapter/.claude/settings.json",
    "docs/templates/adapter/.claude/agents/be-api.md",
    "docs/templates/adapter/.claude/agents/be-logic.md",
    "docs/templates/adapter/.claude/agents/blind-reviewer.md",
    "docs/templates/adapter/.claude/agents/code-reviewer.md",
    "docs/templates/adapter/.claude/agents/db-schema.md",
    "docs/templates/adapter/.claude/agents/devops-deploy.md",
    "docs/templates/adapter/.claude/agents/pdm-innovation-manager.md",
    "docs/templates/adapter/.claude/agents/pdm-marketing-innovation.md",
    "docs/templates/adapter/.claude/agents/pdm-tech-innovation.md",
    "docs/templates/adapter/.claude/agents/pmo-haiku.md",
    "docs/templates/adapter/.claude/agents/pmo-project-explorer.md",
    "docs/templates/adapter/.claude/agents/pmo-project-scout.md",
    "docs/templates/adapter/.claude/agents/pmo-sonnet.md",
    "docs/templates/adapter/.claude/agents/pmo-tech-docs.md",
    "docs/templates/adapter/.claude/agents/pmo-tech-fork.md",
    "docs/templates/adapter/.claude/agents/pmo-tech-news.md",
    "docs/templates/adapter/.claude/agents/qa-test.md",
    "docs/templates/adapter/.claude/agents/refactor-scout.md",
    "docs/templates/adapter/.claude/agents/security-audit.md",
    "docs/templates/adapter/.claude/agents/ut-tdd-tl.md",
    "docs/templates/adapter/.claude/commands/build.md",
    "docs/templates/adapter/.claude/commands/code-simplify.md",
    "docs/templates/adapter/.claude/commands/sdd-plan.md",
    "docs/templates/adapter/.claude/commands/sdd-review.md",
    "docs/templates/adapter/.claude/commands/ship.md",
    "docs/templates/adapter/.claude/commands/spec.md",
    "docs/templates/adapter/.claude/commands/test.md",
    "docs/templates/adapter/.claude/commands/ut-tdd-status.md",
    "docs/templates/adapter/.claude/commands/ut-tdd-test.md",
    ...AUTHORING_TEMPLATE_ARTIFACT_PATHS,
  ];
  const sourcePathSet = sourcePaths;
  for (const artifactPath of artifactPaths) {
    const sourcePath = cleanDistributionSourcePath(artifactPath, sourcePathSet);
    const from = join(repositoryRoot, ...sourcePath.split("/"));
    const to = join(root, ...artifactPath.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
  }
  rmSync(join(root, ".github", "workflows", "harness-check.yml"), { force: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "artifact.ts"), "export const fixture = true;\n", "utf8");
  fixtureGit(root, ["init", "--quiet"]);
  fixtureGit(root, ["config", "user.email", "test@example.invalid"]);
  fixtureGit(root, ["config", "user.name", "UT test"]);
  fixtureGit(root, ["add", "--", "."]);
  fixtureGit(root, ["commit", "--quiet", "-m", "fixture artifact"]);
  const fixturePlan = buildCleanDistributionPlan({
    paths: collectDistributionCandidatePaths(root),
    sourceTag: "fixture",
  });
  if (!fixturePlan.ok)
    throw new Error(`producer fixture clean plan failed: ${fixturePlan.missingRequired.join(",")}`);
  const c1 = fixtureGit(root, ["rev-parse", "HEAD"]);
  if (!includeReleaseManifest) return { root, tag, c1 };
  const resolved = await resolveReleaseArtifacts(
    {
      repository: root,
      release: {
        releaseId: "fixture-release",
        materializerVersion: "1",
        artifactSourceCommit: c1,
        artifactSetDigest: `sha256:${"0".repeat(64)}`,
      },
    },
    { git: createLocalGitObjectReader(), materialize: materializeReleaseArtifacts },
  );
  if (!resolved.ok)
    throw new Error(`producer fixture artifact resolution failed: ${resolved.error}`);
  const artifactEntry = resolved.entries.find((entry) => entry.path === "src/artifact.ts");
  if (!artifactEntry) throw new Error("producer fixture artifact entry is missing");
  const publicationArtifacts = fullInventory
    ? resolved.entries.map((item) => {
        if (item.mode !== "100644" && item.mode !== "100755")
          throw new Error("publication fixture mode is not supported");
        return {
          sourcePath: cleanDistributionSourcePath(item.path, sourcePathSet),
          destinationPath: item.path,
          mode: item.mode,
          size: item.content.length,
          contentDigest: digestConsumerRuntimeBytes(item.content),
        };
      })
    : [
        {
          sourcePath: "src/artifact.ts",
          destinationPath: artifactEntry.path,
          mode: "100644" as const,
          size: artifactEntry.content.length,
          contentDigest: digestConsumerRuntimeBytes(artifactEntry.content),
        },
      ];
  const publicationBase = {
    materializerVersion: "1",
    artifactSourceCommit: c1,
    artifactSetDigest: resolved.digest,
    artifactInventoryDigest: deriveArtifactInventoryDigest(publicationArtifacts),
    releaseAssetInventoryDigest: `sha256:${"c".repeat(64)}`,
    artifacts: publicationArtifacts,
  };
  const releaseId = deriveReleaseId("1", c1, resolved.digest);
  const manifest = {
    schema_version: "v2" as const,
    releases: {
      [releaseId]: {
        ...publicationBase,
        releaseRecordDigest: deriveReleaseRecordDigest(publicationBase),
      },
    },
    channels: { canary: releaseId, stable: releaseId },
    channelOrder: ["canary", "stable"],
  };
  mkdirSync(join(root, "release"), { recursive: true });
  writeFileSync(join(root, "release", "manifest.yaml"), stringify(manifest), "utf8");
  fixtureGit(root, ["add", "--", "release/manifest.yaml"]);
  fixtureGit(root, ["commit", "--quiet", "-m", "release manifest"]);
  fixtureGit(root, ["tag", tag]);
  return { root, tag, c1 };
}

async function createPackrt013Fixture(): Promise<ProducerFixture> {
  const fixture = await createProducerFixture(true, "v0.2.0-canary-013", false);
  const scriptPath = join(fixture.root, "scripts", "ut-tdd.ps1");
  mkdirSync(dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, "Write-Output 'packrt-013 LF blob'\n", "utf8");
  writeFileSync(
    join(fixture.root, "scripts", "executable.sh"),
    "#!/bin/sh\nprintf 'packrt-013\\n'\n",
    "utf8",
  );
  writeFileSync(join(fixture.root, ".gitattributes"), "*.ps1 text eol=crlf\n", "utf8");
  fixtureGit(fixture.root, ["config", "core.autocrlf", "true"]);
  fixtureGit(fixture.root, [
    "add",
    "--",
    ".gitattributes",
    "scripts/ut-tdd.ps1",
    "scripts/executable.sh",
  ]);
  fixtureGit(fixture.root, ["update-index", "--chmod=+x", "--", "scripts/executable.sh"]);
  fixtureGit(fixture.root, ["commit", "--quiet", "--amend", "--no-edit"]);
  fixtureGit(fixture.root, ["checkout", "--force", "HEAD"]);
  fixture.c1 = fixtureGit(fixture.root, ["rev-parse", "HEAD"]);

  const resolved = await resolveReleaseArtifacts(
    {
      repository: fixture.root,
      release: {
        releaseId: "fixture-release",
        materializerVersion: "1",
        artifactSourceCommit: fixture.c1,
        artifactSetDigest: `sha256:${"0".repeat(64)}`,
      },
    },
    { git: createLocalGitObjectReader(), materialize: materializeReleaseArtifacts },
  );
  if (!resolved.ok) throw new Error(`U-PACKRT-013 resolver fixture failed: ${resolved.error}`);
  const tree = readRawGitTree(fixture.root, fixture.c1);
  const publicationArtifacts = resolved.entries.map((entry) => {
    const raw = tree.get(cleanDistributionSourcePath(entry.path, [...tree.keys()]));
    if (!raw) throw new Error(`U-PACKRT-013 source blob is missing: ${entry.path}`);
    if (entry.mode !== "100644" && entry.mode !== "100755")
      throw new Error(`U-PACKRT-013 fixture has unsupported mode: ${entry.path}`);
    return {
      sourcePath: cleanDistributionSourcePath(entry.path, [...tree.keys()]),
      destinationPath: entry.path,
      mode: entry.mode,
      size: entry.content.length,
      contentDigest: digestConsumerRuntimeBytes(entry.content),
    };
  });
  const publicationBase = {
    materializerVersion: "1",
    artifactSourceCommit: fixture.c1,
    artifactSetDigest: resolved.digest,
    artifactInventoryDigest: deriveArtifactInventoryDigest(publicationArtifacts),
    releaseAssetInventoryDigest: `sha256:${"c".repeat(64)}`,
    artifacts: publicationArtifacts,
  };
  const id = deriveReleaseId("1", fixture.c1, resolved.digest);
  const releaseManifest = {
    schema_version: "v2" as const,
    releases: {
      [id]: { ...publicationBase, releaseRecordDigest: deriveReleaseRecordDigest(publicationBase) },
    },
    channels: { canary: id, stable: id },
    channelOrder: ["canary", "stable"],
  };
  mkdirSync(join(fixture.root, "release"), { recursive: true });
  writeFileSync(join(fixture.root, "release", "manifest.yaml"), stringify(releaseManifest), "utf8");
  fixtureGit(fixture.root, ["add", "--", "release/manifest.yaml"]);
  fixtureGit(fixture.root, ["commit", "--quiet", "-m", "release manifest for U-PACKRT-013"]);
  fixtureGit(fixture.root, ["tag", fixture.tag]);
  return fixture;
}

async function createPackrt012Fixture(schemaVersion: "v1" | "v2" = "v2"): Promise<{
  root: string;
  c0: string;
  c1: string;
  c2: string;
  tags: readonly [string, string, string, string];
  canaryReleaseId: string;
  stableReleaseId: string;
  artifactCount: number;
}> {
  const base = await createProducerFixture(true, "v0.2.0-canary.2", false);
  const root = base.root;
  try {
    mkdirSync(join(root, "release"), { recursive: true });
    writeFileSync(join(root, "release", "fixture-notes.txt"), "C1-only release metadata\n", "utf8");
    fixtureGit(root, ["add", "--", "release/fixture-notes.txt"]);
    fixtureGit(root, ["commit", "--quiet", "-m", "release-only metadata"]);
    const c1 = fixtureGit(root, ["rev-parse", "HEAD"]);
    const c0 = base.c1;
    const resolver = {
      git: createLocalGitObjectReader(),
      materialize: materializeReleaseArtifacts,
    };
    const resolveAt = (revision: string) =>
      resolveReleaseArtifacts(
        {
          repository: root,
          release: {
            releaseId: "fixture-release",
            materializerVersion: "1",
            artifactSourceCommit: revision,
            artifactSetDigest: "sha256:" + "0".repeat(64),
          },
        },
        resolver,
      );
    const [c0Resolved, c1Resolved] = await Promise.all([resolveAt(c0), resolveAt(c1)]);
    if (!c0Resolved.ok) throw new Error("C0 artifact resolution failed: " + c0Resolved.error);
    if (!c1Resolved.ok) throw new Error("C1 artifact resolution failed: " + c1Resolved.error);
    if (c0Resolved.digest !== c1Resolved.digest)
      throw new Error("release-only C1 change unexpectedly changed the artifact set");
    if (c1Resolved.entries.some((entry) => entry.path === "release/fixture-notes.txt"))
      throw new Error("C1-only release metadata entered the artifact set");
    const publicationArtifacts = c1Resolved.entries.map((entry) => {
      if (entry.mode !== "100644" && entry.mode !== "100755")
        throw new Error("publication fixture mode is not supported");
      return {
        sourcePath: entry.path,
        destinationPath: entry.path,
        mode: entry.mode,
        size: entry.content.length,
        contentDigest: digestConsumerRuntimeBytes(entry.content),
      };
    });
    const canaryReleaseId = deriveReleaseId("1", c1, c1Resolved.digest);
    const stableReleaseId = deriveReleaseId("1", c0, c0Resolved.digest);
    const makeRecord = (sourceRevision: string, artifactSetDigest: string) => {
      const baseRecord = {
        materializerVersion: "1",
        artifactSourceCommit: sourceRevision,
        artifactSetDigest,
      };
      if (schemaVersion === "v1") return baseRecord;
      const publicationBase = {
        ...baseRecord,
        artifactInventoryDigest: deriveArtifactInventoryDigest(publicationArtifacts),
        releaseAssetInventoryDigest: "sha256:" + "c".repeat(64),
        artifacts: publicationArtifacts,
      };
      return {
        ...publicationBase,
        releaseRecordDigest: deriveReleaseRecordDigest(publicationBase),
      };
    };
    const manifest = {
      schema_version: schemaVersion,
      releases: {
        [canaryReleaseId]: makeRecord(c1, c1Resolved.digest),
        [stableReleaseId]: makeRecord(c0, c0Resolved.digest),
      },
      channels: { canary: canaryReleaseId, stable: stableReleaseId },
      channelOrder: ["canary", "stable"],
    };
    writeFileSync(join(root, "release", "manifest.yaml"), stringify(manifest), "utf8");
    fixtureGit(root, ["add", "--", "release/manifest.yaml"]);
    fixtureGit(root, ["commit", "--quiet", "-m", "channel-split release manifest"]);
    const c2 = fixtureGit(root, ["rev-parse", "HEAD"]);
    const tags = ["v0.2.0-canary.2", "v0.2.0", "v0.0.0-canary-fixture", "v0.0.0-accept"] as const;
    for (const tag of tags) fixtureGit(root, ["tag", tag]);
    return {
      root,
      c0,
      c1,
      c2,
      tags,
      canaryReleaseId,
      stableReleaseId,
      artifactCount: c1Resolved.entries.length,
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function sealReceipt(unsigned: Record<string, unknown>): Buffer {
  return Buffer.from(
    JSON.stringify({
      ...unsigned,
      receipt_digest: createHash("sha256").update(canonical(unsigned)).digest("hex"),
    }),
    "utf8",
  );
}

function fakeGenerationBuilder(
  options: { nodeVersion?: string; fail?: boolean; compiledBytes?: Buffer } = {},
): (input: string | NodeGenerationBuildInput) => Promise<NodeGeneration> {
  return async (input) => {
    if (options.fail) throw new Error("injected Node generation failure");
    if (typeof input === "string") throw new Error("fixture generation input must be structured");
    if (!input.outputRoot) throw new Error("fixture generation output root is missing");
    const compiledBytes =
      options.compiledBytes ?? Buffer.from("export default 'fixture runtime';\n", "utf8");
    const compiledSha256 = createHash("sha256").update(compiledBytes).digest("hex");
    const toolchainRoot = process.platform === "win32" ? "C:/toolchain" : "/opt/ut-tdd-toolchain";
    const unsigned = {
      ...receiptUnsigned,
      generation_id: "fixture-generation",
      subject_revision: input.candidateRevision,
      node: {
        ...receiptUnsigned.node,
        path: `${toolchainRoot}/node${process.platform === "win32" ? ".exe" : ""}`,
        version: options.nodeVersion ?? REVIEWED_NODE_VERSION,
      },
      npm: {
        ...receiptUnsigned.npm,
        cli_path: `${toolchainRoot}/npm-cli.js`,
        version: REVIEWED_NPM_VERSION,
      },
      compiled_cli: {
        ...receiptUnsigned.compiled_cli,
        sha256: compiledSha256,
      },
    };
    const generationPath = join(input.outputRoot, "fixture-generation");
    const compiledCliPath = join(generationPath, "ut-tdd.mjs");
    mkdirSync(generationPath, { recursive: true });
    writeFileSync(compiledCliPath, compiledBytes);
    const receiptBytes = sealReceipt(unsigned);
    writeFileSync(join(generationPath, "receipt.json"), receiptBytes);
    return {
      nodePath: unsigned.node.path,
      compiledCliPath,
      generationPath,
      receipt: parseNodeBootstrapReceiptBytes(receiptBytes),
    };
  };
}

function assetBuffers(root: string, tag: string): Buffer[] {
  return Object.values(releaseArtifactFileNames(tag)).map((name) => readFileSync(join(root, name)));
}

function expectBytesNotToContain(buffers: Iterable<Buffer>, forbidden: Iterable<string>): void {
  for (const bytes of buffers) {
    for (const value of forbidden) {
      if (!value || value.length < 4) continue;
      if (bytes.includes(Buffer.from(value, "utf8")))
        throw new Error(`forbidden producer identity bytes: ${JSON.stringify(value)}`);
    }
  }
}

function validDocument(): ConsumerRuntimeRelease {
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
      compiled_esm_digest: compiledDigest,
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
      control_manifest_base64: Buffer.from(JSON.stringify(manifest), "utf8").toString("base64"),
    },
  };
}

interface RuntimeInstallerFixture {
  readonly root: string;
  readonly releaseDir: string;
  readonly consumerRoot: string;
  readonly tag: string;
  readonly anchor: string;
  readonly compiledBytes: Buffer;
  readonly runtime: ConsumerRuntimeRelease;
}

function hashHex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function checksumLine(bytes: Uint8Array, name: string): string {
  return `${hashHex(bytes)}  ${name}\n`;
}

function writeRuntimeInstallerAssets(input: {
  readonly releaseDir: string;
  readonly tag: string;
  readonly compiledBytes: Uint8Array;
  readonly runtime: ConsumerRuntimeRelease;
  readonly tarballBytes?: Uint8Array;
}): string {
  const names = releaseArtifactFileNames(input.tag);
  const tarball = Buffer.from(input.tarballBytes ?? Buffer.from("fixture source archive\n"));
  const compiled = Buffer.from(input.compiledBytes);
  const runtimeBytes = Buffer.from(`${canonical(input.runtime)}\n`, "utf8");
  const consumerChecksum = Buffer.from(
    `${checksumLine(compiled, names.compiledEsm)}${checksumLine(runtimeBytes, names.consumerRuntime)}`,
    "utf8",
  );
  writeFileSync(join(input.releaseDir, names.tarball), tarball);
  writeFileSync(join(input.releaseDir, names.checksum), checksumLine(tarball, names.tarball));
  writeFileSync(join(input.releaseDir, names.compiledEsm), compiled);
  writeFileSync(join(input.releaseDir, names.consumerRuntime), runtimeBytes);
  writeFileSync(join(input.releaseDir, names.consumerChecksum), consumerChecksum);
  return `sha256:${hashHex(consumerChecksum)}`;
}

async function createRuntimeInstallerFixture(): Promise<RuntimeInstallerFixture> {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-packrt-installer-"));
  const releaseDir = join(root, "release");
  const consumerRoot = join(root, "consumer");
  mkdirSync(releaseDir, { recursive: true });
  mkdirSync(consumerRoot, { recursive: true });
  fixtureGit(consumerRoot, ["init", "--quiet"]);

  const names = releaseArtifactFileNames("v0.2.0-canary.2");
  const compiledPath = join(releaseDir, names.compiledEsm);
  const metafilePath = `${compiledPath}.metafile.json`;
  execFileSync(
    process.execPath,
    [join(installerExecutionRoot, "scripts", "build-node.mjs"), compiledPath, metafilePath],
    { cwd: installerExecutionRoot, encoding: "utf8", windowsHide: true },
  );
  const compiledBytes = readFileSync(compiledPath);
  const executableDigest = hashHex(compiledBytes);
  const receiptBytes = sealReceipt({
    ...receiptUnsigned,
    compiled_cli: { ...receiptUnsigned.compiled_cli, sha256: executableDigest },
  });
  const base = validDocument();
  const runtime: ConsumerRuntimeRelease = {
    ...base,
    generation: {
      ...base.generation,
      compiled_esm_digest: `sha256:${executableDigest}`,
      node_bootstrap_receipt_base64: receiptBytes.toString("base64"),
    },
  };
  validateConsumerRuntimeRelease(runtime);
  const anchor = writeRuntimeInstallerAssets({
    releaseDir,
    tag: runtime.release.tag,
    compiledBytes,
    runtime,
  });
  rmSync(metafilePath, { force: true });
  return {
    root,
    releaseDir,
    consumerRoot,
    tag: runtime.release.tag,
    anchor,
    compiledBytes,
    runtime,
  };
}

function runRuntimeInstaller(
  fixture: RuntimeInstallerFixture,
  options: {
    readonly releaseDir?: string;
    readonly consumerRoot?: string;
    readonly anchor?: string;
  } = {},
) {
  const releaseDir = options.releaseDir ?? fixture.releaseDir;
  const consumerRoot = options.consumerRoot ?? fixture.consumerRoot;
  const testRoot = dirname(consumerRoot);
  const installer = join(releaseDir, releaseArtifactFileNames(fixture.tag).compiledEsm);
  const args = [installer, "setup", "--solo", "--consumer-runtime-release", releaseDir];
  if (options.anchor !== "") {
    args.push("--expected-consumer-digest", options.anchor ?? fixture.anchor);
  }
  return spawnSync(process.execPath, args, {
    cwd: consumerRoot,
    encoding: "utf8",
    env: isolatedConsumerEnv(testRoot),
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function expectUnboundRepositorySetup(run: ReturnType<typeof runRuntimeInstaller>): void {
  expect(run.status, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(2);
  expect(run.stderr).toContain("identity: denied (identity_repository_unbound)");
  expect(run.stderr).toContain("recovery:");
}

function fileTreeSnapshot(root: string): string[] {
  const entries: string[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const rel = path.slice(root.length + 1).replaceAll("\\", "/");
      const info = statSync(path, { bigint: true });
      if (info.isDirectory()) {
        entries.push(`dir:${rel}:${info.mode}:${info.mtimeNs}:${info.ctimeNs}`);
        visit(path);
      } else {
        const bytes = readFileSync(path);
        entries.push(
          `file:${rel}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${hashHex(bytes)}`,
        );
      }
    }
  };
  visit(root);
  return entries;
}

const ISOLATED_USER_STATE_PATHS = [
  "home",
  "appdata",
  "localappdata",
  "gh-config",
  "claude-sessions",
  "codex-sessions",
  "codex-home",
] as const;

function isolatedConsumerEnv(testRoot: string): NodeJS.ProcessEnv {
  const home = join(testRoot, "home");
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(testRoot, "appdata"),
    LOCALAPPDATA: join(testRoot, "localappdata"),
    GH_CONFIG_DIR: join(testRoot, "gh-config"),
    CLAUDE_PROJECT_DIR: "",
    UT_TDD_PROJECT_DIR: "",
    UT_TDD_CLAUDE_SESSIONS_DIR: join(testRoot, "claude-sessions"),
    UT_TDD_CODEX_SESSIONS_DIR: join(testRoot, "codex-sessions"),
    CODEX_HOME: join(testRoot, "codex-home"),
  };
}

function consumerTreeSnapshot(root: string): string[] {
  const environmentState = ISOLATED_USER_STATE_PATHS.flatMap((name) => {
    const path = join(dirname(root), name);
    return existsSync(path)
      ? fileTreeSnapshot(path).map((entry) => `isolated:${name}:${entry}`)
      : [];
  });
  return [...fileTreeSnapshot(root), ...environmentState];
}

function consumerActivePointer(root: string): {
  readonly path: string;
  readonly bundlePath: string;
  readonly bytes: Buffer;
} {
  const path = join(root, ".ut-tdd", "runtime", "activation", "active.json");
  const bytes = readFileSync(path);
  const pointer = JSON.parse(bytes.toString("utf8")) as { bundle_path: string };
  return { path, bundlePath: pointer.bundle_path, bytes };
}

function copyInstallerCase(fixture: RuntimeInstallerFixture): {
  readonly root: string;
  readonly releaseDir: string;
  readonly consumerRoot: string;
} {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-packrt-installer-case-"));
  const releaseDir = join(root, "release");
  const consumerRoot = join(root, "consumer");
  mkdirSync(releaseDir, { recursive: true });
  mkdirSync(consumerRoot, { recursive: true });
  for (const name of readdirSync(fixture.releaseDir))
    cpSync(join(fixture.releaseDir, name), join(releaseDir, name));
  fixtureGit(consumerRoot, ["init", "--quiet"]);
  return { root, releaseDir, consumerRoot };
}

function runInstallerIn(
  fixture: RuntimeInstallerFixture,
  releaseDir: string,
  consumerRoot: string,
  anchor: string | undefined,
) {
  return runRuntimeInstaller(fixture, {
    releaseDir,
    consumerRoot,
    ...(anchor === undefined ? { anchor: "" } : { anchor }),
  });
}

function makeInstallerFixtureWritable(path: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    unlinkSync(path);
    return;
  }
  if (stat.isDirectory()) {
    chmodSync(path, (stat.mode & 0o777) | 0o700);
    for (const name of readdirSync(path)) makeInstallerFixtureWritable(join(path, name));
  } else if (stat.isFile()) {
    chmodSync(path, (stat.mode & 0o777) | 0o200);
  }
}

function removeInstallerFixtureTree(root: string): void {
  const resolvedRoot = resolve(root);
  const relativeRoot = relative(resolve(tmpdir()), resolvedRoot);
  if (
    !relativeRoot ||
    relativeRoot === ".." ||
    relativeRoot.startsWith(`..${sep}`) ||
    dirname(relativeRoot) !== "." ||
    !basename(relativeRoot).startsWith("ut-tdd-packrt-installer-")
  )
    throw new Error("installer fixture cleanup target is outside its owned temp root");
  makeInstallerFixtureWritable(resolvedRoot);
  rmSync(resolvedRoot, { recursive: true, force: true });
}

describe("Pack consumer runtime release producer contract", () => {
  it("U-PACKRT-011: binds the tagged release commit to a first-parent artifact source", async () => {
    const normal = createReleaseBindingFixture("normal");
    try {
      expect(resolveConsumerRuntimeReleaseSourceBinding(normal.root, normal.tag)).toEqual({
        releaseRevision: normal.c2,
        artifactSourceRevision: normal.c1,
        channel: "canary",
      });
    } finally {
      rmSync(normal.root, { recursive: true, force: true });
    }

    const cases = [
      ["tag-at-c1", "consumer_runtime_release_manifest_unavailable"],
      ["side-branch", "consumer_runtime_release_artifact_source_not_first_parent_ancestor"],
      ["second-parent", "consumer_runtime_release_artifact_source_not_first_parent_ancestor"],
      ["src-mutation", "consumer_runtime_release_diff_outside_release"],
      ["schema", "consumer_runtime_release_manifest_invalid"],
    ] as const;
    for (const [variant, code] of cases) {
      const fixture = createReleaseBindingFixture(variant);
      const outDir = mkdtempSync(join(tmpdir(), "ut-tdd-packrt-011-assets-"));
      try {
        await expect(
          packageConsumerRuntimeRelease({
            repoRoot: fixture.root,
            tag: fixture.tag,
            outDir,
            homeDirectory: join(fixture.root, "synthetic-home"),
            installDependencies: () => {
              throw new Error("must fail before dependency installation");
            },
            buildGeneration: async () => {
              throw new Error("must fail before generation");
            },
          }),
        ).rejects.toMatchObject({ code } satisfies Pick<
          ConsumerRuntimeReleaseProducerError,
          "code"
        >);
        expect(readdirSync(outDir)).toEqual([]);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
        rmSync(outDir, { recursive: true, force: true });
      }
    }
  });

  describe("CANDIDATE-U-PACKRT-012: binds producer channel selection to the tag and rejects v1", () => {
    let fixture: Awaited<ReturnType<typeof createPackrt012Fixture>> | undefined;

    beforeAll(async () => {
      fixture = await createPackrt012Fixture();
    });

    afterAll(() => {
      if (fixture) rmSync(fixture.root, { recursive: true, force: true });
    });

    it.each([
      { tagIndex: 0, channel: "canary", source: "canary" },
      { tagIndex: 1, channel: "stable", source: "stable" },
      { tagIndex: 2, channel: "stable", source: "stable" },
      { tagIndex: 3, channel: "stable", source: "stable" },
    ] as const)("binds tag case $tagIndex to its channel and release", async (testCase) => {
      const sharedFixture = fixture;
      if (!sharedFixture) throw new Error("shared v2 fixture was not initialized");
      expect(sharedFixture.canaryReleaseId).not.toBe(sharedFixture.stableReleaseId);
      const expected = {
        tag: sharedFixture.tags[testCase.tagIndex],
        channel: testCase.channel,
        revision: testCase.source === "canary" ? sharedFixture.c1 : sharedFixture.c0,
        releaseId:
          testCase.source === "canary"
            ? sharedFixture.canaryReleaseId
            : sharedFixture.stableReleaseId,
      };
      expect(resolveConsumerRuntimeReleaseSourceBinding(sharedFixture.root, expected.tag)).toEqual({
        releaseRevision: sharedFixture.c2,
        artifactSourceRevision: expected.revision,
        channel: expected.channel,
      });
      const outDir = mkdtempSync(join(tmpdir(), "ut-tdd-packrt-012-assets-"));
      try {
        const result = await packageConsumerRuntimeRelease({
          repoRoot: sharedFixture.root,
          tag: expected.tag,
          outDir,
          homeDirectory: join(sharedFixture.root, "synthetic-home"),
          installDependencies: () => undefined,
          buildGeneration: fakeGenerationBuilder(),
        });
        expect(result.sourceRevision).toBe(expected.revision);
        const names = releaseArtifactFileNames(expected.tag);
        const runtime = JSON.parse(
          readFileSync(join(outDir, names.consumerRuntime), "utf8"),
        ) as ConsumerRuntimeRelease;
        expect(runtime.release).toMatchObject({
          tag: expected.tag,
          source_revision: expected.revision,
        });
        expect(runtime.generation.subject_revision).toBe(expected.revision);
        const aggregate = runtime.admission_input.aggregate_input;
        expect(aggregate.channel).toBe(expected.channel);
        expect(aggregate.attestation).toMatchObject({
          status: "attested",
          releaseId: expected.releaseId,
          artifactSourceCommit: expected.revision,
        });
        expect(aggregate.final_tree.channelMappings).toHaveLength(sharedFixture.artifactCount);
        expect(aggregate.attestation.entries).toHaveLength(sharedFixture.artifactCount);
        expect(
          aggregate.final_tree.channelMappings.every(
            (mapping) =>
              mapping.channel === expected.channel &&
              mapping.releaseId === expected.releaseId &&
              mapping.sourceRevision === expected.revision,
          ),
        ).toBe(true);
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    });

    it("rejects a v1 manifest before dependency install or generation", async () => {
      const v1Fixture = await createPackrt012Fixture("v1");
      const outDir = mkdtempSync(join(tmpdir(), "ut-tdd-packrt-012-v1-assets-"));
      let dependencyInstallCalls = 0;
      let generationCalls = 0;
      try {
        await expect(
          packageConsumerRuntimeRelease({
            repoRoot: v1Fixture.root,
            tag: v1Fixture.tags[0],
            outDir,
            homeDirectory: join(v1Fixture.root, "synthetic-home"),
            installDependencies: () => {
              dependencyInstallCalls += 1;
            },
            buildGeneration: async () => {
              generationCalls += 1;
              throw new Error("v1 rejection must precede generation");
            },
          }),
        ).rejects.toMatchObject({
          code: "consumer_runtime_release_manifest_invalid",
          message: expect.stringContaining(":v1_read_only"),
        });
        expect(dependencyInstallCalls).toBe(0);
        expect(generationCalls).toBe(0);
        expect(readdirSync(outDir)).toEqual([]);
      } finally {
        rmSync(v1Fixture.root, { recursive: true, force: true });
        rmSync(outDir, { recursive: true, force: true });
      }
    });
  });

  it("U-PACKRT-001: names the exact five release assets and excludes manifest.json", () => {
    expect(releaseArtifactFileNames("v0.2.0-canary.2")).toEqual({
      tarball: "v0.2.0-canary.2.tar.gz",
      checksum: "v0.2.0-canary.2.tar.gz.sha256",
      compiledEsm: "v0.2.0-canary.2.ut-tdd.mjs",
      consumerRuntime: "v0.2.0-canary.2.consumer-runtime.json",
      consumerChecksum: "v0.2.0-canary.2.consumer.sha256",
    });
    expect(Object.values(releaseArtifactFileNames("v0.2.0-canary.2"))).not.toContain(
      "v0.2.0-canary.2.manifest.json",
    );
  });

  it("U-PACKRT-002: rejects missing, unknown, and wrong-typed schema fields", () => {
    const document = validDocument() as unknown as Record<string, unknown>;
    expect(() => validateConsumerRuntimeRelease({ ...document, unexpected: true })).toThrow(
      ConsumerRuntimeReleaseValidationError,
    );
    expect(() =>
      validateConsumerRuntimeRelease({
        ...document,
        release: { ...(document.release as object), product_id: 42 },
      }),
    ).toThrow(ConsumerRuntimeReleaseValidationError);
    expect(() =>
      validateConsumerRuntimeRelease({
        ...document,
        generation: { ...(document.generation as object), generation_id: undefined },
      }),
    ).toThrow(ConsumerRuntimeReleaseValidationError);
  });

  it("U-PACKRT-003: validates the sealed receipt as part of the schema boundary", () => {
    expect(validateConsumerRuntimeRelease(validDocument())).toMatchObject({
      schema_version: "ut-tdd.consumer-runtime.v1",
    });
    const mutated = validDocument();
    const value = JSON.parse(
      Buffer.from(mutated.generation.node_bootstrap_receipt_base64, "base64").toString("utf8"),
    );
    value.generation_id = "node-other";
    const invalid = {
      ...mutated,
      generation: {
        ...mutated.generation,
        node_bootstrap_receipt_base64: Buffer.from(JSON.stringify(value)).toString("base64"),
      },
    };
    expect(() => validateConsumerRuntimeRelease(invalid)).toThrow(
      ConsumerRuntimeReleaseValidationError,
    );

    const root = mkdtempSync(join(tmpdir(), "ut-tdd-packrt-home-"));
    const outside = mkdtempSync(join(tmpdir(), "ut-tdd-packrt-outside-"));
    try {
      expect(() =>
        assertProducerPathsOutsideHome({
          repoRoot: root,
          receipt: {
            node: { path: join(outside, "node.exe") },
            npm: { cli_path: join(outside, "npm-cli.js") },
          },
          homeDirectory: root,
        }),
      ).toThrow("user-home scoped");
      expect(() =>
        assertProducerPathsOutsideHome({
          repoRoot: outside,
          receipt: {
            node: { path: join(root, "node.exe") },
            npm: { cli_path: join(outside, "npm-cli.js") },
          },
          homeDirectory: root,
        }),
      ).toThrow("user-home scoped");
      if (process.platform === "win32") {
        const mixedCaseRoot = root.toUpperCase().replaceAll("\\", "/");
        expect(() =>
          assertProducerPathsOutsideHome({
            repoRoot: outside,
            receipt: {
              node: { path: `${mixedCaseRoot}/node.exe` },
              npm: { cli_path: join(outside, "npm-cli.js") },
            },
            homeDirectory: root,
          }),
        ).toThrow("user-home scoped");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("U-PACKRT-004: accepts the schema without any producer workspace path field", () => {
    expect(validateConsumerRuntimeRelease(validDocument()).release.product_id).toBe("ut-tdd");
  });
});

describe("Pack consumer runtime release producer byte and fail-close oracles", () => {
  let fixture: ProducerFixture;

  beforeAll(async () => {
    fixture = await createProducerFixture();
  });

  afterAll(() => {
    if (fixture) rmSync(fixture.root, { recursive: true, force: true });
  });

  const packageFixture = (
    outDir: string,
    options: {
      buildGeneration?: (input: string | NodeGenerationBuildInput) => Promise<NodeGeneration>;
      moveStagedAssets?: (source: string, destination: string) => void;
    } = {},
  ) =>
    packageConsumerRuntimeRelease({
      repoRoot: fixture.root,
      tag: fixture.tag,
      outDir,
      homeDirectory: join(fixture.root, "synthetic-home"),
      installDependencies: () => undefined,
      buildGeneration: options.buildGeneration ?? fakeGenerationBuilder(),
      ...(options.moveStagedAssets ? { moveStagedAssets: options.moveStagedAssets } : {}),
    });

  it("U-PACKRT-013: stages tar entries from C1 Git object bytes and modes", async () => {
    const packrt013 = await createPackrt013Fixture();
    const outDir = mkdtempSync(join(tmpdir(), "ut-tdd-packrt-013-assets-"));
    try {
      const rawTree = readRawGitTree(packrt013.root, packrt013.c1);
      expect(rawTree.get("scripts/executable.sh")?.mode).toBe("100755");
      const paths = [...rawTree.keys()];
      const plan = buildCleanDistributionPlan({ paths, sourceTag: packrt013.tag });
      expect(plan.ok).toBe(true);
      if (!plan.ok) throw new Error("U-PACKRT-013 clean distribution plan failed");

      const expected = plan.artifactPaths.map((artifactPath) => {
        const sourcePath = cleanDistributionSourcePath(artifactPath, paths);
        const source = rawTree.get(sourcePath);
        if (!source) throw new Error(`U-PACKRT-013 raw Git source is missing: ${sourcePath}`);
        if (source.mode !== "100644" && source.mode !== "100755")
          throw new Error(
            `U-PACKRT-013 unsupported public source mode: ${source.mode}:${sourcePath}`,
          );
        let bytes = Buffer.from(source.bytes);
        if (sourcePath === ".ut-tdd/teams/example-review-team.yaml") {
          const projection = projectTrackedTeamBlob({
            blobs: [{ path: source.path, mode: source.mode as "100644", bytes: source.bytes }],
          });
          expect(projection.ok).toBe(true);
          if (!projection.ok)
            throw new Error(`U-PACKRT-013 team projection failed: ${projection.error}`);
          bytes = Buffer.from(projection.bytes);
          expect(bytes).toEqual(source.bytes);
        }
        if (artifactPath === "package.json") {
          bytes = Buffer.from(
            transformCleanDistributionArtifact(artifactPath, source.bytes.toString("utf8")),
            "utf8",
          );
        }
        return { path: artifactPath, mode: source.mode, bytes };
      });

      const originalConfigCount = process.env.GIT_CONFIG_COUNT;
      const originalConfigKey0 = process.env.GIT_CONFIG_KEY_0;
      const originalConfigValue0 = process.env.GIT_CONFIG_VALUE_0;
      process.env.GIT_CONFIG_COUNT = "1";
      process.env.GIT_CONFIG_KEY_0 = "core.autocrlf";
      process.env.GIT_CONFIG_VALUE_0 = "true";
      try {
        await packageConsumerRuntimeRelease({
          repoRoot: packrt013.root,
          tag: packrt013.tag,
          outDir,
          homeDirectory: join(packrt013.root, "synthetic-home"),
          installDependencies: () => undefined,
          buildGeneration: async (input) => {
            if (typeof input === "string")
              throw new Error("fixture generation input must be structured");
            if (!input.repoRoot) throw new Error("fixture generation repo root is missing");
            expect(input.candidateRevision).toBe(packrt013.c1);
            expect(fixtureGit(input.repoRoot, ["rev-parse", "HEAD"])).toBe(packrt013.c1);
            return fakeGenerationBuilder()(input);
          },
        });
      } finally {
        if (originalConfigCount === undefined) delete process.env.GIT_CONFIG_COUNT;
        else process.env.GIT_CONFIG_COUNT = originalConfigCount;
        if (originalConfigKey0 === undefined) delete process.env.GIT_CONFIG_KEY_0;
        else process.env.GIT_CONFIG_KEY_0 = originalConfigKey0;
        if (originalConfigValue0 === undefined) delete process.env.GIT_CONFIG_VALUE_0;
        else process.env.GIT_CONFIG_VALUE_0 = originalConfigValue0;
      }

      const names = releaseArtifactFileNames(packrt013.tag);
      const tarball = readFileSync(join(outDir, names.tarball));
      const readback = readTarEntries(tarball).sort((left, right) =>
        left.path.localeCompare(right.path),
      );
      const expectedSorted = expected
        .map((entry) => ({ ...entry, mode: entry.mode as "100644" | "100755" }))
        .sort((left, right) => left.path.localeCompare(right.path));
      expect(readback).toEqual(expectedSorted);
      expect(readback.find((entry) => entry.path === "scripts/executable.sh")?.mode).toBe("100755");
      const ps1Blob = rawTree.get("scripts/ut-tdd.ps1");
      const ps1TarEntry = readback.find((entry) => entry.path === "scripts/ut-tdd.ps1");
      expect(ps1Blob?.bytes).toEqual(Buffer.from("Write-Output 'packrt-013 LF blob'\n", "utf8"));
      expect(ps1TarEntry?.bytes).toEqual(ps1Blob?.bytes);
      const packageJsonBlob = rawTree.get("package.json");
      const packageTarEntry = readback.find((entry) => entry.path === "package.json");
      expect(packageTarEntry?.bytes).toEqual(
        Buffer.from(
          transformCleanDistributionArtifact(
            "package.json",
            packageJsonBlob?.bytes.toString("utf8") ?? "",
          ),
          "utf8",
        ),
      );
      expect(readdirSync(outDir).sort()).toEqual(Object.values(names).sort());
    } finally {
      rmSync(packrt013.root, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("U-PACKRT-001: repeats the same revision with identical consumer runtime and checksum bytes", async () => {
    const first = mkdtempSync(join(tmpdir(), "ut-tdd-packrt-001-first-"));
    const second = mkdtempSync(join(tmpdir(), "ut-tdd-packrt-001-second-"));
    try {
      await packageFixture(first);
      await packageFixture(second);
      const names = releaseArtifactFileNames(fixture.tag);
      expect(readFileSync(join(first, names.consumerRuntime))).toEqual(
        readFileSync(join(second, names.consumerRuntime)),
      );
      expect(readFileSync(join(first, names.consumerChecksum))).toEqual(
        readFileSync(join(second, names.consumerChecksum)),
      );
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  it("U-PACKRT-003: scans every asset and the sealed receipt bytes for producer identity leakage", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "ut-tdd-packrt-003-"));
    const envSentinel = `packrt-env-sentinel-${fixture.tag}`;
    const producerUsername = `packrt-producer-user-${fixture.tag}`;
    const priorUser = process.env.USER;
    const priorUsername = process.env.USERNAME;
    process.env.UT_TDD_PACKRT_ENV_SENTINEL = envSentinel;
    // Exercise the actual producer environment with a unique identity, not a
    // generic host username that also occurs in committed source prose.
    process.env.USER = producerUsername;
    process.env.USERNAME = producerUsername;
    try {
      await packageFixture(outDir);
      const names = releaseArtifactFileNames(fixture.tag);
      const runtime = JSON.parse(
        readFileSync(join(outDir, names.consumerRuntime), "utf8"),
      ) as ConsumerRuntimeRelease;
      const receiptBytes = Buffer.from(runtime.generation.node_bootstrap_receipt_base64, "base64");
      const runnerIdentityEnvironmentNames = new Set([
        "AGENT_TEMPDIRECTORY",
        "BUILD_SOURCESDIRECTORY",
        "GITHUB_ACTION_PATH",
        "GITHUB_WORKSPACE",
        "HOME",
        "INIT_CWD",
        "RUNNER_TEMP",
        "RUNNER_TOOL_CACHE",
        "RUNNER_WORKSPACE",
        "TEMP",
        "TMP",
        "USER",
        "USERNAME",
        "USERPROFILE",
      ]);
      const envValues = Object.entries(process.env).flatMap(([name, value]) => {
        if (
          !runnerIdentityEnvironmentNames.has(name) ||
          typeof value !== "string" ||
          value.length < 4
        )
          return [];
        return [value, value.replaceAll("\\", "/")];
      });
      const userHome = process.env.USERPROFILE ?? process.env.HOME ?? "";
      const username = process.env.USERNAME ?? process.env.USER ?? "";
      const forbidden = [
        fixture.root,
        fixture.root.replaceAll("\\", "/"),
        process.cwd(),
        process.cwd().replaceAll("\\", "/"),
        join(fixture.root, "synthetic-home"),
        join(fixture.root, "synthetic-home").replaceAll("\\", "/"),
        userHome,
        userHome.replaceAll("\\", "/"),
        username,
        envSentinel,
        ...envValues,
      ];
      const producedBuffers = [...assetBuffers(outDir, fixture.tag), receiptBytes];
      expectBytesNotToContain(producedBuffers, forbidden);
      for (const bytes of producedBuffers) {
        expect(() =>
          expectBytesNotToContain(
            [Buffer.concat([bytes, Buffer.from(producerUsername, "utf8")])],
            forbidden,
          ),
        ).toThrow(`forbidden producer identity bytes: ${JSON.stringify(producerUsername)}`);
      }
      expect(existsSync(join(outDir, names.consumerRuntime))).toBe(true);
    } finally {
      delete process.env.UT_TDD_PACKRT_ENV_SENTINEL;
      if (priorUser === undefined) delete process.env.USER;
      else process.env.USER = priorUser;
      if (priorUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = priorUsername;
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("U-PACKRT-004: rejects a non-reviewed Node/npm generation and leaves zero assets", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "ut-tdd-packrt-004-node-"));
    try {
      await expect(
        packageFixture(outDir, {
          buildGeneration: fakeGenerationBuilder({ nodeVersion: "v24.12.0" }),
        }),
      ).rejects.toThrow("reviewed Node toolchain mismatch");
      expect(existsSync(outDir) ? readdirSync(outDir) : []).toEqual([]);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("U-PACKRT-004: rejects Node generation failure and leaves zero assets", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "ut-tdd-packrt-004-generation-"));
    try {
      await expect(
        packageFixture(outDir, { buildGeneration: fakeGenerationBuilder({ fail: true }) }),
      ).rejects.toThrow("injected Node generation failure");
      expect(readdirSync(outDir)).toEqual([]);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("U-PACKRT-004: rejects staged asset move failure and leaves zero assets", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "ut-tdd-packrt-004-move-"));
    try {
      await expect(
        packageFixture(outDir, {
          moveStagedAssets: () => {
            throw new Error("injected staged asset move failure");
          },
        }),
      ).rejects.toThrow("injected staged asset move failure");
      expect(existsSync(outDir) ? readdirSync(outDir) : []).toEqual([]);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe("Pack consumer runtime release installer", () => {
  let fixture: RuntimeInstallerFixture;

  beforeAll(async () => {
    fixture = await createRuntimeInstallerFixture();
  }, 120_000);

  afterAll(() => {
    if (fixture) removeInstallerFixtureTree(fixture.root);
  });

  it.each([
    ["canary", "v0.2.0-canary.2"],
    ["stable", "v0.2.0"],
  ])(
    "CANDIDATE-U-RELAGGV2-002: %s 完全inventoryを実producerから実installerへ渡す",
    async (channel, tag) => {
      const producer = await createProducerFixture(true, tag);
      const testCase = copyInstallerCase(fixture);
      try {
        // 既存の手作りinstaller documentを使わず、producerの全assetで置き換える。
        for (const name of readdirSync(testCase.releaseDir))
          unlinkSync(join(testCase.releaseDir, name));
        await packageConsumerRuntimeRelease({
          repoRoot: producer.root,
          tag: producer.tag,
          outDir: testCase.releaseDir,
          homeDirectory: join(producer.root, "synthetic-home"),
          installDependencies: () => undefined,
          buildGeneration: fakeGenerationBuilder({ compiledBytes: fixture.compiledBytes }),
        });
        const names = releaseArtifactFileNames(producer.tag);
        const document = validateConsumerRuntimeRelease(
          JSON.parse(readFileSync(join(testCase.releaseDir, names.consumerRuntime), "utf8")),
        );
        expect(
          document.admission_input.aggregate_input.final_tree.channelMappings.length,
        ).toBeGreaterThan(2);
        expect(document.admission_input.aggregate_input.channel).toBe(channel);
        const anchor = `sha256:${hashHex(readFileSync(join(testCase.releaseDir, names.consumerChecksum)))}`;
        const run = runInstallerIn(
          { ...fixture, tag },
          testCase.releaseDir,
          testCase.consumerRoot,
          anchor,
        );
        // runtime installは成功、その後の未束縛product identityは既存の正規deny。
        expectUnboundRepositorySetup(run);
        expect(
          existsSync(
            join(testCase.consumerRoot, ".ut-tdd", "runtime", "activation", "active.json"),
          ),
        ).toBe(true);
        const installed = consumerActivePointer(testCase.consumerRoot);
        expect(installed.bytes.length).toBeGreaterThan(0);
      } finally {
        removeInstallerFixtureTree(testCase.root);
        rmSync(producer.root, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it("U-PACKRT-005: installs from Release assets in a git-init-only consumer and runs offline", () => {
    expect(typeof Reflect.get(setupApi, "installConsumerRuntimeRelease")).toBe("function");
    expect(readdirSync(fixture.releaseDir).sort()).toEqual(
      Object.values(releaseArtifactFileNames(fixture.tag)).sort(),
    );
    const testCase = copyInstallerCase(fixture);
    try {
      expect(readdirSync(testCase.consumerRoot)).toEqual([".git"]);
      const run = runInstallerIn(
        fixture,
        testCase.releaseDir,
        testCase.consumerRoot,
        fixture.anchor,
      );
      expect(run.error?.message ?? "", "installer spawn").toBe("");
      expectUnboundRepositorySetup(run);
      expect(
        existsSync(join(testCase.consumerRoot, ".ut-tdd", "runtime", "activation", "active.json")),
      ).toBe(true);

      const launcher = join(testCase.consumerRoot, ".ut-tdd", "bin", "ut-tdd.mjs");
      const launchHelp = () =>
        spawnSync(process.execPath, [launcher, "--help"], {
          cwd: testCase.consumerRoot,
          encoding: "utf8",
          env: isolatedConsumerEnv(testCase.root),
          windowsHide: true,
          maxBuffer: 64 * 1024 * 1024,
        });
      const help = launchHelp();
      expect(help.status, `stdout:\n${help.stdout}\nstderr:\n${help.stderr}`).toBe(0);
      expect(help.stdout).toContain("Usage: ut-tdd");

      rmSync(testCase.releaseDir, { recursive: true, force: true });
      const offlineHelp = launchHelp();
      expect(
        offlineHelp.status,
        `stdout:\n${offlineHelp.stdout}\nstderr:\n${offlineHelp.stderr}`,
      ).toBe(0);
      expect(offlineHelp.stdout).toContain("Usage: ut-tdd");
    } finally {
      removeInstallerFixtureTree(testCase.root);
    }
  });

  it("U-PACKRT-005 supplement: generated launcher accepts a real Windows 8.3 consumer path", ({
    skip,
  }) => {
    if (process.platform !== "win32") {
      console.info("SKIP U-PACKRT-005 Windows 8.3 alias: Windows-only runtime coverage");
      skip();
    }
    const testCase = copyInstallerCase(fixture);
    try {
      const shortPathResult = spawnSync(
        process.env.ComSpec ?? "cmd.exe",
        ["/d", "/c", `for %I in ("${testCase.consumerRoot}") do @echo %~sI`],
        { encoding: "utf8", windowsVerbatimArguments: true, windowsHide: true },
      );
      if (shortPathResult.error) throw shortPathResult.error;
      expect(shortPathResult.status, shortPathResult.stderr).toBe(0);
      const shortRoot = shortPathResult.stdout.trim();
      const physicalRoot = realpathSync.native(testCase.consumerRoot);
      if (
        !shortRoot ||
        !isAbsolute(shortRoot) ||
        shortRoot.toLowerCase() === physicalRoot.toLowerCase()
      ) {
        console.info("SKIP U-PACKRT-005 Windows 8.3 alias: short names unavailable for fixture");
        skip();
      }
      expect(realpathSync.native(shortRoot).toLowerCase()).toBe(physicalRoot.toLowerCase());

      const install = runInstallerIn(
        fixture,
        testCase.releaseDir,
        testCase.consumerRoot,
        fixture.anchor,
      );
      expectUnboundRepositorySetup(install);
      const launcher = join(shortRoot, ".ut-tdd", "bin", "ut-tdd.mjs");
      const launch = spawnSync(process.execPath, [launcher, "--help"], {
        cwd: shortRoot,
        encoding: "utf8",
        env: isolatedConsumerEnv(testCase.root),
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
      });
      expect(launch.status, `stdout:\n${launch.stdout}\nstderr:\n${launch.stderr}`).toBe(0);
      expect(launch.stdout).toContain("Usage: ut-tdd");
    } finally {
      removeInstallerFixtureTree(testCase.root);
    }
  });

  it("U-PACKRT-005 supplement: generated launcher rejects a runtime-root junction outside the consumer", () => {
    const testCase = copyInstallerCase(fixture);
    try {
      const install = runInstallerIn(
        fixture,
        testCase.releaseDir,
        testCase.consumerRoot,
        fixture.anchor,
      );
      expectUnboundRepositorySetup(install);

      const runtimeRoot = join(testCase.consumerRoot, ".ut-tdd", "runtime");
      const outsideRuntime = join(testCase.root, "outside-runtime");
      makeInstallerFixtureWritable(dirname(runtimeRoot));
      renameSync(runtimeRoot, outsideRuntime);
      symlinkSync(outsideRuntime, runtimeRoot, process.platform === "win32" ? "junction" : "dir");

      const launcher = join(testCase.consumerRoot, ".ut-tdd", "bin", "ut-tdd.mjs");
      const launch = spawnSync(process.execPath, [launcher, "--help"], {
        cwd: testCase.consumerRoot,
        encoding: "utf8",
        env: isolatedConsumerEnv(testCase.root),
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
      });
      expect(launch.status, `stdout:\n${launch.stdout}\nstderr:\n${launch.stderr}`).toBe(78);
      expect(`${launch.stdout}\n${launch.stderr}`).toContain("consumer_runtime_external_path");
    } finally {
      removeInstallerFixtureTree(testCase.root);
    }
  });

  it("U-PACKRT-006: denies corrupted assets and non-exact two-line checksum records", () => {
    const names = releaseArtifactFileNames(fixture.tag);
    const checksumMutations = [
      "missing runtime line",
      "extra line",
      "reordered rows",
      "different filename",
    ] as const;
    for (const mutation of checksumMutations) {
      const testCase = copyInstallerCase(fixture);
      try {
        const checksumPath = join(testCase.releaseDir, names.consumerChecksum);
        const rows = readFileSync(checksumPath, "utf8").trimEnd().split("\n");
        const malformed =
          mutation === "missing runtime line"
            ? `${rows[0]}\n`
            : mutation === "extra line"
              ? `${rows.join("\n")}\n${"0".repeat(64)}  extra\n`
              : mutation === "reordered rows"
                ? `${rows.reverse().join("\n")}\n`
                : `${rows[0]}\n${rows[1]?.replace(names.consumerRuntime, "other.consumer-runtime.json")}\n`;
        writeFileSync(checksumPath, malformed, "utf8");
        const expectedAnchor = `sha256:${hashHex(Buffer.from(malformed, "utf8"))}`;
        const before = consumerTreeSnapshot(testCase.consumerRoot);
        const run = runInstallerIn(
          fixture,
          testCase.releaseDir,
          testCase.consumerRoot,
          expectedAnchor,
        );
        expect(run.status, `${mutation}: ${run.stderr}`).not.toBe(0);
        expect(`${run.stdout}\n${run.stderr}`).toContain("consumer_runtime_checksum_invalid");
        expect(consumerTreeSnapshot(testCase.consumerRoot)).toEqual(before);
      } finally {
        removeInstallerFixtureTree(testCase.root);
      }
    }

    for (const asset of [names.compiledEsm, names.consumerRuntime]) {
      const testCase = copyInstallerCase(fixture);
      try {
        const path = join(testCase.releaseDir, asset);
        const changed = Buffer.concat([readFileSync(path), Buffer.from("\n")]);
        writeFileSync(path, changed);
        const before = consumerTreeSnapshot(testCase.consumerRoot);
        const run = runInstallerIn(
          fixture,
          testCase.releaseDir,
          testCase.consumerRoot,
          fixture.anchor,
        );
        expect(run.status, `${asset}: ${run.stderr}`).not.toBe(0);
        expect(`${run.stdout}\n${run.stderr}`).toContain("consumer_runtime_digest_mismatch");
        expect(consumerTreeSnapshot(testCase.consumerRoot)).toEqual(before);
      } finally {
        removeInstallerFixtureTree(testCase.root);
      }
    }
  });

  it("U-PACKRT-007: verifies executed-module digest, PF-5 binding, and external anchor", () => {
    const selfMismatch = copyInstallerCase(fixture);
    try {
      const names = releaseArtifactFileNames(fixture.tag);
      const modulePath = join(selfMismatch.releaseDir, names.compiledEsm);
      const changedModule = Buffer.concat([
        readFileSync(modulePath),
        Buffer.from("\n// byte changed\n"),
      ]);
      writeFileSync(modulePath, changedModule);
      const runtimeBytes = readFileSync(join(selfMismatch.releaseDir, names.consumerRuntime));
      const checksum = Buffer.from(
        `${checksumLine(changedModule, names.compiledEsm)}${checksumLine(runtimeBytes, names.consumerRuntime)}`,
        "utf8",
      );
      writeFileSync(join(selfMismatch.releaseDir, names.consumerChecksum), checksum);
      const before = consumerTreeSnapshot(selfMismatch.consumerRoot);
      const run = runInstallerIn(
        fixture,
        selfMismatch.releaseDir,
        selfMismatch.consumerRoot,
        `sha256:${hashHex(checksum)}`,
      );
      expect(run.status, run.stderr).not.toBe(0);
      expect(`${run.stdout}\n${run.stderr}`).toContain("consumer_runtime_self_digest_mismatch");
      expect(consumerTreeSnapshot(selfMismatch.consumerRoot)).toEqual(before);
    } finally {
      removeInstallerFixtureTree(selfMismatch.root);
    }

    const pf5Mismatch = copyInstallerCase(fixture);
    try {
      const changedRuntime: ConsumerRuntimeRelease = {
        ...fixture.runtime,
        admission_input: {
          ...fixture.runtime.admission_input,
          aggregate_input: {
            ...fixture.runtime.admission_input.aggregate_input,
            attestation: {
              ...fixture.runtime.admission_input.aggregate_input.attestation,
              artifactSourceCommit: "f".repeat(40),
            },
          },
        },
      };
      const anchor = writeRuntimeInstallerAssets({
        releaseDir: pf5Mismatch.releaseDir,
        tag: fixture.tag,
        compiledBytes: fixture.compiledBytes,
        runtime: changedRuntime,
      });
      const before = consumerTreeSnapshot(pf5Mismatch.consumerRoot);
      const run = runInstallerIn(fixture, pf5Mismatch.releaseDir, pf5Mismatch.consumerRoot, anchor);
      expect(run.status, run.stderr).not.toBe(0);
      expect(`${run.stdout}\n${run.stderr}`).toContain(
        "consumer_runtime_schema_invalid:aggregate_digest_mismatch",
      );
      expect(consumerTreeSnapshot(pf5Mismatch.consumerRoot)).toEqual(before);
    } finally {
      removeInstallerFixtureTree(pf5Mismatch.root);
    }

    const receiptMismatch = copyInstallerCase(fixture);
    try {
      const changedRuntime: ConsumerRuntimeRelease = {
        ...fixture.runtime,
        generation: {
          ...fixture.runtime.generation,
          compiled_esm_digest: `sha256:${"0".repeat(64)}`,
        },
      };
      const anchor = writeRuntimeInstallerAssets({
        releaseDir: receiptMismatch.releaseDir,
        tag: fixture.tag,
        compiledBytes: fixture.compiledBytes,
        runtime: changedRuntime,
      });
      const before = consumerTreeSnapshot(receiptMismatch.consumerRoot);
      const run = runInstallerIn(
        fixture,
        receiptMismatch.releaseDir,
        receiptMismatch.consumerRoot,
        anchor,
      );
      expect(run.status, run.stderr).not.toBe(0);
      expect(`${run.stdout}\n${run.stderr}`).toContain("generation_receipt_mismatch");
      expect(consumerTreeSnapshot(receiptMismatch.consumerRoot)).toEqual(before);
    } finally {
      removeInstallerFixtureTree(receiptMismatch.root);
    }

    const coherentForgery = copyInstallerCase(fixture);
    try {
      const names = releaseArtifactFileNames(fixture.tag);
      const forgedModule = Buffer.concat([
        readFileSync(join(coherentForgery.releaseDir, names.compiledEsm)),
        Buffer.from("\n// coherent multi-asset forgery\n"),
      ]);
      const parsedReceipt = JSON.parse(
        Buffer.from(fixture.runtime.generation.node_bootstrap_receipt_base64, "base64").toString(
          "utf8",
        ),
      ) as Record<string, unknown>;
      const unsignedReceipt = { ...parsedReceipt };
      delete unsignedReceipt.receipt_digest;
      const priorCompiled = unsignedReceipt.compiled_cli as Record<string, unknown>;
      const forgedReceipt = sealReceipt({
        ...unsignedReceipt,
        compiled_cli: { ...priorCompiled, sha256: hashHex(forgedModule) },
      });
      const forgedRuntime: ConsumerRuntimeRelease = {
        ...fixture.runtime,
        generation: {
          ...fixture.runtime.generation,
          compiled_esm_digest: `sha256:${hashHex(forgedModule)}`,
          node_bootstrap_receipt_base64: forgedReceipt.toString("base64"),
        },
      };
      const forgedAnchor = writeRuntimeInstallerAssets({
        releaseDir: coherentForgery.releaseDir,
        tag: fixture.tag,
        compiledBytes: forgedModule,
        runtime: forgedRuntime,
      });
      const before = consumerTreeSnapshot(coherentForgery.consumerRoot);
      const trustedAnchor = runInstallerIn(
        fixture,
        coherentForgery.releaseDir,
        coherentForgery.consumerRoot,
        fixture.anchor,
      );
      expect(trustedAnchor.status, trustedAnchor.stderr).not.toBe(0);
      expect(`${trustedAnchor.stdout}\n${trustedAnchor.stderr}`).toContain(
        "consumer_runtime_anchor_mismatch",
      );
      expect(consumerTreeSnapshot(coherentForgery.consumerRoot)).toEqual(before);

      const forgedAnchorRun = runInstallerIn(
        fixture,
        coherentForgery.releaseDir,
        coherentForgery.consumerRoot,
        forgedAnchor,
      );
      expect(
        forgedAnchorRun.status,
        `stdout:\n${forgedAnchorRun.stdout}\nstderr:\n${forgedAnchorRun.stderr}`,
      ).toBe(2);
      expect(forgedAnchorRun.stderr).toContain("identity: denied (identity_repository_unbound)");
    } finally {
      removeInstallerFixtureTree(coherentForgery.root);
    }

    const anchorMutant = copyInstallerCase(fixture);
    try {
      const originalDigest = hashHex(fixture.compiledBytes);
      const compiledText = fixture.compiledBytes.toString("utf8");
      const anchorGuard =
        /if\s*\(\s*`sha256:\$\{digestHex\w*\(checksumBytes\)\}`\s*!==\s*input\.expectedConsumerDigest\s*\)/g;
      expect([...compiledText.matchAll(anchorGuard)]).toHaveLength(1);
      const mutantModule = Buffer.from(compiledText.replace(anchorGuard, "if (false)"));
      const unsignedReceipt = JSON.parse(
        Buffer.from(fixture.runtime.generation.node_bootstrap_receipt_base64, "base64").toString(
          "utf8",
        ),
      ) as Record<string, unknown>;
      delete unsignedReceipt.receipt_digest;
      const priorCompiled = unsignedReceipt.compiled_cli as Record<string, unknown>;
      const mutantReceipt = sealReceipt({
        ...unsignedReceipt,
        compiled_cli: { ...priorCompiled, sha256: hashHex(mutantModule) },
      });
      writeRuntimeInstallerAssets({
        releaseDir: anchorMutant.releaseDir,
        tag: fixture.tag,
        compiledBytes: mutantModule,
        runtime: {
          ...fixture.runtime,
          generation: {
            ...fixture.runtime.generation,
            compiled_esm_digest: `sha256:${hashHex(mutantModule)}`,
            node_bootstrap_receipt_base64: mutantReceipt.toString("base64"),
          },
        },
      });
      const bypass = runInstallerIn(
        fixture,
        anchorMutant.releaseDir,
        anchorMutant.consumerRoot,
        fixture.anchor,
      );
      expectUnboundRepositorySetup(bypass);
      expect(
        existsSync(join(anchorMutant.consumerRoot, ".ut-tdd/runtime/activation/active.json")),
      ).toBe(true);
      expect(hashHex(fixture.compiledBytes)).toBe(originalDigest);
      expect(
        hashHex(
          readFileSync(join(fixture.releaseDir, releaseArtifactFileNames(fixture.tag).compiledEsm)),
        ),
      ).toBe(originalDigest);
    } finally {
      removeInstallerFixtureTree(anchorMutant.root);
    }

    for (const anchor of [undefined, "sha256:ABCDEF", `sha256:${"0".repeat(64)}`]) {
      const testCase = copyInstallerCase(fixture);
      try {
        const before = consumerTreeSnapshot(testCase.consumerRoot);
        const run = runInstallerIn(fixture, testCase.releaseDir, testCase.consumerRoot, anchor);
        expect(run.status, run.stderr).not.toBe(0);
        expect(`${run.stdout}\n${run.stderr}`).toContain("consumer_runtime_anchor_mismatch");
        expect(consumerTreeSnapshot(testCase.consumerRoot)).toEqual(before);
      } finally {
        removeInstallerFixtureTree(testCase.root);
      }
    }
  });

  it("U-PACKRT-008: rejects missing, extra, or differently tagged Release assets before writes", () => {
    const names = releaseArtifactFileNames(fixture.tag);
    const mutations: readonly ((releaseDir: string) => void)[] = [
      (releaseDir) => rmSync(join(releaseDir, names.tarball)),
      (releaseDir) => writeFileSync(join(releaseDir, "unexpected.txt"), "extra"),
      (releaseDir) => writeFileSync(join(releaseDir, "v0.2.0-canary.3.ut-tdd.mjs"), "other tag"),
    ];
    for (const mutate of mutations) {
      const testCase = copyInstallerCase(fixture);
      try {
        mutate(testCase.releaseDir);
        const before = consumerTreeSnapshot(testCase.consumerRoot);
        const run = runInstallerIn(
          fixture,
          testCase.releaseDir,
          testCase.consumerRoot,
          fixture.anchor,
        );
        expect(run.status, run.stderr).not.toBe(0);
        expect(`${run.stdout}\n${run.stderr}`).toContain("consumer_runtime_asset_set_mismatch");
        expect(consumerTreeSnapshot(testCase.consumerRoot)).toEqual(before);
      } finally {
        removeInstallerFixtureTree(testCase.root);
      }
    }
  });

  it("U-PACKRT-009: canonicalizes receipt identity and makes committed reinstallation write-zero", () => {
    const testCase = copyInstallerCase(fixture);
    try {
      const aliasRoot = join(testCase.root, "consumer-alias");
      symlinkSync(
        testCase.consumerRoot,
        aliasRoot,
        process.platform === "win32" ? "junction" : "dir",
      );
      const first = runInstallerIn(fixture, testCase.releaseDir, aliasRoot, fixture.anchor);
      expectUnboundRepositorySetup(first);

      const pointer = consumerActivePointer(testCase.consumerRoot);
      const savedReceipt = JSON.parse(
        readFileSync(join(pointer.bundlePath, "consumer-receipt.json"), "utf8"),
      ) as { consumer: Record<string, unknown> };
      const canonicalRoot = realpathSync.native(testCase.consumerRoot);
      expect(savedReceipt.consumer).toMatchObject({
        consumerRoot: canonicalRoot,
        runtimeRoot: join(canonicalRoot, ".ut-tdd", "runtime"),
        productId: fixture.runtime.release.product_id,
      });

      const beforeRerun = consumerTreeSnapshot(testCase.consumerRoot);
      const rerun = runInstallerIn(
        fixture,
        testCase.releaseDir,
        testCase.consumerRoot,
        fixture.anchor,
      );
      expect(rerun.status, `stdout:\n${rerun.stdout}\nstderr:\n${rerun.stderr}`).toBe(0);
      expect(consumerTreeSnapshot(testCase.consumerRoot)).toEqual(beforeRerun);

      const copiedConsumer = join(testCase.root, "copied-consumer");
      cpSync(testCase.consumerRoot, copiedConsumer, { recursive: true });
      const beforeCopyRun = consumerTreeSnapshot(copiedConsumer);
      const copied = runInstallerIn(fixture, testCase.releaseDir, copiedConsumer, fixture.anchor);
      expect(copied.status, copied.stderr).not.toBe(0);
      expect(`${copied.stdout}\n${copied.stderr}`).toContain("consumer_runtime_receipt_mismatch");
      expect(consumerTreeSnapshot(copiedConsumer)).toEqual(beforeCopyRun);
    } finally {
      const aliasRoot = join(testCase.root, "consumer-alias");
      if (existsSync(aliasRoot)) unlinkSync(aliasRoot);
      removeInstallerFixtureTree(testCase.root);
    }
  });

  it("U-PACKRT-009: refuses to repair a changed active pointer or missing committed bundle payload", () => {
    const pointerCase = copyInstallerCase(fixture);
    try {
      const installed = runInstallerIn(
        fixture,
        pointerCase.releaseDir,
        pointerCase.consumerRoot,
        fixture.anchor,
      );
      expectUnboundRepositorySetup(installed);
      const pointer = consumerActivePointer(pointerCase.consumerRoot);
      const pointerMode = Number(statSync(pointer.path, { bigint: true }).mode & 0o777n);
      const value = JSON.parse(pointer.bytes.toString("utf8")) as { bundle_digest: string };
      const digestStart = "sha256:".length;
      const digestChar = value.bundle_digest[digestStart];
      value.bundle_digest = `${value.bundle_digest.slice(0, digestStart)}${digestChar === "0" ? "1" : "0"}${value.bundle_digest.slice(digestStart + 1)}`;
      chmodSync(pointer.path, pointerMode | 0o200);
      writeFileSync(pointer.path, `${JSON.stringify(value)}\n`);
      chmodSync(pointer.path, pointerMode);
      const before = consumerTreeSnapshot(pointerCase.consumerRoot);
      const run = runInstallerIn(
        fixture,
        pointerCase.releaseDir,
        pointerCase.consumerRoot,
        fixture.anchor,
      );
      expect(run.status, run.stderr).not.toBe(0);
      expect(`${run.stdout}\n${run.stderr}`).toContain("consumer_runtime_identity_mismatch");
      expect(consumerTreeSnapshot(pointerCase.consumerRoot)).toEqual(before);
    } finally {
      removeInstallerFixtureTree(pointerCase.root);
    }

    const missingBundle = copyInstallerCase(fixture);
    try {
      const installed = runInstallerIn(
        fixture,
        missingBundle.releaseDir,
        missingBundle.consumerRoot,
        fixture.anchor,
      );
      expectUnboundRepositorySetup(installed);
      const pointer = consumerActivePointer(missingBundle.consumerRoot);
      const bundleMode = Number(statSync(pointer.bundlePath, { bigint: true }).mode & 0o777n);
      const payload = join(pointer.bundlePath, "ut-tdd.mjs");
      chmodSync(pointer.bundlePath, bundleMode | 0o200);
      chmodSync(payload, Number(statSync(payload, { bigint: true }).mode & 0o777n) | 0o200);
      rmSync(payload);
      chmodSync(pointer.bundlePath, bundleMode);
      const before = consumerTreeSnapshot(missingBundle.consumerRoot);
      const run = runInstallerIn(
        fixture,
        missingBundle.releaseDir,
        missingBundle.consumerRoot,
        fixture.anchor,
      );
      expect(run.status, run.stderr).not.toBe(0);
      expect(`${run.stdout}\n${run.stderr}`).toContain("consumer_runtime_identity_mismatch");
      expect(consumerTreeSnapshot(missingBundle.consumerRoot)).toEqual(before);
    } finally {
      removeInstallerFixtureTree(missingBundle.root);
    }
  });

  it("U-PACKRT-010: denies a different Release tag without changing the active runtime", () => {
    const testCase = copyInstallerCase(fixture);
    try {
      const installed = runInstallerIn(
        fixture,
        testCase.releaseDir,
        testCase.consumerRoot,
        fixture.anchor,
      );
      expectUnboundRepositorySetup(installed);
      const before = consumerTreeSnapshot(testCase.consumerRoot);

      const nextTag = "v0.2.0-canary.3";
      const nextRelease = join(testCase.root, "next-release");
      mkdirSync(nextRelease);
      const nextRuntime: ConsumerRuntimeRelease = {
        ...fixture.runtime,
        release: { ...fixture.runtime.release, tag: nextTag },
      };
      const nextAnchor = writeRuntimeInstallerAssets({
        releaseDir: nextRelease,
        tag: nextTag,
        compiledBytes: fixture.compiledBytes,
        runtime: nextRuntime,
      });
      const nextFixture: RuntimeInstallerFixture = {
        ...fixture,
        releaseDir: nextRelease,
        tag: nextTag,
        anchor: nextAnchor,
        runtime: nextRuntime,
      };
      const update = runRuntimeInstaller(nextFixture, {
        releaseDir: nextRelease,
        consumerRoot: testCase.consumerRoot,
        anchor: nextAnchor,
      });
      expect(update.status, update.stderr).not.toBe(0);
      expect(`${update.stdout}\n${update.stderr}`).toContain("consumer_runtime_update_unsupported");
      expect(consumerTreeSnapshot(testCase.consumerRoot)).toEqual(before);
    } finally {
      removeInstallerFixtureTree(testCase.root);
    }
  });
});
