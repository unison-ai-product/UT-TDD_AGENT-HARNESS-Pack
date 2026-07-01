import { describe, expect, it } from "vitest";
import {
  analyzeRightArmGatePlanning,
  rightArmGatePlanningMessages,
} from "../src/lint/right-arm-gate-planning";

function backlogRow(status: string, link: string): string {
  return [
    "## §1 backlog",
    "| ID | date | context | issue | candidate | status | link |",
    "|---|---|---|---|---|---|---|",
    `| **IMP-052** | 2026-06-04 | Phase1 | G8-G14 carry | doc / policy | ${status} | ${link} |`,
  ].join("\n");
}

describe("right-arm gate planning lint", () => {
  it("fails when G8-G14 carry is still unplanned", () => {
    const result = analyzeRightArmGatePlanning({
      gatesMd:
        "注: G8-G14 の機械検証条件は概念定義に留まる。G8-G14 機械化 PLAN は未起票のまま = carry。",
      backlogMd: backlogRow("observed", "gates.md §1 注記から本 IMP を参照"),
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toContain(
      "IMP-052 is still observed instead of routed to a concrete PLAN",
    );
    expect(result.violations).toContain("G8-G14 mechanization carry has no PLAN reference");
    expect(result.violations).toContain(
      "docs/process/gates.md still marks G8-G14 mechanization as unplanned",
    );
  });

  it("passes when IMP-052 is routed to concrete PLAN references", () => {
    const result = analyzeRightArmGatePlanning({
      gatesMd:
        "注: G8-G14 の機械検証条件は PLAN-L7-130-right-arm-gate-planning / PLAN-REVERSE-130-right-arm-gate-planning で起票済み。",
      backlogMd: backlogRow(
        "implemented",
        "PLAN-L7-130-right-arm-gate-planning / PLAN-REVERSE-130-right-arm-gate-planning",
      ),
    });

    expect(result.ok).toBe(true);
    expect(result.planRefs).toEqual([
      "PLAN-L7-130-right-arm-gate-planning",
      "PLAN-REVERSE-130-right-arm-gate-planning",
    ]);
    expect(rightArmGatePlanningMessages(result)[0]).toContain("right-arm-gate-planning - OK");
  });
});
