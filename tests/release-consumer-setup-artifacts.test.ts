import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { loadTemplates, nodeSetupDeps, runSetup } from "../src/setup/index.ts";
import { defaultHarnessDbPath, openHarnessDb } from "../src/state-db/index.ts";
import { harnessDbStatus } from "../src/state-db/maintenance.ts";
import * as projectionWriter from "../src/state-db/projection-writer.ts";
import * as tokenTracker from "../src/state-db/token-tracker.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const cliPath = resolve("src/cli.ts");
const fixtures: string[] = [];
const COMMITLINT_INSTALL = "npm install --save-dev @commitlint/cli @commitlint/config-conventional";
const ACTIVATION_POINTER = ".ut-tdd/runtime/activation/active.json";

function fixture(options: { packageType?: "module"; configJs?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-rcdev-setup-artifacts-"));
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
  execFileSync("git", ["remote", "add", "origin", "https://github.com/example/probe.git"], {
    cwd: root,
  });
  if (options.packageType) {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ type: options.packageType }),
      "utf8",
    );
  }
  if (options.configJs !== undefined) {
    writeFileSync(join(root, "commitlint.config.js"), options.configJs, "utf8");
  }
  return root;
}

function testEnv(root: string): NodeJS.ProcessEnv {
  const path = `${join(root, ".test-bin")}${delimiter}${process.env.PATH ?? ""}`;
  return { PATH: path, Path: path, CI: "true" };
}

function runCli(cwd: string, args: readonly string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: "",
      UT_TDD_PROJECT_DIR: "",
      ...testEnv(cwd),
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
}

function setup(root: string) {
  return runCli(root, ["setup", "--solo"]);
}

function hasGateRunsTable(root: string): boolean {
  const db = openHarnessDb(defaultHarnessDbPath(root), { repoRoot: root });
  try {
    return (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("gate_runs") !== undefined
    );
  } finally {
    db.close();
  }
}

function parseWorkflow(source: string) {
  const workflow = parseYaml(source) as {
    jobs?: Record<string, { steps?: Array<Record<string, unknown>> }>;
  };
  const steps = Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
  return { workflow, steps };
}

function stepRun(step: Record<string, unknown>): string {
  return typeof step.run === "string" ? step.run : "";
}

