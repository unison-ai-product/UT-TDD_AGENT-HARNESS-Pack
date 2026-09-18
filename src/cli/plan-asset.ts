import type { Command } from "commander";
import { LegacyMigrationDryRun } from "../plan-asset/application/legacy-migration-dry-run.ts";

export function registerPlanAssetCommands(plan: Command): void {
  plan
    .command("migration-dry-run")
    .description("HEAD上の全legacy PLANについて非破壊migration判定とprovenanceを出力")
    .option("--json", "全recordをJSON出力")
    .action((options: { json?: boolean }) => {
      const report = new LegacyMigrationDryRun().run(process.cwd());
      if (!("records" in report)) {
        process.stderr.write(`plan migration-dry-run: ${report.ruleId}\n`);
        process.exitCode = 1;
        return;
      }
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(
          `plan migration-dry-run — ok=${report.ok} total=${report.total} emitted=${report.emitted} ` +
            `migrated=${report.decisionCounts.migrated} rekeyed=${report.decisionCounts.rekeyed} ` +
            `rejected=${report.decisionCounts.rejected} pending=${report.decisionCounts.pending}\n`,
        );
        process.stdout.write(
          `source_commit=${report.sourceCommit} inventory_digest=${report.inventoryDigest} ` +
            `report_digest=${report.reportDigest}\n`,
        );
        for (const finding of report.findings) {
          process.stdout.write(
            `  [${finding.ruleId}] ${finding.legacyPlanId ?? "inventory"}: ${finding.message}\n`,
          );
        }
      }
      process.exitCode = report.ok ? 0 : 1;
    });
}
