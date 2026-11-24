import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { expect } from "vitest";
import {
  checkBaselineConflict,
  evaluateBaselineConflict,
} from "../../src/feedback/baseline-conflict.ts";
import { type GhPrMergePorts, runPrMerge } from "../../src/feedback/review-merge-gate.ts";
import {
  analyzeCodeSize,
  CODE_SIZE_BASELINE_PATH,
  type CodeSizeBaseline,
  type CodeSizeSource,
  measureCodeFile,
  parseCodeSizeBaseline,
  recordForm,
} from "../../src/lint/code-size.ts";
import { checkCodeSize } from "../../src/lint/code-size-inputs.ts";

export const NOW = "2026-11-05T11:00:00.000Z";
export const TARGET = "src/alpha.ts";
export const SMALL_BASELINE = "docs/governance/small-baseline.json";

interface InjectedFinding {
  path: string;
  kind: string;
  reason: string;
}

export interface InjectedGate {
  name: string;
  inScope: (path: string) => boolean;
  baselinePath: string;
  check: (repoRoot: string) => {
    ok: boolean;
    findings: InjectedFinding[];
    summary?: { over: number; stale: number };
  };
}

interface BranchFiles {
  pr: Record<string, string>;
  main: Record<string, string>;
}

export interface Fixture {
  scratchRoot: string;
  base: string;
  work: string;
  baseSha: string;
  headSha: string;
  mainSha: string;
  gitCommonDir: string;
  initialWorktreePaths: string[];
  ownedPreviewPaths: Set<string>;
}

