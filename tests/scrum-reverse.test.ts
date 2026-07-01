import { describe, expect, it } from "vitest";
import {
  analyzeScrumReverse,
  loadSrPlans,
  type ParsedSrPlan,
  parseLinks,
  parseSrPlan,
  scrumReverseMessages,
} from "../src/lint/scrum-reverse";

function plan(over: Partial<ParsedSrPlan>): ParsedSrPlan {
  return {
    file: `${over.plan_id ?? "PLAN-X"}.md`,
    plan_id: over.plan_id ?? "PLAN-X",
    kind: "poc",
    status: "confirmed",
    decision_outcome: "confirmed",
    promotion_strategy: "reuse-with-hardening",
    links: [],
    ...over,
  };
}

describe("U-SCRUMREV-001 parseLinks / parseSrPlan", () => {
  it("requires + references を 1 集合へ / frontmatter 抽出 (inline コメント除去)", () => {
    const content = `---
plan_id: PLAN-DISCOVERY-09-x
kind: poc
status: confirmed
decision_outcome: confirmed  # PO 授権
promotion_strategy: reuse-with-hardening
dependencies:
  requires:
    - docs/plans/PLAN-A.md
  references:
    - docs/plans/PLAN-B.md
---`;
    expect(parseLinks(content)).toEqual(["docs/plans/PLAN-A.md", "docs/plans/PLAN-B.md"]);
    const p = parseSrPlan("PLAN-DISCOVERY-09-x.md", content);
    expect(p.kind).toBe("poc");
    expect(p.decision_outcome).toBe("confirmed");
    expect(p.promotion_strategy).toBe("reuse-with-hardening");
  });
});

describe("U-SCRUMREV-002 pocOrphans", () => {
  it("confirmed poc (reuse-with-hardening) を指す reverse が無い → orphan + ok=false", () => {
    const r = analyzeScrumReverse([plan({ plan_id: "PLAN-DISCOVERY-09-x" })]);
    expect(r.pocOrphans).toHaveLength(1);
    expect(r.ok).toBe(false);
  });

  it("confirmed poc を requires/references する reverse が有る → 孤児なし", () => {
    const r = analyzeScrumReverse([
      plan({ plan_id: "PLAN-DISCOVERY-09-x" }),
      plan({
        plan_id: "PLAN-REVERSE-09-x",
        kind: "reverse",
        decision_outcome: null,
        promotion_strategy: null,
        links: ["docs/plans/PLAN-DISCOVERY-09-x.md"],
      }),
    ]);
    expect(r.pocOrphans).toHaveLength(0);
    expect(r.ok).toBe(true);
  });

  it("promotion_strategy=redesign の confirmed poc は Reverse 不要 → 孤児にしない", () => {
    const r = analyzeScrumReverse([
      plan({ plan_id: "PLAN-DISCOVERY-02-x", promotion_strategy: "redesign" }),
    ]);
    expect(r.pocOrphans).toHaveLength(0);
    expect(r.ok).toBe(true);
  });

  it("confirmed でない poc (pivot) は orphan 対象外", () => {
    const r = analyzeScrumReverse([
      plan({ plan_id: "PLAN-DISCOVERY-09-x", decision_outcome: "pivot" }),
    ]);
    expect(r.pocOrphans).toHaveLength(0);
  });
});

describe("U-SCRUMREV-003 badReverseRefs", () => {
  it("reverse が confirmed でない poc (pivot) を参照 → bad + ok=false", () => {
    const r = analyzeScrumReverse([
      plan({ plan_id: "PLAN-DISCOVERY-09-x", decision_outcome: "pivot" }),
      plan({
        plan_id: "PLAN-REVERSE-09-x",
        kind: "reverse",
        decision_outcome: null,
        promotion_strategy: null,
        links: ["docs/plans/PLAN-DISCOVERY-09-x.md"],
      }),
    ]);
    expect(r.badReverseRefs).toHaveLength(1);
    expect(r.badReverseRefs[0].outcome).toBe("pivot");
    expect(r.ok).toBe(false);
  });

  it("archived は対象外", () => {
    const r = analyzeScrumReverse([plan({ plan_id: "PLAN-DISCOVERY-09-x", status: "archived" })]);
    expect(r.ok).toBe(true);
  });
});

describe("U-SCRUMREV-004 messages", () => {
  it("孤児なし → OK / 孤児あり → warn 文言", () => {
    expect(scrumReverseMessages(analyzeScrumReverse([])).some((m) => m.includes("OK"))).toBe(true);
    expect(
      scrumReverseMessages(analyzeScrumReverse([plan({ plan_id: "PLAN-DISCOVERY-09-x" })])).some(
        (m) => m.includes("Reverse 合流が無い"),
      ),
    ).toBe(true);
  });
});

describe("U-SCRUMREV-005 実 repo の scrum-reverse 整合 (回帰ガード)", () => {
  it("confirmed poc は全て Reverse 合流済 (redesign 除く) / reverse 参照は confirmed poc のみ", () => {
    const r = analyzeScrumReverse(loadSrPlans());
    expect({ pocOrphans: r.pocOrphans, badReverseRefs: r.badReverseRefs }).toEqual({
      pocOrphans: [],
      badReverseRefs: [],
    });
  });
});
