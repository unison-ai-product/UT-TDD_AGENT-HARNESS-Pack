import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { removeTestTree } from "./support/temp-tree.ts";

const producer = resolve("scripts/windows-ci-shard-evidence.mjs");
const aggregate = resolve("scripts/windows-ci-shard-aggregate.mjs");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function fixture(root: string, lane: "full" | "doc") {
  const cwd = join(root, "checkout");
  mkdirSync(cwd);
  git(cwd, "init", "--quiet");
  const commit = (message: string) =>
    git(
      cwd,
      "-c",
      "user.name=CI fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=.git/disabled-hooks",
      "commit",
      "--quiet",
      "-m",
      message,
    );
  writeFileSync(join(cwd, "README.md"), "fixture\n");
  git(cwd, "add", "README.md");
  commit("base");
  const before = git(cwd, "rev-parse", "HEAD");
  const file = lane === "full" ? "src/fixture.ts" : "docs/reference/fixture.md";
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), "fixture\n");
  git(cwd, "add", file);
  commit("change");

  const eventPath = join(root, "event.json");
  writeFileSync(eventPath, JSON.stringify({ before }));
  const env = {
    ...process.env,
    GITHUB_RUN_ID: "1063",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_SHA: git(cwd, "rev-parse", "HEAD"),
    GITHUB_EVENT_NAME: "push",
    GITHUB_EVENT_PATH: eventPath,
  };
  const evidenceDir = join(root, "downloaded");
  mkdirSync(evidenceDir);
  const admit = () => {
    const result = spawnSync(process.execPath, [aggregate, "--evidence-dir", evidenceDir], {
      cwd,
      env,
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    return { exit: result.status, verdict: JSON.parse(result.stdout) };
  };
  const addArtifact = (name: string, filename: string) => {
    const directory = join(evidenceDir, name);
    mkdirSync(directory);
    return join(directory, filename);
  };
  const produce = (leg: string, kind: "lane" | "shard", report?: unknown) => {
    const runner = join(root, `runner-${leg.split("/")[0]}-${kind}`);
    mkdirSync(runner);
    if (report) writeFileSync(join(runner, "windows-vitest-report.json"), JSON.stringify(report));
    const output = join(runner, "output.txt");
    const result = spawnSync(process.execPath, [producer, kind], {
      cwd,
      encoding: "utf8",
      env: {
        ...env,
        RUNNER_TEMP: runner,
        GITHUB_OUTPUT: output,
        WINDOWS_CI_LANE: lane,
        WINDOWS_CI_EVIDENCE_LEG: leg,
        WINDOWS_CI_SHARD_RESULT: "success",
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const identity = readFileSync(output, "utf8").trim().split("=")[1];
    const prefix = kind === "lane" ? "harness-lane" : "windows-shard";
    const filename = `${kind}-evidence.json`;
    const artifact = addArtifact(`${prefix}-${identity}-attempt-2`, filename);
    copyFileSync(join(runner, filename), artifact);
    return artifact;
  };
  for (const leg of ["linux", "1/3", "2/3", "3/3"]) produce(leg, "lane");
  return { admit, addArtifact, produce };
}

describe("Windows CI evidence entrypoints", () => {
  it("admits producer artifacts for full Windows regression and counts distinct executed files", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-windows-evidence-"));
    try {
      const { admit, addArtifact, produce } = fixture(root, "full");
      writeFileSync(addArtifact("windows-shard-3-attempt-1", "shard-evidence.json"), "not JSON");
      const report = {
        testResults: [
          { name: "executed.test.ts", assertionResults: [{ status: "passed" }] },
          { name: "executed.test.ts", assertionResults: [{ status: "failed" }] },
          { name: "skipped.test.ts", assertionResults: [{ status: "skipped" }] },
        ],
      };
      const first = produce("1/3", "shard", report);
      produce("2/3", "shard", report);
      expect(admit()).toEqual({
        exit: 1,
        verdict: { ok: false, reason: "attempt_binding_mismatch", affected: ["3/3"] },
      });
      produce("3/3", "shard", report);
      expect(JSON.parse(readFileSync(first, "utf8")).file_count).toBe(1);
      expect(admit()).toEqual({ exit: 0, verdict: { ok: true, lane: "full" } });
      writeFileSync(first, "not JSON");
      expect(admit()).toEqual({
        exit: 1,
        verdict: { ok: false, reason: "malformed_evidence", affected: ["1/3"] },
      });
    } finally {
      removeTestTree(root);
    }
  }, 60_000);

  it("recomputes doc from Git and ignores earlier shard artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-windows-evidence-"));
    try {
      const { admit, addArtifact } = fixture(root, "doc");
      writeFileSync(addArtifact("windows-shard-1-attempt-1", "shard-evidence.json"), "not JSON");
      expect(admit()).toEqual({ exit: 0, verdict: { ok: true, lane: "doc" } });
    } finally {
      removeTestTree(root);
    }
  });
});
