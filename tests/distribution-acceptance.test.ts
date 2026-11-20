import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { collectDistributionCandidatePaths } from "../src/cli/distribution.ts";
import { CODEX_GIT_ROOT_PREFIX } from "../src/lint/hook-invocation.ts";
import {
  deriveArtifactInventoryDigest,
  deriveReleaseId,
  deriveReleaseRecordDigest,
} from "../src/schema/release-manifest.ts";
import {
  buildCleanDistributionPlan,
  cleanDistributionSourcePath,
  digestConsumerRuntimeBytes,
  gitAddPathspecCommands,
  materializeReleaseArtifacts,
  transformCleanDistributionArtifact,
} from "../src/setup/index.ts";
import { derivePackPublicationAssets } from "../src/setup/pack-publication-assets.ts";
import {
  createLocalGitObjectReader,
  resolveReleaseArtifacts,
} from "../src/setup/release-artifact-resolver.ts";
import * as privacyHome from "./support/privacy-denylist-home.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const repoRoot = process.cwd();

function walkCandidatePaths(root: string): string[] {
  const ignored = new Set([".git", "node_modules", "dist"]);
  const out: string[] = [];
  const walk = (dir: string, prefix = ""): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else {
        out.push(rel.replace(/\\/g, "/"));
      }
    }
  };
  walk(root);
  return out.sort();
}

function runNode(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    env,
    timeout: 300_000,
  });
}

