import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkDependencyDrift,
  checkRegressionExpansion,
} from "../src/doctor/dependency-regression.ts";

describe("doctor dependency adapters", () => {
  it("keeps extracted adapters fail-closed when the repository cannot be read", () => {
    const missingRoot = join(tmpdir(), `ut-tdd-doctor-dependency-missing-${Date.now()}-nope`);

    expect(checkDependencyDrift(missingRoot)).toMatchObject({
      ok: false,
      result: null,
      messages: ["dependency-drift - violation: repo root could not be read"],
    });
    expect(checkRegressionExpansion(missingRoot, null)).toMatchObject({
      ok: false,
      messages: ["regression-expansion - violation: repo root could not be read"],
    });
  });
});
