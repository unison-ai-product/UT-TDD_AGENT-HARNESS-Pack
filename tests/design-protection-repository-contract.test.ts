import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import * as designProtection from "../src/github/design-protection.ts";
import { analyzeGithubCiPolicy, loadGithubCiPolicyDocs } from "../src/lint/github-ci-policy.ts";
import { gitTextRaw as git } from "./support/git.ts";
import { removeTestTree } from "./support/temp-tree.ts";

/*
 * Contract-first Red: the subject module is intentionally absent in this slice.
 * A module-resolution failure inside it.fails keeps the contract PR green, but is
 * NOT evidence that any individual guard is Red. The implementation PR must run
 * candidate-specific mutation probes before converting these to ordinary tests.
 */

const REPO_ROOT = process.cwd();
const PROTECTION_IF = "$" + "{{ github.event_name == 'pull_request' }}";
const BASE_SHA_EXPR = "$" + "{{ github.sha }}^1";
const GITHUB_SHA_EXPR = "$" + "{{ github.sha }}";
const FULL_LANE_IF = "$" + "{{ steps.classify.outputs.lane == 'full' }}";

interface GateApi {
  IMPLEMENTATION_PATH_PREFIXES: readonly string[];
  PROTECTED_PATH_PREFIXES: readonly string[];
}

async function loadGate(): Promise<GateApi> {
  return designProtection as unknown as GateApi;
}

function initRepo(files: Record<string, string>): { root: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-design-protection-"));
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "UT-TDD test");
  for (const [path, content] of Object.entries(files)) writeRepoFile(root, path, content);
  commit(root, "seed");
  return { root, base: git(root, "rev-parse", "HEAD").trim() };
}

