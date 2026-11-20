import type { Command } from "commander";
import { defaultHarnessDbPath, openHarnessDb } from "../state-db/index.ts";

/** external issue dry-run queue (`ut-tdd issue ...`). Registered from src/cli.ts. */
export function registerIssueCommands(program: Command): void {
  const issue = program.command("issue").description("external issue dry-run queue");
  issue
    .command("queue")
    .description("list GitHub issue dry-run queue entries")
    .option("--json", "JSON output")
    .action((opts: { json?: boolean }) => {
      const db = openHarnessDb(defaultHarnessDbPath(process.cwd()), { repoRoot: process.cwd() });
      try {
        const rows = db
          .prepare("SELECT * FROM issue_queue ORDER BY created_at, issue_queue_id")
          .all();
        if (opts.json) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
        else {
          for (const row of rows) {
            process.stdout.write(
              `${row.issue_queue_id ?? ""} ${row.status ?? ""}: ${row.title ?? ""} approval=${row.human_approval_required ?? ""}\n`,
            );
          }
        }
      } finally {
        db.close();
      }
    });

  issue
    .command("mark-created")
    .description("record externally created GitHub issue back-reference for a queued dry-run item")
    .requiredOption("--queue-id <id>", "issue_queue_id")
    .requiredOption("--issue-url <url>", "created GitHub issue URL")
    .option("--issue-id <id>", "GitHub issue number or node id")
    .option("--approved-by <name>", "human approver")
    .action(
      (opts: { queueId: string; issueUrl: string; issueId?: string; approvedBy?: string }) => {
        const db = openHarnessDb(defaultHarnessDbPath(process.cwd()), { repoRoot: process.cwd() });
        try {
          const existing = db
            .prepare("SELECT * FROM issue_queue WHERE issue_queue_id = ?")
            .get(opts.queueId);
          if (!existing) {
            process.stderr.write(`issue queue entry not found: ${opts.queueId}\n`);
            process.exitCode = 1;
            return;
          }
          db.prepare(
            `UPDATE issue_queue
             SET status = ?,
                 human_approval_required = 0,
                 approved_by = ?,
                 approved_at = ?,
                 external_issue_id = ?,
                 external_issue_url = ?
             WHERE issue_queue_id = ?`,
          ).run(
            "created",
            opts.approvedBy ?? "",
            new Date().toISOString(),
            opts.issueId ?? "",
            opts.issueUrl,
            opts.queueId,
          );
          process.stdout.write(`issue queue updated: ${opts.queueId} -> ${opts.issueUrl}\n`);
        } finally {
          db.close();
        }
      },
    );
}
