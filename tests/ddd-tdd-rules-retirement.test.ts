import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeDddTddRules, loadDddTddInputs } from "../src/lint/ddd-tdd-rules.ts";
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
      "- id: red-first-evidence",
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
      "| U-DDDTDD-002 | invariant trace | DDD-INV-002 remains discoverable when its substantive oracle row exists only " +
        "in the split L7 test design. |",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(join(harness, "README.md"), "NON-L7-SENTINEL\n", "utf8");
  return root;
}

function createRedFirstRetirementFixture(includePlan: boolean): { root: string; planPath: string } {
  const root = createDddTddSplitL7Fixture();
  const policyPath = join(root, "docs", "governance", "ddd-tdd-rules.md");
  writeFileSync(
    policyPath,
    readFileSync(policyPath, "utf8").replace("- id: red-first-evidence\n", ""),
    "utf8",
  );
  for (const [path, text] of [
    [
      "docs/process/forward/L00-L06-design-phase.md",
      "DDD-TDD-WORKFLOW docs/governance/ddd-tdd-rules.md",
    ],
    [
      "docs/process/modes/add-feature.md",
      "DDD-TDD-WORKFLOW docs/governance/ddd-tdd-rules.md add-design add-impl",
    ],
    ["docs/process/modes/README.md", "DDD-TDD-WORKFLOW docs/governance/ddd-tdd-rules.md"],
    [
      "docs/test-design/harness/L8-integration-test-design.md",
      [
        "| IT-ID | Given | When | Then |",
        "|---|---|---|---|",
        "| IT-DDD-01 | a valid fixture | analyze rules | unrelated rule results stay stable |",
      ].join("\n"),
    ],
    [
      "tests/strong.test.ts",
      'import { it, expect } from "vitest";\nit("checks the fixture", () => { expect(1).toBe(1); });',
    ],
  ]) {
    const pathParts = path.split("/");
    pathParts.pop();
    mkdirSync(join(root, ...pathParts), { recursive: true });
    writeFileSync(join(root, path), text, "utf8");
  }

  const planPath = join(root, "docs", "plans", "PLAN-L7-99-retirement-fixture.md");
  if (includePlan) {
    mkdirSync(join(root, "docs", "plans"), { recursive: true });
    writeFileSync(
      planPath,
      [
        "---",
        "status: confirmed",
        "tdd_red_required: true",
        "---",
        "A target PLAN with no red_at or green_at evidence.",
        "",
      ].join("\n"),
      "utf8",
    );
  }
  return { root, planPath };
}

describe("U-PLANRET-013: red-first evidence retirement", () => {
  let withPlanFixture: ReturnType<typeof createRedFirstRetirementFixture>;
  let withoutPlanFixture: ReturnType<typeof createRedFirstRetirementFixture>;

  beforeAll(() => {
    withPlanFixture = createRedFirstRetirementFixture(true);
    withoutPlanFixture = createRedFirstRetirementFixture(false);
  });

  afterAll(() => {
    removeTestTree(withPlanFixture.root);
    removeTestTree(withoutPlanFixture.root);
  });

  it("precondition: aligned post-retirement policy and invariant fixture has only the target PLAN delta", () => {
    const withPlan = loadDddTddInputs(withPlanFixture.root);
    const withoutPlan = loadDddTddInputs(withoutPlanFixture.root);

    expect(existsSync(withPlanFixture.planPath)).toBe(true);
    expect(existsSync(withoutPlanFixture.planPath)).toBe(false);
    expect(withPlan.policy?.ruleIds).toEqual([
      "domain-boundary",
      "invariant-test-trace",
      "test-oracle-strength",
      "integration-gwt",
      "unit-oracle-substance",
    ]);
    expect(withPlan.policy?.text).not.toContain("red-first-evidence");
    expect(withPlan.policy?.text).not.toContain("DDD-INV-003");
    expect(withPlan.policy?.text).toContain("DDD-INV-002 oracle: U-DDDTDD-002");
    expect(withPlan.l7Text).not.toContain("U-DDDTDD-003");
    expect(withPlan.l7Text).toContain("U-DDDTDD-002");
    const planText = readFileSync(withPlanFixture.planPath, "utf8");
    expect(planText).toMatch(/^status: confirmed$/m);
    expect(planText).toMatch(/^tdd_red_required: true$/m);
    expect(planText).not.toMatch(/^red_at:/m);
    expect(planText).not.toMatch(/^green_at:/m);
    expect(withPlan.workflowDocs.every((doc) => doc.exists)).toBe(true);
    expect(withPlan.workflowDocs.map((doc) => doc.text)).toEqual(
      withoutPlan.workflowDocs.map((doc) => doc.text),
    );
    expect(withPlan.docs).toEqual(withoutPlan.docs);
    expect(withPlan.policy).toEqual(withoutPlan.policy);
    expect(withPlan.l7Text).toBe(withoutPlan.l7Text);
    expect(withPlan.l8Text).toBe(withoutPlan.l8Text);
  });

  it("other rule outcomes are stable; DDD-INV-002 remains traced while DDD-INV-003 is retired", () => {
    const withPlan = analyzeDddTddRules(loadDddTddInputs(withPlanFixture.root));
    const withoutPlan = analyzeDddTddRules(loadDddTddInputs(withoutPlanFixture.root));
    const unrelated = (violation: (typeof withPlan.violations)[number]) =>
      violation.rule !== "red-first-evidence" &&
      !(
        violation.rule === "ddd-tdd-policy-missing-rule" &&
        violation.message.includes("red-first-evidence")
      );

    expect(withPlan.violations.filter(unrelated)).toEqual(withoutPlan.violations.filter(unrelated));
    expect(
      withPlan.violations.filter(
        (violation) =>
          ((violation.rule === "ddd-tdd-policy-missing-rule" ||
            violation.rule === "ddd-tdd-policy-unknown-rule") &&
            !violation.message.includes("red-first-evidence")) ||
          violation.rule === "invariant-test-trace",
      ),
    ).toEqual([]);
  });

  it("U-PLANRET-013: PLAN evidence no longer emits red-first-evidence", () => {
    const withPlan = analyzeDddTddRules(loadDddTddInputs(withPlanFixture.root));
    expect(
      withPlan.violations.filter((violation) => violation.rule === "red-first-evidence"),
    ).toEqual([]);
  });

  it("U-PLANRET-013: retired rule, policy, invariant, and oracle leave no drift", () => {
    const withPlan = analyzeDddTddRules(loadDddTddInputs(withPlanFixture.root));
    expect(
      withPlan.violations.filter(
        (violation) =>
          violation.rule === "ddd-tdd-policy-missing-rule" ||
          violation.rule === "ddd-tdd-policy-unknown-rule" ||
          violation.rule === "invariant-test-trace",
      ),
    ).toEqual([]);
  });
});
