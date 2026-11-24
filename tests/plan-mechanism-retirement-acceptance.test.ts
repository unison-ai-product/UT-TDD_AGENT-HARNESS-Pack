import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkTraceGate } from "../src/doctor/process-quality.ts";
import { evaluateStaticGate } from "../src/gate/static.ts";
import { SCHEMA_VERSION } from "../src/schema/harness-db.ts";
import { missingTables, rowCounts } from "../src/state-db/migration.ts";
import {
  cleanupPlanretS7Fixtures,
  runScenario008,
  runScenario008Absent,
  runScenarioG,
  runScenarioJ,
  scanA,
  scanB,
  scanC,
  scanD,
  scanDSource,
  scanE,
  scanF,
} from "./support/planret-s7-acceptance.ts";
import {
  scanHPlanLintEntry,
  scanIImportsSource,
  scanIPlanAssetImports,
} from "./support/planret-s7-import-scan.ts";
import {
  cleanupTraceFixtures,
  copyDocsWithout,
  layerPairOk,
} from "./support/planret-s7-trace-fixture.ts";
import { headSnapshotRoot } from "./support/workspace-roots.ts";

// S7 (#1379) の統合受入 oracle 008 / 018 (L7 plan-mechanism-retirement-test-design §3)。
// S7 の source 撤去 PR はすべて merge 済み (#1798 / #1801 / #1803)。Red 段の it.fails は、すべて it に戻した。
// (h)(i)(j) は Red 段の PR で足した。契約を満たさない (j) だけ it.fails で、(h)(i) は main が既に満たすので it。Green で (j) を it に戻す。
const root = headSnapshotRoot();
afterEach(() => {
  cleanupPlanretS7Fixtures();
  cleanupTraceFixtures();
});

describe("CANDIDATE-U-PLANRET-018 S7 の静的 scan (src / scripts / .github の tracked file)", () => {
  it("CANDIDATE-U-PLANRET-018(a) PLAN 用の表の名前を含む SQL 文字列が無い", () => {
    expect(scanA(root)).toEqual([]);
  });
  it("CANDIDATE-U-PLANRET-018(b) harness-ledger.db の path が無い", () => {
    expect(scanB(root)).toEqual([]);
  });
  it("CANDIDATE-U-PLANRET-018(c) PLAN 用の表と台帳への DROP / VACUUM / DELETE が無い", () => {
    expect(scanC(root)).toEqual([]);
  });
  it("CANDIDATE-U-PLANRET-018(d) docs/plans の実在を確かめるコードが無い", () => {
    expect(scanD(root)).toEqual([]);
  });
  it("CANDIDATE-U-PLANRET-018(e) Project の item を消す GraphQL mutation が無い", () => {
    expect(scanE(root)).toEqual([]);
  });
  it("CANDIDATE-U-PLANRET-018(f) PLAN 専用の SQL 読み手と review lane receipt の書き手が無い", () => {
    expect(scanF(root)).toEqual([]);
  });
});

