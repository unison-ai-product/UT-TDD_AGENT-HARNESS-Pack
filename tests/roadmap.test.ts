// PLAN-DISCOVERY-05 (poc spike): 工程表 (gated layer-decomposition roadmap) 登録機構の TDD Red→Green。
// 検証: roadmap zod schema / 構造整合 (gate 参照・順序) / frontmatter 抽出 / span 実在 / gate 進捗。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeProgramCoverage,
  checkSpanExistence,
  computeGateProgress,
  computeProgramRollup,
  extractRoadmap,
  loadRoadmaps,
  PARKED_BANDS,
  PROGRAM_BANDS,
  parseRoadmap,
  programCoverageMessages,
  type RoadmapRecord,
} from "../src/lint/roadmap-registry";
import { roadmapSchema, validateRoadmapStructure } from "../src/schema/roadmap";

/** test 用 RoadmapRecord factory (layer だけ可変、gates/spans は最小)。 */
function record(planId: string, layer: string): RoadmapRecord {
  return {
    planId,
    file: `docs/plans/${planId}.md`,
    roadmap: { layer, gates: [{ id: "G", name: "g", exit_criteria: "x" }], spans: [] },
    errors: [],
  };
}

const VALID_ROADMAP = {
  layer: "L7",
  gates: [
    { id: "G-L7.A", name: "orphan guard", exit_criteria: "impl-plan-trace green + orphan 0" },
    {
      id: "G-L7.B",
      name: "substance lint",
      exit_criteria: "tracked⊆canonical + oracle⇔test green",
    },
  ],
  spans: [
    { plan_id: "PLAN-REVERSE-40-orphan-governance", after_gate: "entry", before_gate: "G-L7.A" },
    { plan_id: "PLAN-REVERSE-41-substance-lints", after_gate: "G-L7.A", before_gate: "G-L7.B" },
  ],
};

function loadPlanStatuses(repoRoot: string): Map<string, string> {
  const planDir = join(repoRoot, "docs", "plans");
  const statuses = new Map<string, string>();

  for (const name of readdirSync(planDir)) {
    if (!name.endsWith(".md")) continue;
    const content = readFileSync(join(planDir, name), "utf8");
    const planId = content.match(/^plan_id:\s*(.+)$/m)?.[1]?.trim();
    const status = content.match(/^status:\s*(.+)$/m)?.[1]?.trim();
    if (planId && status) statuses.set(planId, status);
  }

  return statuses;
}

describe("roadmapSchema (U-ROADMAP-001/002)", () => {
  it("U-ROADMAP-001: 正規 roadmap を parse する", () => {
    const parsed = roadmapSchema.safeParse(VALID_ROADMAP);
    expect(parsed.success).toBe(true);
  });

  it("U-ROADMAP-002: gates 空は reject (層分解の体をなさない)", () => {
    const parsed = roadmapSchema.safeParse({ ...VALID_ROADMAP, gates: [] });
    expect(parsed.success).toBe(false);
  });
});

