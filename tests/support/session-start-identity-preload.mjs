import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const log = join(process.cwd(), "session-start-commands.jsonl");
const originalExecFileSync = childProcess.execFileSync;

childProcess.execFileSync = (file, args, options) => {
  if (file === "git" || file === "gh") {
    appendFileSync(log, `${JSON.stringify({ file, args })}\n`);
  }
  if (file === "gh") {
    if (process.env.UT_TDD_TEST_GH_MODE === "unavailable") {
      throw new Error("synthetic gh unavailable");
    }
    if (args[0] === "pr" && args[1] === "view") {
      return JSON.stringify({ state: "OPEN", mergedAt: null, headRefOid: "c".repeat(40) });
    }
    return "[]";
  }
  return originalExecFileSync(file, args, options);
};
syncBuiltinESMExports();
