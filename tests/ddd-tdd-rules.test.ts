import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeDddTddRules,
  type DddTddInputs,
  dddTddRulesMessages,
  loadDddTddInputs,
} from "../src/lint/ddd-tdd-rules.ts";
import { removeTestTree } from "./support/temp-tree.ts";

function createDddTddSplitL7Fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ddd-tdd-split-l7-"));
  const governance = join(root, "docs", "governance");
  const harness = join(root, "docs", "test-design", "harness");
  mkdirSync(governance, { recursive: true });
  mkdirSync(harness, { recursive: true });
  writeFileSync(
    join(governance, "ddd-tdd-rules.md"),
    [
      "- id: domain-boundary",
      "- id: invariant-test-trace",
      "- id: test-oracle-strength",
      "- id: integration-gwt",
      "- id: unit-oracle-substance",
      "- id: DDD-INV-002 oracle: U-DDDTDD-002 - The invariant has an explicit L7 oracle.",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(join(harness, "L7-unit-test-design.md"), "PRIMARY-L7-SENTINEL\n", "utf8");
  writeFileSync(
    join(harness, "L7-split-x-test-design.md"),
    [
      "| ID | Target | Oracle |",
      "|---|---|---|",
      "| U-DDDTDD-002 | invariant trace | DDD-INV-002 remains discoverable when its substantive oracle row exists only in the split L7 test design. |",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(join(harness, "README.md"), "NON-L7-SENTINEL\n", "utf8");
  return root;
}

function baseInputs(overrides: Partial<DddTddInputs> = {}): DddTddInputs {
  return {
    policy: {
      path: "docs/governance/ddd-tdd-rules.md",
      text: `
- id: domain-boundary
- id: invariant-test-trace
- id: test-oracle-strength
- id: integration-gwt
- id: unit-oracle-substance
- id: DDD-INV-001; oracle: U-DDDTDD-002
`,
      ruleIds: [
        "domain-boundary",
        "invariant-test-trace",
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
    ...overrides,
  };
}

function oracleStrengthMessages(text: string): string[] {
  const result = analyzeDddTddRules(
    baseInputs({
      docs: [{ path: "tests/oracle-helper-fixture.test.ts", scope: "test", text }],
    }),
  );
  return result.violations
    .filter((violation) => violation.rule === "test-oracle-strength")
    .map((violation) => violation.message);
}

const NO_ORACLE_MESSAGE = "Test cases must contain an explicit expect/assert oracle.";
const WEAK_ORACLE_MESSAGE =
  "Test cases must not rely only on toBeTruthy/toBeFalsy weak assertions.";

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

  it("keeps the primary L7 document in loaded input", () => {
    const root = createDddTddSplitL7Fixture();
    try {
      expect(loadDddTddInputs(root).l7Text).toContain("PRIMARY-L7-SENTINEL");
    } finally {
      removeTestTree(root);
    }
  });

  it("excludes non-L7 Markdown from loaded L7 input", () => {
    const root = createDddTddSplitL7Fixture();
    try {
      expect(loadDddTddInputs(root).l7Text).not.toContain("NON-L7-SENTINEL");
    } finally {
      removeTestTree(root);
    }
  });

  it("U-DOCSPLIT-026: finds U-DDDTDD-002 when only a split L7 document defines it", () => {
    const root = createDddTddSplitL7Fixture();
    try {
      const result = analyzeDddTddRules(loadDddTddInputs(root));
      expect(
        result.violations.filter(
          (violation) =>
            violation.rule === "invariant-test-trace" &&
            violation.message.includes("Invariant DDD-INV-002"),
        ),
      ).toEqual([]);
    } finally {
      removeTestTree(root);
    }
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
- id: test-oracle-strength
- id: integration-gwt
- id: unit-oracle-substance
- tests/weak-oracle.test.ts:2 test-oracle-strength
`,
          ruleIds: [
            "domain-boundary",
            "invariant-test-trace",
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

  describe("U-ORACLEHELPER same-file helper resolution oracles", () => {
    it("U-ORACLEHELPER-001 resolves a strong function helper", () => {
      expect(
        oracleStrengthMessages(`function h(x: number) { expect(x).toBe(1); }
it("uses helper", () => { h(1); });`),
      ).toEqual([]);
    });

    it("U-ORACLEHELPER-002 does not treat an empty helper as an oracle", () => {
      expect(
        oracleStrengthMessages(`function h(x: number) {}
it("uses empty helper", () => { h(1); });`),
      ).toEqual([NO_ORACLE_MESSAGE]);
    });

    it("U-ORACLEHELPER-003 propagates a weak-only helper result", () => {
      expect(
        oracleStrengthMessages(`function h(x: number) { expect(x).toBeTruthy(); }
it("uses weak helper", () => { h(1); });`),
      ).toEqual([WEAK_ORACLE_MESSAGE]);
    });

    it("U-ORACLEHELPER-004 lets a strong helper clear callback weak-only status", () => {
      expect(
        oracleStrengthMessages(`function h(x: number) { expect(x).toBe(1); }
it("combines callback and helper", () => { expect(1).toBeTruthy(); h(1); });`),
      ).toEqual([]);
    });

    it("U-ORACLEHELPER-005a does not resolve a helper outside its describe scope", () => {
      expect(
        oracleStrengthMessages(`describe("inner", () => {
  function h(x: number) { expect(x).toBe(1); }
});
it("calls out-of-scope helper", () => { h(1); });`),
      ).toEqual([NO_ORACLE_MESSAGE]);
    });

    it("U-ORACLEHELPER-005b does not resolve an imported helper", () => {
      expect(
        oracleStrengthMessages(`import { expectOk } from "./helpers";
it("calls imported helper", () => { expectOk(1); });`),
      ).toEqual([NO_ORACLE_MESSAGE]);
    });

    it("U-ORACLEHELPER-006a respects a local function shadow", () => {
      expect(
        oracleStrengthMessages(`function h(x: number) { expect(x).toBe(1); }
it("calls shadow", () => { const h = () => {}; h(); });`),
      ).toEqual([NO_ORACLE_MESSAGE]);
    });

    it("U-ORACLEHELPER-006b respects a local non-function shadow", () => {
      expect(
        oracleStrengthMessages(`function h(x: number) { expect(x).toBe(1); }
it("calls non-function shadow", () => { const h = makeNoop(); h(); });`),
      ).toEqual([NO_ORACLE_MESSAGE]);
    });

    it("U-ORACLEHELPER-006c respects a helper parameter shadow", () => {
      expect(
        oracleStrengthMessages(`function h() { expect(1).toBe(1); }
function wrap(h: () => void) { h(); }
it("calls wrapper with noop", () => { wrap(() => {}); });`),
      ).toEqual([NO_ORACLE_MESSAGE]);
    });

    it("U-ORACLEHELPER-007 ignores assertions in an uncalled nested helper function", () => {
      expect(
        oracleStrengthMessages(`function h(x: number) { const lazy = () => expect(x).toBe(1); }
it("calls helper with lazy assertion", () => { h(1); });`),
      ).toEqual([NO_ORACLE_MESSAGE]);
    });

    it("U-ORACLEHELPER-008 ignores helper calls in an uncalled callback function", () => {
      expect(
        oracleStrengthMessages(`function h(x: number) { expect(x).toBe(1); }
it("declares but does not call helper", () => { const f = () => h(1); });`),
      ).toEqual([NO_ORACLE_MESSAGE]);
    });

    it("U-ORACLEHELPER-009a stops a helper cycle without an oracle", () => {
      expect(
        oracleStrengthMessages(`function a() { b(); }
function b() { a(); }
it("calls cycle", () => { a(); });`),
      ).toEqual([NO_ORACLE_MESSAGE]);
    });

    it("U-ORACLEHELPER-009b resolves a strong helper through a cycle", () => {
      expect(
        oracleStrengthMessages(`function a() { expect(1).toBe(1); b(); }
function b() { a(); }
it("calls cycle", () => { b(); });`),
      ).toEqual([]);
    });

    it("U-ORACLEHELPER-010a resolves through the maximum helper depth", () => {
      expect(
        oracleStrengthMessages(`function h1() { h2(); }
function h2() { h3(); }
function h3() { expect(1).toBe(1); }
it("calls depth three", () => { h1(); });`),
      ).toEqual([]);
    });

    it("U-ORACLEHELPER-010b does not resolve beyond the maximum helper depth", () => {
      expect(
        oracleStrengthMessages(`function h1() { h2(); }
function h2() { h3(); }
function h3() { h4(); }
function h4() { expect(1).toBe(1); }
it("calls depth four", () => { h1(); });`),
      ).toEqual([NO_ORACLE_MESSAGE]);
    });

    it("U-ORACLEHELPER-011a requires the expectStatus helper body to be strong", () => {
      expect(
        oracleStrengthMessages(`function expectStatus(x: number) { expect(x).toBe(200); }
it("checks status", () => { expectStatus(200); });`),
      ).toEqual([]);
    });

    it("U-ORACLEHELPER-011b reports an empty expectStatus helper", () => {
      expect(
        oracleStrengthMessages(`function expectStatus(x: number) {}
it("checks status", () => { expectStatus(200); });`),
      ).toEqual([NO_ORACLE_MESSAGE]);
    });

    it("U-ORACLEHELPER-011c reports a weak expectStatus helper as weak", () => {
      expect(
        oracleStrengthMessages(`function expectStatus(x: number) { expect(x).toBeTruthy(); }
it("checks status", () => { expectStatus(200); });`),
      ).toEqual([WEAK_ORACLE_MESSAGE]);
    });

    it("U-ORACLEHELPER-012a preserves a direct strong callback oracle", () => {
      expect(oracleStrengthMessages(`it("direct", () => { expect(1).toBe(1); });`)).toEqual([]);
    });

    it("U-ORACLEHELPER-012b preserves a missing direct callback oracle", () => {
      expect(oracleStrengthMessages(`it("direct", () => { const value = 1; });`)).toEqual([
        NO_ORACLE_MESSAGE,
      ]);
    });

    it("U-ORACLEHELPER-012c preserves a weak direct callback oracle", () => {
      expect(oracleStrengthMessages(`it("direct", () => { expect(1).toBeTruthy(); });`)).toEqual([
        WEAK_ORACLE_MESSAGE,
      ]);
    });

    it("U-ORACLEHELPER-012d preserves regex counting inside a nested callback", () => {
      expect(
        oracleStrengthMessages(`it("nested", () => { const later = () => expect(1).toBe(1); });`),
      ).toEqual([]);
    });

    it("U-ORACLEHELPER-012e keeps it.fails outside the oracle-strength target", () => {
      expect(
        oracleStrengthMessages(`it.fails("not targeted", () => { const value = 1; });`),
      ).toEqual([]);
    });

    it("U-ORACLEHELPER-013 resolves nested-scope helpers called in try", () => {
      expect(
        oracleStrengthMessages(`describe("percent tokens", () => {
  function captureError(run: () => unknown, root: object) {
    try { run(); } catch (error) { expect(error).toBeInstanceOf(Error); return error; }
    throw new Error("expected error");
  }
  function expectPercentTokenError(run: () => unknown, root: object) {
    const error = captureError(run, root);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("%");
    expect(root).toEqual({ preserved: true });
  }
  [{ token: "%bad" }].forEach(({ token }) => {
    describe("invalid token", () => {
      it("rejects token", () => {
        const root = { preserved: true };
        try { expectPercentTokenError(() => build(token), root); }
        finally { root.preserved = false; }
      });
    });
  });
});`),
      ).toEqual([]);
    });

    it("U-ORACLEHELPER-014a resolves a const arrow expression helper", () => {
      expect(
        oracleStrengthMessages(`const h = (x: number) => expect(x).toBe(1);
it("calls arrow helper", () => { h(1); });`),
      ).toEqual([]);
    });

    it("U-ORACLEHELPER-014b does not resolve a let arrow helper", () => {
      expect(
        oracleStrengthMessages(`let h = (x: number) => expect(x).toBe(1);
it("calls let helper", () => { h(1); });`),
      ).toEqual([NO_ORACLE_MESSAGE]);
    });

    it("U-ORACLEHELPER-014c does not resolve a helper in a sibling describe", () => {
      expect(
        oracleStrengthMessages(`describe("inner", () => {
  const h = (x: number) => expect(x).toBe(1);
});
it("calls out-of-scope arrow", () => { h(1); });`),
      ).toEqual([NO_ORACLE_MESSAGE]);
    });

    it("U-ORACLEHELPER-015a counts assert calls in helpers", () => {
      expect(
        oracleStrengthMessages(`function h(x: number) { assert.equal(x, 1); }
it("calls assert helper", () => { h(1); });`),
      ).toEqual([]);
    });

    it("U-ORACLEHELPER-015b ignores commented assertions in helpers", () => {
      expect(
        oracleStrengthMessages(`function h(x: number) {
  // expect(x).toBe(1);
}
it("calls commented helper", () => { h(1); });`),
      ).toEqual([NO_ORACLE_MESSAGE]);
    });

    it("U-ORACLEHELPER-016a preserves the callback regex's existing non-violation", () => {
      expect(
        oracleStrengthMessages(`function h() { expect(1).toBe(1); }
it("keeps callback counts", () => {
  const e = expect(1);
  e.toBeTruthy();
  e.not.toBeFalsy();
  h();
});`),
      ).toEqual([]);
    });

    it("U-ORACLEHELPER-016b takes the strongest helper result without summing", () => {
      expect(
        oracleStrengthMessages(`function h1() {
  const e = expect(1);
  e.toBeTruthy();
  e.not.toBeFalsy();
}
function h2() { expect(1).toBe(1); }
it("keeps helper results separate", () => { h1(); h2(); });`),
      ).toEqual([]);
    });

    it("U-ORACLEHELPER-017a rejects a written-to function helper", () => {
      expect(
        oracleStrengthMessages(`function h() { expect(1).toBe(1); }
h = () => {};
it("calls written helper", () => { h(); });`),
      ).toEqual([NO_ORACLE_MESSAGE]);
    });

    it("U-ORACLEHELPER-017b rejects a function helper written inside another function", () => {
      expect(
        oracleStrengthMessages(`function h() { expect(1).toBe(1); }
function reset() { h = () => {}; }
it("calls written helper", () => { h(); });`),
      ).toEqual([NO_ORACLE_MESSAGE]);
    });
  });

  it("real repo guard has no DDD/TDD strictness violations", () => {
    const result = analyzeDddTddRules(loadDddTddInputs());
    expect(result.violations).toEqual([]);
  });
});
