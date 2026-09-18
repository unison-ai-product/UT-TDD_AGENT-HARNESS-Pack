import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { analyzeGithubCiPolicy, type GithubWorkflowDoc } from "../src/lint/github-ci-policy.ts";

const RUNNER = "node scripts/run-vitest-snapshot.ts";
const FAST_EXCLUDES = [
  "tests/cli-surface.test.ts",
  "tests/db-projection-ingestion.test.ts",
  "tests/distribution-acceptance.test.ts",
  "tests/doctor.test.ts",
  "tests/drive-db-registration.test.ts",
  "tests/projection-writer.test.ts",
  "tests/review-green-command-projection.test.ts",
  "tests/runtime-hook-entrypoints.test.ts",
] as const;
const CLI_FILES = [
  "tests/cli-surface.test.ts",
  "tests/distribution-acceptance.test.ts",
  "tests/runtime-hook-entrypoints.test.ts",
] as const;
const CLI_FILE_SET = new Set<string>(CLI_FILES);
const WINDOWS_EXCLUDES = FAST_EXCLUDES.filter((file) => !CLI_FILE_SET.has(file));

interface PackageDocument {
  scripts?: Record<string, unknown>;
}

interface WorkflowStep {
  name?: unknown;
  run?: unknown;
  id?: unknown;
  if?: unknown;
}

interface WorkflowDocument {
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
}

function packageDocument(): PackageDocument {
  return JSON.parse(readFileSync("package.json", "utf8")) as PackageDocument;
}

function runnerArguments(command: unknown, scriptName: string): string[] {
  if (typeof command !== "string" || !command.startsWith(`${RUNNER} `)) {
    throw new Error(`${scriptName} must invoke the sealed snapshot runner`);
  }
  return command
    .slice(RUNNER.length + 1)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function exclusionArguments(arguments_: readonly string[], scriptName: string): string[] {
  const excluded: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] !== "--exclude" || typeof arguments_[index + 1] !== "string") {
      throw new Error(`${scriptName} must contain only --exclude <path> arguments`);
    }
    excluded.push(arguments_[index + 1]);
    index += 1;
  }
  return excluded;
}

function explicitFiles(arguments_: readonly string[], scriptName: string): string[] {
  if (arguments_.some((argument) => argument.startsWith("--"))) {
    throw new Error(`${scriptName} must contain explicit test paths only`);
  }
  return [...arguments_];
}

function expectedWindowsArguments(document: PackageDocument): string[] {
  const scripts = document.scripts;
  if (!scripts) throw new Error("package.json scripts must be present");
  const fast = exclusionArguments(runnerArguments(scripts["test:fast"], "test:fast"), "test:fast");
  const cli = explicitFiles(runnerArguments(scripts["test:cli"], "test:cli"), "test:cli");
  const cliFiles = new Set(cli);
  const unionExclusions = fast.filter((file) => !cliFiles.has(file));
  return unionExclusions.flatMap((file) => ["--exclude", file]);
}

function assertWindowsSnapshotContract(document: PackageDocument): void {
  const scripts = document.scripts;
  if (!scripts) throw new Error("package.json scripts must be present");

  const fastArguments = runnerArguments(scripts["test:fast"], "test:fast");
  expect(fastArguments).toEqual(FAST_EXCLUDES.flatMap((file) => ["--exclude", file]));

  const cliArguments = runnerArguments(scripts["test:cli"], "test:cli");
  expect(cliArguments).toEqual([...CLI_FILES]);

  const windowsArguments = runnerArguments(scripts["test:windows"], "test:windows");
  expect(windowsArguments).toEqual(expectedWindowsArguments(document));
}

function mutatedPackage(mutator: (scripts: Record<string, unknown>) => void): PackageDocument {
  const document = packageDocument();
  if (!document.scripts) throw new Error("test fixture must contain package scripts");
  mutator(document.scripts);
  return document;
}

function workflowDocument(): GithubWorkflowDoc {
  return {
    file: ".github/workflows/harness-check.yml",
    content: readFileSync(".github/workflows/harness-check.yml", "utf8"),
    profile: "source",
    role: "runtime",
  };
}

function workflowShape(content = workflowDocument().content): WorkflowDocument {
  return parseYaml(content) as WorkflowDocument;
}

function mutatedWorkflow(mutator: (workflow: WorkflowDocument) => void): GithubWorkflowDoc {
  const document = workflowDocument();
  const workflow = workflowShape(document.content);
  mutator(workflow);
  return { ...document, content: stringifyYaml(workflow) };
}

function assertWindowsWorkflowContract(document: GithubWorkflowDoc): void {
  const windows = workflowShape(document.content).jobs?.["harness-check-windows"];
  if (!windows?.steps) throw new Error("harness-check-windows steps must be present");
  const steps = windows.steps;
  const runCommands = steps.flatMap((step) => (typeof step.run === "string" ? [step.run] : []));
  const snapshotInvocations = runCommands.filter((run) => run.includes("npm run test:windows"));
  if (snapshotInvocations.length !== 1) {
    throw new Error("Windows full lane must invoke test:windows exactly once");
  }
  if (
    runCommands.some(
      (run) =>
        run.includes("npm run test:fast") ||
        run.includes("npm run test:cli") ||
        /(?:^|\s)(?:bunx|vitest)(?:\s|$)/.test(run),
    )
  ) {
    throw new Error("Windows full lane must not bypass the single sealed snapshot script");
  }
  const named = new Map(
    steps.flatMap((step) =>
      typeof step.name === "string" && typeof step.run === "string"
        ? [[step.name, step] as const]
        : [],
    ),
  );
  for (const name of [
    "typecheck (tsc --noEmit)",
    "db rebuild (deterministic projection on Windows SQLite)",
    "doctor (toolchain scope)",
  ]) {
    if (!named.has(name)) throw new Error(`Windows full lane is missing ${name}`);
  }
}

