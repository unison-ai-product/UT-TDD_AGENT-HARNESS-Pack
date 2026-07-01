import { describe, expect, it } from "vitest";
import {
  analyzeRuleAutomationClosure,
  loadRuleAutomationClosureDocs,
  ruleAutomationClosureMessages,
} from "../src/lint/rule-automation-closure";

const doc = `# PLAN-X

## Section 2.3 Rule Automation Closure Required

| Rule | Required automation owner | Current status |
|---|---|---|
| FR coverage | doctor + plan-lint | \`closed\` |
| DB registration | projection writer + DB check | \`gap\` |

## Section 3 Next
`;

describe("rule automation closure lint", () => {
  it("U-RAC-001: parses closure table rows and surfaces non-closed rules", () => {
    const r = analyzeRuleAutomationClosure([{ file: "PLAN-X.md", content: doc }]);

    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(2);
    expect(r.openRows.map((row) => row.rule)).toEqual(["DB registration"]);
    expect(ruleAutomationClosureMessages(r)[0]).toContain("non-closed 1");
  });

  it("U-RAC-002: rejects a text-only rule without a known automation owner", () => {
    const content = doc.replace("projection writer + DB check", "manual checklist");
    const r = analyzeRuleAutomationClosure([{ file: "PLAN-X.md", content }]);

    expect(r.ok).toBe(false);
    expect(r.violations).toEqual([
      { file: "PLAN-X.md", rule: "DB registration", reason: "unknown_owner" },
    ]);
    expect(ruleAutomationClosureMessages(r)[0]).toContain("violation 1");
  });

  it("U-RAC-002b: reports missing closure docs as a violation", () => {
    const r = analyzeRuleAutomationClosure([]);

    expect(r.checked).toBe(0);
    expect(ruleAutomationClosureMessages(r)[0]).toContain("violation");
  });

  it("U-RAC-003: current reconciliation PLAN has no text-only or scheduled rule closures", () => {
    const docs = loadRuleAutomationClosureDocs(process.cwd());
    const r = analyzeRuleAutomationClosure(docs);

    expect(docs.length).toBeGreaterThan(0);
    expect(r.ok).toBe(true);
    expect(r.openRows).toEqual([]);
    expect(ruleAutomationClosureMessages(r)[0]).toContain("OK");
  });
});
