import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeCycleP4Verification,
  cycleP4VerificationMessages,
} from "../src/lint/cycle-p4-verification.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const legacyRuntimeName = ["HE", "LIX"].join("");

const roadmapFiles = [
  "docs/design/harness/L3-functional/roadmap.md",
  "src/doctor/roadmap-verification.ts",
];
const testEvidencePath = "tests/cycle-p4-verification.test.ts";
const sourceIsolationEvidence = [
  ...roadmapFiles,
  testEvidencePath,
  "plans-archive-20261102:src/lint/roadmap-registry.ts",
]
  .map((path) => `\`${path}\``)
  .join(", ");
const sourceIsolationRow = `| Source isolation current vocabulary | current docs | UT-TDD wording | ${sourceIsolationEvidence} | roadmap + doctor + verification lint | \`closed\` |`;

const compliant = `# A-TEST

## Cycle P4 Verification Closure Matrix

| Requirement | Scope | Required evidence | Current evidence | Automation owner | Status |
|---|---|---|---|---|---|
| Cycle P4 L7 DB integration | L7-DB | db rows | \`tests/cycle-p4-verification.test.ts\` | DB projection + doctor | \`closed\` |
| L8-L14 local verification band | local band | workflow rows | \`tests/cycle-p4-verification.test.ts\` | DB projection + verification tests | \`closed\` |
| UT-TDD Run P4 L9-L11 boundary | run layer | naming separation | \`tests/cycle-p4-verification.test.ts\` | roadmap + doctor | \`closed\` |
| Production and PO signoff boundary | external | human required | \`tests/cycle-p4-verification.test.ts\` | DB projection + verification tests | \`human_required\` |
| Handover current action | handover | current pointer | \`tests/cycle-p4-verification.test.ts\` | handover + doctor | \`closed\` |
${sourceIsolationRow}
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
    const content = compliant.replace(`${sourceIsolationRow}\n`, "");
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

  it("U-CP4-005: fails current operational files that reintroduce legacy source cutover terms", () => {
    const repo = mkdtempSync(join(tmpdir(), "ut-tdd-cp4-"));
    try {
      mkdirSync(join(repo, "tests"), { recursive: true });
      writeFileSync(join(repo, testEvidencePath), "");
      for (const file of roadmapFiles) {
        const path = join(repo, file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${legacyRuntimeName} to UT cutover`);
      }

      const r = analyzeCycleP4Verification([{ file: "A.md", content: compliant }], repo);

      expect(r.ok).toBe(false);
      expect(r.violations).toEqual(
        roadmapFiles.map((file) => ({ file, reason: "forbidden_legacy_source_term" })),
      );
    } finally {
      removeTestTree(repo);
    }
  });
});
