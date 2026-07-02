import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { Command } from "commander";
import { buildReleasePublicationPlan } from "../github/ops-guard";
import { detectMode } from "../runtime/detect";
import {
  buildCleanDistributionPlan,
  buildConsumerReadinessPlan,
  buildPackSyncPlan,
  cleanDistributionSourcePath,
  DEFAULT_PACK_REPO,
  gitAddPathspecCommands,
  transformCleanDistributionArtifact,
} from "../setup/index";

function gitHead(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
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

function copyCleanDistributionArtifact(input: {
  sourceRoot: string;
  sourcePath: string;
  targetRoot: string;
  artifactPath: string;
}): void {
  const from = join(input.sourceRoot, ...input.sourcePath.split("/"));
  const to = join(input.targetRoot, ...input.artifactPath.split("/"));
  mkdirSync(dirname(to), { recursive: true });
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

export function registerDistributionCommands(program: Command): void {
  const distribution = program.command("distribution").description("clean distribution planning");

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
      let bunVersion: string | null = null;
      try {
        bunVersion = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();
      } catch {
        bunVersion = null;
      }
      const hasGit = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
      const hasGh = spawnSync("gh", ["--version"], { stdio: "ignore" }).status === 0;
      const packageRoot = opts.packageRoot ? join(repoRoot, opts.packageRoot) : repoRoot;
      const hookWrapperPath = join(packageRoot, ".ut-tdd", "bin", "ut-tdd.mjs");
      const packageBinPath = join(
        packageRoot,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "ut-tdd.cmd" : "ut-tdd",
      );
      const sourceSetupEntrypoint = join(packageRoot, "src", "cli.ts");
      const hasProjectLocalUtTdd = existsSync(hookWrapperPath) || existsSync(packageBinPath);
      const hasSourceSetupEntrypoint = existsSync(sourceSetupEntrypoint);
      const utTddCli = spawnSync("ut-tdd", ["--help"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const hasUtTddCli = hasProjectLocalUtTdd || hasSourceSetupEntrypoint || utTddCli.status === 0;
      const utTddCliObserved =
        utTddCli.error?.message || utTddCli.stderr.trim() || `exit ${utTddCli.status ?? "unknown"}`;
      const utTddCliHints = [
        join(homedir(), ".bun", "bin", "ut-tdd.exe"),
        join(homedir(), ".bun", "bin", "ut-tdd"),
        process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules", "bun", "bin") : "",
      ].filter((p) => p && existsSync(p));
      const utTddCliMessage = hasUtTddCli
        ? undefined
        : [
            "Generated Claude/Codex hooks call `bun .ut-tdd/bin/ut-tdd.mjs ...` so each project can use its own pinned UT-TDD package.",
            `Expected wrapper: ${hookWrapperPath}`,
            `Expected package bin: ${packageBinPath}`,
            `Expected source setup entrypoint: ${sourceSetupEntrypoint}`,
            `Observed: ${utTddCliObserved}`,
            utTddCliHints.length > 0
              ? `Detected global candidate path(s): ${utTddCliHints.join(", ")}. Prefer the project-local wrapper when multiple projects on one PC pin different harness versions.`
              : "Add UT-TDD as a project dependency, run setup to emit the wrapper, and ensure Bun resolves on the hook shell PATH.",
          ].join(" ");
      const exportPlan = buildCleanDistributionPlan({
        paths: collectDistributionCandidatePaths(repoRoot),
        sourceTag: opts.tag,
        cleanRepo: opts.cleanRepo,
      });
      const readiness = buildConsumerReadinessPlan({
        bunVersion,
        hasGit,
        hasGh,
        hasUtTddCli,
        utTddCliMessage,
        hasClaude: detection.claude,
        hasCodex: detection.codex,
        repoRoot,
        packageRoot,
        tag: opts.tag,
        cleanRepo: opts.cleanRepo,
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
        mkdirSync(outDir, { recursive: true });
        const plannedArtifacts = new Set(exportPlan.artifactPaths);
        const unmanagedExistingPaths = collectDistributionCandidatePaths(outDir).filter(
          (path) => !plannedArtifacts.has(path) && !path.startsWith(".git/"),
        );
        let copyError: string | null = null;
        if (exportPlan.ok) {
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
        }
        const manifest = join(outDir, ".ut-tdd-pack-sync-manifest.json");
        const output = {
          ok: exportPlan.ok && copyError === null && unmanagedExistingPaths.length === 0,
          export: exportPlan,
          sync,
          stage: {
            outDir,
            manifest,
            copiedArtifacts:
              copyError === null && exportPlan.ok ? exportPlan.artifactPaths.length : 0,
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

        if (repoExists && opts.pruneLocal) {
          try {
            for (const rel of existingBefore) {
              rmSync(join(repoDir, ...rel.split("/")), { force: true });
              prunedPaths.push(rel);
            }
          } catch (error) {
            pruneError = error instanceof Error ? error.message : String(error);
          }
        }

        if (repoExists && exportPlan.ok && pruneError === null) {
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
        }

        const unmanagedExistingPaths =
          repoExists && pruneError === null
            ? collectDistributionCandidatePaths(repoDir).filter(
                (path) => !plannedArtifacts.has(path),
              )
            : existingBefore;
        const manifestDir = join(repoRoot, ".ut-tdd", "pack-sync");
        mkdirSync(manifestDir, { recursive: true });
        const manifest = join(
          manifestDir,
          `${exportPlan.sourceTag.replace(/[^A-Za-z0-9._-]+/g, "-")}.sync-pack.json`,
        );
        const output = {
          ok:
            repoExists &&
            exportPlan.ok &&
            pruneError === null &&
            copyError === null &&
            unmanagedExistingPaths.length === 0,
          export: exportPlan,
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
              ...gitAddPathspecCommands(repoDir, exportPlan.artifactPaths),
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
      const outDir = opts.out
        ? isAbsolute(opts.out)
          ? opts.out
          : join(repoRoot, opts.out)
        : join(repoRoot, ".ut-tdd", "release");
      const artifactStem = exportPlan.sourceTag.replace(/[^A-Za-z0-9._-]+/g, "-");
      const tarball = join(outDir, `${artifactStem}.tar.gz`);
      const checksum = `${tarball}.sha256`;
      const manifest = join(outDir, `${artifactStem}.manifest.json`);
      const signature = `${tarball}.sig`;
      const stage = mkdtempSync(join(tmpdir(), "ut-tdd-clean-package-"));
      let tarResult: ReturnType<typeof spawnSync> | null = null;
      try {
        mkdirSync(outDir, { recursive: true });
        const sourcePaths = collectDistributionCandidatePaths(repoRoot);
        for (const rel of exportPlan.artifactPaths) {
          const sourceRel = cleanDistributionSourcePath(rel, sourcePaths);
          copyCleanDistributionArtifact({
            sourceRoot: repoRoot,
            sourcePath: sourceRel,
            targetRoot: stage,
            artifactPath: rel,
          });
        }
        tarResult = spawnSync("tar", ["-czf", tarball, "-C", stage, "."], {
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
                signature,
                signatureRequired: true,
                signatureCreated: false,
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
      } finally {
        rmSync(stage, { recursive: true, force: true });
      }
      const ok =
        exportPlan.ok && tarResult?.status === 0 && existsSync(tarball) && existsSync(checksum);
      const output = {
        ok,
        export: exportPlan,
        artifacts: {
          tarball,
          checksum,
          manifest,
          signature,
          signatureRequired: true,
          signatureCreated: false,
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
      process.stdout.write(`  tarball: ${tarball}\n`);
      process.stdout.write(`  checksum: ${checksum}\n`);
      process.stdout.write("  signature: required but not created (external signing boundary)\n");
      process.stdout.write("  publish: requires PO approval\n");
      process.exitCode = ok ? 0 : 1;
    });
}
