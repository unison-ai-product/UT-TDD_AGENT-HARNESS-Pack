import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";
import { TRACKED_RECEIPT_SCHEMA } from "../../src/plan-admission/tracked-receipt-projection.ts";
import {
  deriveArtifactInventoryDigest,
  deriveReleaseId,
  deriveReleaseRecordDigest,
  parsePublicationManifest,
} from "../../src/schema/release-manifest.ts";
import {
  buildCleanDistributionPlan,
  cleanDistributionSourcePath,
  digestConsumerRuntimeBytes,
  releaseArtifactFileNames,
  transformCleanDistributionArtifact,
} from "../../src/setup/index.ts";
import {
  createLocalGitObjectReader,
  resolveReleaseArtifacts,
} from "../../src/setup/release-artifact-resolver.ts";
import { materializeReleaseArtifacts } from "../../src/setup/release-materializer.ts";
import { removeTestTree } from "./temp-tree.ts";

export const CANARY_FIXTURE_TAG = "v0.0.0-canary.0";
export const CANARY_ASSET_NAMES = Object.values(
  releaseArtifactFileNames(CANARY_FIXTURE_TAG),
).sort();

const SOURCE_ROOT = realpathSync.native(process.cwd());
const SKILLS_BASELINE = ["skills/SKILL_MAP.md", "skills/review-checklist.yaml"] as const;

export interface CanaryFixture {
  readonly root: string;
  readonly producerRoot: string;
  readonly releaseDir: string;
  readonly consumerRoot: string;
  readonly alternateCwd: string;
  readonly anchor: string;
  readonly wrapper: string;
  readonly planTemplate: string;
}

export interface CanaryReviewStubPaths {
  readonly ghBin: string;
  readonly ghTracePath: string;
  readonly ghNodeOptions: string;
  readonly claudeCommand: string;
  readonly claudeMarkerPath: string;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function trackedPaths(): string[] {
  return execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", "HEAD"], {
    cwd: SOURCE_ROOT,
    encoding: "buffer",
    windowsHide: true,
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function materializeProducerRoot(root: string): void {
  const paths = trackedPaths();
  const plan = buildCleanDistributionPlan({ paths, sourceTag: CANARY_FIXTURE_TAG });
  if (!plan.ok) throw new Error(`clean distribution plan denied: ${JSON.stringify(plan)}`);

  for (const artifactPath of plan.artifactPaths) {
    const sourcePath = join(SOURCE_ROOT, cleanDistributionSourcePath(artifactPath, paths));
    const destination = join(root, artifactPath);
    mkdirSync(dirname(destination), { recursive: true });
    if (artifactPath === "package.json") {
      writeFileSync(
        destination,
        transformCleanDistributionArtifact(artifactPath, readFileSync(sourcePath, "utf8")),
        "utf8",
      );
    } else {
      cpSync(sourcePath, destination, { recursive: true, errorOnExist: true });
    }
  }

  // These are explicit tagged-source build inputs, not Pack entries or runtime fallbacks.
  for (const sourcePath of [
    "docs/governance/node-toolchain-provenance.json",
    "tsconfig.node.json",
  ]) {
    const destination = join(root, sourcePath);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(SOURCE_ROOT, sourcePath), destination);
  }
  const sourceTreePaths = trackedPaths();
  const vmodelBuildInputs = sourceTreePaths.filter(
    (path) =>
      path === "docs/governance/vmodel-document-catalog.md" ||
      (path.startsWith("docs/templates/vmodel/") &&
        path.endsWith(".md") &&
        !path.startsWith("docs/templates/vmodel/review-examples/")),
  );
  if (vmodelBuildInputs.length === 0)
    throw new Error("tracked Node build input inventory is empty");
  for (const path of vmodelBuildInputs) {
    if (!sourceTreePaths.includes(path)) throw new Error(`untracked Node build input: ${path}`);
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(SOURCE_ROOT, path), destination);
  }

  mkdirSync(join(root, "releases", "canary"), { recursive: true });
  writeFileSync(join(root, "releases", "canary", "entry.ts"), "export const fixture = true;\n");
}

