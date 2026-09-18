// PLAN-L7-451 W4: typed PR trace contract の unit oracle。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderPrTraceBlock, validatePrTraceBody } from "../src/github/pr-trace.ts";
import { headSnapshotRoot } from "./support/workspace-roots.ts";

const VALID_FIELDS = {
  plan_id: "PLAN-L7-451-github-ops-phase1-visibility-and-policy",
  route_mode: "add-feature",
  subject_head: "abc123def456abc123def456abc123def456abcd",
  base_sha: "5eff8549",
  issue_number: "97",
} as const;

describe("github pr trace contract (PLAN-L7-451 W4)", () => {
  it("U-L7-451-W4-001: render が有効な trace block を生成し validate が受理する", () => {
    const block = renderPrTraceBlock(VALID_FIELDS);
    expect(block).toContain("<!-- ut-tdd:trace/v1");
    expect(block).toContain(`plan_id: ${VALID_FIELDS.plan_id}`);
    const body = `## 概要\n\nやったこと\n\n${block}\n`;
    const result = validatePrTraceBody(body);
    expect(result.ok).toBe(true);
    expect(result.fields.plan_id).toBe(VALID_FIELDS.plan_id);
    expect(result.fields.issue_number).toBe("97");
  });

  it("U-L7-451-W4-002: block 欠落は fail-close する", () => {
    const result = validatePrTraceBody("## 概要\n\ntrace block なし\n");
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toContain("trace-block-missing");
  });

  it("U-L7-451-W4-003: 必須キー欠落・不正値・未知キーを fail-close する", () => {
    const broken = [
      "<!-- ut-tdd:trace/v1",
      "plan_id: not-a-plan",
      "route_mode: add-feature",
      "subject_head: ZZZZ",
      "custom_field: x",
      "-->",
    ].join("\n");
    const result = validatePrTraceBody(broken);
    expect(result.ok).toBe(false);
    const codes = result.findings.map((f) => f.code);
    expect(codes).toContain("invalid-plan-id");
    expect(codes).toContain("invalid-subject-head");
    expect(codes).toContain("trace-key-unknown");
    expect(codes).toContain("missing-base-sha");
  });

  it("U-L7-451-W4-004: render は壊れた block を作らない (必須欠落で throw)", () => {
    expect(() => renderPrTraceBlock({ ...VALID_FIELDS, plan_id: "" } as never)).toThrow(
      /missing-plan-id/,
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
      "<!-- ut-tdd:trace/v1",
      `plan_id: ${VALID_FIELDS.plan_id}`,
      `plan_id: ${VALID_FIELDS.plan_id}`,
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
    const root = headSnapshotRoot();
    const templates = [
      readFileSync(join(root, ".github", "PULL_REQUEST_TEMPLATE.md"), "utf8"),
      readFileSync(
        join(root, "docs", "templates", "github", "common", "PULL_REQUEST_TEMPLATE.md"),
        "utf8",
      ),
    ];
    for (const template of templates) {
      expect(template).toContain("Closes #<issue-number>");
      expect(template).not.toMatch(/通常 Forward.*Issue.*(?:不要|省略)/u);
    }
  });
});
