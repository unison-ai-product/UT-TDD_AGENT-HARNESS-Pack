import type { Command } from "commander";
import {
  createGhPrMergePorts,
  type GhPrMergePorts,
  runPrMerge,
} from "../feedback/review-merge-gate.ts";

export function registerPrMergeCommands(
  program: Command,
  dependencies: { ports?: GhPrMergePorts; now?: () => string; repoRoot?: string } = {},
): void {
  const pr = program.command("pr").description("PR operations with the UT-TDD review gate");
  pr.command("merge")
    .description("merge a PR only when the exact-head review dispatch is merge_ready")
    .requiredOption("--pr <number>", "PR number")
    .option("--json", "JSON output")
    .action((options: { pr: string; json?: boolean }) => {
      const result = runPrMerge({
        repoRoot: dependencies.repoRoot ?? process.cwd(),
        pr: Number(options.pr),
        ports: dependencies.ports ?? createGhPrMergePorts(),
        now: dependencies.now,
      });
      if (options.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        process.stdout.write(
          `pr merge — ${result.ok ? "MERGED" : "DENY"} pr=#${result.pr} head=${result.headSha ?? "unknown"} reason=${result.reason}\n`,
        );
      }
      if (!options.json && /^baseline_conflict(?!_unknown)/.test(result.reason)) {
        process.stdout.write(
          "baseline を持つ gate の対象を並行 PR が変更しています。git merge origin/main で main を取り込み、CI が緑になってから再実行してください (新しい head には新しい review が必要です)。\n",
        );
      }
      if (!result.ok) process.exitCode = 1;
    });
}
