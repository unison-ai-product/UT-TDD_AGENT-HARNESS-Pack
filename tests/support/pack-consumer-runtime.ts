import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { resolveLiveClaudeTarget } from "../../src/runtime/claude-memory-wake.ts";
import { buildNodeGeneration } from "../../src/runtime/node-bootstrap.ts";
import {
  deriveArtifactInventoryDigest,
  deriveReleaseId,
  deriveReleaseRecordDigest,
} from "../../src/schema/release-manifest.ts";
import { digestConsumerRuntimeBytes } from "../../src/setup/consumer-node-runtime.ts";
import {
  buildCleanDistributionPlan,
  cleanDistributionSourcePath,
  transformCleanDistributionArtifact,
} from "../../src/setup/distribution.ts";
import { derivePackPublicationAssets } from "../../src/setup/pack-publication-assets.ts";
import { buildPackPublicationStagingPlan } from "../../src/setup/pack-publication-staging.ts";
import { digestMaterializedReleaseEntries } from "../../src/setup/release-materializer.ts";
import { headSnapshotRoot } from "./workspace-roots.ts";

export const fixtureRoots: string[] = [];
const wakeProcesses: ReturnType<typeof spawn>[] = [];

export function removeFixtureTree(path: string): void {
  try {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      chmodSync(path, 0o755);
      for (const name of readdirSync(path)) removeFixtureTree(join(path, name));
    } else chmodSync(path, 0o644);
  } catch {
    return;
  }
  rmSync(path, { recursive: true, force: true });
}

export function stopConsumerWakeProcesses(): void {
  for (const child of wakeProcesses.splice(0)) {
    if (!child.killed) child.kill();
  }
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function walk(root: string): string[] {
  const ignored = new Set([".git", "node_modules", "dist"]);
  const paths: string[] = [];
  const visit = (directory: string, prefix = ""): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) paths.push(relative.replaceAll("\\", "/"));
    }
  };
  visit(root);
  return paths.sort();
}

export function createCleanPack(
  repository = "unison-ai-product/UT-TDD_AGENT-HARNESS-Pack",
): string {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-pack-parity-pack-"));
  fixtureRoots.push(root);
  const sourceRoot = headSnapshotRoot();
  const sourcePaths = walk(sourceRoot);
  const plan = buildCleanDistributionPlan({ paths: sourcePaths, sourceTag: "v0.2.0-canary.1" });
  if (!plan.ok) throw new Error(JSON.stringify(plan));
  for (const artifactPath of plan.artifactPaths) {
    const sourcePath = cleanDistributionSourcePath(artifactPath, sourcePaths);
    const from = join(sourceRoot, sourcePath);
    const to = join(root, artifactPath);
    mkdirSync(dirname(to), { recursive: true });
    if (artifactPath === "package.json") {
      writeFileSync(
        to,
        transformCleanDistributionArtifact(artifactPath, readFileSync(from, "utf8")),
      );
    } else cpSync(from, to, { recursive: true });
  }
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "UT-TDD Pack parity"]);
  git(root, ["config", "core.autocrlf", "false"]);
  git(root, ["remote", "add", "origin", `git@github.com:${repository}.git`]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "test: materialize clean Pack"]);
  return root;
}

export function createConsumerProject(repository: string): string {
  // PLAN-L7-628 §6.2: consumer_root は 8.3 alias を解決した canonical path で記録する。
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ut-tdd-pack-parity-consumer-")));
  fixtureRoots.push(root);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "UT-TDD Pack consumer"]);
  git(root, ["config", "core.autocrlf", "false"]);
  git(root, ["remote", "add", "origin", `git@github.com:${repository}.git`]);
  writeFileSync(join(root, "README.md"), "# consumer\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-qm", "test: materialize consumer project"]);
  return root;
}

function installDependencies(root: string): void {
  const result =
    process.platform === "win32"
      ? spawnSync(
          join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"),
          ["/d", "/c", "npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
          { cwd: root, encoding: "utf8", timeout: 300_000 },
        )
      : spawnSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
          cwd: root,
          encoding: "utf8",
          timeout: 300_000,
        });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
}