export function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function canonicalPath(path: string): string {
  const absolutePath = resolve(path);
  // A missing owned preview is still removable from the in-memory registry, but
  // realpath cannot resolve it. Keep that branch lexical and non-destructive.
  const canonical = existsSync(absolutePath) ? realpathSync.native(absolutePath) : absolutePath;
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function canonicalExistingPath(path: string): string {
  const absolutePath = resolve(path);
  if (!existsSync(absolutePath)) {
    throw new Error(
      `expected path to exist before canonicalization: ${JSON.stringify(absolutePath)}`,
    );
  }
  const canonical = realpathSync.native(absolutePath);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function canonicalGitCommonDir(path: string): string {
  return canonicalPath(path);
}

function configure(root: string): void {
  git(root, "config", "user.email", "fixture@example.test");
  git(root, "config", "user.name", "fixture");
  git(root, "config", "core.autocrlf", "false");
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
}

export function worktreePaths(root: string): string[] {
  return git(root, "worktree", "list", "--porcelain")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => resolve(line.slice("worktree ".length)));
}

export function changedPaths(root: string, from: string, to: string): string[] {
  return git(root, "diff", "--name-only", "-z", from, to)
    .split("\0")
    .filter((path) => path !== "");
}

function functionText(name: string, excess: number): string {
  return `function ${name}() {\n${"  return 1;\n".repeat(120 + excess)}}\n`;
}

function functionRow(path: string, content: string): string {
  return JSON.stringify(recordForm(measureCodeFile({ path, text: content })));
}

function functionBaseline(a: string, b: string): string {
  return `{
  "src/a.ts": ${a},
${"\n".repeat(8)}
  "src/b.ts": ${b}
}\n`;
}

export function separatedFile(firstLine: string, lastLine: string): string {
  return [
    firstLine,
    ...Array.from({ length: 8 }, (_, index) => `// shared context ${index + 1}`),
    lastLine,
    "",
  ].join("\n");
}

export function buildFunctionExcessFixture(): Fixture {
  const aBase = functionText("a", 2);
  const bBase = functionText("b", 3);
  const aMain = functionText("a", 1);
  const bPr = functionText("b", 4);
  return buildFixture(
    {
      "src/a.ts": aBase,
      "src/b.ts": bBase,
      [CODE_SIZE_BASELINE_PATH]: functionBaseline(
        functionRow("src/a.ts", aBase),
        functionRow("src/b.ts", bBase),
      ),
    },
    {
      pr: {
        "src/b.ts": bPr,
        [CODE_SIZE_BASELINE_PATH]: functionBaseline(
          functionRow("src/a.ts", aBase),
          functionRow("src/b.ts", bPr),
        ),
      },
      main: {
        "src/a.ts": aMain,
        [CODE_SIZE_BASELINE_PATH]: functionBaseline(
          functionRow("src/a.ts", aMain),
          functionRow("src/b.ts", bBase),
        ),
      },
    },
  );
}

function codeLines(count: number): string {
  return `${Array.from(
    { length: count },
    (_, index) => `export const line${index + 1} = ${index + 1};`,
  ).join("\n")}\n`;
}

function lineBaseline(lines: number): string {
  return `${JSON.stringify({ [TARGET]: { lines, functionExcess: null } }, null, 2)}\n`;
}

export function buildLineBaselineGrowthFixture(): Fixture {
  return buildFixture(
    { [TARGET]: codeLines(1001), [CODE_SIZE_BASELINE_PATH]: lineBaseline(1001) },
    {
      pr: { [CODE_SIZE_BASELINE_PATH]: lineBaseline(1002) },
      main: { [TARGET]: codeLines(1002) },
    },
  );
}

/** U-RVMG-051(b) analyzer oracle; kept independent of the Red rejection assertion. */
export function verifyLineBaselineGrowthFixture(fixture: Fixture): void {
  const preview = createPreviewWorktree(fixture);
  try {
    const source: CodeSizeSource = {
      path: TARGET,
      text: readFileSync(join(preview.path, TARGET), "utf8"),
    };
    const sources: CodeSizeSource[] = [source];
    const baseline = parseCodeSizeBaseline(
      readFileSync(join(preview.path, CODE_SIZE_BASELINE_PATH), "utf8"),
    ) as CodeSizeBaseline;
    const previousBaseline = parseCodeSizeBaseline(
      execFileSync(
        "git",
        ["-C", fixture.work, "show", `${fixture.mainSha}:${CODE_SIZE_BASELINE_PATH}`],
        { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      ),
    ) as CodeSizeBaseline;
    expect(measureCodeFile(source)).toMatchObject({ lines: 1002 });
    expect(previousBaseline[TARGET]).toEqual({ lines: 1001, functionExcess: null });
    expect(baseline[TARGET]).toEqual({ lines: 1002, functionExcess: null });
    const actual = analyzeCodeSize({
      sources,
      baseline,
      previousBaseline,
      mergeBaseMeasures: null,
      renames: [],
    });
    const expectedFinding = {
      path: TARGET,
      kind: "code-size-baseline-grown",
      reason: "lines",
    };
    expect(actual.findings).toEqual([expectedFinding]);
    expect(actual.summary).toMatchObject({ over: 0, stale: 0 });

    const injected = injectedGate(expectedFinding.kind, {
      name: "code-size",
      baselinePath: CODE_SIZE_BASELINE_PATH,
      forceFinding: true,
      reason: expectedFinding.reason,
    }).check(preview.path);
    expect(injected).toMatchObject({ ok: false, summary: { over: 0, stale: 0 } });
    expect(injected.findings).toEqual(actual.findings);
  } finally {
    removeFixturePreviewWorktree(fixture, preview.path);
  }
}

export function verifyFunctionExcessFixture(fixture: Fixture): void {
  const preview = createPreviewWorktree(fixture);
  try {
    const mergedSources = ["src/a.ts", "src/b.ts"].map(
      (path): CodeSizeSource => ({
        path,
        text: readFileSync(join(preview.path, path), "utf8"),
      }),
    );
    const mergedBaseline = parseCodeSizeBaseline(
      readFileSync(join(preview.path, CODE_SIZE_BASELINE_PATH), "utf8"),
    ) as CodeSizeBaseline;
    const baseBaseline = parseCodeSizeBaseline(
      execFileSync(
        "git",
        ["-C", fixture.work, "show", `${fixture.baseSha}:${CODE_SIZE_BASELINE_PATH}`],
        { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      ),
    ) as CodeSizeBaseline;
    const mainBaseline = parseCodeSizeBaseline(
      execFileSync(
        "git",
        ["-C", fixture.work, "show", `${fixture.mainSha}:${CODE_SIZE_BASELINE_PATH}`],
        { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      ),
    ) as CodeSizeBaseline;
    const analyze = (previousBaseline: CodeSizeBaseline) =>
      analyzeCodeSize({
        sources: mergedSources,
        baseline: mergedBaseline,
        previousBaseline,
        mergeBaseMeasures: null,
        renames: [],
      });
    const againstBase = analyze(baseBaseline);
    expect(againstBase.findings).toHaveLength(0);
    const againstMain = analyze(mainBaseline);
    expect(againstMain.findings).toContainEqual({
      path: CODE_SIZE_BASELINE_PATH,
      kind: "code-size-baseline-grown",
      reason: "functionExcess-total",
    });
    expect(againstMain.summary).toMatchObject({ over: 0, stale: 0 });
    const gate = checkCodeSize(preview.path);
    expect(gate.ok).toBe(false);
    expect(gate.messages.join("\n")).toContain("functionExcess-total");
  } finally {
    removeFixturePreviewWorktree(fixture, preview.path);
  }
}

function fixtureScratchRoot(): string {
  const root = resolve(process.env.UT_TDD_TEST_SCRATCH_ROOT ?? tmpdir());
  if (canonicalPath(root) === canonicalPath(parse(root).root)) {
    throw new Error(
      `UT_TDD_TEST_SCRATCH_ROOT must not be a filesystem root: expectedNonRoot=true actual=${JSON.stringify(canonicalPath(root))}`,
    );
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`UT_TDD_TEST_SCRATCH_ROOT must be an existing directory: ${root}`);
  }
  return root;
}

export function buildFixture(baseFiles: Record<string, string>, branchFiles: BranchFiles): Fixture {
  const scratchRoot = fixtureScratchRoot();
  const base = mkdtempSync(join(scratchRoot, "ut-tdd-rvmg-"));
  const origin = join(base, "origin.git");
  const work = join(base, "clone");
  try {
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { windowsHide: true });
    execFileSync("git", ["clone", "-q", "-c", "core.autocrlf=false", origin, work], {
      windowsHide: true,
      stdio: "ignore",
    });
    configure(work);
    git(work, "checkout", "-q", "-B", "main");
    writeFiles(work, baseFiles);
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "base");
    const baseSha = git(work, "rev-parse", "HEAD");
    git(work, "push", "-q", "-u", "origin", "main");

    git(work, "checkout", "-q", "-b", "pr");
    writeFiles(work, branchFiles.pr);
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "pr");
    const headSha = git(work, "rev-parse", "HEAD");
    git(work, "push", "-q", "-u", "origin", "pr");

    git(work, "checkout", "-q", "main");
    writeFiles(work, branchFiles.main);
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "main");
    const mainSha = git(work, "rev-parse", "HEAD");
    git(work, "push", "-q", "origin", "main");
    git(work, "checkout", "-q", "pr");
    git(work, "fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main");
    return {
      scratchRoot,
      base,
      work: canonicalExistingPath(work),
      baseSha,
      headSha,
      mainSha,
      gitCommonDir: canonicalGitCommonDir(
        resolve(work, git(work, "rev-parse", "--git-common-dir")),
      ),
      initialWorktreePaths: worktreePaths(work).map(canonicalExistingPath),
      ownedPreviewPaths: new Set(),
    };
  } catch (error) {
    rmSync(base, { recursive: true });
    throw error;
  }
}

