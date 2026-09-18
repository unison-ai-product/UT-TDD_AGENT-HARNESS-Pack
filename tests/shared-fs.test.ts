import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureDir } from "../src/shared/fs.ts";

describe("shared fs", () => {
  const mkRoot = () => mkdtempSync(join(tmpdir(), "ut-tdd-shared-fs-"));

  it("U-FS-001: ensureDir creates missing directories", () => {
    const root = mkRoot();
    const target = join(root, "a", "b", "c");
    ensureDir(target, { recursive: true });
    expect(existsSync(target)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("U-FS-002: ensureDir does not throw on existing directory", () => {
    const root = mkRoot();
    const target = join(root, "existing");
    mkdirSync(target);
    expect(() => ensureDir(target)).not.toThrow();
    rmSync(root, { recursive: true, force: true });
  });

  it("U-FS-003: ensureDir throws when path is existing file", () => {
    const root = mkRoot();
    const target = join(root, "file.txt");
    writeFileSync(target, "x");
    expect(() => ensureDir(target)).toThrow();
    rmSync(root, { recursive: true, force: true });
  });
});