export async function writeConsumerRuntimeInput(
  packRoot: string,
  consumerRoot: string,
): Promise<string> {
  const checkout = mkdtempSync(join(tmpdir(), "ut-tdd-pack-parity-producer-"));
  fixtureRoots.push(checkout);
  installDependencies(packRoot);
  // The clean Pack deliberately excludes governance provenance. Build the
  // producer bytes from the detached execution snapshot (where npm deps are
  // installed), then feed them to the Pack setup CLI as release materializer
  // input. This is strictly pre-boundary fixture construction.
  const producerRoot = process.cwd();
  const subjectRevision = git(producerRoot, ["rev-parse", "HEAD"]);
  const generation = await buildNodeGeneration({
    repoRoot: producerRoot,
    outputRoot: checkout,
    candidateRevision: subjectRevision,
  });
  const sealedRoot = join(checkout, "sealed-generation");
  mkdirSync(sealedRoot, { recursive: true });
  cpSync(generation.compiledCliPath, join(sealedRoot, "ut-tdd.mjs"));
  cpSync(join(generation.generationPath, "receipt.json"), join(sealedRoot, "receipt.json"));
  removeFixtureTree(generation.generationPath);
  const compiledEsm = readFileSync(join(sealedRoot, "ut-tdd.mjs"));
  const receiptBytes = readFileSync(join(sealedRoot, "receipt.json"));
  const receipt = JSON.parse(receiptBytes.toString("utf8")) as {
    generation_id: string;
    subject_revision: string;
    node: { version: string; sha256: string };
    package_lock_sha256: string;
    source_graph_sha256: string;
    compiled_cli: { sha256: string };
  };
  const entry = { path: "src/entry.ts", mode: "100644" as const, content: compiledEsm };
  const artifactSetDigest = digestMaterializedReleaseEntries([entry]);
  const releaseId = deriveReleaseId("1", receipt.subject_revision, artifactSetDigest);
  const publicationEntry = {
    sourcePath: "releases/stable/entry.ts",
    destinationPath: entry.path,
    mode: entry.mode,
    size: entry.content.length,
    contentDigest: digestConsumerRuntimeBytes(entry.content),
    content: entry.content,
  };
  const publicationArtifacts = [
    {
      sourcePath: publicationEntry.sourcePath,
      destinationPath: publicationEntry.destinationPath,
      mode: publicationEntry.mode,
      size: publicationEntry.size,
      contentDigest: publicationEntry.contentDigest,
    },
  ];
  const publicationBase = {
    materializerVersion: "1",
    artifactSourceCommit: receipt.subject_revision,
    artifactSetDigest,
    artifactInventoryDigest: deriveArtifactInventoryDigest(publicationArtifacts),
    releaseAssetInventoryDigest: `sha256:${"0".repeat(64)}`,
    releaseRecordDigest: `sha256:${"0".repeat(64)}`,
    artifacts: publicationArtifacts,
  };
  const publicationAssets = derivePackPublicationAssets({
    release: { releaseId, ...publicationBase },
    entries: [publicationEntry],
  });
  if (!publicationAssets.ok) throw new Error(publicationAssets.error);
  const publicationRelease = {
    ...publicationBase,
    releaseAssetInventoryDigest: publicationAssets.value.releaseAssetInventoryDigest,
  };
  const manifest = {
    schema_version: "v2" as const,
    releases: {
      [releaseId]: {
        ...publicationRelease,
        releaseRecordDigest: deriveReleaseRecordDigest(publicationRelease),
      },
    },
    channels: { canary: releaseId, stable: releaseId },
    channelOrder: ["canary", "stable"],
  };
  const controlManifestBytes = Buffer.from(stringify(manifest), "utf8");
  const publicationPlan = buildPackPublicationStagingPlan({
    manifestInput: manifest,
    releaseId,
    controlManifestBytes,
    entries: [publicationEntry],
  });
  if (!publicationPlan.ok) throw new Error(publicationPlan.error);
  const aggregateInput = {
    repository: "unison-ai-product/UT-TDD_AGENT-HARNESS-Pack",
    channel: "stable",
    final_tree: {
      manifestEntries: [{ path: "release/manifest.yaml", value: manifest }],
      sourcePaths: ["releases/stable/entry.ts"],
      cleanPackAllowlist: ["release/manifest.yaml", entry.path],
      channelMappings: [
        {
          channel: "stable",
          releaseId,
          sourceRevision: receipt.subject_revision,
          sourcePath: "releases/stable/entry.ts",
          destinationPath: entry.path,
        },
      ],
    },
    attestation: {
      status: "attested",
      releaseId,
      artifactSourceCommit: receipt.subject_revision,
      expectedDigest: artifactSetDigest,
      actualDigest: artifactSetDigest,
      entries: [
        { path: entry.path, mode: entry.mode, content_base64: compiledEsm.toString("base64") },
      ],
    },
  };
  const runtimeRoot = join(consumerRoot, ".ut-tdd", "runtime");
  const identity = {
    product_id: "ut-tdd",
    consumer_root: consumerRoot,
    runtime_root: runtimeRoot,
    operation_id: "pack-parity-install",
    attempt: 0,
    generation_id: receipt.generation_id,
    subject_revision: receipt.subject_revision,
    artifact_digest: `sha256:${"1".repeat(64)}`,
    node_executable_identity: `node-${receipt.node.version}|sha256:${receipt.node.sha256}`,
    package_lock_digest: `sha256:${receipt.package_lock_sha256}`,
    source_graph_digest: `sha256:${receipt.source_graph_sha256}`,
    compiled_esm_digest: digestConsumerRuntimeBytes(compiledEsm),
    release_id: releaseId,
    materializer_version: "1",
    artifact_set_digest: artifactSetDigest,
    control_manifest_digest: publicationPlan.plan.controlManifestSnapshotDigest,
    sealed_policy: "compiled-esm-only" as const,
  };
  const input = {
    identity,
    admission_input: {
      productId: "ut-tdd",
      consumerRoot: consumerRoot,
      runtimeRoot,
      manifest: {
        materializerVersion: "1",
        releaseId,
        sourceRevision: receipt.subject_revision,
        artifactSetDigest,
      },
      receipt: {
        materializerVersion: "1",
        releaseId,
        sourceRevision: receipt.subject_revision,
        artifactSetDigest,
        productId: "ut-tdd",
        consumerRoot,
        runtimeRoot,
      },
      aggregate_input: aggregateInput,
      control_manifest_base64: controlManifestBytes.toString("base64"),
    },
    compiled_esm_base64: compiledEsm.toString("base64"),
    node_bootstrap_receipt_base64: receiptBytes.toString("base64"),
  };
  const inputPath = join(consumerRoot, "consumer-runtime-input.json");
  writeFileSync(inputPath, `${JSON.stringify(input)}\n`);
  return inputPath;
}

