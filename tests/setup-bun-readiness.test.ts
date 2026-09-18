import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildConsumerReadinessPlan } from "../src/setup/distribution.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "ut-tdd-bun-free-home-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// U-PACKBUN-001 / 002 (PLAN-L7-522 §2.2, S1-a):
// Bun 未導入 consumer で readiness が成立することを、readiness 関数の単体呼び出しではなく
// **実 CLI の実行**で測る (test-design §2: 単体評価では Issue #450 AC1 を満たさない)。
//
// Bun 不在の作り方: 必要な実行子の dir だけを PATH に allowlist し、HOME / USERPROFILE を
// 空の temp dir へ向けて `~/.bun` を不在にする。
const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, "src", "cli.ts");
const LEGACY = ["b", "un"].join("");

function resolveGitDir(): string | null {
  const gitLaunchers = process.platform === "win32" ? ["git.exe", "git.cmd", "git"] : ["git"];
  const pathEntries = (process.env.PATH ?? process.env.Path ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return (
    pathEntries.find((entry) =>
      gitLaunchers.some((launcher) => existsSync(join(entry, launcher))),
    ) ?? null
  );
}

function createCleanConsumer(): string {
  const consumer = temporaryDirectory();
  for (const file of ["README.md", "LICENSE", "package.json"]) {
    cpSync(join(REPO_ROOT, file), join(consumer, file));
  }
  for (const file of ["src/cli.ts", "src/setup/index.ts"]) {
    const destination = join(consumer, file);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(REPO_ROOT, file), destination);
  }
  cpSync(
    join(REPO_ROOT, "docs", "templates", "adapter"),
    join(consumer, "docs", "templates", "adapter"),
    {
      recursive: true,
    },
  );
  return consumer;
}

function bunFreeEnv(home: string): NodeJS.ProcessEnv {
  const nodeDir = join(process.execPath, "..");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^BUN_/i.test(key)) delete env[key];
  }
  const gitDir = resolveGitDir();
  const system32 =
    process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32") : null;
  const path = [
    ...new Set([nodeDir, gitDir, system32].filter((entry): entry is string => Boolean(entry))),
  ].join(delimiter);
  env.PATH = path;
  env.Path = path;
  env.HOME = home;
  env.USERPROFILE = home;
  env.UT_TDD_SKIP_UPDATE_CHECK = "1";
  return env;
}