describe("roadmap park / program rollup (U-ROADMAP-019..022)", () => {
  it("U-ROADMAP-019: PARKED_BANDS の未登録 band は parked に入り / covered band は park 指定でも covered 優先", () => {
    // fixture 注入で実 fs (loadRoadmaps) 非依存にする (cwd 変動で偽 PASS/FAIL を出さない、substance 担保)。
    // impl(L7) のみ登録。verification/cutover は未登録 → park 指定で parked へ。
    // impl も parkedBandIds に含めるが covered なので parked にならない (covered 優先 = 二重計上なし)。
    const records = [record("PLAN-L7-44-harness-db-master", "L7")];
    const parked = new Set([...PARKED_BANDS.keys(), "impl"]);
    const result = analyzeProgramCoverage(records, parked);
    const parkedIds = result.parked.map((c) => c.band.id);
    const uncoveredIds = result.uncovered.map((c) => c.band.id);
    const coveredIds = result.coverage.filter((c) => c.covered).map((c) => c.band.id);
    // 未登録 park band は parked に分類され uncovered に出ない
    expect(parkedIds).toContain("verification");
    expect(parkedIds).toContain("cutover");
    expect(uncoveredIds).not.toContain("verification");
    expect(uncoveredIds).not.toContain("cutover");
    // covered な impl は park 指定でも parked に入らない (covered 優先)
    expect(coveredIds).toContain("impl");
    expect(parkedIds).not.toContain("impl");
    // 不変条件: covered + parked + uncovered = 全 band (二重計上なし)
    expect(coveredIds.length + result.parked.length + result.uncovered.length).toBe(
      PROGRAM_BANDS.length,
    );
  });

  it("U-ROADMAP-020: programCoverageMessages は uncovered=0 でも parked band と reason を surface する", () => {
    const result = analyzeProgramCoverage(
      [
        record("PLAN-L3-00-master", "L3"),
        record("PLAN-L4-00-master", "L4"),
        record("PLAN-L7-44-harness-db-master", "L7"),
      ],
      new Set(PARKED_BANDS.keys()),
    );
    const message = programCoverageMessages(result)[0];
    const verificationReason = PARKED_BANDS.get("verification");
    const cutoverReason = PARKED_BANDS.get("cutover");
    expect(message).toContain("登録 3 / park 2");
    expect(message).toContain("verification:");
    expect(verificationReason).toBeDefined();
    expect(message).toContain(String(verificationReason));
    expect(message).toContain("cutover:");
    expect(cutoverReason).toBeDefined();
    expect(message).toContain(String(cutoverReason));
  });

  it("U-ROADMAP-021: parkedBandIds に含めない未登録 band は uncovered に残る", () => {
    const result = analyzeProgramCoverage(
      [
        record("PLAN-L3-00-master", "L3"),
        record("PLAN-L4-00-master", "L4"),
        record("PLAN-L7-44-harness-db-master", "L7"),
      ],
      new Set(["verification"]),
    );
    expect(result.parked.map((c) => c.band.id)).toEqual(["verification"]);
    expect(result.uncovered.map((c) => c.band.id)).toEqual(["cutover"]);
  });

  it("U-ROADMAP-022: computeProgramRollup は band 合計不変条件と pending frontier を返す", () => {
    const records: RoadmapRecord[] = [
      {
        planId: "PLAN-UP",
        file: "docs/plans/PLAN-UP.md",
        roadmap: {
          layer: "L3",
          gates: [{ id: "G-UP", name: "up", exit_criteria: "x" }],
          spans: [{ plan_id: "PLAN-UP-1", after_gate: "entry", before_gate: "G-UP" }],
        },
        errors: [],
      },
      {
        planId: "PLAN-IMPL",
        file: "docs/plans/PLAN-IMPL.md",
        roadmap: {
          layer: "L7",
          gates: [{ id: "G-IMPL", name: "impl", exit_criteria: "x" }],
          spans: [{ plan_id: "PLAN-IMPL-1", after_gate: "entry", before_gate: "G-IMPL" }],
        },
        errors: [],
      },
    ];
    const rollup = computeProgramRollup(
      records,
      (planId) => (planId === "PLAN-UP-1" ? "confirmed" : "draft"),
      new Set(["verification"]),
    );

    expect(rollup.coveredBands + rollup.parkedBands + rollup.uncoveredBands).toBe(
      rollup.totalBands,
    );
    expect(rollup.totalBands).toBe(PROGRAM_BANDS.length);
    expect(rollup.totalGates).toBe(2);
    expect(rollup.reachedGates).toBe(1);
    expect(rollup.totalSpans).toBe(2);
    expect(rollup.confirmedSpans).toBe(1);
    expect(rollup.frontier).toEqual(["design", "cutover", "PLAN-IMPL"]);
    expect(rollup.perBand).toEqual([
      {
        bandId: "upstream",
        name: PROGRAM_BANDS[0]?.name,
        status: "covered",
        roadmaps: ["PLAN-UP"],
      },
      {
        bandId: "design",
        name: PROGRAM_BANDS[1]?.name,
        status: "uncovered",
        roadmaps: [],
      },
      {
        bandId: "impl",
        name: PROGRAM_BANDS[2]?.name,
        status: "covered",
        roadmaps: ["PLAN-IMPL"],
      },
      {
        bandId: "verification",
        name: PROGRAM_BANDS[3]?.name,
        status: "parked",
        roadmaps: [],
      },
      {
        bandId: "cutover",
        name: PROGRAM_BANDS[4]?.name,
        status: "uncovered",
        roadmaps: [],
      },
    ]);
  });

  it("U-ROADMAP-024: real repo verification/cutover bands are covered by PLAN-M-00/M-01", () => {
    const repoRoot = process.cwd();
    const records = loadRoadmaps(repoRoot);
    const statuses = loadPlanStatuses(repoRoot);
    const rollup = computeProgramRollup(
      records,
      (planId) => statuses.get(planId) ?? null,
      new Set(PARKED_BANDS.keys()),
    );
    const byBand = new Map(rollup.perBand.map((band) => [band.bandId, band]));

    expect(byBand.get("verification")).toMatchObject({
      status: "covered",
      roadmaps: expect.arrayContaining(["PLAN-M-00-verify-cutover"]),
    });
    expect(byBand.get("cutover")).toMatchObject({
      status: "covered",
      roadmaps: expect.arrayContaining(["PLAN-M-01-cutover-backfill"]),
    });
    expect(rollup.coveredBands).toBe(rollup.totalBands);
    expect(rollup.parkedBands).toBe(0);
    expect(rollup.uncoveredBands).toBe(0);
    expect(rollup.frontier).toEqual([]);
  });
});

