import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderElicitationContext, selectElicitationContext } from "../src/elicitation/context.ts";
import { appendDesignDecision, DESIGN_DECISION_LOG_PATH } from "../src/elicitation/record.ts";
import { type HarnessDb, openHarnessDb, upsertRow } from "../src/state-db/index.ts";
import { migrate } from "../src/state-db/migration.ts";

const opened: HarnessDb[] = [];
const tempDirs: string[] = [];

function db(): HarnessDb {
  const value = openHarnessDb(":memory:");
  migrate(value);
  opened.push(value);
  return value;
}

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ut-tdd-elicit-"));
  tempDirs.push(dir);
  return dir;
}

function put(database: HarnessDb, table: string, primaryKey: string, row: Record<string, unknown>) {
  upsertRow(database, { table, primaryKey, row });
}

function seedPlan(database: HarnessDb, planId: string, layer: string) {
  put(database, "plan_registry", "plan_id", {
    plan_id: planId,
    kind: "add-impl",
    layer,
    sub_doc: "",
    drive: "agent",
    status: "draft",
    parent: "",
    route_mode: "add-feature",
    updated_at: "2026-07-13T00:00:00Z",
    decision_outcome: "",
    source_hash: "",
  });
}

function seedSchedule(database: HarnessDb, planId: string, location: string, blocked = "") {
  put(database, "schedule_entries", "schedule_entry_id", {
    schedule_entry_id: `schedule:${planId}`,
    plan_id: planId,
    current_location: location,
    rag: "yellow",
    status: "draft",
    blocked_reason: blocked,
    source_path: "docs/governance/vmodel-upgrade-schedule.md",
    predecessor_plan_ids: "",
  });
}

function seedSkillAsset(database: HarnessDb, repoRoot: string, skillId: string, layer: string) {
  const skillPath = `skills/${skillId}.md`;
  mkdirSync(join(repoRoot, "skills"), { recursive: true });
  writeFileSync(
    join(repoRoot, skillPath),
    [
      "---",
      "schema_version: skill.v1",
      `name: ${skillId}`,
      "skill_type: workflow-contract",
      "decision_points:",
      '  - when: "既定判断の分岐"',
      '    choose: "既定案を採る"',
      '    over: "POへ質問する"',
      '    because: "慣例既定があるため"',
      "---",
      "# body",
    ].join("\n"),
    "utf8",
  );
  put(database, "automation_assets", "asset_id", {
    asset_id: skillId,
    asset_type: "skill",
    path: skillPath,
    trigger: "",
    role: "",
    capability: "",
    skill_type: "workflow-contract",
    category: "",
    applies_layers: layer,
    applies_drive_models: "Forward|Add-feature",
    drift_status: "ok",
  });
}

function seedSpec(database: HarnessDb, specId: string, planId: string, layer: string) {
  put(database, "spec_defs", "spec_id", {
    spec_id: specId,
    spec_kind: "function",
    layer,
    sub_doc: "",
    owner_artifact_id: "",
    owner_path: "docs/design/harness/L6-function-design/function-spec.md",
    section_anchor: "",
    title: `spec ${specId}`,
    lifecycle_status: "active",
    plan_id: planId,
    source_path: "",
    source_hash: "",
    indexed_at: "2026-07-13T00:00:00Z",
  });
}

