import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkCodeSize,
  loadCodeSizeMergeBaseMeasures,
  loadCodeSizeSources,
  loadPreviousCodeSizeBaseline,
  loadRenamedCodeFiles,
} from "../src/lint/code-size-inputs.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const BASELINE = "docs/governance/code-size-baseline.json";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function writeRepoFile(root: string, relativePath: string, text: string): void {
  const absolute = join(root, ...relativePath.split("/"));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
}

function commit(root: string, message: string): string {
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", message);
  return git(root, "rev-parse", "HEAD").trim();
}

function initRepo(files: Record<string, string>, exposeAsOriginMain = true): string {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-code-size-inputs-"));
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "UT-TDD test");
  for (const [relativePath, text] of Object.entries(files)) writeRepoFile(root, relativePath, text);
  const base = commit(root, "seed code-size inputs fixture");
  if (exposeAsOriginMain) git(root, "update-ref", "refs/remotes/origin/main", base);
  return root;
}

const body = (count: number) => "x++;\n".repeat(count);
const fn = (name: string, bodyLines: number) => `function ${name}() {\n${body(bodyLines)}}\n`;
/** A top-level statement spanning exactly `count` nonblank lines and no function. */
const statement = (name: string, count: number) =>
  `const ${name} = [\n${"1,\n".repeat(count - 2)}];\n`;
/** checkCodeSize messages for one committed file against an empty baseline. */
function messagesFor(path: string, text: string): string {
  const root = initRepo({ [path]: text, [BASELINE]: "{}\n" });
  try {
    return checkCodeSize(root).messages.join("\n");
  } finally {
    removeRepo(root);
  }
}
const lines = (count: number) => "const a = 1;\n".repeat(count);

function baselineEntry(path: string, lineCount: number | null, excess: number | null): string {
  return `${JSON.stringify({ [path]: { lines: lineCount, functionExcess: excess } }, null, 2)}\n`;
}

function removeRepo(root: string): void {
  // root is only the unique mkdtempSync fixture created by this file.
  removeTestTree(root);
}

function hasMessage(result: { messages: string[] }, code: string): boolean {
  return result.messages.some((message) => message.includes(code));
}