function runGit(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

// Issue #506: node-toolchain equivalent of `bun install --frozen-lockfile` /
// `bun run <script>` for the clean-distribution fixture (npm ci / npm run).
function runNpm(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  if (process.platform === "win32") {
    const cmdExe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
    return spawnSync(cmdExe, ["/d", "/c", "npm", ...args], {
      cwd,
      encoding: "utf8",
      env,
      timeout: 300_000,
    });
  }
  return spawnSync("npm", args, { cwd, encoding: "utf8", env, timeout: 300_000 });
}

function runBareUtTdd(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  if (process.platform === "win32") {
    const cmdExe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
    return spawnSync(cmdExe, ["/d", "/c", "ut-tdd", ...args], {
      cwd,
      encoding: "utf8",
      env,
      timeout: 120_000,
    });
  }
  return spawnSync("ut-tdd", args, { cwd, encoding: "utf8", env, timeout: 120_000 });
}

function writeFakeCodex(root: string): string {
  const binDir = join(root, ".fake-bin");
  mkdirSync(binDir, { recursive: true });
  if (process.platform === "win32") {
    const path = join(binDir, "codex.cmd");
    writeFileSync(path, "@echo off\r\necho codex 0.0.0\r\nexit /b 0\r\n", "utf8");
    return path;
  }
  const path = join(binDir, "codex");
  writeFileSync(path, "#!/bin/sh\necho codex 0.0.0\nexit 0\n", { encoding: "utf8", mode: 0o755 });
  return path;
}

function writeLocalUtTddShim(root: string): string {
  const binDir = join(root, ".fake-bin");
  mkdirSync(binDir, { recursive: true });
  if (process.platform === "win32") {
    const path = join(binDir, "ut-tdd.cmd");
    writeFileSync(path, '@echo off\r\nnode "%~dp0..\\src\\cli.ts" %*\r\n', "utf8");
    return path;
  }
  const path = join(binDir, "ut-tdd");
  writeFileSync(path, '#!/bin/sh\nexec node "$(dirname "$0")/../src/cli.ts" "$@"\n', {
    encoding: "utf8",
    mode: 0o755,
  });
  chmodSync(path, 0o755);
  return path;
}

const removeCleanRoot = removeTestTree;

interface Candidate009RawGitEntry {
  readonly path: string;
  readonly mode: string;
  readonly bytes: Buffer;
}

function readCandidate009HeadTree(root: string): Map<string, Candidate009RawGitEntry> {
  const records = execFileSync("git", ["ls-tree", "-r", "-z", "--full-tree", "HEAD"], {
    cwd: root,
    encoding: "buffer",
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const treeEntries = records.map((record) => {
    const match = /^(\d{6}) blob ([a-f0-9]{40})\t(.+)$/.exec(record);
    if (!match) throw new Error(`unexpected raw Git tree record: ${record}`);
    return { mode: match[1], objectId: match[2], path: match[3] };
  });
  const objectIds = [...new Set(treeEntries.map((entry) => entry.objectId))];
  const batch = objectIds.length
    ? execFileSync("git", ["cat-file", "--batch"], {
        cwd: root,
        input: Buffer.from(`${objectIds.join("\n")}\n`, "ascii"),
        encoding: "buffer",
        maxBuffer: 256 * 1024 * 1024,
      })
    : Buffer.alloc(0);
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
    if (!Number.isSafeInteger(size) || contentEnd >= batch.length || batch[contentEnd] !== 0x0a)
      throw new Error(`invalid raw Git batch blob size or delimiter: ${header}`);
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
  const entries = new Map<string, Candidate009RawGitEntry>();
  for (const entry of treeEntries) {
    const bytes = blobs.get(entry.objectId);
    if (!bytes) throw new Error(`raw Git batch blob missing: ${entry.objectId}`);
    entries.set(entry.path, { path: entry.path, mode: entry.mode, bytes });
  }
  return entries;
}

function candidate009Hash(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function createCleanDistributionFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-distribution-integrity-"));
  const sourcePaths = walkCandidatePaths(repoRoot);
  const plan = buildCleanDistributionPlan({ paths: sourcePaths, sourceTag: "v0.0.0-test" });
  for (const rel of plan.artifactPaths) {
    const from = join(repoRoot, cleanDistributionSourcePath(rel, sourcePaths));
    const to = join(root, rel);
    mkdirSync(dirname(to), { recursive: true });
    if (rel === "package.json") {
      writeFileSync(to, transformCleanDistributionArtifact(rel, readFileSync(from, "utf8")));
    } else {
      cpSync(from, to, { recursive: true });
    }
  }
  return root;
}

describe("clean distribution local acceptance smoke", () => {
  it("source candidates use the HEAD tree and exclude untracked allowed-prefix files", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-distribution-candidates-"));
    try {
      mkdirSync(join(root, "scripts"), { recursive: true });
      writeFileSync(join(root, "scripts", "tracked.ts"), "export {}\n", "utf8");
      writeFileSync(join(root, "scripts", "untracked.ts"), "secret workspace state\n", "utf8");
      runGit(root, ["init", "--quiet"]);
      runGit(root, ["config", "user.email", "test@example.invalid"]);
      runGit(root, ["config", "user.name", "UT test"]);
      runGit(root, ["add", "scripts/tracked.ts"]);
      runGit(root, ["commit", "--quiet", "-m", "fixture"]);

      expect(collectDistributionCandidatePaths(root)).toEqual(["scripts/tracked.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("Git work trees without a committed HEAD fail closed instead of using workspace files", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-distribution-unborn-head-"));
    try {
      mkdirSync(join(root, "scripts"), { recursive: true });
      writeFileSync(join(root, "scripts", "untracked.ts"), "workspace state\n", "utf8");
      runGit(root, ["init", "--quiet"]);

      expect(() => collectDistributionCandidatePaths(root)).toThrow(
        "Git work tree has no readable HEAD tree",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("clean unpacked trees use the filesystem candidate fallback without Git HEAD", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-distribution-clean-tree-"));
    try {
      mkdirSync(join(root, "scripts"), { recursive: true });
      writeFileSync(join(root, "scripts", "pack-entry.js"), "console.log('ok')\n", "utf8");
      expect(collectDistributionCandidatePaths(root)).toEqual(["scripts/pack-entry.js"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("PLAN-L7-413 D-1: sync-stage is idempotent when the outDir already has its manifest", () => {
    const cleanRoot = createCleanDistributionFixture();
    const stageDir = join(cleanRoot, ".stage");
    try {
      const args = [
        join(repoRoot, "src", "cli.ts"),
        "distribution",
        "sync-stage",
        "--tag",
        "v0.0.0-test",
        "--out",
        stageDir,
        "--json",
      ];
      const first = runNode(cleanRoot, args);
      expect(first.status, first.stderr || first.stdout).toBe(0);
      const second = runNode(cleanRoot, args);
      expect(second.status, second.stderr || second.stdout).toBe(0);
      expect(JSON.parse(second.stdout).ok).toBe(true);
    } finally {
      removeCleanRoot(cleanRoot);
    }
  }, 120_000);

  it("PLAN-L7-413 D-2: denied 入力は出荷集合へ決して到達しない (構造 fence)", () => {
    // deny 対象 (allow 外・allow 内 carve-out の両方) は excludedPaths 行きで、
    // artifactPaths / violation には現れない。violation は出力ガード (include filter 退行
    // や remap の denied 空間衝突時のみ fire) — 入力に denied があるだけでは blocked に
    // ならない (full repo walk は denied 常在のため、恒常 blocked は誤 fail-close)。
    const plan = buildCleanDistributionPlan({
      paths: [
        "README.md",
        "LICENSE",
        "package.json",
        "src/cli.ts",
        ".ut-tdd/x",
        "docs/plans/x.md",
        "src/web/leak.ts",
      ],
    });
    expect(plan.denylistViolations).toEqual([]);
    for (const denied of [".ut-tdd/x", "docs/plans/x.md", "src/web/leak.ts"]) {
      expect(plan.artifactPaths).not.toContain(denied);
      expect(plan.excludedPaths).toContain(denied);
    }
  });

  it("PLAN-L7-413 D-3: deletion paths are staged by generated Pack commands", () => {
    const commands = gitAddPathspecCommands("C:/pack", ["README.md"], ["obsolete.txt"]);
    expect(commands.join("\n")).toContain('git -C C:/pack rm --ignore-unmatch -- "obsolete.txt"');
  });

  it("PLAN-L7-413 D-4: a blocked export neither packages nor prunes", () => {
    privacyHome.stubSyntheticPrivacyHome();
    const cleanRoot = createCleanDistributionFixture();
    const releaseDir = join(cleanRoot, ".release");
    try {
      // blocked は missingRequired で誘発する (denied 入力は D-2 followup により通常除外で
      // あって blocked にならないため)。
      rmSync(join(cleanRoot, "LICENSE"), { force: true });
      const cli = (...args: string[]) =>
        runNode(cleanRoot, [join(repoRoot, "src", "cli.ts"), "distribution", ...args]);
      const result = cli("package", "--tag", "v0.0.0-blocked", "--out", releaseDir, "--json");
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).ok).toBe(false);
      expect(existsSync(join(releaseDir, "v0.0.0-blocked.tar.gz"))).toBe(false);

      const packDir = join(cleanRoot, ".pack");
      mkdirSync(packDir, { recursive: true });
      const obsolete = join(packDir, "obsolete.txt");
      writeFileSync(obsolete, "must not be pruned\n", "utf8");
      const pack = cli("sync-pack", "--repo-dir", packDir, "--prune-local", "--json");
      expect(pack.status).toBe(1);
      expect(JSON.parse(pack.stdout).pack.prunedPaths).toEqual([]);
      expect(existsSync(obsolete)).toBe(true);
    } finally {
      removeCleanRoot(cleanRoot);
    }
  }, 120_000);

  it("U-PACKRT-011 / U-SETUP-013 / U-SETUP-014 / AT-DIST-001: clean artifact installs and exposes the same core CLI surfaces", async () => {
    const sourcePlan = buildCleanDistributionPlan({
      paths: walkCandidatePaths(repoRoot),
      sourceTag: "v0.1.0",
    });
    const plan = buildCleanDistributionPlan({
      paths: sourcePlan.artifactPaths,
      sourceTag: "v0.1.0",
    });
    expect(plan.ok).toBe(true);
    expect(plan.missingRequired).toEqual([]);
    expect(plan.denylistViolations).toEqual([]);

    // PLAN-L7-628: the producer builds from tagged source, independently of
    // the unchanged clean tarball. PR-2c adds tracked text-loader build inputs.
    const vmodelBuildInputs = execFileSync(
      "git",
      [
        "ls-files",
        "-z",
        "--",
        "docs/templates/vmodel",
        "docs/governance/vmodel-document-catalog.md",
      ],
      { cwd: repoRoot, encoding: "utf8" },
    )
      .split("\0")
      .filter(
        (path) =>
          path === "docs/governance/vmodel-document-catalog.md" ||
          (path.startsWith("docs/templates/vmodel/") &&
            path.endsWith(".md") &&
            !path.startsWith("docs/templates/vmodel/review-examples/")),
      );
    expect(vmodelBuildInputs.length).toBeGreaterThan(0);

    const cleanRoot = mkdtempSync(join(tmpdir(), "ut-tdd-clean-acceptance-"));
    const injectedHome = mkdtempSync(join(tmpdir(), "ut-tdd-acceptance-home-"));
    privacyHome.writeSyntheticPrivacyDenylist(injectedHome);
    try {
      const sourcePaths = walkCandidatePaths(repoRoot);
      for (const rel of plan.artifactPaths) {
        const from = join(repoRoot, cleanDistributionSourcePath(rel, sourcePaths));
        const to = join(cleanRoot, rel);
        mkdirSync(dirname(to), { recursive: true });
        if (rel === "package.json") {
          writeFileSync(to, transformCleanDistributionArtifact(rel, readFileSync(from, "utf8")));
        } else {
          cpSync(from, to, { recursive: true });
        }
      }
      // Node generation の sealed receipt は、clean Pack の出荷集合からは除外される
      // governance provenance を source checkout 側で照合する。tagged source fixture
      // にはその既存 artifact だけを追加し、tar の clean artifact 集合には入れない。
      const provenance = "docs/governance/node-toolchain-provenance.json";
      const provenancePath = join(cleanRoot, provenance);
      mkdirSync(dirname(provenancePath), { recursive: true });
      cpSync(join(repoRoot, provenance), provenancePath);
      cpSync(join(repoRoot, "tsconfig.node.json"), join(cleanRoot, "tsconfig.node.json"));
      for (const path of vmodelBuildInputs) {
        const destination = join(cleanRoot, path);
        mkdirSync(dirname(destination), { recursive: true });
        cpSync(join(repoRoot, path), destination);
      }

      // PR-1 の package は、workspace の現在状態ではなく実在 tag が指す
      // release revision C2 を入力にする。C1 は artifact source、C2 は
      // release/manifest.yaml だけを追加した release commit として作る。
      const fixtureArtifact = Buffer.from("export const fixture = true;\n", "utf8");
      mkdirSync(join(cleanRoot, "releases", "canary"), { recursive: true });
      writeFileSync(join(cleanRoot, "releases", "canary", "entry.ts"), fixtureArtifact);
      runGit(cleanRoot, ["init", "--quiet"]);
      runGit(cleanRoot, ["config", "user.email", "test@example.invalid"]);
      runGit(cleanRoot, ["config", "user.name", "UT test"]);
      runGit(cleanRoot, ["remote", "add", "origin", "https://github.com/example/consumer.git"]);
      runGit(cleanRoot, ["add", "--", "."]);
      runGit(cleanRoot, ["commit", "--quiet", "-m", "fixture artifact"]);
      const trackedBuildInputs = execFileSync("git", ["ls-files", "-z"], {
        cwd: cleanRoot,
        encoding: "utf8",
      }).split("\0");
      for (const path of vmodelBuildInputs) expect(trackedBuildInputs).toContain(path);
      const artifactCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: cleanRoot,
        encoding: "utf8",
      }).trim();
      const resolved = await resolveReleaseArtifacts(
        {
          repository: cleanRoot,
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
      const artifactSetDigest = resolved.digest;
      const publicationArtifacts = resolved.entries.map((item) => {
        if (item.mode !== "100644" && item.mode !== "100755")
          throw new Error("publication fixture mode is not supported");
        return {
          sourcePath: item.path,
          destinationPath: item.path,
          mode: item.mode,
          size: item.content.length,
          contentDigest: digestConsumerRuntimeBytes(item.content),
        };
      });
      const publicationBase = {
        materializerVersion: "1",
        artifactSourceCommit: artifactCommit,
        artifactSetDigest,
        artifactInventoryDigest: deriveArtifactInventoryDigest(publicationArtifacts),
        releaseAssetInventoryDigest: `sha256:${"c".repeat(64)}`,
        artifacts: publicationArtifacts,
      };
      const releaseId = deriveReleaseId("1", artifactCommit, artifactSetDigest);
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
      mkdirSync(join(cleanRoot, "release"), { recursive: true });
      writeFileSync(join(cleanRoot, "release", "manifest.yaml"), stringify(manifest), "utf8");
      runGit(cleanRoot, ["add", "--", "release/manifest.yaml"]);
      runGit(cleanRoot, ["commit", "--quiet", "-m", "release manifest"]);
      const releaseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: cleanRoot,
        encoding: "utf8",
      }).trim();
      runGit(cleanRoot, ["tag", "v0.0.0-accept"]);
      expect(
        execFileSync("git", ["rev-parse", "--verify", "refs/tags/v0.0.0-accept^{commit}"], {
          cwd: cleanRoot,
          encoding: "utf8",
        }).trim(),
      ).toMatch(/^[a-f0-9]{40}$/);

      const fakeCodex = writeFakeCodex(cleanRoot);
      writeLocalUtTddShim(cleanRoot);
      const env = {
        ...process.env,
        UT_TDD_CODEX_BIN: fakeCodex,
        // PLAN-L7-362: staged root には cache が無いため、status の update-check advisory が
        // 実 remote へ問い合わせないよう opt-out する (テスト決定論)。
        UT_TDD_SKIP_UPDATE_CHECK: "1",
        HOME: injectedHome,
        USERPROFILE: injectedHome,
        PATH: `${join(cleanRoot, ".fake-bin")}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
      };

      const install = runNpm(cleanRoot, ["ci", "--no-audit", "--no-fund"], env);
      expect(install.status, install.stderr || install.stdout).toBe(0);
      const tagAfterInstall = runNode(
        cleanRoot,
        [
          "-e",
          "const { spawnSync } = require('node:child_process'); const r = spawnSync('git', ['rev-parse', '--verify', 'refs/tags/v0.0.0-accept^{commit}'], { encoding: 'utf8' }); process.stdout.write(JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr }));",
        ],
        env,
      );
      expect(tagAfterInstall.status, tagAfterInstall.stderr || tagAfterInstall.stdout).toBe(0);
      expect(JSON.parse(tagAfterInstall.stdout).stdout.trim()).toMatch(/^[a-f0-9]{40}$/);
      const packPackageJson = JSON.parse(readFileSync(join(cleanRoot, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      };
      expect(packPackageJson.scripts.test).toBe("npm run test:pack");
      expect(packPackageJson.scripts["test:pack"]).toContain("scripts/run-vitest-snapshot.ts");
      expect(packPackageJson.scripts["test:pack"]).toContain(
        "tests/distribution-acceptance.test.ts",
      );
      expect(packPackageJson.scripts["test:source"]).toBe("npm run test:vitest-snapshot");

      const status = runNode(cleanRoot, ["src/cli.ts", "status", "--json"], env);
      expect(status.status, status.stderr || status.stdout).toBe(0);
      const statusJson = JSON.parse(status.stdout);
      expect(statusJson.availableRuntimes).toContain("codex");

      const bareStatus = runBareUtTdd(cleanRoot, ["status", "--json"], env);
      expect(bareStatus.status, bareStatus.stderr || bareStatus.stdout).toBe(0);
      expect(JSON.parse(bareStatus.stdout).availableRuntimes).toContain("codex");

      const codexHooks = JSON.parse(
        readFileSync(join(cleanRoot, "docs/templates/adapter/.codex/hooks.json"), "utf8"),
      ) as {
        hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
      };
      expect(codexHooks.hooks.PreToolUse).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            matcher: "spawn_agent|spawn_agents_on_csv",
            hooks: [
              expect.objectContaining({
                command: `node "${CODEX_GIT_ROOT_PREFIX}.ut-tdd/bin/ut-tdd.mjs" hook agent-guard`,
              }),
            ],
          }),
          expect.objectContaining({
            matcher: "apply_patch|write_file",
            hooks: [
              expect.objectContaining({
                command: `node "${CODEX_GIT_ROOT_PREFIX}.ut-tdd/bin/ut-tdd.mjs" hook work-guard`,
              }),
            ],
          }),
        ]),
      );

      // S1-a readiness must observe the real Node runtime. Running this command
      // through Bun would expose Bun's compatibility value as process.versions.node
      // and would keep the retired Bun launcher on the acceptance path.
      const distribution = runNode(
        cleanRoot,
        ["src/cli.ts", "distribution", "plan", "--tag", "v0.1.0", "--json"],
        env,
      );
      // A clean export has no consumer-local sealed runtime yet.  The
      // distribution surface remains usable, but readiness must fail closed
      // until setup admits and publishes that runtime.
      expect(distribution.status, distribution.stderr || distribution.stdout).toBe(0);
      const distributionJson = JSON.parse(distribution.stdout);
      expect(distributionJson).toMatchObject({
        ok: false,
        export: {
          ok: true,
          missingRequired: [],
          denylistViolations: [],
        },
        readiness: {
          ok: false,
        },
      });
      expect(distributionJson.readiness.checks).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "ut-tdd-cli", ok: false })]),
      );
      expect(distributionJson.export.artifactPaths).toContain("src/cli.ts");
      expect(distributionJson.export.artifactPaths).toContain("CHANGELOG.md");
      expect(distributionJson.export.artifactPaths).toContain("package-lock.json");
      expect(distributionJson.export.artifactPaths).not.toContain("bun.lock");
      expect(distributionJson.export.artifactPaths).toContain("skills/SKILL_MAP.md");
      expect(distributionJson.export.artifactPaths).not.toContain("docs/skills/SKILL_MAP.md");
      expect(distributionJson.export.artifactPaths).toContain(
        "docs/templates/adapter/.codex/hooks.json",
      );
      expect(distributionJson.export.artifactPaths).toContain(
        "docs/templates/adapter/.claude/commands/build.md",
      );
      expect(distributionJson.export.artifactPaths).not.toContain(
        "docs/plans/PLAN-L7-157-distribution-clean-pull.md",
      );
      // A-172 review B 項目: 参照ゼロの孤立旧構想 doc (v1.1) は clean 配布に載せない
      // (PLAN-RECOVERY-06 同時修正、allowlist から除外)。
      expect(distributionJson.export.artifactPaths).not.toContain(
        "docs/governance/ai-dev-team-concept_v1.1.md",
      );
      expect(distributionJson.export.artifactPaths).not.toContain(
        "docs/governance/ai-dev-team-operations_v1.1.md",
      );
      expect(distributionJson.actualCutRequiresPoApproval).toBe(true);

      // PLAN-L7-361: package の tar は相対 -f + cwd 固定で bsdtar/GNU tar 両対応 (絶対
      // Windows パスは GNU tar が remote host 解釈)。実 tarball の生成と exit 契約を固定。
      const releaseDir = join(cleanRoot, ".ut-tdd", "release-accept");
      const pkg = runNode(
        cleanRoot,
        [
          "src/cli.ts",
          "distribution",
          "package",
          "--tag",
          "v0.0.0-accept",
          "--out",
          releaseDir,
          "--json",
        ],
        env,
      );
      expect(pkg.status, pkg.stderr || pkg.stdout).toBe(0);
      const pkgJson = JSON.parse(pkg.stdout);
      expect(pkgJson.ok).toBe(true);
      expect(pkgJson.sourceRevision).toBe(artifactCommit);
      expect(pkgJson.sourceRevision).not.toBe(releaseCommit);
      expect(readdirSync(releaseDir).sort()).toEqual([
        "v0.0.0-accept.consumer-runtime.json",
        "v0.0.0-accept.consumer.sha256",
        "v0.0.0-accept.tar.gz",
        "v0.0.0-accept.tar.gz.sha256",
        "v0.0.0-accept.ut-tdd.mjs",
      ]);
      expect(existsSync(join(releaseDir, "v0.0.0-accept.tar.gz"))).toBe(true);
      expect(existsSync(join(releaseDir, "v0.0.0-accept.tar.gz.sha256"))).toBe(true);
      const runtime = JSON.parse(
        readFileSync(join(releaseDir, "v0.0.0-accept.consumer-runtime.json"), "utf8"),
      ) as {
        release: {
          tag: string;
          source_revision: string;
          materializer_version: string;
          product_id: string;
        };
        generation: { subject_revision: string };
        admission_input: { aggregate_input: { attestation: { artifactSourceCommit: string } } };
      };
      expect(runtime.release).toEqual({
        tag: "v0.0.0-accept",
        source_revision: artifactCommit,
        materializer_version: "1",
        product_id: "ut-tdd",
      });
      expect(runtime.generation.subject_revision).toBe(artifactCommit);
      expect(runtime.admission_input.aggregate_input.attestation.artifactSourceCommit).toBe(
        artifactCommit,
      );

      const setup = runNode(cleanRoot, ["src/cli.ts", "setup", "--solo"], env);
      expect(setup.status, setup.stderr || setup.stdout).toBe(0);

      const wrapperHelp = runNode(cleanRoot, [".ut-tdd/bin/ut-tdd.mjs", "--help"], env);
      expect(wrapperHelp.status, wrapperHelp.stderr || wrapperHelp.stdout).toBe(2);
      expect(wrapperHelp.stderr).toMatch(/consumer_runtime_absent.*setup --worktree/s);

      const setupSmoke = runNode(cleanRoot, ["src/cli.ts", "doctor", "--setup-smoke"], env);
      expect(setupSmoke.status, setupSmoke.stderr || setupSmoke.stdout).toBe(0);
      expect(setupSmoke.stdout).toContain("doctor: setup-smoke - OK");

      const typecheck = runNpm(cleanRoot, ["run", "typecheck"], env);
      expect(typecheck.status, typecheck.stderr || typecheck.stdout).toBe(0);
    } finally {
      removeCleanRoot(cleanRoot);
      removeCleanRoot(injectedHome);
    }
  }, 420_000);
});

describe("U-OIDBASE-009 packaged default baseline authority", () => {
  it("loads the tracked JSON baseline from the real clean Pack independent of subject and cwd", () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "ut-tdd-oidbase-009-assets-"));
    const packRoot = mkdtempSync(join(tmpdir(), "ut-tdd-oidbase-009-pack-"));
    const subjectRoot = mkdtempSync(join(tmpdir(), "ut-tdd-oidbase-009-subject-"));
    const cwdA = mkdtempSync(join(tmpdir(), "ut-tdd-oidbase-009-cwd-a-"));
    const cwdB = mkdtempSync(join(tmpdir(), "ut-tdd-oidbase-009-cwd-b-"));
    try {
      const writeScanFixture = (root: string, id: string, description: string): void => {
        const designRoot = join(root, "docs", "test-design");
        const testRoot = join(root, "tests");
        const governanceRoot = join(root, "docs", "governance");
        mkdirSync(designRoot, { recursive: true });
        mkdirSync(testRoot, { recursive: true });
        mkdirSync(governanceRoot, { recursive: true });
        writeFileSync(
          join(designRoot, "fixture.md"),
          [
            `| IT-ID | Given | When | Then |`,
            `| --- | --- | --- | --- |`,
            `| \`${id}\` | ${description} | scan fixture | observed |`,
            "",
          ].join("\n"),
          "utf8",
        );
        writeFileSync(
          join(testRoot, "fixture.test.ts"),
          `it("${id}: ${description}", () => {});\n`,
          "utf8",
        );
        writeFileSync(
          join(governanceRoot, "oracle-test-trace-baseline.json"),
          JSON.stringify({
            schemaVersion: 2,
            legacy: [`U-OIDBASE-${id.endsWith("009") ? "101" : id.slice(-3)}`],
            widened: [`U-OIDBASE-${id.endsWith("009") ? "102" : id.slice(-3)}`],
            citations: [`U-OIDBASE-${id.endsWith("009") ? "103" : id.slice(-3)}`],
          }),
          "utf8",
        );
      };
      writeScanFixture(subjectRoot, "U-OIDBASE-009", "subject fixture");
      writeScanFixture(cwdA, "U-OIDBASE-901", "cwd A decoy");
      writeScanFixture(cwdB, "U-OIDBASE-902", "cwd B decoy");
      const rawTree = readCandidate009HeadTree(repoRoot);
      const sourcePaths = collectDistributionCandidatePaths(repoRoot);
      expect([...rawTree.keys()].sort()).toEqual([...sourcePaths].sort());

      const plan = buildCleanDistributionPlan({
        paths: sourcePaths,
        sourceTag: "v0.0.0-oidbase-009",
      });
      expect(plan.ok).toBe(true);
      expect(plan.missingRequired).toEqual([]);
      expect(plan.denylistViolations).toEqual([]);
      if (!plan.ok) throw new Error("OIDBASE-009 clean distribution plan failed");

      const materialized = materializeReleaseArtifacts({
        materializerVersion: "1",
        entries: [...rawTree.values()].map((entry) => {
          if (entry.mode !== "100644" && entry.mode !== "100755" && entry.mode !== "120000")
            throw new Error(`OIDBASE-009 source mode is unsupported: ${entry.path}:${entry.mode}`);
          return { path: entry.path, mode: entry.mode, content: entry.bytes };
        }),
      });
      expect(materialized.ok).toBe(true);
      if (!materialized.ok)
        throw new Error(`OIDBASE-009 materialization failed: ${materialized.error}`);
      expect(materialized.entries.map((entry) => entry.path).sort()).toEqual(
        plan.artifactPaths.filter((path) => path !== "release/manifest.yaml").sort(),
      );

      // The Pack producer consumes a Git tree. Build that tree from the exact
      // materialized output so each Pack path has its own Git identity; the
      // original source tree remains the input to the real materializer above.
      const packGitRoot = mkdtempSync(join(outputRoot, "pack-git-"));
      for (const entry of materialized.entries) {
        if (entry.mode !== "100644" && entry.mode !== "100755")
          throw new Error(`OIDBASE-009 Pack mode is unsupported: ${entry.path}:${entry.mode}`);
        const destination = join(packGitRoot, ...entry.path.split("/"));
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, entry.content);
        chmodSync(destination, entry.mode === "100755" ? 0o755 : 0o644);
      }
      runGit(packGitRoot, ["init"]);
      runGit(packGitRoot, ["config", "user.name", "UT-TDD OIDBASE-009 fixture"]);
      runGit(packGitRoot, ["config", "user.email", "oidbase-009-fixture@example.invalid"]);
      runGit(packGitRoot, ["config", "core.autocrlf", "false"]);
      runGit(packGitRoot, ["config", "core.filemode", "true"]);
      execFileSync(
        "git",
        ["--literal-pathspecs", "add", "--pathspec-from-file=-", "--pathspec-file-nul"],
        {
          cwd: packGitRoot,
          input: Buffer.from(`${materialized.entries.map((entry) => entry.path).join("\0")}\0`),
        },
      );
      const executablePackPaths = materialized.entries
        .filter((entry) => entry.mode === "100755")
        .map((entry) => entry.path);
      if (executablePackPaths.length > 0) {
        execFileSync("git", ["update-index", "--chmod=+x", "-z", "--stdin"], {
          cwd: packGitRoot,
          input: Buffer.from(`${executablePackPaths.join("\0")}\0`),
        });
      }
      runGit(packGitRoot, ["commit", "-m", "OIDBASE-009 materialized Pack fixture"]);
      const packTree = readCandidate009HeadTree(packGitRoot);
      expect([...packTree.keys()].sort()).toEqual(
        materialized.entries.map((entry) => entry.path).sort(),
      );
      for (const entry of materialized.entries) {
        const raw = packTree.get(entry.path);
        if (!raw) throw new Error(`OIDBASE-009 Pack Git blob is missing: ${entry.path}`);
        expect(raw.mode, `OIDBASE-009 Pack Git mode changed: ${entry.path}`).toBe(entry.mode);
        expect(
          raw.bytes.equals(Buffer.from(entry.content)),
          `OIDBASE-009 Pack Git bytes changed (possible .gitattributes clean conversion): ${entry.path}`,
        ).toBe(true);
      }

      const publicationEntries = materialized.entries.map((entry) => {
        const sourcePath = entry.path;
        const raw = packTree.get(sourcePath);
        if (!raw) throw new Error(`OIDBASE-009 Pack Git source is missing: ${sourcePath}`);
        if (entry.mode !== "100644" && entry.mode !== "100755")
          throw new Error(
            `OIDBASE-009 publication mode is unsupported: ${entry.path}:${entry.mode}`,
          );
        const content = raw.bytes;
        return {
          sourcePath,
          destinationPath: entry.path,
          mode: entry.mode,
          size: content.length,
          contentDigest: candidate009Hash(content),
          content,
        };
      });
      const artifacts = publicationEntries.map(({ content: _content, ...artifact }) => artifact);
      const artifactSourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: packGitRoot,
        encoding: "utf8",
      }).trim();
      const artifactInventoryDigest = deriveArtifactInventoryDigest(artifacts);
      const zeroAssetInventoryDigest = `sha256:${"0".repeat(64)}`;
      const recordDigestFor = (releaseAssetInventoryDigest: string) =>
        deriveReleaseRecordDigest({
          materializerVersion: "1",
          artifactSourceCommit,
          artifactSetDigest: materialized.digest,
          artifactInventoryDigest,
          releaseAssetInventoryDigest,
        });
      const provisionalRelease = {
        releaseId: deriveReleaseId("1", artifactSourceCommit, materialized.digest),
        materializerVersion: "1",
        artifactSourceCommit,
        artifactSetDigest: materialized.digest,
        artifactInventoryDigest,
        releaseAssetInventoryDigest: zeroAssetInventoryDigest,
        releaseRecordDigest: recordDigestFor(zeroAssetInventoryDigest),
        artifacts,
      };
      const provisionalPack = derivePackPublicationAssets({
        release: provisionalRelease,
        entries: publicationEntries,
      });
      expect(provisionalPack.ok, provisionalPack.ok ? undefined : provisionalPack.error).toBe(true);
      if (!provisionalPack.ok)
        throw new Error(`OIDBASE-009 provisional Pack producer failed: ${provisionalPack.error}`);
      const release = {
        ...provisionalRelease,
        releaseAssetInventoryDigest: provisionalPack.value.releaseAssetInventoryDigest,
        releaseRecordDigest: recordDigestFor(provisionalPack.value.releaseAssetInventoryDigest),
      };
      const packed = derivePackPublicationAssets({ release, entries: publicationEntries });
      expect(packed.ok, packed.ok ? undefined : packed.error).toBe(true);
      if (!packed.ok) throw new Error(`OIDBASE-009 Pack producer failed: ${packed.error}`);
      const tarballName = "oidbase-009.tar.gz";
      writeFileSync(join(outputRoot, tarballName), packed.value.tarball.bytes);

      const list = spawnSync("tar", ["-tzf", tarballName], {
        cwd: outputRoot,
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(list.status, list.stderr || list.stdout).toBe(0);
      const tarPaths = list.stdout.trim().split(/\r?\n/).filter(Boolean);
      // First intentional Red anchor: the real clean allowlist currently omits this asset.
      expect(
        tarPaths.filter((path) => path === "docs/governance/oracle-test-trace-baseline.json"),
      ).toHaveLength(1);

      const sourceBaseline = rawTree.get("docs/governance/oracle-test-trace-baseline.json");
      if (!sourceBaseline) throw new Error("OIDBASE-009 HEAD baseline JSON is missing");
      const baselineArtifact = publicationEntries.find(
        (entry) => entry.destinationPath === "docs/governance/oracle-test-trace-baseline.json",
      );
      if (!baselineArtifact)
        throw new Error("OIDBASE-009 baseline is absent from materialized inventory");
      const extracted = spawnSync("tar", ["-xzf", tarballName, "-C", packRoot], {
        cwd: outputRoot,
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(extracted.status, extracted.stderr || extracted.stdout).toBe(0);
      const packagedBaselinePath = join(
        packRoot,
        "docs",
        "governance",
        "oracle-test-trace-baseline.json",
      );
      const packagedBaselineBytes = readFileSync(packagedBaselinePath);
      expect(packagedBaselineBytes).toEqual(sourceBaseline.bytes);
      expect(packagedBaselineBytes.length).toBe(baselineArtifact.size);
      expect(candidate009Hash(packagedBaselineBytes)).toBe(baselineArtifact.contentDigest);

      const install = runNpm(packRoot, ["ci", "--no-audit", "--no-fund"]);
      expect(install.status, install.stderr || install.stdout).toBe(0);

      type SerializedInput =
        | {
            ok: true;
            value: {
              declared: string[];
              referenced: string[];
              baseline: string[];
              widenedBaseline: string[];
              duplicateBaseline: string[] | null;
              citationBaseline: string[] | null;
            };
          }
        | {
            ok: false;
            typed: boolean;
            name?: string;
            reason?: string;
            message?: string;
          };
      const serializeInput = (moduleRoot: string, cwd: string): SerializedInput => {
        const moduleUrl = pathToFileURL(
          join(moduleRoot, "src", "lint", "oracle-test-trace.ts"),
        ).href;
        const code = [
          `const { loadOracleTestTraceInput, OracleTestTraceLoadError } = await import(${JSON.stringify(moduleUrl)});`,
          `try {`,
          `  const value = loadOracleTestTraceInput(${JSON.stringify(subjectRoot)});`,
          `  const sorted = (items) => [...items].sort();`,
          `  console.log(JSON.stringify({ ok: true, value: { declared: sorted(value.declared), referenced: sorted(value.referenced), baseline: sorted(value.baseline), widenedBaseline: sorted(value.widenedBaseline), duplicateBaseline: value.duplicateBaseline === undefined ? null : sorted(value.duplicateBaseline), citationBaseline: value.citationBaseline === undefined ? null : sorted(value.citationBaseline) } }));`,
          `} catch (error) { console.log(JSON.stringify({ ok: false, typed: error instanceof OracleTestTraceLoadError, name: error?.name, reason: error?.reason, message: error?.message })); }`,
        ].join("\n");
        const result = runNode(cwd, ["--input-type=module", "-e", code]);
        expect(result.status, result.stderr || result.stdout).toBe(0);
        return JSON.parse(result.stdout.trim()) as SerializedInput;
      };
      const sourceAtA = serializeInput(repoRoot, cwdA);
      const sourceAtB = serializeInput(repoRoot, cwdB);
      const packAtA = serializeInput(packRoot, cwdA);
      const packAtB = serializeInput(packRoot, cwdB);
      expect(sourceAtA.ok).toBe(true);
      expect(sourceAtB).toEqual(sourceAtA);
      expect(packAtA).toEqual(sourceAtA);
      expect(packAtB).toEqual(sourceAtA);
      if (!sourceAtA.ok || !sourceAtB.ok || !packAtA.ok || !packAtB.ok)
        throw new Error("OIDBASE-009 one-argument loader failed before missing-asset check");

      const baselineJson = JSON.parse(packagedBaselineBytes.toString("utf8")) as {
        schemaVersion: number;
        legacy: string[];
        widened: string[];
        citations: string[];
      };
      expect(baselineJson.schemaVersion).toBe(2);
      expect(Array.isArray(baselineJson.legacy)).toBe(true);
      expect(Array.isArray(baselineJson.widened)).toBe(true);
      expect(Array.isArray(baselineJson.citations)).toBe(true);
      const expectedLegacy = [...baselineJson.legacy].sort();
      const expectedWidened = [...baselineJson.widened].sort();
      const expectedCitations = [...baselineJson.citations].sort();
      for (const output of [sourceAtA.value, sourceAtB.value, packAtA.value, packAtB.value]) {
        expect(output.declared).toEqual(["U-OIDBASE-009"]);
        expect(output.referenced).toEqual(["U-OIDBASE-009"]);
        expect(output.baseline).toEqual(expectedLegacy);
        expect(output.widenedBaseline).toEqual(expectedWidened);
        expect(output.citationBaseline).toEqual(expectedCitations);
      }

      rmSync(packagedBaselinePath);
      const missing = serializeInput(packRoot, cwdB);
      expect(missing).toMatchObject({
        ok: false,
        typed: true,
        name: "OracleTestTraceLoadError",
        reason: "baseline_asset_missing",
      });
    } finally {
      removeTestTree(outputRoot);
      removeTestTree(packRoot);
      removeTestTree(subjectRoot);
      removeTestTree(cwdA);
      removeTestTree(cwdB);
    }
  }, 420_000);
});