afterEach(() => {
  for (const database of opened.splice(0)) database.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("elicitation stage-bound context (U-ELICIT)", () => {
  it("U-ELICIT-001: resolves stage from ready schedule row when plan is omitted", () => {
    const database = db();
    const repoRoot = tempRepo();
    seedPlan(database, "PLAN-L7-901-target", "L7");
    seedSchedule(database, "PLAN-L7-901-target", "U20a: elicitation wiring");
    const ctx = selectElicitationContext(database, { repoRoot });
    expect(ctx.stage_source).toBe("schedule-current");
    expect(ctx.plan?.plan_id).toBe("PLAN-L7-901-target");
    expect(ctx.stage?.current_location).toBe("U20a: elicitation wiring");
  });

  it("U-ELICIT-002: binds skill decision_points as no-ask defaults for the plan", () => {
    const database = db();
    const repoRoot = tempRepo();
    seedPlan(database, "PLAN-L7-902-skills", "L7");
    seedSchedule(database, "PLAN-L7-902-skills", "U20b: defaults join");
    seedSkillAsset(database, repoRoot, "sample-contract", "L7");
    const ctx = selectElicitationContext(database, {
      repoRoot,
      planId: "PLAN-L7-902-skills",
    });
    expect(ctx.stage_source).toBe("plan-match");
    expect(ctx.decision_defaults).toEqual([
      {
        skill_id: "sample-contract",
        when: "既定判断の分岐",
        choose: "既定案を採る",
        over: "POへ質問する",
        because: "慣例既定があるため",
      },
    ]);
    expect(ctx.unreadable_skills).toEqual([]);
  });

  it("U-ELICIT-003: reports unreadable skill assets fail-open instead of throwing", () => {
    const database = db();
    const repoRoot = tempRepo();
    seedPlan(database, "PLAN-L7-903-missing", "L7");
    put(database, "automation_assets", "asset_id", {
      asset_id: "ghost-skill",
      asset_type: "skill",
      path: "skills/ghost-skill.md",
      trigger: "",
      role: "",
      capability: "",
      skill_type: "workflow-contract",
      category: "",
      applies_layers: "L7",
      applies_drive_models: "Forward|Add-feature",
      drift_status: "ok",
    });
    const ctx = selectElicitationContext(database, {
      repoRoot,
      planId: "PLAN-L7-903-missing",
    });
    expect(ctx.unreadable_skills).toContain("ghost-skill");
  });

  it("U-ELICIT-007: surfaces skills whose asset path is unresolved as unreadable", () => {
    const database = db();
    const repoRoot = tempRepo();
    seedPlan(database, "PLAN-L7-907-nopath", "L7");
    put(database, "automation_assets", "asset_id", {
      asset_id: "pathless-skill",
      asset_type: "skill",
      path: "",
      trigger: "",
      role: "",
      capability: "",
      skill_type: "workflow-contract",
      category: "",
      applies_layers: "L7",
      applies_drive_models: "Forward|Add-feature",
      drift_status: "ok",
    });
    const ctx = selectElicitationContext(database, {
      repoRoot,
      planId: "PLAN-L7-907-nopath",
    });
    expect(ctx.unreadable_skills).toContain("pathless-skill");
    expect(ctx.decision_defaults).toEqual([]);
  });

  it("U-ELICIT-004: joins design coverage from spec_defs by plan and layer", () => {
    const database = db();
    const repoRoot = tempRepo();
    seedPlan(database, "PLAN-L7-904-coverage", "L7");
    seedSpec(database, "SPEC-A", "PLAN-L7-904-coverage", "L6");
    seedSpec(database, "SPEC-B", "PLAN-L7-999-other", "L7");
    seedSpec(database, "SPEC-C", "PLAN-L7-999-other", "L3");
    put(database, "spec_relations", "relation_id", {
      relation_id: "REL-1",
      from_spec_id: "SPEC-A",
      to_spec_id: "SPEC-B",
      relation_kind: "verifies",
      plan_id: "",
      status: "active",
      source: "",
      evidence_path: "",
      indexed_at: "2026-07-13T00:00:00Z",
    });
    const ctx = selectElicitationContext(database, {
      repoRoot,
      planId: "PLAN-L7-904-coverage",
    });
    expect(ctx.design_coverage?.spec_count).toBe(2); // SPEC-A (plan match) + SPEC-B (layer match)
    expect(ctx.design_coverage?.relation_count).toBe(1);
    expect(ctx.design_coverage?.by_lifecycle).toEqual({ active: 2 });
  });

  it("U-ELICIT-005: render includes stage, defaults, coverage, and the ask template", () => {
    const database = db();
    const repoRoot = tempRepo();
    seedPlan(database, "PLAN-L7-905-render", "L7");
    seedSchedule(database, "PLAN-L7-905-render", "U20c: render");
    seedSkillAsset(database, repoRoot, "render-contract", "L7");
    seedSpec(database, "SPEC-R", "PLAN-L7-905-render", "L7");
    const output = renderElicitationContext(
      selectElicitationContext(database, { repoRoot, planId: "PLAN-L7-905-render" }),
    );
    expect(output).toContain("PLAN-L7-905-render U20c: render");
    expect(output).toContain("聞かずに既定で進められる判断");
    expect(output).toContain("[render-contract] 既定判断の分岐 → 既定案を採る");
    expect(output).toContain("specs=1");
    expect(output).toContain("## 設計判断依頼");
    // governance §共通ルール 1: 選択肢 2〜4 個 — 雛形は A (推奨) + B の 2 行以上を含む
    expect(output).toContain("| A (推奨) |");
    expect(output).toContain("| B |");
  });

  it("U-ELICIT-006: appendDesignDecision writes an append-only JSONL record and validates input", () => {
    const repoRoot = tempRepo();
    appendDesignDecision(repoRoot, {
      planId: "PLAN-L7-906-record",
      currentLocation: "U20d: record",
      topic: "方式選択",
      options: ["A", "B"],
      chosen: "A",
      reason: "trade-off で A が優位",
      recordedAt: "2026-07-13T00:00:00Z",
    });
    appendDesignDecision(repoRoot, {
      planId: "PLAN-L7-906-record",
      topic: "二件目",
      chosen: "B",
      reason: "追記が壊れないこと",
      recordedAt: "2026-07-13T00:01:00Z",
    });
    const lines = readFileSync(join(repoRoot, DESIGN_DECISION_LOG_PATH), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({
      plan_id: "PLAN-L7-906-record",
      current_location: "U20d: record",
      chosen: "A",
      options: ["A", "B"],
    });
    expect(() =>
      appendDesignDecision(repoRoot, {
        planId: "PLAN-L7-906-record",
        topic: "",
        chosen: "A",
        reason: "r",
      }),
    ).toThrow(/topic/);
  });
});
