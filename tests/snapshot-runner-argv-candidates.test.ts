import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { heavyAfterAll, heavyBeforeAll } from "./support/hook-bounds.ts";
import {
  expectNoForbiddenSnapshotStages,
  isSnapshotResolverGitRead,
  SNAPSHOT_RESOLVER_GIT_READS,
} from "./support/snapshot-stage-classifier.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const SENTINEL = "UT_TDD_SPAWN_INTERCEPT_SENTINEL";
const UNKNOWN_OPTION = "--not-a-vitest-option";
const RUNNER = join(process.cwd(), "scripts", "run-vitest-snapshot.ts");
const ACCEPTED_OPTION_TOKENS = [
  "-t",
  "--testNamePattern",
  "--reporter",
  "--maxWorkers",
  "--shard",
  "--exclude",
  "--pool",
  "--outputFile",
  "--browser",
];
interface SupportedArgumentCase {
  readonly name: string;
  readonly key: string;
  readonly args: readonly string[];
}
interface UnknownOptionCase {
  readonly name: string;
  readonly key: string;
  readonly option: string;
}

const UNKNOWN_OPTION_CASES: readonly UnknownOptionCase[] = [
  { name: "unknown short option -z", key: "unknown-short-z", option: "-z" },
  {
    name: "unknown long option --not-a-vitest-option",
    key: "unknown-long-option",
    option: UNKNOWN_OPTION,
  },
];

const SUPPORTED_ARGUMENT_CASES: readonly SupportedArgumentCase[] = [
  {
    name: "-t with a space-separated value",
    key: "test-name-short-space",
    args: ["-t", "name pattern"],
  },
  { name: "-t with an equals value", key: "test-name-short-equals", args: ["-t=name pattern"] },
  {
    name: "--testNamePattern with a space-separated value",
    key: "test-name-long-space",
    args: ["--testNamePattern", "name pattern"],
  },
  {
    name: "--testNamePattern with an equals value",
    key: "test-name-long-equals",
    args: ["--testNamePattern=name pattern"],
  },
  {
    name: "--reporter with a space-separated value",
    key: "reporter-space",
    args: ["--reporter", "dot"],
  },
  { name: "--reporter with an equals value", key: "reporter-equals", args: ["--reporter=dot"] },
  {
    name: "--maxWorkers with a space-separated value",
    key: "max-workers-space",
    args: ["--maxWorkers", "2"],
  },
  {
    name: "--maxWorkers with an equals value",
    key: "max-workers-equals",
    args: ["--maxWorkers=2"],
  },
  { name: "--shard with a space-separated value", key: "shard-space", args: ["--shard", "1/2"] },
  { name: "--shard with an equals value", key: "shard-equals", args: ["--shard=1/2"] },
  {
    name: "--exclude with a space-separated path",
    key: "exclude-space",
    args: ["--exclude", "tests/excluded.test.ts"],
  },
  {
    name: "--exclude with an equals path",
    key: "exclude-equals",
    args: ["--exclude=tests/excluded.test.ts"],
  },
  { name: "--pool with a space-separated value", key: "pool-space", args: ["--pool", "forks"] },
  { name: "--pool with an equals value", key: "pool-equals", args: ["--pool=forks"] },
  { name: "--browser as a standalone option", key: "browser-standalone", args: ["--browser"] },
  { name: "a positional test path", key: "positional-path", args: ["tests/one.test.ts"] },
  {
    name: "repeated excludes and mixed option order",
    key: "repeated-excludes-mixed-order",
    args: [
      "tests/one.test.ts",
      "--exclude",
      "tests/skip-one.test.ts",
      "--reporter=dot",
      "tests/two.test.ts",
      "--exclude=tests/skip-two.test.ts",
      "-t",
      "mixed name pattern",
    ],
  },
  {
    name: "unknown options after -- pass through",
    key: "separator-tail",
    args: ["--", UNKNOWN_OPTION, "opaque positional value"],
  },
  {
    name: "--help after -- passes through to Vitest",
    key: "separator-help-tail",
    args: ["--", "--help"],
  },
];
const WATCH_BATCH_REJECTION_CASES: readonly SupportedArgumentCase[] = [
  { name: "--watch before --", key: "watch-before-separator", args: ["--watch"] },
  { name: "-w before --", key: "short-watch-before-separator", args: ["-w"] },
  { name: "--watch=value before --", key: "watch-equals-before-separator", args: ["--watch=1"] },
  { name: "--watch after --", key: "watch-after-separator", args: ["--", "--watch"] },
  { name: "-w after --", key: "short-watch-after-separator", args: ["--", "-w"] },
  {
    name: "--watch=value after --",
    key: "watch-equals-after-separator",
    args: ["--", "--watch=1"],
  },
];
let fixtureRoot: string;
let preloadPath: string;
const fakeRunnerRoots: string[] = [];

