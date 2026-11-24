import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzePrivacyScan,
  findEmailHitLines,
  type PrivacyUnit,
} from "../src/lint/privacy-scan.ts";
import { loadDiffPrivacyUnits, loadTreePrivacyUnits } from "../src/lint/privacy-scan-inputs.ts";
import { heavyAfterAll, heavyBeforeAll } from "./support/hook-bounds.ts";
import { removeTestTree } from "./support/temp-tree.ts";

// Keep the synthetic address out of the source text: tree mode also scans tests/.
const P = ["s".repeat(65), "@", "mail-provider.jp"].join("");

let scratchRoot = "";
let redFixtureRoot = "";
let redBase = "";
let redAdded = "";
let redHead = "";
let redUnits: PrivacyUnit[] = [];
let replacementRoot = "";
let replacementBase = "";
let replacementAdded = "";
let replacementHead = "";
let replacementUnits: PrivacyUnit[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
}

function initRepo(name: string): string {
  const root = join(scratchRoot, name);
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Diff Hunk Test");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.autocrlf", "false");
  return root;
}

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text, "utf8");
}

function commit(root: string, message: string): string {
  git(root, "add", "-A");
  git(root, "commit", "-q", "--allow-empty", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

function scan(root: string, base: string, head: string) {
  const loaded = loadDiffPrivacyUnits(root, { base, head });
  expect(loaded.kind).toBe("found");
  if (loaded.kind !== "found") throw new Error("temporary git diff was unreadable");
  return analyzePrivacyScan({
    mode: "diff",
    units: loaded.units,
    skipped: 0,
    denylist: null,
    baseline: null,
    baselineUnreadable: false,
    previousBaseline: null,
  });
}

heavyBeforeAll("git", () => {
  const scratchBase = process.env.UT_TDD_1467_SCRATCH_ROOT?.trim() || tmpdir();
  mkdirSync(scratchBase, { recursive: true });
  scratchRoot = mkdtempSync(join(scratchBase, "ut-tdd-privacy-diff-hunk-"));
  redFixtureRoot = initRepo("plus-prefixed-add-delete");
  write(redFixtureRoot, "docs/steady.md", "base\n");
  redBase = commit(redFixtureRoot, "base");
  write(redFixtureRoot, "docs/plus.md", `++ ${P}\n`);
  redAdded = commit(redFixtureRoot, "add plus-prefixed content");
  rmSync(join(redFixtureRoot, "docs/plus.md"));
  redHead = commit(redFixtureRoot, "remove plus-prefixed line");

  replacementRoot = initRepo("replacement-hunk-add-delete");
  write(replacementRoot, "docs/rewrite.md", "-- x\n");
  replacementBase = commit(replacementRoot, "base with old line");
  write(replacementRoot, "docs/rewrite.md", `++ ${P}\n`);
  replacementAdded = commit(replacementRoot, "replace old line with plus-prefixed content");
  write(replacementRoot, "docs/rewrite.md", "-- x\n");
  replacementHead = commit(replacementRoot, "restore old line");
});

heavyAfterAll("teardown", () => {
  if (scratchRoot) removeTestTree(scratchRoot);
});

describe("privacy scan diff hunk parsing", () => {
  it("U-PRIVDIFF-001: accepts regular file headers, scans additions across files, and ignores deletions", () => {
    const root = initRepo("ordinary-diff");
    write(root, "docs/old.md", `${P}\nkeep\n`);
    write(root, "docs/steady.md", "before\n");
    const base = commit(root, "base files");

    write(root, "docs/old.md", "keep\n");
    write(root, "docs/first.md", `${P}\nplain\n`);
    write(root, "docs/second.md", `plain\n${P}\n`);
    const head = commit(root, "remove old line and add two files");

    const result = scan(root, base, head);
    expect(result.findings.map(({ location, line, kind }) => [location, line, kind])).toEqual([
      [`docs/first.md@${head.slice(0, 12)}`, 1, "privacy-email-hit"],
      [`docs/second.md@${head.slice(0, 12)}`, 2, "privacy-email-hit"],
    ]);
    expect(result.ok).toBe(false);
  });

  it("U-PRIVDIFF-002 prerequisites: builds the intended plus-only add/delete history and confirms scanner health", () => {
    expect(redBase).not.toBe(redAdded);
    expect(redAdded).not.toBe(redHead);
    const patch = git(redFixtureRoot, "show", "--format=", "-U0", redAdded);
    expect(patch).toContain("+++ b/docs/plus.md");
    expect(patch).toContain(`+++ ${P}`);

    const loaded = loadDiffPrivacyUnits(redFixtureRoot, { base: redBase, head: redHead });
    expect(loaded.kind).toBe("found");
    if (loaded.kind !== "found") throw new Error("temporary git diff was unreadable");
    redUnits = loaded.units;

    const ordinaryAddition: PrivacyUnit = {
      source: "diff",
      path: "docs/ordinary.md",
      commit: redAdded,
      field: "content",
      lines: [{ line: 1, text: P }],
    };
    expect(
      analyzePrivacyScan({
        mode: "diff",
        units: [ordinaryAddition],
        skipped: 0,
        denylist: null,
        baseline: null,
        baselineUnreadable: false,
        previousBaseline: null,
      }).findings.map(({ location, line, kind }) => [location, line, kind]),
    ).toEqual([[`docs/ordinary.md@${redAdded.slice(0, 12)}`, 1, "privacy-email-hit"]]);

    const historyResult = analyzePrivacyScan({
      mode: "diff",
      units: redUnits,
      skipped: 0,
      denylist: null,
      baseline: null,
      baselineUnreadable: false,
      previousBaseline: null,
    });
    expect(typeof historyResult.ok).toBe("boolean");
    expect(Array.isArray(historyResult.findings)).toBe(true);

    const tree = loadTreePrivacyUnits(redFixtureRoot, redHead);
    expect(tree.kind).toBe("found");
    if (tree.kind !== "found") throw new Error("temporary head tree was unreadable");
    expect(
      tree.units.flatMap((unit) => (unit.field === "content" ? findEmailHitLines(unit) : [])),
    ).toEqual([]);
  });

  it("U-PRIVDIFF-002: distinguishes an added hunk line beginning ++ from a +++ file header and retains it after a later deletion", () => {
    const result = analyzePrivacyScan({
      mode: "diff",
      units: redUnits,
      skipped: 0,
      denylist: null,
      baseline: null,
      baselineUnreadable: false,
      previousBaseline: null,
    });
    expect(
      result.findings.map(({ location, line, kind }) => [location, line, kind]),
    ).toContainEqual([`docs/plus.md@${redAdded.slice(0, 12)}`, 1, "privacy-email-hit"]);
    expect(result.ok).toBe(false);
  });

  it("U-PRIVDIFF-003 prerequisites: verifies a same-hunk deletion/addition followed by restoration", () => {
    expect(replacementBase).not.toBe(replacementAdded);
    expect(replacementAdded).not.toBe(replacementHead);

    const patch = git(replacementRoot, "show", "--format=", "-U0", replacementAdded);
    const patchLines = patch.split(/\r?\n/);
    const hunkStart = patchLines.findIndex((line) => line.startsWith("@@ "));
    expect(hunkStart).toBeGreaterThanOrEqual(0);
    expect(patchLines[hunkStart + 1]).toBe("--- x");
    expect(patchLines[hunkStart + 2]).toBe(`+++ ${P}`);

    const loaded = loadDiffPrivacyUnits(replacementRoot, {
      base: replacementBase,
      head: replacementHead,
    });
    expect(loaded.kind).toBe("found");
    if (loaded.kind !== "found") throw new Error("replacement history diff was unreadable");
    replacementUnits = loaded.units;

    const historyResult = analyzePrivacyScan({
      mode: "diff",
      units: replacementUnits,
      skipped: 0,
      denylist: null,
      baseline: null,
      baselineUnreadable: false,
      previousBaseline: null,
    });
    expect(typeof historyResult.ok).toBe("boolean");
    expect(Array.isArray(historyResult.findings)).toBe(true);

    const tree = loadTreePrivacyUnits(replacementRoot, replacementHead);
    expect(tree.kind).toBe("found");
    if (tree.kind !== "found") throw new Error("replacement head tree was unreadable");
    expect(
      tree.units.flatMap((unit) => (unit.field === "content" ? findEmailHitLines(unit) : [])),
    ).toEqual([]);
  });

  it("U-PRIVDIFF-003: scans the added content after a --- deletion line in the same hunk, even when a later commit restores the old line", () => {
    const result = analyzePrivacyScan({
      mode: "diff",
      units: replacementUnits,
      skipped: 0,
      denylist: null,
      baseline: null,
      baselineUnreadable: false,
      previousBaseline: null,
    });
    expect(
      result.findings.map(({ location, line, kind }) => [location, line, kind]),
    ).toContainEqual([`docs/rewrite.md@${replacementAdded.slice(0, 12)}`, 1, "privacy-email-hit"]);
    expect(result.ok).toBe(false);
  });
});
