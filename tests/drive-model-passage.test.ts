import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeDriveModelPassage,
  driveModelPassageMessages,
  loadDriveModelPassageDocs,
} from "../src/lint/drive-model-passage";

const compliant = `# PLAN-X

## Section 2.1 Drive-model Passage Certificate Required

| Drive model / entry mode | Required certificate columns |
|---|---|
| Discovery | trigger, Forward target, residual status |
| Scrum | feedback signal, Forward target, residual status |
| Reverse | R4 routing, re-entry gate, residual status |
| Recovery | correction artifact, Forward target, residual status |
| Incident | permanent-fix Forward route, residual status |
| Refactor | behavior-invariance proof, Forward target, residual status |
| Retrofit | migration plan, Forward target, residual status |
| Add-feature | parent PLAN, Forward target, residual status |
| Research | ADR, Forward target, residual status |
| Design-bottomup | backend-derived FE requirement evidence, Forward target, residual status |
| Version-up | version target, activation route, Forward target, residual status |

## Section 2.2 Next
`;

describe("drive-model passage lint", () => {
  it("U-DMP-001: accepts the complete 11-mode passage table", () => {
    const r = analyzeDriveModelPassage([{ file: "PLAN-X.md", content: compliant }]);

    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(11);
    expect(driveModelPassageMessages(r)[0]).toContain("OK");
  });

  it("U-DMP-002: rejects a mode row without Forward re-entry", () => {
    const content = compliant.replace(
      "trigger, Forward target, residual status",
      "trigger, residual status",
    );
    const r = analyzeDriveModelPassage([{ file: "PLAN-X.md", content }]);

    expect(r.ok).toBe(false);
    expect(r.violations).toContainEqual({
      file: "PLAN-X.md",
      mode: "Discovery",
      reason: "missing_forward_target",
    });
  });

  it("U-DMP-002b: reports missing passage certificate docs as a violation", () => {
    const r = analyzeDriveModelPassage([]);

    expect(r.checked).toBe(0);
    expect(driveModelPassageMessages(r)[0]).toContain("violation");
  });

  it("U-DMP-003: current reconciliation PLAN has all passage certificate modes", () => {
    if (
      !existsSync(
        join(process.cwd(), "docs", "plans", "PLAN-L3-04-upstream-schedule-reconciliation.md"),
      )
    )
      return;

    const docs = loadDriveModelPassageDocs(process.cwd());
    const r = analyzeDriveModelPassage(docs);

    expect(docs.length).toBeGreaterThan(0);
    expect(r.ok).toBe(true);
    expect(r.rows.map((row) => row.mode)).toEqual([
      "Discovery",
      "Scrum",
      "Reverse",
      "Recovery",
      "Incident",
      "Refactor",
      "Retrofit",
      "Add-feature",
      "Research",
      "Design-bottomup",
      "Version-up",
    ]);
  });
});