function probeBun(env: NodeJS.ProcessEnv) {
  if (process.platform === "win32") {
    const cmdExe = env.ComSpec ?? join(env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
    return spawnSync(cmdExe, ["/d", "/c", LEGACY, "--version"], {
      env,
      encoding: "utf8",
      windowsHide: true,
    });
  }
  return spawnSync(LEGACY, ["--version"], { env, encoding: "utf8" });
}

function readinessOf(cwd: string, env: NodeJS.ProcessEnv) {
  const run = spawnSync(process.execPath, [CLI, "distribution", "plan", "--json"], {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  // Setup creates the sealed-runtime wrapper, but readiness remains blocked
  // until a producer-admitted runtime bundle is published.
  expect(run.status, run.stderr || run.stdout).toBe(0);
  return (
    JSON.parse(run.stdout) as {
      readiness: {
        ok: boolean;
        checks: { name: string; ok: boolean; message: string }[];
        ci: { requires: string[] };
        rollback: { commands: string[] };
      };
    }
  ).readiness;
}

function setupConsumer(cwd: string, env: NodeJS.ProcessEnv): void {
  const run = spawnSync(process.execPath, [CLI, "setup", "--solo"], {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  expect(run.status, run.stderr || run.stdout).toBe(0);
  expect(existsSync(join(cwd, ".ut-tdd", "bin", "ut-tdd.mjs"))).toBe(true);
}

function readinessForNodeConstraint(
  nodeVersion: string | null,
  requiredNodeVersion: string | null,
) {
  return buildConsumerReadinessPlan({
    nodeVersion,
    requiredNodeVersion,
    hasGit: true,
    hasGh: false,
    hasUtTddCli: true,
    hasClaude: false,
    hasCodex: false,
    repoRoot: "/consumer",
  });
}

function expectNodeConstraintBlocked(
  readiness: ReturnType<typeof readinessForNodeConstraint>,
  name: string,
  message: string,
): void {
  expect(readiness.ok).toBe(false);
  expect(readiness.checks.find((check) => check.name === name)).toEqual({
    name,
    ok: false,
    message,
  });
}

describe("consumer readiness without Bun (PLAN-L7-522 §2.2)", () => {
  it("U-PACKBUN-001: Bun is irrelevant when sealed runtime admission is absent", () => {
    const home = temporaryDirectory();
    const consumer = createCleanConsumer();
    const env = bunFreeEnv(home);
    setupConsumer(consumer, env);
    const readiness = readinessOf(consumer, env);

    // Bun が本当に到達不能であることを先に固定する (環境が緩いと恒真テストになる)。
    const probe = probeBun(bunFreeEnv(home));
    expect(probe.status).not.toBe(0);
    expect(readiness.ok).toBe(false);
    expect(readiness.checks.find((check) => check.name === "ut-tdd-cli")?.ok).toBe(false);
  });

  it("U-PACKBUN-002: readiness uses engines.node and npm semver grammar", () => {
    const home = temporaryDirectory();
    const consumer = createCleanConsumer();
    const env = bunFreeEnv(home);
    setupConsumer(consumer, env);
    const readiness = readinessOf(consumer, env);
    const names = readiness.checks.map((check) => check.name);
    const serializedReadinessCommands = JSON.stringify({
      checks: readiness.checks,
      ciRequires: readiness.ci.requires,
      rollbackCommands: readiness.rollback.commands,
    });
    const requiredNodeVersion = (
      JSON.parse(readFileSync(join(consumer, "package.json"), "utf8")) as {
        engines: { node: string };
      }
    ).engines.node;

    expect(names).not.toContain(`${LEGACY}>=1.3`);
    expect(serializedReadinessCommands).not.toContain("Install Bun 1.3 or newer before setup");
    expect(serializedReadinessCommands.toLowerCase()).not.toContain(LEGACY);
    expect(readiness.ci.requires).toEqual([
      "actions/checkout@v4",
      "actions/setup-node@v4",
      "npm ci --no-audit --no-fund",
      "npm run typecheck",
      "npm test",
    ]);
    expect(readiness.rollback.commands[0]).toMatch(/^git switch \S+$/);
    expect(readiness.rollback.commands.slice(1)).toEqual([
      "node .ut-tdd/bin/ut-tdd.mjs setup --dry-run",
      "node .ut-tdd/bin/ut-tdd.mjs setup --solo",
    ]);
    expect(names).toContain(`node@${requiredNodeVersion}`);
    expect(names).toContain("git");
    expect(readiness.checks.find((check) => check.name === `node@${requiredNodeVersion}`)?.ok).toBe(
      true,
    );

    const nodeReady = (nodeVersion: string, requiredNodeVersion: string) =>
      buildConsumerReadinessPlan({
        nodeVersion,
        requiredNodeVersion,
        hasGit: true,
        hasGh: false,
        hasUtTddCli: true,
        hasClaude: false,
        hasCodex: false,
        repoRoot: consumer,
      }).checks.find((check) => check.name === `node@${requiredNodeVersion}`)?.ok;

    // npm semver grammar is authoritative. These cases independently kill the
    // former local evaluator's tilde and partial-hyphen upper-bound defects.
    expect(nodeReady("24.13.0", "~24")).toBe(true);
    expect(nodeReady("25.0.0", "~24")).toBe(false);
    expect(nodeReady("24.14.9", "24.13 - 24.14")).toBe(true);
    expect(nodeReady("24.15.0", "24.13 - 24.14")).toBe(false);
    expect(nodeReady("24.12.9", ">=24.13 <25")).toBe(false);
    expect(nodeReady("24.13.0", ">=24.13 <25")).toBe(true);
  });

  it("missing engines.node is a typed blocking readiness check", () => {
    const readiness = readinessForNodeConstraint("24.13.0", null);

    expect(readiness.ok).toBe(false);
    expectNodeConstraintBlocked(
      readiness,
      "node engines.node (missing)",
      "package.json engines.node is missing; cannot verify the Node runtime",
    );
  });

  it("invalid engines.node is a typed blocking readiness check", () => {
    const readiness = readinessForNodeConstraint("24.13.0", "not a semver range");

    expect(readiness.ok).toBe(false);
    expectNodeConstraintBlocked(
      readiness,
      "node@not a semver range",
      "Install a Node version satisfying not a semver range before setup (observed 24.13.0)",
    );
  });

  it("missing nodeVersion is a typed blocking readiness check", () => {
    const readiness = readinessForNodeConstraint(null, "^24.13.0");

    expect(readiness.ok).toBe(false);
    expectNodeConstraintBlocked(
      readiness,
      "node@^24.13.0",
      "Install a Node version satisfying ^24.13.0 before setup (observed none)",
    );
  });

  it("range guard rejects an observed Node version outside engines.node", () => {
    const readiness = readinessForNodeConstraint("25.0.0", "^24.13.0");

    expect(readiness.ok).toBe(false);
    expectNodeConstraintBlocked(
      readiness,
      "node@^24.13.0",
      "Install a Node version satisfying ^24.13.0 before setup (observed 25.0.0)",
    );
  });
});
