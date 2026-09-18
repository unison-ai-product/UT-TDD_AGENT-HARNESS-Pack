import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzePlanGovernance,
  analyzePlanReferenceFreshness,
  analyzePlanSchedule,
  extractScheduleSection,
  lintPlanWithGate,
  planGovernanceMessages,
  planScheduleMessages,
} from "../src/plan/lint.ts";
import {
  READY_DEPENDENCY_STATUSES,
  ROUTE_MODE_ALLOWED_KINDS,
  ROUTE_MODE_KIND_DRAFT_DEBT_PLAN_IDS,
  ROUTE_MODE_KIND_LEGACY_LANDED_PLAN_IDS,
  ROUTE_MODE_LAYER_BANDS,
  VERSION_UP_PARKING_LEGACY_LANDED_PLAN_IDS,
} from "../src/plan/lint-policy.ts";
import type { LintResult as SidecarLintResult } from "../src/plan/lint-types.ts";
import { PARENT_DRIVE_MISMATCH_BASELINE } from "../src/plan/parent-drive-mismatch-baseline.ts";

const compliant = `---
plan_id: PLAN-X
---
## §3 工程表 (Step + 進捗)

### Step 1: [直列] 設計対象の確定
直列理由: downstream_dependency

### Step 2: [並列] fixture 整備

### Step 3: [直列] review
直列理由: downstream_dependency
self / pmo-sonnet review

## §3.1 実装計画

- 情報源: src/plan/lint.ts
`;

function planDoc(
  id: string,
  overrides: {
    kind?: string;
    layer?: string;
    drive?: string;
    status?: string;
    subDoc?: string | null;
    dependencies?: string;
    parentDesign?: string;
    generates?: string;
    extra?: string;
  } = {},
) {
  const kind = overrides.kind ?? "design";
  const layer = overrides.layer ?? "L4";
  const drive = overrides.drive ?? "agent";
  const status = overrides.status ?? "completed";
  const subDoc = overrides.subDoc === undefined ? "function" : overrides.subDoc;
  const dependencies = overrides.dependencies ?? "  parent: null\n  requires: []\n  blocks: []";
  const parentDesign = overrides.parentDesign ? `parent_design: ${overrides.parentDesign}\n` : "";
  const subDocLine = subDoc ? `sub_doc: ${subDoc}\n` : "";
  const generates = overrides.generates ?? "[]";
  return {
    file: `docs/plans/${id}.md`,
    content: `---\nplan_id: ${id}\ntitle: "${id}"\nkind: ${kind}\nlayer: ${layer}\ndrive: ${drive}\nstatus: ${status}\n${subDocLine}${parentDesign}agent_slots:\n  - role: tl\n    slot_label: "TL - fixture"\ngenerates: ${generates}\ndependencies:\n${dependencies}\n${overrides.extra ?? ""}---\n\n## body\n`,
  };
}

function fixtureArtifactType(artifactPath: string): string {
  if (artifactPath.startsWith("docs/design/")) return "design_doc";
  if (artifactPath.startsWith("docs/test-design/")) return "test_design";
  if (artifactPath.startsWith("docs/plans/")) return "markdown_doc";
  if (artifactPath.endsWith(".ts") || artifactPath.endsWith(".tsx")) return "source_module";
  if (artifactPath.includes("/tests/") || artifactPath.startsWith("tests/")) return "test_code";
  return "markdown_doc";
}

function dbProgressPlanDoc(id: string, generatedPaths: string[]) {
  const generates = generatedPaths
    .map((artifactPath) => {
      const artifactType = fixtureArtifactType(artifactPath);
      return `  - artifact_path: ${artifactPath}\n    artifact_type: ${artifactType}`;
    })
    .join("\n");
  return {
    file: `docs/plans/${id}.md`,
    content: `---\nplan_id: ${id}\ntitle: "${id}: artifact_progress red/yellow/green DB projection"\nkind: add-impl\nlayer: L7\ndrive: db\nstatus: confirmed\nagent_slots:\n  - role: tl\n    slot_label: "TL - fixture"\ngenerates:\n${generates}\ndependencies:\n  parent: null\n  requires: []\n  blocks: []\n---\n\n## body\n\nAdd artifact_progress progress color semantics for red/yellow/green.\n`,
  };
}

function reverseFullbackPlanDoc(
  id: string,
  generatedPaths: string[],
  overrides: { updated?: string; status?: string; extra?: string } = {},
) {
  const generates =
    generatedPaths.length === 0
      ? "[]"
      : `\n${generatedPaths
          .map(
            (artifactPath) =>
              `  - artifact_path: ${artifactPath}\n    artifact_type: ${fixtureArtifactType(
                artifactPath,
              )}`,
          )
          .join("\n")}`;
  return {
    file: `docs/plans/${id}.md`,
    content: `---\nplan_id: ${id}\ntitle: "${id}: reverse fullback fixture"\nkind: reverse\nlayer: cross\nworkflow_phase: R4\nconfirmed_reverse_type: fullback\ndrive: fullstack\nstatus: ${overrides.status ?? "confirmed"}\ncreated: 2026-06-22\nupdated: ${overrides.updated ?? "2026-06-22"}\nowner: fixture\nforward_routing: L5\npromotion_strategy: reuse-as-is\nagent_slots:\n  - role: tl\n    slot_label: "TL - fixture"\ngenerates: ${generates}\ndependencies:\n  parent: null\n  requires: []\n  blocks: []\n${overrides.extra ?? ""}---\n\n## body\n`,
  };
}

function reverseR4PlanDoc(
  id: string,
  reverseType: string,
  generatedPaths: string[],
  overrides: { updated?: string; status?: string; body?: string; extra?: string } = {},
) {
  const generates =
    generatedPaths.length === 0
      ? "[]"
      : `\n${generatedPaths
          .map(
            (artifactPath) =>
              `  - artifact_path: ${artifactPath}\n    artifact_type: ${fixtureArtifactType(
                artifactPath,
              )}`,
          )
          .join("\n")}`;
  return {
    file: `docs/plans/${id}.md`,
    content: `---\nplan_id: ${id}\ntitle: "${id}: reverse R4 fixture"\nkind: reverse\nlayer: cross\nworkflow_phase: R4\nconfirmed_reverse_type: ${reverseType}\ndrive: fullstack\nstatus: ${overrides.status ?? "confirmed"}\ncreated: 2026-06-23\nupdated: ${overrides.updated ?? "2026-06-23"}\nowner: fixture\nforward_routing: L5\npromotion_strategy: reuse-as-is\nagent_slots:\n  - role: tl\n    slot_label: "TL - fixture"\ngenerates: ${generates}\ndependencies:\n  parent: null\n  requires: []\n  blocks: []\n${overrides.extra ?? ""}---\n\n## body\n\n${overrides.body ?? ""}\n`,
  };
}

const fullbackScope = `backprop_scope:
  - layer: requirements
    decision: updated
    evidence_path: docs/governance/ut-tdd-agent-harness-requirements_v1.2.md
    reason: "Requirements record the fullback governance change."
  - layer: L4-basic-design
    decision: not_impacted
    reason: "The change does not alter external basic design behavior."
  - layer: L5-detailed-design
    decision: not_impacted
    reason: "The change does not alter detailed internal design behavior."
`;

