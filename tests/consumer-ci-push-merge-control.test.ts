import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { heavyAfterAll, heavyBeforeAll } from "./support/hook-bounds.ts";
import { removeTestTree } from "./support/temp-tree.ts";
import { workspaceRead } from "./support/workspace-roots.ts";

type GuardResult = { ok: boolean; findings: Array<{ code: string; evidence: string }> };

const harnessRoot = workspaceRead({
  id: "consumer-ci-push-merge-control-cli-root",
  mode: "isolated_fixture",
  reason: "push merge control executes the CLI from the npm-ci execution snapshot",
  root: process.cwd(),
});
const cliPath = join(harnessRoot, "src", "cli.ts");
const mergeMessage =
  "Merge pull request #42 from fixture/feature\n\nfeat: add push fixture\n\nAdditional merge details";
let fixtureRoot = "";
let actualMergeMessage = "";
let emptyBaseRange: string[] = [];
let guardArgs: string[] = [];

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: fixtureRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

function commit(file: string, contents: string, subject: string): void {
  writeFileSync(join(fixtureRoot, file), contents, "utf8");
  git("add", file);
  git("commit", "--quiet", "-m", subject);
}

function runGuard() {
  guardArgs = [cliPath, "github", "guard", "--head-ref", "main", "--base-ref", "main", "--json"];
  return spawnSync(process.execPath, guardArgs, {
    cwd: fixtureRoot,
    encoding: "utf8",
    windowsHide: true,
  });
}

describe("consumer CI push merge control", () => {
  heavyBeforeAll("git", () => {
    const fixtureParent = process.env.UT_TDD_PUSH_MERGE_FIXTURE_ROOT ?? tmpdir();
    fixtureRoot = mkdtempSync(join(fixtureParent, "ut-tdd-push-merge-control-"));
    git("init", "--quiet", "-b", "main");
    git("config", "user.name", "UT-TDD fixture");
    git("config", "user.email", "fixture@example.invalid");
    commit("base.txt", "base\n", "chore: fixture base");
    git("checkout", "--quiet", "-b", "feature/push-merge");
    commit("feature.txt", "feature\n", "feat: add push fixture");
    git("checkout", "--quiet", "main");
    git(
      "merge",
      "--quiet",
      "--no-ff",
      "feature/push-merge",
      "-m",
      "Merge pull request #42 from fixture/feature",
      "-m",
      "feat: add push fixture\n\nAdditional merge details",
    );
    actualMergeMessage = git("log", "-1", "--format=%B");
    emptyBaseRange = git("log", "--reverse", "--format=%s", "main..HEAD")
      .split(/\r?\n/)
      .filter(Boolean);
  });

  heavyAfterAll("teardown", () => {
    if (fixtureRoot) removeTestTree(fixtureRoot);
  });

  it("precondition: CLI and real multiline merge fixture are available", () => {
    expect(existsSync(cliPath)).toBe(true);
    expect(actualMergeMessage).toBe(mergeMessage);
    expect(actualMergeMessage.includes("\n")).toBe(true);
    expect(emptyBaseRange).toEqual([]);
  });

  it("control: push merge messages are not treated as PR titles when the base range is empty", () => {
    const child = runGuard();
    expect(guardArgs).not.toContain("--pr-title");
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    const body = JSON.parse(child.stdout) as GuardResult;
    expect(body.ok).toBe(true);
    expect(body.findings).toEqual([]);
  });
});