describe("validateRoadmapStructure (U-ROADMAP-003/004/005)", () => {
  it("U-ROADMAP-003: 整合済 roadmap は issue 0", () => {
    expect(validateRoadmapStructure(VALID_ROADMAP)).toHaveLength(0);
  });

  it("U-ROADMAP-004: span が未知 gate を参照すると issue (件数固定)", () => {
    // before_gate のみ未知 → unknown-gate 1 件 (I-3: 件数を固定して substance 検証)
    const oneBad = {
      ...VALID_ROADMAP,
      spans: [{ plan_id: "PLAN-REVERSE-40-x", after_gate: "entry", before_gate: "G-L7.Z" }],
    };
    const one = validateRoadmapStructure(oneBad).filter((i) => i.kind === "unknown-gate");
    expect(one).toHaveLength(1);
    // after・before 両方未知 → unknown-gate 2 件
    const twoBad = {
      ...VALID_ROADMAP,
      spans: [{ plan_id: "PLAN-REVERSE-40-x", after_gate: "G-L7.Y", before_gate: "G-L7.Z" }],
    };
    const two = validateRoadmapStructure(twoBad).filter((i) => i.kind === "unknown-gate");
    expect(two).toHaveLength(2);
  });

  it("U-ROADMAP-005: before_gate が after_gate より前なら順序 issue (件数固定)", () => {
    const bad = {
      ...VALID_ROADMAP,
      spans: [{ plan_id: "PLAN-REVERSE-40-x", after_gate: "G-L7.B", before_gate: "G-L7.A" }],
    };
    expect(validateRoadmapStructure(bad).filter((i) => i.kind === "gate-order")).toHaveLength(1);
  });

  it("U-ROADMAP-011: after_gate === before_gate (同一 gate 内 span) も順序 issue", () => {
    const bad = {
      ...VALID_ROADMAP,
      spans: [{ plan_id: "PLAN-REVERSE-40-x", after_gate: "G-L7.A", before_gate: "G-L7.A" }],
    };
    expect(validateRoadmapStructure(bad).filter((i) => i.kind === "gate-order")).toHaveLength(1);
  });

  it("U-ROADMAP-012: gate id 重複は duplicate-gate", () => {
    const bad = {
      ...VALID_ROADMAP,
      gates: [...VALID_ROADMAP.gates, { id: "G-L7.A", name: "dup", exit_criteria: "x" }],
    };
    expect(validateRoadmapStructure(bad).filter((i) => i.kind === "duplicate-gate")).toHaveLength(
      1,
    );
  });
});

describe("extractRoadmap / parseRoadmap (U-ROADMAP-006/007)", () => {
  const FM = `---
plan_id: PLAN-L7-00-master
master_hub: true
roadmap:
  layer: L7
  gates:
    - id: G-L7.A
      name: orphan guard
      exit_criteria: impl-plan-trace green
  spans:
    - plan_id: PLAN-REVERSE-40-orphan-governance
      after_gate: entry
      before_gate: G-L7.A
---

# body
`;

  it("U-ROADMAP-006: master-hub frontmatter から roadmap block を抽出", () => {
    const rm = extractRoadmap(FM);
    expect(rm).not.toBeNull();
    const { roadmap, errors } = parseRoadmap(FM);
    expect(errors).toHaveLength(0);
    expect(roadmap?.layer).toBe("L7");
    expect(roadmap?.spans[0]?.plan_id).toBe("PLAN-REVERSE-40-orphan-governance");
  });

  it("U-ROADMAP-007: roadmap 不在の frontmatter は null", () => {
    expect(extractRoadmap("---\nplan_id: PLAN-L7-04\n---\nbody")).toBeNull();
  });

  it("U-ROADMAP-014: 破損 YAML frontmatter は無音スキップせず errors に surface (I-2)", () => {
    const broken =
      "---\nplan_id: PLAN-L7-00\nroadmap:\n  layer: L7\n   gates: [bad indent\n---\nbody";
    const { roadmap, errors } = parseRoadmap(broken);
    expect(roadmap).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("YAML parse error");
  });
});