function writeRepoFile(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function commit(root: string, message: string): string {
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", message);
  return git(root, "rev-parse", "HEAD").trim();
}

function removeRepo(root: string): void {
  // `root` is always the unique mkdtempSync path created by initRepo or the test.
  removeTestTree(root);
}

function designStep(): Record<string, unknown> {
  return {
    name: "design-protection (実装 PR の設計書書き換え拒否、fail-close)",
    if: PROTECTION_IF,
    env: { BASE_SHA: BASE_SHA_EXPR },
    run: `node src/cli.ts github design-protection --base "$BASE_SHA" --head "${GITHUB_SHA_EXPR}"`,
  };
}

interface WorkflowStep {
  name?: string;
  if?: string;
  env?: Record<string, string>;
  run?: string;
  "continue-on-error"?: boolean;
}

interface WorkflowShape {
  jobs: Record<string, { steps: WorkflowStep[] }>;
}

function mutateWorkflow(content: string, mutate: (workflow: WorkflowShape) => void): string {
  const workflow = parseYaml(content) as WorkflowShape;
  mutate(workflow);
  return stringifyYaml(workflow);
}

function withProtectionStep(content: string): string {
  return mutateWorkflow(content, (workflow) => {
    const steps = workflow.jobs["harness-check-linux"].steps;
    const existing = steps.filter((step) => step.run?.includes("github design-protection"));
    if (existing.length > 1) throw new Error("fixture contains duplicate design-protection steps");
    if (existing.length === 1) return;
    const branchGuardIndex = steps.findIndex((step) => step.name?.startsWith("branch-type guard"));
    if (branchGuardIndex < 0) throw new Error("fixture is missing the branch-type guard step");
    steps.splice(branchGuardIndex + 1, 0, designStep() as WorkflowStep);
  });
}

function policyWithRuntime(runtimeContent: string) {
  const docs = loadGithubCiPolicyDocs({ runtimeProfile: "source", repoRoot: REPO_ROOT });
  return analyzeGithubCiPolicy(
    docs.map((doc) =>
      doc.role === "runtime" && doc.file === ".github/workflows/harness-check.yml"
        ? { ...doc, content: runtimeContent }
        : doc,
    ),
  );
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function tablePrefixes(content: string, heading: "判定 path" | "保護 path"): string[] | undefined {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`| ${heading} `));
  if (start < 0) return undefined;
  const rows: string[] = [];
  for (let index = start + 2; index < lines.length && lines[index].startsWith("|"); index += 1) {
    const value = /^\|\s*`([^`]+)`\s*\|/.exec(lines[index])?.[1];
    if (value) rows.push(value);
  }
  return rows.length > 0 ? rows : undefined;
}

function inventory(root: string, prefixes: readonly string[]): Map<string, string[]> {
  const tracked = git(root, "ls-files", "-z").split("\0").filter(Boolean);
  return new Map(
    prefixes.map((prefix) => [prefix, tracked.filter((path) => path.startsWith(prefix))]),
  );
}

describe("design-protection L7 candidate Red (PR #981)", () => {
  it("U-DPROT-016: workflowからstepを消す/skip-ifへ変えるとpolicyが拒否する", () => {
    const baseline = withProtectionStep(
      readFileSync(join(REPO_ROOT, ".github/workflows/harness-check.yml"), "utf8"),
    );
    const removed = mutateWorkflow(baseline, (workflow) => {
      workflow.jobs["harness-check-linux"].steps = workflow.jobs[
        "harness-check-linux"
      ].steps.filter((step) => !step.run?.includes("github design-protection"));
    });
    const removedResult = policyWithRuntime(removed);
    expect(removedResult.violations).toContainEqual(
      expect.objectContaining({
        reason: "missing_step",
        detail: expect.stringContaining("design protection"),
      }),
    );
    expect(removedResult.violations).toContainEqual(
      expect.objectContaining({
        reason: "missing_runtime_leg",
        file: ".github/workflows/harness-check.yml",
      }),
    );

    const skipped = mutateWorkflow(baseline, (workflow) => {
      const step = workflow.jobs["harness-check-linux"].steps.find((item) =>
        item.run?.includes("github design-protection"),
      );
      if (!step) throw new Error("proposed step missing from fixture");
      step.if = FULL_LANE_IF;
    });
    expect(policyWithRuntime(skipped).violations).toContainEqual(
      expect.objectContaining({
        reason: "missing_runtime_leg",
        file: ".github/workflows/harness-check.yml",
      }),
    );
  });

  it("U-DPROT-024: workflowとruntime manifestに正しいLinux stepがあればpolicy OK", () => {
    const actual = readFileSync(join(REPO_ROOT, ".github/workflows/harness-check.yml"), "utf8");
    const workflow = parseYaml(actual) as WorkflowShape;
    const installed = workflow.jobs["harness-check-linux"].steps.filter((step) =>
      step.run?.includes("github design-protection"),
    );
    // A synthetic extra step can be ignored by the old policy. Require the
    // completed repository workflow before checking its runtime manifest join.
    expect(installed).toEqual([designStep()]);
    const result = policyWithRuntime(actual);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("U-DPROT-025: order/if/error/window変異はruntime manifest不一致になる", () => {
    const proposed = withProtectionStep(
      readFileSync(join(REPO_ROOT, ".github/workflows/harness-check.yml"), "utf8"),
    );
    const baseline = policyWithRuntime(proposed);
    expect(baseline.ok).toBe(true);
    expect(baseline.violations).toEqual([]);
    const variants: Array<[string, string]> = [
      [
        "if missing",
        mutateWorkflow(proposed, (workflow) => {
          const step = workflow.jobs["harness-check-linux"].steps.find((item) =>
            item.run?.includes("github design-protection"),
          );
          if (!step) throw new Error("proposed step missing from fixture");
          delete step.if;
        }),
      ],
      [
        "always",
        mutateWorkflow(proposed, (workflow) => {
          const step = workflow.jobs["harness-check-linux"].steps.find((item) =>
            item.run?.includes("github design-protection"),
          );
          if (!step) throw new Error("proposed step missing from fixture");
          step.if = "$" + "{{ always() }}";
        }),
      ],
      [
        "before branch-type guard",
        mutateWorkflow(proposed, (workflow) => {
          const steps = workflow.jobs["harness-check-linux"].steps;
          const index = steps.findIndex((step) => step.run?.includes("github design-protection"));
          const [step] = steps.splice(index, 1);
          const branchGuard = steps.findIndex((item) => item.name?.startsWith("branch-type guard"));
          steps.splice(branchGuard, 0, step);
        }),
      ],
      [
        "after typecheck",
        mutateWorkflow(proposed, (workflow) => {
          const steps = workflow.jobs["harness-check-linux"].steps;
          const index = steps.findIndex((step) => step.run?.includes("github design-protection"));
          const [step] = steps.splice(index, 1);
          const typecheck = steps.findIndex((item) => item.run?.includes("npm run typecheck"));
          steps.splice(typecheck + 1, 0, step);
        }),
      ],
      [
        "continue on error",
        mutateWorkflow(proposed, (workflow) => {
          const step = workflow.jobs["harness-check-linux"].steps.find((item) =>
            item.run?.includes("github design-protection"),
          );
          if (!step) throw new Error("proposed step missing from fixture");
          step["continue-on-error"] = true;
        }),
      ],
      [
        "duplicate on windows",
        mutateWorkflow(proposed, (workflow) => {
          workflow.jobs["harness-check-windows"].steps.push(designStep() as WorkflowStep);
        }),
      ],
    ];
    for (const [label, workflow] of variants) {
      const result = policyWithRuntime(workflow);
      expect(result.violations, label).toContainEqual(
        expect.objectContaining({ reason: "missing_runtime_leg" }),
      );
    }
  });

  it("U-DPROT-026:実workflowのmerge第1親基準はmain変更を除外しPR変更を拒否する", () => {
    const workflow = parseYaml(
      readFileSync(join(REPO_ROOT, ".github/workflows/harness-check.yml"), "utf8"),
    ) as WorkflowShape;
    const steps = workflow.jobs["harness-check-linux"].steps.filter((step) =>
      step.run?.includes("github design-protection"),
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]?.if).toBe(PROTECTION_IF);
    expect(steps[0]?.env).toEqual({ BASE_SHA: BASE_SHA_EXPR });
    expect(steps[0]?.run).toBe(designStep().run);
    expect(steps[0]?.run).not.toContain("github.event.before");
    const baseExpression = steps[0]?.env?.BASE_SHA;
    if (baseExpression === undefined) throw new Error("workflow BASE_SHA is required");

    const { root, base: original } = initRepo({
      "src/a.ts": "original source\n",
      "docs/design/harness/x.md": "original main design\n",
      "docs/test-design/harness/y.md": "original PR design\n",
    });
    const invoke = (baseRef: string, head: string) => {
      const run = spawnSync(
        process.execPath,
        [
          join(REPO_ROOT, "src", "cli.ts"),
          "github",
          "design-protection",
          "--base",
          baseRef,
          "--head",
          head,
          "--json",
        ],
        { cwd: root, encoding: "utf8", windowsHide: true },
      );
      expect(run.error?.message ?? "", "production CLI must start").toBe("");
      expect(run.signal, "production CLI must exit normally").toBeNull();
      expect(run.stdout.trim(), `stderr: ${run.stderr}`).not.toBe("");
      return { status: run.status, result: JSON.parse(run.stdout) };
    };
    const fromWorkflow = (head: string) =>
      invoke(baseExpression.replaceAll(GITHUB_SHA_EXPR, head), head);

    try {
      git(root, "checkout", "--quiet", "-b", "main-line", original);
      writeRepoFile(root, "docs/design/harness/x.md", "advanced main design\n");
      const main = commit(root, "main changes x only");
      git(root, "checkout", "--quiet", "-b", "pr-line", original);
      writeRepoFile(root, "src/a.ts", "PR source\n");
      const pr = commit(root, "PR changes source only");
      git(root, "checkout", "--quiet", "main-line");
      git(root, "merge", "--quiet", "--no-ff", "-m", "test merge source PR", pr);
      const merge = git(root, "rev-parse", "HEAD").trim();
      expect(git(root, "rev-parse", `${merge}^1`).trim()).toBe(main);
      expect(git(root, "rev-parse", `${merge}^2`).trim()).toBe(pr);

      const sourceOnly = fromWorkflow(merge);
      expect(sourceOnly.status).toBe(0);
      expect(sourceOnly.result).toMatchObject({
        ok: true,
        classification: "implementation",
        violations: [],
      });
      const staleEventBase = invoke(original, merge);
      expect(staleEventBase.status).toBe(1);
      expect(staleEventBase.result).toMatchObject({
        ok: false,
        classification: "implementation",
        violations: [{ code: "protected-modified", path: "docs/design/harness/x.md" }],
      });

      git(root, "checkout", "--quiet", "-b", "pr-line-two", original);
      writeRepoFile(root, "src/a.ts", "second PR source\n");
      writeRepoFile(root, "docs/test-design/harness/y.md", "PR changes design\n");
      const prTwo = commit(root, "PR changes source and y");
      git(root, "checkout", "--quiet", "-b", "main-line-two", main);
      git(root, "merge", "--quiet", "--no-ff", "-m", "test merge design PR", prTwo);
      const mergeTwo = git(root, "rev-parse", "HEAD").trim();
      expect(git(root, "rev-parse", `${mergeTwo}^1`).trim()).toBe(main);
      expect(git(root, "rev-parse", `${mergeTwo}^2`).trim()).toBe(prTwo);
      const changedDesign = fromWorkflow(mergeTwo);
      expect(changedDesign.status).toBe(1);
      expect(changedDesign.result).toMatchObject({
        ok: false,
        classification: "implementation",
        violations: [{ code: "protected-modified", path: "docs/test-design/harness/y.md" }],
      });

      expect(git(root, "rev-list", "--parents", "-n", "1", original).trim()).toBe(original);
      const parentAbsent = fromWorkflow(original);
      expect(parentAbsent.status).toBe(1);
      expect(parentAbsent.result).toMatchObject({
        ok: false,
        classification: "unknown",
        error: { code: "git-ref-invalid" },
      });
    } finally {
      removeRepo(root);
    }
  }, 60_000);

  it("U-DPROT-027: repository-structureの2表と定数は集合一致し壊れた表を拒否", async () => {
    const api = await loadGate();
    const path = join(REPO_ROOT, "docs/governance/repository-structure.md");
    const content = readFileSync(path, "utf8");
    const implementation = tablePrefixes(content, "判定 path");
    const protectedPaths = tablePrefixes(content, "保護 path");
    expect(implementation).toBeDefined();
    expect(protectedPaths).toBeDefined();
    expect(sorted(api.IMPLEMENTATION_PATH_PREFIXES)).toEqual(sorted(implementation ?? []));
    expect(sorted(api.PROTECTED_PATH_PREFIXES)).toEqual(sorted(protectedPaths ?? []));

    const changedHeading = content.replace("判定 path (どれか", "判定 PATH (どれか");
    expect(changedHeading).not.toBe(content);
    expect(tablePrefixes(changedHeading, "判定 path")).toBeUndefined();

    const emptyTable = removeTableRows(content, "判定 path");
    expect(tablePrefixes(emptyTable, "判定 path")).toBeUndefined();

    const extraRow = content.replace(
      "| `scripts/` | §2 の OS entrypoint |",
      "| `scripts/` | §2 の OS entrypoint |\n| `lib/` | unexpected |",
    );
    expect(extraRow).not.toBe(content);
    expect(sorted(tablePrefixes(extraRow, "判定 path") ?? [])).not.toEqual(
      sorted(api.IMPLEMENTATION_PATH_PREFIXES),
    );

    const reordered = mutateTableRows(content, "判定 path");
    expect(sorted(tablePrefixes(reordered, "判定 path") ?? [])).toEqual(
      sorted(api.IMPLEMENTATION_PATH_PREFIXES),
    );
    expect(
      sorted(tablePrefixes(mutateTableRows(content, "保護 path") ?? "", "保護 path") ?? []),
    ).toEqual(sorted(api.PROTECTED_PATH_PREFIXES));
  });

  it("U-DPROT-030: HEAD git ls-filesで各prefixの存在を確認し全src移動を検出", async () => {
    const api = await loadGate();
    const implementationInventory = inventory(REPO_ROOT, api.IMPLEMENTATION_PATH_PREFIXES);
    const protectedInventory = inventory(REPO_ROOT, api.PROTECTED_PATH_PREFIXES);
    for (const prefix of api.IMPLEMENTATION_PATH_PREFIXES)
      expect(implementationInventory.get(prefix)?.length ?? 0).toBeGreaterThan(0);
    for (const prefix of api.PROTECTED_PATH_PREFIXES)
      expect(protectedInventory.get(prefix)?.length ?? 0).toBeGreaterThan(0);

    const { root } = initRepo({ "src/a.ts": "source\n", "docs/design/harness/x.md": "design\n" });
    try {
      const pathsBefore = inventory(root, ["src/"]);
      expect(pathsBefore.get("src/")?.length ?? 0).toBeGreaterThan(0);
      mkdirSync(join(root, "product"), { recursive: true });
      git(root, "mv", "src/a.ts", "product/a.ts");
      commit(root, "move all implementation files out of src");
      writeRepoFile(root, "src/untracked.ts", "untracked\n");
      const pathsAfter = inventory(root, ["src/"]);
      expect(pathsAfter.get("src/")?.length ?? 0).toBe(0);
      expect(pathsAfter.has("src/")).toBe(true);
    } finally {
      removeRepo(root);
    }
  });
});

function mutateTableRows(content: string, heading: "判定 path" | "保護 path"): string {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`| ${heading} `));
  if (start < 0) return content;
  let end = start + 1;
  while (end < lines.length && lines[end].startsWith("|")) end += 1;
  const rows = lines.slice(start + 2, end);
  lines.splice(start + 2, rows.length, ...rows.reverse());
  return lines.join("\n");
}

function removeTableRows(content: string, heading: "判定 path" | "保護 path"): string {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`| ${heading} `));
  if (start < 0) return content;
  let end = start + 1;
  while (end < lines.length && lines[end].startsWith("|")) end += 1;
  lines.splice(start + 2, end - (start + 2));
  return lines.join("\n");
}
