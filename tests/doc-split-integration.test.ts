import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFullDoctorCheckDefinitions } from "../src/doctor/check-registry.ts";
import { nodeDoctorDeps } from "../src/doctor/runtime-state.ts";
import {
  classifyDoc,
  type DocSplitBaseline,
  measureDoc,
  parseDocSplitBaseline,
} from "../src/lint/doc-split.ts";
import { checkDocSplit, loadDocSplitSources } from "../src/lint/doc-split-inputs.ts";
import { heavyAfterAll, heavyBeforeAll } from "./support/hook-bounds.ts";
import { removeTestTree } from "./support/temp-tree.ts";
import { headSnapshotRoot } from "./support/workspace-roots.ts";

const BASELINE_PATH = "docs/governance/doc-split-baseline.json";
const L6_ROOT = "docs/design/harness/L6-function-design/";
const L7_ROOT = "docs/test-design/harness/";

interface BaselineFixture {
  root: string;
  path: string;
}

let authorRoot = "";
let scratchRoot = "";
let liveBaseline: DocSplitBaseline | null = null;
let largestBaselineFixture: BaselineFixture | null = null;
let largestL7BaselineFixture: BaselineFixture | null = null;
let initialGrowthRoot = "";
let initialNewEntryRoot = "";
let cliGreenRoot = "";
let cliViolationRoot = "";

function writeFixtureFile(root: string, relativePath: string, content: string): void {
  const absolutePath = join(root, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf8");
}

function initializeGit(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Doc Split Integration Test"], { cwd: root });
}

function commitAll(root: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-m", message], { cwd: root, stdio: "ignore" });
}

function pointOriginMainAtHead(root: string): void {
  execFileSync("git", ["remote", "add", "origin", root], { cwd: root });
  execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: root });
}

function documentText(lines: number, headings: number): string {
  const bodyLines = Array.from({ length: lines - headings }, () => "body");
  const headingLines = Array.from({ length: headings }, (_, index) => `## H${index + 1}`);
  return [...bodyLines, ...headingLines].join("\n");
}

function countMarkdownFiles(directory: string): number {
  let count = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) count += countMarkdownFiles(path);
    else if (entry.isFile() && entry.name.endsWith(".md")) count += 1;
  }
  return count;
}

function makeInitialBaselineFixture(kind: "grown" | "new-entry"): string {
  const root = join(scratchRoot, `initial-${kind}`);
  mkdirSync(root, { recursive: true });
  initializeGit(root);

  const existingPath = `${L6_ROOT}${kind === "grown" ? "big" : "small"}.md`;
  writeFixtureFile(
    root,
    existingPath,
    documentText(kind === "grown" ? 500 : 1, kind === "grown" ? 20 : 1),
  );
  commitAll(root, "merge-base documents without a doc-split baseline");
  pointOriginMainAtHead(root);

  const currentPath = kind === "grown" ? existingPath : `${L6_ROOT}new.md`;
  const currentLines = kind === "grown" ? 600 : 600;
  writeFixtureFile(root, currentPath, documentText(currentLines, 20));
  writeFixtureFile(
    root,
    BASELINE_PATH,
    JSON.stringify({ [currentPath]: { lines: currentLines, responsibilities: 20 } }, null, 2),
  );
  commitAll(root, `record ${kind} baseline candidate`);
  return root;
}

function copyLiveDocsWithBaseline(label: string, mutationPath?: string): BaselineFixture {
  const root = join(scratchRoot, label);
  mkdirSync(root, { recursive: true });
  const l6Target = join(root, "docs/design/harness");
  const l7Target = join(root, "docs/test-design/harness");
  const baselineTarget = join(root, BASELINE_PATH);
  mkdirSync(dirname(l6Target), { recursive: true });
  mkdirSync(dirname(l7Target), { recursive: true });
  mkdirSync(dirname(baselineTarget), { recursive: true });
  cpSync(join(authorRoot, "docs/design/harness"), l6Target, {
    recursive: true,
  });
  cpSync(join(authorRoot, "docs/test-design/harness"), l7Target, {
    recursive: true,
  });
  copyFileSync(join(authorRoot, BASELINE_PATH), baselineTarget);
  initializeGit(root);
  commitAll(root, "copy the live repository doc-split baseline");
  pointOriginMainAtHead(root);

  if (mutationPath) {
    const absolutePath = join(root, mutationPath);
    const original = readFileSync(absolutePath, "utf8");
    const appended = original.endsWith("\n") ? `${original}added line` : `${original}\nadded line`;
    writeFileSync(absolutePath, appended, "utf8");
  }
  return { root, path: mutationPath ?? "" };
}