async function createReleaseManifest(root: string, artifactCommit: string): Promise<void> {
  const resolved = await resolveReleaseArtifacts(
    {
      repository: root,
      release: {
        releaseId: `rel-sha256:${"0".repeat(64)}`,
        materializerVersion: "1",
        artifactSourceCommit: artifactCommit,
        artifactSetDigest: `sha256:${"0".repeat(64)}`,
      },
    },
    { git: createLocalGitObjectReader(), materialize: materializeReleaseArtifacts },
  );
  if (!resolved.ok) throw new Error(`fixture artifact resolution failed: ${resolved.error}`);

  // Inventory every materialized entry from the selected Git commit. A one-entry
  // manifest can package successfully but cannot admit the complete Pack at setup.
  const sourcePaths = git(root, ["ls-tree", "-r", "--name-only", "-z", artifactCommit])
    .split("\0")
    .filter(Boolean);
  const trackedSources = new Set(sourcePaths);
  const artifacts = resolved.entries.map((entry) => {
    if (entry.mode === "120000")
      throw new Error(`fixture inventory forbids symlink: ${entry.path}`);
    if (!trackedSources.has(entry.path))
      throw new Error(`fixture artifact source missing: ${entry.path}`);
    return {
      // C1 is already a clean Pack: use its exact tracked path, not a source
      // adapter mapping that aliases two destinations to the same template.
      sourcePath: entry.path,
      destinationPath: entry.path,
      mode: entry.mode,
      size: entry.content.length,
      contentDigest: digestConsumerRuntimeBytes(entry.content),
    };
  });
  const base = {
    materializerVersion: "1",
    artifactSourceCommit: artifactCommit,
    artifactSetDigest: resolved.digest,
    artifactInventoryDigest: deriveArtifactInventoryDigest(artifacts),
    releaseAssetInventoryDigest: `sha256:${"c".repeat(64)}`,
    artifacts,
  };
  const releaseId = deriveReleaseId("1", artifactCommit, resolved.digest);
  const manifest = {
    schema_version: "v2" as const,
    releases: {
      [releaseId]: { ...base, releaseRecordDigest: deriveReleaseRecordDigest(base) },
    },
    channels: { canary: releaseId, stable: releaseId },
    channelOrder: ["canary", "stable"],
  };
  mkdirSync(join(root, "release"), { recursive: true });
  if (!parsePublicationManifest(manifest).ok)
    throw new Error("fixture publication manifest invalid");
  writeFileSync(join(root, "release", "manifest.yaml"), stringify(manifest), "utf8");
}

function runNpmCi(cwd: string): void {
  const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
  const args =
    process.platform === "win32"
      ? ["/d", "/c", "npm", "ci", "--no-audit", "--no-fund"]
      : ["ci", "--no-audit", "--no-fund"];
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 300_000,
    env: { ...process.env, UT_TDD_SKIP_UPDATE_CHECK: "1" },
  });
  if (result.error || result.status !== 0)
    throw new Error(`npm ci failed: ${result.error?.message ?? result.stderr ?? result.stdout}`);
}

function assertFixtureTree(root: string): void {
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      const info = lstatSync(child);
      // Do not follow a symlink/junction while checking our owned tree. `rmSync` unlinks it as
      // an entry; it never recursively traverses the target.
      if (info.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(child);
    }
  };
  visit(root);
}

function makeFixtureDirectoriesWritable(root: string): void {
  if (process.platform === "win32") return;
  const visit = (path: string): void => {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return;
    if (!info.isDirectory()) return;
    chmodSync(path, info.mode | 0o700);
    for (const entry of readdirSync(path, { withFileTypes: true }))
      if (entry.isDirectory()) visit(join(path, entry.name));
  };
  visit(root);
}

export function removeCanaryFixtureTree(root: string): void {
  const target = resolve(root);
  const relativeRoot = relative(resolve(tmpdir()), target);
  if (
    !relativeRoot ||
    relativeRoot === ".." ||
    relativeRoot.startsWith(`..${sep}`) ||
    dirname(relativeRoot) !== "." ||
    !basename(relativeRoot).startsWith("ut-tdd-packcanary-pr1-")
  )
    throw new Error("canary fixture cleanup target is outside its owned temporary root");
  assertFixtureTree(target);
  makeFixtureDirectoriesWritable(target);
  removeTestTree(target);
}

export function removeCanaryFixtureChild(root: string, child: string): void {
  const base = resolve(root);
  const target = resolve(child);
  if (dirname(target) !== base) throw new Error("canary cleanup child escapes its test root");
  if (existsSync(target)) {
    assertFixtureTree(target);
    makeFixtureDirectoriesWritable(target);
    removeTestTree(target);
  }
}

