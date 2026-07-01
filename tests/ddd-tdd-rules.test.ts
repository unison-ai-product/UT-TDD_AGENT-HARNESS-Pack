import { describe, expect, it } from "vitest";
import {
  analyzeDddTddRules,
  type DddTddInputs,
  dddTddRulesMessages,
  loadDddTddInputs,
} from "../src/lint/ddd-tdd-rules";

function baseInputs(overrides: Partial<DddTddInputs> = {}): DddTddInputs {
  return {
    policy: {
      path: "docs/governance/ddd-tdd-rules.md",
      text: `
- id: domain-boundary
- id: invariant-test-trace
- id: red-first-evidence
- id: test-oracle-strength
- id: integration-gwt
- id: unit-oracle-substance
- id: DDD-INV-001; oracle: U-DDDTDD-002
`,
      ruleIds: [
        "domain-boundary",
        "invariant-test-trace",
        "red-first-evidence",
        "test-oracle-strength",
        "integration-gwt",
        "unit-oracle-substance",
      ],
    },
    workflowDocs: [
      {
        path: "docs/governance/ddd-tdd-rules.md",
        exists: true,
        text: "Workflow Placement\nForward L6\nAdd-feature\nL7 Red\n",
      },
      {
        path: "docs/process/forward/L00-L06-design-phase.md",
        exists: true,
        text: "DDD-TDD-WORKFLOW docs/governance/ddd-tdd-rules.md",
      },
      {
        path: "docs/process/modes/add-feature.md",
        exists: true,
        text: "DDD-TDD-WORKFLOW docs/governance/ddd-tdd-rules.md add-design add-impl",
      },
      {
        path: "docs/process/modes/README.md",
        exists: true,
        text: "DDD-TDD-WORKFLOW docs/governance/ddd-tdd-rules.md",
      },
    ],
    docs: [
      {
        path: "tests/strong.test.ts",
        scope: "test",
        text: 'import { it, expect } from "vitest";\nit("checks value", () => { expect(1).toBe(1); });',
      },
    ],
    l7Text: "U-DDDTDD-002",
    l8Text:
      "| IT-ID | Given | When | Then | Fixture / Boundary | Assertions | Negative / Edge |\n| IT-DDD-01 | a | b | c | d | e | f |",
    plans: [],
    ...overrides,
  };
}