describe("CANDIDATE-U-PLANRET-018(d) scanner の正例と負例 (合成入力)", () => {
  const src = (...lines: string[]) =>
    ['import { existsSync, statSync } from "node:fs";', ...lines].join("\n");
  it("docs/plans を引数に直接取る実在確認を検出する", () => {
    expect(
      scanDSource("a.ts", src('export const x = existsSync(join(root, "docs/plans"));')),
    ).toEqual([2]);
  });
  it("docs/plans を初期化式に持つ変数 (関数内・module 直下) を経由する実在確認を検出する", () => {
    const local = src(
      "export function f(r: string) {",
      '  const d = join(r, "docs", "plans");',
      "  return statSync(d);",
      "}",
    );
    const top = src('const D = "docs/plans";', "export const f = () => existsSync(D);");
    expect(scanDSource("a.ts", local)).toEqual([4]);
    expect(scanDSource("a.ts", top)).toEqual([3]);
  });
  it("無関係な FS 検査と docs/plans の除外規則が同じ file にあっても hit にしない", () => {
    const s = src(
      'export const skip = (p: string) => p.startsWith("docs/plans/");',
      'export const g = () => existsSync(".git");',
    );
    expect(scanDSource("a.ts", s)).toEqual([]);
  });
  it("別の関数にある docs/plans の変数は実在確認に流れ込まない", () => {
    const s = src(
      'export const a = () => { const d = "docs/plans"; return d; };',
      "export const b = (d: string) => existsSync(d);",
    );
    expect(scanDSource("a.ts", s)).toEqual([]);
  });
  it("仮引数の d は、入れ子の関数にある同名の docs/plans 変数に結び付かない", () => {
    const s = src(
      "function f(d: string) {",
      '  function unrelated() { const d = "docs/plans"; return d; }',
      "  return existsSync(d);",
      "}",
    );
    expect(scanDSource("a.ts", s)).toEqual([]);
  });
  it("別のブロックにある docs/plans の変数は、同名の別の束縛に結び付かない", () => {
    const s = src(
      "function f() {",
      '  { const d = "docs/plans"; }',
      '  const d = ".git";',
      "  return existsSync(d);",
      "}",
    );
    expect(scanDSource("a.ts", s)).toEqual([]);
  });
  it("内側の scope の docs/plans 変数が外側の同名変数を隠し、同じ scope の実在確認を検出する", () => {
    const s = src(
      'const d = ".git";',
      "function f() {",
      '  if (true) { const d = "docs/plans"; return existsSync(d); }',
      "}",
    );
    expect(scanDSource("a.ts", s)).toEqual([4]);
  });
});

describe("CANDIDATE-U-PLANRET-018(g) 新規 DB と旧表入り DB の非 PLAN 動作", () => {
  it("CANDIDATE-U-PLANRET-018(g) text 推薦が新規 DB と旧表入り DB で同じ結果になる", () => {
    const g = runScenarioG();
    expect(g.legacyOut.recommend).toEqual(g.freshOut.recommend);
  });
  it("CANDIDATE-U-PLANRET-018(g) PLAN に依らない digest が両 DB で同じ結果になる", () => {
    const g = runScenarioG();
    expect(g.legacyOut.digest).toEqual(g.freshOut.digest);
  });
  it("CANDIDATE-U-PLANRET-018(g) 旧表の行が出力に現れない", () => {
    expect(runScenarioG().leaked).toBe(false);
  });
  it("CANDIDATE-U-PLANRET-018(g) 旧表と保存対象 12 表の DDL と行数が変わらない", () => {
    const g = runScenarioG();
    expect(g.after).toEqual(g.before);
  });
});

describe("CANDIDATE-U-PLANRET-008 登録の無い PLAN 表の保全", () => {
  it("CANDIDATE-U-PLANRET-008 migrate 2 回と rebuild の truncate で DDL と行数が変わらない", () => {
    const r = runScenario008();
    expect(r.after).toEqual(r.before);
    expect(r.after.plan_registry?.rows).toBe(3);
    expect(r.after.schedule_entries?.rows).toBe(2);
    expect(r.second.tables).toEqual(expect.arrayContaining(["plan_registry", "schedule_entries"]));
  });
  for (const table of ["plan_registry", "schedule_entries"]) {
    it(`CANDIDATE-U-PLANRET-008 rowCounts に ${table} が出ない`, () => {
      expect(Object.keys(rowCounts(runScenario008().db))).not.toContain(table);
    });
    it(`CANDIDATE-U-PLANRET-008 表の無い DB でも missingTables が ${table} を要求しない`, () => {
      expect(missingTables(runScenario008Absent())).not.toContain(table);
    });
  }
});

const TRACE_MISSING_DOC = {
  G1: "docs/design/harness/L1-requirements/business-requirements.md",
  G3: "docs/design/harness/L3-functional/business-detail.md",
} as const;

