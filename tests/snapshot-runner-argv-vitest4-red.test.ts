import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseSnapshotRunnerArgs } from "../scripts/run-vitest-snapshot.ts";

// 契約: docs/design/harness/L6-function-design/snapshot-runner-argv.md §2.1 / I5 (issue #1247)

const VALUE_PROBE = "1";

function allowedOptionsReportedByRunner(): string[] {
  const parsed = parseSnapshotRunnerArgs(["--not-a-vitest-option"]);
  if (parsed.kind !== "unknown-option") throw new Error("runner did not report its allowlist");
  const match = /Allowed options: (.+?)\. To pass/.exec(parsed.message);
  if (!match) throw new Error(`allowlist not found in diagnostic: ${parsed.message}`);
  return match[1].split(", ");
}

// 固定版 Vitest の実際の CLI 定義 (stub なし) を、別の node process で cli.js が import する chunk から取り出して検査する。
// vite-node の import 変換 (Windows の短い path 名など) を通さず、どの platform でも同じ経路で CLI 定義に届く。
const PROBE_SOURCE = String.raw`
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
const root = dirname(createRequire(join(process.cwd(), "noop.js")).resolve("vitest/package.json"));
const cliSource = readFileSync(join(root, "dist", "cli.js"), "utf8");
const chunk = /import \{ c as createCLI \} from '(\.\/chunks\/[^']+)'/.exec(cliSource);
if (!chunk) throw new Error("createCLI chunk not found in vitest/dist/cli.js");
const createCLI = (await import(pathToFileURL(join(root, "dist", chunk[1])).href)).c;
const rejected = [];
for (const option of JSON.parse(process.env.UT_PROBE_OPTIONS)) {
  const argv = option === "--browser" ? [option] : [option, ${JSON.stringify(VALUE_PROBE)}];
  const cli = createCLI();
  try {
    cli.parse(["node", "vitest", "run", ...argv], { run: false });
    cli.matchedCommand.checkUnknownOptions();
  } catch (error) {
    rejected.push(option + ": " + String(error.message).split("\n")[0]);
  }
}
console.log(JSON.stringify(rejected));
`;

describe("snapshot runner argv vs pinned Vitest (issue #1247)", () => {
  it("U-SNAPARG-003 rejects --minWorkers (removed in Vitest 4) as an unknown option", () => {
    for (const args of [["--minWorkers=1"], ["--minWorkers", "1"]]) {
      const parsed = parseSnapshotRunnerArgs(args);
      expect(parsed.kind).toBe("unknown-option");
      if (parsed.kind === "unknown-option") expect(parsed.token).toBe("--minWorkers");
    }
  });

  it("U-SNAPARG-002 the diagnostic keeps the original input token (--name=value) while token is the option name", () => {
    const parsed = parseSnapshotRunnerArgs(["--foo=1"]);
    expect(parsed.kind).toBe("unknown-option");
    if (parsed.kind === "unknown-option") {
      expect(parsed.token).toBe("--foo");
      expect(parsed.message).toContain("--foo=1");
    }
  });

  it("U-SNAPARG-004 every allowlisted option is accepted by the real pinned Vitest CLI", () => {
    const options = allowedOptionsReportedByRunner();
    expect(options.length).toBeGreaterThan(0);
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", PROBE_SOURCE], {
      env: { ...process.env, UT_PROBE_OPTIONS: JSON.stringify(options) },
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
    });
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  it("CANDIDATE-U-SNAPARG-005 preserves the report path and its position around --", () => {
    const outputFile = "C:/CI temp/windows report.json";
    const forms = [["--outputFile", outputFile], [`--outputFile=${outputFile}`]];
    const cases = [...forms, ...forms.map((form) => ["--", ...form])];
    for (const args of cases) expect(parseSnapshotRunnerArgs(args)).toEqual({ kind: "run", args });

    const source = `
import { parseCLI } from "vitest/node";
const values = JSON.parse(process.env.UT_PROBE_REPORT_ARGS).map((args) =>
  parseCLI(["vitest", "run", ...args]).options.outputFile ?? null
);
console.log(JSON.stringify(values));
`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      env: { ...process.env, UT_PROBE_REPORT_ARGS: JSON.stringify(cases) },
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual([outputFile, outputFile, null, null]);
  });
});
