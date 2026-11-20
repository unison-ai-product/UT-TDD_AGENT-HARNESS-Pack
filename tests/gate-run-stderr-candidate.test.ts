import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { heavyAfterAll, heavyBeforeAll } from "./support/hook-bounds.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const snapshotRepoRoot = process.cwd();
const cliPath = join(snapshotRepoRoot, "src", "cli.ts");
const warning = "gate run evidence write failed";

describe("U-GATE-011: human gate evidence warning uses stderr", () => {
  let fixtureRoot: string | undefined;
  let stdout = "";
  let stderr = "";

  heavyBeforeAll(["git", 45_000], () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "ut-tdd-gate-stderr-"));
    // A regular file at .ut-tdd deterministically prevents creation of the
    // gate_runs evidence directory while leaving the gate itself runnable.
    writeFileSync(join(fixtureRoot, ".ut-tdd"), "not a directory", "utf8");
    const blockerPath = join(fixtureRoot, ".ut-tdd");
    expect(lstatSync(blockerPath).isFile()).toBe(true);
    expect(readFileSync(blockerPath, "utf8")).toBe("not a directory");
    expect(existsSync(join(blockerPath, "gate_runs"))).toBe(false);

    const run = spawnSync(
      process.execPath,
      [
        cliPath,
        "gate",
        "G0.5",
        "--mode",
        "standalone",
        "--review-kind",
        "human",
        "--human-approved",
      ],
      {
        cwd: fixtureRoot,
        encoding: "utf8",
        env: { ...process.env, UT_TDD_PLAN_ID: "" },
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );

    expect(run.error?.message ?? "", "gate subprocess spawn/timeout error").toBe("");
    expect(
      run.signal,
      `gate subprocess signal; stderr:\n${run.stderr}\nstdout:\n${run.stdout}`,
    ).toBe(null);
    expect(run.status, `stderr:\n${run.stderr}\nstdout:\n${run.stdout}`).toBe(0);

    stdout = run.stdout;
    stderr = run.stderr;
    expect(stdout).toMatch(/^gate G0\.5: passed mode=standalone review=human\b/m);
    expect(`${stdout}\n${stderr}`).toContain(warning);
    expect(`${stdout}\n${stderr}`).toContain("gate_runs");
  });

  heavyAfterAll("teardown", () => {
    if (fixtureRoot) removeTestTree(fixtureRoot);
  });

  it("U-GATE-011: writes the evidence warning to stderr", () => {
    expect(stderr).toContain(warning);
  });

  it("U-GATE-011: keeps the evidence warning out of stdout", () => {
    expect(stdout).not.toContain(warning);
  });
});
