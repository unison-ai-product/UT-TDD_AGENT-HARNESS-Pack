import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  analyzeGithubCiPolicy,
  type GithubWorkflowDoc,
  loadGithubCiPolicyDocs,
} from "../src/lint/github-ci-policy.ts";
import { runSetup, type SetupDeps } from "../src/setup/index.ts";
import { BUILTIN_GITHUB_TEMPLATES } from "../src/setup/templates.ts";
import { heavyAfterAll, heavyBeforeAll } from "./support/hook-bounds.ts";
import { removeTestTree } from "./support/temp-tree.ts";
import { headSnapshotRoot } from "./support/workspace-roots.ts";

type WorkflowStep = Record<string, unknown> & {
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
};

type Workflow = {
  env?: Record<string, unknown>;
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
};

const WORKFLOW_PATH = join(".github", "workflows", "harness-check.yml");
const HEAD_SNAPSHOT_ROOT = headSnapshotRoot();
const SOURCE_WORKFLOW_PATH = join(HEAD_SNAPSHOT_ROOT, WORKFLOW_PATH);
const SOURCE_POLICY_PATH = join(HEAD_SNAPSHOT_ROOT, "src", "lint", "github-ci-policy.ts");
const SOURCE_WORKFLOW = readFileSync(SOURCE_WORKFLOW_PATH, "utf8");
const SOURCE_TEMPLATE = readFileSync(
  join(HEAD_SNAPSHOT_ROOT, "docs", "templates", "github", "common", "harness-check.yml"),
  "utf8",
);
const SOURCE_POLICY = readFileSync(SOURCE_POLICY_PATH, "utf8");
let cleanGitFixture = "";
let dirtyGitFixture = "";
let nonGitFixture = "";
let activationCommandResult: ReturnType<typeof runBashIn> | undefined;
let cleanDirtyCheckCommandResult: ReturnType<typeof runBashIn> | undefined;
let dirtyCheckCommandResult: ReturnType<typeof runBashIn> | undefined;

function parseWorkflow(source: string): Workflow {
  return parseYaml(source) as Workflow;
}

function allSteps(workflow: Workflow): WorkflowStep[] {
  return Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
}

function stepText(step: WorkflowStep): string {
  return `${step.name ?? ""}\n${step.run ?? ""}\n${step.uses ?? ""}`;
}

function generatedWorkflow(existing?: string): string {
  const repoRoot = mkdtempSync(join(tmpdir(), "ut-tdd-cicons-setup-"));
  const workflowPath = join(repoRoot, WORKFLOW_PATH);
  const files = new Map<string, string>();
  if (existing !== undefined) files.set(workflowPath, existing);

  const deps: SetupDeps = {
    repoRoot,
    now: () => "2026-11-05T00:00:00.000Z",
    gh: () => ({ ok: false, stdout: "" }),
    readText: (path) => files.get(path) ?? null,
    writeText: (path, content) => files.set(path, content),
    confirm: () => true,
    isInteractive: true,
    templates: BUILTIN_GITHUB_TEMPLATES,
  };

  try {
    runSetup({ phase: "0-A", dryRun: false, applyBranchProtection: false }, deps);
    const output = files.get(workflowPath);
    if (output === undefined) throw new Error("setup did not emit the consumer workflow");
    return output;
  } finally {
    removeTestTree(repoRoot);
  }
}

function pinEntries(workflow: Workflow): Array<[string, unknown]> {
  return Object.entries(workflow.env ?? {}).filter(([key]) =>
    /(?:version|release|tag|digest)/i.test(key),
  );
}

function replaceGuardRun(source: string, run: string): string {
  const workflow = parseWorkflow(source);
  let replacements = 0;
  for (const step of allSteps(workflow)) {
    if (stepText(step).includes("github guard")) {
      step.run = run;
      replacements += 1;
    }
  }
  if (replacements !== 1) throw new Error(`expected one github guard step, found ${replacements}`);
  return stringifyYaml(workflow);
}

