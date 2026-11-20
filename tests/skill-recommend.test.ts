import { describe, expect, it } from "vitest";
import {
  bucketRecommendations,
  buildSkillInjectionSet,
  recommendSkillsForText,
} from "../src/skill-engine/recommend.ts";
import { scoreSkillDetailed, shouldScoreSkillAsset } from "../src/skill-scoring/scoring.ts";
import { openHarnessDb } from "../src/state-db/index.ts";
import { migrate, rowCounts } from "../src/state-db/migration.ts";
import { recordProjectionEvent } from "../src/state-db/projection-writer.ts";
import { projectSkillEvaluations } from "../src/state-db/skill-projections.ts";

describe("skill recommendation telemetry", () => {
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
      plan_id: string | null;
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

  // U-SKILL-IDX-006: de-saturate — 同一 layer+drive の skill 群が score=1 に飽和せず metadata 重なりで弁別される。
  it("de-saturates equal layer/drive skills via graduated metadata overlap", () => {
    const context = {
      reference: "text:desaturate",
      layer: "L7",
      drive: "fullstack",
      kind: "add-impl",
      workflowMode: "Add-feature",
    };
    const assets = [
      {
        asset_id: "skill:code-review-and-quality",
        trigger: "code review quality implementation test",
        capability: "L7 add impl quality review and test substance",
        skill_type: "review",
      },
      {
        asset_id: "skill:adversarial-review",
        trigger: "assumption challenge trace freeze review",
        capability: "judgement gate falsification review",
        skill_type: "review",
      },
      {
        asset_id: "skill:browser-testing-and-screen-verification",
        trigger: "browser screen visual verification",
        capability: "console network accessibility screenshot",
        skill_type: "verification",
      },
    ];
    const scoreAssets = () =>
      assets.map(
        (asset) =>
          scoreSkillDetailed(context, {
            ...asset,
            applies_layers: "L7",
            applies_drive_models: "Add-feature",
          }).score,
      );

    const scores = scoreAssets();
    expect(scores).toEqual(scoreAssets());
    expect(scores.every((score) => score <= 1)).toBe(true);
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[1]).toBeGreaterThan(scores[2]);
  });

  it("excludes all-layer/all-drive review checklist assets from scoring candidates", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
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

      const rows = recommendSkillsForText(db, "implement database quality review and tests", {
        limit: 5,
      });

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
          reference: "text:review-checklist",
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

  it("projects skill evaluations only for runtime-provenance invocations and applies no PLAN-derived learning", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
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
        plan_id: null,
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

      const rows = recommendSkillsForText(db, "implement database quality review and tests", {
        limit: 2,
      });
      const byId = Object.fromEntries(rows.map((row) => [row.skill_id, row] as const));
      expect(byId["skill:runtime-learned"].score).toBe(byId["skill:auto-noise"].score);
      expect(byId["skill:runtime-learned"].reason).toContain("learning=neutral");
      expect(byId["skill:auto-noise"].reason).toContain("learning=neutral");
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
      expect(rowCounts(db).skill_recommendations).toBe(0);
      expect(rowCounts(db).skill_invocations).toBe(0);
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
});
