import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  analyzeTestRepositoryIsolation,
  REPOSITORY_READ_CONTRACTS,
} from "../src/doctor/test-repository-isolation.ts";
import { analyzeOracleTestTrace, loadOracleTestTraceInput } from "../src/lint/oracle-test-trace.ts";
import {
  analyzePlanArtifactExistence,
  loadPlanArtifactExistenceInput,
} from "../src/lint/plan-artifact-existence.ts";

// PLAN-L6-104 §5 PR-1 / L7-memory-clean-cut-replacement-test-design §4.2。
// 削除対象の名前は実行時に組み立てる (本 file 自身が U-MEMCUT-016 の「出現 0」に数えられないため)。
const MODULE_STEM = ["project-memory", "migration"].join("-");
const MODULE_PATH = `src/runtime/${MODULE_STEM}.ts`;
const TEST_PATH = `tests/${MODULE_STEM}.test.ts`;
const SYMBOL = ["ProjectMemory", "Migration"].join("");
const WITHDRAWN_PREFIXES = ["U-PMEM" + "INV-", "U-PMEM" + "QUAR-"];
const PRODUCTION_ROOTS = ["src", "scripts", ".claude/hooks"];
const OCCURRENCE_ROOTS = ["src", "tests", "scripts"];
const INHERITED_TEST_LABELS = [
  "U-MEMWAKE-001",
  "U-MEMWAKE-002",
  "U-MEMWAKE-003",
  "U-MEMWAKE-004",
  "U-MEMWAKE-005",
  "U-MEMWAKE-006",
  "U-MEMWAKE-007",
  "U-MEMWAKE-008",
  "U-MEMWAKE-009",
  "U-PMEMROOT-001",
  "U-PMEMROOT-002",
  "U-PMEMROOT-004",
  "U-PMEMROOT-007",
  "U-PMEMROOT-008",
  "U-PMEMROOT-009",
  "U-RVATT-023",
  "U-RVATT-024",
  "U-RVATT-025",
  "U-RVWAKE-010",
];
const INHERITED = [
  "src/runtime/project-memory-root.ts",
  "src/runtime/claude-provider-envelope.ts",
  "tests/project-memory-root.test.ts",
  "tests/project-memory-pack-parity.test.ts",
  "tests/claude-memory-wake.test.ts",
];

const root = process.cwd();

function walkTs(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walkTs(p, out);
    else if (/\.(ts|mts|cts)$/.test(entry)) out.push(p);
  }
  return out;
}

/** import graph の edge のうち、指定 stem を指すものを返す (pure、mutation 負例で再利用する)。 */
function migrationImportEdges(
  files: ReadonlyArray<{ path: string; source: string }>,
  stem: string,
): string[] {
  const edges: string[] = [];
  for (const file of files) {
    for (const imported of ts.preProcessFile(file.source, true, true).importedFiles) {
      if (imported.fileName.includes(stem)) edges.push(`${file.path} -> ${imported.fileName}`);
    }
  }
  return edges;
}

function productionFiles(): Array<{ path: string; source: string }> {
  return PRODUCTION_ROOTS.flatMap((r) => walkTs(join(root, r))).map((p) => ({
    path: relative(root, p).replaceAll("\\", "/"),
    source: readFileSync(p, "utf8"),
  }));
}