export function buildGateSelectionFixture(key: "code" | "doc" | "both" | "none"): Fixture {
  const base = {
    "src/alpha.ts": separatedFile("base-src-a", "base-src-b"),
    "docs/alpha.md": separatedFile("base-doc-a", "base-doc-b"),
    "docs/governance/code-baseline.json": "{}\n",
    "docs/governance/doc-baseline.json": "{}\n",
  };
  if (key === "code") {
    return buildFixture(base, {
      pr: { "src/alpha.ts": separatedFile("pr-src", "base-src-b") },
      main: { "src/alpha.ts": separatedFile("base-src-a", "main-src") },
    });
  }
  if (key === "doc") {
    return buildFixture(base, {
      pr: { "docs/alpha.md": separatedFile("pr-doc", "base-doc-b") },
      main: { "docs/alpha.md": separatedFile("base-doc-a", "main-doc") },
    });
  }
  if (key === "both") {
    return buildFixture(base, {
      pr: {
        "src/alpha.ts": separatedFile("pr-src", "base-src-b"),
        "docs/alpha.md": separatedFile("pr-doc", "base-doc-b"),
      },
      main: {
        "src/alpha.ts": separatedFile("base-src-a", "main-src"),
        "docs/alpha.md": separatedFile("base-doc-a", "main-doc"),
      },
    });
  }
  return buildFixture(base, {
    pr: { "src/alpha.ts": separatedFile("pr-src", "base-src-b") },
    main: { "docs/alpha.md": separatedFile("base-doc-a", "main-doc") },
  });
}