interface SpawnCall {
  readonly method: string;
  readonly command: string;
  readonly args: string[];
}

function readSpawnCalls(logPath: string): SpawnCall[] {
  if (!logPath || !existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SpawnCall);
}

function forbiddenCloneOrVitestCount(calls: readonly SpawnCall[]): number {
  return calls.filter(({ command, args }) => {
    const normalizedCommand = command.replaceAll("\\", "/").toLowerCase();
    const normalizedArgs = args.map((arg) => arg.replaceAll("\\", "/").toLowerCase());
    const isGit = /(?:^|[\s/"'])git(?:\.exe)?(?:[\s"']|$)/.test(`${normalizedCommand} `);
    const isClone =
      isGit && (normalizedArgs.includes("clone") || /\bclone\b/.test(normalizedCommand));
    const isVitest =
      ["vitest", "vitest.cmd", "vitest.exe"].includes(normalizedCommand.split("/").pop() ?? "") ||
      normalizedArgs.some((arg) => /(?:^|\/)node_modules\/vitest\/vitest\.mjs$/.test(arg)) ||
      /(?:^|[\s/])vitest(?:\.mjs|\.cmd|\.exe)?(?:[\s]|$)/.test(normalizedCommand);
    return isClone || isVitest;
  }).length;
}

function childEnvironment(logPath: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const preloadOption = `--require="${preloadPath.replaceAll("\\", "/")}"`;
  return {
    ...process.env,
    // Do not inherit an ambient NODE_OPTIONS value into these bounded child probes.
    NODE_OPTIONS: preloadOption,
    UT_TDD_ARGV_TEST_SPAWN_LOG: logPath,
    ...overrides,
  };
}

function runChild(args: string[], logPath: string, envOverrides: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: childEnvironment(logPath, envOverrides),
    timeout: 30_000,
    windowsHide: true,
  });
}

interface RunnerProbe {
  readonly result: SpawnSyncReturns<string>;
  readonly calls: SpawnCall[];
}

function outputOf(probe: RunnerProbe): string {
  return `${probe.result.stdout ?? ""}\n${probe.result.stderr ?? ""}`;
}

function hasUnknownOptionDiagnostic(output: string, option: string): boolean {
  return (
    /(?:unknown|unrecognized)[^\r\n]*(?:option|argument)|(?:option|argument)[^\r\n]*(?:unknown|unrecognized)/i.test(
      output,
    ) && output.includes(option)
  );
}

function runRunnerProbe(args: string[], name: string): RunnerProbe {
  const logPath = join(fixtureRoot, `${name}.jsonl`);
  const result = runChild([RUNNER, ...args], logPath);
  // Process startup / timeout / signal failures are setup failures, never candidate Red.
  expect(result.error, `${name} child process error`).toBeUndefined();
  expect(result.status, `${name} child exit status`).not.toBeNull();
  expect(result.signal, `${name} child signal`).toBeNull();
  return { result, calls: readSpawnCalls(logPath) };
}

