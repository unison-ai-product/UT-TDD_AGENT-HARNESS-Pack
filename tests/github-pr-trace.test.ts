// PLAN-L7-451 W4: typed PR trace contract の unit oracle。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderPrTraceBlock, validatePrTraceBody } from "../src/github/pr-trace.ts";
import { headSnapshotRoot } from "./support/workspace-roots.ts";

const VALID_FIELDS = {
  route_mode: "add-feature",
  subject_head: "abc123def456abc123def456abc123def456abcd",
  base_sha: "5eff8549",
  issue_number: "97",
} as const;

function headPrTemplates(): [string, string] {
  const root = headSnapshotRoot();
  return [
    readFileSync(join(root, ".github", "PULL_REQUEST_TEMPLATE.md"), "utf8"),
    readFileSync(
      join(root, "docs", "templates", "github", "common", "PULL_REQUEST_TEMPLATE.md"),
      "utf8",
    ),
  ];
}

describe("github pr trace contract (PLAN-L7-451 W4)", () => {
  it("U-PLANRET-006: trace v2 はIssueだけに束縛し、PLAN fieldを拒否する", () => {
    const fields = {
      route_mode: "add-feature",
      subject_head: "abc123def456abc123def456abc123def456abcd",
      base_sha: "5eff8549",
      issue_number: "97",
    };
    const block = renderPrTraceBlock(fields as Parameters<typeof renderPrTraceBlock>[0]);
    expect(block).toContain("<!-- ut-tdd:trace/v2");
    expect(block).not.toContain("plan_id:");
    expect(validatePrTraceBody(`## 概要\n\n${block}\n`).ok).toBe(true);

    const withPlan = `${block.replace("-->", "plan_id: PLAN-L7-451-retired\n-->")}`;
    expect(validatePrTraceBody(`## 概要\n\n${withPlan}\n`).findings).toContainEqual(
      expect.objectContaining({ code: "trace-key-unknown" }),
    );
    const missingIssue = block.replace("issue_number: 97\n", "");
    expect(validatePrTraceBody(`## 概要\n\n${missingIssue}\n`).findings).toContainEqual(
      expect.objectContaining({ code: "missing-issue-number" }),
    );

    const [template] = headPrTemplates();
    expect(template).toContain("Closes #<issue-number>");
    expect(template).toContain("ut-tdd:trace/v2");
    expect(template).not.toMatch(/PLAN|plan_id|plan_revision|trace\/v1/iu);
  });

  it("U-L7-451-W4-001: render が有効な trace block を生成し validate が受理する", () => {
    const block = renderPrTraceBlock(VALID_FIELDS);
    expect(block).toContain("<!-- ut-tdd:trace/v2");
    expect(block).toContain("issue_number: 97");
    const body = `## 概要\n\nやったこと\n\n${block}\n`;
    const result = validatePrTraceBody(body);
    expect(result.ok).toBe(true);
    expect(result.fields.issue_number).toBe("97");
  });

  it("U-L7-451-W4-002: block 欠落は fail-close する", () => {
    const result = validatePrTraceBody("## 概要\n\ntrace block なし\n");
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toContain("trace-block-missing");
  });

  it("U-L7-451-W4-003: 必須キー欠落・不正値・未知キーを fail-close する", () => {
    const broken = [
      "<!-- ut-tdd:trace/v2",
      "plan_id: PLAN-X-1",
      "route_mode: add-feature",
      "subject_head: ZZZZ",
      "custom_field: x",
      "-->",
    ].join("\n");
    const result = validatePrTraceBody(broken);
    expect(result.ok).toBe(false);
    const codes = result.findings.map((f) => f.code);
    expect(codes).not.toContain("invalid-plan-id");
    expect(codes).toContain("invalid-subject-head");
    expect(codes).toContain("trace-key-unknown");
    expect(codes).toContain("missing-base-sha");
  });

  it("U-L7-451-W4-004: render は壊れた block を作らない (必須欠落で throw)", () => {
    expect(() => renderPrTraceBlock({ ...VALID_FIELDS, route_mode: "" })).toThrow(
      /missing-route-mode/,
    );
    expect(() => renderPrTraceBlock({ ...VALID_FIELDS, subject_head: "not-hex" })).toThrow(
      /invalid-subject-head/,
    );
    expect(() => renderPrTraceBlock({ ...VALID_FIELDS, issue_number: undefined } as never)).toThrow(
      /missing-issue-number/,
    );
  });

  it("U-L7-451-W4-005: block 重複とキー重複を fail-close する", () => {
    const block = renderPrTraceBlock(VALID_FIELDS);
    const duplicated = validatePrTraceBody(`${block}\n\n${block}`);
    expect(duplicated.ok).toBe(false);
    expect(duplicated.findings.map((f) => f.code)).toContain("trace-block-duplicated");
    const dupKey = [
      "<!-- ut-tdd:trace/v2",
      "route_mode: add-feature",
      "route_mode: add-feature",
      `subject_head: ${VALID_FIELDS.subject_head}`,
      `base_sha: ${VALID_FIELDS.base_sha}`,
      "-->",
    ].join("\n");
    const result = validatePrTraceBody(dupKey);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toContain("trace-key-duplicated");
  });

  it("U-L7-451-W4-006: source/common PR templates require an Issue for every Forward PR", () => {
    const templates = headPrTemplates();
    for (const template of templates) {
      expect(template).toContain("Closes #<issue-number>");
      expect(template).not.toMatch(/通常 Forward.*Issue.*(?:不要|省略)/u);
    }
  });
});