describe("U-DDDTDD DDD/TDD strictness lint", () => {
  it("detects SSoT policy drift", () => {
    const result = analyzeDddTddRules(
      baseInputs({
        policy: {
          path: "docs/governance/ddd-tdd-rules.md",
          text: "- id: domain-boundary\n- id: unknown-rule\n",
          ruleIds: ["domain-boundary", "unknown-rule"],
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.rule)).toContain("ddd-tdd-policy-missing-rule");
    expect(result.violations.map((v) => v.rule)).toContain("ddd-tdd-policy-unknown-rule");
  });

  it("detects missing workflow placement", () => {
    const result = analyzeDddTddRules(baseInputs({ workflowDocs: [] }));
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.rule)).toContain("ddd-tdd-workflow-missing-doc");
  });

  it("detects domain boundary reverse imports", () => {
    const result = analyzeDddTddRules(
      baseInputs({
        docs: [
          {
            path: "src/lint/bad-boundary.ts",
            scope: "source",
            text: 'import { detectMode } from "../runtime/detect";\nexport const x = detectMode;',
          },
          {
            path: "tests/strong.test.ts",
            scope: "test",
            text: 'import { it, expect } from "vitest";\nit("checks value", () => { expect(1).toBe(1); });',
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.rule)).toContain("domain-boundary");
  });

  it("detects invariant rows without L7 oracle trace", () => {
    const result = analyzeDddTddRules(baseInputs({ l7Text: "" }));
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.rule)).toContain("invariant-test-trace");
  });

  it("detects confirmed TDD plans without red-first evidence or with inverted evidence", () => {
    const result = analyzeDddTddRules(
      baseInputs({
        plans: [
          {
            path: "docs/plans/PLAN-L7-99-missing-red.md",
            text: "---\nstatus: confirmed\ntdd_red_required: true\n---",
          },
          {
            path: "docs/plans/PLAN-L7-98-inverted-red.md",
            text: "---\nstatus: confirmed\ntdd_red_required: true\nred_at: 2026-06-09T10:00:00Z\ngreen_at: 2026-06-09T09:00:00Z\n---",
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.violations.filter((v) => v.rule === "red-first-evidence")).toHaveLength(2);
  });

  it("detects missing and weak test oracles", () => {
    const result = analyzeDddTddRules(
      baseInputs({
        docs: [
          {
            path: "tests/no-oracle.test.ts",
            scope: "test",
            text: 'import { it } from "vitest";\nit("does work", () => { const x = 1 + 1; });',
          },
          {
            path: "tests/weak-oracle.test.ts",
            scope: "test",
            text: 'import { it, expect } from "vitest";\nit("truthy only", () => { expect(1).toBeTruthy(); });',
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.violations.filter((v) => v.rule === "test-oracle-strength")).toHaveLength(2);
  });

  it("suppresses only exact baseline debt keys", () => {
    const result = analyzeDddTddRules(
      baseInputs({
        policy: {
          path: "docs/governance/ddd-tdd-rules.md",
          text: `- id: domain-boundary
- id: invariant-test-trace
- id: red-first-evidence
- id: test-oracle-strength
- id: integration-gwt
- id: unit-oracle-substance
- tests/weak-oracle.test.ts:2 test-oracle-strength
`,
          ruleIds: [
            "domain-boundary",
            "invariant-test-trace",
            "red-first-evidence",
            "test-oracle-strength",
            "integration-gwt",
            "unit-oracle-substance",
          ],
        },
        docs: [
          {
            path: "tests/weak-oracle.test.ts",
            scope: "test",
            text: 'import { it, expect } from "vitest";\nit("truthy only", () => { expect(1).toBeTruthy(); });',
          },
        ],
      }),
    );
    expect(result.violations).toEqual([]);
    expect(result.baselineDebt).toBe(1);
  });

  it("detects L8 integration cases without Given/When/Then", () => {
    const result = analyzeDddTddRules(
      baseInputs({
        l8Text: "| IT-ID | Given | When | Then |\n| IT-DDD-01 | Given fixture | | Then result |",
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.rule)).toContain("integration-gwt");
  });

  it("formats doctor messages with path and rule samples", () => {
    const result = analyzeDddTddRules(baseInputs({ l7Text: "" }));
    expect(dddTddRulesMessages(result)[0]).toContain("invariant-test-trace");
  });

  // U-DDDTDD-009 (IMP-083 残差): L7 unit test-design の U-* 行が骨格 (空/trivial expected) なら違反。
  it("detects skeletal unit test-design U-* rows (unit-oracle-substance, IMP-083)", () => {
    const skeleton = analyzeDddTddRules(
      baseInputs({ l7Text: "| U-ID | function | expected |\n| U-FOO-001 | f | - |" }),
    );
    expect(skeleton.ok).toBe(false);
    expect(skeleton.violations.map((v) => v.rule)).toContain("unit-oracle-substance");
    // ヘッダ行 (U-ID) と substantive 行は違反にしない (false-positive 回避)。
    const real = analyzeDddTddRules(
      baseInputs({
        l7Text: "| U-ID | function | expected |\n| U-FOO-002 | f | 同入力→同出力、orphans==[] |",
      }),
    );
    expect(real.violations.map((v) => v.rule)).not.toContain("unit-oracle-substance");
  });

  it("real repo guard has no DDD/TDD strictness violations", () => {
    const result = analyzeDddTddRules(loadDddTddInputs());
    expect(result.violations).toEqual([]);
  });
});
