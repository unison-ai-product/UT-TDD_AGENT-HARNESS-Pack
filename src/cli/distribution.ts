import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Command } from "commander";
import { buildReleasePublicationPlan } from "../github/ops-guard.ts";
import {
  analyzeSecretScan,
  loadSecretScanArtifactsForPaths,
  secretScanMessages,
} from "../lint/secret-scan.ts";
import { detectMode } from "../runtime/detect.ts";
import {
  buildCleanDistributionPlan,
  buildConsumerReadinessPlan,
  buildPackSyncPlan,
  type ConsumerNodeRuntimeReadinessInput,
  cleanDistributionSourcePath,
  DEFAULT_PACK_REPO,
  gitAddPathspecCommands,
  type PackAuthoringSmokeResult,
  projectTrackedTeamBlob,
  releaseArtifactFileNames,
  runPackAuthoringSmoke,
  type TrackedGitBlob,
  transformCleanDistributionArtifact,
} from "../setup/index.ts";
import { ensureDir } from "../shared/fs.ts";

function gitHead(): string | null {
  // Distribution commands are intentionally valid in an unpacked clean artifact,
  // where no `.git` directory exists.  `execFileSync` writes rev-parse's fatal
  // diagnostic to the parent stderr before the exception can be caught (and Bun's
  // Linux subprocess implementation can retain the failed child status).  Probe
  // without inheriting stderr so command registration remains side-effect free.
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function collectDistributionCandidatePaths(repoRoot: string): string[] {
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
        out.push(rel);
      }
    }
  };
  walk(repoRoot);
  return out.sort();
}

const PACK_SYNC_MANIFEST = ".ut-tdd-pack-sync-manifest.json";

function readConsumerRuntimeReadiness(repoRoot: string): ConsumerNodeRuntimeReadinessInput {
  const runtimeRoot = resolve(repoRoot, ".ut-tdd", "runtime");
  const pointerPath = join(runtimeRoot, "activation", "active.json");
  try {
    const pointer = JSON.parse(readFileSync(pointerPath, "utf8")) as {
      bundle_path?: unknown;
      bundle_digest?: unknown;
    };
    if (
      typeof pointer.bundle_path !== "string" ||
      resolve(pointer.bundle_path) !== pointer.bundle_path
    )
      return { status: "blocked", reason: "consumer_runtime_resolution_denied" };
    const rel = relative(runtimeRoot, pointer.bundle_path);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      return { status: "blocked", reason: "consumer_runtime_external_path" };
    const bundle = JSON.parse(
      readFileSync(join(pointer.bundle_path, "bundle-manifest.json"), "utf8"),
    ) as {
      identity?: unknown;
      bundle_digest?: unknown;
      bundle_path?: unknown;
      files?: unknown;
      history_sequence?: unknown;
      prior_bundle_digest?: unknown;
      prior_history_tip_digest?: unknown;
    };
    if (
      bundle.bundle_path !== pointer.bundle_path ||
      bundle.bundle_digest !== pointer.bundle_digest
    )
      return { status: "blocked", reason: "consumer_runtime_digest_mismatch" };
    return {
      status: "ready",
      identity: bundle.identity as ConsumerNodeRuntimeReadinessInput["identity"],
      bundle: bundle as ConsumerNodeRuntimeReadinessInput["bundle"],
    };
  } catch {
    return { status: "blocked", reason: "consumer_runtime_absent" };
  }
}

function copyCleanDistributionArtifact(input: {
  sourceRoot: string;
  sourcePath: string;
  targetRoot: string;
  artifactPath: string;
}): void {
  if (
    input.sourcePath === ".ut-tdd/teams/example-review-team.yaml" &&
    input.artifactPath === "docs/templates/team/example-review-team.yaml"
  ) {
    const projection = readTrackedTeamBlob(input.sourceRoot);
    if (!projection.ok) throw new Error(`authoring projection denied: ${projection.error}`);
    const to = join(input.targetRoot, ...input.artifactPath.split("/"));
    ensureDir(dirname(to), { recursive: true });
    writeFileSync(to, projection.bytes, { encoding: "utf8", mode: 0o644 });
    return;
  }
  const from = join(input.sourceRoot, ...input.sourcePath.split("/"));
  const to = join(input.targetRoot, ...input.artifactPath.split("/"));
  ensureDir(dirname(to), { recursive: true });
  if (input.artifactPath === "package.json") {
    writeFileSync(
      to,
      transformCleanDistributionArtifact(input.artifactPath, readFileSync(from, "utf8")),
      "utf8",
    );
    return;
  }
  cpSync(from, to, { recursive: true });
}

