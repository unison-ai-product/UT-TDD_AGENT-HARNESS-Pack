import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkBaselineConflictWithPreview } from "../src/feedback/baseline-conflict.ts";
import {
  buildFixture,
  canonicalGitCommonDir,
  canonicalPath,
  cleanFixture,
  createPreviewWorktree,
  type Fixture,
  removeFixturePreviewWorktree,
  smallFiles,
  worktreePaths,
} from "./fixtures/baseline-recompute-fixture.ts";

function assertPreviewUsesResolvedRepoParent(repoRoot: string, fixture: Fixture): string {
  const previewRoots: string[] = [];
  const physicalRepoRoot = realpathSync.native(repoRoot);
  const result = checkBaselineConflictWithPreview(repoRoot, fixture.headSha, {
    pr: 1559,
    gates: [
      {
        name: "code-size",
        inScope: (path) => path === "src/alpha.ts",
        baselinePath: "docs/governance/small-baseline.json",
        check: (previewRoot) => {
          previewRoots.push(previewRoot);
          expect(existsSync(previewRoot)).toBe(true);
          expect(existsSync(join(previewRoot, "node_modules"))).toBe(false);
          expect(canonicalPath(dirname(realpathSync.native(previewRoot)))).toBe(
            canonicalPath(dirname(physicalRepoRoot)),
          );
          return { ok: true, findings: [] };
        },
      },
    ],
  });

  expect(result).toMatchObject({
    reason: null,
    preview: { gates: [{ name: "code-size", ok: true }] },
  });
  expect(previewRoots).toHaveLength(1);
  const previewRoot = previewRoots[0];
  if (!previewRoot) throw new Error("preview gate did not capture its repository root");
  expect(basename(previewRoot)).toMatch(/^ut-tdd-baseline-preview-1559-/);
  expect(existsSync(previewRoot)).toBe(false);
  return previewRoot;
}

