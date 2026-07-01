import { describe, expect, it } from "vitest";
import {
  analyzeDbProjectionCoverage,
  dbProjectionCoverageMessages,
  extractDbProjectionRequirements,
  loadDbProjectionRequirements,
} from "../src/lint/db-projection-coverage";

describe("db-projection-coverage detector", () => {
  it("covers physical-data projection tables and required columns with the schema registry", () => {
    const result = analyzeDbProjectionCoverage(loadDbProjectionRequirements(process.cwd()));

    expect(result.ok).toBe(true);
    expect(result.checked).toBeGreaterThan(30);
    expect(result.missingTables).toEqual([]);
    expect(result.missingColumns).toEqual([]);
    expect(result.primaryKeyMismatches).toEqual([]);
    expect(dbProjectionCoverageMessages(result)[0]).toContain("db-projection-coverage - OK");
  });

  it("fails when a physical-data required table is absent from the schema registry", () => {
    const requirements = extractDbProjectionRequirements(
      [
        "### §9.4 UT evidence history projection (A-122 / IMP-109)",
        "",
        "| table | primary key | required columns | purpose |",
        "|---|---|---|---|",
        "| `definitely_missing_projection_table` | `missing_id` | `plan_id`, `status` | sentinel |",
      ].join("\n"),
    );

    const result = analyzeDbProjectionCoverage(requirements);

    expect(result.ok).toBe(false);
    expect(result.missingTables.map((item) => item.table)).toEqual([
      "definitely_missing_projection_table",
    ]);
    expect(dbProjectionCoverageMessages(result).join("\n")).toContain("missing table");
  });
});
