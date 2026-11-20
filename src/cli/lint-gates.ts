import type { Command } from "commander";
import { registerCodeSizeCommands } from "./code-size.ts";
import { registerDocSplitCommands } from "./doc-split.ts";
import { registerPrivacyScanCommands } from "./privacy-scan.ts";

/** Repository lint gates that own a CLI group, registered in their former `cli.ts` order. */
export function registerLintGateCommands(program: Command): void {
  registerDocSplitCommands(program);
  registerPrivacyScanCommands(program);
  registerCodeSizeCommands(program);
}
