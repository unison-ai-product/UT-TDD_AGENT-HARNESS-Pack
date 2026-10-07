import type { Command } from "commander";
import { LegacyMigrationDryRun } from "../plan-asset/application/legacy-migration-dry-run.ts";
import { readPlanRevisionCanonicalPayloadDigest } from "../plan-asset/ledger/plan-revision-digest-query.ts";

export function registerPlanAssetCommands(plan: Command): void {
  plan
    .command("revision-digest")
    .description("指定PLAN revisionのcanonical payload digestを読み出す")
    .requiredOption("--alias <alias>", "完全一致するPLAN alias")
    .requiredOption("--asset-id <assetId>", "PLAN asset ID")
    .requiredOption("--revision <revision>", "読み出すrevision番号")
    .option("--json", "JSON出力")
    .action((options: { alias: string; assetId: string; revision: string; json?: boolean }) => {
      if (!options.json) {
        process.stderr.write("plan revision-digest: --json が必要です\n");
        process.exitCode = 1;
        return;
      }
      const result = readPlanRevisionCanonicalPayloadDigest({
        alias: options.alias,
        assetId: options.assetId,
        revision: Number(options.revision),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = result.ok ? 0 : 1;
    });

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