function runFakeRunnerProbe(args: readonly string[], name: string): RunnerProbe {
  const repoRoot = mkdtempSync(join(tmpdir(), `ut-tdd-argv-${name}-`));
  fakeRunnerRoots.push(repoRoot);
  const logPath = join(repoRoot, "spawn-calls.jsonl");
  const result = runChild(
    [
      "--input-type=module",
      "-e",
      "const { runSnapshotTests } = await import(process.env.UT_TDD_ARGV_TEST_RUNNER_URL); try { runSnapshotTests(JSON.parse(process.env.UT_TDD_ARGV_TEST_ARGS), process.env.UT_TDD_ARGV_TEST_REPO_ROOT, () => 1000); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 23; }",
    ],
    logPath,
    {
      UT_TDD_ARGV_TEST_MODE: "fake-runner",
      UT_TDD_ARGV_TEST_REPO_ROOT: repoRoot,
      UT_TDD_ARGV_TEST_RUNNER_URL: pathToFileURL(RUNNER).href,
      UT_TDD_ARGV_TEST_ARGS: JSON.stringify(args),
    },
  );
  // Startup/timeout/signal failures are fixture errors, not candidate Red.
  expect(result.error, `${name} child process error`).toBeUndefined();
  expect(result.status, `${name} child exit status`).not.toBeNull();
  expect(result.signal, `${name} child signal`).toBeNull();
  return { result, calls: readSpawnCalls(logPath) };
}

function assertExpectedPreloadBoundary(probe: RunnerProbe, name: string, option: string): void {
  expect(probe.result.status, `${name} must reach its guarded boundary`).toBeGreaterThan(0);
  const output = outputOf(probe);
  expect(
    output.includes(SENTINEL) || hasUnknownOptionDiagnostic(output, option),
    `${name} must stop at the spawn sentinel or an unknown-option diagnostic`,
  ).toBe(true);
}

function assertHelpUsage(probe: RunnerProbe): void {
  const output = outputOf(probe);
  expectNoForbiddenSnapshotStages(probe.calls, "help");
  expect(probe.result.status).toBe(0);
  expect(output).toMatch(/usage:/i);
  expect(output).toMatch(/vitest/i);
}

function requireHelpProbe(flag: string): RunnerProbe {
  const probe = helpProbes.get(flag);
  if (!probe) throw new Error(`missing ${flag} probe`);
  return probe;
}

function assertFakeVitestInvocation(probe: RunnerProbe, expectedArgs: readonly string[]): void {
  expect(probe.result.status).toBe(0);
  const vitestRequests = probe.calls.filter(({ args }) =>
    /(?:^|\/)node_modules\/vitest\/vitest\.mjs$/.test(
      (args[0] ?? "").replaceAll("\\", "/").toLowerCase(),
    ),
  );
  expect(vitestRequests).toHaveLength(1);
  // The only forbidden-boundary request is the observed fake Vitest argv. Clone
  // requests are refused by the preload and would add another match.
  expect(forbiddenCloneOrVitestCount(probe.calls)).toBe(1);
  expect(vitestRequests[0]?.args.slice(1)).toEqual(["run", ...expectedArgs]);
}

const helpProbes = new Map<string, RunnerProbe>();
const watchProbes = new Map<string, RunnerProbe>();
const supportedArgumentProbes = new Map<string, RunnerProbe>();
const unknownOptionProbes = new Map<string, RunnerProbe>();
let validVitestOptionProbe: RunnerProbe;