function assertWorkflowPolicy(document: GithubWorkflowDoc): void {
  const result = analyzeGithubCiPolicy([document]);
  if (!result.ok) {
    throw new Error(result.violations.map((violation) => violation.detail).join("; "));
  }
}

describe("Issue #490 Windows single sealed snapshot contract", () => {
  it("U-CI490-001: keeps test:fast and test:cli and defines test:windows as F union C", () => {
    expect(() => assertWindowsSnapshotContract(packageDocument())).not.toThrow();
  });

  it.each([
    ["missing test:fast", (scripts: Record<string, unknown>) => delete scripts["test:fast"]],
    ["empty test:fast", (scripts: Record<string, unknown>) => (scripts["test:fast"] = "")],
    [
      "wrong test:fast runner",
      (scripts: Record<string, unknown>) => (scripts["test:fast"] = "vitest run"),
    ],
    ["missing test:cli", (scripts: Record<string, unknown>) => delete scripts["test:cli"]],
    ["empty test:cli", (scripts: Record<string, unknown>) => (scripts["test:cli"] = "")],
    [
      "wrong test:cli runner",
      (scripts: Record<string, unknown>) =>
        (scripts["test:cli"] = "vitest run tests/cli-surface.test.ts"),
    ],
  ])("U-CI490-002: rejects %s", (_label, mutator) => {
    expect(() => assertWindowsSnapshotContract(mutatedPackage(mutator))).toThrow();
  });

  it.each([
    [
      "missing exclusion",
      (scripts: Record<string, unknown>) =>
        (scripts["test:windows"] = `${RUNNER} ${WINDOWS_EXCLUDES.slice(1)
          .flatMap((file) => ["--exclude", file])
          .join(" ")}`),
    ],
    [
      "unknown path",
      (scripts: Record<string, unknown>) =>
        (scripts["test:windows"] =
          `${RUNNER} ${WINDOWS_EXCLUDES.flatMap((file) => ["--exclude", file]).join(" ")} --exclude tests/unknown.test.ts`),
    ],
    [
      "CLI path excluded again",
      (scripts: Record<string, unknown>) =>
        (scripts["test:windows"] =
          `${RUNNER} ${WINDOWS_EXCLUDES.flatMap((file) => ["--exclude", file]).join(" ")} --exclude ${CLI_FILES[0]}`),
    ],
    [
      "duplicate exclusion",
      (scripts: Record<string, unknown>) =>
        (scripts["test:windows"] =
          `${RUNNER} --exclude ${WINDOWS_EXCLUDES[0]} ${WINDOWS_EXCLUDES.flatMap((file) => ["--exclude", file]).join(" ")}`),
    ],
    ["raw vitest", (scripts: Record<string, unknown>) => (scripts["test:windows"] = "vitest run")],
    [
      "second snapshot invocation",
      (scripts: Record<string, unknown>) =>
        (scripts["test:windows"] =
          `${RUNNER} ${WINDOWS_EXCLUDES.flatMap((file) => ["--exclude", file]).join(" ")} && ${RUNNER}`),
    ],
  ])("U-CI490-003: rejects test:windows mutation %s", (_label, mutator) => {
    expect(() => assertWindowsSnapshotContract(mutatedPackage(mutator))).toThrow();
  });

  it("U-CI490-004: keeps the Windows workflow on one sealed snapshot invocation", () => {
    expect(() => assertWindowsWorkflowContract(workflowDocument())).not.toThrow();
    expect(() => assertWorkflowPolicy(workflowDocument())).not.toThrow();
  });

  it.each([
    [
      "missing snapshot step",
      (workflow: WorkflowDocument) => {
        const steps = workflow.jobs?.["harness-check-windows"]?.steps;
        if (!steps) return;
        const snapshotIndex = steps.findIndex(
          (step) => step.name === "test — Windows full 回帰 (vitest run, windows leg)",
        );
        if (snapshotIndex >= 0) steps.splice(snapshotIndex, 1);
      },
    ],
    [
      "two snapshot steps",
      (workflow: WorkflowDocument) => {
        const steps = workflow.jobs?.["harness-check-windows"]?.steps;
        if (!steps) return;
        const snapshot = steps.find(
          (step) => step.name === "test — Windows full 回帰 (vitest run, windows leg)",
        );
        if (snapshot) steps.push({ ...snapshot, name: "duplicate Windows snapshot" });
      },
    ],
    [
      "fast and cli split",
      (workflow: WorkflowDocument) => {
        const steps = workflow.jobs?.["harness-check-windows"]?.steps;
        if (!steps) return;
        const snapshot = steps.find(
          (step) => step.name === "test — Windows full 回帰 (vitest run, windows leg)",
        );
        if (snapshot) {
          snapshot.run = "npm run test:fast\nnpm run test:cli";
        }
      },
    ],
    [
      "raw vitest",
      (workflow: WorkflowDocument) => {
        const steps = workflow.jobs?.["harness-check-windows"]?.steps;
        const snapshot = steps?.find(
          (step) => step.name === "test — Windows full 回帰 (vitest run, windows leg)",
        );
        if (snapshot) snapshot.run = "npx vitest run";
      },
    ],
  ])("U-CI490-005: rejects Windows workflow mutation %s", (_label, mutator) => {
    const mutated = mutatedWorkflow(mutator);
    expect(() => assertWindowsWorkflowContract(mutated)).toThrow();
    expect(() => assertWorkflowPolicy(mutated)).toThrow();
  });
});
