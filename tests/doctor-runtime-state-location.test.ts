import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkRuntimeStateLocation,
  findRuntimeStateLocationFindings,
} from "../src/doctor/runtime-state-location.ts";
import { removeTestTree } from "./support/temp-tree.ts";

describe("doctor runtime state location", () => {
  it("U-TESTHYGIENE-004: accepts only the canonical root runtime state", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-state-location-"));
    try {
      mkdirSync(join(root, ".ut-tdd"));
      expect(findRuntimeStateLocationFindings(root)).toEqual([]);
      expect(checkRuntimeStateLocation(root).ok).toBe(true);
    } finally {
      removeTestTree(root);
    }
  });

  it("U-TESTHYGIENE-005: rejects nested runtime state but ignores owned boundaries", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-state-location-"));
    try {
      mkdirSync(join(root, ".ut-tdd"));
      mkdirSync(join(root, "docs", "plans", ".ut-tdd"), { recursive: true });
      mkdirSync(join(root, ".git", ".ut-tdd"), { recursive: true });
      mkdirSync(join(root, "node_modules", "pkg", ".ut-tdd"), { recursive: true });
      expect(findRuntimeStateLocationFindings(root)).toEqual([
        { kind: "misplaced", path: "docs/plans/.ut-tdd" },
      ]);
      expect(checkRuntimeStateLocation(root).ok).toBe(false);
    } finally {
      removeTestTree(root);
    }
  });

  it("U-TESTHYGIENE-006: fails closed when the repository cannot be scanned", () => {
    const missing = join(tmpdir(), `ut-tdd-state-location-missing-${process.pid}`);
    expect(findRuntimeStateLocationFindings(missing)).toEqual([{ kind: "scan-error", path: "." }]);
    expect(checkRuntimeStateLocation(missing).ok).toBe(false);
  });
});