export function createPreviewWorktree(fixture: Fixture): { path: string; treeSha: string } {
  const treeSha = git(
    fixture.work,
    "merge-tree",
    "--write-tree",
    fixture.mainSha,
    fixture.headSha,
  ).split(/\r?\n/)[0];
  if (treeSha === undefined || !/^[0-9a-f]{40,64}$/.test(treeSha)) {
    throw new Error("fixture merge-tree did not produce a tree SHA");
  }
  const commitSha = git(
    fixture.work,
    "commit-tree",
    treeSha,
    "-p",
    fixture.mainSha,
    "-p",
    fixture.headSha,
    "-m",
    "fixture preview",
  );
  const path = mkdtempSync(join(fixture.scratchRoot, "ut-tdd-rvmg-preview-"));
  const absolutePath = resolve(path);
  fixture.ownedPreviewPaths.add(absolutePath);
  try {
    git(fixture.work, "worktree", "add", "-q", "--detach", absolutePath, commitSha);
    return { path: absolutePath, treeSha };
  } catch (error) {
    const absolutePathIdentity = canonicalPath(absolutePath);
    const registered = worktreePaths(fixture.work).some(
      (candidate) => canonicalPath(candidate) === absolutePathIdentity,
    );
    if (registered) removeFixturePreviewWorktree(fixture, absolutePath);
    else {
      fixture.ownedPreviewPaths.delete(absolutePath);
      rmdirSync(absolutePath);
    }
    throw error;
  }
}

