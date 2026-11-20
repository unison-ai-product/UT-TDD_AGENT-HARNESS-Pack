import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeL6FrCoverage } from "../src/lint/l6-fr-coverage.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const basePath = "docs/design/harness/L6-function-design/";
const substance = [
  "| function | type body | implementation_state |",
  "|---|---|---|",
  "| `splitFn` | `SplitInput { value: string } -> SplitResult` | pseudocode: validate input and return result |",
].join("\n");
const dbc = [
  "| Function | Signature | pre | post | invariant | oracle |",
  "|---|---|---|---|---|---|",
  "| `splitFn` | `SplitInput -> SplitResult` | valid input | result | stable | U-FR-L1-01 |",
].join("\n");

function checkFixture(name: string, role: boolean, table: boolean) {
  const root = mkdtempSync(join(tmpdir(), "ut-doc-split-fr-"));
  const path = `${basePath}${name}.md`;
  try {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(
      join(root, path),
      [role ? "---\nartifact_role: fr_contract\n---" : "", substance, table ? dbc : ""].join("\n"),
    );
    return analyzeL6FrCoverage({
      frIds: ["FR-L1-01"],
      coverageText: [
        "| FR | L6 spec | unit contract | unit oracle |",
        "|---|---|---|---|",
        `| FR-L1-01 | ${path} | \`splitFn\` validates input. | U-FR-L1-01 |`,
      ].join("\n"),
      repoRoot: root,
    });
  } finally {
    removeTestTree(root);
  }
}

describe("FR contract document split candidates", () => {
  it("U-DOCSPLIT-025a: accepts the original function-spec DbC table", () => {
    expect(checkFixture("function-spec", false, true)).toMatchObject({
      ok: true,
      weakContracts: [],
      missingSubstance: [],
    });
  });

  it("U-DOCSPLIT-025b: accepts a split FR contract with a DbC table", () => {
    expect(checkFixture("fr-split", true, true)).toMatchObject({
      ok: true,
      weakContracts: [],
      missingSubstance: [],
    });
  });

  it.fails("U-DOCSPLIT-025c: rejects a split FR contract without its DbC table", () => {
    const result = checkFixture("fr-split", true, false);
    expect(result.weakContracts).toContainEqual({
      fr_id: "FR-L1-01",
      contract: "splitFn",
      reason: "function_spec_missing_structured_dbc_table",
    });
    expect(result.ok).toBe(false);
  });

  it.fails("U-DOCSPLIT-025d: rejects an FR contract with no role marker or DbC table", () => {
    expect(checkFixture("fr-split", false, false).ok).toBe(false);
  });
});
