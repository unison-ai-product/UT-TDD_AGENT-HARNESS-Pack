import { execFileSync, spawnSync } from "node:child_process";
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
import {
  createLocalGitObjectReader,
  resolveReleaseArtifacts,
} from "../src/setup/release-artifact-resolver.ts";
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
    const cleanRoot = createCleanDistributionFixture();
    const releaseDir = join(cleanRoot, ".release");
    try {
      // blocked は missingRequired で誘発する (denied 入力は D-2 followup により通常除外で
      // あって blocked にならないため)。
      rmSync(join(cleanRoot, "LICENSE"), { force: true });
      const result = runNode(cleanRoot, [
        join(repoRoot, "src", "cli.ts"),
        "distribution",
        "package",
        "--tag",
        "v0.0.0-blocked",
        "--out",
        releaseDir,
        "--json",
      ]);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).ok).toBe(false);
      expect(existsSync(join(releaseDir, "v0.0.0-blocked.tar.gz"))).toBe(false);

      const packDir = join(cleanRoot, ".pack");
      mkdirSync(packDir, { recursive: true });
      const obsolete = join(packDir, "obsolete.txt");
      writeFileSync(obsolete, "must not be pruned\n", "utf8");
      const pack = runNode(cleanRoot, [
        join(repoRoot, "src", "cli.ts"),
        "distribution",
        "sync-pack",
        "--repo-dir",
        packDir,
        "--prune-local",
        "--json",
      ]);
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
        "docs/templates/adapter/.claude/agents/ut-tdd-tl.md",
      );
      expect(distributionJson.export.artifactPaths).toContain(
        "docs/templates/adapter/.claude/agents/code-reviewer.md",
      );
      expect(distributionJson.export.artifactPaths).toContain(
        "docs/templates/adapter/.claude/agents/qa-test.md",
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
      expect(wrapperHelp.status, wrapperHelp.stderr || wrapperHelp.stdout).toBe(78);
      expect(wrapperHelp.stderr).toContain("consumer_runtime_absent");

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