export function canarySkillsBaselineErrors(paths: readonly string[]): string[] {
  return SKILLS_BASELINE.flatMap((requiredPath) => {
    const count = paths.filter((path) => path === requiredPath).length;
    if (count === 0) return [`missing:${requiredPath}`];
    if (count > 1) return [`duplicate:${requiredPath}`];
    return [];
  });
}

/** Pre-installer fixture admission: exact tag and exact producer output names only. */
export function selectExactCanaryAssets(tag: string, actualNames: readonly string[]): string[] {
  if (tag !== CANARY_FIXTURE_TAG) throw new Error("canary_fixture_tag_mismatch");
  const names = [...actualNames].sort();
  if (JSON.stringify(names) !== JSON.stringify(CANARY_ASSET_NAMES))
    throw new Error("consumer_runtime_asset_set_mismatch");
  return names;
}

export function runNode(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  input?: string,
  timeoutMs = 120_000,
) {
  return spawnSync(process.execPath, [...args], {
    cwd,
    encoding: "utf8",
    env,
    input,
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function isolatedCanaryEnv(root: string): NodeJS.ProcessEnv {
  const home = join(root, "home");
  for (const directory of [
    home,
    join(root, "appdata"),
    join(root, "localappdata"),
    join(root, "codex-home"),
  ])
    mkdirSync(directory, { recursive: true });
  const pathSeparator = process.platform === "win32" ? ";" : ":";
  const basePath = process.env.PATH?.split(pathSeparator).filter((item) => item.length > 0) ?? [];
  return {
    PATH: basePath.join(pathSeparator),
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(root, "appdata"),
    LOCALAPPDATA: join(root, "localappdata"),
    UT_TDD_SKIP_UPDATE_CHECK: "1",
    CLAUDE_PROJECT_DIR: undefined,
    UT_TDD_PROJECT_DIR: undefined,
    CODEX_HOME: join(root, "codex-home"),
    PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
  };
}

/** Closed GH executable: copied Node starts a loader which handles only exact local argv. */
export function createCanaryReviewStubs(root: string, head: string): CanaryReviewStubPaths {
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("canary_review_head_invalid");
  const bin = join(root, "review-bin");
  mkdirSync(bin, { recursive: true });
  const ghExecutable = join(bin, process.platform === "win32" ? "gh.exe" : "gh");
  copyFileSync(process.execPath, ghExecutable);
  if (process.platform !== "win32") chmodSync(ghExecutable, 0o755);

  const ghTracePath = join(root, "closed-gh-argv.jsonl");
  const ghLoader = join(root, "closed-gh.mjs");
  writeFileSync(
    ghLoader,
    `import fs from "node:fs";
import path from "node:path";
const executable = path.basename(process.execPath).toLowerCase();
if (executable === "gh" || executable === "gh.exe") {
  const argv = process.argv.slice(1);
  const tracePath = ${JSON.stringify(ghTracePath)};
  const expectedHead = ${JSON.stringify(head)};
  if (argv[0] === path.resolve(process.cwd(), "pr")) argv[0] = "pr";
  const record = (response = "", code = 0) => {
    fs.appendFileSync(tracePath, JSON.stringify(argv) + "\\n");
    if (response) fs.writeSync(1, response);
    process.exit(code);
  };
  const exact = (...expected) => argv.length === expected.length && expected.every((value, index) => argv[index] === value);
  if (exact("pr", "view", "418", "--json", "headRefOid", "--jq", ".headRefOid")) record(expectedHead + "\\n");
  if (exact("pr", "view", "418", "--json", "headRefOid,state,statusCheckRollup")) record(JSON.stringify({ headRefOid: expectedHead, state: "OPEN", statusCheckRollup: [{ conclusion: "SUCCESS" }] }) + "\\n");
  if (argv.length === 5 && argv[0] === "pr" && argv[1] === "comment" && argv[2] === "418" && argv[3] === "--body" && new RegExp("^PR #418 exact HEAD " + expectedHead + " のcanonical review receipt。\\\\nverdict=PASS blocking=0\\\\nreviewRevision=rv1-[a-f0-9]{64}\\\\nreviewerFamily=claude\\\\nreceiptDigest=[a-f0-9]{64}$").test(argv[4])) record();
  if (exact("pr", "merge", "418", "--merge", "--match-head-commit", expectedHead)) record();
  record(JSON.stringify({ denied: true, argv }) + "\\n", 2);
}
`,
    "utf8",
  );

  const claudeHelper = join(root, "closed-claude-provider.cjs");
  const claudeMarkerPath = join(root, "closed-claude-provider-invoked.log");
  writeFileSync(
    claudeHelper,
    `const fs = require("node:fs");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync(process.env.CANARY_CLAUDE_MARKER, "invoked\\n");
  const fields = ["schema_version", "request_digest", "attempt", "pr", "exact_head", "review_revision", "reviewer_provider", "reviewer_model", "invocation_nonce"].map((key) => {
    const match = prompt.match(new RegExp("^" + key + ":\\\\s*(.*)$", "m"));
    if (!match || !match[1].trim()) process.exit(2);
    return key + ": " + match[1].trim();
  }).join("\\n");
  const verdictFile = process.env.UT_TDD_REVIEW_VERDICT_FILE;
  if (!verdictFile) process.exit(2);
  fs.writeFileSync(verdictFile, fields + "\\nVERDICT: PASS\\n", "utf8");
  process.stdout.write("VERDICT: PASS\\n");
});
`,
    "utf8",
  );
  const claudeCommand = join(bin, process.platform === "win32" ? "claude.cmd" : "claude");
  writeFileSync(
    claudeCommand,
    process.platform === "win32"
      ? `@echo off\r\nif "%~1"=="--version" (echo claude 0.0.0-canary& exit /b 0)\r\nnode "${claudeHelper}"\r\nexit /b %ERRORLEVEL%\r\n`
      : `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "claude 0.0.0-canary"; exit 0; fi\nexec node "${claudeHelper}"\n`,
    process.platform === "win32" ? "utf8" : { encoding: "utf8", mode: 0o755 },
  );
  return {
    ghBin: bin,
    ghTracePath,
    ghNodeOptions: `--import=${pathToFileURL(ghLoader).href}`,
    claudeCommand,
    claudeMarkerPath,
  };
}

export interface CanaryReviewRequest {
  readonly memoryId: string;
  readonly pr: number;
  readonly exactHead: string;
  readonly reviewRevision: string;
  readonly authorFamily: "codex" | "claude";
  readonly requestedAt: string;
}

/** A typed wake input for the no-live-workspace backlog lane; request remains CLI-produced. */
export function writeCanaryReviewEnvelope(input: {
  readonly consumerRoot: string;
  readonly requestDigest: string;
  readonly request: CanaryReviewRequest;
  readonly memoryPath: string;
}): string {
  if (!/^[a-f0-9]{64}$/.test(input.requestDigest))
    throw new Error("canary_review_request_digest_invalid");
  const envelopePath = join(input.consumerRoot, ".ut-tdd", "review", "canary-review-envelope.json");
  mkdirSync(dirname(envelopePath), { recursive: true });
  const envelope = {
    schemaVersion: "ut-tdd.claude-inbox/v3",
    purpose: "review",
    id: `${input.request.memoryId}:canary-review`,
    memoryId: input.request.memoryId,
    body: "Consume the canonical canary review request.",
    originRuntime: "codex",
    operationId: `canary-review-${input.requestDigest.slice(0, 16)}`,
    targetWorkspaceId: "f".repeat(64),
    createdAt: input.request.requestedAt,
    requestDigest: input.requestDigest,
    requestPath: `.ut-tdd/review/requests/${input.requestDigest}.json`,
    memoryPath: input.memoryPath,
    pr: input.request.pr,
    exactHead: input.request.exactHead,
    reviewRevision: input.request.reviewRevision,
    authorFamily: input.request.authorFamily,
  };
  writeFileSync(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  return envelopePath;
}

export async function createCanaryFixture(): Promise<CanaryFixture> {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-packcanary-pr1-"));
  try {
    const producerRoot = join(root, "producer");
    const releaseDir = join(root, "release");
    const consumerRoot = join(root, "consumer");
    const alternateCwd = join(root, "alternate-cwd");
    mkdirSync(producerRoot, { recursive: true });
    mkdirSync(releaseDir, { recursive: true });
    mkdirSync(consumerRoot, { recursive: true });
    mkdirSync(alternateCwd, { recursive: true });

    materializeProducerRoot(producerRoot);
    git(producerRoot, ["init", "--quiet"]);
    git(producerRoot, ["config", "user.email", "test@example.invalid"]);
    git(producerRoot, ["config", "user.name", "UT canary fixture"]);
    git(producerRoot, ["remote", "add", "origin", "https://github.com/example/consumer.git"]);
    git(producerRoot, ["add", "--", "."]);
    git(producerRoot, ["commit", "--quiet", "-m", "fixture artifact"]);
    const artifactCommit = git(producerRoot, ["rev-parse", "HEAD"]);
    await createReleaseManifest(producerRoot, artifactCommit);
    git(producerRoot, ["add", "--", "release/manifest.yaml"]);
    git(producerRoot, ["commit", "--quiet", "-m", "release manifest"]);
    git(producerRoot, ["tag", CANARY_FIXTURE_TAG]);

    runNpmCi(producerRoot);
    const producer = runNode(
      producerRoot,
      [
        "src/cli.ts",
        "distribution",
        "package",
        "--tag",
        CANARY_FIXTURE_TAG,
        "--out",
        releaseDir,
        "--json",
      ],
      isolatedCanaryEnv(root),
      undefined,
      // The real producer performs a second isolated npm ci from the tagged Git tree.
      // Keep a finite bound, but do not apply the short CLI bound to that nested build.
      300_000,
    );
    if (producer.status !== 0)
      throw new Error(
        `distribution package failed: ${JSON.stringify({
          status: producer.status,
          signal: producer.signal,
          error: producer.error
            ? {
                name: producer.error.name,
                message: producer.error.message,
                code: (producer.error as NodeJS.ErrnoException).code,
              }
            : null,
          stdout: producer.stdout.slice(-4000),
          stderr: producer.stderr.slice(-4000),
        })}`,
      );
    const result = JSON.parse(producer.stdout) as { ok?: boolean; sourceRevision?: string };
    if (!result.ok || result.sourceRevision !== artifactCommit)
      throw new Error(`unexpected producer result: ${producer.stdout}`);
    selectExactCanaryAssets(CANARY_FIXTURE_TAG, readdirSync(releaseDir));

    const checksumBytes = readFileSync(join(releaseDir, `${CANARY_FIXTURE_TAG}.consumer.sha256`));
    const anchor = `sha256:${createHash("sha256").update(checksumBytes).digest("hex")}`;
    const names = releaseArtifactFileNames(CANARY_FIXTURE_TAG);
    const wrapper = join(releaseDir, names.compiledEsm);
    const planTemplate = execFileSync(
      "tar",
      // The deterministic Pack serializer stores the canonical destinationPath
      // without a leading `./`.
      ["-xOf", names.tarball, "docs/templates/plan/design/template.md"],
      { cwd: releaseDir, encoding: "utf8", windowsHide: true },
    );
    if (!planTemplate.includes("kind: design")) throw new Error("shipped PLAN template is missing");
    return {
      root,
      producerRoot,
      releaseDir,
      consumerRoot,
      alternateCwd,
      anchor,
      wrapper,
      planTemplate,
    };
  } catch (error) {
    removeCanaryFixtureTree(root);
    throw error;
  }
}

/** Author a consumer-owned draft from the actual shipped template; receipts are CLI-produced. */
export function writeCanaryPlanManifest(fixture: CanaryFixture): {
  manifest: string;
  planPath: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(fixture.planTemplate);
  if (!match) throw new Error("shipped PLAN template frontmatter is invalid");
  const planId = "PLAN-L2-999-canary-authoring";
  const frontmatter = {
    ...parse(match[1]),
    plan_id: planId,
    title: "Canary consumer の設計起票",
    drive: "agent",
    created: "2026-09-29",
    owner: "Canary consumer",
    route_signal: "forward",
    route_mode: "forward",
    sub_doc: "screen-list",
    generates: [],
    related_docs: [],
  };
  const body = match[2].replaceAll(
    "(本 PLAN でどの範囲の設計を凍結するかを 1-2 段落で記述)",
    "配布された PLAN テンプレートから consumer 固有の draft を正規 CLI で起票する。",
  );
  const planPath = `docs/plans/${planId}.md`;
  const manifest = join(fixture.consumerRoot, "canary-plan-draft.json");
  const projection = "docs/governance/plan-admission-receipts.json";
  // The product repository owns its PLAN directory; the Pack does not ship
  // source-side PLAN files into a fresh consumer.
  mkdirSync(join(fixture.consumerRoot, "docs", "plans"), { recursive: true });
  mkdirSync(join(fixture.consumerRoot, "docs", "governance"), { recursive: true });
  // Empty fixture ledger projection, never an authored PASS/admission receipt.
  writeFileSync(
    join(fixture.consumerRoot, projection),
    JSON.stringify({ schema_version: TRACKED_RECEIPT_SCHEMA, records: [] }),
  );
  writeFileSync(
    manifest,
    JSON.stringify({
      version: 2,
      command_id: "canary:plan-authoring",
      plan_id: planId,
      recorded_at: "2026-09-29T00:00:00.000Z",
      admission: {
        route_signal: "forward",
        route_mode: "forward",
        kind: "design",
        layer: "L2",
        drive: "agent",
        branch: "work/forward-canary",
        status: "draft",
        sub_doc: "screen-list",
      },
      source: { path: planPath, content: `---\n${stringify(frontmatter)}---\n${body}` },
      projection: { path: projection },
    }),
  );
  return { manifest, planPath };
}

export function installCanaryFixture(fixture: CanaryFixture, env: NodeJS.ProcessEnv) {
  return runNode(
    fixture.consumerRoot,
    [
      fixture.wrapper,
      "setup",
      "--solo",
      "--consumer-runtime-release",
      fixture.releaseDir,
      "--expected-consumer-digest",
      fixture.anchor,
    ],
    env,
  );
}

export function setupSourcePaths(fixture: CanaryFixture): string[] {
  return [fixture.producerRoot, fixture.releaseDir].map((path) => resolve(path));
}

export function observedForbiddenPaths(fixture: CanaryFixture): string[] {
  return [SOURCE_ROOT, ...setupSourcePaths(fixture)];
}

export function countAbsolutePathReferences(
  root: string,
  needlePaths: readonly string[],
): string[] {
  const findings: string[] = [];
  const needles = needlePaths.map((path) => path.replaceAll("\\", "/").toLowerCase());
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const bytes = readFileSync(path);
        if (bytes.includes(0)) continue;
        // JSON escapes Windows separators twice; collapse each run to one
        // separator before comparing it with the canonical needle.
        const content = bytes.toString("utf8").replaceAll(/\\+/g, "/").toLowerCase();
        for (const needle of needles)
          if (content.includes(needle)) findings.push(`${path}:${needle}`);
      }
    }
  };
  visit(root);
  return findings;
}

export function writeAccessTrace(
  root: string,
  watchedPaths: readonly string[],
): {
  readonly nodeOptions: string;
  readonly logPath: string;
} {
  const logPath = join(root, "denied-path-access.jsonl");
  const tracePath = join(root, "access-trace.mjs");
  const source = `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const watched = ${JSON.stringify(watchedPaths.map((path) => resolve(path).replaceAll("\\", "/").toLowerCase()))};
const log = ${JSON.stringify(logPath)};
const pathText = (value) => typeof value === "string" ? value.replaceAll("\\\\", "/").toLowerCase() : String(value);
for (const name of ["access", "accessSync", "existsSync", "open", "openSync", "readFile", "readFileSync", "stat", "statSync", "lstat", "lstatSync", "realpath", "realpathSync", "createReadStream"]) {
  const original = fs[name];
  if (typeof original !== "function") continue;
  const wrapped = function(path, ...args) {
    const candidate = pathText(path);
    if (watched.some((value) => candidate === value || candidate.startsWith(value + "/"))) fs.appendFileSync(log, JSON.stringify({ api: name, path: candidate }) + "\\n");
    return original.call(this, path, ...args);
  };
  if (typeof original.native === "function") wrapped.native = function(path, ...args) {
    const candidate = pathText(path);
    if (watched.some((value) => candidate === value || candidate.startsWith(value + "/"))) fs.appendFileSync(log, JSON.stringify({ api: name + ".native", path: candidate }) + "\\n");
    return original.native.call(original, path, ...args);
  };
  fs[name] = wrapped;
}
syncBuiltinESMExports();
for (const name of ["access", "open", "readFile", "stat", "lstat", "realpath"]) {
  const original = fs.promises[name];
  if (typeof original !== "function") continue;
  fs.promises[name] = async function(path, ...args) {
    const candidate = pathText(path);
    if (watched.some((value) => candidate === value || candidate.startsWith(value + "/"))) fs.appendFileSync(log, JSON.stringify({ api: "promises." + name, path: candidate }) + "\\n");
    return original.call(this, path, ...args);
  };
}
`;
  writeFileSync(tracePath, source, "utf8");
  return { nodeOptions: `--import=${pathToFileURL(tracePath).href}`, logPath };
}
