import "../src/runtime/windows-hide.ts";
import { existsSync, rmSync } from "node:fs";
import { delimiter } from "node:path";
import { makeFixtureDir, writeFakeClaude } from "./support/claude-probe-fixture.ts";

// #1677: PATH の先頭に偽の claude (版 9999.0.0、記録は invocations.log) を置き、
// 注入しない probe と CLI の子 process の doctor が本物の claude を起動しないようにする。
const current = process.env.UT_TDD_CLAUDE_FENCE_DIR;
const first = (process.env.PATH ?? "").split(delimiter)[0];
if (!(current && existsSync(current) && first === current)) {
  const dir = makeFixtureDir("ut-tdd-claude-fence-");
  writeFakeClaude(dir, { version: "9999.0.0" });
  process.env.UT_TDD_CLAUDE_FENCE_DIR = dir;
  process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ""}`;
  process.once("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });
}