export function removeFixturePreviewWorktree(fixture: Fixture, previewPath: string): void {
  const absolutePath = resolve(previewPath);
  const scratchRoot = resolve(fixture.scratchRoot);
  const absolutePathExists = existsSync(absolutePath);
  const absolutePathIdentity = canonicalPath(absolutePath);
  const ownedPath = [...fixture.ownedPreviewPaths].find(
    (candidate) => canonicalPath(candidate) === absolutePathIdentity,
  );
  const structuralPath = absolutePathExists ? realpathSync.native(absolutePath) : absolutePath;
  if (ownedPath === undefined) {
    const expectedOwnedPaths = [...fixture.ownedPreviewPaths].map(canonicalPath);
    throw new Error(
      `refusing to remove a preview worktree outside this fixture: expectedOwnedPaths=${JSON.stringify(expectedOwnedPaths)} actual=${JSON.stringify(absolutePathIdentity)}`,
    );
  }
  const expectedParent = canonicalPath(scratchRoot);
  const actualParent = canonicalPath(dirname(structuralPath));
  if (actualParent !== expectedParent) {
    throw new Error(
      `refusing to remove a preview worktree outside this fixture: expectedParent=${JSON.stringify(expectedParent)} actualParent=${JSON.stringify(actualParent)}`,
    );
  }
  const expectedBasenamePrefix = "ut-tdd-rvmg-preview-";
  const actualBasename = basename(structuralPath);
  if (!actualBasename.startsWith(expectedBasenamePrefix)) {
    throw new Error(
      `refusing to remove a preview worktree outside this fixture: expectedBasenamePrefix=${JSON.stringify(expectedBasenamePrefix)} actualBasename=${JSON.stringify(actualBasename)}`,
    );
  }
  if (!absolutePathExists) {
    fixture.ownedPreviewPaths.delete(ownedPath);
    return;
  }
  const common = resolve(absolutePath, git(absolutePath, "rev-parse", "--git-common-dir"));
  const canonicalCommon = canonicalGitCommonDir(common);
  const expectedCommon = canonicalGitCommonDir(fixture.gitCommonDir);
  if (canonicalCommon !== expectedCommon) {
    throw new Error(
      `refusing to remove a preview worktree with a different git common directory: expected=${JSON.stringify(expectedCommon)} actual=${JSON.stringify(canonicalCommon)}`,
    );
  }
  const registeredPath = worktreePaths(fixture.work).find(
    (candidate) => canonicalPath(candidate) === absolutePathIdentity,
  );
  if (registeredPath === undefined) {
    const registeredPaths = worktreePaths(fixture.work).map(canonicalPath);
    throw new Error(
      `refusing to remove a path not registered as this fixture's worktree: expectedRegisteredPaths=${JSON.stringify(registeredPaths)} actual=${JSON.stringify(absolutePathIdentity)}`,
    );
  }
  git(fixture.work, "worktree", "remove", registeredPath);
  fixture.ownedPreviewPaths.delete(ownedPath);
}