describe("snapshot runner argv candidates (#1469)", () => {
  heavyBeforeAll(["db", 180_000], () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "ut-tdd-argv-preload-"));
    preloadPath = join(fixtureRoot, "spawn-intercept-preload.cjs");
    writeFileSync(
      preloadPath,
      [
        'const fs = require("node:fs");',
        'const childProcess = require("node:child_process");',
        'const { syncBuiltinESMExports } = require("node:module");',
        'const sentinel = "UT_TDD_SPAWN_INTERCEPT_SENTINEL";',
        'const fakeRunner = process.env.UT_TDD_ARGV_TEST_MODE === "fake-runner";',
        `const resolverGitReads = new Set(${JSON.stringify(SNAPSHOT_RESOLVER_GIT_READS)});`,
        "const nativeExistsSync = fs.existsSync;",
        'fs.existsSync = (path, ...args) => fakeRunner && String(path).replaceAll("\\\\", "/").toLowerCase().endsWith("/npm/bin/npm-cli.js") ? true : nativeExistsSync(path, ...args);',
        "const record = (method, command, args = []) => {",
        "  const logPath = process.env.UT_TDD_ARGV_TEST_SPAWN_LOG;",
        "  if (logPath) fs.appendFileSync(logPath, JSON.stringify({ method, command: String(command), args: Array.from(Array.isArray(args) ? args : [], String) }) + String.fromCharCode(10));",
        "};",
        "const recordAndDeny = (method, command, args = []) => {",
        "  record(method, command, args);",
        "  throw new Error(sentinel);",
        "};",
        'const fakeResult = (status, stdout = "") => ({ pid: 1, output: [null, stdout, ""], stdout, stderr: "", status, signal: null });',
        "childProcess.spawnSync = (command, args = []) => {",
        '  record("spawnSync", command, args);',
        '  const normalizedCommand = String(command).replaceAll("\\\\", "/").toLowerCase();',
        '  const normalizedArgs = Array.from(Array.isArray(args) ? args : [], String).map((arg) => arg.replaceAll("\\\\", "/").toLowerCase());',
        '  const executable = normalizedCommand.split("/").pop();',
        "  if (!fakeRunner) {",
        '    if ((executable === "git" || executable === "git.exe") && resolverGitReads.has(normalizedArgs.join(" "))) {',
        '      const key = normalizedArgs.join(" ");',
        '      if (key === "rev-parse --show-toplevel") return fakeResult(0, process.cwd());',
        '      if (key === "rev-parse head") return fakeResult(0, "0000000000000000000000000000000000000000");',
        '      if (key === "status --porcelain=v1 -z --untracked-files=all") return fakeResult(0);',
        "      return fakeResult(1);",
        "    }",
        "    throw new Error(sentinel);",
        "  }",
        '  if (executable === "git" || executable === "git.exe") {',
        '    if (normalizedArgs.includes("clone")) throw new Error("unexpected git clone request");',
        '    if (normalizedArgs.join(" ") === "rev-parse --show-toplevel") return fakeResult(1);',
        '    throw new Error("unexpected Git request: " + normalizedArgs.join(" "));',
        "  }",
        '  if (executable === "whoami") return fakeResult(0, "TEST\\\\runner\\n");',
        '  if (executable === "attrib" || executable === "icacls") return fakeResult(0);',
        '  if (normalizedCommand === process.execPath.replaceAll("\\\\", "/").toLowerCase()) {',
        '    if (normalizedArgs[0]?.endsWith("/npm/bin/npm-cli.js") && normalizedArgs[1] === "ci") return fakeResult(0);',
        '    if (normalizedArgs.slice(0, 3).join(" ") === "src/cli.ts db rebuild") return fakeResult(0);',
        '    if (normalizedArgs[0]?.endsWith("node_modules/vitest/vitest.mjs") && normalizedArgs[1] === "run") return fakeResult(0);',
        "  }",
        '  throw new Error("unexpected child process request: " + command);',
        "};",
        'childProcess.spawn = (command, args = []) => recordAndDeny("spawn", command, args);',
        'childProcess.exec = (command) => recordAndDeny("exec", command);',
        'childProcess.execSync = (command, args) => recordAndDeny("execSync", command, args);',
        'childProcess.execFile = (command, args = []) => recordAndDeny("execFile", command, args);',
        'childProcess.execFileSync = (command, args = []) => recordAndDeny("execFileSync", command, args);',
        'childProcess.fork = (modulePath, args = []) => recordAndDeny("fork", modulePath, args);',
        "syncBuiltinESMExports();",
        // runSnapshotTests rejects uid=0 before it can reach the intercepted spawn.
        // Override only in these short-lived child processes; no repository process is affected.
        'if (process.platform === "linux" && typeof process.getuid === "function") Object.defineProperty(process, "getuid", { configurable: true, value: () => 1000 });',
        "",
      ].join("\n"),
      "utf8",
    );

    // Preconditions intentionally run outside every it.fails candidate. This exercises a
    // normal-arguments Node child with an ESM named import, proving both the preload and
    // syncBuiltinESMExports interception are active before any candidate can be marked Red.
    const controlLog = join(fixtureRoot, "control.jsonl");
    const control = runChild(
      [
        "--input-type=module",
        "-e",
        `import { spawnSync } from "node:child_process"; try { spawnSync("intercept-control", ["normal-args"]); process.exitCode = 7; } catch (error) { if (String(error).includes("${SENTINEL}")) { console.error("${SENTINEL}"); } else { console.error(error); process.exitCode = 8; } }`,
      ],
      controlLog,
    );
    expect(control.error).toBeUndefined();
    expect(control.status).toBe(0);
    expect(control.signal).toBeNull();
    expect(control.stderr.trim()).toBe(SENTINEL);
    expect(readSpawnCalls(controlLog)).toEqual([
      { method: "spawnSync", command: "intercept-control", args: ["normal-args"] },
    ]);

    // The valid-args control runs before candidates too. It traverses only the resolver's
    // modeled Git reads, then logs and refuses clone without executing that forbidden stage.
    validVitestOptionProbe = runRunnerProbe(["--reporter=dot"], "valid-vitest-option");
    expect(validVitestOptionProbe.result.status).toBeGreaterThan(0);
    expect(outputOf(validVitestOptionProbe)).toContain(SENTINEL);
    expect(outputOf(validVitestOptionProbe)).not.toMatch(
      /(?:unknown|unrecognized)[^\r\n]*(?:option|argument)/i,
    );
    expect(
      validVitestOptionProbe.calls
        .slice(0, -1)
        .every(({ command, args }) => isSnapshotResolverGitRead(command, args)),
    ).toBe(true);
    expect(validVitestOptionProbe.calls.at(-1)?.args[0]?.toLowerCase()).toBe("clone");

    // Execute every runner child during setup, where infrastructure failures cannot be
    // absorbed by it.fails. Their observations are reused below without respawning.
    for (const flag of ["--help", "-h"]) {
      const name = flag === "--help" ? "long-help" : "short-help";
      const probe = runRunnerProbe([flag], name);
      if (probe.result.status !== 0) {
        expect(outputOf(probe), `${name} unexpected abnormal exit`).toContain(SENTINEL);
      }
      helpProbes.set(flag, probe);
    }

    for (const testCase of UNKNOWN_OPTION_CASES) {
      const probe = runRunnerProbe([testCase.option], testCase.key);
      assertExpectedPreloadBoundary(probe, testCase.key, testCase.option);
      unknownOptionProbes.set(testCase.key, probe);
    }
    expect(helpProbes.size).toBe(2);
    expect(helpProbes.has("--help")).toBe(true);
    expect(helpProbes.has("-h")).toBe(true);
    expect(unknownOptionProbes.size).toBe(UNKNOWN_OPTION_CASES.length);
    for (const testCase of UNKNOWN_OPTION_CASES) {
      expect(unknownOptionProbes.has(testCase.key)).toBe(true);
    }

    for (const testCase of WATCH_BATCH_REJECTION_CASES) {
      const probe = runRunnerProbe([...testCase.args], testCase.key);
      expect(
        probe.result.status,
        `${testCase.name} keeps the batch-only rejection`,
      ).toBeGreaterThan(0);
      expect(outputOf(probe)).toContain("batch-only");
      expect(forbiddenCloneOrVitestCount(probe.calls)).toBe(0);
      watchProbes.set(testCase.key, probe);
    }

    // Each probe fakes every runner child command. It reaches the Vitest argv boundary
    // without cloning, installing dependencies, rebuilding the DB, or running Vitest.
    for (const testCase of SUPPORTED_ARGUMENT_CASES) {
      supportedArgumentProbes.set(testCase.key, runFakeRunnerProbe(testCase.args, testCase.key));
    }
  });

  heavyAfterAll("teardown", () => {
    if (fixtureRoot) removeTestTree(fixtureRoot);
    for (const root of fakeRunnerRoots) removeTestTree(root);
  });

  it("keeps the child-only spawn fence live for the test harness", () => {
    // beforeAll completed this normal-args ESM named-import control before any candidate.
    const controlLog = join(fixtureRoot, "control.jsonl");
    expect(readSpawnCalls(controlLog)).toEqual([
      { method: "spawnSync", command: "intercept-control", args: ["normal-args"] },
    ]);
  });

  it("U-SNAPARG-001 --help prints usage and exits successfully before any child command", () => {
    assertHelpUsage(requireHelpProbe("--help"));
  });

  it("U-SNAPARG-001 -h prints usage and exits successfully before any child command", () => {
    assertHelpUsage(requireHelpProbe("-h"));
  });

  for (const testCase of UNKNOWN_OPTION_CASES) {
    it(`U-SNAPARG-002 rejects ${testCase.name} before clone or Vitest`, () => {
      const probe = unknownOptionProbes.get(testCase.key);
      if (!probe) throw new Error(`missing ${testCase.key} precondition probe`);
      const output = outputOf(probe);
      expectNoForbiddenSnapshotStages(probe.calls, testCase.key);
      // The status code is intentionally unconstrained; require a diagnostic naming this option.
      expect(probe.result.status).toBeGreaterThan(0);
      expect(hasUnknownOptionDiagnostic(output, testCase.option)).toBe(true);
    });
    it(`U-SNAPARG-002 lists accepted options for ${testCase.name}`, () => {
      const probe = unknownOptionProbes.get(testCase.key);
      if (!probe) throw new Error(`missing ${testCase.key} precondition probe`);
      const tokens =
        outputOf(probe).match(
          /(?<![\w-])--[A-Za-z][\w-]*(?![\w-])|(?<![\w-])-[A-Za-z](?![\w-])/g,
        ) ?? [];
      for (const option of ACCEPTED_OPTION_TOKENS) expect(tokens).toContain(option);
    });
    it(`U-SNAPARG-002 explains the separator for ${testCase.name}`, () => {
      const probe = unknownOptionProbes.get(testCase.key);
      if (!probe) throw new Error(`missing ${testCase.key} precondition probe`);
      expect(outputOf(probe)).toMatch(/(?:^|[\s`"'])--(?=$|[\s`"'])/m);
    });
  }

  for (const testCase of WATCH_BATCH_REJECTION_CASES) {
    it(`keeps ${testCase.name} batch-only before clone or Vitest`, () => {
      const probe = watchProbes.get(testCase.key);
      if (!probe) throw new Error(`missing ${testCase.key} compatibility probe`);
      expect(probe.result.status).toBeGreaterThan(0);
      expect(outputOf(probe)).toContain("batch-only");
      expect(forbiddenCloneOrVitestCount(probe.calls)).toBe(0);
    });
  }

  it("does not classify an existing Vitest option as unknown", () => {
    const output = outputOf(validVitestOptionProbe);
    const calls = validVitestOptionProbe.calls;
    const resolverReads = calls.slice(0, -1);

    // A valid option proceeds through modeled read-only Git probes and reaches the
    // recorded clone boundary. The preload throws before the real clone can execute.
    expect(validVitestOptionProbe.result.status).toBeGreaterThan(0);
    expect(output).toContain(SENTINEL);
    expect(output).not.toMatch(/(?:unknown|unrecognized)[^\r\n]*(?:option|argument)/i);
    expect(resolverReads.length).toBe(SNAPSHOT_RESOLVER_GIT_READS.length);
    expect(
      resolverReads.every(({ command, args }) => isSnapshotResolverGitRead(command, args)),
    ).toBe(true);
    expect(forbiddenCloneOrVitestCount(calls)).toBe(1);
    const finalCall = calls.at(-1);
    expect(finalCall?.command.toLowerCase()).toMatch(/(?:^|[\\/])git(?:\.exe)?$/);
    expect(finalCall?.args[0]?.toLowerCase()).toBe("clone");
  });

  for (const testCase of SUPPORTED_ARGUMENT_CASES) {
    it(`preserves ${testCase.name} at the fake Vitest boundary`, () => {
      const probe = supportedArgumentProbes.get(testCase.key);
      if (!probe) throw new Error(`missing ${testCase.key} compatibility probe`);
      assertFakeVitestInvocation(probe, testCase.args);
    });
  }
});
