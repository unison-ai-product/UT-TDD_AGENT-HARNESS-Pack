import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkDocSplit,
  loadDocSplitSources,
  loadMergeBaseMeasures,
  loadPreviousDocSplitBaseline,
  loadRenamedDocs,
} from "../src/lint/doc-split-inputs.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const L6 = "docs/design/harness/L6-function-design/";
const L7 = "docs/test-design/harness/";
const BASELINE = "docs/governance/doc-split-baseline.json";

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
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-doc-split-inputs-"));
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "UT-TDD test");
  for (const [relativePath, text] of Object.entries(files)) writeRepoFile(root, relativePath, text);
  const base = commit(root, "seed doc-split inputs fixture");
  if (exposeAsOriginMain) git(root, "update-ref", "refs/remotes/origin/main", base);
  return root;
}

function docText(lines: number, headingCount: number): string {
  const headings = Array.from({ length: headingCount }, (_, i) => `## H${i + 1}`);
  return [
    ...Array.from({ length: Math.max(0, lines - headingCount) }, () => "x"),
    ...headings,
  ].join("\n");
}

function familyDoc(lines: number, names: string[]): string {
  const table = [
    "| ID | Description |",
    "| --- | --- |",
    ...names.map((name) => `| U-${name}-001 | case |`),
  ];
  return [...table, ...Array.from({ length: Math.max(0, lines - table.length) }, () => "x")].join(
    "\n",
  );
}

function baselineEntry(path: string, lines: number, responsibilities: number | null): string {
  return JSON.stringify({ [path]: { lines, responsibilities } }, null, 2) + "\n";
}

function removeRepo(root: string): void {
  // root is only the unique mkdtempSync fixture created by this file.
  removeTestTree(root);
}

function hasMessage(result: { messages: string[] }, code: string): boolean {
  return result.messages.some((message) => message.includes(code));
}

function hasFindingMessage(result: { messages: string[] }): boolean {
  return result.messages.some((message) => message.includes(":doc-split-"));
}

