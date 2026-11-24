import type { Command } from "commander";
import { defaultHarnessDbPath, openHarnessDb } from "../state-db/index.ts";

/** guardrail decision ledger (`ut-tdd guardrail ...`). Registered from src/cli.ts. */
export function registerGuardrailCommands(program: Command): void {
  const guardrail = program.command("guardrail").description("guardrail decision ledger");
  guardrail
    .command("status")
    .description("list guardrail decisions from harness.db")
    .option("--json", "JSON output")
    .action((opts: { json?: boolean }) => {
      const db = openHarnessDb(defaultHarnessDbPath(process.cwd()), { repoRoot: process.cwd() });
      try {
        const rows = db.prepare("SELECT * FROM guardrail_decisions ORDER BY decided_at").all();
        if (opts.json) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
        else {
          for (const row of rows) {
            process.stdout.write(
              `${row.plan_id ?? ""} ${row.guardrail ?? ""}: ${row.decision ?? ""} evidence=${row.evidence_path ?? ""}\n`,
            );
          }
        }
      } finally {
        db.close();
      }
    });
}
