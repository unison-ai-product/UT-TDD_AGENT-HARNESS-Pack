import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { requireRuntimeRepoRoot, resolveRuntimeRepoRoot } from "../src/runtime/repo-root.ts";

describe("U-TESTHYGIENE-002: runtime repo root", () => {
  it("walks from a nested hook cwd to the nearest UT-TDD root", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-runtime-root-"));
    try {
      const nested = join(root, "docs", "plans");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(root, "ut-tdd.project.json"), "{}\n");
      expect(resolveRuntimeRepoRoot({ cwd: nested, env: {} })).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts only marked absolute provider roots and blocks an unresolved cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-runtime-env-"));
    const isolated = mkdtempSync(join(tmpdir(), "ut-tdd-runtime-isolated-"));
    try {
      writeFileSync(join(root, "ut-tdd.project.json"), "{}\n");
      expect(resolveRuntimeRepoRoot({ cwd: isolated, env: { CLAUDE_PROJECT_DIR: root } })).toBe(
        root,
      );
      expect(
        resolveRuntimeRepoRoot({ cwd: isolated, env: { CLAUDE_PROJECT_DIR: "relative" } }),
      ).toBeNull();
      expect(() =>
        requireRuntimeRepoRoot({ cwd: isolated, env: { CLAUDE_PROJECT_DIR: "relative" } }),
      ).toThrow("runtime state write blocked");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it("uses the hook cwd only when the caller explicitly permits a consumer fallback", () => {
    const isolated = mkdtempSync(join(tmpdir(), "ut-tdd-runtime-hook-"));
    try {
      expect(requireRuntimeRepoRoot({ cwd: isolated, env: {}, allowCwdFallback: true })).toBe(
        isolated,
      );
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it("does not mistake a nested Git marker for a UT-TDD repository root", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-runtime-git-"));
    try {
      const nested = join(root, "vendor", "nested");
      mkdirSync(join(nested, ".git"), { recursive: true });
      writeFileSync(join(root, "ut-tdd.project.json"), "{}\n");
      expect(resolveRuntimeRepoRoot({ cwd: nested, env: {} })).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts an unmarked checkout only when its complete UT-TDD source markers exist", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-runtime-source-"));
    try {
      mkdirSync(join(root, ".git"));
      mkdirSync(join(root, "src"));
      mkdirSync(join(root, ".claude"));
      for (const path of [
        "package.json",
        "src/cli.ts",
        "AGENTS.md",
        "CLAUDE.md",
        ".claude/CLAUDE.md",
      ]) {
        writeFileSync(join(root, path), "\n");
      }
      expect(resolveRuntimeRepoRoot({ cwd: root, env: {} })).toBe(root);
      rmSync(join(root, "CLAUDE.md"));
      expect(resolveRuntimeRepoRoot({ cwd: root, env: {} })).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
