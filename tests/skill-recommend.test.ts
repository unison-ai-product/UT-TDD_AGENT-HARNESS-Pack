import { describe, expect, it } from "vitest";
import {
  bucketRecommendations,
  buildSkillInjectionSet,
  inferSkillInvocations,
  recommendSkillsForPlan,
  recommendSkillsForText,
  recordSkillInvocations,
  recordSkillRecommendations,
} from "../src/skill-engine/recommend.ts";
import { scoreSkillDetailed, shouldScoreSkillAsset } from "../src/skill-scoring/scoring.ts";
import { stableId } from "../src/stable-id.ts";
import { openHarnessDb } from "../src/state-db/index.ts";
import { migrate, rowCounts } from "../src/state-db/migration.ts";
import { recordProjectionEvent } from "../src/state-db/projection-writer.ts";
import {
  projectSkillEvaluations,
  projectSkillTelemetry,
} from "../src/state-db/skill-projections.ts";

describe("skill recommendation telemetry", () => {
  function seedPlan(
    db: ReturnType<typeof openHarnessDb>,
    row: {
      plan_id: string;
      kind: string;
      layer: string;
      drive: string;
      status?: string;
      route_mode?: string;
    },
  ): void {
    recordProjectionEvent(db, {
      table: "plan_registry",
      id: row.plan_id,
      row: {
        ...row,
        status: row.status ?? "confirmed",
        updated_at: "2026-06-12",
      },
    });
  }

  function seedSkill(
    db: ReturnType<typeof openHarnessDb>,
    row: {
      asset_id: string;
      trigger: string;
      capability: string;
      path?: string;
      role?: string;
      skill_type?: string;
      category?: string;
      applies_layers?: string;
      applies_drive_models?: string;
    },
  ): void {
    recordProjectionEvent(db, {
      table: "automation_assets",
      id: row.asset_id,
      row: {
        asset_id: row.asset_id,
        asset_type: "skill",
        path: row.path ?? `docs/skills/${row.asset_id.replace("skill:", "")}.yaml`,
        trigger: row.trigger,
        role: row.role ?? "",
        capability: row.capability,
        skill_type: row.skill_type ?? "test-skill",
        category: row.category ?? "",
        applies_layers: row.applies_layers ?? "L7",
        applies_drive_models: row.applies_drive_models ?? "Forward",
        drift_status: "current",
        indexed_at: "2026-06-12T00:00:00.000Z",
      },
    });
  }

  function seedInvocation(
    db: ReturnType<typeof openHarnessDb>,
    row: {
      skill_id: string;
      plan_id: string;
      id?: string;
      source: string;
      accepted?: number;
      fired_at?: string;
    },
  ): void {
    recordProjectionEvent(db, {
      table: "skill_invocations",
      id: row.id ?? `inv:${row.plan_id}:${row.skill_id}:${row.source}`,
      row: {
        skill_invocation_id: row.id ?? `inv:${row.plan_id}:${row.skill_id}:${row.source}`,
        session_id: row.source.startsWith("runtime-hook:") ? "session-runtime" : "rebuild:indirect",
        plan_id: row.plan_id,
        skill_id: row.skill_id,
        layer: "L7",
        drive: "db",
        fired_at: row.fired_at ?? "2026-06-12T00:03:00.000Z",
        source: row.source,
        accepted: row.accepted ?? 1,
      },
    });
  }

  function seedAcceptedReview(db: ReturnType<typeof openHarnessDb>, planId: string): void {
    recordProjectionEvent(db, {
      table: "review_evidence_registry",
      id: `review:${planId}`,
      row: {
        review_evidence_id: `review:${planId}`,
        plan_id: planId,
        kind: "add-impl",
        status: "confirmed",
        has_evidence: 1,
        review_kind: "intra_runtime_subagent",
        verdict: "pass",
        reviewed_at: "2026-06-12T00:01:00.000Z",
        tests_green_at: "2026-06-12T00:00:30.000Z",
        worker_model: "gpt-5.3-codex",
        reviewer_model: "gpt-5.4",
        source: `docs/plans/${planId}.md`,
        indexed_at: "2026-06-12T00:01:00.000Z",
      },
    });
  }

  it("recommends skills from plan layer/drive context and records accepted invocations", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      seedPlan(db, {
        plan_id: "PLAN-L7-99-skill-test",
        kind: "add-impl",
        layer: "L7",
        drive: "fullstack",
      });
      seedSkill(db, {
        asset_id: "skill:l7-db-review",
        trigger: "db implementation review",
        capability: "L7 db quality review checklist",
        applies_drive_models: "Add-feature",
      });
      seedAcceptedReview(db, "PLAN-L7-99-skill-test");

      const recommendations = recommendSkillsForPlan(db, "PLAN-L7-99-skill-test", {
        recordedAt: "2026-06-12T00:02:00.000Z",
      });
      recordSkillRecommendations(db, recommendations);
      const invocations = inferSkillInvocations(db, recommendations, {
        firedAt: "2026-06-12T00:03:00.000Z",
      });
      recordSkillInvocations(db, invocations);

      expect(recommendations).toHaveLength(1);
      expect(recommendations[0]).toMatchObject({
        plan_id: "PLAN-L7-99-skill-test",
        skill_id: "skill:l7-db-review",
        rank: 1,
      });
      expect(invocations).toHaveLength(1);
      expect(invocations[0]).toMatchObject({
        plan_id: "PLAN-L7-99-skill-test",
        skill_id: "skill:l7-db-review",
        accepted: 1,
      });
      expect(rowCounts(db).skill_recommendations).toBe(1);
      expect(rowCounts(db).skill_invocations).toBe(1);
    } finally {
      db.close();
    }
  });

  it("selects different top skills for different workflow layers", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      seedPlan(db, {
        plan_id: "PLAN-L3-99-skill-layer",
        kind: "design",
        layer: "L3",
        drive: "normal",
      });
      seedPlan(db, {
        plan_id: "PLAN-L7-99-skill-layer",
        kind: "add-impl",
        layer: "L7",
        drive: "fullstack",
      });
      seedSkill(db, {
        asset_id: "skill:l3-design-review",
        trigger: "L3 design review",
        capability: "L3 design quality checklist",
        applies_layers: "L3",
      });
      seedSkill(db, {
        asset_id: "skill:l7-fullstack-test",
        trigger: "L7 fullstack test",
        capability: "L7 fullstack implementation lint test",
        applies_layers: "L7",
      });

      const l3 = recommendSkillsForPlan(db, "PLAN-L3-99-skill-layer", { limit: 1 });
      const l7 = recommendSkillsForPlan(db, "PLAN-L7-99-skill-layer", { limit: 1 });

      expect(l3[0]).toMatchObject({
        plan_id: "PLAN-L3-99-skill-layer",
        skill_id: "skill:l3-design-review",
      });
      expect(l3[0].reason).toContain(
        "layer=L3; technical_drive=normal; drive_model=Forward; kind=design",
      );
      expect(l3[0].reason).toContain("skill=skill:l3-design-review");
      expect(l7[0]).toMatchObject({
        plan_id: "PLAN-L7-99-skill-layer",
        skill_id: "skill:l7-fullstack-test",
      });
      expect(l7[0].reason).toContain(
        "layer=L7; technical_drive=fullstack; drive_model=Add-feature; kind=add-impl",
      );
      expect(l7[0].reason).toContain("skill=skill:l7-fullstack-test");
    } finally {
      db.close();
    }
  });

  it("selects drive-model specific skills when layer is the same", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      seedPlan(db, {
        plan_id: "PLAN-L7-99-reverse-skill",
        kind: "add-impl",
        layer: "L7",
        drive: "reverse",
        route_mode: "reverse",
      });
      seedPlan(db, {
        plan_id: "PLAN-L7-99-scrum-skill",
        kind: "add-impl",
        layer: "L7",
        drive: "scrum",
        route_mode: "scrum",
      });
      seedSkill(db, {
        asset_id: "skill:l7-reverse-routing-review",
        trigger: "L7 reverse routing review",
        capability: "reverse R4 lint quality checklist",
        applies_drive_models: "Reverse",
      });
      seedSkill(db, {
        asset_id: "skill:l7-scrum-feedback-review",
        trigger: "L7 scrum feedback review",
        capability: "scrum sprint feedback quality checklist",
        applies_drive_models: "Scrum",
      });

      const reverse = recommendSkillsForPlan(db, "PLAN-L7-99-reverse-skill", { limit: 1 });
      const scrum = recommendSkillsForPlan(db, "PLAN-L7-99-scrum-skill", { limit: 1 });

      expect(reverse[0]).toMatchObject({
        plan_id: "PLAN-L7-99-reverse-skill",
        skill_id: "skill:l7-reverse-routing-review",
      });
      expect(reverse[0].reason).toContain(
        "layer=L7; technical_drive=reverse; drive_model=Reverse; kind=add-impl",
      );
      expect(scrum[0]).toMatchObject({
        plan_id: "PLAN-L7-99-scrum-skill",
        skill_id: "skill:l7-scrum-feedback-review",
      });
      expect(scrum[0].reason).toContain(
        "layer=L7; technical_drive=scrum; drive_model=Scrum; kind=add-impl",
      );
    } finally {
      db.close();
    }
  });

  // U-SKILL-IDX-006: de-saturate — 同一 layer+drive の skill 群が score=1 に飽和せず metadata 重なりで弁別される。
  it("de-saturates equal layer/drive skills via graduated metadata overlap", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      seedPlan(db, {
        plan_id: "PLAN-L7-99-desaturate",
        kind: "add-impl",
        layer: "L7",
        drive: "fullstack",
      });
      // 実 catalog の frontmatter 分布に寄せる: L7/Add-feature は重なるが、
      // trigger/capability は review/test/browser/adversarial で薄く分散する。
      seedSkill(db, {
        asset_id: "skill:code-review-and-quality",
        trigger: "code review quality implementation test",
        capability: "L7 add impl quality review and test substance",
        skill_type: "review",
        applies_drive_models: "Add-feature",
      });
      seedSkill(db, {
        asset_id: "skill:adversarial-review",
        trigger: "assumption challenge trace freeze review",
        capability: "judgement gate falsification review",
        skill_type: "review",
        applies_drive_models: "Add-feature",
      });
      seedSkill(db, {
        asset_id: "skill:browser-testing-and-screen-verification",
        trigger: "browser screen visual verification",
        capability: "console network accessibility screenshot",
        skill_type: "verification",
        applies_drive_models: "Add-feature",
      });

      const rows = recommendSkillsForPlan(db, "PLAN-L7-99-desaturate");
      const scores = rows.map((r) => r.score);
      // 飽和解消: 全て 1 ではなく、distinct な score に分散する (旧実装は全て 1 へ clamp)。
      expect(new Set(scores).size).toBeGreaterThan(1);
      expect(scores.every((s) => s <= 1)).toBe(true);
      // overlap の多寡で順位が付く (同点アルファベット順退化でない)。
      const byId = Object.fromEntries(rows.map((r) => [r.skill_id, r.score] as const));
      expect(byId["skill:code-review-and-quality"]).toBeGreaterThan(
        byId["skill:adversarial-review"],
      );
      expect(byId["skill:adversarial-review"]).toBeGreaterThan(
        byId["skill:browser-testing-and-screen-verification"],
      );
    } finally {
      db.close();
    }
  });

  it("excludes all-layer/all-drive review checklist assets from scoring candidates", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      seedPlan(db, {
        plan_id: "PLAN-L7-99-wildcard-boundary",
        kind: "add-impl",
        layer: "L7",
        drive: "db",
        route_mode: "add-feature",
      });
      seedSkill(db, {
        asset_id: "skill:review-checklist",
        path: "skills/review-checklist.yaml",
        trigger: "review checklist",
        capability: "quality gate review checklist",
        skill_type: "quality-gate-review",
        applies_layers: "L0,L1,L2,L3,L4,L5,L6,L7,L8,L9,L10,L11,L12,L13,L14",
        applies_drive_models:
          "Add-feature,Discovery,Forward,Incident,Recovery,Refactor,Research,Retrofit,Reverse,Scrum",
      });
      seedSkill(db, {
        asset_id: "skill:db-implementation-review",
        trigger: "db implementation add impl review",
        capability: "L7 database implementation quality test",
        skill_type: "review",
        applies_drive_models: "Add-feature",
      });

      const rows = recommendSkillsForPlan(db, "PLAN-L7-99-wildcard-boundary", { limit: 5 });

      expect(rows.map((row) => row.skill_id)).not.toContain("skill:review-checklist");
      expect(rows[0]).toMatchObject({ skill_id: "skill:db-implementation-review" });
      expect(bucketRecommendations(rows).required.map((row) => row.skill_id)).not.toContain(
        "skill:review-checklist",
      );
    } finally {
      db.close();
    }
  });

  it("excludes wildcard review checklist assets at the shared scorer boundary", () => {
    const asset = {
      asset_id: "skill:review-checklist",
      path: "skills/review-checklist.yaml",
      skill_type: "quality-gate-review",
      trigger: "review checklist",
      capability: "quality gate review checklist",
      applies_layers: "L0,L1,L2,L3,L4,L5,L6,L7,L8,L9,L10,L11,L12,L13,L14",
      applies_drive_models:
        "Add-feature,Discovery,Forward,Incident,Recovery,Refactor,Research,Retrofit,Reverse,Scrum",
    };

    expect(shouldScoreSkillAsset(asset)).toBe(false);
    expect(
      scoreSkillDetailed(
        {
          reference: "PLAN-L7-99-wildcard-boundary",
          layer: "L7",
          drive: "db",
          kind: "add-impl",
          workflowMode: "Add-feature",
        },
        asset,
      ),
    ).toMatchObject({
      score: 0,
      excluded: true,
      exclusionReason: "non-workflow-scoring-asset",
    });
  });

  it("applies learning only from runtime-provenance skill evaluations", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      seedPlan(db, {
        plan_id: "PLAN-L7-99-learning-target",
        kind: "add-impl",
        layer: "L7",
        drive: "db",
        route_mode: "add-feature",
      });
      seedPlan(db, {
        plan_id: "PLAN-L7-99-runtime-success",
        kind: "add-impl",
        layer: "L7",
        drive: "db",
        status: "completed",
        route_mode: "add-feature",
      });
      seedPlan(db, {
        plan_id: "PLAN-L7-99-auto-noise",
        kind: "add-impl",
        layer: "L7",
        drive: "db",
        status: "completed",
        route_mode: "add-feature",
      });
      for (const skillId of ["skill:runtime-learned", "skill:auto-noise"]) {
        seedSkill(db, {
          asset_id: skillId,
          trigger: "db implementation add impl review",
          capability: "L7 database implementation quality test",
          skill_type: "review",
          applies_drive_models: "Add-feature",
        });
      }
      seedInvocation(db, {
        skill_id: "skill:runtime-learned",
        plan_id: "PLAN-L7-99-runtime-success",
        source: "runtime-hook:skill-suggest",
      });
      seedInvocation(db, {
        skill_id: "skill:auto-noise",
        plan_id: "PLAN-L7-99-auto-noise",
        source: "auto-projection:review-evidence",
      });

      projectSkillEvaluations({
        db,
        opts: { asOf: "2026-06-12T00:04:00.000Z" },
        deps: {
          nowIso: () => "2026-06-12T00:04:00.000Z",
          recordProjectionEvent,
        },
      });

      const evalRows = db
        .prepare("SELECT skill_id FROM skill_evaluations ORDER BY skill_id")
        .all() as { skill_id: string }[];
      expect(evalRows.map((row) => row.skill_id)).toEqual(["skill:runtime-learned"]);

      const rows = recommendSkillsForPlan(db, "PLAN-L7-99-learning-target", { limit: 2 });
      const byId = Object.fromEntries(rows.map((row) => [row.skill_id, row] as const));
      expect(byId["skill:runtime-learned"].score).toBeGreaterThan(byId["skill:auto-noise"].score);
      expect(byId["skill:runtime-learned"].reason).toContain("learning=0.");
      expect(byId["skill:auto-noise"].reason).toContain("learning=neutral");
    } finally {
      db.close();
    }
  });

  it("keeps CLI recommendation and DB projection ranking on the same scorer", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      const planId = "PLAN-L7-99-shared-score";
      seedPlan(db, {
        plan_id: planId,
        kind: "add-impl",
        layer: "L7",
        drive: "db",
        route_mode: "add-feature",
      });
      seedSkill(db, {
        asset_id: "skill:db-implementation-review",
        trigger: "db implementation add impl review",
        capability: "L7 database implementation quality test",
        skill_type: "review",
        applies_drive_models: "Add-feature",
      });
      seedSkill(db, {
        asset_id: "skill:generic-quality",
        trigger: "quality review",
        capability: "general quality checklist",
        skill_type: "review",
        applies_drive_models: "Add-feature",
      });

      const cliRows = recommendSkillsForPlan(db, planId, { limit: 2 });
      projectSkillTelemetry({
        db,
        plans: new Map([
          [
            planId,
            {
              planId,
              kind: "add-impl",
              layer: "L7",
              drive: "db",
              status: "confirmed",
              updatedAt: "2026-06-12T00:00:00.000Z",
            },
          ],
        ]),
        deps: {
          nowIso: () => "2026-06-12T00:05:00.000Z",
          stableId,
          recordProjectionEvent,
          skillDriveModelForPlan: () => "Add-feature",
        },
      });
      const projectionRows = db
        .prepare(
          "SELECT skill_id, score FROM skill_recommendations WHERE plan_id = ? ORDER BY rank",
        )
        .all(planId) as { skill_id: string; score: number }[];

      expect(projectionRows.map((row) => [row.skill_id, row.score])).toEqual(
        cliRows.map((row) => [row.skill_id, row.score]),
      );
    } finally {
      db.close();
    }
  });

  // U-SKILL-IDX-007: domain situation-pull — L/駆動を持たない domain skill が task の domain 一致で浮上する。
  it("surfaces a domain skill (no layers/drive) when the task matches its metadata", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      // domain skill: L/駆動なし + category=domain。trigger に domain tag が畳み込まれている想定。
      seedSkill(db, {
        asset_id: "skill:writing-domain",
        trigger: "writing documentation style guide",
        capability: "writing documentation style guide quality",
        category: "domain",
        applies_layers: "",
        applies_drive_models: "",
      });
      // control: domain と無関係 + 駆動も非 Forward (text path で浮上しない)。
      seedSkill(db, {
        asset_id: "skill:control-scrum",
        trigger: "scrum sprint planning",
        capability: "scrum backlog",
        applies_layers: "",
        applies_drive_models: "Scrum",
      });

      const rows = recommendSkillsForText(
        db,
        "improve the writing and documentation style of the guide",
        { limit: 5 },
      );
      const byId = Object.fromEntries(rows.map((r) => [r.skill_id, r.score] as const));
      expect(rows[0].skill_id).toBe("skill:writing-domain");
      // situation-pull: metadata 重なり + category ヒットで base(0.15) を確実に超える。
      expect(byId["skill:writing-domain"]).toBeGreaterThan(0.15);
      expect(byId["skill:writing-domain"]).toBeGreaterThan(byId["skill:control-scrum"]);
    } finally {
      db.close();
    }
  });

  // A-138 ITEM-2: --text additive surface (flat ranked list, --plan 不要)。
  it("recommendSkillsForText: 自由文を classify して flat ranked list を返す (PLAN 未登録不要)", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      // PLAN は一切 seed しない — text path は plan_registry を引かない。
      seedSkill(db, {
        asset_id: "skill:reverse-routing-review",
        trigger: "reverse routing review",
        capability: "reverse back-fill lint quality checklist",
        applies_drive_models: "Reverse",
      });
      seedSkill(db, {
        asset_id: "skill:scrum-feedback",
        trigger: "scrum sprint feedback",
        capability: "scrum sprint feedback checklist",
        applies_drive_models: "Scrum",
      });

      const rows = recommendSkillsForText(db, "reverse back-fill the L3 requirements as-is", {
        recordedAt: "2026-06-19T00:00:00.000Z",
        limit: 1,
      });
      expect(rows).toHaveLength(1);
      // kind=reverse → drive_model=Reverse なので reverse skill が上位、reference=text:<slug>。
      expect(rows[0]).toMatchObject({ skill_id: "skill:reverse-routing-review", rank: 1 });
      expect(rows[0].plan_id).toMatch(/^text:/);
      expect(rows[0].reason).toContain("source=text");
      expect(rows[0].reason).toContain("drive_model=Reverse");
    } finally {
      db.close();
    }
  });

  it("recommendSkillsForText: risk 語を含む自由文は reason に risk フラグを載せる", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      seedSkill(db, {
        asset_id: "skill:review-checklist",
        trigger: "review checklist",
        capability: "quality review checklist",
      });
      const rows = recommendSkillsForText(db, "implement production payment migration", {
        limit: 1,
      });
      expect(rows[0].reason).toMatch(/risk=.*payment/);
    } finally {
      db.close();
    }
  });

  // A-138 ITEM-2 PO 残課題: 3-bucket 出力 (TL 素案を PO 承認、score band で分類)。
  it("bucketRecommendations: score band で required/recommended/optional に分類", () => {
    const mk = (skill_id: string, score: number) => ({
      skill_recommendation_id: skill_id,
      session_id: "",
      plan_id: "P",
      skill_id,
      rank: 1,
      score,
      reason: "",
      recommended_at: "",
    });
    const buckets = bucketRecommendations([
      mk("hi", 0.9),
      mk("edge-req", 0.8),
      mk("mid", 0.6),
      mk("edge-rec", 0.5),
      mk("low", 0.3),
    ]);
    expect(buckets.required.map((r) => r.skill_id)).toEqual(["hi", "edge-req"]);
    expect(buckets.recommended.map((r) => r.skill_id)).toEqual(["mid", "edge-rec"]);
    expect(buckets.optional.map((r) => r.skill_id)).toEqual(["low"]);
  });

  it("buildSkillInjectionSet: provider context manifest returns scoped skill paths", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      seedSkill(db, {
        asset_id: "skill:must-load",
        trigger: "required skill",
        capability: "quality review checklist",
      });
      seedSkill(db, {
        asset_id: "skill:on-demand",
        trigger: "optional skill",
        capability: "supporting notes",
        applies_layers: "",
        applies_drive_models: "",
      });
      const recommendations = [
        {
          skill_recommendation_id: "rec:must-load",
          session_id: "",
          plan_id: "PLAN-L7-99-inject",
          skill_id: "skill:must-load",
          rank: 1,
          score: 0.9,
          reason: "layer=L7; drive_model=Forward",
          recommended_at: "2026-06-23T00:00:00.000Z",
        },
        {
          skill_recommendation_id: "rec:on-demand",
          session_id: "",
          plan_id: "PLAN-L7-99-inject",
          skill_id: "skill:on-demand",
          rank: 2,
          score: 0.3,
          reason: "layer=L7; drive_model=Forward",
          recommended_at: "2026-06-23T00:00:00.000Z",
        },
        {
          skill_recommendation_id: "rec:missing",
          session_id: "",
          plan_id: "PLAN-L7-99-inject",
          skill_id: "skill:missing",
          rank: 3,
          score: 0.9,
          reason: "missing catalog row",
          recommended_at: "2026-06-23T00:00:00.000Z",
        },
      ];

      const injection = buildSkillInjectionSet(db, recommendations, {
        generatedAt: "2026-06-23T00:01:00.000Z",
      });

      expect(injection).toMatchObject({
        plan_id: "PLAN-L7-99-inject",
        generated_at: "2026-06-23T00:01:00.000Z",
        required_paths: ["docs/skills/must-load.yaml"],
        optional_paths: ["docs/skills/on-demand.yaml"],
        missing_skill_ids: ["skill:missing"],
      });
      expect(injection.entries).toEqual([
        expect.objectContaining({
          skill_id: "skill:must-load",
          tier: "required",
          inject_at: "before_work",
          skill_path: "docs/skills/must-load.yaml",
        }),
        expect.objectContaining({
          skill_id: "skill:on-demand",
          tier: "optional",
          inject_at: "on_demand",
          skill_path: "docs/skills/on-demand.yaml",
        }),
      ]);
    } finally {
      db.close();
    }
  });

  it("records recommendations but does not auto-register invocations before review evidence exists", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      seedPlan(db, {
        plan_id: "PLAN-L7-99-skill-pending-review",
        kind: "add-impl",
        layer: "L7",
        drive: "fullstack",
      });
      seedSkill(db, {
        asset_id: "skill:l7-fullstack-test",
        trigger: "L7 fullstack test",
        capability: "L7 fullstack implementation lint test",
      });

      const recommendations = recommendSkillsForPlan(db, "PLAN-L7-99-skill-pending-review");
      recordSkillRecommendations(db, recommendations);
      const invocations = inferSkillInvocations(db, recommendations);
      recordSkillInvocations(db, invocations);

      expect(recommendations).toHaveLength(1);
      expect(invocations).toEqual([]);
      expect(rowCounts(db).skill_recommendations).toBe(1);
      expect(rowCounts(db).skill_invocations).toBe(0);
    } finally {
      db.close();
    }
  });
});