function replaceSourceGuardDocs(docs: GithubWorkflowDoc[], run: string): GithubWorkflowDoc[] {
  return docs.map((doc) => {
    if (doc.role !== "runtime" && doc.role !== "source_template" && doc.role !== "setup_builtin")
      return doc;
    return { ...doc, content: replaceGuardRun(doc.content, run) };
  });
}

function loadSourcePolicyDocs(): GithubWorkflowDoc[] {
  return loadGithubCiPolicyDocs({
    repoRoot: HEAD_SNAPSHOT_ROOT,
    runtimeProfile: "source",
    setupBuiltinWorkflow: BUILTIN_GITHUB_TEMPLATES["common/harness-check.yml"],
  });
}

function createGitFixture(dirty: boolean): string {
  const repoRoot = mkdtempSync(join(tmpdir(), "ut-tdd-cicons-dirty-check-"));
  try {
    execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
    if (dirty) writeFileSync(join(repoRoot, "setup-output.txt"), "untracked\n", "utf8");
    return repoRoot;
  } catch (error) {
    removeTestTree(repoRoot);
    throw error;
  }
}

function gitBashExecutable(): string {
  if (process.platform !== "win32") return "bash";
  const execPath = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
  const gitRoot = resolve(execPath, "..", "..", "..");
  const bashPath = [join(gitRoot, "bin", "bash.exe"), join(gitRoot, "usr", "bin", "bash.exe")].find(
    existsSync,
  );
  if (!bashPath) throw new Error(`Git for Windows bash.exe was not found from ${execPath}`);
  return bashPath;
}

const BASH_EXECUTABLE = gitBashExecutable();

function runBashIn(cwd: string, command: string) {
  return spawnSync(
    BASH_EXECUTABLE,
    ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", command],
    { cwd, encoding: "utf8" },
  );
}

const LEGACY_GUARD_RUN = [
  "printf '%s\\n' \"$PR_BODY\" > .ut-tdd-pr-body.txt",
  "git log --format=%s -n 20 > .ut-tdd-commit-subjects.txt",
  'node src/cli.ts github guard --head-ref "$HEAD_REF" --base-ref "$BASE_REF" --pr-title "$PR_TITLE" --pr-body-file .ut-tdd-pr-body.txt --commit-file .ut-tdd-commit-subjects.txt',
].join("\n");

const RANGE_GUARD_RUN = [
  "printf '%s\\n' \"$PR_BODY\" > .ut-tdd-pr-body.txt",
  'node src/cli.ts github guard --head-ref "$HEAD_REF" --base-ref "$BASE_REF" --pr-title "$PR_TITLE" --pr-body-file .ut-tdd-pr-body.txt',
].join("\n");

