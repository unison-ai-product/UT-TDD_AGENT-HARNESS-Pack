import { realpathSync } from "node:fs";
import type { ConsumerRuntimeReleaseInstallResult } from "./consumer-runtime-contracts.ts";
import { setupConsumerWorktreeRuntime } from "./index.ts";

export function reportExistingRuntime(
  result: ConsumerRuntimeReleaseInstallResult,
): result is Extract<ConsumerRuntimeReleaseInstallResult, { status: "already-installed" }> {
  if (result.status !== "already-installed") return false;
  process.stdout.write(
    result.cacheCreated
      ? "consumer runtime: already installed; verified runtime cache created\n"
      : "consumer runtime: already installed\n",
  );
  if (result.cacheWarning) process.stderr.write(`${result.cacheWarning}\n`);
  return true;
}

interface WorktreeSetupOptions {
  readonly worktree?: string;
  readonly solo?: boolean;
  readonly team?: boolean;
  readonly dryRun?: boolean;
  readonly applyBranchProtection?: boolean;
  readonly teamCount: number;
  readonly consumerRuntimeInput?: string;
  readonly consumerRuntimeRelease?: string;
  readonly expectedConsumerDigest?: string;
}

export function invalidSetupMode(options: WorktreeSetupOptions): boolean {
  let message: string | null = null;
  if (options.solo && options.team)
    message = "--solo と --team は同時指定できません (どちらか一方)\n";
  else if (options.team && options.teamCount === 0)
    message =
      "--team requires --tl-team / --qa-team / --po-team so generated CODEOWNERS never ships with unresolved team placeholders.\n";
  if (message === null) return false;
  process.stderr.write(message);
  process.exitCode = 1;
  return true;
}

export async function handleConsumerWorktreeSetupOption(
  options: WorktreeSetupOptions,
): Promise<boolean> {
  if (!options.worktree) return false;
  if (
    options.solo ||
    options.team ||
    options.dryRun ||
    options.applyBranchProtection ||
    options.teamCount > 0 ||
    options.consumerRuntimeInput
  ) {
    process.stderr.write(
      "worktree_entry_options_invalid: --worktree cannot be combined with setup mode, dry-run, branch-protection, team, or consumer-runtime-input options.\n",
    );
    process.exitCode = 1;
    return true;
  }
  try {
    const result = await setupConsumerWorktreeRuntime({
      currentRoot: realpathSync.native(process.cwd()),
      worktreePath: options.worktree,
      ...(options.consumerRuntimeRelease
        ? { releaseDirectory: options.consumerRuntimeRelease }
        : {}),
      ...(options.expectedConsumerDigest
        ? { expectedConsumerDigest: options.expectedConsumerDigest }
        : {}),
    });
    process.stdout.write(
      `consumer worktree runtime: ${result.status} tag=${result.tag} ` +
        `release_id=${result.identity.release_id} ` +
        `artifact_set_digest=${result.identity.artifact_set_digest} ` +
        `compiled_esm_digest=${result.identity.compiled_esm_digest}\n`,
    );
  } catch (error) {
    process.stderr.write(`setup --worktree invalid: ${String(error)}\n`);
    process.exitCode = 1;
  }
  return true;
}
