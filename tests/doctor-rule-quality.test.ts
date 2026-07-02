import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkCodingRules,
  checkDddTddRules,
  checkDesignLanguage,
  checkGateConfirm,
  checkReadability,
  checkRuleDrift,
  checkRuntimePortability,
  checkRuntimeReadability,
} from "../src/doctor/rule-quality";

describe("doctor rule quality checks", () => {
  it("fails closed when rule and readability inputs cannot read the repo root", () => {
    const missingRoot = join(tmpdir(), `ut-tdd-doctor-rule-quality-${Date.now()}-missing`);

    const checks = [
      ["coding-rules", checkCodingRules(missingRoot)],
      ["design-language", checkDesignLanguage(missingRoot)],
      ["ddd-tdd-rules", checkDddTddRules(missingRoot)],
      ["runtime-portability", checkRuntimePortability(missingRoot)],
      ["rule-drift", checkRuleDrift(missingRoot)],
      ["gate-confirm", checkGateConfirm(missingRoot)],
      ["readability", checkReadability(missingRoot)],
      ["runtime-readability", checkRuntimeReadability(missingRoot)],
    ] as const;

    for (const [name, result] of checks) {
      expect(result.ok, name).toBe(false);
      expect(result.messages.join("\n"), name).toContain(`${name} - violation`);
    }
  });
});
