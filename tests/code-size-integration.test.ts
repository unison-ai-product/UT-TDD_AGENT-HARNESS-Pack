import { execFileSync, spawnSync } from "node:child_process";
import {
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
  type CodeSizeBaseline,
  measureCodeFile,
  parseCodeSizeBaseline,
} from "../src/lint/code-size.ts";
import { checkCodeSize } from "../src/lint/code-size-inputs.ts";
import { heavyAfterAll, heavyBeforeAll } from "./support/hook-bounds.ts";
import { removeTestTree } from "./support/temp-tree.ts";
import { headSnapshotRoot } from "./support/workspace-roots.ts";

const BASELINE_PATH = "docs/governance/code-size-baseline.json";
const SRC_LINES = 500;
const TESTS_LINES = 500;
const FUNCTION_LINES = 120;

let authorRoot = "";
let scratchRoot = "";
let liveBaseline: CodeSizeBaseline | null = null;
let largestSrcFixture = "";
let largestTestsFixture = "";
let newFunctionFixture = "";
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
  execFileSync("git", ["config", "user.name", "Code Size Integration Test"], { cwd: root });
}

function commitAll(root: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-m", message], { cwd: root, stdio: "ignore" });
}

function pointOriginMainAtHead(root: string): void {
  execFileSync("git", ["remote", "add", "origin", root], { cwd: root });
  execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: root });
}

function codeText(lineCount: number): string {
  return "const a = 1;\n".repeat(lineCount);
}

function countTargetFiles(directory: string, inTests = false): number {
  let count = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "dist"].includes(entry.name)) continue;
      if (inTests && entry.name === "fixtures") continue;
      count += countTargetFiles(path, inTests);
    } else if (/\.(?:ts|tsx|mts|cts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      count += 1;
    }
  }
  return count;
}

/** Copies the live src/tests/baseline into a git repository whose origin/main is its HEAD. */
function copyLiveCode(label: string, mutate?: (root: string) => void): string {
  const root = join(scratchRoot, label);
  mkdirSync(root, { recursive: true });
  cpSync(join(authorRoot, "src"), join(root, "src"), { recursive: true });
  cpSync(join(authorRoot, "tests"), join(root, "tests"), { recursive: true });
  mkdirSync(dirname(join(root, BASELINE_PATH)), { recursive: true });
  if (existsSync(join(authorRoot, BASELINE_PATH))) {
    cpSync(join(authorRoot, BASELINE_PATH), join(root, BASELINE_PATH));
  }
  initializeGit(root);
  commitAll(root, "copy the live code and code-size baseline");
  pointOriginMainAtHead(root);
  mutate?.(root);
  return root;
}

function appendLine(root: string, path: string): void {
  const absolutePath = join(root, path);
  const original = readFileSync(absolutePath, "utf8");
  writeFileSync(
    absolutePath,
    `${original}${original.endsWith("\n") ? "" : "\n"}const added = 1;\n`,
  );
}

function largestRow(prefix: string): string {
  const rows = Object.entries(liveBaseline ?? {}).filter(
    ([path, value]) => path.startsWith(prefix) && value.lines !== null,
  );
  rows.sort((left, right) => (right[1].lines ?? 0) - (left[1].lines ?? 0));
  return rows[0]?.[0] ?? "";
}

function createCliFixture(label: string, violated: boolean): string {
  const root = join(scratchRoot, label);
  mkdirSync(root, { recursive: true });
  writeFixtureFile(root, "src/cli-fixture.ts", codeText(SRC_LINES));
  writeFixtureFile(root, BASELINE_PATH, "{}\n");
  writeFixtureFile(root, ".ut-tdd/harness.db", "temporary read-only CLI fixture\n");
  initializeGit(root);
  commitAll(root, "green code-size CLI fixture");
  pointOriginMainAtHead(root);
  if (violated) writeFixtureFile(root, "src/cli-fixture.ts", codeText(SRC_LINES + 1));
  return root;
}