export function setupConsumerFromPack(packRoot: string, consumerRoot: string, inputPath: string) {
  const run = spawnSync(
    process.execPath,
    [join(packRoot, "src", "cli.ts"), "setup", "--solo", "--consumer-runtime-input", inputPath],
    {
      cwd: consumerRoot,
      encoding: "utf8",
      timeout: 300_000,
      windowsHide: true,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: consumerRoot,
        UT_TDD_PROJECT_DIR: consumerRoot,
        UT_TDD_SKIP_UPDATE_CHECK: "1",
      },
    },
  );
  if (run.status !== 0) throw new Error(`${run.stdout}\n${run.stderr}`);
  git(consumerRoot, ["add", "ut-tdd.project.json"]);
  git(consumerRoot, ["commit", "-qm", "test: commit consumer project identity"]);
  return run;
}

export function runConsumer(
  consumerRoot: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
) {
  return spawnSync(
    process.execPath,
    [join(consumerRoot, ".ut-tdd", "bin", "ut-tdd.mjs"), ...args],
    {
      cwd: tmpdir(),
      encoding: "utf8",
      timeout: 120_000,
      windowsHide: true,
      env: {
        ...process.env,
        ...env,
        CLAUDE_PROJECT_DIR: consumerRoot,
        UT_TDD_PROJECT_DIR: consumerRoot,
        UT_TDD_SKIP_UPDATE_CHECK: "1",
      },
    },
  );
}

export function startConsumerWake(consumerRoot: string, sessionId: string) {
  const child = spawn(
    process.execPath,
    [join(consumerRoot, ".ut-tdd", "bin", "ut-tdd.mjs"), "hook", "claude-memory-wake"],
    {
      cwd: tmpdir(),
      env: {
        ...process.env,
        CLAUDE_CODE_ENTRYPOINT: "claude-vscode",
        CLAUDE_PROJECT_DIR: consumerRoot,
        UT_TDD_PROJECT_DIR: consumerRoot,
        UT_TDD_CLAUDE_WAKE_POLL_MS: "10",
        UT_TDD_CLAUDE_WAKE_MAX_MS: "30000",
        UT_TDD_SKIP_UPDATE_CHECK: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  wakeProcesses.push(child);
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
  child.stdin.end(JSON.stringify({ hook_event_name: "Stop", session_id: sessionId }));
  return {
    child,
    result: new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
      child.once("close", (code) =>
        resolve({ code, stdout: stdout.join(""), stderr: stderr.join("") }),
      ),
    ),
  };
}

export async function waitForConsumerWakeTarget(consumerRoot: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    // A generation marker is the first activation write, not the readiness
    // boundary.  Stopping the fixture process after that marker but before its
    // capability and authority records are durable leaves a valid-looking
    // marker which must correctly fail closed at the consumer boundary.  Wait
    // for the same complete authority resolution used by production instead.
    if (resolveLiveClaudeTarget(consumerRoot).ok) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("consumer_claude_wake_target_not_live");
}