describe("checkSpanExistence (U-ROADMAP-008)", () => {
  it("U-ROADMAP-008: 実在しない span.plan_id を孤児として surface", () => {
    const known = new Set(["PLAN-REVERSE-40-orphan-governance"]);
    const issues = checkSpanExistence(VALID_ROADMAP, known);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("PLAN-REVERSE-41-substance-lints");
  });

  it("U-ROADMAP-013: 全 span 実在なら孤児 0 (正常系)", () => {
    const known = new Set(["PLAN-REVERSE-40-orphan-governance", "PLAN-REVERSE-41-substance-lints"]);
    expect(checkSpanExistence(VALID_ROADMAP, known)).toHaveLength(0);
  });
});

describe("computeGateProgress (U-ROADMAP-009/010)", () => {
  it("U-ROADMAP-009: 直前 span が全 confirmed なら gate=reached", () => {
    const statusOf = (id: string) =>
      id === "PLAN-REVERSE-40-orphan-governance" ? "confirmed" : "draft";
    const progress = computeGateProgress(VALID_ROADMAP, statusOf);
    const gA = progress.find((g) => g.gateId === "G-L7.A");
    expect(gA?.reached).toBe(true);
    const gB = progress.find((g) => g.gateId === "G-L7.B");
    expect(gB?.reached).toBe(false);
  });

  it("U-ROADMAP-010: span 0 の gate は vacuous reached でなく未到達扱い", () => {
    const rmNoSpan = { ...VALID_ROADMAP, spans: [] };
    const progress = computeGateProgress(rmNoSpan, () => "confirmed");
    expect(progress.every((g) => g.reached === false)).toBe(true);
  });

  it("U-ROADMAP-023: completed は confirmed と同等に gate 到達計数へ含める", () => {
    const roadmap = {
      layer: "L7",
      gates: [{ id: "G-L7.CLOSE", name: "close", exit_criteria: "span done" }],
      spans: [{ plan_id: "PLAN-L7-CLOSE", after_gate: "entry", before_gate: "G-L7.CLOSE" }],
    };

    expect(computeGateProgress(roadmap, () => "confirmed")[0]).toMatchObject({
      confirmedSpans: 1,
      reached: true,
    });
    expect(computeGateProgress(roadmap, () => "completed")[0]).toMatchObject({
      confirmedSpans: 1,
      reached: true,
    });
    expect(computeGateProgress(roadmap, () => "draft")[0]).toMatchObject({
      confirmedSpans: 0,
      reached: false,
    });
  });
});

describe("analyzeProgramCoverage (U-ROADMAP-015〜018、全プログラム被覆)", () => {
  it("U-ROADMAP-015: roadmap.layer が band.layers に属せば当該 band を被覆", () => {
    const { coverage } = analyzeProgramCoverage([record("PLAN-L7-44", "L7")]);
    const impl = coverage.find((c) => c.band.id === "impl");
    expect(impl?.covered).toBe(true);
    expect(impl?.roadmaps).toContain("PLAN-L7-44");
  });

  it("U-ROADMAP-016: 未登録バンドは uncovered として surface (実装どこまで frontier)", () => {
    // L7 のみ登録 → impl 以外の全 band が uncovered。PROGRAM_BANDS から動的に検証し band 追加に追随。
    const { uncovered } = analyzeProgramCoverage([record("PLAN-L7-44", "L7")]);
    const ids = uncovered.map((c) => c.band.id);
    expect(ids).not.toContain("impl"); // L7 登録済 band は除外される
    expect(ids).toHaveLength(PROGRAM_BANDS.length - 1); // impl 以外すべて未登録
  });

  it("U-ROADMAP-017: park 宣言 band は uncovered から除外 (明示 defer は under-design でない)", () => {
    const parked = new Set(["upstream", "design", "verification", "cutover"]);
    const { uncovered } = analyzeProgramCoverage([record("PLAN-L7-44", "L7")], parked);
    expect(uncovered).toHaveLength(0);
  });

  it("U-ROADMAP-018: 登録 0 なら全 band uncovered、全 band 被覆なら OK メッセージ", () => {
    const none = analyzeProgramCoverage([]);
    expect(none.uncovered).toHaveLength(PROGRAM_BANDS.length);
    expect(programCoverageMessages(none)[0]).toContain("未登録");
    // 全 band を別 roadmap で被覆
    const all = analyzeProgramCoverage([
      record("p-up", "L1"),
      record("p-de", "L5"),
      record("p-im", "L7"),
      record("p-ve", "L10"),
      record("p-cu", "cutover"),
    ]);
    expect(all.uncovered).toHaveLength(0);
    expect(programCoverageMessages(all)[0]).toContain("OK");
  });
});