describe("consumer CI workflow registered Red oracles (#1522 / #1523)", () => {
  heavyBeforeAll("git", () => {
    cleanGitFixture = createGitFixture(false);
    dirtyGitFixture = createGitFixture(true);
    nonGitFixture = mkdtempSync(join(tmpdir(), "ut-tdd-cicons-non-git-"));
  });

  heavyAfterAll("teardown", () => {
    if (cleanGitFixture) removeTestTree(cleanGitFixture);
    if (dirtyGitFixture) removeTestTree(dirtyGitFixture);
    if (nonGitFixture) removeTestTree(nonGitFixture);
  });

  it("precondition: setup emits parseable workflow and detached HEAD inputs exist", () => {
    const generated = generatedWorkflow();
    const steps = allSteps(parseWorkflow(generated));
    expect(steps.length).toBeGreaterThan(0);
    expect(() => parseWorkflow(SOURCE_WORKFLOW)).not.toThrow();
    expect(SOURCE_WORKFLOW).toContain("github guard");
    expect(SOURCE_POLICY).toContain("github guard");
    expect(SOURCE_POLICY).toContain("src/cli.ts github guard");

    const activationStep = steps.find((step) => stepText(step).includes("active.json"));
    if (activationStep?.run) {
      const syntax = spawnSync(
        BASH_EXECUTABLE,
        ["--noprofile", "--norc", "-n", "-c", activationStep.run],
        {
          cwd: cleanGitFixture,
          encoding: "utf8",
        },
      );
      expect(syntax.error).toBeUndefined();
      expect(syntax.status).toBe(0);

      activationCommandResult = runBashIn(cleanGitFixture, activationStep.run);
      expect(activationCommandResult.error).toBeUndefined();
      expect(activationCommandResult.status).not.toBeNull();
      expect(`${activationCommandResult.stdout}\n${activationCommandResult.stderr}`).not.toMatch(
        /syntax error|command not found/i,
      );
    }
  });

  it("U-CICONS-001: activation absence fails rather than skipping all checks", () => {
    const workflow = parseWorkflow(generatedWorkflow());
    const steps = allSteps(workflow);
    const activationStep = steps.find((step) => stepText(step).includes("active.json"));
    expect(activationStep).toBeDefined();
    expect(activationStep?.run).toContain("::error::");
    expect(activationStep?.run).not.toContain("::notice::");
    expect(activationCommandResult).toBeDefined();
    expect(activationCommandResult?.status).not.toBe(0);
    expect(`${activationCommandResult?.stdout}\n${activationCommandResult?.stderr}`).toContain(
      "::error::",
    );

    const gatedChecks = steps.filter((step) =>
      /branch-type guard|typecheck|test|audit quality|doctor --setup-smoke|ut-tdd/i.test(
        stepText(step),
      ),
    );
    expect(gatedChecks.length).toBeGreaterThan(0);
    expect(
      gatedChecks.some((step) => /hashFiles\([^)]*active\.json/.test(String(step.if ?? ""))),
    ).toBe(false);
  });

  it("U-CICONS-002: release setup uses the single top-level version/digest pin", () => {
    const source = generatedWorkflow();
    const workflow = parseWorkflow(source);
    const steps = allSteps(workflow);
    const setup = steps.find((step) => /setup\s+--consumer-runtime-release/.test(step.run ?? ""));
    const releaseDownload = steps.find((step) => {
      const run = step.run ?? "";
      return (
        /\bgh\s+release\s+download\b/i.test(run) ||
        /\b(?:curl|wget)\b[\s\S]*https?:\/\/(?:api\.)?github\.com[\s\S]*\/releases?\/(?:download|assets)\//i.test(
          run,
        )
      );
    });
    const versionPin = pinEntries(workflow).filter(
      ([key]) => /version|release|tag/i.test(key) && !/digest/i.test(key),
    );
    const digestPin = pinEntries(workflow).filter(([key]) => /digest/i.test(key));

    expect(releaseDownload).toBeDefined();
    expect(setup?.run).toContain("--expected-consumer-digest");
    expect(source.match(/^env:\s*$/gm) ?? []).toHaveLength(1);
    expect(versionPin).toHaveLength(1);
    expect(digestPin).toHaveLength(1);
    for (const [, value] of [...versionPin, ...digestPin]) {
      expect(typeof value).toBe("string");
      expect(String(value).trim().length).toBeGreaterThan(0);
      expect(source.split(String(value)).length - 1).toBe(1);
    }
  });

  it("precondition: dirty-check Git and Bash fixtures are independently executable", () => {
    expect(cleanGitFixture).not.toBe("");
    expect(dirtyGitFixture).not.toBe("");
    const cleanStatus = execFileSync("git", ["status", "--porcelain"], {
      cwd: cleanGitFixture,
      encoding: "utf8",
    });
    const dirtyStatus = execFileSync("git", ["status", "--porcelain"], {
      cwd: dirtyGitFixture,
      encoding: "utf8",
    });
    expect(cleanStatus.trim()).toBe("");
    expect(dirtyStatus.trim().length).toBeGreaterThan(0);

    const shell = runBashIn(cleanGitFixture, "exit 0");
    expect(shell.error).toBeUndefined();
    expect(shell.status).toBe(0);

    const dirtyCheck = allSteps(parseWorkflow(generatedWorkflow())).find((step) =>
      /git status --porcelain/.test(step.run ?? ""),
    );
    if (dirtyCheck?.run) {
      const syntax = spawnSync(
        BASH_EXECUTABLE,
        ["--noprofile", "--norc", "-n", "-c", dirtyCheck.run],
        {
          cwd: cleanGitFixture,
          encoding: "utf8",
        },
      );
      expect(syntax.error).toBeUndefined();
      expect(syntax.status).toBe(0);

      cleanDirtyCheckCommandResult = runBashIn(cleanGitFixture, dirtyCheck.run);
      expect(cleanDirtyCheckCommandResult.error).toBeUndefined();
      expect(cleanDirtyCheckCommandResult.status).not.toBeNull();
      expect(
        `${cleanDirtyCheckCommandResult.stdout}\n${cleanDirtyCheckCommandResult.stderr}`,
      ).not.toMatch(/syntax error|command not found/i);

      const dirtySyntax = spawnSync(
        BASH_EXECUTABLE,
        ["--noprofile", "--norc", "-n", "-c", dirtyCheck.run],
        {
          cwd: dirtyGitFixture,
          encoding: "utf8",
        },
      );
      expect(dirtySyntax.error).toBeUndefined();
      expect(dirtySyntax.status).toBe(0);

      dirtyCheckCommandResult = runBashIn(dirtyGitFixture, dirtyCheck.run);
      expect(dirtyCheckCommandResult.error).toBeUndefined();
      expect(dirtyCheckCommandResult.status).not.toBeNull();
      expect(`${dirtyCheckCommandResult.stdout}\n${dirtyCheckCommandResult.stderr}`).not.toMatch(
        /syntax error|command not found/i,
      );
    }
  });

  it("U-CICONS-003: generated dirty check passes clean and fails dirty", () => {
    const workflow = parseWorkflow(generatedWorkflow());
    const steps = allSteps(workflow);
    const setupIndex = steps.findIndex((step) =>
      /setup\s+--consumer-runtime-release/.test(step.run ?? ""),
    );
    const dirtyCheckIndex = steps.findIndex((step) =>
      /git status --porcelain/.test(step.run ?? ""),
    );
    const dirtyStatus = execFileSync("git", ["status", "--porcelain"], {
      cwd: dirtyGitFixture,
      encoding: "utf8",
    });
    const dirtyCheckDiagnostic = [
      `dirtyCheck.run=${JSON.stringify(steps[dirtyCheckIndex]?.run)}`,
      `dirtyGitStatus=${JSON.stringify(dirtyStatus)}`,
      `bash.stdout=${JSON.stringify(dirtyCheckCommandResult?.stdout)}`,
      `bash.stderr=${JSON.stringify(dirtyCheckCommandResult?.stderr)}`,
    ].join("\n");

    expect(setupIndex).toBeGreaterThanOrEqual(0);
    expect(dirtyCheckIndex).toBeGreaterThan(setupIndex);
    expect(steps[dirtyCheckIndex]?.run).toBeDefined();
    expect(cleanDirtyCheckCommandResult).toBeDefined();
    expect(dirtyCheckCommandResult).toBeDefined();
    expect(cleanDirtyCheckCommandResult?.status).toBe(0);
    expect(dirtyCheckCommandResult?.status, dirtyCheckDiagnostic).not.toBe(0);
  });

  it("U-CICONS-003b: dirty check fails closed outside a Git worktree", () => {
    const dirtyCheck = allSteps(parseWorkflow(generatedWorkflow())).find((step) =>
      /git status --porcelain/.test(step.run ?? ""),
    );
    expect(dirtyCheck?.run).toBeDefined();
    const result = runBashIn(nonGitFixture, dirtyCheck?.run ?? "");
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "Unable to inspect consumer checkout after runtime setup.",
    );
  });

  it("precondition: generated workflow is parseable and pin keys can be inventoried", () => {
    const initial = parseWorkflow(generatedWorkflow());
    expect(initial.env ?? {}).toEqual(parseWorkflow(stringifyYaml(initial)).env ?? {});
    expect(pinEntries(initial)).toEqual(
      Object.entries(initial.env ?? {}).filter(([key]) =>
        /(?:version|release|tag|digest)/i.test(key),
      ),
    );
  });

  it("U-CICONS-004: setup regeneration preserves changed consumer pins", () => {
    const initial = parseWorkflow(generatedWorkflow());
    const versionKey =
      pinEntries(initial).find(
        ([key]) => /version|release|tag/i.test(key) && !/digest/i.test(key),
      )?.[0] ?? "";
    const digestKey = pinEntries(initial).find(([key]) => /digest/i.test(key))?.[0] ?? "";
    expect(versionKey).not.toBe("");
    expect(digestKey).not.toBe("");

    const version = "99.8.7";
    const digest = `sha256:${"a".repeat(64)}`;
    const existing = stringifyYaml({
      ...initial,
      env: { ...(initial.env ?? {}), [versionKey]: version, [digestKey]: digest },
    });
    const regeneratedSource = generatedWorkflow(existing);
    const regenerated = parseWorkflow(regeneratedSource);

    expect(regenerated.env?.[versionKey]).toBe(version);
    expect(regenerated.env?.[digestKey]).toBe(digest);
    expect(regeneratedSource.match(/^env:\s*$/gm) ?? []).toHaveLength(1);
  });

  it("U-CICONS-005: first generation provides one nonempty default pin pair", () => {
    const source = generatedWorkflow();
    const workflow = parseWorkflow(source);
    const versionPin = pinEntries(workflow).filter(
      ([key]) => /version|release|tag/i.test(key) && !/digest/i.test(key),
    );
    const digestPin = pinEntries(workflow).filter(([key]) => /digest/i.test(key));

    expect(source.match(/^env:\s*$/gm) ?? []).toHaveLength(1);
    expect(versionPin).toHaveLength(1);
    expect(digestPin).toHaveLength(1);
    for (const [, value] of [...versionPin, ...digestPin]) {
      expect(typeof value).toBe("string");
      expect(String(value).trim().length).toBeGreaterThan(0);
      expect(source.split(String(value)).length - 1).toBe(1);
    }
  });

  it("U-CICONS-011: generated checkout fetches full history", () => {
    const workflow = parseWorkflow(generatedWorkflow());
    const checkout = allSteps(workflow).find((step) =>
      /^actions\/checkout@/i.test(step.uses ?? ""),
    );
    expect(checkout).toBeDefined();
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
  });

  it("U-CICONS-012: generated guard delegates range discovery to --base-ref", () => {
    const workflow = parseWorkflow(generatedWorkflow());
    const guard = allSteps(workflow).find((step) => stepText(step).includes("github guard"));
    expect(guard).toBeDefined();
    expect(guard?.run).toContain("--base-ref");
    expect(guard?.run).not.toContain("--commit-file");
    expect(guard?.run).not.toMatch(/git\s+log[^\n]*>\s*\S+/);
  });

  it("control: only pull_request events supply a PR title to the guard", () => {
    const expected =
      "$" + "{{ github.event_name == 'pull_request' && github.event.pull_request.title || '' }}";
    for (const source of [generatedWorkflow(), SOURCE_WORKFLOW, SOURCE_TEMPLATE]) {
      const workflow = parseWorkflow(source);
      const guard = allSteps(workflow).find((step) => stepText(step).includes("github guard"));
      expect(guard?.env?.PR_TITLE).toBe(expected);
      expect(String(guard?.env?.PR_TITLE)).not.toContain("head_commit.message");
    }
  });

  it("precondition: snapshot workflow and policy contain one source guard contract input", () => {
    const workflow = parseWorkflow(SOURCE_WORKFLOW);
    const guards = allSteps(workflow).filter((step) => stepText(step).includes("github guard"));
    const policyLines = SOURCE_POLICY.split(/\r?\n/).filter((line) =>
      line.includes("node src/cli.ts github guard"),
    );

    expect(guards).toHaveLength(1);
    expect(policyLines.length).toBeGreaterThan(0);
    expect(SOURCE_WORKFLOW_PATH).toContain(".github");
    expect(SOURCE_POLICY_PATH).toContain("github-ci-policy.ts");
  });

  it("U-CICONS-013: source harness-check calls range guard without precomputed subjects", () => {
    const workflow = parseWorkflow(SOURCE_WORKFLOW);
    const guard = allSteps(workflow).find((step) => stepText(step).includes("github guard"));
    const source = String(guard?.run ?? "");

    expect(guard).toBeDefined();
    expect(source).toContain("--base-ref");
    expect(source).not.toContain("--commit-file");
    expect(SOURCE_WORKFLOW).not.toMatch(/git\s+log[^\n]*>\s*\S+/);
  });

  it("precondition: policy baseline and both rewritten source docs are valid inputs", () => {
    const docs = loadSourcePolicyDocs();
    expect(
      docs.some(
        (doc) => doc.role === "runtime" && doc.file === ".github/workflows/harness-check.yml",
      ),
    ).toBe(true);
    expect(docs.some((doc) => doc.role === "source_template")).toBe(true);
    expect(docs.some((doc) => doc.role === "setup_builtin")).toBe(true);
    expect(analyzeGithubCiPolicy(docs).ok).toBe(true);

    const legacyDocs = replaceSourceGuardDocs(docs, LEGACY_GUARD_RUN);
    const rangeDocs = replaceSourceGuardDocs(docs, RANGE_GUARD_RUN);
    expect(legacyDocs).toHaveLength(docs.length);
    expect(rangeDocs).toHaveLength(docs.length);
    expect(legacyDocs.every((doc) => parseWorkflow(doc.content) !== undefined)).toBe(true);
    expect(rangeDocs.every((doc) => parseWorkflow(doc.content) !== undefined)).toBe(true);
    expect(legacyDocs.find((doc) => doc.role === "runtime")?.content).toContain("--commit-file");
    expect(rangeDocs.find((doc) => doc.role === "runtime")?.content).not.toContain("--commit-file");
  });

  it("U-CICONS-014: policy expected guard command owns range discovery", () => {
    const expectedGuardLines = SOURCE_POLICY.split(/\r?\n/).filter((line) =>
      line.includes("node src/cli.ts github guard"),
    );
    expect(expectedGuardLines.length).toBeGreaterThan(0);
    expect(expectedGuardLines.every((line) => line.includes("--base-ref"))).toBe(true);
    expect(expectedGuardLines.every((line) => !line.includes("--commit-file"))).toBe(true);
  });

  it("U-CICONS-014: CI policy denies the legacy precomputed commit list", () => {
    const baselineDocs = loadSourcePolicyDocs();
    const legacyDocs = replaceSourceGuardDocs(baselineDocs, LEGACY_GUARD_RUN);
    expect(analyzeGithubCiPolicy(legacyDocs).ok).toBe(false);
  });

  it("U-CICONS-014: CI policy accepts guard-owned base range", () => {
    const baselineDocs = loadSourcePolicyDocs();
    const rangeDocs = replaceSourceGuardDocs(baselineDocs, RANGE_GUARD_RUN);
    expect(analyzeGithubCiPolicy(rangeDocs).ok).toBe(true);
  });
});
