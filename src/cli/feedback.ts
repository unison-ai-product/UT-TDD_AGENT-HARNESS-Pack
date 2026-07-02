import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { emitFeedbackEvents } from "../feedback/engine";
import { renderFeedbackEventRows } from "../feedback/surface";
import {
  type ClassifyResult,
  emitClassifyRequest,
  type FeedbackCtx,
  pendingRecoveryProposals,
  recordFeedback,
} from "../runtime/forced-stop";
import { nodeDeps, resolveActivePlan } from "../runtime/session-log";
import { defaultHarnessDbPath, openHarnessDb } from "../state-db/index";

function gitBranch(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export function registerFeedbackCommands(program: Command): void {
  const feedback = program
    .command("feedback")
    .description("feedback event operations and forced-stop recovery intake");

  feedback
    .command("list")
    .description("emit/list harness.db feedback events")
    .option("--json", "JSON output")
    .option(
      "--emit",
      "compute feedback events from current findings and quality signals before listing",
    )
    .action((opts: { json?: boolean; emit?: boolean }) => {
      const db = openHarnessDb(defaultHarnessDbPath(process.cwd()), { repoRoot: process.cwd() });
      try {
        if (opts.emit) emitFeedbackEvents(db);
        const rows = db
          .prepare("SELECT * FROM feedback_events WHERE status = 'open' ORDER BY created_at")
          .all();
        if (opts.json) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
        else process.stdout.write(renderFeedbackEventRows(rows));
      } finally {
        db.close();
      }
    });

  feedback
    .command("classify")
    .description(
      "emit a managed classifier request for feedback text, or record an applied ClassifyResult",
    )
    .option("--text <text>", "target text; stdin is used when omitted")
    .option("--session <id>", "session_id")
    .option("--plan <id>", "plan_id; defaults to active state or branch resolution")
    .option("--apply <json>", "ClassifyResult JSON to apply through recordFeedback")
    .action((opts: { text?: string; session?: string; plan?: string; apply?: string }) => {
      const text = opts.text ?? readStdin();
      if (!opts.apply) {
        process.stdout.write(`${emitClassifyRequest(text)}\n`);
        return;
      }
      let result: ClassifyResult;
      try {
        result = JSON.parse(opts.apply) as ClassifyResult;
      } catch {
        process.stderr.write("--apply must be a ClassifyResult JSON value\n");
        process.exitCode = 1;
        return;
      }
      const deps = nodeDeps(process.cwd(), gitBranch);
      const ctx: FeedbackCtx = {
        session_id: opts.session ?? "unknown",
        plan_id: opts.plan ?? resolveActivePlan(deps),
        summary: text,
      };
      recordFeedback(result, ctx, deps);
      process.stdout.write(
        result.category === "feedback" && ctx.plan_id
          ? `recorded: feedback (attention=${result.attention})\n`
          : "skipped (mistake or unresolved plan_id)\n",
      );
    });

  feedback
    .command("pending")
    .description("list unresolved recovery proposals captured from feedback entries")
    .option("--json", "JSON output")
    .action((opts: { json?: boolean }) => {
      const deps = nodeDeps(process.cwd(), gitBranch);
      const pending = pendingRecoveryProposals(deps);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(pending, null, 2)}\n`);
        return;
      }
      if (pending.length === 0) {
        process.stdout.write("No pending recovery proposals.\n");
        return;
      }
      for (const p of pending) {
        process.stdout.write(`[${p.attention}] ${p.plan_id} ${p.ts} - ${p.summary}\n`);
      }
    });
}
