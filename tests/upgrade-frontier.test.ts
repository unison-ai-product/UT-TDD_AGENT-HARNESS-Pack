import { describe, expect, it } from "vitest";
import {
  parseUpgradeFrontier,
  upgradeFrontierMessage,
  upgradeFrontierViolations,
} from "../src/vmodel/upgrade-frontier.ts";

describe("active Vモデル upgrade frontier", () => {
  const schedule = [
    "| `plan_id` | `current_location` | `rag` | `status` | `blocked_reason` |",
    "|---|---|---|---|---|",
    "| PLAN-BASE | baseline complete | green | confirmed |  |",
    "| PLAN-U18-A | U18a design | yellow | draft | review |",
    "| PLAN-U18-B | U18b review | yellow | confirmed | evidence |",
  ].join("\n");

  it("surfaces yellow and draft rows without converting expected progress into failure", () => {
    const result = parseUpgradeFrontier(schedule);
    expect(result.map((entry) => entry.planId)).toEqual(["PLAN-U18-A", "PLAN-U18-B"]);
    expect(upgradeFrontierMessage(result)).toContain("IN-PROGRESS");
    expect(upgradeFrontierMessage(result)).not.toContain("CLEAR");
  });

  it("is clear only when every authored schedule row is green and non-draft", () => {
    const result = parseUpgradeFrontier(
      schedule.replaceAll("yellow", "green").replaceAll("draft", "confirmed"),
    );
    expect(result).toEqual([]);
    expect(upgradeFrontierMessage(result)).toBe("active-upgrade-frontier — CLEAR");
  });

  it("fails closed for a missing table, missing columns, empty rows, and duplicate IDs", () => {
    expect(() => parseUpgradeFrontier("# schedule")).toThrow("table is missing");
    expect(() =>
      parseUpgradeFrontier(
        ["| plan_id | rag | status |", "|---|---|---|", "| P1 | green | confirmed |"].join("\n"),
      ),
    ).toThrow("columns are missing");
    expect(() =>
      parseUpgradeFrontier(
        [
          "| plan_id | current_location | rag | status | blocked_reason |",
          "|---|---|---|---|---|",
        ].join("\n"),
      ),
    ).toThrow("no rows");
    expect(() =>
      parseUpgradeFrontier(`${schedule}\n| PLAN-U18-A | duplicate | yellow | draft | x |`),
    ).toThrow("duplicate plan_id");
  });

  it("turns a red authored row into a hard-gate violation", () => {
    const entries = parseUpgradeFrontier(
      schedule.replace(
        "| PLAN-U18-B | U18b review | yellow | confirmed | evidence |",
        "| PLAN-U18-B | U18b review | red | confirmed | blocked |",
      ),
    );
    expect(upgradeFrontierViolations(entries)).toEqual([
      "active-upgrade-frontier - violation: PLAN-U18-B is red (blocked)",
    ]);
  });

  it("fails closed for an invalid separator, rag, or PLAN status", () => {
    expect(() =>
      parseUpgradeFrontier(schedule.replace("|---|---|---|---|---|", "|---|oops|---|---|---|")),
    ).toThrow("separator row is invalid");
    expect(() =>
      parseUpgradeFrontier(schedule.replace("| yellow | draft |", "| blue | draft |")),
    ).toThrow("invalid rag=blue");
    expect(() =>
      parseUpgradeFrontier(schedule.replace("| yellow | draft |", "| yellow | nonsense |")),
    ).toThrow("invalid status=nonsense");
  });
});
