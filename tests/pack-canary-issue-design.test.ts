import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { removeTestTree } from "./support/temp-tree.ts";

interface IssueDesignModule {
  createConsumerIssueDesignDocument(consumerRoot: string, source: string): string;
}

const issueDesignModuleSpecifier = "../scripts/pack-canary-acceptance.mjs";
const issueDesignModule = await import(issueDesignModuleSpecifier);
const { createConsumerIssueDesignDocument } = issueDesignModule as IssueDesignModule;
const shippedTemplate = readFileSync(
  join(process.cwd(), "docs", "templates", "design", "L6-function-spec-template.md"),
  "utf8",
);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeTestTree(root);
});

describe("Pack canary Issue-linked design authoring", () => {
  it("U-ST-PACKCANARY-009: derives a positive Issue document from the shipped design template", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-canary-issue-design-"));
    roots.push(root);
    const destination = createConsumerIssueDesignDocument(root, shippedTemplate);
    const document = readFileSync(join(root, ...destination.split("/")), "utf8");
    const match = /^---\n([\s\S]*?)\n---\n/.exec(document);
    expect(match).not.toBeNull();
    const frontmatter = parseYaml(match?.[1] ?? "") as Record<string, unknown>;
    expect(frontmatter.issue).toBe(418);
    expect(Number.isSafeInteger(frontmatter.issue)).toBe(true);
    expect(Object.hasOwn(frontmatter, "plan")).toBe(false);
    expect(document).not.toContain("<Issue 番号>");
    expect(document).not.toBe(shippedTemplate);
  });

  it("U-ST-PACKCANARY-009: fails closed for ambiguous Issue values, duplicate keys, and retired PLAN fields", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-canary-issue-design-negative-"));
    roots.push(root);
    const template = shippedTemplate;
    const withFrontmatter = (replacement: string) =>
      template.replace(/^issue:\s*<Issue 番号>\s*$/m, replacement);
    const invalidTemplates = [
      ["missing issue", template.replace(/^issue:.*(?:\r?\n|$)/m, "")],
      ["empty issue", withFrontmatter("issue:")],
      ["issue without YAML key separation", withFrontmatter("issue:418")],
      ["unknown placeholder", withFrontmatter("issue: <Issue ID>")],
      ["zero", withFrontmatter("issue: 0")],
      ["negative", withFrontmatter("issue: -1")],
      ["fractional", withFrontmatter("issue: 1.5")],
      ["quoted string", withFrontmatter('issue: "418"')],
      ["quoted issue key", withFrontmatter('"issue": 418')],
      ["commented value", withFrontmatter("issue: 418 # can be reinterpreted")],
      ["indented issue key", withFrontmatter("  issue: 418")],
      ["flow mapping", withFrontmatter("{ issue: 418, plan: forbidden }")],
      ["duplicate issue", withFrontmatter("issue: 418\nissue: 419")],
      [
        "duplicate unrelated key",
        withFrontmatter("issue: 418\nlayer: L6").replace("layer: L6", "layer: L6\nlayer: L7"),
      ],
      ["plan field", withFrontmatter("issue: 418\nplan: docs/plans/PLAN-418.md")],
      ["empty plan field", withFrontmatter("issue: 418\nplan:")],
      ["plan without YAML key separation", withFrontmatter("issue: 418\nplan:forbidden")],
      ["quoted plan key", withFrontmatter('issue: 418\n"plan": forbidden')],
    ] as const;
    for (const [label, invalidTemplate] of invalidTemplates) {
      expect(
        () => createConsumerIssueDesignDocument(join(root, label), invalidTemplate),
        label,
      ).toThrow();
    }
  });
});