function readTrackedTeamBlob(repoRoot: string) {
  const tree = spawnSync(
    "git",
    ["ls-tree", "-r", "-z", "--full-tree", "HEAD", "--", ".ut-tdd/teams/example-review-team.yaml"],
    { cwd: repoRoot, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] },
  );
  const records = Buffer.from(tree.stdout ?? new Uint8Array())
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const blobs: TrackedGitBlob[] = [];
  for (const record of records) {
    const match = /^(\d{6}) blob ([a-f0-9]{40})\t(.+)$/.exec(record);
    if (!match) continue;
    const blob = spawnSync("git", ["cat-file", "blob", match[2]], {
      cwd: repoRoot,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (blob.status !== 0) continue;
    blobs.push({
      path: match[3],
      mode: match[1] === "100644" ? "100644" : match[1],
      objectId: match[2],
      bytes: new Uint8Array(blob.stdout ?? new Uint8Array()),
    });
  }
  return projectTrackedTeamBlob({ blobs });
}

function runDistributionSecretScan(input: {
  repoRoot: string;
  sourcePaths: readonly string[];
  artifactPaths: readonly string[];
}): ReturnType<typeof analyzeSecretScan> {
  const sourceArtifactPaths = input.artifactPaths.map((rel) =>
    cleanDistributionSourcePath(rel, input.sourcePaths),
  );
  const artifacts = loadSecretScanArtifactsForPaths(input.repoRoot, sourceArtifactPaths).filter(
    (artifact) => artifact.path !== ".ut-tdd/teams/example-review-team.yaml",
  );
  if (sourceArtifactPaths.includes(".ut-tdd/teams/example-review-team.yaml")) {
    const projection = readTrackedTeamBlob(input.repoRoot);
    if (!projection.ok)
      return {
        checked: artifacts.length,
        violations: [
          {
            path: ".ut-tdd/teams/example-review-team.yaml",
            line: 1,
            marker: `authoring-projection-${projection.error}`,
          },
        ],
        ok: false,
      };
    try {
      artifacts.push({
        path: ".ut-tdd/teams/example-review-team.yaml",
        text: new TextDecoder("utf-8", { fatal: true }).decode(projection.bytes),
      });
    } catch {
      return {
        checked: artifacts.length,
        violations: [
          {
            path: ".ut-tdd/teams/example-review-team.yaml",
            line: 1,
            marker: "authoring-projection-invalid-utf8",
          },
        ],
        ok: false,
      };
    }
  }
  return analyzeSecretScan(artifacts);
}

/**
 * PLAN-L7-462 step 2: ut-tdd のグローバル CLI は .cmd shim 配布のため、node の
 * spawn では PATH 解決されない。win32 は ComSpec 経由で CLI shim を探す
 * (fail-soft は従来どおり)。単体テスト U-DIST-CLI-PROBE が「素の spawn に戻すと
 * ENOENT で status=null になる」ことを fail-close で固定する。
 */
export function utTddCliProbe(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): SpawnSyncReturns<string> {
  if (platform === "win32") {
    const cmdExe = env.ComSpec ?? join(env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
    return spawnSync(cmdExe, ["/d", "/c", "ut-tdd", "--help"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env,
    });
  }
  return spawnSync("ut-tdd", ["--help"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
}

export function registerDistributionCommands(program: Command): void {
  const distribution = program.command("distribution").description("clean distribution planning");

  distribution
    .command("authoring-smoke")
    .alias("smoke")
    .description("verify authoring templates from a Pack tree without source dependencies")
    .option("--root <dir>", "Pack tree root", ".")
    .option("--json", "JSON output")
    .action((opts: { root?: string; json?: boolean }) => {
      const root = opts.root
        ? isAbsolute(opts.root)
          ? opts.root
          : join(process.cwd(), opts.root)
        : process.cwd();
      const smoke = runPackAuthoringSmoke(root);
      const output = { ok: smoke.ok, root, smoke };
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
        process.exitCode = smoke.ok ? 0 : 1;
        return;
      }
      process.stdout.write(`distribution authoring-smoke: ${smoke.ok ? "ok" : "blocked"}\n`);
      process.stdout.write(`  checked: ${smoke.checked.length}\n`);
      for (const error of smoke.errors) process.stdout.write(`  ${error}\n`);
      process.exitCode = smoke.ok ? 0 : 1;
    });

  distribution
    .command("plan")
    .description("emit the clean export, preflight, rollback, and contract plan")
    .option("--tag <tag>", "source/release tag", gitHead() ?? "unreleased")
    .option("--clean-repo <name>", "clean distribution repository", DEFAULT_PACK_REPO)
    .option("--package-root <path>", "consumer package root; defaults to repo root")
    .option("--json", "JSON output")
    .action((opts: { tag?: string; cleanRepo?: string; packageRoot?: string; json?: boolean }) => {
      const repoRoot = process.cwd();
      const detection = detectMode();
      // PLAN-L7-522 §2.2 (S1-a): readiness の runtime 検査は Bun ではなく Node を見る。
      // 実行中の node 自身が観測値であり、外部 probe を spawn しない。
      const nodeVersion = process.versions.node;
      const hasGit = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
      const hasGh = spawnSync("gh", ["--version"], { stdio: "ignore" }).status === 0;
      const packageRoot = opts.packageRoot ? join(repoRoot, opts.packageRoot) : repoRoot;
      // engines.node は consumer package root の package.json が正本 (第二の pin を持たない)。
      const requiredNodeVersion = ((): string | null => {
        const manifestPath = join(packageRoot, "package.json");
        if (!existsSync(manifestPath)) return null;
        try {
          const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as {
            engines?: { node?: unknown };
          };
          const node = parsed.engines?.node;
          return typeof node === "string" && node.trim() !== "" ? node.trim() : null;
        } catch {
          return null;
        }
      })();
      const exportPlan = buildCleanDistributionPlan({
        paths: collectDistributionCandidatePaths(repoRoot),
        sourceTag: opts.tag,
        cleanRepo: opts.cleanRepo,
      });
      const readiness = buildConsumerReadinessPlan({
        nodeVersion,
        requiredNodeVersion,
        hasGit,
        hasGh,
        hasClaude: detection.claude,
        hasCodex: detection.codex,
        repoRoot,
        packageRoot,
        tag: opts.tag,
        cleanRepo: opts.cleanRepo,
        consumerRuntime: readConsumerRuntimeReadiness(repoRoot),
      });
      const output = {
        ok: exportPlan.ok && readiness.ok,
        export: exportPlan,
        readiness,
        actualCutRequiresPoApproval: true,
      };
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
        return;
      }
      process.stdout.write(
        `distribution plan: ${output.ok ? "ok" : "blocked"} channel=${exportPlan.channel} tag=${exportPlan.sourceTag}\n`,
      );
      process.stdout.write(`  clean-repo: ${exportPlan.cleanRepo}\n`);
      process.stdout.write(`  artifact-paths: ${exportPlan.artifactPaths.length}\n`);
      process.stdout.write(`  excluded-paths: ${exportPlan.excludedPaths.length}\n`);
      process.stdout.write(
        `  readiness: ${readiness.ok ? "ok" : "blocked"} mode=${readiness.mode}\n`,
      );
      process.stdout.write("  actual-cut: requires PO approval\n");
      process.exitCode = output.ok ? 0 : 1;
    });

  distribution
    .command("sync-plan")
    .description("emit a non-destructive clean Pack repository sync plan")
    .option("--tag <tag>", "source/release tag", gitHead() ?? "unreleased")
    .option("--clean-repo <name>", "clean distribution repository", DEFAULT_PACK_REPO)
    .option("--branch <name>", "Pack repository target branch", "main")
    .option("--staging-dir <path>", "local Pack staging clone path")
    .option("--json", "JSON output")
    .action(
      (opts: {
        tag?: string;
        cleanRepo?: string;
        branch?: string;
        stagingDir?: string;
        json?: boolean;
      }) => {
        const repoRoot = process.cwd();
        const sourcePaths = collectDistributionCandidatePaths(repoRoot);
        const exportPlan = buildCleanDistributionPlan({
          paths: sourcePaths,
          sourceTag: opts.tag,
          cleanRepo: opts.cleanRepo,
        });
        const stagingDir = opts.stagingDir
          ? isAbsolute(opts.stagingDir)
            ? opts.stagingDir
            : join(repoRoot, opts.stagingDir)
          : join(repoRoot, ".ut-tdd", "pack-sync", exportPlan.sourceTag);
        const sync = buildPackSyncPlan({
          exportPlan,
          sourcePaths,
          stagingDir,
          branch: opts.branch,
        });
        const output = {
          ok: sync.ok,
          export: exportPlan,
          sync,
          actualRemoteMutationRequiresPoApproval: true,
        };
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
          process.exitCode = sync.ok ? 0 : 1;
          return;
        }
        process.stdout.write(
          `distribution sync-plan: ${sync.ok ? "ok" : "blocked"} tag=${sync.sourceTag}\n`,
        );
        process.stdout.write(`  clean-repo: ${sync.cleanRepo}\n`);
        process.stdout.write(`  staging-dir: ${sync.stagingDir}\n`);
        process.stdout.write(`  copy-plan: ${sync.copyPlan.length} files\n`);
        process.stdout.write(
          "  remote mutation: requires PO approval; commands were not executed\n",
        );
        process.exitCode = sync.ok ? 0 : 1;
      },
    );

  distribution
    .command("sync-stage")
    .description(
      "materialize clean Pack artifacts into a local staging directory without publishing",
    )
    .option("--tag <tag>", "source/release tag", gitHead() ?? "unreleased")
    .option("--clean-repo <name>", "clean distribution repository", DEFAULT_PACK_REPO)
    .option("--branch <name>", "Pack repository target branch", "main")
    .option("--out <dir>", "local staging directory", ".ut-tdd/pack-stage")
    .option("--json", "JSON output")
    .action(
      (opts: {
        tag?: string;
        cleanRepo?: string;
        branch?: string;
        out?: string;
        json?: boolean;
      }) => {
        const repoRoot = process.cwd();
        const sourcePaths = collectDistributionCandidatePaths(repoRoot);
        const exportPlan = buildCleanDistributionPlan({
          paths: sourcePaths,
          sourceTag: opts.tag,
          cleanRepo: opts.cleanRepo,
        });
        const secretScan = runDistributionSecretScan({
          repoRoot,
          sourcePaths,
          artifactPaths: exportPlan.artifactPaths,
        });
        const outDir = opts.out
          ? isAbsolute(opts.out)
            ? opts.out
            : join(repoRoot, opts.out)
          : join(repoRoot, ".ut-tdd", "pack-stage");
        const sync = buildPackSyncPlan({
          exportPlan,
          sourcePaths,
          stagingDir: outDir,
          branch: opts.branch,
        });
        ensureDir(outDir, { recursive: true });
        const plannedArtifacts = new Set(exportPlan.artifactPaths);
        const unmanagedExistingPaths = collectDistributionCandidatePaths(outDir).filter(
          (path) =>
            !plannedArtifacts.has(path) && !path.startsWith(".git/") && path !== PACK_SYNC_MANIFEST,
        );
        let copyError: string | null = null;
        let authoringSmoke: PackAuthoringSmokeResult = {
          ok: false,
          checked: [],
          errors: ["not-run"],
        };
        if (exportPlan.ok && secretScan.ok) {
          try {
            for (const rel of exportPlan.artifactPaths) {
              const sourceRel = cleanDistributionSourcePath(rel, sourcePaths);
              copyCleanDistributionArtifact({
                sourceRoot: repoRoot,
                sourcePath: sourceRel,
                targetRoot: outDir,
                artifactPath: rel,
              });
            }
          } catch (error) {
            copyError = error instanceof Error ? error.message : String(error);
          }
          if (copyError === null) authoringSmoke = runPackAuthoringSmoke(outDir);
        }
        const manifest = join(outDir, PACK_SYNC_MANIFEST);
        const output = {
          ok:
            exportPlan.ok &&
            secretScan.ok &&
            copyError === null &&
            authoringSmoke.ok &&
            unmanagedExistingPaths.length === 0,
          export: exportPlan,
          secretScan: {
            ok: secretScan.ok,
            checked: secretScan.checked,
            violations: secretScan.violations,
          },
          authoringSmoke,
          sync,
          stage: {
            outDir,
            manifest,
            copiedArtifacts:
              copyError === null && exportPlan.ok && secretScan.ok
                ? exportPlan.artifactPaths.length
                : 0,
            unmanagedExistingPaths,
            copyError,
            destructiveRemoteMutation: false,
            actualRemoteMutationRequiresPoApproval: true,
          },
        };
        writeFileSync(manifest, `${JSON.stringify(output, null, 2)}\n`, "utf8");
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
          process.exitCode = output.ok ? 0 : 1;
          return;
        }
        process.stdout.write(
          `distribution sync-stage: ${output.ok ? "ok" : "blocked"} tag=${exportPlan.sourceTag}\n`,
        );
        process.stdout.write(`  out: ${outDir}\n`);
        process.stdout.write(`  copied-artifacts: ${output.stage.copiedArtifacts}\n`);
        if (!secretScan.ok) {
          process.stdout.write(`  ${secretScanMessages(secretScan)[0]}\n`);
        }
        process.stdout.write(`  unmanaged-existing: ${unmanagedExistingPaths.length}\n`);
        process.stdout.write(
          "  remote mutation: requires PO approval; no push/release was executed\n",
        );
        process.exitCode = output.ok ? 0 : 1;
      },
    );

  distribution
    .command("sync-pack")
    .description(
      "update a local Pack repository checkout with clean artifacts; never commits or pushes",
    )
    .option("--tag <tag>", "source/release tag", gitHead() ?? "unreleased")
    .option("--clean-repo <name>", "clean distribution repository", DEFAULT_PACK_REPO)
    .option("--branch <name>", "Pack repository target branch", "main")
    .requiredOption("--repo-dir <dir>", "local Pack repository checkout to update")
    .option("--prune-local", "remove local files in repo-dir that are not part of the clean Pack")
    .option("--json", "JSON output")
    .action(
      (opts: {
        tag?: string;
        cleanRepo?: string;
        branch?: string;
        repoDir: string;
        pruneLocal?: boolean;
        json?: boolean;
      }) => {
        const repoRoot = process.cwd();
        const repoDir = isAbsolute(opts.repoDir) ? opts.repoDir : join(repoRoot, opts.repoDir);
        const repoExists = existsSync(repoDir);
        const sourcePaths = collectDistributionCandidatePaths(repoRoot);
        const exportPlan = buildCleanDistributionPlan({
          paths: sourcePaths,
          sourceTag: opts.tag,
          cleanRepo: opts.cleanRepo,
        });
        const secretScan = runDistributionSecretScan({
          repoRoot,
          sourcePaths,
          artifactPaths: exportPlan.artifactPaths,
        });
        const sync = buildPackSyncPlan({
          exportPlan,
          sourcePaths,
          stagingDir: repoDir,
          branch: opts.branch,
        });
        const plannedArtifacts = new Set(exportPlan.artifactPaths);
        const existingBefore = repoExists
          ? collectDistributionCandidatePaths(repoDir).filter((path) => !plannedArtifacts.has(path))
          : [];
        const prunedPaths: string[] = [];
        let copyError: string | null = null;
        let pruneError: string | null = null;
        let authoringSmoke: PackAuthoringSmokeResult = {
          ok: false,
          checked: [],
          errors: ["not-run"],
        };

        if (repoExists && opts.pruneLocal && exportPlan.ok && secretScan.ok) {
          try {
            for (const rel of existingBefore) {
              rmSync(join(repoDir, ...rel.split("/")), { force: true });
              prunedPaths.push(rel);
            }
          } catch (error) {
            pruneError = error instanceof Error ? error.message : String(error);
          }
        }

        if (repoExists && exportPlan.ok && secretScan.ok && pruneError === null) {
          try {
            for (const rel of exportPlan.artifactPaths) {
              const sourceRel = cleanDistributionSourcePath(rel, sourcePaths);
              copyCleanDistributionArtifact({
                sourceRoot: repoRoot,
                sourcePath: sourceRel,
                targetRoot: repoDir,
                artifactPath: rel,
              });
            }
          } catch (error) {
            copyError = error instanceof Error ? error.message : String(error);
          }
          if (copyError === null) authoringSmoke = runPackAuthoringSmoke(repoDir);
        }

        const unmanagedExistingPaths =
          repoExists && pruneError === null
            ? collectDistributionCandidatePaths(repoDir).filter(
                (path) => !plannedArtifacts.has(path),
              )
            : existingBefore;
        const manifestDir = join(repoRoot, ".ut-tdd", "pack-sync");
        ensureDir(manifestDir, { recursive: true });
        const manifest = join(
          manifestDir,
          `${exportPlan.sourceTag.replace(/[^A-Za-z0-9._-]+/g, "-")}.sync-pack.json`,
        );
        const output = {
          ok:
            repoExists &&
            exportPlan.ok &&
            secretScan.ok &&
            pruneError === null &&
            copyError === null &&
            authoringSmoke.ok &&
            unmanagedExistingPaths.length === 0,
          export: exportPlan,
          secretScan: {
            ok: secretScan.ok,
            checked: secretScan.checked,
            violations: secretScan.violations,
          },
          authoringSmoke,
          sync,
          pack: {
            repoDir,
            repoExists,
            manifest,
            copiedArtifacts:
              repoExists && exportPlan.ok && pruneError === null && copyError === null
                ? exportPlan.artifactPaths.length
                : 0,
            pruneLocal: Boolean(opts.pruneLocal),
            prunedPaths,
            unmanagedExistingPaths,
            pruneError,
            copyError,
            localGitMutationExecuted: false,
            destructiveRemoteMutation: false,
            actualRemoteMutationRequiresPoApproval: true,
            nextCommands: [
              `git -C ${repoDir} status --short`,
              ...gitAddPathspecCommands(repoDir, exportPlan.artifactPaths, existingBefore),
              `git -C ${repoDir} commit -m "chore: sync clean pack ${exportPlan.sourceTag}"`,
              `git -C ${repoDir} push origin ${opts.branch ?? "main"}`,
            ],
          },
        };
        writeFileSync(manifest, `${JSON.stringify(output, null, 2)}\n`, "utf8");
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
          process.exitCode = output.ok ? 0 : 1;
          return;
        }
        process.stdout.write(
          `distribution sync-pack: ${output.ok ? "ok" : "blocked"} tag=${exportPlan.sourceTag}\n`,
        );
        process.stdout.write(`  repo-dir: ${repoDir}\n`);
        process.stdout.write(`  copied-artifacts: ${output.pack.copiedArtifacts}\n`);
        if (!secretScan.ok) {
          process.stdout.write(`  ${secretScanMessages(secretScan)[0]}\n`);
        }
        process.stdout.write(`  unmanaged-existing: ${unmanagedExistingPaths.length}\n`);
        process.stdout.write(`  pruned-local: ${prunedPaths.length}\n`);
        process.stdout.write(
          "  git commit/push: requires explicit human approval; commands were not executed\n",
        );
        process.exitCode = output.ok ? 0 : 1;
      },
    );

  distribution
    .command("release-plan")
    .description(
      "emit non-destructive git tag and gh release commands for human-approved publishing",
    )
    .requiredOption("--tag <tag>", "release tag, e.g. v0.1.0")
    .option("--repo <name>", "GitHub repository for release publication", DEFAULT_PACK_REPO)
    .option("--json", "JSON output")
    .action((opts: { tag: string; repo?: string; json?: boolean }) => {
      const plan = buildReleasePublicationPlan({
        tag: opts.tag,
        repo: opts.repo ?? DEFAULT_PACK_REPO,
        dryRun: true,
      });
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
        process.exitCode = plan.ok ? 0 : 1;
        return;
      }
      process.stdout.write(
        `release plan: ${plan.ok ? "ok" : "blocked"} tag=${plan.tag} repo=${plan.repo}\n`,
      );
      for (const command of plan.commands) process.stdout.write(`  ${command}\n`);
      process.stdout.write("  publish: requires PO approval; commands were not executed\n");
      process.exitCode = plan.ok ? 0 : 1;
    });

  distribution
    .command("package")
    .description("create a local clean tarball and sha256 checksum without publishing")
    .option("--tag <tag>", "source/release tag", gitHead() ?? "unreleased")
    .option("--clean-repo <name>", "clean distribution repository", DEFAULT_PACK_REPO)
    .option("--out <dir>", "output directory for local release artifacts", ".ut-tdd/release")
    .option("--json", "JSON output")
    .action((opts: { tag?: string; cleanRepo?: string; out?: string; json?: boolean }) => {
      const repoRoot = process.cwd();
      const exportPlan = buildCleanDistributionPlan({
        paths: collectDistributionCandidatePaths(repoRoot),
        sourceTag: opts.tag,
        cleanRepo: opts.cleanRepo,
      });
      const sourcePaths = collectDistributionCandidatePaths(repoRoot);
      const secretScan = runDistributionSecretScan({
        repoRoot,
        sourcePaths,
        artifactPaths: exportPlan.artifactPaths,
      });
      const outDir = opts.out
        ? isAbsolute(opts.out)
          ? opts.out
          : join(repoRoot, opts.out)
        : join(repoRoot, ".ut-tdd", "release");
      const artifactNames = releaseArtifactFileNames(exportPlan.sourceTag);
      const tarball = join(outDir, artifactNames.tarball);
      const checksum = join(outDir, artifactNames.checksum);
      const manifest = join(outDir, artifactNames.manifest);
      const stage = mkdtempSync(join(tmpdir(), "ut-tdd-clean-package-"));
      let tarResult: ReturnType<typeof spawnSync> | null = null;
      try {
        if (exportPlan.ok && secretScan.ok) {
          ensureDir(outDir, { recursive: true });
          for (const rel of exportPlan.artifactPaths) {
            const sourceRel = cleanDistributionSourcePath(rel, sourcePaths);
            copyCleanDistributionArtifact({
              sourceRoot: repoRoot,
              sourcePath: sourceRel,
              targetRoot: stage,
              artifactPath: rel,
            });
          }
          // -f はドライブレター (C:) を含む絶対パスだと GNU tar (Git Bash 同梱) がリモートホスト名と
          // 解釈して "Cannot connect to C:" で必ず失敗する。cwd を outDir に固定し -f を相対 basename に
          // することで bsdtar/GNU tar の両実装で動く (PLAN-L7-361)。-C の引数は remote 解釈されない。
          tarResult = spawnSync("tar", ["-czf", basename(tarball), "-C", stage, "."], {
            cwd: outDir,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          });
          if (tarResult.status === 0) {
            const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
            writeFileSync(checksum, `${digest}  ${basename(tarball)}\n`, "utf8");
            writeFileSync(
              manifest,
              `${JSON.stringify(
                {
                  ok: exportPlan.ok,
                  sourceTag: exportPlan.sourceTag,
                  cleanRepo: exportPlan.cleanRepo,
                  tarball,
                  checksum,
                  artifactCount: exportPlan.artifactPaths.length,
                  missingRequired: exportPlan.missingRequired,
                  denylistViolations: exportPlan.denylistViolations,
                },
                null,
                2,
              )}\n`,
              "utf8",
            );
          }
        } else {
          rmSync(tarball, { force: true });
          rmSync(checksum, { force: true });
          rmSync(manifest, { force: true });
        }
      } finally {
        rmSync(stage, { recursive: true, force: true });
      }
      const ok =
        exportPlan.ok &&
        secretScan.ok &&
        tarResult?.status === 0 &&
        existsSync(tarball) &&
        existsSync(checksum);
      const output = {
        ok,
        export: exportPlan,
        secretScan: {
          ok: secretScan.ok,
          checked: secretScan.checked,
          violations: secretScan.violations,
        },
        artifacts: {
          tarball,
          checksum,
          manifest,
        },
        tar: {
          exitCode: tarResult?.status ?? null,
          stderr: tarResult?.stderr ?? "",
        },
        actualPublishRequiresPoApproval: true,
      };
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
        process.exitCode = ok ? 0 : 1;
        return;
      }
      process.stdout.write(
        `distribution package: ${ok ? "ok" : "blocked"} tag=${exportPlan.sourceTag}\n`,
      );
      if (!ok && tarResult !== null && tarResult.status !== 0) {
        const stderrHead = String(tarResult.stderr ?? "")
          .split(/\r?\n/, 1)[0]
          .trim();
        process.stdout.write(
          `  tar: error exit=${tarResult.status ?? "null"}${stderrHead ? ` (${stderrHead})` : ""} - artifacts not created\n`,
        );
      }
      if (!secretScan.ok) {
        process.stdout.write(`  ${secretScanMessages(secretScan)[0]}\n`);
      }
      process.stdout.write(`  tarball: ${tarball}\n`);
      process.stdout.write(`  checksum: ${checksum}\n`);
      process.stdout.write("  publish: requires PO approval\n");
      process.exitCode = ok ? 0 : 1;
    });
}