function runCli(root: string) {
  return spawnSync(process.execPath, [join(authorRoot, "src/cli.ts"), "code-size", "check"], {
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

heavyBeforeAll(["git", 240000], () => {
  authorRoot = process.cwd();
  scratchRoot = mkdtempSync(join(tmpdir(), "code-size-integration-"));
  const liveBaselinePath = join(authorRoot, BASELINE_PATH);
  if (existsSync(liveBaselinePath)) {
    liveBaseline = parseCodeSizeBaseline(readFileSync(liveBaselinePath, "utf8"));
  }
  const largestSrc = largestRow("src/");
  const largestTests = largestRow("tests/");
  if (largestSrc) largestSrcFixture = copyLiveCode("largest-src", (r) => appendLine(r, largestSrc));
  if (largestTests) {
    largestTestsFixture = copyLiveCode("largest-tests", (r) => appendLine(r, largestTests));
  }
  newFunctionFixture = copyLiveCode("new-function", (root) => {
    const body = "  void 0;\n".repeat(FUNCTION_LINES + 1);
    writeFixtureFile(root, "src/code-size-new-fixture.ts", `export function big() {\n${body}}\n`);
  });
  cliGreenRoot = createCliFixture("cli-green", false);
  cliViolationRoot = createCliFixture("cli-violation", true);
}); // 104s measured, bounded per #1063

heavyAfterAll("teardown", () => {
  if (scratchRoot) removeTestTree(scratchRoot);
});

describe("code-size live repository and CLI integration candidates", () => {
  it("U-CODESIZE-016: has a parseable live code-size baseline", () => {
    expect(existsSync(join(authorRoot, BASELINE_PATH))).toBe(true);
    expect(liveBaseline).not.toBeNull();
  });

  it("U-CODESIZE-016: records the measured form for every live baseline file", () => {
    expect(liveBaseline).not.toBeNull();
    for (const [path, expected] of Object.entries(liveBaseline ?? {})) {
      const measured = measureCodeFile({
        path,
        text: readFileSync(join(authorRoot, path), "utf8"),
      });
      const limit = path.startsWith("tests/") ? TESTS_LINES : SRC_LINES;
      expect.soft(expected, path).toEqual({
        lines: measured.lines > limit ? measured.lines : null,
        functionExcess: measured.functionExcess ? measured.functionExcess : null,
      });
    }
  });

  it("U-CODESIZE-016: accepts the live repository and reports the live summary", () => {
    const result = checkCodeSize(authorRoot);
    const checked =
      countTargetFiles(join(authorRoot, "src")) + countTargetFiles(join(authorRoot, "tests"), true);
    expect(result.ok).toBe(true);
    expect
      .soft(result.messages)
      .toContain(
        `checked=${checked} over=0 stale=0 baseline=${Object.keys(liveBaseline ?? {}).length}`,
      );
  });

  it("U-CODESIZE-016: rejects one appended line in the largest baseline src file", () => {
    expect(largestSrcFixture).not.toBe("");
    const result = checkCodeSize(largestSrcFixture);
    expect.soft(result.ok).toBe(false);
    expect.soft(result.messages.join("\n")).toContain("code-size-required:exceeds-baseline");
    expect.soft(result.messages.join("\n")).toContain("ファイル:");
  });

  it("U-CODESIZE-016: rejects one appended line in the largest baseline tests file", () => {
    expect(largestTestsFixture).not.toBe("");
    const result = checkCodeSize(largestTestsFixture);
    expect.soft(result.ok).toBe(false);
    expect.soft(result.messages.join("\n")).toContain("code-size-required:exceeds-baseline");
  });

  it("U-CODESIZE-016: rejects a new src file with a function over the limit", () => {
    const result = checkCodeSize(newFunctionFixture);
    expect(result.ok).toBe(false);
    expect(result.messages.join("\n")).toContain("code-size-required:new-file-over-limit");
  });

  it("U-CODESIZE-017: registers code-size in the full doctor hard-gate definitions and fails it on a violation", () => {
    const definitions = buildFullDoctorCheckDefinitions(nodeDoctorDeps(headSnapshotRoot()));
    const definition = definitions.find((item) => item.id === "code-size");
    expect(definition).toBeDefined();
    expect(definition?.profiles).toContain("full");
    const doctorCheck = (root: string) =>
      buildFullDoctorCheckDefinitions(nodeDoctorDeps(root))
        .find((item) => item.id === "code-size")
        ?.run();
    expect.soft(doctorCheck(cliGreenRoot)?.ok).toBe(true);
    expect.soft(doctorCheck(cliViolationRoot)?.ok).toBe(false);
  });

  it("U-CODESIZE-017: the green CLI worktree exits successfully with the summary", () => {
    const result = runCli(cliGreenRoot);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("checked=");
  });

  it("U-CODESIZE-017: the violating CLI worktree exits 1, prints the finding and writes no state", () => {
    const before = stateMtimes(cliViolationRoot);
    const result = runCli(cliViolationRoot);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("code-size-required:new-file-over-limit");
    expect(stateMtimes(cliViolationRoot)).toEqual(before);
  });
});