describe("doc split gate filesystem and git adapter candidate oracles", () => {
  it("imports adapter exports and returns the L6 result shapes without throwing", () => {
    const sources = loadDocSplitSources("unused-test-root");
    const previous = loadPreviousDocSplitBaseline("unused-test-root");
    const mergeBase = loadMergeBaseMeasures("unused-test-root", []);
    const renamed = loadRenamedDocs("unused-test-root");
    const checked = checkDocSplit("unused-test-root");

    expect(Array.isArray(sources.sources)).toBe(true);
    expect(Array.isArray(sources.unreadable)).toBe(true);
    expect(["found", "absent", "unreadable"]).toContain(previous.kind);
    expect(["found", "unreadable"]).toContain(mergeBase.kind);
    expect(["found", "unreadable"]).toContain(renamed.kind);
    expect(typeof checked.ok).toBe("boolean");
    expect(Array.isArray(checked.messages)).toBe(true);
  });

  it("U-DOCSPLIT-014(a): loads a parseable previous baseline at origin/main", () => {
    const entryPath = `${L6}big.md`;
    const root = initRepo({
      [entryPath]: docText(500, 20),
      [BASELINE]: baselineEntry(entryPath, 500, 20),
    });
    try {
      expect(loadPreviousDocSplitBaseline(root)).toEqual({
        kind: "found",
        baseline: { [entryPath]: { lines: 500, responsibilities: 20 } },
      });
    } finally {
      removeRepo(root);
    }
  });

  it("U-DOCSPLIT-014(b): reports absent when the merge-base has no baseline file", () => {
    const root = initRepo({ [`${L6}small.md`]: "## Small" });
    try {
      expect(loadPreviousDocSplitBaseline(root)).toEqual({ kind: "absent" });
    } finally {
      removeRepo(root);
    }
  });

  it("U-DOCSPLIT-014(c): reports unreadable when origin/main cannot resolve", () => {
    const root = initRepo(
      { [`${L6}small.md`]: "## Small", [BASELINE]: baselineEntry(`${L6}small.md`, 1, 1) },
      false,
    );
    try {
      expect(loadPreviousDocSplitBaseline(root)).toEqual({ kind: "unreadable" });
    } finally {
      removeRepo(root);
    }
  });

  it("U-DOCSPLIT-014(c): fails closed when the merge-base cannot resolve", () => {
    const root = initRepo(
      { [`${L6}small.md`]: "## Small", [BASELINE]: baselineEntry(`${L6}small.md`, 1, 1) },
      false,
    );
    try {
      const result = checkDocSplit(root);
      expect(result.ok).toBe(false);
      expect(hasMessage(result, "doc-split-baseline-base-unreadable")).toBe(true);
    } finally {
      removeRepo(root);
    }
  });

  it("U-DOCSPLIT-014(d): reports unreadable for malformed baseline JSON", () => {
    const root = initRepo({ [`${L6}small.md`]: "## Small", [BASELINE]: "{" });
    try {
      expect(loadPreviousDocSplitBaseline(root)).toEqual({ kind: "unreadable" });
    } finally {
      removeRepo(root);
    }
  });

  it("U-DOCSPLIT-014(d): fails closed for malformed baseline JSON", () => {
    const root = initRepo({ [`${L6}small.md`]: "## Small", [BASELINE]: "{" });
    try {
      const result = checkDocSplit(root);
      expect(result.ok).toBe(false);
      expect(hasMessage(result, "doc-split-baseline-base-unreadable")).toBe(true);
    } finally {
      removeRepo(root);
    }
  });

  it("U-DOCSPLIT-014(e): measures the base document and rejects initial self-growth", () => {
    const path = `${L6}big.md`;
    const root = initRepo({ [path]: docText(500, 20) });
    try {
      writeRepoFile(root, path, docText(600, 20));
      writeRepoFile(root, BASELINE, baselineEntry(path, 600, 20));
      commit(root, "grow the document and record the grown value");

      expect(loadMergeBaseMeasures(root, [path])).toEqual({
        kind: "found",
        measures: { [path]: { lines: 500, responsibilities: 20 } },
      });
      const result = checkDocSplit(root);
      expect(result.ok).toBe(false);
      expect(hasMessage(result, "doc-split-initial-baseline-grown")).toBe(true);
    } finally {
      removeRepo(root);
    }
  });

  it("U-DOCSPLIT-014(f): omits a document absent from the merge-base and rejects its initial entry", () => {
    const path = `${L6}new.md`;
    const root = initRepo({ [`${L6}small.md`]: "## Small" });
    try {
      writeRepoFile(root, path, docText(600, 20));
      writeRepoFile(root, BASELINE, baselineEntry(path, 600, 20));
      commit(root, "add and initially baseline a new document");

      expect(loadMergeBaseMeasures(root, [path])).toEqual({ kind: "found", measures: {} });
      const result = checkDocSplit(root);
      expect(result.ok).toBe(false);
      expect(hasMessage(result, "doc-split-initial-baseline-new-entry")).toBe(true);
    } finally {
      removeRepo(root);
    }
  });

  it("U-DOCSPLIT-014(g): rejects an initial baseline entry whose merge-base value is under the limit", () => {
    const path = `${L6}small.md`;
    const root = initRepo({ [path]: docText(300, 5) });
    try {
      writeRepoFile(root, BASELINE, baselineEntry(path, 300, 5));
      commit(root, "record a below-limit initial baseline entry");

      expect(loadMergeBaseMeasures(root, [path])).toEqual({
        kind: "found",
        measures: { [path]: { lines: 300, responsibilities: 5 } },
      });
      const result = checkDocSplit(root);
      expect(result.ok).toBe(false);
      expect(hasMessage(result, "doc-split-initial-baseline-new-entry")).toBe(true);
    } finally {
      removeRepo(root);
    }
  });

  it("U-DOCSPLIT-014(h): accepts an initial baseline matching an over-limit merge-base document", () => {
    const path = `${L6}big.md`;
    const root = initRepo({ [path]: docText(500, 20) });
    try {
      writeRepoFile(root, BASELINE, baselineEntry(path, 500, 20));
      commit(root, "record the unchanged over-limit initial value");

      expect(loadMergeBaseMeasures(root, [path])).toEqual({
        kind: "found",
        measures: { [path]: { lines: 500, responsibilities: 20 } },
      });
      const result = checkDocSplit(root);
      expect(result.ok).toBe(true);
      expect(hasFindingMessage(result)).toBe(false);
      expect(hasMessage(result, "checked=1 over=0 stale=0 baseline=1")).toBe(true);
    } finally {
      removeRepo(root);
    }
  });

  it("U-DOCSPLIT-014(i): reports unreadable when merge-base measurement cannot resolve origin/main", () => {
    const path = `${L6}big.md`;
    const root = initRepo({ [path]: docText(500, 20) }, false);
    try {
      expect(loadMergeBaseMeasures(root, [path])).toEqual({ kind: "unreadable" });
    } finally {
      removeRepo(root);
    }
  });

  it("U-DOCSPLIT-014(i): fails closed when merge-base measurement is unreadable", () => {
    const path = `${L6}big.md`;
    const root = initRepo(
      { [path]: docText(500, 20), [BASELINE]: baselineEntry(path, 500, 20) },
      false,
    );
    try {
      const result = checkDocSplit(root);
      expect(result.ok).toBe(false);
      expect(hasMessage(result, "doc-split-baseline-base-unreadable")).toBe(true);
    } finally {
      removeRepo(root);
    }
  });

  it("U-DOCSPLIT-015(b): reports unreadable sources and fails closed instead of treating them as empty", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doc-split-unreadable-"));
    rmSync(root, { recursive: true, force: true });
    try {
      const loaded = loadDocSplitSources(root);
      expect(loaded.sources).toEqual([]);
      expect(loaded.unreadable.length).toBeGreaterThan(0);
      const result = checkDocSplit(root);
      expect(result.ok).toBe(false);
      expect(hasMessage(result, "doc-split-input-unreadable")).toBe(true);
    } finally {
      removeTestTree(root);
    }
  });

  it("U-DOCSPLIT-024(a): recognizes and safely carries a same-class nested rename", () => {
    const oldPath = `${L6}big.md`;
    const newPath = `${L6}sub/big.md`;
    const root = initRepo({
      [oldPath]: docText(500, 20),
      [BASELINE]: baselineEntry(oldPath, 500, 20),
    });
    try {
      mkdirSync(dirname(join(root, newPath)), { recursive: true });
      git(root, "mv", oldPath, newPath);
      writeRepoFile(root, BASELINE, baselineEntry(newPath, 500, 20));
      commit(root, "move the topic without changing its class or size");

      expect(loadRenamedDocs(root)).toEqual({
        kind: "found",
        renames: [{ from: oldPath, to: newPath }],
      });
      const result = checkDocSplit(root);
      expect(result.ok).toBe(true);
      expect(hasFindingMessage(result)).toBe(false);
      expect(hasMessage(result, "checked=1 over=0 stale=0 baseline=1")).toBe(true);
    } finally {
      removeRepo(root);
    }
  });

  it("U-DOCSPLIT-024(a): reports a missing-file finding when the baseline is not transferred", () => {
    const oldPath = `${L6}big.md`;
    const newPath = `${L6}sub/big.md`;
    const root = initRepo({
      [oldPath]: docText(500, 20),
      [BASELINE]: baselineEntry(oldPath, 500, 20),
    });
    try {
      mkdirSync(dirname(join(root, newPath)), { recursive: true });
      git(root, "mv", oldPath, newPath);
      commit(root, "move the topic without transferring its baseline entry");

      const result = checkDocSplit(root);
      expect(result.ok).toBe(false);
      expect(hasMessage(result, "missing-file")).toBe(true);
    } finally {
      removeRepo(root);
    }
  });

  it("U-DOCSPLIT-024(a): reports a new-doc-over-limit finding for an empty baseline", () => {
    const oldPath = `${L6}big.md`;
    const newPath = `${L6}sub/big.md`;
    const root = initRepo({
      [oldPath]: docText(500, 20),
      [BASELINE]: baselineEntry(oldPath, 500, 20),
    });
    try {
      mkdirSync(dirname(join(root, newPath)), { recursive: true });
      git(root, "mv", oldPath, newPath);
      writeRepoFile(root, BASELINE, "{}\n");
      commit(root, "move the topic with an empty baseline");

      const result = checkDocSplit(root);
      expect(result.ok).toBe(false);
      expect(hasMessage(result, "new-doc-over-limit")).toBe(true);
    } finally {
      removeRepo(root);
    }
  });

  it("U-DOCSPLIT-024(b): detects a rename that changes the document class", () => {
    const oldPath = `${L7}L7-x-test-design.md`;
    const newPath = `${L7}x-test-design.md`;
    const root = initRepo({
      [oldPath]: familyDoc(500, ["A", "B", "C", "D", "E"]),
      [BASELINE]: baselineEntry(oldPath, 500, 5),
    });
    try {
      git(root, "mv", oldPath, newPath);
      commit(root, "remove the L7 topic prefix");

      expect(loadRenamedDocs(root)).toEqual({
        kind: "found",
        renames: [{ from: oldPath, to: newPath }],
      });
      const result = checkDocSplit(root);
      expect(result.ok).toBe(false);
      expect(hasMessage(result, "doc-split-class-changed")).toBe(true);
    } finally {
      removeRepo(root);
    }
  });

  it("U-DOCSPLIT-024(c): returns an empty rename list when the worktree has no renames", () => {
    const root = initRepo({ [`${L6}small.md`]: "## Small" });
    try {
      expect(loadRenamedDocs(root)).toEqual({ kind: "found", renames: [] });
    } finally {
      removeRepo(root);
    }
  });

  it("U-DOCSPLIT-024(c): composes an unchanged small document without findings", () => {
    const root = initRepo({ [`${L6}small.md`]: "## Small" });
    try {
      const result = checkDocSplit(root);
      expect(result.ok).toBe(true);
      expect(hasFindingMessage(result)).toBe(false);
      expect(hasMessage(result, "checked=1 over=0 stale=0 baseline=0")).toBe(true);
    } finally {
      removeRepo(root);
    }
  });

  it("U-DOCSPLIT-024(d): fails closed when git rename input is unreadable", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doc-split-no-git-"));
    try {
      expect(loadRenamedDocs(root)).toEqual({ kind: "unreadable" });
      const result = checkDocSplit(root);
      expect(result.ok).toBe(false);
      expect(hasMessage(result, "doc-split-baseline-base-unreadable")).toBe(true);
    } finally {
      removeRepo(root);
    }
  });
});
