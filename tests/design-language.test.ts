import { describe, expect, it } from "vitest";
import {
  analyzeDesignLanguage,
  type DesignLanguageDoc,
  designLanguageMessages,
} from "../src/lint/design-language";

function doc(text: string): DesignLanguageDoc {
  return { path: "docs/design/harness/example.md", text };
}

describe("design-language lint", () => {
  it("fails English prose in design documents", () => {
    const result = analyzeDesignLanguage([
      doc("# English Design Heading\n\nThis document explains the product workflow boundary."),
    ]);

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.reason)).toEqual(["english-heading", "english-prose"]);
    expect(designLanguageMessages(result)[0]).toContain("design-language - violation");
  });

  it("allows Japanese prose with technical terms, code fences, and frontmatter", () => {
    const result = analyzeDesignLanguage([
      doc(
        [
          "---",
          "layer: L6",
          "status: confirmed",
          "---",
          "# L6 設計契約",
          "",
          "この doc は CLI / API / PLAN ID を扱う設計契約である。",
          "",
          "```ts",
          "type EnglishIdentifier = { workflowBoundary: string };",
          "```",
        ].join("\n"),
      ),
    ]);

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });
});