describe("memory clean-cut PR-1: migration removal (U-MEMCUT-012..016)", () => {
  it("U-MEMCUT-012: production import graph has no edge to the migration module and the symbol is gone", () => {
    const files = productionFiles();
    expect(migrationImportEdges(files, MODULE_STEM)).toEqual([]);
    expect(existsSync(join(root, MODULE_PATH))).toBe(false);
    expect(files.filter((f) => f.source.includes(SYMBOL)).map((f) => f.path)).toEqual([]);
    // mutation: 任意の production module へ import を 1 行戻すと Red
    const mutated = [
      ...files,
      { path: "src/runtime/x.ts", source: `import { a } from "./${MODULE_STEM}.ts";\n` },
    ];
    expect(migrationImportEdges(mutated, MODULE_STEM)).toHaveLength(1);
  });

  it("U-MEMCUT-013: CONTRACT_ROWS no longer carries the deleted test, and a kept row would be stale", () => {
    const files = walkTs(join(root, "tests")).map((p) => ({
      path: relative(root, p).replaceAll("\\", "/"),
      source: readFileSync(p, "utf8"),
    }));
    expect(Object.keys(REPOSITORY_READ_CONTRACTS)).not.toContain(TEST_PATH);
    expect(analyzeTestRepositoryIsolation({ files }).ok).toBe(true);
    const kept = analyzeTestRepositoryIsolation({
      files,
      contracts: {
        ...REPOSITORY_READ_CONTRACTS,
        [TEST_PATH]: { mode: "isolated_fixture", calls: 1, reason: "kept" },
      },
    });
    expect(kept.messages).toContain(
      `test-repository-isolation - violation: stale-contract:${TEST_PATH}`,
    );
  });

  it("U-MEMCUT-014: the 13 withdrawn oracle declarations have no site and leaving them would orphan", () => {
    const input = loadOracleTestTraceInput(root);
    const withdrawn = (id: string) => WITHDRAWN_PREFIXES.some((p) => id.startsWith(p));
    expect((input.declarationSites ?? []).filter((s) => withdrawn(s.id))).toEqual([]);
    const r = analyzeOracleTestTrace(input);
    expect(r.orphans).toEqual([]);
    const kept = analyzeOracleTestTrace({
      ...input,
      declared: [...input.declared, `${WITHDRAWN_PREFIXES[0]}001`],
      declarationSites: [
        ...(input.declarationSites ?? []),
        {
          id: `${WITHDRAWN_PREFIXES[0]}001`,
          path: "docs/test-design/x.md",
          line: 1,
          description: "kept",
        },
      ],
    });
    expect(kept.orphans).toContain(`${WITHDRAWN_PREFIXES[0]}001`);
  });

  it("U-MEMCUT-015: PLAN-L7-512 generates has no phantom after the deletion; kept entries would be phantom", () => {
    const input = loadPlanArtifactExistenceInput(root);
    const row = input.plans.find((p) => p.planId === "PLAN-L7-512-project-scoped-memory-root");
    expect(row?.missingArtifacts ?? []).toEqual([]);
    expect(analyzePlanArtifactExistence(input).violations.map((v) => v.planId)).not.toContain(
      "PLAN-L7-512-project-scoped-memory-root",
    );
    const kept = analyzePlanArtifactExistence({
      plans: [
        {
          planId: "PLAN-L7-512-project-scoped-memory-root",
          status: "confirmed",
          missingArtifacts: [MODULE_PATH, TEST_PATH],
          hollowArtifacts: [],
        },
      ],
    });
    expect(kept.violations[0]?.missing).toEqual([MODULE_PATH, TEST_PATH]);
  });

  it("U-MEMCUT-016: inherited modules and tests remain unchanged, and the name occurs nowhere in src/tests/scripts", () => {
    // 継承 module / test は非空で、migration module への import edge を持たない (PR diff 0 の機械的な代替。
    // git diff そのものは review packet の実測で、test は import graph の不変条件を固定する)。
    const inherited = INHERITED.map((p) => ({
      path: p,
      source: readFileSync(join(root, p), "utf8"),
    }));
    for (const file of inherited) expect(/\S/.test(file.source)).toBe(true);
    expect(migrationImportEdges(inherited, MODULE_STEM)).toEqual([]);
    // 継承 test の label 集合は不変 (削除 PR が継承 oracle を巻き込んでいない)。Green は CI の全 suite が証跡。
    const inheritedLabels = [
      ...new Set(
        inherited
          .filter((f) => f.path.startsWith("tests/"))
          .flatMap((f) => [...f.source.matchAll(/\b(U-[A-Z]+-\d{3})\b/g)].map((m) => m[1])),
      ),
    ].sort();
    expect(inheritedLabels).toEqual(INHERITED_TEST_LABELS);
    // 出現 0 は path と内容の両方で数える (path だけの復活も Red)。
    const files = OCCURRENCE_ROOTS.flatMap((r) => walkTs(join(root, r))).map((p) => ({
      path: relative(root, p).replaceAll("\\", "/"),
      source: readFileSync(p, "utf8"),
    }));
    const occurrences = (set: ReadonlyArray<{ path: string; source: string }>) =>
      set
        .filter((f) => f.path.includes(MODULE_STEM) || f.source.includes(MODULE_STEM))
        .map((f) => f.path);
    expect(occurrences(files)).toEqual([]);
    // mutation: 削除した module / test を path だけ戻しても Red、内容に stem を戻しても Red
    expect(occurrences([...files, { path: MODULE_PATH, source: "export {};\n" }])).toEqual([
      MODULE_PATH,
    ]);
    expect(occurrences([...files, { path: TEST_PATH, source: "" }])).toEqual([TEST_PATH]);
    expect(
      occurrences([...files, { path: "src/runtime/x.ts", source: `// ${MODULE_STEM}\n` }]),
    ).toEqual(["src/runtime/x.ts"]);
  });
});
