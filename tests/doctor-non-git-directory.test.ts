import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkChangeImpact, checkChangeSetIntegrity } from "../src/doctor/lint-gates.ts";
import { removeTestTree } from "./support/temp-tree.ts";

describe("doctor non-git directory", () => {
  it("skips change-impact / change-set-integrity instead of failing closed", () => {
    // ZIP 展開のみ (非 git) の利用環境: git status が引けないだけで doctor を落とさない。
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-nongit-"));
    try {
      const impact = checkChangeImpact(root);
      const integrity = checkChangeSetIntegrity(root);
      expect(impact.ok).toBe(true);
      expect(impact.messages.join("\n")).toMatch(/skipped \(not a git repository\)/);
      expect(integrity.ok).toBe(true);
      expect(integrity.messages.join("\n")).toMatch(/skipped \(not a git repository\)/);
    } finally {
      removeTestTree(root);
    }
  });
});
