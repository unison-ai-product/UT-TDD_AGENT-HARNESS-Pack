import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRuntimeRepoRoot } from "../src/runtime/repo-root.ts";

const cliPath = resolve("src/cli.ts");
const fixtures: string[] = [];

function fixture(remote?: string): string {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-rcdev-identity-"));
  fixtures.push(root);
  const testBin = join(root, ".test-bin");
  mkdirSync(testBin);
  const fakeGh = join(testBin, process.platform === "win32" ? "gh.exe" : "gh");
  if (process.platform === "win32") {
    copyFileSync(process.execPath, fakeGh);
  } else {
    writeFileSync(fakeGh, "#!/bin/sh\nexit 1\n", "utf8");
    chmodSync(fakeGh, 0o755);
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "UT-TDD test"], { cwd: root });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: root });
  if (remote) execFileSync("git", ["remote", "add", "origin", remote], { cwd: root });
  return root;
}

function testEnv(root: string): NodeJS.ProcessEnv {
  const testBin = join(root, ".test-bin");
  const path = `${testBin};${process.env.PATH ?? ""}`;
  return { PATH: path, Path: path };
}

function runCli(cwd: string, args: readonly string[], input = "", env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: "",
      UT_TDD_PROJECT_DIR: "",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
}

function setup(root: string) {
  return runCli(root, ["setup", "--solo"], "", testEnv(root));
}

function writtenPaths(stdout: string): string[] {
  return [...stdout.matchAll(/^ {2}\+ (.+)$/gm)].map((match) => match[1] as string);
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("U-RCDEV PR-1: identity / repo-root", () => {
  it("U-RCDEV-001: origin-less setup is partial success with visible typed deny", () => {
    const root = fixture();
    const run = setup(root);

    expect(run.status).toBe(2);
    expect(run.stdout).toContain("phase: 0-A");
    expect(run.stdout).toContain("AGENTS.md");
    expect(existsSync(join(root, ".ut-tdd", "state", "setup.json"))).toBe(true);
    expect(existsSync(join(root, "ut-tdd.project.json"))).toBe(false);
    expect(writtenPaths(run.stdout)).not.toContain("ut-tdd.project.json");
    expect(run.stderr).toContain(
      "identity: denied (identity_repository_unbound): origin remote is missing or invalid",
    );
    expect(run.stderr).toContain("recovery: git remote add origin <url>");
    expect(run.stderr).toContain("recovery: ut-tdd setup --solo");
  });

  it("U-RCDEV-002: adding origin allows a no-op-safe rerun to create identity", () => {
    const root = fixture();
    const first = setup(root);
    const paths = writtenPaths(first.stdout);
    expect(paths.length).toBeGreaterThan(0);
    const before = new Map(paths.map((path) => [path, readFileSync(join(root, path))]));

    execFileSync("git", ["remote", "add", "origin", "https://github.com/example/probe.git"], {
      cwd: root,
    });
    const second = setup(root);

    expect(second.status).toBe(0);
    expect(existsSync(join(root, "ut-tdd.project.json"))).toBe(true);
    for (const [path, bytes] of before) {
      expect(readFileSync(join(root, path)), path).toEqual(bytes);
    }
  });

  it("U-RCDEV-003: setup identity marker resolves root for all five hook/session routes", () => {
    const withOrigin = fixture("https://github.com/example/probe.git");
    expect(setup(withOrigin).status).toBe(0);
    const nested = join(withOrigin, "nested", "hook-cwd");
    mkdirSync(nested, { recursive: true });
    expect(resolveRuntimeRepoRoot({ cwd: nested, env: {} })).toBe(withOrigin);

    const routes: readonly (readonly string[])[] = [
      ["hook", "work-guard"],
      ["hook", "agent-guard"],
      ["session", "start"],
      ["session", "summary"],
      ["hook", "subagent-stop"],
    ];
    for (const route of routes) {
      const run = runCli(nested, route, "{}\n", testEnv(withOrigin));
      expect(run.stderr, route.join(" ")).not.toContain("repository root could not be resolved");
    }

    const markerlessParent = fixture();
    const markerlessNested = join(markerlessParent, "nested", "hook-cwd");
    mkdirSync(markerlessNested, { recursive: true });
    expect(resolveRuntimeRepoRoot({ cwd: markerlessNested, env: {} })).toBeNull();

    const withoutOrigin = fixture();
    expect(setup(withoutOrigin).status).toBe(2);
    const deniedNested = join(withoutOrigin, "nested", "hook-cwd");
    mkdirSync(deniedNested, { recursive: true });
    for (const route of routes) {
      const run = runCli(deniedNested, route, "{}\n", testEnv(withoutOrigin));
      expect(run.stderr, route.join(" ")).toContain("recovery: git remote add origin <url>");
      expect(run.stderr, route.join(" ")).toContain("recovery: ut-tdd setup --solo");
    }
  }, 60_000);

  it("U-RCDEV-004: setup surfaces the explicit commit requirement", () => {
    const root = fixture("https://github.com/example/probe.git");
    const run = setup(root);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("identity: commit required (ut-tdd.project.json)");
    expect(run.stdout).toContain("git add ut-tdd.project.json");
    expect(run.stdout).toContain('git commit -m "chore: add project identity"');
  });

  it("U-RCDEV-005: session start keeps HEAD-strict identity and prints commit recovery", () => {
    const root = fixture("https://github.com/example/probe.git");
    expect(setup(root).status).toBe(0);

    const beforeCommit = runCli(root, ["session", "start"], "{}\n", testEnv(root));
    expect(beforeCommit.status).toBe(1);
    expect(beforeCommit.stderr).toContain("project_memory_root_project_identity_unavailable");
    expect(beforeCommit.stderr).toContain("recovery: git add ut-tdd.project.json");
    expect(beforeCommit.stderr).toContain('recovery: git commit -m "chore: add project identity"');

    execFileSync("git", ["add", "ut-tdd.project.json"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "test: commit project identity"], { cwd: root });
    const afterCommit = runCli(root, ["session", "start"], "{}\n", testEnv(root));
    expect(afterCommit.stderr).not.toContain("project_memory_root_project_identity_unavailable");
  }, 60_000);
});
