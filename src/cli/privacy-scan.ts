import type { Command } from "commander";
import { checkPrivacyScan } from "../lint/privacy-scan-inputs.ts";

/**
 * privacy scan (`ut-tdd privacy-scan check`, issue #1391). Registered from src/cli.ts.
 * Read-only: email-shape check over the committed tree or a PR range. The local default is a
 * warning (exit 0); `--fail-close` (CI) exits 1 on findings. The denylist is never read here.
 */
export function registerPrivacyScanCommands(program: Command): void {
  const privacyScan = program.command("privacy-scan").description("privacy scan (#1391)");
  privacyScan
    .command("check")
    .description("check the committed tree or a PR range for personal email addresses")
    .requiredOption("--mode <mode>", "tree | diff")
    .option("--rev <rev>", "commit to scan in tree mode", "HEAD")
    .option("--base <rev>", "PR base commit (diff mode)")
    .option("--head <rev>", "PR head commit (diff mode)")
    .option("--fail-close", "exit 1 when findings exist (CI)")
    .action(
      (opts: { mode: string; rev: string; base?: string; head?: string; failClose?: boolean }) => {
        if (opts.mode !== "tree" && opts.mode !== "diff") {
          process.stderr.write("privacy-scan: --mode must be tree or diff\n");
          process.exitCode = 1;
          return;
        }
        const range =
          opts.base !== undefined && opts.head !== undefined
            ? { base: opts.base, head: opts.head }
            : undefined;
        const result = checkPrivacyScan({
          repoRoot: process.cwd(),
          mode: opts.mode,
          rev: opts.rev,
          range,
        });
        for (const message of result.messages) process.stdout.write(`${message}\n`);
        process.exitCode = opts.failClose && !result.ok ? 1 : 0;
      },
    );
}
