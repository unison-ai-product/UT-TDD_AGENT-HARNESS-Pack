import { describe, expect, it } from "vitest";
import {
  analyzeForwardFreezeContracts,
  forwardFreezeContractMessages,
  loadPairDocs,
  type PairDoc,
} from "../src/vmodel/lint.ts";

const doc = (
  path: string,
  layer: string | null,
  pa: string | null,
  status: string | null = null,
  nextPairFreeze: string | null = null,
  content = "",
): PairDoc => ({
  path,
  layer,
  pairArtifact: pa,
  status,
  nextPairFreeze,
  content,
});

const l2 = (name: string, content = "G2 freeze PO prototype agreement") =>
  doc(
    `docs/design/harness/L2-screen/${name}.md`,
    "L2",
    "docs/test-design/harness/L10-ux-validation-test-design.md",
    "confirmed",
    "L10",
    content,
  );

const l5 = (name: string) =>
  doc(
    `docs/design/harness/L5-detailed-design/${name}.md`,
    "L5",
    "docs/test-design/harness/L8-integration-test-design.md",
    "confirmed",
    "L8",
    "",
  );

const l8Content = [
  "---",
  "layer: L5",
  "executed_at_layer: L8",
  "status: confirmed",
  "pair_artifact: docs/design/harness/L5-detailed-design/",
  "---",
  "if-detail.md internal-processing.md module-decomposition.md physical-data.md ui-detail.md",
  "| IT-ID | Given | When | Then | Fixture | Assertions | Negative |",
].join("\n");

describe("forward freeze contracts (U-FREEZE-CONTRACT)", () => {
  it("U-FREEZE-CONTRACT-001: L2 prototype agreement and L5 verification design pass together", () => {
    const result = analyzeForwardFreezeContracts([
      l2("business-flow"),
      l2("screen-detail"),
      l2("screen-flow"),
      l2("screen-list"),
      l2("ui-element"),
      l2("wireframe"),
      l5("if-detail"),
      l5("internal-processing"),
      l5("module-decomposition"),
      l5("physical-data"),
      l5("ui-detail"),
      doc(
        "docs/test-design/harness/L8-integration-test-design.md",
        "L5",
        "docs/design/harness/L5-detailed-design/",
        "confirmed",
        "L5",
        l8Content,
      ),
    ]);
    expect(result.ok).toBe(true);
    expect(forwardFreezeContractMessages(result)[0]).toContain("OK");
  });

  it("U-FREEZE-CONTRACT-002: L2 confirmed without prototype evidence is not enough", () => {
    const result = analyzeForwardFreezeContracts([
      l2("business-flow", "plain confirmed doc"),
      l2("screen-detail"),
      l2("screen-flow"),
      l2("screen-list"),
      l2("ui-element"),
      l2("wireframe"),
      l5("if-detail"),
      l5("internal-processing"),
      l5("module-decomposition"),
      l5("physical-data"),
      l5("ui-detail"),
      doc(
        "docs/test-design/harness/L8-integration-test-design.md",
        "L5",
        "docs/design/harness/L5-detailed-design/",
        "confirmed",
        "L5",
        l8Content,
      ),
    ]);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.reason)).toContain("l2-prototype-evidence-missing");
  });

  it("U-FREEZE-CONTRACT-003: L8 design must cover every L5 detail doc with GWT cases", () => {
    const result = analyzeForwardFreezeContracts([
      l2("business-flow"),
      l2("screen-detail"),
      l2("screen-flow"),
      l2("screen-list"),
      l2("ui-element"),
      l2("wireframe"),
      l5("if-detail"),
      l5("internal-processing"),
      l5("module-decomposition"),
      l5("physical-data"),
      l5("ui-detail"),
      doc(
        "docs/test-design/harness/L8-integration-test-design.md",
        "L5",
        "docs/design/harness/L5-detailed-design/",
        "confirmed",
        "L5",
        l8Content.replace(" ui-detail.md", "").replace("Given | When | Then", "Scenario"),
      ),
    ]);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.reason)).toContain("l8-coverage-missing");
    expect(result.violations.map((v) => v.reason)).toContain("l8-gwt-missing");
  });

  it("U-FREEZE-CONTRACT-004: real repo satisfies ZIP107 L2/L5 freeze contracts", () => {
    const result = analyzeForwardFreezeContracts(loadPairDocs());
    if (!result.ok) {
      throw new Error(JSON.stringify(result.violations, null, 2));
    }
    expect(result.ok).toBe(true);
  });
});