describe("review merge gate preview path identity", () => {
  it("Windows 8.3 alias and long git common paths have the same physical identity", ({ skip }) => {
    if (process.platform !== "win32") skip();

    const fixture = buildFixture(smallFiles().base, smallFiles().branches);
    try {
      const longPath = fixture.gitCommonDir;
      const result = spawnSync(
        process.env.ComSpec ?? "cmd.exe",
        ["/d", "/c", `for %I in ("${longPath}") do @echo %~sI`],
        { encoding: "utf8", windowsVerbatimArguments: true, windowsHide: true },
      );
      if (result.error) throw new Error(`8.3 helper spawn failed: ${result.error.message}`);
      if (result.status !== 0) {
        throw new Error(`8.3 helper exit ${result.status}: ${result.stderr}${result.stdout}`);
      }
      const shortPath = result.stdout.trim().split(/\r?\n/).at(-1)?.trim();
      if (!shortPath || !isAbsolute(shortPath))
        throw new Error(
          `8.3 helper returned non-absolute output: ${JSON.stringify(result.stdout)}`,
        );
      if (!existsSync(shortPath)) {
        throw new Error(`8.3 helper candidate does not exist: ${JSON.stringify(shortPath)}`);
      }
      if (resolve(shortPath).toLowerCase() === resolve(longPath).toLowerCase()) skip();
      expect(canonicalGitCommonDir(shortPath)).toBe(canonicalGitCommonDir(longPath));
    } finally {
      cleanFixture(fixture);
    }
  });

  it("refuses a preview worktree from another repository and leaves it registered", () => {
    const sample = smallFiles();
    const fixture = buildFixture(sample.base, sample.branches);
    let foreignFixture: Fixture | undefined;
    let preview: ReturnType<typeof createPreviewWorktree> | undefined;
    let expectedCommon: string | undefined;
    try {
      foreignFixture = buildFixture(sample.base, sample.branches);
      preview = createPreviewWorktree(fixture);
      expectedCommon = fixture.gitCommonDir;
      const ownedPreview = preview;
      expect(
        worktreePaths(fixture.work).some(
          (path) => canonicalPath(path) === canonicalPath(ownedPreview.path),
        ),
      ).toBe(true);
      fixture.gitCommonDir = foreignFixture.gitCommonDir;
      const foreign = foreignFixture;
      const fixtureCommon = expectedCommon;

      expect(() => removeFixturePreviewWorktree(fixture, ownedPreview.path)).toThrow(
        `expected=${JSON.stringify(foreign.gitCommonDir)} actual=${JSON.stringify(fixtureCommon)}`,
      );
      expect(existsSync(ownedPreview.path)).toBe(true);
      expect(
        worktreePaths(fixture.work).some(
          (path) => canonicalPath(path) === canonicalPath(ownedPreview.path),
        ),
      ).toBe(true);
    } finally {
      if (expectedCommon) fixture.gitCommonDir = expectedCommon;
      if (preview && existsSync(preview.path)) removeFixturePreviewWorktree(fixture, preview.path);
      cleanFixture(fixture);
      if (foreignFixture) cleanFixture(foreignFixture);
    }
  });

  it("refuses an owned path that is not registered in this fixture repository", () => {
    const sample = smallFiles();
    const fixture = buildFixture(sample.base, sample.branches);
    let foreignFixture: Fixture | undefined;
    let foreignPreview: ReturnType<typeof createPreviewWorktree> | undefined;
    const expectedCommon = fixture.gitCommonDir;
    try {
      foreignFixture = buildFixture(sample.base, sample.branches);
      foreignPreview = createPreviewWorktree(foreignFixture);
      const foreign = foreignFixture;
      const preview = foreignPreview;
      fixture.ownedPreviewPaths.add(preview.path);
      fixture.gitCommonDir = foreign.gitCommonDir;

      expect(() => removeFixturePreviewWorktree(fixture, preview.path)).toThrow(
        "refusing to remove a path not registered as this fixture's worktree",
      );
      expect(existsSync(preview.path)).toBe(true);
      expect(
        worktreePaths(foreign.work).some(
          (path) => canonicalPath(path) === canonicalPath(preview.path),
        ),
      ).toBe(true);
      expect(
        worktreePaths(fixture.work).some(
          (path) => canonicalPath(path) === canonicalPath(preview.path),
        ),
      ).toBe(false);
    } finally {
      fixture.gitCommonDir = expectedCommon;
      if (foreignPreview) fixture.ownedPreviewPaths.delete(foreignPreview.path);
      cleanFixture(fixture);
      if (foreignFixture) cleanFixture(foreignFixture);
    }
  });

  it("uses the linked worktree's physical root parent for the preview", () => {
    const sample = smallFiles();
    const fixture = buildFixture(sample.base, sample.branches);
    const linkedParent = join(fixture.base, "linked-parent");
    const linkedRoot = join(linkedParent, "linked-repository");
    mkdirSync(linkedParent, { recursive: true });
    try {
      execFileSync(
        "git",
        ["-C", fixture.work, "worktree", "add", "-q", "--detach", linkedRoot, fixture.headSha],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      const before = worktreePaths(fixture.work).map(canonicalPath).sort();
      assertPreviewUsesResolvedRepoParent(linkedRoot, fixture);
      expect(worktreePaths(fixture.work).map(canonicalPath).sort()).toEqual(before);
      expect(canonicalPath(linkedParent)).not.toBe(
        canonicalPath(dirname(realpathSync.native(fixture.work))),
      );
    } finally {
      cleanFixture(fixture);
    }
  });

  it("uses the target repository's physical parent when invoked through a junction or symlink", () => {
    const sample = smallFiles();
    const fixture = buildFixture(sample.base, sample.branches);
    const aliasParent = join(fixture.base, "alias-parent");
    const alias = join(aliasParent, "repository-alias");
    mkdirSync(aliasParent, { recursive: true });
    try {
      symlinkSync(fixture.work, alias, process.platform === "win32" ? "junction" : "dir");
      const before = worktreePaths(fixture.work).map(canonicalPath).sort();
      assertPreviewUsesResolvedRepoParent(alias, fixture);
      expect(canonicalPath(dirname(realpathSync.native(alias)))).toBe(
        canonicalPath(dirname(realpathSync.native(fixture.work))),
      );
      expect(canonicalPath(dirname(alias))).not.toBe(
        canonicalPath(dirname(realpathSync.native(alias))),
      );
      expect(worktreePaths(fixture.work).map(canonicalPath).sort()).toEqual(before);
    } finally {
      if (existsSync(alias)) unlinkSync(alias);
      cleanFixture(fixture);
    }
  });

  it("removes a registered Windows 8.3 preview alias through the real safety guard", ({ skip }) => {
    if (process.platform !== "win32") skip();

    const fixture = buildFixture(smallFiles().base, smallFiles().branches);
    try {
      const ownedPreview = createPreviewWorktree(fixture);
      const result = spawnSync(
        process.env.ComSpec ?? "cmd.exe",
        ["/d", "/c", `for %I in ("${ownedPreview.path}") do @echo %~sI`],
        { encoding: "utf8", windowsVerbatimArguments: true, windowsHide: true },
      );
      if (result.error) throw new Error(`8.3 helper spawn failed: ${result.error.message}`);
      if (result.status !== 0) {
        throw new Error(`8.3 helper exit ${result.status}: ${result.stderr}${result.stdout}`);
      }
      const shortPath = result.stdout.trim().split(/\r?\n/).at(-1)?.trim();
      if (!shortPath || !isAbsolute(shortPath)) {
        throw new Error(
          `8.3 helper returned non-absolute output: ${JSON.stringify(result.stdout)}`,
        );
      }
      if (!existsSync(shortPath)) {
        throw new Error(`8.3 helper candidate does not exist: ${JSON.stringify(shortPath)}`);
      }
      if (resolve(shortPath).toLowerCase() === resolve(ownedPreview.path).toLowerCase()) skip();

      expect(canonicalPath(shortPath)).toBe(canonicalPath(ownedPreview.path));
      expect(
        worktreePaths(fixture.work).some(
          (path) => canonicalPath(path) === canonicalPath(shortPath),
        ),
      ).toBe(true);
      removeFixturePreviewWorktree(fixture, shortPath);
      expect(existsSync(ownedPreview.path)).toBe(false);
      expect(fixture.ownedPreviewPaths.size).toBe(0);
      expect(
        worktreePaths(fixture.work).some(
          (path) => canonicalPath(path) === canonicalPath(ownedPreview.path),
        ),
      ).toBe(false);
    } finally {
      cleanFixture(fixture);
    }
  });
});
