import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendDesignDecision, DESIGN_DECISION_LOG_PATH } from "../src/elicitation/record.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const tempDirs: string[] = [];

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ut-tdd-elicit-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) removeTestTree(dir);
});

describe("elicitation stage-bound context (U-ELICIT)", () => {
  it("U-ELICIT-006: appendDesignDecision writes an append-only JSONL record and validates input", () => {
    const repoRoot = tempRepo();
    appendDesignDecision(repoRoot, {
      issueNumber: 906,
      currentLocation: "U20d: record",
      topic: "方式選択",
      options: ["A", "B"],
      chosen: "A",
      reason: "trade-off で A が優位",
      recordedAt: "2026-07-13T00:00:00Z",
    });
    appendDesignDecision(repoRoot, {
      issueNumber: 906,
      topic: "二件目",
      chosen: "B",
      reason: "追記が壊れないこと",
      recordedAt: "2026-07-13T00:01:00Z",
    });
    const lines = readFileSync(join(repoRoot, DESIGN_DECISION_LOG_PATH), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({
      issue_number: 906,
      current_location: "U20d: record",
      chosen: "A",
      options: ["A", "B"],
    });
    expect(() =>
      appendDesignDecision(repoRoot, {
        issueNumber: 906,
        topic: "",
        chosen: "A",
        reason: "r",
      }),
    ).toThrow(/topic/);
  });
});