function createCliFixture(label: string, violated: boolean): string {
  const root = join(scratchRoot, label);
  const documentPath = `${L6_ROOT}cli-fixture.md`;
  mkdirSync(root, { recursive: true });
  writeFixtureFile(root, documentPath, documentText(500, 20));
  writeFixtureFile(
    root,
    BASELINE_PATH,
    JSON.stringify({ [documentPath]: { lines: 500, responsibilities: 20 } }, null, 2),
  );
  writeFixtureFile(root, ".ut-tdd/harness.db", "temporary read-only CLI fixture\n");
  initializeGit(root);
  commitAll(root, "green doc-split CLI fixture");
  pointOriginMainAtHead(root);
  if (violated) writeFixtureFile(root, documentPath, documentText(501, 20));
  return root;
}

function liveBaselineOrFail(): DocSplitBaseline {
  expect(liveBaseline).not.toBeNull();
  return liveBaseline ?? {};
}

function createViolatingCliResult(root: string) {
  return spawnSync(process.execPath, [join(authorRoot, "src/cli.ts"), "doc-split", "check"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
}

function stateMtimes(root: string): Map<string, number> {
  const stateRoot = join(root, ".ut-tdd");
  const state = new Map<string, number>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      state.set(absolutePath.slice(stateRoot.length), statSync(absolutePath).mtimeMs);
      if (entry.isDirectory()) visit(absolutePath);
    }
  };
  visit(stateRoot);
  return state;
}

heavyBeforeAll(["git", 60000], () => {
  authorRoot = process.cwd();
  scratchRoot = mkdtempSync(join(tmpdir(), "doc-split-integration-"));
  initialGrowthRoot = makeInitialBaselineFixture("grown");
  initialNewEntryRoot = makeInitialBaselineFixture("new-entry");
  cliGreenRoot = createCliFixture("cli-green", false);
  cliViolationRoot = createCliFixture("cli-violation", true);

  const liveBaselinePath = join(authorRoot, BASELINE_PATH);
  if (existsSync(liveBaselinePath)) {
    liveBaseline = parseDocSplitBaseline(readFileSync(liveBaselinePath, "utf8"));
    if (liveBaseline) {
      const entries = Object.entries(liveBaseline);
      const largest = entries.sort((left, right) => right[1].lines - left[1].lines)[0];
      const largestL7 = entries
        .filter(([path]) => path.startsWith(L7_ROOT))
        .sort((left, right) => right[1].lines - left[1].lines)[0];
      if (largest)
        largestBaselineFixture = copyLiveDocsWithBaseline("largest-baseline", largest[0]);
      if (largestL7)
        largestL7BaselineFixture = copyLiveDocsWithBaseline("largest-l7-baseline", largestL7[0]);
    }
  }
}); // 23s measured, bounded per #1063

heavyAfterAll("teardown", () => {
  if (scratchRoot) removeTestTree(scratchRoot);
});

