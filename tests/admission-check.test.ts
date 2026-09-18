import { describe, expect, it } from "vitest";
import {
  type AdmissionComparison,
  checkPlanAdmission,
} from "../src/plan-admission/admission-check.ts";

const path = "docs/plans/PLAN-L7-99-admission-fixture.md";

function comparison(overrides: Partial<AdmissionComparison> = {}): AdmissionComparison {
  return {
    base: [],
    head: [{ path, content: "not-frontmatter" }],
    changes: [{ kind: "added", path }],
    baseComplete: true,
    headComplete: true,
    ...overrides,
  };
}

describe("PLAN admission application service", () => {
  it("U-PADM-017: aggregates projection and comparison completeness failures", () => {
    const result = checkPlanAdmission({
      baseRef: "main",
      headRef: "HEAD",
      changes: {
        compare: () => comparison({ baseComplete: false, head: [], headComplete: false }),
      },
      projection: {
        lookup: () => undefined,
        validate: () => ({ ok: false, findings: [{ code: "projection-digest-mismatch" }] }),
      },
    });

    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toEqual([
      "plan-admission-projection-invalid",
      "plan-admission-base-incomplete",
      "plan-admission-head-incomplete",
      "plan-admission-head-incomplete",
    ]);
  });

  it("U-PADM-018: converts adapter exceptions into fail-closed findings", () => {
    const result = checkPlanAdmission({
      baseRef: "missing",
      headRef: "HEAD",
      changes: {
        compare: () => {
          throw new Error("base ref missing");
        },
      },
      projection: {
        lookup: () => undefined,
        validate: () => {
          throw new Error("projection unreadable");
        },
      },
    });

    expect(result).toEqual({
      ok: false,
      findings: [
        {
          path: "<comparison>",
          code: "plan-admission-comparison-unavailable",
          detail: "base ref missing",
        },
        {
          path: "<projection>",
          code: "plan-admission-projection-invalid",
          detail: "projection unreadable",
        },
      ],
    });
  });

  it("U-PADM-019: runs the pure analyzer only after both boundaries validate", () => {
    const result = checkPlanAdmission({
      baseRef: "main",
      headRef: "HEAD",
      changes: { compare: () => comparison() },
      projection: { lookup: () => undefined, validate: () => ({ ok: true, findings: [] }) },
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([{ path, code: "plan-admission-frontmatter-invalid" }]);
  });
});
