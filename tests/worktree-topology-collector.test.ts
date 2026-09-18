import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeWorktreeTopology } from "../src/runtime/worktree-topology.ts";
import {
  collectWorktreeTopology,
  type GitCommand,
  type GitCommandResult,
  observeTopologyPath,
} from "../src/runtime/worktree-topology-collector.ts";

const roots: string[] = [];
const cleanups: Array<() => void> = [];
const oid = "a".repeat(40);

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ut-tdd-wttopo-pf2-")));
  roots.push(root);
  return root;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

function initRepository(): { root: string; merged: string; active: string; detached: string } {
  const root = tempRoot();
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "pf2@example.invalid"]);
  git(root, ["config", "user.name", "PF2"]);
  writeFileSync(join(root, "README.md"), "root\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "root"]);
  const merged = join(root, "merged");
  const active = join(root, "active");
  const detached = join(root, "detached");
  git(root, ["worktree", "add", "-b", "merged", merged, "HEAD"]);
  git(root, ["worktree", "add", "-b", "active", active, "HEAD"]);
  writeFileSync(join(active, "active.txt"), "active\n");
  git(active, ["add", "active.txt"]);
  git(active, ["commit", "-m", "active"]);
  git(root, ["worktree", "add", "--detach", detached, "HEAD"]);
  cleanups.push(() => {
    for (const path of [detached, active, merged]) {
      execFileSync("git", ["-C", root, "worktree", "remove", "--force", path], {
        stdio: "ignore",
        windowsHide: true,
      });
    }
  });
  return { root, merged, active, detached };
}

function result(stdout: string, status = 0): GitCommandResult {
  return { status, stdout, stderr: status === 0 ? "" : "fatal: fixture failure" };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("worktree topology PF2 OS collector", () => {
  it("U-WTTOPO-007/012: merged と retained detached だけを analyzer の retirable へ渡す", () => {
    const fixture = initRepository();
    const collection = collectWorktreeTopology({ repoRoot: fixture.root });

    expect(collection.observations).toEqual([]);
    expect(collection.retainedRefs.some((ref) => ref.name === "refs/remotes/origin/HEAD")).toBe(
      false,
    );
    const detachedPath = observeTopologyPath(fixture.detached).pathKey;
    const mergedPath = observeTopologyPath(fixture.merged).pathKey;
    const activePath = observeTopologyPath(fixture.active).pathKey;
    const detached = collection.facts.find((fact) => fact.worktreePathKey === detachedPath);
    expect(detached?.detachedRetained).toBe(true);
    expect(
      collection.facts.find((fact) => fact.worktreePathKey === mergedPath)?.mergedIntoMain,
    ).toBe(true);
    expect(
      collection.facts.find((fact) => fact.worktreePathKey === activePath)?.mergedIntoMain,
    ).toBe(false);
    const report = analyzeWorktreeTopology(collection);
    expect(report.retirable).toEqual(expect.arrayContaining([detachedPath, mergedPath]));
    expect(report.retirable).not.toContain(activePath);
  });

  it("U-WTTOPO-012/017: retained ref の symbolic alias を保持し、到達性失敗を fail-close する", () => {
    const root = tempRoot();
    const detachedPath = join(root, "detached");
    const commands: GitCommand[] = [];
    const runGit = (command: GitCommand): GitCommandResult => {
      commands.push(command);
      if (command.args[0] === "worktree") {
        return result(`worktree ${detachedPath}\nHEAD ${oid}\ndetached\n\n`);
      }
      if (command.args[0] === "rev-parse") return result(".git\n");
      if (command.args[0] === "for-each-ref") {
        return result(
          `refs/heads/main\t${oid}\t\nrefs/remotes/origin/HEAD\t${oid}\trefs/remotes/origin/main\n`,
        );
      }
      if (command.args[0] === "status") return result("");
      if (command.args[0] === "merge-base") return result("", 2);
      return result("", 1);
    };

    mkdirSync(join(root, ".git"));
    mkdirSync(detachedPath);
    const collection = collectWorktreeTopology({ repoRoot: root, runGit });

    expect(collection.retainedRefs).toContainEqual({
      name: "refs/remotes/origin/HEAD",
      objectId: oid,
      symbolicTarget: "refs/remotes/origin/main",
    });
    expect(collection.facts[0]?.detachedRetained).toBe(false);
    expect(collection.observations).toContainEqual(
      expect.objectContaining({
        kind: "reachability_unavailable",
        operation: "reachability",
        evidenceCode: "command_failed",
      }),
    );
    expect(JSON.stringify(collection.observations)).not.toContain("fixture failure");
    expect(commands.some((command) => command.args.includes("for-each-ref"))).toBe(true);
  });

  it("U-WTTOPO-014/U-WTTOPO-017: malformed porcelain、command failure、root escape を typed finding にする", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".git"));
    const cases: Array<{
      label: string;
      runGit: (command: GitCommand) => GitCommandResult;
      kind: string;
      operation: string;
      evidenceCode: string;
    }> = [
      {
        label: "malformed",
        runGit: (command) =>
          command.args[0] === "worktree" ? result("HEAD missing-worktree\n") : result(".git\n"),
        kind: "collector_parse_error",
        operation: "worktree-porcelain",
        evidenceCode: "malformed",
      },
      {
        label: "command failure",
        runGit: (command) => (command.args[0] === "worktree" ? result("", 128) : result(".git\n")),
        kind: "collector_command_error",
        operation: "worktree-list",
        evidenceCode: "command_failed",
      },
      {
        label: "path escape",
        runGit: (command) =>
          command.args[0] === "worktree"
            ? result(`worktree ../outside\nHEAD ${oid}\ndetached\n\n`)
            : result("../outside-git\n"),
        kind: "path_escape",
        operation: "resolve-path",
        evidenceCode: "root_escape",
      },
    ];

    for (const item of cases) {
      const collection = collectWorktreeTopology({ repoRoot: root, runGit: item.runGit });
      expect(collection.observations, item.label).toContainEqual(
        expect.objectContaining({
          kind: item.kind,
          operation: item.operation,
          evidenceCode: item.evidenceCode,
        }),
      );
    }
  });

  it("U-WTTOPO-016: Windows の実 junction を realpath.native 観測で同一 identity に収束する", () => {
    const root = tempRoot();
    const target = join(root, "target");
    const alias = join(root, "alias");
    mkdirSync(target);
    const expectJunctionCapabilityFinding = (): void => {
      expect(observeTopologyPath(alias).finding).toEqual(
        expect.objectContaining({
          kind: "collector_parse_error",
          operation: "realpath",
          evidenceCode: "realpath_unavailable",
        }),
      );
    };
    if (process.platform !== "win32") {
      expectJunctionCapabilityFinding();
      return;
    }
    try {
      symlinkSync(target, alias, "junction");
    } catch {
      expectJunctionCapabilityFinding();
      return;
    }
    const targetObserved = observeTopologyPath(target);
    const aliasObserved = observeTopologyPath(alias);
    expect(targetObserved.pathKey).toBeDefined();
    expect(aliasObserved.pathKey).toBe(targetObserved.pathKey);
    expect(observeTopologyPath(`${alias.toLowerCase()}\\`).pathKey).toBe(targetObserved.pathKey);
  });
});