describe("doc-split live repository and CLI integration candidates", () => {
  it("U-DOCSPLIT-020: returns the check result shape for the live repository", () => {
    const result = checkDocSplit(authorRoot);
    expect(typeof result.ok).toBe("boolean");
    expect(Array.isArray(result.messages)).toBe(true);
  });

  it("U-DOCSPLIT-020: accepts the live repository when its baseline is current", () => {
    expect(checkDocSplit(authorRoot).ok).toBe(true);
  });

  it("U-DOCSPLIT-020: loads tracked design and test-design documents", () => {
    const loaded = loadDocSplitSources(authorRoot);
    expect(loaded.sources.length).toBeGreaterThan(0);
  });

  it("U-DOCSPLIT-020: reports no unreadable tracked documents", () => {
    expect(loadDocSplitSources(authorRoot).unreadable).toEqual([]);
  });

  it("U-DOCSPLIT-020: reports the live checked/over/stale/baseline summary", () => {
    const result = checkDocSplit(authorRoot);
    const expectedChecked =
      countMarkdownFiles(join(authorRoot, "docs/design/harness")) +
      countMarkdownFiles(join(authorRoot, "docs/test-design/harness"));
    const expectedBaseline = Object.keys(liveBaseline ?? {}).length;
    expect(result.messages).toContain(
      `checked=${expectedChecked} over=0 stale=0 baseline=${expectedBaseline}`,
    );
  });

  it("U-DOCSPLIT-020: has a parseable live doc-split baseline", () => {
    const baselinePath = join(authorRoot, BASELINE_PATH);
    expect(existsSync(baselinePath)).toBe(true);
    expect(liveBaseline).not.toBeNull();
  });

  it("U-DOCSPLIT-020: records the measured values for every live baseline document", () => {
    const baseline = liveBaselineOrFail();
    for (const [path, expected] of Object.entries(baseline)) {
      const measured = measureDoc({ path, text: readFileSync(join(authorRoot, path), "utf8") });
      expect(expected).toEqual({
        lines: measured.lines,
        responsibilities: measured.responsibilities,
      });
    }
  });

  it("U-DOCSPLIT-020: lists only live documents above their class limit", () => {
    const baseline = liveBaselineOrFail();
    expect(Object.keys(baseline).length).toBeGreaterThan(0);
    const overLimit = Object.entries(baseline).every(([path, expected]) => {
      const text = readFileSync(join(authorRoot, path), "utf8");
      const measured = measureDoc({ path, text });
      const docClass = classifyDoc(path);
      if (docClass === null) return false;
      const lineLimit = docClass === "layer-doc" ? 1200 : 400;
      const responsibilityLimit = docClass === "l6-topic" ? 16 : docClass === "l7-topic" ? 4 : null;
      return (
        expected.lines === measured.lines &&
        expected.responsibilities === measured.responsibilities &&
        (measured.lines > lineLimit ||
          (responsibilityLimit !== null &&
            measured.responsibilities !== null &&
            measured.responsibilities > responsibilityLimit))
      );
    });
    expect(overLimit).toBe(true);
  });

  it("U-DOCSPLIT-020: rejects one appended line in the largest baseline document", () => {
    if (!largestBaselineFixture) return;
    const result = checkDocSplit(largestBaselineFixture.root);
    expect(result.ok).toBe(false);
  });

  it("U-DOCSPLIT-020: names exceeds-baseline for the largest baseline document", () => {
    if (!largestBaselineFixture) return;
    const result = checkDocSplit(largestBaselineFixture.root);
    expect(result.messages.join("\n")).toContain("doc-split-required:exceeds-baseline");
  });

  it("U-DOCSPLIT-020: checks the largest L7 baseline document when one exists", () => {
    if (liveBaseline === null) {
      // This no-baseline control is not Red evidence for the optional L7 append case.
      expect(liveBaseline).toBeNull();
      return;
    }
    const hasL7Entry = Object.keys(liveBaseline).some((path) => path.startsWith(L7_ROOT));
    expect(largestL7BaselineFixture !== null).toBe(hasL7Entry);
    if (!hasL7Entry || !largestL7BaselineFixture) return;
    const result = checkDocSplit(largestL7BaselineFixture.root);
    expect(result.ok).toBe(false);
    expect(result.messages.join("\n")).toContain("doc-split-required:exceeds-baseline");
  });

  it("U-DOCSPLIT-020: rejects a grown initial baseline entry", () => {
    expect(checkDocSplit(initialGrowthRoot).ok).toBe(false);
  });

  it("U-DOCSPLIT-020: reports initial-baseline-grown for the grown entry", () => {
    expect(checkDocSplit(initialGrowthRoot).messages.join("\n")).toContain(
      "doc-split-initial-baseline-grown",
    );
  });

  it("U-DOCSPLIT-020: rejects a new initial baseline entry", () => {
    expect(checkDocSplit(initialNewEntryRoot).ok).toBe(false);
  });

  it("U-DOCSPLIT-020: reports initial-baseline-new-entry for a new document", () => {
    expect(checkDocSplit(initialNewEntryRoot).messages.join("\n")).toContain(
      "doc-split-initial-baseline-new-entry",
    );
  });

  it("U-DOCSPLIT-021: registers doc-split in the full doctor hard-gate definitions", () => {
    const definitions = buildFullDoctorCheckDefinitions(nodeDoctorDeps(headSnapshotRoot()));
    const definition = definitions.find((item) => item.id === "doc-split");
    expect(definition).toBeDefined();
    expect(definition?.profiles).toContain("full");
  });

  it("U-DOCSPLIT-021: the green CLI worktree exits successfully", () => {
    expect(createViolatingCliResult(cliGreenRoot).status).toBe(0);
  });

  it("U-DOCSPLIT-021: the green CLI worktree prints the check summary", () => {
    expect(createViolatingCliResult(cliGreenRoot).stdout).toContain("checked=");
  });

  it("U-DOCSPLIT-021: the violating CLI worktree exits nonzero", () => {
    // Status alone is only a control: an unimplemented command may also exit 1.
    expect(createViolatingCliResult(cliViolationRoot).status).toBe(1);
  });

  it("U-DOCSPLIT-021: the violating CLI worktree prints the baseline finding", () => {
    expect(createViolatingCliResult(cliViolationRoot).stdout).toContain(
      "doc-split-required:exceeds-baseline",
    );
  });

  it("U-DOCSPLIT-021: the CLI leaves fixture .ut-tdd and harness.db mtimes unchanged", () => {
    const before = stateMtimes(cliViolationRoot);
    createViolatingCliResult(cliViolationRoot);
    expect(stateMtimes(cliViolationRoot)).toEqual(before);
  });
});
