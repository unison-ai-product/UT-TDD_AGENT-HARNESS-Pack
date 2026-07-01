import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeBackfill,
  BACKFILL_RESULT_KEYS,
  backfillMessages,
  KIND_BACKFILL,
  loadBackfillDocs,
  type ParsedPlan,
  parseConditionalBackfillAuditPlanIds,
  parseGlossaryTerms,
  parsePlan,
  parseRequires,
} from "../src/lint/backfill-pairing";

function plan(over: Partial<ParsedPlan> = {}): ParsedPlan {
  return {
    file: "f.md",
    plan_id: "PLAN-L7-99-x",
    kind: "add-impl",
    status: "confirmed",
    updated: "2026-06-21",
    backpropDecision: "",
    backpropDecisionReason: "",
    requires: [],
    glossaryTerms: [],
    ...over,
  };
}

describe("U-BACKFILL-001 parseRequires / parseGlossaryTerms", () => {
  it("requires の YAML list path を抽出 / 無し・[] → []", () => {
    const fm = `---
plan_id: PLAN-REVERSE-06-x
dependencies:
  parent: null
  requires:
    - docs/plans/PLAN-L7-06-handover-enforcement.md
    - docs/plans/PLAN-L7-08-agent-slots.md
  blocks: []
---
`;
    expect(parseRequires(fm)).toEqual([
      "docs/plans/PLAN-L7-06-handover-enforcement.md",
      "docs/plans/PLAN-L7-08-agent-slots.md",
    ]);
    expect(parseRequires("requires: []\n")).toEqual([]);
    expect(parseRequires("no requires here")).toEqual([]);
  });

  it("§6 用語更新 の太字 term を抽出", () => {
    const body = `## §6 用語更新

- **agent-slot**: 定義...
- **直列化 3 条件**: file_conflict / ...
- 通常行 (太字なし) は無視

## §7 次
- **無関係**: 別 section`;
    expect(parseGlossaryTerms(body)).toEqual(["agent-slot", "直列化 3 条件"]);
  });
});

describe("U-BACKFILL-002 parsePlan", () => {
  it("frontmatter + requires + glossary を構造化", () => {
    const content = `---
plan_id: PLAN-L7-08-agent-slots
kind: add-impl
status: confirmed
dependencies:
  requires:
    - docs/plans/PLAN-L6-07-agent-slots.md
---
## §6 用語更新
- **peak_parallel**: 同時実行ピーク`;
    const p = parsePlan("PLAN-L7-08-agent-slots.md", content);
    expect(p.plan_id).toBe("PLAN-L7-08-agent-slots");
    expect(p.kind).toBe("add-impl");
    expect(p.requires).toEqual(["docs/plans/PLAN-L6-07-agent-slots.md"]);
    expect(p.glossaryTerms).toEqual(["peak_parallel"]);
  });
});

describe("U-BACKFILL-003 KIND_BACKFILL matrix", () => {
  it("add-impl=required / refactor=conditional / impl・design・reverse・recovery=none", () => {
    expect(KIND_BACKFILL["add-impl"]).toBe("required");
    expect(KIND_BACKFILL.refactor).toBe("conditional");
    expect(KIND_BACKFILL.troubleshoot).toBe("conditional");
    expect(KIND_BACKFILL.impl).toBe("none");
    expect(KIND_BACKFILL.design).toBe("none");
    expect(KIND_BACKFILL.reverse).toBe("none");
    expect(KIND_BACKFILL.recovery).toBe("none");
  });
});

