import type { Command } from "commander";
import { checkCodeSize } from "../lint/code-size-inputs.ts";

/** code and test size gate (`ut-tdd code-size ...`). Registered from src/cli.ts. */
export function registerCodeSizeCommands(program: Command): void {
  const codeSize = program.command("code-size").description("code and test size gate (#1310)");
  codeSize
    .command("check")
    .description(
      "measure src / tests files and functions against the code-size limits and baseline",
    )
    .action(() => {
      const result = checkCodeSize(process.cwd());
      for (const message of result.messages) process.stdout.write(`${message}\n`);
      process.exitCode = result.ok ? 0 : 1;
    });
}
