import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeCycleP4Verification,
  cycleP4VerificationMessages,
  loadCycleP4VerificationDocs,
} from "../src/lint/cycle-p4-verification";

const legacyRuntimeName = ["HE", "LIX"].join("");

const compliant = `# A-TEST

## Cycle P4 Verification Closure Matrix

| Requirement | Scope | Required evidence | Current evidence | Automation owner | Status |
|---|---|---|---|---|---|
| Cycle P4 L7 DB integration | L7-DB | db rows | \`tests/cycle-p4-verification.test.ts\` | DB projection + doctor | \`closed\` |
| L8-L14 local verification band | local band | workflow rows | \`tests/cycle-p4-verification.test.ts\` | DB projection + verification tests | \`closed\` |
| UT-TDD Run P4 L9-L11 boundary | run layer | naming separation | \`tests/cycle-p4-verification.test.ts\` | roadmap + doctor | \`closed\` |
| Production and PO signoff boundary | external | human required | \`tests/cycle-p4-verification.test.ts\` | DB projection + verification tests | \`human_required\` |
| Handover current action | handover | current pointer | \`tests/cycle-p4-verification.test.ts\` | handover + doctor | \`closed\` |
| Source isolation current vocabulary | current docs | UT-TDD wording | \`tests/cycle-p4-verification.test.ts\` | roadmap + doctor + verification lint | \`closed\` |
| Telemetry and self-improvement closure | telemetry | feedback loop | \`tests/cycle-p4-verification.test.ts\` | telemetry closure + doctor | \`closed\` |
| Feature residual closure | feature residual | closure evidence | \`tests/cycle-p4-verification.test.ts\` | fr-roadmap coverage + doctor | \`closed\` |
| Placeholder-deps carry boundary | carry | explicit boundary | \`tests/cycle-p4-verification.test.ts\` | test-design + doctor | \`closed\` |
| Skill assignment closure | skill metadata | layer and drive-model assignment | \`tests/cycle-p4-verification.test.ts\` | skill + DB projection + doctor | \`closed\` |
| Source migration coverage | source audit | reference-only source audit | \`tests/cycle-p4-verification.test.ts\` | source-isolation + migration audit + doctor | \`closed\` |

## Next
`;

describe("cycle-p4-verification lint", () => {
  it("U-CP4-001: accepts all required Cycle P4 closure rows with evidence paths", () => {
    const r = analyzeCycleP4Verification([{ file: "A.md", content: compliant }], process.cwd());

    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(11);
    expect(cycleP4VerificationMessages(r)[0]).toContain("OK");
  });

  it("U-CP4-002: fails missing source isolation row", () => {
    const content = compliant.replace(
      "| Source isolation current vocabulary | current docs | UT-TDD wording | `tests/cycle-p4-verification.test.ts` | roadmap + doctor + verification lint | `closed` |\n",
      "",
    );
    const r = analyzeCycleP4Verification([{ file: "A.md", content }], process.cwd());

    expect(r.ok).toBe(false);
    expect(r.violations).toContainEqual({
      file: "A.md",
      requirement: "Source isolation current vocabulary",
      reason: "missing_expected_requirement",
    });
  });

  it("U-CP4-003: fails closure rows without real evidence paths", () => {
    const content = compliant.replace("`tests/cycle-p4-verification.test.ts`", "`docs/missing.md`");
    const r = analyzeCycleP4Verification([{ file: "A.md", content }], process.cwd());

    expect(r.ok).toBe(false);
    expect(r.violations).toContainEqual({
      file: "A.md",
      requirement: "Cycle P4 L7 DB integration",
      reason: "missing_evidence_path",
    });
  });

  it("U-CP4-004: current A-136 audit is complete", () => {
    const docs = loadCycleP4VerificationDocs(process.cwd());
    const r = analyzeCycleP4Verification(docs, process.cwd());

    expect(docs.length).toBeGreaterThan(0);
    expect(r.ok).toBe(true);
    expect(r.rows.map((row) => row.requirement)).toEqual([
      "Cycle P4 L7 DB integration",
      "L8-L14 local verification band",
      "UT-TDD Run P4 L9-L11 boundary",
      "Production and PO signoff boundary",
      "Handover current action",
      "Source isolation current vocabulary",
      "Telemetry and self-improvement closure",
      "Feature residual closure",
      "Placeholder-deps carry boundary",
      "Skill assignment closure",
      "Source migration coverage",
    ]);
  });

  it("U-CP4-005: fails current operational files that reintroduce legacy source cutover terms", () => {
    const repo = mkdtempSync(join(tmpdir(), "ut-tdd-cp4-"));
    mkdirSync(join(repo, "docs", "design", "harness", "L3-functional"), { recursive: true });
    mkdirSync(join(repo, "tests"), { recursive: true });
    writeFileSync(join(repo, "tests", "cycle-p4-verification.test.ts"), "");
    writeFileSync(
      join(repo, "docs", "design", "harness", "L3-functional", "roadmap.md"),
      `${legacyRuntimeName} to UT cutover`,
    );

    const r = analyzeCycleP4Verification([{ file: "A.md", content: compliant }], repo);

    expect(r.ok).toBe(false);
    expect(r.violations).toContainEqual({
      file: "docs/design/harness/L3-functional/roadmap.md",
      reason: "forbidden_legacy_source_term",
    });
  });
});
