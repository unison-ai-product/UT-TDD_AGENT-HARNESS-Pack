import { describe, expect, it } from "vitest";
import {
  analyzeTelemetryClosure,
  loadTelemetryClosureDocs,
  telemetryClosureMessages,
} from "../src/lint/telemetry-closure";

const compliant = `# A-TEST

## Telemetry Closure Matrix

| Requirement | Required evidence | Current evidence | Automation owner | Status |
|---|---|---|---|---|
| Skill firing parameters | recommendation and invocation rows | tables exist but no rows | DB projection + CLI + doctor | \`gap\` |
| Trouble logs | trouble rows and findings | hook rows exist | session-log + hook_events + feedback engine | \`partial\` |
| GitHub issue creation outside Forward | issue queue and approval | no queue | GitHub issue queue + doctor | \`blocked-human\` |
| Drive model firing-rate measurement | numerator and denominator | drive rows exist | DB projection + quality_signals + doctor | \`partial\` |
| Plan/workflow retry detection | retry groups | hook rows exist | hook_events + workflow_runs + feedback engine | \`gap\` |
| Bottleneck detection | stale workflow signals | stale check exists | doctor + workflow_runs + quality_signals | \`partial\` |
| Improvement log | backlog bridge | backlog exists | feedback engine + improvement-backlog | \`partial\` |
| Measurement-to-feedback loop | feedback events | engine exists | feedback engine + DB projection + doctor | \`partial\` |
| Project hook configuration | project-local hook settings | settings exist | project-hook + doctor | \`partial\` |

## Next
`;

describe("telemetry-closure lint", () => {
  it("U-TCLOS-001: accepts telemetry matrix with explicit non-closed statuses", () => {
    const r = analyzeTelemetryClosure([{ file: "A.md", content: compliant }]);

    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(9);
    expect(r.openRows).toHaveLength(9);
    expect(telemetryClosureMessages(r)[0]).toContain("non-closed 9");
  });

  it("U-TCLOS-002: fails missing expected telemetry row", () => {
    const content = compliant.replace(
      "| Improvement log | backlog bridge | backlog exists | feedback engine + improvement-backlog | `partial` |\n",
      "",
    );
    const r = analyzeTelemetryClosure([{ file: "A.md", content }]);

    expect(r.ok).toBe(false);
    expect(r.violations).toContainEqual({
      file: "A.md",
      requirement: "Improvement log",
      reason: "missing_expected_requirement",
    });
  });

  it("U-TCLOS-002b: reports missing telemetry docs as a violation", () => {
    const r = analyzeTelemetryClosure([]);

    expect(r.checked).toBe(0);
    expect(telemetryClosureMessages(r)[0]).toContain("violation");
  });

  it("U-TCLOS-003: current A-134 audit lists all telemetry closure requirements", () => {
    const docs = loadTelemetryClosureDocs(process.cwd());
    const r = analyzeTelemetryClosure(docs);

    expect(docs.length).toBeGreaterThan(0);
    expect(r.ok).toBe(true);
    expect(r.rows.map((row) => row.requirement)).toEqual([
      "Skill firing parameters",
      "Trouble logs",
      "GitHub issue creation outside Forward",
      "Drive model firing-rate measurement",
      "Plan/workflow retry detection",
      "Bottleneck detection",
      "Improvement log",
      "Measurement-to-feedback loop",
      "Project hook configuration",
    ]);
    expect(r.openRows).toEqual([]);
    expect(telemetryClosureMessages(r)[0]).toContain("OK");
  });
});
