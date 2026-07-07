import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkChangeImpact,
  checkChangeSetIntegrity,
  checkModuleDrift,
} from "../src/doctor/lint-gates";

describe("doctor lint gate direct checks", () => {
  it("fails closed when the repo root cannot be read", () => {
    const missingRoot = join(tmpdir(), `ut-tdd-doctor-lint-gates-${Date.now()}-missing`);

    const checks = [
      ["module-drift", checkModuleDrift(missingRoot)],
      ["change-impact", checkChangeImpact(missingRoot)],
      ["change-set-integrity", checkChangeSetIntegrity(missingRoot)],
    ] as const;

    for (const [name, result] of checks) {
      expect(result.ok, name).toBe(false);
      expect(result.messages.join("\n"), name).toContain(`${name} - violation`);
    }
  });

  it("skips git change-set gates for non-git distribution directories", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-lint-gates-"));
    try {
      mkdirSync(join(root, "src"));

      const impact = checkChangeImpact(root);
      const integrity = checkChangeSetIntegrity(root);

      expect(impact).toEqual({
        ok: true,
        messages: ["change-impact — skipped (not a git repository)"],
      });
      expect(integrity).toEqual({
        ok: true,
        messages: ["change-set-integrity — skipped (not a git repository)"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