describe("U-BACKFILL-004 analyzeBackfill", () => {
  const glossary = "用語集: agent-slot は ... peak_parallel は ...";

  it("required (add-impl) に Reverse requires が有る → 孤児なし", () => {
    const plans = [
      plan({ plan_id: "PLAN-L7-08-agent-slots", kind: "add-impl" }),
      plan({
        plan_id: "PLAN-REVERSE-06-x",
        kind: "reverse",
        requires: ["docs/plans/PLAN-L7-08-agent-slots.md"],
      }),
    ];
    const r = analyzeBackfill(plans, glossary);
    expect(r.reverseOrphans).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("required (add-impl) に Reverse が無い → reverseOrphan + ok=false", () => {
    const r = analyzeBackfill([plan({ plan_id: "PLAN-L7-50-orphan", kind: "add-impl" })], glossary);
    expect(r.reverseOrphans).toEqual([{ plan_id: "PLAN-L7-50-orphan", kind: "add-impl" }]);
    expect(r.ok).toBe(false);
  });

  it("conditional (refactor) に Reverse 無し → conditionalPending (warn のみ、ok を落とさない)", () => {
    const r = analyzeBackfill([plan({ plan_id: "PLAN-L7-05-x", kind: "refactor" })], glossary);
    expect(r.conditionalPending).toHaveLength(1);
    expect(r.reverseOrphans).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("§6 用語が glossary 未 merge → glossaryGap + ok=false", () => {
    const r = analyzeBackfill(
      [
        plan({
          plan_id: "PLAN-L6-07-agent-slots",
          kind: "add-design",
          glossaryTerms: ["未登録語"],
        }),
      ],
      glossary,
    );
    expect(r.glossaryGaps).toEqual([{ plan_id: "PLAN-L6-07-agent-slots", term: "未登録語" }]);
    expect(r.ok).toBe(false);
  });

  it("endsWith 誤判定なし: 別 plan_id の suffix では back-fill 済と見なさない", () => {
    const plans = [
      plan({ plan_id: "PLAN-L7-1", kind: "add-impl" }),
      plan({
        plan_id: "PLAN-REVERSE-9-x",
        kind: "reverse",
        // 別 plan の path。`PLAN-L7-1` の suffix だが境界が違う
        requires: ["docs/plans/PLAN-X-L7-1.md"],
      }),
    ];
    const r = analyzeBackfill(plans, glossary);
    expect(r.reverseOrphans).toEqual([{ plan_id: "PLAN-L7-1", kind: "add-impl" }]);
  });

  it("archived は対象外", () => {
    const r = analyzeBackfill(
      [plan({ plan_id: "PLAN-L7-99-old", kind: "add-impl", status: "archived" })],
      glossary,
    );
    expect(r.reverseOrphans).toEqual([]);
  });
});

describe("U-BACKFILL-004a required backfill bidirectional pairing", () => {
  const glossary = "agent-slot peak_parallel";

  it("new required add-impl must also require its Reverse backfill PLAN", () => {
    const plans = [
      plan({
        plan_id: "PLAN-L7-108-green-evidence",
        kind: "add-impl",
        updated: "2026-06-23",
      }),
      plan({
        plan_id: "PLAN-REVERSE-108-green-evidence",
        kind: "reverse",
        requires: ["docs/plans/PLAN-L7-108-green-evidence.md"],
      }),
    ];
    const r = analyzeBackfill(plans, glossary);
    expect(r.reverseOrphans).toEqual([]);
    expect(r.reverseLinkMissing).toEqual([
      {
        plan_id: "PLAN-L7-108-green-evidence",
        reverse_plan_id: "PLAN-REVERSE-108-green-evidence",
      },
    ]);
    expect(r.ok).toBe(false);
  });

  it("new required add-impl passes when the Reverse pairing is bidirectional", () => {
    const plans = [
      plan({
        plan_id: "PLAN-L7-108-green-evidence",
        kind: "add-impl",
        updated: "2026-06-23",
        requires: ["docs/plans/PLAN-REVERSE-108-green-evidence.md"],
      }),
      plan({
        plan_id: "PLAN-REVERSE-108-green-evidence",
        kind: "reverse",
        requires: ["docs/plans/PLAN-L7-108-green-evidence.md"],
      }),
    ];
    const r = analyzeBackfill(plans, glossary);
    expect(r.reverseOrphans).toEqual([]);
    expect(r.reverseLinkMissing).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe("U-BACKFILL-004b conditional backprop decision gate", () => {
  const glossary = "agent-slot peak_parallel";

  it("conditional kind updated after enforcement without Reverse or no-backprop decision fails", () => {
    const r = analyzeBackfill(
      [plan({ plan_id: "PLAN-L7-104-x", kind: "refactor", updated: "2026-06-22" })],
      glossary,
    );
    expect(r.conditionalDecisionMissing).toEqual([{ plan_id: "PLAN-L7-104-x", kind: "refactor" }]);
    expect(r.conditionalPending).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it("conditional kind can explicitly declare no design backprop required", () => {
    const r = analyzeBackfill(
      [
        plan({
          plan_id: "PLAN-L7-104-x",
          kind: "refactor",
          updated: "2026-06-22",
          backpropDecision: "not_required",
          backpropDecisionReason: "internal cleanup only; no contract or design change",
        }),
      ],
      glossary,
    );
    expect(r.conditionalDecisionMissing).toEqual([]);
    expect(r.conditionalPending).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("legacy conditional debt remains a warning baseline", () => {
    const r = analyzeBackfill(
      [
        plan({
          plan_id: "PLAN-L7-100-standard-deliverable-section-structure",
          kind: "troubleshoot",
          updated: "2026-06-22",
        }),
      ],
      glossary,
    );
    expect(r.conditionalDecisionMissing).toEqual([]);
    expect(r.conditionalPending).toEqual([
      { plan_id: "PLAN-L7-100-standard-deliverable-section-structure", kind: "troubleshoot" },
    ]);
    expect(r.ok).toBe(true);
  });
});

describe("U-BACKFILL-004c legacy conditional audit sync", () => {
  const glossary = "agent-slot peak_parallel";

  it("fails when the legacy conditional allowlist is missing from the audit table", () => {
    const r = analyzeBackfill([], glossary, new Set());

    expect(r.legacyAuditGaps).toContainEqual({
      plan_id: "PLAN-L7-05-biome-debt",
      location: "audit",
    });
    expect(r.ok).toBe(false);
  });

  it("fails when the audit table contains an entry outside the allowlist", () => {
    const r = analyzeBackfill([], glossary, new Set(["PLAN-L7-999-unknown-legacy"]));

    expect(r.legacyAuditGaps).toContainEqual({
      plan_id: "PLAN-L7-999-unknown-legacy",
      location: "allowlist",
    });
    expect(r.ok).toBe(false);
  });

  it("parses legacy audit table PLAN ids", () => {
    const ids = parseConditionalBackfillAuditPlanIds(`| PLAN | kind | observed issue |
|---|---|---|
| PLAN-L7-05-biome-debt | refactor | No Reverse link. |
`);

    expect(ids).toEqual(new Set(["PLAN-L7-05-biome-debt"]));
  });
});

describe("U-BACKFILL-005 backfillMessages", () => {
  it("孤児なし → OK / 孤児あり → warn 文言", () => {
    expect(backfillMessages(analyzeBackfill([], "")).some((m) => m.includes("OK"))).toBe(true);
    const orphan = analyzeBackfill([plan({ plan_id: "PLAN-L7-50-o", kind: "add-impl" })], "");
    expect(backfillMessages(orphan).some((m) => m.includes("without Reverse backfill"))).toBe(true);
  });
});

describe("U-BACKFILL-005b backfill result docs sync", () => {
  it("requirements and concept list all machine backfill result keys", () => {
    const root = process.cwd();
    const requirements = readFileSync(
      join(root, "docs", "governance", "ut-tdd-agent-harness-requirements_v1.2.md"),
      "utf8",
    );
    const concept = readFileSync(
      join(root, "docs", "governance", "ut-tdd-agent-harness-concept_v3.1.md"),
      "utf8",
    );

    for (const key of BACKFILL_RESULT_KEYS) {
      expect(requirements).toContain(key);
      expect(concept).toContain(key);
    }
  });
});

describe("U-BACKFILL-006 実 repo の back-fill 完全性 (回帰ガード)", () => {
  it("docs/plans/ 全 add-impl が Reverse 合流済 + §6 用語が L0 §10 に merge 済 (required orphan 0 / glossary gap 0)", () => {
    const docs = loadBackfillDocs();
    const r = analyzeBackfill(docs.plans, docs.glossaryText, docs.auditedLegacyIds);
    // 失敗時に具体 PLAN/term を出して直せるように
    expect({
      reverseOrphans: r.reverseOrphans,
      reverseLinkMissing: r.reverseLinkMissing,
      legacyAuditGaps: r.legacyAuditGaps,
      glossaryGaps: r.glossaryGaps,
    }).toEqual({
      reverseOrphans: [],
      reverseLinkMissing: [],
      legacyAuditGaps: [],
      glossaryGaps: [],
    });
  });
});