describe("code size gate filesystem and git adapter candidate oracles", () => {
  it("imports adapter exports and returns the L6 result shapes without throwing", () => {
    const sources = loadCodeSizeSources("unused-test-root");
    const previous = loadPreviousCodeSizeBaseline("unused-test-root");
    const mergeBase = loadCodeSizeMergeBaseMeasures("unused-test-root", []);
    const renamed = loadRenamedCodeFiles("unused-test-root");
    const checked = checkCodeSize("unused-test-root");

    expect(Array.isArray(sources.sources)).toBe(true);
    expect(Array.isArray(sources.unreadable)).toBe(true);
    expect(["found", "absent", "unreadable"]).toContain(previous.kind);
    expect(["found", "unreadable"]).toContain(mergeBase.kind);
    expect(["found", "unreadable"]).toContain(renamed.kind);
    expect(typeof checked.ok).toBe("boolean");
    expect(Array.isArray(checked.messages)).toBe(true);
  });

  it("U-CODESIZE-013(b): reports unreadable sources and fails closed instead of treating them as empty", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-code-size-unreadable-"));
    rmSync(root, { recursive: true, force: true });
    try {
      const loaded = loadCodeSizeSources(root);
      expect(loaded.sources).toEqual([]);
      expect(loaded.unreadable.length).toBeGreaterThan(0);
      const result = checkCodeSize(root);
      expect(result.ok).toBe(false);
      expect(hasMessage(result, "code-size-input-unreadable")).toBe(true);
    } finally {
      removeTestTree(root);
    }
  });

  it("U-CODESIZE-015(a): loads a parseable previous baseline at origin/main", () => {
    const entryPath = "src/big.ts";
    const root = initRepo({
      [entryPath]: lines(900),
      [BASELINE]: baselineEntry(entryPath, 900, null),
    });
    try {
      expect(loadPreviousCodeSizeBaseline(root)).toEqual({
        kind: "found",
        baseline: { [entryPath]: { lines: 900, functionExcess: null } },
      });
    } finally {
      removeRepo(root);
    }
  });

  it("U-CODESIZE-015(b): reports absent and skips the comparison when the merge-base has no baseline file", () => {
    const root = initRepo({ "src/small.ts": lines(3) });
    try {
      expect(loadPreviousCodeSizeBaseline(root)).toEqual({ kind: "absent" });
      const result = checkCodeSize(root);
      expect(result.ok).toBe(true);
      expect(hasMessage(result, "checked=1 over=0 stale=0 baseline=0")).toBe(true);
    } finally {
      removeRepo(root);
    }
  });

  it("U-CODESIZE-015(c): reports unreadable and fails closed when origin/main cannot resolve", () => {
    const root = initRepo(
      { "src/small.ts": lines(3), [BASELINE]: baselineEntry("src/small.ts", 900, null) },
      false,
    );
    try {
      expect(loadPreviousCodeSizeBaseline(root)).toEqual({ kind: "unreadable" });
      const result = checkCodeSize(root);
      expect(result.ok).toBe(false);
      expect(hasMessage(result, "code-size-baseline-base-unreadable")).toBe(true);
    } finally {
      removeRepo(root);
    }
  });

  it("U-CODESIZE-015(d): reports unreadable and fails closed for malformed baseline JSON", () => {
    const root = initRepo({ "src/small.ts": lines(3), [BASELINE]: "{" });
    try {
      expect(loadPreviousCodeSizeBaseline(root)).toEqual({ kind: "unreadable" });
      const result = checkCodeSize(root);
      expect(result.ok).toBe(false);
      expect(hasMessage(result, "code-size-baseline-base-unreadable")).toBe(true);
    } finally {
      removeRepo(root);
    }
  });

  it("U-CODESIZE-015(e): measures the merge-base content and rejects initial self-growth", () => {
    const path = "src/big.ts";
    const root = initRepo({ [path]: lines(900) });
    try {
      writeRepoFile(root, path, lines(950));
      writeRepoFile(root, BASELINE, baselineEntry(path, 950, null));
      commit(root, "grow the file and record the grown value");

      expect(loadCodeSizeMergeBaseMeasures(root, [path])).toEqual({
        kind: "found",
        measures: { [path]: { lines: 900, functionExcess: null } },
      });
      const result = checkCodeSize(root);
      expect(result.ok).toBe(false);
      expect(hasMessage(result, "code-size-initial-baseline-grown")).toBe(true);
    } finally {
      removeRepo(root);
    }
  });

  it("U-CODESIZE-015(f): recognizes a same-class nested rename and carries the row", () => {
    const oldPath = "src/big.ts";
    const newPath = "src/sub/big.ts";
    const root = initRepo({
      [oldPath]: lines(900),
      [BASELINE]: baselineEntry(oldPath, 900, null),
    });
    try {
      mkdirSync(dirname(join(root, newPath)), { recursive: true });
      git(root, "mv", oldPath, newPath);
      writeRepoFile(root, BASELINE, baselineEntry(newPath, 900, null));
      commit(root, "move the file without changing its class or size");

      expect
        .soft(loadRenamedCodeFiles(root))
        .toEqual({ kind: "found", renames: [{ from: oldPath, to: newPath }] });
      const result = checkCodeSize(root);
      expect(result.ok).toBe(true);
      expect(hasMessage(result, "checked=1 over=0 stale=0 baseline=1")).toBe(true);
    } finally {
      removeRepo(root);
    }
  });

  it("U-CODESIZE-015(g): fails closed when git rename input is unreadable", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-code-size-no-git-"));
    try {
      expect(loadRenamedCodeFiles(root)).toEqual({ kind: "unreadable" });
      const result = checkCodeSize(root);
      expect(result.ok).toBe(false);
      expect(hasMessage(result, "code-size-baseline-base-unreadable")).toBe(true);
    } finally {
      removeRepo(root);
    }
  });

  it("U-CODESIZE-004(message): reports lines=501/500 through the check messages", () => {
    expect(messagesFor("src/x.ts", lines(501))).toContain("lines=501/500");
    expect(messagesFor("tests/x.test.ts", lines(501))).toContain("lines=501/500");
    expect(messagesFor("src/x.ts", lines(500))).not.toContain("code-size-required");
  });

  it("U-CODESIZE-005(message): reports functionExcess=1/0 through the check messages", () => {
    expect(messagesFor("src/x.ts", fn("f", 121))).toContain("functionExcess=1/0");
    expect(messagesFor("src/x.ts", fn("f", 120))).not.toContain("code-size-required");
  });

  it("U-CODESIZE-012: points to what to split and where through the check messages", () => {
    const limit = 500;
    // (a) over by 20: trailing statements are selected from the back
    const featureText =
      statement("alpha", 3) + statement("beta", limit + 20 - 3 - 15) + statement("gamma", 15);
    const feature = messagesFor("src/feature/x.ts", featureText);
    expect(feature).toContain("gamma (15 行)");
    expect(feature).toContain("beta");
    expect(feature).not.toContain("alpha");
    expect(feature).toContain("src/feature/");
    expect(feature).toContain("tests/");
    // (b) over by 1: at least one statement, the last one
    const tailMessage = messagesFor(
      "src/feature/y.ts",
      statement("head", limit + 1 - 5) + statement("tail", 5),
    );
    expect(tailMessage).toContain("tail (5 行)");
    expect(tailMessage).not.toContain("head");
    // (c) tests: a describe statement is named by its title and only tests/ is suggested
    const describeText = `${statement("filler", limit + 10 - 30)}describe("末尾の題", () => {\n${body(28)}});\n`;
    const testsMessage = messagesFor("tests/x.test.ts", describeText);
    expect(testsMessage).toContain("describe: 末尾の題");
    expect(testsMessage).not.toContain("src/");
    // (d) functions over the limit, longest first, anonymous ones by line number
    const functionMessage = messagesFor(
      "src/f.ts",
      `${fn("big", 150)}run(() => {\n${body(130)}});\n`,
    );
    expect(functionMessage).toContain("150/120");
    expect(functionMessage).toContain("<anon@153>");
    expect(functionMessage).toContain("130/120");
    expect(functionMessage.indexOf("big")).toBeLessThan(functionMessage.indexOf("<anon@153>"));
  });
});
