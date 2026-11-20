import type { Command } from "commander";
import { checkDocSplit } from "../lint/doc-split-inputs.ts";

/** design document split gate (`ut-tdd doc-split ...`). Registered from src/cli.ts. */
export function registerDocSplitCommands(program: Command): void {
  const docSplit = program.command("doc-split").description("design document split gate (#1032)");
  docSplit
    .command("check")
    .description("measure design / test-design documents against the doc-split limits and baseline")
    .action(() => {
      const result = checkDocSplit(process.cwd());
      for (const message of result.messages) process.stdout.write(`${message}\n`);
      process.exitCode = result.ok ? 0 : 1;
    });
}