describe("plan schedule lint (IMP-081)", () => {
  it("U-PLANSCH-001: §工程表 section を抽出する", () => {
    expect(extractScheduleSection(compliant)).toContain("Step 1");
  });

  it("U-PLANSCH-002: 準拠 PLAN は ok", () => {
    const r = analyzePlanSchedule([{ file: "PLAN-X.md", content: compliant }]);
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("U-PLANSCH-003: [並列]/[直列] 欠落 Step は violation", () => {
    const content = compliant.replace(
      "### Step 1: [直列] 設計対象の確定",
      "### Step 1: 設計対象の確定",
    );
    const r = analyzePlanSchedule([{ file: "PLAN-X.md", content }]);
    expect(r.violations.some((v) => v.reason === "missing_mode")).toBe(true);
    expect(r.ok).toBe(false);
  });

  it("U-PLANSCH-004: [直列] の3条件理由欠落は violation", () => {
    const content = compliant.replace("直列理由: downstream_dependency", "直列理由: 手順上必要");
    const r = analyzePlanSchedule([{ file: "PLAN-X.md", content }]);
    expect(r.violations.some((v) => v.reason === "missing_serial_reason")).toBe(true);
  });

  it("U-PLANSCH-005: review Step 不在は violation", () => {
    const content = compliant.replace("### Step 3: [直列] review", "### Step 3: [直列] 完了確認");
    const r = analyzePlanSchedule([{ file: "PLAN-X.md", content }]);
    expect(r.violations.some((v) => v.reason === "missing_review_step")).toBe(true);
  });

  it("U-PLANSCH-006: §3.1 実装計画 不在は violation", () => {
    const content = compliant.replace("## §3.1 実装計画", "## §4 DoD");
    const r = analyzePlanSchedule([{ file: "PLAN-X.md", content }]);
    expect(r.violations.some((v) => v.reason === "missing_impl_plan")).toBe(true);
    expect(planScheduleMessages(r)[0]).toContain("violation");
  });

  it("U-PLANSCH-007: --gate G3-trace runs the trace lint", () => {
    if (!existsSync(join(process.cwd(), "docs", "test-design", "harness"))) return;
    const r: SidecarLintResult = lintPlanWithGate(undefined, process.cwd(), "G3-trace");
    expect(r.ok).toBe(true);
    expect(r.messages[0]).toContain("g3-trace - OK");
    expect(READY_DEPENDENCY_STATUSES.has("confirmed")).toBe(true);
  });

  it("U-PLANSCH-008: --gate G3-trace fails closed when required docs are missing", () => {
    const r = lintPlanWithGate(undefined, "__missing_repo_root__", "G3-trace");
    expect(r.ok).toBe(false);
    expect(r.messages[0]).toContain("required docs could not be read");
  });

  it("U-PLANSCH-009: --gate G1-trace runs the trace lint", () => {
    if (!existsSync(join(process.cwd(), "docs", "test-design", "harness"))) return;
    const r = lintPlanWithGate(undefined, process.cwd(), "G1-trace");
    expect(r.ok).toBe(true);
    expect(r.messages[0]).toContain("g1-trace - OK");
  });

  it("U-PLANSCH-010: unknown gate fails closed", () => {
    const r = lintPlanWithGate(undefined, process.cwd(), "NO-SUCH-GATE");
    expect(r.ok).toBe(false);
    expect(r.messages[0]).toContain("unsupported gate");
  });

  it("U-PLANGOV-001: valid frontmatter/cross-record fixture passes", () => {
    const docs = [
      planDoc("PLAN-L6-90-parent", {
        kind: "design",
        layer: "L6",
        status: "confirmed",
        subDoc: "function-spec",
      }),
      planDoc("PLAN-L7-90-child", {
        kind: "add-impl",
        layer: "L7",
        subDoc: null,
        dependencies: "  parent: docs/plans/PLAN-L6-90-parent.md\n  requires: []\n  blocks: []",
      }),
    ];

    const r = analyzePlanGovernance(docs);

    expect(r.ok).toBe(true);
    expect(planGovernanceMessages(r)[0]).toContain("OK");
  });

  it("U-PLANGOV-002: schema, sub_doc, duplicate, and skip-reason violations are reported", () => {
    const docs = [
      planDoc("PLAN-L4-91-invalid-schema", { extra: 'github_issue_id: "bad"\n' }),
      planDoc("PLAN-L4-92-missing-subdoc", { subDoc: null }),
      planDoc("PLAN-L4-93-bad-subdoc", { subDoc: "no-such-subdoc" }),
      planDoc("PLAN-L4-94-duplicate-a"),
      planDoc("PLAN-L4-95-duplicate-b"),
      planDoc("PLAN-L2-91-skip", {
        layer: "L2",
        subDoc: "screen-list",
        extra: "skip_sub_doc:\n  - sub_doc: wireframe\n    reason: no\n",
      }),
    ];

    const reasons = analyzePlanGovernance(docs).violations.map((v) => v.reason);

    expect(reasons).toContain("invalid_frontmatter");
    expect(reasons).toContain("missing_sub_doc");
    expect(reasons).toContain("invalid_sub_doc");
    expect(reasons).toContain("duplicate_layer_sub_doc");
    expect(reasons).toContain("skip_sub_doc_reason");
  });

  it("U-PLANGOV-002a: different slugs cannot reuse the same PLAN namespace and ordinal", () => {
    const docs = [
      planDoc("PLAN-L6-991-contract-a", { layer: "L6", subDoc: "function-spec" }),
      planDoc("PLAN-L6-991-contract-b", { layer: "L6", subDoc: "function-spec" }),
    ];

    const violations = analyzePlanGovernance(docs).violations.filter(
      (violation) => violation.reason === "duplicate_plan_identity",
    );

    expect(violations.map((violation) => violation.file)).toEqual([
      "docs/plans/PLAN-L6-991-contract-a.md",
      "docs/plans/PLAN-L6-991-contract-b.md",
    ]);
    expect(violations.every((violation) => violation.detail?.includes("L6:991"))).toBe(true);
  });

  it("U-PLANGOV-002b: zero padding does not create a second PLAN identity", () => {
    const docs = [
      planDoc("PLAN-RECOVERY-070-repair-a", {
        kind: "recovery",
        layer: "cross",
        subDoc: null,
      }),
      planDoc("PLAN-RECOVERY-70-repair-b", {
        kind: "recovery",
        layer: "cross",
        subDoc: null,
      }),
    ];

    const violations = analyzePlanGovernance(docs).violations.filter(
      (violation) => violation.reason === "duplicate_plan_identity",
    );

    expect(violations).toHaveLength(2);
    expect(violations.every((violation) => violation.detail?.includes("RECOVERY:70"))).toBe(true);
  });

  const legacyL6CollisionDocs = () => [
    planDoc("PLAN-L6-70-source-catalog-profile-resolver-contracts", {
      layer: "L6",
      subDoc: "function-spec",
    }),
    planDoc("PLAN-L6-70-vmodel-judgement-skill-pack", {
      layer: "L6",
      subDoc: "function-spec",
    }),
  ];

  it("U-PLANGOV-002c: accepts only the exact legacy collision set", () => {
    const violations = analyzePlanGovernance(legacyL6CollisionDocs()).violations.filter(
      (violation) => violation.reason === "duplicate_plan_identity",
    );

    expect(violations).toEqual([]);
  });

  it("U-PLANGOV-002d: rejects a third PLAN at a legacy collision coordinate", () => {
    const docs = [
      ...legacyL6CollisionDocs(),
      planDoc("PLAN-L6-070-third-collision", {
        layer: "L6",
        subDoc: "function-spec",
      }),
    ];
    const violations = analyzePlanGovernance(docs).violations.filter(
      (violation) => violation.reason === "duplicate_plan_identity",
    );

    expect(violations).toHaveLength(3);
  });

  it("U-PLANGOV-002e: rejects substitution inside a legacy collision set", () => {
    const docs = [
      legacyL6CollisionDocs()[0],
      planDoc("PLAN-L6-70-substituted-plan", {
        layer: "L6",
        subDoc: "function-spec",
      }),
    ];
    const violations = analyzePlanGovernance(docs).violations.filter(
      (violation) => violation.reason === "duplicate_plan_identity",
    );

    expect(violations).toHaveLength(2);
  });

  it("U-PLANGOV-002f: accepts a coordinate after its legacy collision is resolved", () => {
    const violations = analyzePlanGovernance([legacyL6CollisionDocs()[0]]).violations.filter(
      (violation) => violation.reason === "duplicate_plan_identity",
    );

    expect(violations).toEqual([]);
  });

  it("U-PLANGOV-006: L4 標準成果物カタログ拡張 (report/batch/notification/code-value) を plan lint が valid sub_doc として受理", () => {
    const newTypes = ["report", "batch", "notification", "code-value", "security"];
    const docs = newTypes.map((t, i) => planDoc(`PLAN-L4-8${i}-${t}`, { layer: "L4", subDoc: t }));
    const reasons = analyzePlanGovernance(docs).violations.map((v) => v.reason);
    expect(reasons).not.toContain("invalid_sub_doc");

    // schema 単一正本由来 (重複コピー撤去) ゆえ L4 専用: L2 へ置くと invalid_sub_doc
    const l2 = analyzePlanGovernance([
      planDoc("PLAN-L2-89-report", { layer: "L2", subDoc: "report" }),
    ]);
    expect(l2.violations.map((v) => v.reason)).toContain("invalid_sub_doc");
  });

  it("U-PLANGOV-003: parent/requires/parent_design cross-record checks fail closed", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-plan-governance-"));
    try {
      const docs = [
        planDoc("PLAN-L6-91-parent", {
          kind: "design",
          layer: "L6",
          drive: "be",
          status: "draft",
          subDoc: "function-spec",
        }),
        planDoc("PLAN-L7-91-child", {
          kind: "add-impl",
          layer: "L7",
          drive: "agent",
          subDoc: null,
          parentDesign: "docs/design/missing.md",
          dependencies:
            "  parent: docs/plans/PLAN-L6-91-parent.md\n  requires:\n    - docs/plans/PLAN-L6-91-parent.md\n    - docs/plans/PLAN-L6-99-missing.md\n  blocks: []",
        }),
      ];

      const reasons = analyzePlanGovernance(docs, root).violations.map((v) => v.reason);

      expect(reasons).toContain("parent_drive_mismatch");
      expect(reasons).toContain("requires_not_ready");
      expect(reasons).toContain("requires_missing");
      expect(reasons).toContain("parent_design_missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-PLANGOV-003a: parent_drive_mismatch applies to impl kind children", () => {
    const docs = [
      planDoc("PLAN-L7-91-parent-drive", {
        kind: "add-impl",
        layer: "L7",
        drive: "be",
        status: "draft",
        subDoc: "function-spec",
      }),
      planDoc("PLAN-L7-92-child-impl", {
        kind: "impl",
        layer: "L7",
        drive: "agent",
        subDoc: null,
        dependencies:
          "  parent: docs/plans/PLAN-L7-91-parent-drive.md\n  requires: []\n  blocks: []",
      }),
    ];

    const reasons = analyzePlanGovernance(docs).violations.map((v) => v.reason);

    expect(reasons).toContain("parent_drive_mismatch");
  });

  it("U-PLANGOV-003d: 非 PLAN 親参照はファイル実在なら親チェックを通過する", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-plan-governance-nonplan-parent-"));
    try {
      const parentArtifact = join(
        root,
        "docs",
        "design",
        "harness",
        "L6-function-design",
        "function-spec.md",
      );
      mkdirSync(join(root, "docs", "design", "harness", "L6-function-design"), { recursive: true });
      writeFileSync(parentArtifact, "---\nstatus: completed\n---\n", "utf8");

      const docs = [
        planDoc("PLAN-L7-1000-impl", {
          kind: "impl",
          layer: "L7",
          drive: "agent",
          parentDesign: "docs/design/harness/L6-function-design/function-spec.md",
          dependencies: `  parent: docs/design/harness/L6-function-design/function-spec.md\n  requires: []\n  blocks: []`,
          subDoc: null,
        }),
      ];

      const reasons = analyzePlanGovernance(docs, root).violations.map((v) => v.reason);

      expect(reasons).not.toContain("parent_missing");
      expect(reasons).not.toContain("parent_drive_mismatch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-PLANGOV-003b: parent_drive_mismatch debt は既知項目で WARN（fail-close しない）", () => {
    const baselinePlanId = [...PARENT_DRIVE_MISMATCH_BASELINE][0];
    const baselineDocs = [
      planDoc("PLAN-L7-basis-parent", {
        kind: "impl",
        layer: "L7",
        drive: "agent",
        status: "confirmed",
      }),
      planDoc(baselinePlanId, {
        kind: "impl",
        layer: "L7",
        drive: "be",
        dependencies: "  parent: docs/plans/PLAN-L7-basis-parent.md\n  requires: []\n  blocks: []",
      }),
    ];
    const reasons = analyzePlanGovernance(baselineDocs).violations.map((v) => v.reason);

    expect(reasons).not.toContain("parent_drive_mismatch");
    expect(reasons).not.toContain("parent_drive_mismatch_debt_stale");
  });

  it("U-PLANGOV-003c: parent_drive_mismatch debt を fixed すると baseline stale として再通知", () => {
    const baselinePlanId = [...PARENT_DRIVE_MISMATCH_BASELINE][0];
    const baselineMatchFixed = [
      planDoc("PLAN-L7-basis-parent", {
        kind: "impl",
        layer: "L7",
        drive: "agent",
        status: "confirmed",
      }),
      planDoc(baselinePlanId, {
        kind: "impl",
        layer: "L7",
        drive: "agent",
        dependencies: "  parent: docs/plans/PLAN-L7-basis-parent.md\n  requires: []\n  blocks: []",
      }),
    ];
    const reasons = analyzePlanGovernance(baselineMatchFixed).violations.map((v) => v.reason);

    expect(reasons).toContain("parent_drive_mismatch_debt_stale");
  });

  it("U-PLANGOV-004: artifact requires use filesystem existence instead of PLAN status", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-plan-governance-artifact-"));
    try {
      const artifact = join(root, "docs", "design", "harness", "L4-basic-design", "function.md");
      mkdirSync(join(root, "docs", "design", "harness", "L4-basic-design"), { recursive: true });
      writeFileSync(artifact, "---\nstatus: confirmed\n---\n", "utf8");
      const docs = [
        planDoc("PLAN-L4-97-artifact-requires", {
          dependencies:
            "  parent: null\n  requires:\n    - docs/design/harness/L4-basic-design/function.md\n  blocks: []",
        }),
      ];

      const r = analyzePlanGovernance(docs, root);

      expect(r.violations.filter((v) => v.reason === "requires_missing")).toEqual([]);
      expect(r.violations.filter((v) => v.reason === "requires_not_ready")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows draft add-impl / draft Reverse pairing through parent without requires_not_ready", () => {
    const docs = [
      planDoc("PLAN-L7-263-route-kind", {
        kind: "add-impl",
        layer: "L7",
        drive: "be",
        status: "draft",
        dependencies:
          "  parent: docs/plans/PLAN-L7-212-route-governance.md\n  requires: []\n  blocks: []",
      }),
      planDoc("PLAN-L7-212-route-governance", {
        kind: "refactor",
        layer: "L7",
        drive: "be",
        status: "confirmed",
      }),
      {
        file: "PLAN-REVERSE-263-route-kind.md",
        content: `---
plan_id: PLAN-REVERSE-263-route-kind
title: "PLAN-REVERSE-263: route kind backfill"
kind: reverse
layer: cross
workflow_phase: R0
confirmed_reverse_type: design
drive: be
status: draft
created: 2026-07-02
updated: 2026-07-02
agent_slots:
  - role: tl
    slot_label: "TL - fixture"
dependencies:
  parent: docs/plans/PLAN-L7-263-route-kind.md
  requires: []
  blocks: []
---

## body
`,
      },
    ];

    const reasons = analyzePlanGovernance(docs).violations.map((v) => v.reason);

    expect(reasons).not.toContain("requires_not_ready");
    expect(reasons).not.toContain("parent_missing");
    expect(READY_DEPENDENCY_STATUSES.has("draft")).toBe(false);
  });

  it("keeps draft Reverse references in dependencies.requires blocked as not ready", () => {
    const docs = [
      planDoc("PLAN-L7-263-route-kind", {
        kind: "add-impl",
        layer: "L7",
        drive: "be",
        status: "draft",
        dependencies:
          "  parent: docs/plans/PLAN-L7-212-route-governance.md\n  requires:\n    - docs/plans/PLAN-REVERSE-263-route-kind.md\n  blocks: []",
      }),
      planDoc("PLAN-L7-212-route-governance", {
        kind: "refactor",
        layer: "L7",
        drive: "be",
        status: "confirmed",
      }),
      {
        file: "PLAN-REVERSE-263-route-kind.md",
        content: `---
plan_id: PLAN-REVERSE-263-route-kind
title: "PLAN-REVERSE-263: route kind backfill"
kind: reverse
layer: cross
workflow_phase: R0
confirmed_reverse_type: design
drive: be
status: draft
created: 2026-07-02
updated: 2026-07-02
agent_slots:
  - role: tl
    slot_label: "TL - fixture"
dependencies:
  parent: docs/plans/PLAN-L7-263-route-kind.md
  requires: []
  blocks: []
---

## body
`,
      },
    ];

    const reasons = analyzePlanGovernance(docs).violations.map((v) => v.reason);

    expect(reasons).toContain("requires_not_ready");
  });

  it("U-PLANGOV-005: --gate governance runs strict PLAN governance lint", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-plan-governance-cli-"));
    try {
      const plansDir = join(root, "docs", "plans");
      mkdirSync(plansDir, { recursive: true });
      const fixture = planDoc("PLAN-L4-96-governance-cli", { extra: 'github_issue_id: "bad"\n' });
      writeFileSync(join(plansDir, "PLAN-L4-96-governance-cli.md"), fixture.content, "utf8");

      const r = lintPlanWithGate(undefined, root, "governance");

      expect(r.ok).toBe(false);
      expect(r.messages[0]).toContain("plan-governance - violation");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-PLANLINT-001: default plan lint includes frontmatter governance", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-plan-lint-default-"));
    try {
      const plansDir = join(root, "docs", "plans");
      mkdirSync(plansDir, { recursive: true });
      const fixture = planDoc("PLAN-L4-96-default-lint", {
        extra: 'github_issue_id: "bad"\n',
      });
      const content = fixture.content.replace(
        "## body",
        "## §3 工程表 (Step + 進捗)\n\n### Step 1: [直列] review\n直列理由: downstream_dependency\n\n## §3.1 実装計画\n\n## body",
      );
      writeFileSync(join(plansDir, "PLAN-L4-96-default-lint.md"), content, "utf8");

      const r = lintPlanWithGate(undefined, root);

      expect(r.ok).toBe(false);
      expect(r.messages.some((message) => message.includes("plan-schedule — OK"))).toBe(true);
      expect(r.messages.some((message) => message.includes("plan-governance - violation"))).toBe(
        true,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-PLANLINT-002: path-form default lint resolves cross-record refs from the full PLAN corpus", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-plan-lint-path-context-"));
    try {
      const plansDir = join(root, "docs", "plans");
      mkdirSync(plansDir, { recursive: true });
      const parent = planDoc("PLAN-L6-97-parent", {
        kind: "design",
        layer: "L6",
        status: "confirmed",
        subDoc: "function-spec",
      });
      const child = planDoc("PLAN-L7-97-child", {
        kind: "add-impl",
        layer: "L7",
        subDoc: null,
        dependencies: "  parent: PLAN-L6-97-parent\n  requires: [PLAN-L6-97-parent]\n  blocks: []",
      });
      writeFileSync(join(root, parent.file), parent.content, "utf8");
      writeFileSync(join(root, child.file), child.content, "utf8");

      const result = lintPlanWithGate(child.file, root);

      expect(result.ok).toBe(true);
      expect(result.messages.some((message) => message.includes("parent_missing"))).toBe(false);
      expect(result.messages.some((message) => message.includes("requires_missing"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-PLANLINT-003: path-form governance violations survive slash normalization", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-plan-lint-path-scope-"));
    try {
      const plansDir = join(root, "docs", "plans");
      mkdirSync(plansDir, { recursive: true });
      const fixture = planDoc("PLAN-L4-98-path-scope", {
        extra: 'github_issue_id: "bad"\n',
      });
      writeFileSync(join(root, fixture.file), fixture.content, "utf8");

      const forward = lintPlanWithGate(fixture.file, root);
      expect(forward.ok).toBe(false);
      expect(forward.messages.some((message) => message.includes("invalid_frontmatter"))).toBe(
        true,
      );

      if (process.platform === "win32") {
        const windowsPath = fixture.file.replaceAll("/", "\\");
        const backslash = lintPlanWithGate(windowsPath, root);
        expect(backslash.ok).toBe(false);
        expect(backslash.messages.some((message) => message.includes("invalid_frontmatter"))).toBe(
          true,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-PLANLINT-004: path scope uses canonical identity and fails closed outside corpus", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-plan-lint-path-identity-"));
    try {
      const plansDir = join(root, "docs", "plans");
      const draftsDir = join(root, "docs", "drafts");
      const nestedDir = join(plansDir, "sub");
      mkdirSync(draftsDir, { recursive: true });
      mkdirSync(nestedDir, { recursive: true });

      const corpus = planDoc("PLAN-L4-99-path-identity", {
        extra: 'github_issue_id: "bad"\n',
      });
      writeFileSync(join(root, corpus.file), corpus.content, "utf8");
      const clean = planDoc("PLAN-L4-99-path-identity").content;
      const targets = [
        [join(draftsDir, "PLAN-L4-99-path-identity.md"), clean],
        [join(nestedDir, "PLAN-L4-99-path-identity.md"), clean],
        // Keep the lowercase basename on a distinct directory: Windows treats
        // a case-only spelling of the corpus path as the same physical file.
        [join(nestedDir, "plan-l4-99-path-identity.md"), clean],
      ] as const;

      for (const [target, content] of targets) {
        writeFileSync(target, content, "utf8");
        const result = lintPlanWithGate(target, root);
        expect(result.ok).toBe(false);
        expect(result.messages.some((message) => message.includes("target_context_missing"))).toBe(
          true,
        );
        expect(result.messages.some((message) => message.includes("invalid_frontmatter"))).toBe(
          false,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-PLANGOV-007: progress color DB projection requires Reverse and upstream design backprop", () => {
    const docs = [
      dbProgressPlanDoc("PLAN-L7-98-progress-leak", [
        "docs/plans/PLAN-L7-98-progress-leak.md",
        "src/schema/harness-db.ts",
        "src/state-db/projection-writer.ts",
        "tests/projection-writer.test.ts",
      ]),
    ];

    const reasons = analyzePlanGovernance(docs).violations.map((v) => v.reason);

    expect(reasons).toContain("db_projection_backprop_missing");
  });

  it("U-PLANGOV-008: progress color DB projection passes with fullback and V-model coverage", () => {
    const docs = [
      dbProgressPlanDoc("PLAN-L7-98-progress-covered", [
        "docs/plans/PLAN-L7-98-progress-covered.md",
        "docs/plans/PLAN-REVERSE-98-progress-covered.md",
        "docs/governance/ut-tdd-agent-harness-requirements_v1.2.md",
        "docs/design/harness/L1-requirements/functional-requirements.md",
        "docs/design/harness/L1-requirements/screen-requirements.md",
        "docs/design/harness/L3-functional/functional-requirements.md",
        "docs/design/harness/L4-basic-design/function.md",
        "docs/design/harness/L5-detailed-design/physical-data.md",
        "docs/design/harness/L6-function-design/function-spec.md",
        "docs/design/harness/L6-function-design/fr-unit-coverage.md",
        "src/schema/harness-db.ts",
        "src/state-db/projection-writer.ts",
        "tests/projection-writer.test.ts",
      ]),
    ];

    const reasons = analyzePlanGovernance(docs).violations.map((v) => v.reason);

    expect(reasons).not.toContain("db_projection_backprop_missing");
  });

  it("U-PLANGOV-009: new R4 fullback requires generated design/governance/test-design backprop", () => {
    const docs = [
      reverseFullbackPlanDoc("PLAN-REVERSE-198-no-backprop", [
        "docs/plans/PLAN-REVERSE-198-no-backprop.md",
      ]),
    ];

    const reasons = analyzePlanGovernance(docs).violations.map((v) => v.reason);

    expect(reasons).toContain("reverse_fullback_backprop_missing");
  });

  it("U-PLANGOV-010: new R4 fullback passes when generated backprop artifact is present", () => {
    const docs = [
      reverseFullbackPlanDoc(
        "PLAN-REVERSE-198-with-backprop",
        [
          "docs/plans/PLAN-REVERSE-198-with-backprop.md",
          "docs/governance/ut-tdd-agent-harness-requirements_v1.2.md",
        ],
        { extra: fullbackScope },
      ),
    ];

    const reasons = analyzePlanGovernance(docs).violations.map((v) => v.reason);

    expect(reasons).not.toContain("reverse_fullback_backprop_missing");
    expect(reasons).not.toContain("reverse_fullback_scope_missing");
  });

  it("U-PLANGOV-011: legacy R4 fullback debt remains observable but is not retroactively hard-failed", () => {
    const docs = [
      reverseFullbackPlanDoc("PLAN-REVERSE-198-legacy", [], {
        updated: "2026-06-21",
      }),
    ];

    const reasons = analyzePlanGovernance(docs).violations.map((v) => v.reason);

    expect(reasons).not.toContain("reverse_fullback_backprop_missing");
  });

  it("U-PLANGOV-011b: new R4 fullback requires explicit requirements/L4/L5 backprop scope", () => {
    const docs = [
      reverseFullbackPlanDoc("PLAN-REVERSE-198-missing-scope", [
        "docs/plans/PLAN-REVERSE-198-missing-scope.md",
        "docs/governance/ut-tdd-agent-harness-requirements_v1.2.md",
      ]),
    ];

    const reasons = analyzePlanGovernance(docs).violations.map((v) => v.reason);

    expect(reasons).toContain("reverse_fullback_scope_missing");
  });

  it("U-PLANGOV-011c: updated backprop scope must cite a generated evidence path", () => {
    const docs = [
      reverseFullbackPlanDoc(
        "PLAN-REVERSE-198-stale-scope",
        [
          "docs/plans/PLAN-REVERSE-198-stale-scope.md",
          "docs/design/harness/L5-detailed-design/physical-data.md",
        ],
        { extra: fullbackScope },
      ),
    ];

    const violation = analyzePlanGovernance(docs).violations.find(
      (v) => v.reason === "reverse_fullback_scope_missing",
    );

    expect(violation?.detail).toContain("requirements:missing_generated_evidence");
  });

  it("U-PLANGOV-011d: new fullback body cannot claim an ungenerated backprop artifact path", () => {
    const doc = reverseFullbackPlanDoc(
      "PLAN-REVERSE-198-claimed-artifact",
      [
        "docs/plans/PLAN-REVERSE-198-claimed-artifact.md",
        "docs/governance/ut-tdd-agent-harness-requirements_v1.2.md",
      ],
      { extra: fullbackScope },
    );
    doc.content = `${doc.content}\n## R4 Routing\n\nBack-fill also updates docs/test-design/harness/L7-unit-test-design.md.\n`;

    const violation = analyzePlanGovernance([doc]).violations.find(
      (v) => v.reason === "reverse_fullback_claimed_artifact_missing",
    );

    expect(violation?.detail).toContain("docs/test-design/harness/L7-unit-test-design.md");
  });

  it("U-PLANGOV-011e: new non-fullback R4 reverse cannot claim an ungenerated upstream artifact path", () => {
    const docs = [
      reverseR4PlanDoc(
        "PLAN-REVERSE-198-design-claimed-artifact",
        "design",
        ["docs/plans/PLAN-REVERSE-198-design-claimed-artifact.md"],
        {
          body: "R4 routes the design update to docs/governance/document-system-map.md.",
        },
      ),
    ];

    const violation = analyzePlanGovernance(docs).violations.find(
      (v) => v.reason === "reverse_r4_claimed_artifact_missing",
    );

    expect(violation?.detail).toContain("docs/governance/document-system-map.md");
  });

  it("U-PLANGOV-011f: new non-fullback R4 reverse passes when claimed upstream artifact is generated", () => {
    const docs = [
      reverseR4PlanDoc(
        "PLAN-REVERSE-198-design-generated-artifact",
        "design",
        [
          "docs/plans/PLAN-REVERSE-198-design-generated-artifact.md",
          "docs/governance/document-system-map.md",
        ],
        { body: "R4 routes the design update to docs/governance/document-system-map.md." },
      ),
    ];

    const reasons = analyzePlanGovernance(docs).violations.map((v) => v.reason);

    expect(reasons).not.toContain("reverse_r4_claimed_artifact_missing");
  });

  it("U-PLANGOV-011g: legacy non-fullback R4 reverse claimed-artifact debt is not retroactively failed", () => {
    const docs = [
      reverseR4PlanDoc("PLAN-REVERSE-198-legacy-design-claim", "design", [], {
        updated: "2026-06-22",
        body: "Legacy body cites docs/governance/document-system-map.md.",
      }),
    ];

    const reasons = analyzePlanGovernance(docs).violations.map((v) => v.reason);

    expect(reasons).not.toContain("reverse_r4_claimed_artifact_missing");
  });

  it("U-PLANGOV-011h: new non-fullback R4 route to design layer requires backprop evidence", () => {
    const docs = [
      reverseR4PlanDoc("PLAN-REVERSE-198-design-route-no-backprop", "design", [
        "docs/plans/PLAN-REVERSE-198-design-route-no-backprop.md",
      ]),
    ];

    const reasons = analyzePlanGovernance(docs).violations.map((v) => v.reason);

    expect(reasons).toContain("reverse_r4_route_backprop_missing");
  });

  it("U-PLANGOV-011i: new non-fullback R4 route passes with upstream generated artifact", () => {
    const docs = [
      reverseR4PlanDoc("PLAN-REVERSE-198-design-route-generated", "design", [
        "docs/plans/PLAN-REVERSE-198-design-route-generated.md",
        "docs/design/harness/L5-detailed-design/physical-data.md",
      ]),
    ];

    const reasons = analyzePlanGovernance(docs).violations.map((v) => v.reason);

    expect(reasons).not.toContain("reverse_r4_route_backprop_missing");
  });

  it("U-PLANGOV-011j: new non-fullback R4 route passes with explicit no-backprop decision", () => {
    const docs = [
      reverseR4PlanDoc(
        "PLAN-REVERSE-198-design-route-not-required",
        "normalization",
        ["docs/plans/PLAN-REVERSE-198-design-route-not-required.md"],
        {
          extra:
            'backprop_decision: not_required\nbackprop_decision_reason: "naming normalization only; no requirements or design meaning changed"\n',
        },
      ),
    ];

    const reasons = analyzePlanGovernance(docs).violations.map((v) => v.reason);

    expect(reasons).not.toContain("reverse_r4_route_backprop_missing");
  });

  it("U-PLANGOV-011k: new drive-model PLANs require mandatory agent roles", () => {
    const docs = [
      {
        file: "docs/plans/PLAN-DISCOVERY-198-poc-role.md",
        content: `---\nplan_id: PLAN-DISCOVERY-198-poc-role\ntitle: "PLAN-DISCOVERY-198: poc role"\nkind: poc\nlayer: cross\ndrive: fullstack\nstatus: confirmed\ncreated: 2026-06-23\nupdated: 2026-06-23\nworkflow_phase: S2\nagent_slots:\n  - role: tl\n    slot_label: "TL - fixture"\ndependencies:\n  parent: null\n  requires: []\n  blocks: []\n---\n\n## body\n`,
      },
      {
        file: "docs/plans/PLAN-RECOVERY-198-recovery-role.md",
        content: `---\nplan_id: PLAN-RECOVERY-198-recovery-role\ntitle: "PLAN-RECOVERY-198: recovery role"\nkind: recovery\nlayer: cross\ndrive: fullstack\nstatus: confirmed\ncreated: 2026-06-23\nupdated: 2026-06-23\nagent_slots:\n  - role: tl\n    slot_label: "TL - fixture"\ndependencies:\n  parent: null\n  requires: []\n  blocks: []\n---\n\n## body\n`,
      },
      {
        file: "docs/plans/PLAN-L7-198-troubleshoot-role.md",
        content: `---\nplan_id: PLAN-L7-198-troubleshoot-role\ntitle: "PLAN-L7-198: troubleshoot role"\nkind: troubleshoot\nlayer: L7\ndrive: fullstack\nstatus: confirmed\ncreated: 2026-06-23\nupdated: 2026-06-23\nagent_slots:\n  - role: tl\n    slot_label: "TL - fixture"\ndependencies:\n  parent: null\n  requires: []\n  blocks: []\n---\n\n## body\n`,
      },
      {
        file: "docs/plans/PLAN-REVERSE-198-r3-role.md",
        content: `---\nplan_id: PLAN-REVERSE-198-r3-role\ntitle: "PLAN-REVERSE-198: R3 role"\nkind: reverse\nlayer: cross\ndrive: fullstack\nstatus: confirmed\ncreated: 2026-06-23\nupdated: 2026-06-23\nworkflow_phase: R3\nconfirmed_reverse_type: design\nagent_slots:\n  - role: tl\n    slot_label: "TL - fixture"\ndependencies:\n  parent: null\n  requires: []\n  blocks: []\n---\n\n## body\n`,
      },
    ];

    const violations = analyzePlanGovernance(docs).violations.filter(
      (v) => v.reason === "missing_required_agent_role",
    );

    expect(violations.map((v) => v.detail)).toEqual([
      "poc:aim",
      "recovery:aim",
      "troubleshoot:aim",
      "reverse:R3:po",
    ]);
  });

  it("U-PLANGOV-011l: mandatory role gate passes with required roles and spares legacy debt", () => {
    const docs = [
      {
        file: "docs/plans/PLAN-DISCOVERY-198-poc-role-ok.md",
        content: `---\nplan_id: PLAN-DISCOVERY-198-poc-role-ok\ntitle: "PLAN-DISCOVERY-198: poc role ok"\nkind: poc\nlayer: cross\ndrive: fullstack\nstatus: confirmed\ncreated: 2026-06-23\nupdated: 2026-06-23\nworkflow_phase: S2\nagent_slots:\n  - role: aim\n    slot_label: "AIM - fixture"\ndependencies:\n  parent: null\n  requires: []\n  blocks: []\n---\n\n## body\n`,
      },
      {
        file: "docs/plans/PLAN-REVERSE-198-r3-role-ok.md",
        content: `---\nplan_id: PLAN-REVERSE-198-r3-role-ok\ntitle: "PLAN-REVERSE-198: R3 role ok"\nkind: reverse\nlayer: cross\ndrive: fullstack\nstatus: confirmed\ncreated: 2026-06-23\nupdated: 2026-06-23\nworkflow_phase: R3\nconfirmed_reverse_type: design\nagent_slots:\n  - role: po\n    slot_label: "PO - fixture"\ndependencies:\n  parent: null\n  requires: []\n  blocks: []\n---\n\n## body\n`,
      },
      {
        file: "docs/plans/PLAN-DISCOVERY-198-legacy-poc-role.md",
        content: `---\nplan_id: PLAN-DISCOVERY-198-legacy-poc-role\ntitle: "PLAN-DISCOVERY-198: legacy poc role"\nkind: poc\nlayer: cross\ndrive: fullstack\nstatus: confirmed\ncreated: 2026-06-22\nupdated: 2026-06-22\nworkflow_phase: S2\nagent_slots:\n  - role: tl\n    slot_label: "TL - fixture"\ndependencies:\n  parent: null\n  requires: []\n  blocks: []\n---\n\n## body\n`,
      },
    ];

    const reasons = analyzePlanGovernance(docs).violations.map((v) => v.reason);

    expect(reasons).not.toContain("missing_required_agent_role");
  });

  it("U-PLANGOV-011m: new PLANs must use kind-compatible authoring layers", () => {
    const docs = [
      planDoc("PLAN-L12-198-design-right-arm", {
        kind: "design",
        layer: "L12",
        subDoc: null,
        extra: "created: 2026-06-23\nupdated: 2026-06-23\n",
      }),
      planDoc("PLAN-L6-198-troubleshoot-left-arm", {
        kind: "troubleshoot",
        layer: "L6",
        subDoc: null,
        extra: "created: 2026-06-23\nupdated: 2026-06-23\n",
      }),
      planDoc("PLAN-L7-198-add-design-runtime", {
        kind: "add-design",
        layer: "L7",
        subDoc: null,
        extra: "created: 2026-06-23\nupdated: 2026-06-23\n",
      }),
      planDoc("PLAN-L6-198-add-impl-design", {
        kind: "add-impl",
        layer: "L6",
        subDoc: null,
        extra: "created: 2026-06-23\nupdated: 2026-06-23\n",
      }),
      planDoc("PLAN-L7-198-research-runtime", {
        kind: "research",
        layer: "L7",
        subDoc: null,
        extra: "created: 2026-06-23\nupdated: 2026-06-23\n",
      }),
      planDoc("PLAN-L7-198-verify-left-arm", {
        kind: "verify",
        layer: "L7",
        subDoc: null,
        extra: "created: 2026-07-07\nupdated: 2026-07-07\n",
      }),
    ];

    const violations = analyzePlanGovernance(docs).violations.filter(
      (v) => v.reason === "kind_layer_mismatch",
    );

    expect(violations.map((v) => v.detail)).toEqual([
      "design:L12:expected_L1-L6",
      "troubleshoot:L6:expected_L7",
      "add-design:L7:expected_L3-L6",
      "add-impl:L6:expected_L7",
      "research:L7:expected_L1-L4",
      "verify:L7:expected_L8-L14",
    ]);
  });

  it("U-PLANGOV-011n: kind-compatible layers and master hubs pass", () => {
    const docs = [
      planDoc("PLAN-L4-198-design-ok", {
        kind: "design",
        layer: "L4",
        subDoc: "function",
        extra: "created: 2026-06-23\nupdated: 2026-06-23\n",
      }),
      planDoc("PLAN-L7-198-refactor-ok", {
        kind: "refactor",
        layer: "L7",
        subDoc: null,
        extra: "created: 2026-06-23\nupdated: 2026-06-23\n",
      }),
      planDoc("PLAN-L6-198-add-design-ok", {
        kind: "add-design",
        layer: "L6",
        subDoc: null,
        extra: "created: 2026-06-23\nupdated: 2026-06-23\n",
      }),
      planDoc("PLAN-L7-198-add-impl-ok", {
        kind: "add-impl",
        layer: "L7",
        subDoc: null,
        extra: "created: 2026-06-23\nupdated: 2026-06-23\n",
      }),
      planDoc("PLAN-L3-198-research-ok", {
        kind: "research",
        layer: "L3",
        subDoc: null,
        extra: "created: 2026-06-23\nupdated: 2026-06-23\n",
      }),
      planDoc("PLAN-L9-198-verify-ok", {
        kind: "verify",
        layer: "L9",
        subDoc: null,
        extra:
          "route_signal: verification_plan\nroute_mode: verify\nverification_gate: G9\ncreated: 2026-07-07\nupdated: 2026-07-07\n",
      }),
      planDoc("PLAN-M-198-master-hub", {
        kind: "design",
        layer: "L14",
        subDoc: null,
        extra: "created: 2026-06-23\nupdated: 2026-06-23\nmaster_hub: true\n",
      }),
    ];

    const reasons = analyzePlanGovernance(docs).violations.map((v) => v.reason);

    expect(reasons).not.toContain("kind_layer_mismatch");
  });

  it("U-PLANGOV-011o: version_target drafts require a version-up route certificate", () => {
    const docs = [
      planDoc("PLAN-L7-198-version-parked", {
        kind: "impl",
        layer: "L7",
        subDoc: null,
        status: "draft",
        parentDesign: "docs/design/harness/L6-function-design/function-spec.md",
        extra: "version_target: future\ncreated: 2026-06-23\nupdated: 2026-06-23\n",
      }),
    ];

    const reasons = analyzePlanGovernance(docs).violations.map((v) => v.reason);

    expect(reasons).toContain("version_route_certificate_missing");
  });

  it("U-PLANGOV-011p: version_target route certificate fails closed on signal or mode drift", () => {
    const docs = [
      planDoc("PLAN-L7-198-version-parked-wrong-route", {
        kind: "impl",
        layer: "L7",
        subDoc: null,
        status: "draft",
        parentDesign: "docs/design/harness/L6-function-design/function-spec.md",
        extra:
          "version_target: future\nroute_signal: incident\nroute_mode: recovery\ncreated: 2026-06-23\nupdated: 2026-06-23\n",
      }),
    ];

    const reasons = analyzePlanGovernance(docs).violations.map((v) => v.reason);

    expect(reasons).toContain("version_route_certificate_mismatch");
  });

  it("U-PLANGOV-011q: version_target route certificate passes with version_deferral/version-up", () => {
    const docs = [
      planDoc("PLAN-L7-198-version-parked-ok", {
        kind: "impl",
        layer: "L7",
        subDoc: null,
        status: "draft",
        parentDesign: "docs/design/harness/L6-function-design/function-spec.md",
        extra:
          "version_target: future\nroute_signal: version_deferral\nroute_mode: version-up\ncreated: 2026-06-23\nupdated: 2026-06-23\n",
      }),
    ];

    const reasons = analyzePlanGovernance(docs).violations.map((v) => v.reason);

    expect(reasons).not.toContain("version_route_certificate_missing");
    expect(reasons).not.toContain("version_route_certificate_mismatch");
  });

  it("U-PLANGOV-011r: new plans require a route certificate after the route enforcement date", () => {
    const docs = [
      planDoc("PLAN-L7-230-new-without-route", {
        kind: "impl",
        layer: "L7",
        subDoc: null,
        parentDesign: "docs/design/harness/L6-function-design/function-spec.md",
        extra: "created: 2026-07-01\nupdated: 2026-07-01\n",
      }),
    ];

    const reasons = analyzePlanGovernance(docs).violations.map((v) => v.reason);

    expect(reasons).toContain("route_certificate_missing");
  });

  it("U-PLANGOV-011s: new plan route certificate fails closed when signal and mode disagree", () => {
    const docs = [
      planDoc("PLAN-L7-231-new-route-drift", {
        kind: "impl",
        layer: "L7",
        subDoc: null,
        parentDesign: "docs/design/harness/L6-function-design/function-spec.md",
        extra:
          "route_signal: version_deferral\nroute_mode: recovery\ncreated: 2026-07-01\nupdated: 2026-07-01\n",
      }),
    ];

    const reasons = analyzePlanGovernance(docs).violations.map((v) => v.reason);

    expect(reasons).toContain("route_certificate_mismatch");
  });

  it("U-PLANGOV-011t: new plan route certificate passes when route eval maps signal to mode", () => {
    const docs = [
      planDoc("PLAN-L7-232-new-route-ok", {
        kind: "impl",
        layer: "L7",
        subDoc: null,
        parentDesign: "docs/design/harness/L6-function-design/function-spec.md",
        extra:
          "route_signal: version_deferral\nroute_mode: version-up\ncreated: 2026-07-01\nupdated: 2026-07-01\n",
      }),
    ];

    const reasons = analyzePlanGovernance(docs).violations.map((v) => v.reason);

    expect(reasons).not.toContain("route_certificate_missing");
    expect(reasons).not.toContain("route_certificate_mismatch");
  });

  it("U-PLANGOV-011u: route_mode=add-feature rejects kind=impl (route_mode_kind_mismatch)", () => {
    const docs = [
      planDoc("PLAN-L7-900-add-feature-impl", {
        kind: "impl",
        layer: "L7",
        status: "draft",
        subDoc: null,
        parentDesign: "docs/design/harness/L6-function-design/function-spec.md",
        extra: "route_mode: add-feature\n",
      }),
    ];

    const reasons = analyzePlanGovernance(docs).violations.map((v) => v.reason);

    expect(reasons).toContain("route_mode_kind_mismatch");
  });

  it("U-PLANGOV-011v: route_mode=add-feature allows kind=add-design/add-impl", () => {
    const docs = [
      planDoc("PLAN-L7-901-add-feature-add-impl", {
        kind: "add-impl",
        layer: "L7",
        status: "draft",
        subDoc: null,
        parentDesign: "docs/design/harness/L6-function-design/function-spec.md",
        extra: "route_mode: add-feature\n",
      }),
      planDoc("PLAN-L6-902-add-feature-add-design", {
        kind: "add-design",
        layer: "L6",
        status: "draft",
        subDoc: null,
        extra: "route_mode: add-feature\n",
      }),
    ];

    const reasons = analyzePlanGovernance(docs).violations.map((v) => v.reason);

    expect(reasons).not.toContain("route_mode_kind_mismatch");
  });

  it("U-PLANGOV-011v2: route_mode=verify accepts only kind=verify", () => {
    const docs = [
      planDoc("PLAN-L9-910-verify-ok", {
        kind: "verify",
        layer: "L9",
        subDoc: null,
        extra:
          "route_signal: verification_plan\nroute_mode: verify\nverification_gate: G9\ncreated: 2026-07-07\nupdated: 2026-07-07\n",
      }),
      planDoc("PLAN-L7-911-verify-wrong-kind", {
        kind: "add-impl",
        layer: "L7",
        subDoc: null,
        extra:
          "route_signal: verification_plan\nroute_mode: verify\ncreated: 2026-07-07\nupdated: 2026-07-07\n",
      }),
    ];

    const reasons = analyzePlanGovernance(docs).violations.map((v) => v.reason);

    expect(reasons).toContain("route_mode_kind_mismatch");
  });

  it("U-PLANGOV-011v3: route_mode=incident accepts troubleshoot/recovery only", () => {
    const docs = [
      planDoc("PLAN-L7-912-incident-troubleshoot-ok", {
        kind: "troubleshoot",
        layer: "L7",
        subDoc: null,
        extra:
          "route_signal: incident\nroute_mode: incident\ncreated: 2026-07-08\nupdated: 2026-07-08\n",
      }),
      planDoc("PLAN-RECOVERY-913-incident-recovery-ok", {
        kind: "recovery",
        layer: "cross",
        subDoc: null,
        extra:
          "route_signal: incident\nroute_mode: incident\ncreated: 2026-07-08\nupdated: 2026-07-08\n",
      }),
      planDoc("PLAN-L7-914-incident-wrong-kind", {
        kind: "refactor",
        layer: "L7",
        subDoc: null,
        extra:
          "route_signal: incident\nroute_mode: incident\ncreated: 2026-07-08\nupdated: 2026-07-08\n",
      }),
    ];

    const violations = analyzePlanGovernance(docs).violations;
    const okDocs = new Set([
      "docs/plans/PLAN-L7-912-incident-troubleshoot-ok.md",
      "docs/plans/PLAN-RECOVERY-913-incident-recovery-ok.md",
    ]);
    const mismatchFiles = violations
      .filter((v) => v.reason === "route_mode_kind_mismatch")
      .map((v) => v.file);

    for (const file of okDocs) expect(mismatchFiles).not.toContain(file);
    expect(mismatchFiles).toContain("docs/plans/PLAN-L7-914-incident-wrong-kind.md");
  });

  it("U-PLANGOV-011v3b: all L4 §3.1 drive route modes are registered with allowed kinds and layer bands", () => {
    const expectedKinds: Record<string, string[]> = {
      "add-feature": ["add-design", "add-impl"],
      "design-bottomup": ["add-design", "add-impl"],
      discovery: ["poc"],
      forward: ["design", "impl"],
      incident: ["troubleshoot", "recovery"],
      recovery: ["recovery"],
      redesign: ["design", "add-design"],
      refactor: ["refactor"],
      research: ["research"],
      retrofit: ["retrofit"],
      reverse: ["reverse"],
      scrum: ["poc"],
      "version-up": ["impl"],
      verify: ["verify"],
    };
    const expectedLayerBands: Record<string, string[]> = {
      "add-feature": ["L3", "L4", "L5", "L6", "L7"],
      "design-bottomup": ["L2", "L3", "L4", "L5", "L6", "L7"],
      discovery: ["cross"],
      forward: ["L1", "L2", "L3", "L4", "L5", "L6", "L7"],
      incident: ["L7", "cross"],
      recovery: ["cross"],
      redesign: ["L1", "L2", "L3", "L4", "L5", "L6"],
      refactor: ["L7"],
      research: ["L1", "L2", "L3", "L4"],
      retrofit: ["L7"],
      reverse: ["cross"],
      scrum: ["cross"],
      "version-up": ["L7"],
      verify: ["L8", "L9", "L10", "L11", "L12", "L13", "L14"],
    };

    expect(ROUTE_MODE_ALLOWED_KINDS).toEqual(expectedKinds);
    expect(ROUTE_MODE_LAYER_BANDS).toEqual(expectedLayerBands);
  });

  it("U-PLANGOV-011v3d: canonical forward design/impl route is registered, not unknown", () => {
    const docs = [
      planDoc("PLAN-L7-906-forward-impl", {
        kind: "impl",
        layer: "L7",
        subDoc: null,
        extra:
          "route_signal: forward\nroute_mode: forward\ncreated: 2026-07-31\nupdated: 2026-07-31\n",
      }),
    ];

    const violations = analyzePlanGovernance(docs).violations.filter((violation) =>
      ["route_certificate_mismatch", "route_mode_kind_mismatch"].includes(violation.reason),
    );

    expect(violations).toEqual([]);
  });

  it("U-PLANGOV-011v3c: newly registered route modes no longer fail as unknown route_mode", () => {
    const docs = [
      planDoc("PLAN-DISCOVERY-901-discovery-poc", {
        kind: "poc",
        layer: "cross",
        subDoc: null,
        extra:
          "route_signal: requirement_undefined\nroute_mode: discovery\ncreated: 2026-07-09\nupdated: 2026-07-09\n",
      }),
      planDoc("PLAN-DISCOVERY-902-scrum-poc", {
        kind: "poc",
        layer: "cross",
        subDoc: null,
        extra:
          "route_signal: user_feedback_iteration\nroute_mode: scrum\ncreated: 2026-07-09\nupdated: 2026-07-09\n",
      }),
      planDoc("PLAN-L7-903-retrofit-ok", {
        kind: "retrofit",
        layer: "L7",
        subDoc: null,
        extra:
          "route_signal: upgrade\nroute_mode: retrofit\ncreated: 2026-07-09\nupdated: 2026-07-09\n",
      }),
      planDoc("PLAN-L4-904-research-ok", {
        kind: "research",
        layer: "L4",
        subDoc: null,
        extra:
          "route_signal: adr_required\nroute_mode: research\ncreated: 2026-07-09\nupdated: 2026-07-09\n",
      }),
      planDoc("PLAN-L2-905-design-bottomup-ok", {
        kind: "add-design",
        layer: "L2",
        subDoc: null,
        extra:
          "route_signal: design_bottomup\nroute_mode: design-bottomup\ncreated: 2026-07-09\nupdated: 2026-07-09\n",
      }),
    ];

    const details = analyzePlanGovernance(docs)
      .violations.filter((v) => v.reason === "route_mode_kind_mismatch")
      .map((v) => v.detail ?? "");

    expect(details.some((detail) => detail.includes("unknown route_mode="))).toBe(false);
  });

  it("U-PLANGOV-011v4: route_mode layer band rejects mismatched V-model layers", () => {
    const docs = [
      planDoc("PLAN-L9-915-verify-layer-ok", {
        kind: "verify",
        layer: "L9",
        subDoc: null,
        extra:
          "route_signal: verification_plan\nroute_mode: verify\nverification_gate: G9\ncreated: 2026-07-08\nupdated: 2026-07-08\n",
      }),
      planDoc("PLAN-L7-916-verify-layer-wrong", {
        kind: "verify",
        layer: "L7",
        subDoc: null,
        extra:
          "route_signal: verification_plan\nroute_mode: verify\ncreated: 2026-07-08\nupdated: 2026-07-08\n",
      }),
      planDoc("PLAN-L2-917-add-feature-layer-wrong", {
        kind: "add-design",
        layer: "L2",
        status: "draft",
        subDoc: null,
        extra:
          "route_signal: feature_addition\nroute_mode: add-feature\ncreated: 2026-07-08\nupdated: 2026-07-08\n",
      }),
    ];

    const mismatchFiles = analyzePlanGovernance(docs)
      .violations.filter((v) => v.reason === "route_mode_kind_layer_mismatch")
      .map((v) => v.file);

    expect(mismatchFiles).not.toContain("docs/plans/PLAN-L9-915-verify-layer-ok.md");
    expect(mismatchFiles).toContain("docs/plans/PLAN-L7-916-verify-layer-wrong.md");
    expect(mismatchFiles).toContain("docs/plans/PLAN-L2-917-add-feature-layer-wrong.md");
  });

  it("U-PLANGOV-011v4a: version-up is parked-only and active work uses add-feature", () => {
    const docs = [
      planDoc("PLAN-L7-930-version-up-parked-ok", {
        kind: "impl",
        layer: "L7",
        status: "draft",
        subDoc: null,
        extra:
          "version_target: v2\nroute_signal: version_deferral\nroute_mode: version-up\ncreated: 2026-07-10\nupdated: 2026-07-10\n",
      }),
      planDoc("PLAN-L4-931-active-upgrade-ok", {
        kind: "add-design",
        layer: "L4",
        subDoc: "function",
        extra:
          "route_signal: feature_addition\nroute_mode: add-feature\ncreated: 2026-07-10\nupdated: 2026-07-10\n",
      }),
      planDoc("PLAN-L4-932-version-up-active-wrong", {
        kind: "add-design",
        layer: "L4",
        subDoc: "function",
        extra:
          "route_signal: version_deferral\nroute_mode: version-up\ncreated: 2026-07-10\nupdated: 2026-07-10\n",
      }),
    ];

    const violations = analyzePlanGovernance(docs).violations;
    const kindMismatches = violations
      .filter((violation) => violation.reason === "route_mode_kind_mismatch")
      .map((violation) => violation.file);
    const layerMismatches = violations
      .filter((violation) => violation.reason === "route_mode_kind_layer_mismatch")
      .map((violation) => violation.file);

    expect(kindMismatches).not.toContain("docs/plans/PLAN-L7-930-version-up-parked-ok.md");
    expect(layerMismatches).not.toContain("docs/plans/PLAN-L7-930-version-up-parked-ok.md");
    expect(kindMismatches).not.toContain("docs/plans/PLAN-L4-931-active-upgrade-ok.md");
    expect(layerMismatches).not.toContain("docs/plans/PLAN-L4-931-active-upgrade-ok.md");
    expect(kindMismatches).toContain("docs/plans/PLAN-L4-932-version-up-active-wrong.md");
    expect(layerMismatches).toContain("docs/plans/PLAN-L4-932-version-up-active-wrong.md");
  });

  it("U-PLANGOV-011v5: verify PLANs bind L8-L14 layers to matching G8-G14 verification_gate", () => {
    const docs = [
      planDoc("PLAN-L10-918-verify-gate-ok", {
        kind: "verify",
        layer: "L10",
        subDoc: null,
        extra:
          "route_signal: verification_plan\nroute_mode: verify\nverification_gate: G10\ncreated: 2026-07-09\nupdated: 2026-07-09\n",
      }),
      planDoc("PLAN-L10-919-verify-gate-missing", {
        kind: "verify",
        layer: "L10",
        subDoc: null,
        extra:
          "route_signal: verification_plan\nroute_mode: verify\ncreated: 2026-07-09\nupdated: 2026-07-09\n",
      }),
      planDoc("PLAN-L10-920-verify-gate-mismatch", {
        kind: "verify",
        layer: "L10",
        subDoc: null,
        extra:
          "route_signal: verification_plan\nroute_mode: verify\nverification_gate: G9\ncreated: 2026-07-09\nupdated: 2026-07-09\n",
      }),
      planDoc("PLAN-L7-921-nonverify-gate", {
        kind: "add-impl",
        layer: "L7",
        subDoc: null,
        parentDesign: "docs/design/harness/L6-function-design/function-spec.md",
        extra:
          "route_signal: feature_addition\nroute_mode: add-feature\nverification_gate: G8\ncreated: 2026-07-09\nupdated: 2026-07-09\n",
      }),
    ];

    const violations = analyzePlanGovernance(docs).violations;
    const missingFiles = violations
      .filter((v) => v.reason === "verify_gate_missing")
      .map((v) => v.file);
    const mismatchFiles = violations
      .filter((v) => v.reason === "verify_gate_layer_mismatch")
      .map((v) => v.file);

    expect(missingFiles).toEqual(["docs/plans/PLAN-L10-919-verify-gate-missing.md"]);
    expect(mismatchFiles).toEqual([
      "docs/plans/PLAN-L10-920-verify-gate-mismatch.md",
      "docs/plans/PLAN-L7-921-nonverify-gate.md",
    ]);
    expect(violations.map((v) => v.file)).not.toContain(
      "docs/plans/PLAN-L10-918-verify-gate-ok.md",
    );
  });

  it("U-PLANGOV-011w: draft debt is exempt while draft and fails closed on start (着手時昇格)", () => {
    const draftDebt = (status: string) =>
      planDoc("PLAN-L7-262-skill-telemetry-provenance", {
        kind: "impl",
        layer: "L7",
        status,
        subDoc: null,
        parentDesign: "docs/design/harness/L6-function-design/function-spec.md",
        extra: "route_mode: add-feature\n",
      });

    const draftReasons = analyzePlanGovernance([draftDebt("draft")]).violations.map(
      (v) => v.reason,
    );
    expect(draftReasons).not.toContain("route_mode_kind_mismatch");

    const started = analyzePlanGovernance([draftDebt("confirmed")]);
    const startedReasons = started.violations.map((v) => v.reason);
    expect(startedReasons).toContain("route_mode_kind_mismatch");
    const detail = started.violations.find((v) => v.reason === "route_mode_kind_mismatch")?.detail;
    expect(detail).toContain("docs/governance/route-mode-kind-debt-audit-2026-07-02.md");
    expect(detail).toContain("docs/plans/PLAN-L7-263-route-mode-kind-certificate.md");
  });

  it("U-PLANGOV-011x: DB三ループ/reverse 監査 draft PLAN 群が draft-debt allowlist に登録済み (2026-07-07)", () => {
    // 2026-07-07 DB三ループ + reverse/refactor/設計層検出 監査で起票した draft-debt intake 群。
    // route_mode=add-feature + kind=impl を draft の間だけ免除するため allowlist 台帳に固定する。
    // 着手 (draft→confirmed) 時は add-impl + Reverse pairing へ昇格しないと route_mode_kind_mismatch で
    // fail-close する (U-PLANGOV-011w と同じ契約)。
    const auditDraftPlanIds = [
      "PLAN-L7-363-routine-gate-run-projection",
      "PLAN-L7-364-reverse-stage-db-obligation",
      "PLAN-L7-365-harness-db-currency-hook",
      "PLAN-L7-366-takeover-surface-warn-actionable",
      "PLAN-L7-367-refactor-candidate-lifecycle",
      "PLAN-L7-368-design-lint-db-projection",
    ];
    for (const planId of auditDraftPlanIds) {
      expect(ROUTE_MODE_KIND_DRAFT_DEBT_PLAN_IDS.has(planId)).toBe(true);
    }
  });

  it("U-PLANGOV-011x: legacy landed debt is permanently exempt", () => {
    const docs = [
      planDoc("PLAN-L7-212-route-certificate-governance", {
        kind: "impl",
        layer: "L7",
        status: "confirmed",
        subDoc: null,
        parentDesign: "docs/design/harness/L6-function-design/function-spec.md",
        extra: "route_mode: add-feature\n",
      }),
    ];

    const reasons = analyzePlanGovernance(docs).violations.map((v) => v.reason);

    expect(reasons).not.toContain("route_mode_kind_mismatch");
  });

  it("U-PLANGOV-011x2: removing route_mode from a ledgered debt plan fails closed (bypass guard)", () => {
    const docs = [
      planDoc("PLAN-L7-262-skill-telemetry-provenance", {
        kind: "impl",
        layer: "L7",
        status: "draft",
        subDoc: null,
        parentDesign: "docs/design/harness/L6-function-design/function-spec.md",
      }),
    ];

    const result = analyzePlanGovernance(docs);
    const reasons = result.violations.map((v) => v.reason);

    expect(reasons).toContain("route_mode_kind_mismatch");
    expect(result.violations[0].detail).toContain(
      "docs/governance/route-mode-kind-debt-audit-2026-07-02.md",
    );
  });

  it("U-PLANGOV-011x3: unknown route_mode fails closed, not fail-open (RECOVERY-10 Stage 1 P2)", () => {
    // 従来は ROUTE_MODE_ALLOWED_KINDS 未登録 mode が `if (!allowedKinds) return []` で素通り (fail-open)。
    // Stage 1 P2 で fail-close 化: 未知 route_mode は検査漏れでなく違反として surface する。
    const docs = [
      planDoc("PLAN-L7-990-fabricated-unknown-route-mode", {
        kind: "impl",
        layer: "L7",
        status: "draft",
        subDoc: null,
        parentDesign: "docs/design/harness/L6-function-design/function-spec.md",
        extra: "route_mode: bogus-unregistered-mode\n",
      }),
    ];

    const result = analyzePlanGovernance(docs);
    const detail = result.violations.find((v) => v.reason === "route_mode_kind_mismatch")?.detail;

    expect(result.violations.map((v) => v.reason)).toContain("route_mode_kind_mismatch");
    expect(detail).toContain("unknown route_mode=bogus-unregistered-mode");
  });

  it("U-PLANGOV-011y: route_mode_kind debt ledger doc stays in sync with lint allowlists", () => {
    const ledgerPath = join(
      process.cwd(),
      "docs/governance/route-mode-kind-debt-audit-2026-07-02.md",
    );
    if (!existsSync(ledgerPath)) return;

    const ledger = readFileSync(ledgerPath, "utf8");
    const [, legacySection = "", draftSection = ""] = ledger.split(
      /## (?:legacy landed|draft debt)[^\n]*\n/,
    );
    const idsOf = (section: string) =>
      new Set(
        [...section.matchAll(/^\|\s*(PLAN-[A-Za-z0-9-]+)\s*\|([^\n]*)$/gm)]
          .filter(
            ([, planId, row]) =>
              planId !== "PLAN-L7-245-sub-doc-schema-integrity" || !row.includes("昇格済 promoted"),
          )
          .map((m) => m[1]),
      );

    expect(idsOf(legacySection)).toEqual(ROUTE_MODE_KIND_LEGACY_LANDED_PLAN_IDS);
    expect(idsOf(draftSection)).toEqual(ROUTE_MODE_KIND_DRAFT_DEBT_PLAN_IDS);
  });

  it("U-PLANGOV-011y2: parked version-up requires target and landed debt tuple is immutable", () => {
    const missingTarget = analyzePlanGovernance([
      planDoc("PLAN-L7-930-version-up-missing-target", {
        kind: "impl",
        layer: "L7",
        status: "draft",
        subDoc: null,
        extra:
          "route_signal: version_deferral\nroute_mode: version-up\ncreated: 2026-07-10\nupdated: 2026-07-10\n",
      }),
    ]);
    expect(missingTarget.violations.map((violation) => violation.reason)).toContain(
      "version_route_certificate_missing",
    );

    const legacyId = "PLAN-L7-303-digest-commit-anchor";
    const exactLegacy = analyzePlanGovernance([
      planDoc(legacyId, {
        kind: "impl",
        layer: "L7",
        status: "confirmed",
        subDoc: null,
        extra:
          "route_signal: version_deferral\nroute_mode: version-up\ncreated: 2026-07-01\nupdated: 2026-07-01\n",
      }),
    ]);
    expect(exactLegacy.violations.map((violation) => violation.reason)).not.toContain(
      "version_route_certificate_mismatch",
    );

    const changedLegacy = analyzePlanGovernance([
      planDoc(legacyId, {
        kind: "impl",
        layer: "L7",
        status: "archived",
        subDoc: null,
        extra:
          "route_signal: version_deferral\nroute_mode: version-up\ncreated: 2026-07-01\nupdated: 2026-07-10\n",
      }),
    ]);
    expect(changedLegacy.violations.map((violation) => violation.reason)).toContain(
      "version_route_certificate_mismatch",
    );
    const emptyTargetKey = analyzePlanGovernance([
      planDoc(legacyId, {
        kind: "impl",
        layer: "L7",
        status: "confirmed",
        subDoc: null,
        extra:
          "version_target:\nroute_signal: version_deferral\nroute_mode: version-up\ncreated: 2026-07-01\nupdated: 2026-07-10\n",
      }),
    ]);
    expect(emptyTargetKey.violations.map((violation) => violation.reason)).toContain(
      "version_route_certificate_mismatch",
    );
    expect(VERSION_UP_PARKING_LEGACY_LANDED_PLAN_IDS).toEqual(
      new Set(["PLAN-L7-303-digest-commit-anchor"]),
    );
    const debtLedger = readFileSync(
      join(process.cwd(), "docs/governance/version-up-route-debt-2026-07-10.md"),
      "utf8",
    );
    const ledgerIds = new Set(
      [...debtLedger.matchAll(/^\|\s*(PLAN-[A-Za-z0-9-]+)\s*\|/gm)].map((match) => match[1]),
    );
    expect(ledgerIds).toEqual(VERSION_UP_PARKING_LEGACY_LANDED_PLAN_IDS);
    const landedPlan = readFileSync(
      join(process.cwd(), "docs/plans/PLAN-L7-303-digest-commit-anchor.md"),
      "utf8",
    );
    expect(landedPlan).toMatch(/^status:\s*confirmed$/m);
    expect(landedPlan).toMatch(/^route_mode:\s*version-up$/m);
    expect(landedPlan).toMatch(/^kind:\s*impl$/m);
    expect(landedPlan).toMatch(/^layer:\s*L7$/m);
    expect(landedPlan).not.toMatch(/^version_target:/m);
  });

  it("U-PLANGOV-011z: draft PLAN code-line references surface missing paths and stale line numbers as advisory findings", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-plan-ref-fresh-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "short.ts"), "export const x = 1;\n", "utf8");
      const docs = [
        {
          file: "docs/plans/PLAN-DRAFT.md",
          content:
            "---\nplan_id: PLAN-DRAFT\nstatus: draft\n---\n\nSee src/missing.ts:1 and src/short.ts:99.\n",
        },
        {
          file: "docs/plans/PLAN-CONFIRMED.md",
          content:
            "---\nplan_id: PLAN-CONFIRMED\nstatus: confirmed\n---\n\nHistorical src/missing.ts:1 is ignored.\n",
        },
      ];

      const result = analyzePlanReferenceFreshness(docs, root);

      expect(result.ok).toBe(false);
      expect(result.checked).toBe(2);
      expect(result.findings.map((finding) => finding.reason)).toEqual([
        "reference_path_missing",
        "reference_line_out_of_range",
      ]);
      expect(result.findings.map((finding) => finding.reference)).toEqual([
        "src/missing.ts:1",
        "src/short.ts:99",
      ]);
      expect(result.findings.every((finding) => finding.file.includes("PLAN-DRAFT"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-PLANGOV-012: docs/design generated artifacts must use design_doc", () => {
    const docs = [
      planDoc("PLAN-L7-99-design-type-mismatch", {
        kind: "add-impl",
        layer: "L7",
        subDoc: null,
        generates:
          "\n  - artifact_path: docs/design/harness/L4-basic-design/function.md\n    artifact_type: markdown_doc",
      }),
    ];

    const r = analyzePlanGovernance(docs);
    const mismatch = r.violations.find((v) => v.reason === "artifact_type_mismatch");

    expect(r.violations.map((v) => v.reason)).toContain("artifact_type_mismatch");
    expect(mismatch?.detail).toContain("design_doc");
  });

  it("U-PLANGOV-013: docs/test-design generated artifacts must use test_design", () => {
    const docs = [
      planDoc("PLAN-L7-99-test-design-type-mismatch", {
        kind: "add-impl",
        layer: "L7",
        subDoc: null,
        generates:
          "\n  - artifact_path: docs/test-design/harness/L7-unit-test-design.md\n    artifact_type: markdown_doc",
      }),
    ];

    const r = analyzePlanGovernance(docs);
    const mismatch = r.violations.find((v) => v.reason === "artifact_type_mismatch");

    expect(r.violations.map((v) => v.reason)).toContain("artifact_type_mismatch");
    expect(mismatch?.detail).toContain("test_design");
  });

  it("U-PLANGOV-014: docs/plans generated artifacts remain markdown_doc", () => {
    const docs = [
      planDoc("PLAN-L7-99-plan-type-mismatch", {
        kind: "add-impl",
        layer: "L7",
        subDoc: null,
        generates:
          "\n  - artifact_path: docs/plans/PLAN-L7-99-plan-type-mismatch.md\n    artifact_type: design_doc",
      }),
    ];

    const r = analyzePlanGovernance(docs);
    const mismatch = r.violations.find((v) => v.reason === "artifact_type_mismatch");

    expect(r.violations.map((v) => v.reason)).toContain("artifact_type_mismatch");
    expect(mismatch?.detail).toContain("markdown_doc");
  });

  it("U-PLANSCH-011: active gate docs do not point to stale trace/stub commands", () => {
    const activeDocs = [
      "docs/test-design/harness/L14-operational-test-design.md",
      "docs/design/harness/L3-functional/README.md",
      "docs/test-design/harness/L12-acceptance-test-design.md",
      "docs/design/harness/L3-functional/functional-requirements.md",
      "docs/design/harness/L3-functional/roadmap.md",
    ];
    if (!activeDocs.every((p) => existsSync(join(process.cwd(), p)))) return;
    const text = activeDocs.map((p) => readFileSync(join(process.cwd(), p), "utf8")).join("\n");
    expect(text).not.toContain("ut-tdd trace --g1");
    expect(text).not.toMatch(/G3-trace.*L7 carry/);
    expect(text).not.toMatch(/plan lint.*stub/);
  });
});
