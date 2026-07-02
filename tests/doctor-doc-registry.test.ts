import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkDocConsistency,
  checkEntityCoverage,
  checkFrRegistryAudit,
} from "../src/doctor/doc-registry";
import { checkDocConsistency as checkDocConsistencyFromIndex } from "../src/doctor/index";

describe("doctor doc registry checks", () => {
  it("fails closed when doc registry inputs cannot read the repo root", () => {
    const missingRoot = join(tmpdir(), `ut-tdd-doctor-doc-registry-${Date.now()}-missing`);

    const checks = [
      ["doc-consistency", checkDocConsistency(missingRoot)],
      ["entity-coverage", checkEntityCoverage(missingRoot)],
      ["fr-registry-audit", checkFrRegistryAudit(missingRoot)],
    ] as const;

    for (const [name, result] of checks) {
      expect(result.ok, name).toBe(false);
      expect(result.messages.join("\n"), name).toMatch(/violation/i);
    }
  });

  it("keeps the doctor index re-export path available", () => {
    const missingRoot = join(tmpdir(), `ut-tdd-doctor-doc-registry-index-${Date.now()}-missing`);

    const result = checkDocConsistencyFromIndex(missingRoot);

    expect(result.ok).toBe(false);
    expect(result.messages.join("\n")).toMatch(/doc-consistency.*violation/i);
  });
});