export function verifyConflictAndCleanPreview(
  fixture: Fixture,
  gates: readonly InjectedGate[],
  inspectPreview: (previewPath: string) => void,
): string {
  expect(
    execFileSync("git", ["-C", fixture.work, "merge-base", fixture.headSha, "origin/main"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim(),
  ).toBe(fixture.baseSha);
  const preview = createPreviewWorktree(fixture);
  try {
    const parentLine = execFileSync(
      "git",
      ["-C", preview.path, "rev-list", "--parents", "-n", "1", "HEAD"],
      { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    )
      .trim()
      .split(/\s+/);
    expect(parentLine).toEqual([parentLine[0], fixture.mainSha, fixture.headSha]);
    expect(
      execFileSync("git", ["-C", preview.path, "merge-base", "HEAD", "origin/main"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    ).toBe(fixture.mainSha);
    const conflict = evaluateBaselineConflict(
      changedPaths(fixture.work, fixture.baseSha, fixture.headSha),
      changedPaths(fixture.work, fixture.baseSha, fixture.mainSha),
      gates,
    );
    expect(conflict.conflicts).not.toHaveLength(0);
    inspectPreview(preview.path);
    return preview.treeSha;
  } finally {
    removeFixturePreviewWorktree(fixture, preview.path);
    expect(worktreePaths(fixture.work).map(canonicalPath).sort()).toEqual(
      fixture.initialWorktreePaths.map(canonicalPath).sort(),
    );
  }
}

export function smallFiles(
  prLine = "pr-line",
  mainLine = "main-line",
): {
  base: Record<string, string>;
  branches: BranchFiles;
} {
  return {
    base: {
      [TARGET]: separatedFile("base-a", "base-b"),
      [SMALL_BASELINE]: '{"baseline":1}\n',
    },
    branches: {
      pr: { [TARGET]: separatedFile(prLine, "base-b") },
      main: { [TARGET]: separatedFile("base-a", mainLine) },
    },
  };
}

export function injectedGate(
  kind: string | null,
  options: {
    throwOnCheck?: boolean;
    over?: number;
    stale?: number;
    forceFinding?: boolean;
    reason?: string;
    name?: string;
    inScope?: (path: string) => boolean;
    baselinePath?: string;
    calls?: string[];
  } = {},
): InjectedGate {
  return {
    name: options.name ?? "fixture-gate",
    inScope: options.inScope ?? ((path) => path === TARGET),
    baselinePath: options.baselinePath ?? SMALL_BASELINE,
    check: (repoRoot) => {
      options.calls?.push(options.name ?? "fixture-gate");
      if (options.throwOnCheck) throw new Error("fixture gate check failed");
      const content = readFileSync(join(repoRoot, TARGET), "utf8");
      const hasMergedEdits = content.includes("pr-line") && content.includes("main-line");
      let shouldFind = options.forceFinding ?? hasMergedEdits;
      if (kind === "code-size-required") {
        const baseline = JSON.parse(readFileSync(join(repoRoot, SMALL_BASELINE), "utf8")) as Record<
          string,
          unknown
        >;
        const lines = content.split(/\r?\n/).filter((line) => line.trim() !== "");
        shouldFind = !(TARGET in baseline) && lines.length > 2;
      }
      const findings =
        kind === null || !shouldFind
          ? []
          : [{ path: TARGET, kind, reason: options.reason ?? kind }];
      return {
        ok: findings.length === 0,
        findings,
        summary: { over: options.over ?? 0, stale: options.stale ?? 0 },
      };
    },
  };
}

export function gateSelectionGates(calls: string[]): InjectedGate[] {
  return [
    injectedGate(null, {
      name: "code-size",
      inScope: (path) => path === "src/alpha.ts",
      baselinePath: "docs/governance/code-baseline.json",
      calls,
    }),
    injectedGate(null, {
      name: "doc-split",
      inScope: (path) => path === "docs/alpha.md",
      baselinePath: "docs/governance/doc-baseline.json",
      calls,
    }),
  ];
}

export const checkWithGates = checkBaselineConflict as unknown as (
  repoRoot: string,
  headSha: string,
  options: { gates: readonly InjectedGate[]; pr: number },
) => string | null;

function seedPassReview(root: string, headSha: string): void {
  const requests = join(root, ".ut-tdd", "review", "requests");
  const receipts = join(root, ".ut-tdd", "review", "receipts");
  mkdirSync(requests, { recursive: true });
  mkdirSync(receipts, { recursive: true });
  writeFileSync(
    join(requests, "request.json"),
    JSON.stringify({
      memoryId: "review:1559:head:1",
      pr: 1559,
      exactHead: headSha,
      reviewRevision: "review-r1",
      authorFamily: "claude",
      requestedAt: "2026-11-05T10:30:00.000Z",
    }),
  );
  writeFileSync(
    join(receipts, "receipt.json"),
    JSON.stringify({
      memoryId: "review:1559:head:1",
      pr: 1559,
      head: headSha,
      reviewRevision: "review-r1",
      reviewerFamily: "codex",
      kind: "verdict",
      verdict: "PASS",
      blockingFindings: [],
      at: "2026-11-05T10:45:00.000Z",
    }),
  );
}

export function runMerge(
  fixture: Fixture,
  bypassBaselineConflict = false,
  baselineConflictChecker?: GhPrMergePorts["checkBaselineConflict"],
  readMergeCommitTree?: GhPrMergePorts["readMergeCommitTree"],
) {
  seedPassReview(fixture.work, fixture.headSha);
  let mergeCount = 0;
  const ports: GhPrMergePorts = {
    getPullRequest: () => ({
      pr: 1559,
      headSha: fixture.headSha,
      evaluatedHeadSha: fixture.headSha,
      state: "OPEN",
      checksGreen: true,
    }),
    mergePullRequest: () => {
      mergeCount += 1;
    },
  };
  if (bypassBaselineConflict) ports.checkBaselineConflict = () => null;
  else if (baselineConflictChecker) ports.checkBaselineConflict = baselineConflictChecker;
  if (readMergeCommitTree) ports.readMergeCommitTree = readMergeCommitTree;
  const result = runPrMerge({ repoRoot: fixture.work, pr: 1559, now: () => NOW, ports });
  return { result, merges: mergeCount };
}

export function captureWorktreeObservation(
  repoRoot: string,
  executeGit: (args: string[]) => string,
): { repoRoot: string; commonDir: string; registeredWorktreePaths: string[] } {
  const commonDir = canonicalExistingPath(
    executeGit(["-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"]).trim(),
  );
  const worktrees = executeGit(["-C", repoRoot, "worktree", "list", "--porcelain"]);
  const registeredWorktreePaths = worktrees
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => canonicalExistingPath(line.slice("worktree ".length)));
  return { repoRoot: canonicalExistingPath(repoRoot), commonDir, registeredWorktreePaths };
}

export function isFixtureLinkedPreviewRoot(
  observation: {
    repoRoot: string;
    commonDir: string;
    registeredWorktreePaths: string[];
  },
  fixture: Fixture,
): boolean {
  const initialPaths = new Set([fixture.work, ...fixture.initialWorktreePaths]);
  return (
    !initialPaths.has(observation.repoRoot) &&
    observation.commonDir === fixture.gitCommonDir &&
    observation.registeredWorktreePaths.includes(observation.repoRoot)
  );
}

export function cleanFixture(fixture: Fixture): void {
  const base = resolve(fixture.base);
  const scratchRoot = resolve(fixture.scratchRoot);
  const baseIdentity = canonicalPath(base);
  const expectedBasePrefix = "ut-tdd-rvmg-";
  const actualBaseName = basename(baseIdentity);
  if (!actualBaseName.startsWith(expectedBasePrefix)) {
    throw new Error(
      `refusing to remove a path not created by this fixture: expectedBasenamePrefix=${JSON.stringify(expectedBasePrefix)} actualBasename=${JSON.stringify(actualBaseName)}`,
    );
  }
  const expectedParent = canonicalPath(scratchRoot);
  const actualParent = canonicalPath(dirname(baseIdentity));
  if (actualParent !== expectedParent) {
    throw new Error(
      `refusing to remove a path not created by this fixture: expectedParent=${JSON.stringify(expectedParent)} actualParent=${JSON.stringify(actualParent)}`,
    );
  }
  for (const previewPath of [...fixture.ownedPreviewPaths]) {
    removeFixturePreviewWorktree(fixture, previewPath);
  }
  const initial = new Set(fixture.initialWorktreePaths.map((path) => canonicalPath(path)));
  const outsidePaths: string[] = [];
  const basePrefix = baseIdentity.endsWith(sep) ? baseIdentity : `${baseIdentity}${sep}`;
  for (const path of worktreePaths(fixture.work)) {
    const pathIdentity = canonicalPath(path);
    if (initial.has(pathIdentity)) continue;
    if (!pathIdentity.startsWith(basePrefix)) {
      outsidePaths.push(path);
      continue;
    }
    if (!existsSync(path)) continue;
    const common = resolve(path, git(path, "rev-parse", "--git-common-dir"));
    const canonicalCommon = canonicalGitCommonDir(common);
    const expectedCommon = canonicalGitCommonDir(fixture.gitCommonDir);
    if (canonicalCommon !== expectedCommon) {
      throw new Error(
        `refusing to remove a linked worktree outside this fixture repository: expected=${JSON.stringify(expectedCommon)} actual=${JSON.stringify(canonicalCommon)}`,
      );
    }
    git(fixture.work, "worktree", "remove", path);
  }
  if (outsidePaths.length > 0) {
    throw new Error(
      `refusing to remove fixture storage while linked worktrees remain outside it: expectedBasePrefix=${JSON.stringify(basePrefix)} actualPaths=${JSON.stringify(outsidePaths.map(canonicalPath))}`,
    );
  }
  rmSync(base, { recursive: true });
}
