import { isAbsolute, join } from "node:path";
import { buildCleanDistributionPlan, buildPackSyncPlan } from "../setup/index.ts";

export interface SyncPlanOptions {
  tag?: string;
  cleanRepo?: string;
  branch?: string;
  stagingDir?: string;
  json?: boolean;
}

export function emitSyncPlan(input: {
  repoRoot: string;
  tag: string;
  sourcePaths: string[];
  opts: SyncPlanOptions;
}): void {
  const { repoRoot, tag, sourcePaths, opts } = input;
  const exportPlan = buildCleanDistributionPlan({
    paths: sourcePaths,
    sourceTag: tag,
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
  process.exitCode = sync.ok ? 0 : 1;
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `distribution sync-plan: ${sync.ok ? "ok" : "blocked"} tag=${sync.sourceTag}\n`,
  );
  process.stdout.write(`  clean-repo: ${sync.cleanRepo}\n`);
  process.stdout.write(`  staging-dir: ${sync.stagingDir}\n`);
  process.stdout.write(`  copy-plan: ${sync.copyPlan.length} files\n`);
  process.stdout.write("  remote mutation: requires PO approval; commands were not executed\n");
}