describe("CANDIDATE-U-PLANRET-018(h) G1 / G3 trace の直接経路", () => {
  for (const gate of ["G1", "G3"] as const) {
    const trace = `${gate}-trace` as const;
    const lower = trace.toLowerCase();
    it(`CANDIDATE-U-PLANRET-018(h) gate ${gate} と doctor が実 repo で ${lower} を直接動かす`, () => {
      // aggregate の passed ではなく、trace 固有の OK message で、trace の lint が実行されたことを確かめる。
      const doctor = checkTraceGate(root, trace);
      expect(doctor.ok).toBe(true);
      expect(doctor.messages.join("\n")).toContain(`${lower} - OK (`);
      const result = evaluateStaticGate({ gate, repoRoot: root });
      expect(result.applicable).toBe(true);
      expect(result.passed).toBe(true);
      expect(result.messages.join("\n")).toContain(`${lower} - OK (`);
    });
    it(`CANDIDATE-U-PLANRET-018(h) layer-pair が成立していても、trace の対象文書だけが欠けると gate ${gate} と doctor が ${lower} 固有の message で拒否する`, () => {
      const missingDoc = TRACE_MISSING_DOC[gate];
      const dir = copyDocsWithout(root, missingDoc);
      // (1) 拒否の原因が layer-pair ではないこと (layer-pair 単体は成立している)。
      expect(layerPairOk(dir, gate, gate === "G1" ? "L1" : "L3")).toBe(true);
      // (2) それでも gate 全体と doctor は trace 固有の message で拒否する。
      const missing = `${lower} - violation: required docs could not be read (Error: required doc not created: ${missingDoc}`;
      const doctor = checkTraceGate(dir, trace);
      expect(doctor.ok).toBe(false);
      expect(doctor.messages.join("\n")).toContain(missing);
      const result = evaluateStaticGate({ gate, repoRoot: dir });
      expect(result.passed).toBe(false);
      expect(result.messages.join("\n")).toContain(`${gate.toLowerCase()}-pair - OK (`);
      expect(result.messages.join("\n")).toContain(missing);
    });
  }
  it("CANDIDATE-U-PLANRET-018(h) plan lint の互換入口が無い", () => {
    expect(scanHPlanLintEntry(root)).toEqual([]);
  });
});

describe("CANDIDATE-U-PLANRET-018(i) 共用型の移し先と plan-asset 参照", () => {
  const exportsOf: [string, RegExp][] = [
    ["src/github/git-diff.ts", /export type GitChange(?![A-Za-z])/],
    ["src/lint/lint-result.ts", /export interface LintResult(?![A-Za-z])/],
    ["src/kernel/project-identity.ts", /export function loadTrackedProjectIdentity(?![A-Za-z])/],
  ];
  for (const [path, pattern] of exportsOf) {
    it(`CANDIDATE-U-PLANRET-018(i) ${path} が移し先として宣言を持つ`, () => {
      expect(readFileSync(join(root, path), "utf8")).toMatch(pattern);
    });
  }
  it("CANDIDATE-U-PLANRET-018(i) src / scripts / tests / .github に src/plan-asset/ を参照する import が無い", () => {
    expect(scanIPlanAssetImports(root)).toEqual([]);
  });
  it("CANDIDATE-U-PLANRET-018(i) scanner が静的・副作用・動的・re-export・require の各形式を検出する (合成入力)", () => {
    const cases: [string, number[]][] = [
      ['import { x } from "../src/plan-asset/x.ts";', [1]],
      ['import "../src/plan-asset/x.ts";', [1]],
      ['const m = await import("../src/plan-asset/x.ts");', [1]],
      ['export * from "./plan-asset/x.ts";', [1]],
      ['const r = require("../plan-asset/x.cjs");', [1]],
      ['type T = import("../plan-asset/x.ts").T;', [1]],
    ];
    for (const [source, hits] of cases) expect(scanIImportsSource("a.mts", source)).toEqual(hits);
  });
  it("CANDIDATE-U-PLANRET-018(i) scanner は import でない plan-asset の文字列を hit にしない (合成入力)", () => {
    const source = [
      'import { x } from "../src/other.ts";',
      'export const id = "plan-asset-not-found";',
      '// import "../src/plan-asset/x.ts";',
    ].join("\n");
    expect(scanIImportsSource("a.ts", source)).toEqual([]);
  });
});

