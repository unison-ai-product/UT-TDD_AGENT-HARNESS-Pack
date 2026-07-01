import { describe, expect, it } from "vitest";
import { frontmatterSchema } from "../src/schema/frontmatter";

/** 有効な normal impl frontmatter の最小形 */
function implBase(overrides: Record<string, unknown> = {}) {
  return {
    plan_id: "PLAN-L7-05-frontmatter-schema",
    title: "PLAN-005: frontmatter schema",
    kind: "impl",
    layer: "L7",
    drive: "be",
    status: "draft",
    parent_design: "docs/design/schema/frontmatter.md",
    agent_slots: [{ role: "aim", slot_label: "AIM — 実装" }],
    generates: [{ artifact_path: "src/schema/frontmatter.ts", artifact_type: "source_module" }],
    dependencies: { parent: null, requires: [], blocks: [] },
    ...overrides,
  };
}

describe("frontmatter schema (§1.1 / §1.1.parent_design / §3.3 / §3.4)", () => {
  it("正常な impl PLAN は通る + dependencies default が適用される", () => {
    const r = frontmatterSchema.safeParse(implBase({ dependencies: { parent: null } }));
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.dependencies.requires).toEqual([]);
      expect(r.data.dependencies.blocks).toEqual([]);
    }
  });

  it("github_issue_id は optional・正の整数のみ (§6.8.2 Issue スパイン)", () => {
    expect(frontmatterSchema.safeParse(implBase()).success).toBe(true); // 省略可
    const defaulted = frontmatterSchema.safeParse(implBase({ status: undefined }));
    expect(defaulted.success && defaulted.data.status === "draft").toBe(true);
    expect(frontmatterSchema.safeParse(implBase({ github_issue_id: 42 })).success).toBe(true);
    expect(frontmatterSchema.safeParse(implBase({ github_issue_id: null })).success).toBe(true);
    expect(frontmatterSchema.safeParse(implBase({ github_issue_id: 0 })).success).toBe(false);
    expect(frontmatterSchema.safeParse(implBase({ github_issue_id: -1 })).success).toBe(false);
    expect(frontmatterSchema.safeParse(implBase({ github_issue_id: "42" })).success).toBe(false);
  });

  it("kind=impl で parent_design 欠落は fail (§1.1.parent_design)", () => {
    const r = frontmatterSchema.safeParse(implBase({ parent_design: undefined }));
    expect(r.success).toBe(false);
  });

  it("不正な plan_id は fail (§1.10 A)", () => {
    expect(frontmatterSchema.safeParse(implBase({ plan_id: "PLAN-5" })).success).toBe(false);
    expect(frontmatterSchema.safeParse(implBase({ plan_id: "plan-005" })).success).toBe(false);
  });

  it("charter は layer=L0 で通り、L0 以外は fail (§1.3 / §2.1.1)", () => {
    const ok = frontmatterSchema.safeParse(
      implBase({
        kind: "charter",
        layer: "L0",
        parent_design: undefined,
        agent_slots: [{ role: "po", slot_label: "PO — 企画" }],
      }),
    );
    expect(ok.success).toBe(true);
    const bad = frontmatterSchema.safeParse(
      implBase({ kind: "charter", layer: "L4", parent_design: undefined }),
    );
    expect(bad.success).toBe(false);
  });

  it("normal kind に workflow_phase は禁止 (§1.1)", () => {
    const r = frontmatterSchema.safeParse(implBase({ workflow_phase: "S2" }));
    expect(r.success).toBe(false);
  });

  it("kind=design + L1-L6 requires layer-scoped sub_doc", () => {
    const designBase = implBase({
      plan_id: "PLAN-L4-99-design-subdoc",
      kind: "design",
      layer: "L4",
      parent_design: undefined,
      sub_doc: "function",
      generates: [
        {
          artifact_path: "docs/design/harness/L4-basic-design/function.md",
          artifact_type: "design_doc",
        },
      ],
    });

    expect(frontmatterSchema.safeParse(designBase).success).toBe(true);
    expect(frontmatterSchema.safeParse({ ...designBase, sub_doc: undefined }).success).toBe(false);
    expect(frontmatterSchema.safeParse({ ...designBase, sub_doc: "wireframe" }).success).toBe(
      false,
    );
  });

  it("kind-layer authoring guard rejects right-arm layers for normal authoring kinds", () => {
    expect(frontmatterSchema.safeParse(implBase({ kind: "impl", layer: "L8" })).success).toBe(
      false,
    );
    expect(frontmatterSchema.safeParse(implBase({ kind: "refactor", layer: "L6" })).success).toBe(
      false,
    );
    expect(frontmatterSchema.safeParse(implBase({ kind: "retrofit", layer: "L6" })).success).toBe(
      false,
    );
    expect(
      frontmatterSchema.safeParse(implBase({ kind: "troubleshoot", layer: "L6" })).success,
    ).toBe(false);
    expect(
      frontmatterSchema.safeParse(
        implBase({
          plan_id: "PLAN-L5-99-research",
          kind: "research",
          layer: "L5",
          parent_design: undefined,
        }),
      ).success,
    ).toBe(false);
  });

  it("master_hub may host verification-band roadmap layers without weakening normal design guard", () => {
    const master = implBase({
      plan_id: "PLAN-M-99-master",
      kind: "design",
      layer: "L14",
      master_hub: true,
      parent_design: undefined,
      agent_slots: [{ role: "tl", slot_label: "TL - master hub" }],
      generates: [
        { artifact_path: "docs/plans/PLAN-M-99-master.md", artifact_type: "markdown_doc" },
      ],
    });

    expect(frontmatterSchema.safeParse(master).success).toBe(true);
    expect(frontmatterSchema.safeParse({ ...master, master_hub: false }).success).toBe(false);
  });

  it("poc は layer=cross + workflow_phase 必須、S4 は decision_outcome 必須 (§1.1)", () => {
    const pocBase = {
      plan_id: "PLAN-DISCOVERY-06-poc",
      title: "PLAN-DISCOVERY-06: poc",
      kind: "poc",
      layer: "cross",
      drive: "fullstack",
      status: "draft",
      workflow_phase: "S2",
      agent_slots: [{ role: "aim", slot_label: "AIM — PoC" }],
      dependencies: { parent: null },
    };
    expect(frontmatterSchema.safeParse(pocBase).success).toBe(true);
    // layer != cross は fail
    expect(frontmatterSchema.safeParse({ ...pocBase, layer: "L7" }).success).toBe(false);
    // S4 + decision_outcome 欠落は fail
    expect(frontmatterSchema.safeParse({ ...pocBase, workflow_phase: "S4" }).success).toBe(false);
    // S3 以降 scrum_type 欠落は fail (§3.5)
    expect(frontmatterSchema.safeParse({ ...pocBase, workflow_phase: "S3" }).success).toBe(false);
    // S4 + decision_outcome + scrum_type ありは通る
    expect(
      frontmatterSchema.safeParse({
        ...pocBase,
        workflow_phase: "S4",
        scrum_type: "design-spike",
        decision_outcome: "confirmed",
      }).success,
    ).toBe(true);
    // S4 + decision_outcome ありでも scrum_type 欠落は fail (§3.5)
    expect(
      frontmatterSchema.safeParse({
        ...pocBase,
        workflow_phase: "S4",
        decision_outcome: "confirmed",
      }).success,
    ).toBe(false);
    // poc に R phase は fail
    expect(frontmatterSchema.safeParse({ ...pocBase, workflow_phase: "R2" }).success).toBe(false);
  });

  it("reverse は confirmed_reverse_type 必須、R4 は forward_routing/promotion_strategy 必須 (§3.3 / §3.4)", () => {
    const revBase = {
      plan_id: "PLAN-REVERSE-07-reverse",
      title: "PLAN-REVERSE-07: reverse",
      kind: "reverse",
      layer: "cross",
      drive: "fullstack",
      status: "draft",
      workflow_phase: "R2",
      confirmed_reverse_type: "code",
      agent_slots: [{ role: "tl", slot_label: "TL — Reverse" }],
      dependencies: { parent: null },
    };
    expect(frontmatterSchema.safeParse(revBase).success).toBe(true);
    // confirmed_reverse_type 欠落は fail
    expect(
      frontmatterSchema.safeParse({ ...revBase, confirmed_reverse_type: undefined }).success,
    ).toBe(false);
    // R4 + forward_routing/promotion_strategy 欠落は fail
    expect(frontmatterSchema.safeParse({ ...revBase, workflow_phase: "R4" }).success).toBe(false);
    // R4 + 両方ありは通る
    expect(
      frontmatterSchema.safeParse({
        ...revBase,
        workflow_phase: "R4",
        forward_routing: "L3",
        promotion_strategy: "reuse-with-hardening",
      }).success,
    ).toBe(true);
  });

  it("recovery は layer=cross 許可 + workflow_phase 禁止、token↔kind 一致 (§1.1 / §1.10 A)", () => {
    const recBase = {
      plan_id: "PLAN-RECOVERY-09-x",
      title: "PLAN-RECOVERY-09: recovery",
      kind: "recovery",
      layer: "cross",
      drive: "fullstack",
      status: "draft",
      agent_slots: [{ role: "aim", slot_label: "AIM — Recovery" }],
      dependencies: { parent: null },
    };
    // recovery + cross + phase なしは通る (解禁)
    expect(frontmatterSchema.safeParse(recBase).success).toBe(true);
    // recovery に workflow_phase は fail
    expect(frontmatterSchema.safeParse({ ...recBase, workflow_phase: "S2" }).success).toBe(false);
    // 駆動トークン↔kind 不一致は fail (DISCOVERY token に recovery kind)
    expect(
      frontmatterSchema.safeParse({ ...recBase, plan_id: "PLAN-DISCOVERY-09-x" }).success,
    ).toBe(false);
  });

  it("v2_import 任意フィールドが受理される (Minor 1 / G1 readiness v8)", () => {
    const r = frontmatterSchema.safeParse(
      implBase({ v2_import: "docs/migration/v2-import-ledger.md" }),
    );
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.v2_import).toBe("docs/migration/v2-import-ledger.md");
    }
    // v2_import なしも通る (任意フィールド)
    const r2 = frontmatterSchema.safeParse(implBase());
    expect(r2.success).toBe(true);
  });

  it("kind=add-* は dependencies.parent 必須 (§1.10 E)", () => {
    const r = frontmatterSchema.safeParse(
      implBase({ kind: "add-impl", dependencies: { parent: null } }),
    );
    expect(r.success).toBe(false);
    const ok = frontmatterSchema.safeParse(
      implBase({ kind: "add-impl", dependencies: { parent: "PLAN-L7-05-frontmatter-schema" } }),
    );
    expect(ok.success).toBe(true);
  });
  it("L4 標準成果物カタログ拡張: report/batch/notification/code-value は L4 valid・L2 invalid (§1.10.G.1)", () => {
    const l4 = (subDoc: string) =>
      implBase({
        plan_id: "PLAN-L4-98-catalog",
        kind: "design",
        layer: "L4",
        parent_design: undefined,
        sub_doc: subDoc,
        generates: [
          {
            artifact_path: `docs/design/harness/L4-basic-design/${subDoc}.md`,
            artifact_type: "design_doc",
          },
        ],
      });
    for (const t of ["report", "batch", "notification", "code-value"]) {
      expect(frontmatterSchema.safeParse(l4(t)).success).toBe(true);
    }
    // L4 専用カタログ: L2 (画面層) では invalid
    const l2Report = implBase({
      plan_id: "PLAN-L2-98-catalog",
      kind: "design",
      layer: "L2",
      parent_design: undefined,
      sub_doc: "report",
      generates: [
        { artifact_path: "docs/design/harness/L2-screen/report.md", artifact_type: "design_doc" },
      ],
    });
    expect(frontmatterSchema.safeParse(l2Report).success).toBe(false);
  });

  it("drive は専門職 5 種のみ・mode 値 (駆動モデル) を拒否する (§1.6 軸分離、DISCOVERY-04 V7)", () => {
    // 専門職 5 種は通る (kind 非依存の許容 matrix = 全 kind × 全 drive)。
    for (const drive of ["be", "fe", "fullstack", "db", "agent"]) {
      expect(frontmatterSchema.safeParse(implBase({ drive })).success).toBe(true);
    }
    // 旧 mode 値 (駆動モデル/状況。drive でない) は fail = 軸分離が崩れていない証拠。
    for (const mode of ["scrum", "reverse", "poc", "troubleshoot", "recovery"]) {
      expect(frontmatterSchema.safeParse(implBase({ drive: mode })).success).toBe(false);
    }
  });

  it("kind=impl の master_hub は工程表ハブとして parent_design 不要", () => {
    const r = frontmatterSchema.safeParse(
      implBase({
        parent_design: undefined,
        master_hub: true,
        generates: [
          {
            artifact_path: "docs/plans/PLAN-L7-05-frontmatter-schema.md",
            artifact_type: "markdown_doc",
          },
        ],
      }),
    );
    expect(r.success).toBe(true);
  });

  it("review_evidence.green_commands accepts structured green command evidence", () => {
    const ok = frontmatterSchema.safeParse(
      implBase({
        review_evidence: [
          {
            reviewer: "codex-intra-runtime",
            review_kind: "intra_runtime_subagent",
            reviewed_at: "2026-06-23",
            tests_green_at: "2026-06-23",
            verdict: "approve",
            green_commands: [
              {
                kind: "unit_test",
                command: "bun test tests/review-evidence.test.ts",
                runner: "bun",
                scope: "targeted",
                exit_code: 0,
                completed_at: "2026-06-23",
                evidence_path: "tests/review-evidence.test.ts",
                output_digest: "sha256:0123456789abcdef",
              },
            ],
          },
        ],
      }),
    );
    expect(ok.success).toBe(true);

    const bad = frontmatterSchema.safeParse(
      implBase({
        review_evidence: [
          {
            reviewer: "codex-intra-runtime",
            review_kind: "intra_runtime_subagent",
            reviewed_at: "2026-06-23",
            tests_green_at: "2026-06-23",
            verdict: "approve",
            green_commands: [
              {
                kind: "doctor",
                command: "bun run src/cli.ts doctor",
                runner: "bun",
                scope: "gate",
                exit_code: 1,
                evidence_path: "docs/plans/PLAN-L7-108-review-green-command-evidence.md",
                output_digest: "sha256:0123456789abcdef",
              },
            ],
          },
        ],
      }),
    );
    expect(bad.success).toBe(false);
  });
});
