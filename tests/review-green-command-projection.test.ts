import { describe, expect, it } from "vitest";
import { openHarnessDb } from "../src/state-db/index";
import { rebuildHarnessDb } from "../src/state-db/projection-writer";

describe("review green command projection", () => {
  it("projects review_evidence.green_commands into test_runs", () => {
    const db = openHarnessDb(":memory:");
    try {
      const result = rebuildHarnessDb({ repoRoot: process.cwd(), db });

      expect(result.ok).toBe(true);
      const rows = db
        .prepare(
          "SELECT command, exit_code, evidence_path, output_digest FROM test_runs WHERE plan_id = ? ORDER BY command",
        )
        .all("PLAN-L7-108-review-green-command-evidence") as Array<{
        command: string;
        exit_code: number;
        evidence_path: string;
        output_digest: string;
      }>;

      expect(rows.length).toBeGreaterThanOrEqual(4);
      expect(rows.every((row) => row.exit_code === 0)).toBe(true);
      expect(rows.map((row) => row.evidence_path)).toContain("tests/review-evidence.test.ts");
      expect(rows.every((row) => /^sha256:[a-f0-9]{16,64}$/i.test(row.output_digest))).toBe(true);
    } finally {
      db.close();
    }
  }, 20_000);
});