const NO_CHECK = /required_plan_id IS NOT NULL/;
const EXPECTED_ENTRIES = [
  {
    profile_id: "PLANRET-J-A",
    doc_type_id: "DOC-L0-CHARTER",
    decision: "defer",
    required_plan_id: null,
  },
  {
    profile_id: "PLANRET-J-B",
    doc_type_id: "DOC-L0-CHARTER",
    decision: "adopt",
    required_plan_id: null,
  },
];
function expectDeferRowsProjectedWithNull(j: ReturnType<typeof runScenarioJ>) {
  expect(j.thrown).toBeNull();
  // 旧 ID 付きの source でも、書き込まれる行の required_plan_id は SQL の NULL (writer が旧値を持ち越さない)。
  expect(j.entries).toEqual(EXPECTED_ENTRIES);
  expect(j.reviewCount).toBe(2);
  // 表そのものが defer + NULL を受ける (旧 CHECK が無い)。
  expect(j.ddl).not.toMatch(NO_CHECK);
  expect(j.deferNullUpdate).toBeNull();
  // (g) の保存対象 12 表は rebuild の前後で DDL も行数も変わらない。
  expect(j.preservedAfter).toEqual(j.preservedBefore);
  // migrate の再適用は何も変えない。
  expect(j.remigrateApplied).toBe(false);
  expect(j.remigrateUnchanged).toBe(true);
}

describe("CANDIDATE-U-PLANRET-018(j) document_scale_profile_entries の defer 行 (required_plan_id=NULL)", () => {
  it("CANDIDATE-U-PLANRET-018(j) 新規 DB で defer 行を NULL で投影し、正例を保つ", () => {
    const j = runScenarioJ("fresh");
    expect(j.afterMigrate.version).toBe(SCHEMA_VERSION);
    expectDeferRowsProjectedWithNull(j);
  }, 120000);
  it("CANDIDATE-U-PLANRET-018(j) 旧 CHECK のある v29 からの migrate 後に defer 行を NULL で投影し、正例を保つ", () => {
    const j = runScenarioJ("v29");
    expect(j.before?.ddl).toMatch(NO_CHECK);
    expect(j.before?.version).toBe(29);
    expect(j.afterMigrate.applied).toBe(true);
    expect(j.afterMigrate.version).toBe(SCHEMA_VERSION);
    expect(j.afterMigrate.ddl).not.toMatch(NO_CHECK);
    expectDeferRowsProjectedWithNull(j);
  }, 120000);
  it("CANDIDATE-U-PLANRET-018(j) 旧 CHECK のある現行版 v30 からも migrate で版が上がり、defer 行を NULL で投影し、正例を保つ", () => {
    const j = runScenarioJ("v30");
    expect(j.before?.ddl).toMatch(NO_CHECK);
    expect(j.before?.version).toBe(30);
    // 既存の fromVersion < 30 の枝への追加では v30 の DB は直らない。新しい版への更新が要る。
    expect(SCHEMA_VERSION).toBeGreaterThan(30);
    expect(j.afterMigrate.applied).toBe(true);
    expect(j.afterMigrate.version).toBe(SCHEMA_VERSION);
    expect(j.afterMigrate.ddl).not.toMatch(NO_CHECK);
    expectDeferRowsProjectedWithNull(j);
  }, 120000);
});
