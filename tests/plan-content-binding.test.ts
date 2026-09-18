import { describe, expect, it } from "vitest";
import { bindPlanSourceToAdmission } from "../src/plan-admission/plan-content-binding.ts";
import type { PlanAdmissionRequest } from "../src/plan-admission/policy.ts";
import { parseLegacyPlanSource } from "../src/plan-asset/adapters/legacy-plan-inventory.ts";

const planId = "PLAN-L6-999-content-binding";
const source = `---
plan_id: ${planId}
title: stale route-owned fields
kind: reverse
layer: cross
drive: fullstack
route_signal: reverse
route_mode: reverse
workflow_phase: R3
status: completed
sub_doc: function-spec
github_issue_id: 41
supersedes:
  - PLAN-L6-998-stale
owner: fixture
---

# Body
`;

function admission(overrides: Partial<PlanAdmissionRequest> = {}): PlanAdmissionRequest {
  return {
    routeSignal: "forward",
    routeMode: "forward",
    kind: "design",
    layer: "L6",
    drive: "agent",
    branch: "work/forward-content-binding",
    ...overrides,
  };
}

function boundFrontmatter(request: PlanAdmissionRequest): Record<string, unknown> {
  const bound = bindPlanSourceToAdmission({ source, planId, admission: request });
  const parsed = parseLegacyPlanSource(bound.source);
  if (!parsed) throw new Error("fixture binding did not produce a PLAN");
  return parsed.frontmatter;
}

describe("bindPlanSourceToAdmission", () => {
  it("U-PA-BIND-001: current admissionにない旧route-owned optional keysをすべて除去する", () => {
    const frontmatter = boundFrontmatter(admission());

    expect(frontmatter).not.toHaveProperty("workflow_phase");
    expect(frontmatter).not.toHaveProperty("status");
    expect(frontmatter).not.toHaveProperty("sub_doc");
    expect(frontmatter).not.toHaveProperty("github_issue_id");
    expect(frontmatter).not.toHaveProperty("supersedes");
    expect(frontmatter.owner).toBe("fixture");
  });

  it("U-PA-BIND-002: route-owned optional keysはcurrent admissionの値だけを再追加する", () => {
    const frontmatter = boundFrontmatter(
      admission({
        workflowPhase: "R1",
        status: "draft",
        subDoc: "function-spec",
        issue: {
          provider: "github",
          issueId: 102,
          episodeId: "E4-102",
          projectionDigest: `sha256:${"a".repeat(64)}`,
        },
      }),
    );

    expect(frontmatter).toMatchObject({
      workflow_phase: "R1",
      status: "draft",
      sub_doc: "function-spec",
      github_issue_id: 102,
    });
  });

  it("U-PA-BIND-003: supersedesは旧値を継承せずcurrent admissionの値へ差し替える", () => {
    const frontmatter = boundFrontmatter(admission({ supersedes: ["PLAN-L6-997-current"] }));

    expect(frontmatter.supersedes).toEqual(["PLAN-L6-997-current"]);
  });
});
