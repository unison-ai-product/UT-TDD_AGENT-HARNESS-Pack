import { describe, expect, it } from "vitest";
import {
  analyzeGateIdFormat,
  gateIdFormatMessages,
  loadGateIdFormatInput,
} from "../src/lint/gate-id-format.ts";

describe("gate id format lint", () => {
  it("U-GID-001: accepts canonical forward gate ids and split shorthand rows", () => {
    const result = analyzeGateIdFormat({
      markdownDocs: [
        {
          file: "docs/process/gates.md",
          content: [
            "| gate | desc |",
            "|---|---|",
            "| **G0.5** | planning |",
            "| G8/G9 | integration/system |",
            "| G12/G13/G14 | release |",
          ].join("\n"),
        },
      ],
      evidenceManifests: [{ file: ".ut-tdd/evidence/g10.json", gate: "G10" }],
    });

    expect(result.ok).toBe(true);
    expect(result.checked).toBe(7);
    expect(gateIdFormatMessages(result)[0]).toContain("OK");
  });

  it("U-GID-002: rejects out-of-range and non-canonical gate ids", () => {
    const result = analyzeGateIdFormat({
      markdownDocs: [
        {
          file: "docs/governance/gate-design.md",
          content: [
            "| ゲート | desc |",
            "|---|---|",
            "| G15 | out of range |",
            "| gate-3 | non canonical |",
          ].join("\n"),
        },
      ],
      evidenceManifests: [{ file: ".ut-tdd/evidence/bad.json", gate: "G01" }],
    });

    expect(result.ok).toBe(false);
    expect(result.violations.map((violation) => violation.gate)).toEqual(["G15", "gate-3", "G01"]);
  });

  it("U-GID-003: live repo keeps forward gate ids in canonical range", () => {
    const result = analyzeGateIdFormat(loadGateIdFormatInput());

    expect(result.ok).toBe(true);
  });
});
