import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDbProjectionCoverage, checkDbProjectionIngestion } from "../src/doctor/db-projection";

describe("doctor db projection checks", () => {
  it("fails closed when coverage and ingestion inputs cannot read the repo root", () => {
    const missingRoot = join(tmpdir(), `ut-tdd-doctor-db-projection-${Date.now()}-missing`);

    const coverage = checkDbProjectionCoverage(missingRoot);
    const ingestion = checkDbProjectionIngestion(missingRoot);

    expect(coverage.ok).toBe(false);
    expect(coverage.messages.join("\n")).toContain("db-projection-coverage - violation");
    expect(ingestion.ok).toBe(false);
    expect(ingestion.messages.join("\n")).toContain("db-projection-ingestion - violation");
  });
});