function hasFileGuard(step: Record<string, unknown>, path: string): boolean {
  const guard = `${String(step.if ?? "")}\n${stepRun(step)}`;
  return guard.includes(path) && /if\s*\[|test\s+-[ef]|hashFiles\(/.test(guard);
}

function assertWorkflowConsumerConditions(source: string): void {
  const { steps } = parseWorkflow(source);
  const launcherSteps = steps.filter((step) => /\.ut-tdd\/bin\/ut-tdd\.mjs/.test(stepRun(step)));
  expect(launcherSteps.length).toBeGreaterThan(0);
  for (const step of launcherSteps) {
    const condition = String(step.if ?? "");
    const body = stepRun(step);
    expect(`${condition}\n${body}`).toContain(ACTIVATION_POINTER);
    expect(condition.includes(ACTIVATION_POINTER) || /if\s+\[/.test(body)).toBe(true);
  }

  const noticeSteps = steps.filter((step) => /::notice::/.test(stepRun(step)));
  expect(noticeSteps.length).toBeGreaterThan(0);
  expect(
    noticeSteps.some((step) => {
      const body = stepRun(step);
      return (
        body.includes(ACTIVATION_POINTER) &&
        /if\s+\[\s+!\s+-f/.test(body) &&
        /echo\s+["']?::notice::/.test(body) &&
        !/exit\s+78|exit\s+1\b/.test(body)
      );
    }),
  ).toBe(true);

  for (const step of steps) {
    const body = stepRun(step);
    const isConditional = (path: string) => hasFileGuard(step, path);
    if (/\bnpm\s+ci\b/.test(body)) {
      expect(isConditional("package-lock.json")).toBe(true);
    }
    for (const match of body.matchAll(/\bnpm\s+run\s+(\S+)/g)) {
      const script = match[1] as string;
      const precedingIf = body.lastIndexOf("if ", match.index);
      const scriptGuard = precedingIf < 0 ? "" : body.slice(precedingIf, match.index);
      expect(isConditional("package.json")).toBe(true);
      expect(scriptGuard, `npm run ${script} needs a preceding package script probe`).toContain(
        "scripts",
      );
      expect(scriptGuard, `npm run ${script} needs a probe for that exact script`).toContain(
        script,
      );
    }
    if (
      step.cache === "npm" ||
      (step.with as Record<string, unknown> | undefined)?.cache === "npm"
    ) {
      expect(isConditional("package-lock.json")).toBe(true);
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of fixtures.splice(0)) removeTestTree(root);
});

describe("U-RCDEV PR-3: generated setup artifacts", () => {
  it("CANDIDATE-U-RCDEV-016: setup initializes the actual DB and session start is not degraded", () => {
    const root = fixture();
    const result = setup(root);
    expect(result.status, result.stderr).toBe(0);

    const status = runCli(root, ["db", "status", "--json"]);
    expect(status.status, status.stderr).toBe(0);
    const db = JSON.parse(status.stdout) as {
      initialized: boolean;
      schemaVersion: number;
      expectedVersion: number;
      missingTables: string[];
    };
    expect(db.initialized).toBe(true);
    expect(db.schemaVersion).toBeGreaterThan(0);
    expect(db.schemaVersion).toBe(db.expectedVersion);
    expect(db.missingTables).not.toContain("gate_runs");
    expect(hasGateRunsTable(root)).toBe(true);

    execFileSync("git", ["add", "ut-tdd.project.json"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "test: commit project identity"], { cwd: root });
    const session = runCli(root, ["session", "start"]);
    expect(session.status, session.stderr).toBe(0);
    expect(`${session.stdout}\n${session.stderr}`).not.toContain("DEGRADED");
  }, 90_000);

  it("CANDIDATE-U-RCDEV-016: actual setup opts out of home token telemetry scanning", () => {
    const root = fixture();
    const deps = nodeSetupDeps(root);
    const scan = vi.spyOn(tokenTracker, "loadRepoScopedRuntimeSessionUsage");
    const rebuild = vi.spyOn(projectionWriter, "rebuildHarnessDb");
    runSetup(
      { phase: "0-A", dryRun: false, applyBranchProtection: false },
      {
        ...deps,
        gh: () => ({ ok: false, stdout: "", stderr: "offline fixture" }),
        isInteractive: false,
      },
    );
    expect(scan).not.toHaveBeenCalled();
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(rebuild).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: root, skipTokenTelemetry: true }),
    );
    const db = harnessDbStatus(root);
    expect(db.initialized).toBe(true);
    expect(db.schemaVersion).toBe(db.expectedVersion);
    expect(db.missingTables).not.toContain("gate_runs");
    expect(hasGateRunsTable(root)).toBe(true);
  });

  it("CANDIDATE-U-RCDEV-017: generated and source-mirrored workflow gates activation and consumer files", () => {
    const root = fixture();
    const generated = setup(root);
    expect(generated.status, generated.stderr).toBe(0);
    expect(existsSync(join(root, "package.json"))).toBe(false);
    expect(existsSync(join(root, "package-lock.json"))).toBe(false);
    expect(existsSync(join(root, ACTIVATION_POINTER))).toBe(false);
    const workflowPath = join(root, ".github", "workflows", "harness-check.yml");
    expect(existsSync(workflowPath)).toBe(true);
    assertWorkflowConsumerConditions(readFileSync(workflowPath, "utf8"));

    // The source-repo template overrides the built-in fallback during normal setup.
    // Keep both render inputs on the same consumer-safety contract.
    const mirrored = loadTemplates(process.cwd())["common/harness-check.yml"];
    expect(mirrored).toBeDefined();
    assertWorkflowConsumerConditions(mirrored as string);
  }, 90_000);

  it("CANDIDATE-U-RCDEV-018: CJS commitlint config loads in ESM and CommonJS consumers", () => {
    for (const packageType of ["module", undefined] as const) {
      const root = fixture(packageType ? { packageType } : {});
      const result = setup(root);
      expect(result.status, result.stderr).toBe(0);
      const configPath = join(root, "commitlint.config.cjs");
      expect(existsSync(configPath)).toBe(true);
      const requireConfig = spawnSync(
        process.execPath,
        ["-e", "require('./commitlint.config.cjs')"],
        { cwd: root, encoding: "utf8", env: testEnv(root), timeout: 15_000, windowsHide: true },
      );
      expect(requireConfig.status, requireConfig.stderr).toBe(0);
      expect(result.stdout).toContain(COMMITLINT_INSTALL);
      expect(readFileSync(configPath, "utf8")).toContain(COMMITLINT_INSTALL);
    }
  }, 90_000);

  it("CANDIDATE-U-RCDEV-018: preserves existing commitlint.config.js and warns", () => {
    const existing = "export default { extends: ['local-policy'] };\n";
    const root = fixture({ packageType: "module", configJs: existing });
    const result = setup(root);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(root, "commitlint.config.js"), "utf8")).toBe(existing);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /(?:warning|警告).*commitlint\.config\.js|commitlint\.config\.js.*(?:warning|警告)/i,
    );
    expect(`${result.stdout}\n${result.stderr}`).toContain(COMMITLINT_INSTALL);
  }, 90_000);
});
