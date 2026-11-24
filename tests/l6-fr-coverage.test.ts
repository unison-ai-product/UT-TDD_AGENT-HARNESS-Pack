import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadFrUnitCoverageOracles } from "../src/lint/descent-obligation.ts";
import {
  analyzeL6FrCoverage,
  type L6FrCoverageDocs,
  type L6FrCoverageResult,
  loadL6FrCoverageDocs,
  parseL6FrCoverageRows,
} from "../src/lint/l6-fr-coverage.ts";

describe("L6 FR coverage (FR registry -> unit-level function spec)", () => {
  it("parses FR coverage rows from the L6 matrix", () => {
    const rows = parseL6FrCoverageRows(`
| FR | L6 spec | unit contract | unit oracle |
|---|---|---|---|
| FR-L1-01 | docs/design/harness/L6-function-design/function-spec.md | planDraft | U-FR-L1-01 |
`);
    expect(rows).toEqual([
      {
        fr_id: "FR-L1-01",
        l6_spec: "docs/design/harness/L6-function-design/function-spec.md",
        unit_contract: "planDraft",
        unit_oracle: "U-FR-L1-01",
      },
    ]);
  });

  it("reports missing, unknown, and incomplete FR rows", () => {
    const result = analyzeL6FrCoverage({
      frIds: ["FR-L1-01", "FR-L1-02"],
      coverageText: `
| FR | L6 spec | unit contract | unit oracle |
|---|---|---|---|
| FR-L1-01 | docs/design/harness/L6-function-design/function-spec.md | \`planDraft\` |  |
| FR-L1-99 | docs/design/harness/L6-function-design/function-spec.md | \`unknown\` | U-FR-L1-98 |
`,
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["FR-L1-02"]);
    expect(result.unknown).toEqual(["FR-L1-99"]);
    expect(result.incomplete).toEqual([
      { fr_id: "FR-L1-01", missing: ["unit_oracle"] },
      { fr_id: "FR-L1-99", missing: ["unit_oracle_match"] },
    ]);
  });

  it("requires contract references to be present in the referenced L6 spec", () => {
    const result = analyzeL6FrCoverage({
      frIds: ["FR-L1-01"],
      coverageText: `
| FR | L6 spec | unit contract | unit oracle |
|---|---|---|---|
| FR-L1-01 | docs/design/harness/L6-function-design/session-log.md | \`missingContract\` validates input. | U-FR-L1-01 |
`,
      repoRoot: process.cwd(),
    });
    expect(result.ok).toBe(false);
    expect(result.weakContracts).toEqual([
      {
        fr_id: "FR-L1-01",
        contract: "missingContract",
        reason: "contract_ref_missing_in_l6_spec",
      },
    ]);
    expect(result.missingSubstance).toEqual([]);
  });

  it("requires function-spec refs to carry type body plus pseudocode or explicit defer", () => {
    const result = analyzeL6FrCoverage({
      frIds: ["FR-L1-01"],
      coverageText: `
| FR | L6 spec | unit contract | unit oracle |
|---|---|---|---|
| FR-L1-01 | docs/design/harness/L6-function-design/function-spec.md | \`runDoctor\` validates input. | U-FR-L1-01 |
`,
      repoRoot: process.cwd(),
    });
    expect(result.ok).toBe(false);
    expect(result.missingSubstance).toEqual([
      {
        fr_id: "FR-L1-01",
        contract: "runDoctor",
        reason: "missing_type_body_or_pseudocode_defer_marker",
      },
    ]);
  });

  it("requires explicit L7 defer rows to include a structured field block", () => {
    const repoRoot = join(tmpdir(), `ut-tdd-l6-fr-${Date.now()}`);
    const specDir = join(repoRoot, "docs", "design", "harness", "L6-function-design");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(
      join(specDir, "function-spec.md"),
      `
| function | type body | pseudocode / implementation_state |
|---|---|---|
| \`deferredContract\` | \`DeferredInput -> DeferredResult\` | explicit_l7_defer; pseudocode = validate input and return result |
`,
      "utf8",
    );
    try {
      const result = analyzeL6FrCoverage({
        frIds: ["FR-L1-01"],
        coverageText: `
| FR | L6 spec | unit contract | unit oracle |
|---|---|---|---|
| FR-L1-01 | docs/design/harness/L6-function-design/function-spec.md | \`deferredContract\` validates input. | U-FR-L1-01 |
`,
        repoRoot,
      });
      expect(result.ok).toBe(false);
      expect(result.missingSubstance).toEqual([
        {
          fr_id: "FR-L1-01",
          contract: "deferredContract",
          reason: "missing_type_body_or_pseudocode_defer_marker",
        },
      ]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("real repo covers every FR-L1 row with an L6 spec and U-* oracle", () => {
    const result = analyzeL6FrCoverage(loadL6FrCoverageDocs());
    expect(result.totalFr).toBe(51);
    expect(result.covered).toBe(51);
    expect(result.missing).toEqual([]);
    expect(result.unknown).toEqual([]);
    expect(result.incomplete).toEqual([]);
    expect(result.missingSpecFiles).toEqual([]);
    expect(result.weakContracts).toEqual([]);
    expect(result.missingSubstance).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Issue #848 退役行 coverage 契約の Red (U-FRCOV-007..023)。
// 契約: docs/design/harness/L6-function-design/fr-unit-coverage.md §Issue #848
//       docs/test-design/harness/L7-unit-test-design.md (U-FRCOV-007..023 表)
// 入力は既存公開 API の `analyzeL6FrCoverage({ frIds, coverageText, repoRoot })` と
// `loadFrUnitCoverageOracles(root)` のみ。退役状態・退役根拠・oracle 宣言・実 test は
// fixture repoRoot の正規パス配下の文書から読まれる前提 (L6 契約が signature を変えないため)。
// 各 negative は「有効な双子 fixture が受理されること」を先に確かめ、その後に1条件だけ変えた
// fixture が拒否されることを確かめる。現行実装は退役状態を読まず双子を拒否するので、
// assertion (expect) まで届いて落ちる (import 不足・余分引数・setup 失敗による偽 Red ではない)。
// ---------------------------------------------------------------------------

const RET_SPEC_REL = "docs/design/harness/L6-function-design/retire-fixture.md";
const RET_FS_REL = "docs/design/harness/L6-function-design/function-spec.md";
const RET_TEST_REL = "tests/fixture/retired.test.ts";
const RET_TEST_REL_2 = "tests/fixture/retired-second.test.ts";
const RET_DOC_REL = "docs/design/harness/L6-function-design/retire-evidence-fixture.md";
const RET_HEADING = "退役の根拠";
const RET_REF = `${RET_DOC_REL}#${RET_HEADING}`;
const CAND = "CANDIDATE-U-RET-001";
const FORMAL = "U-RET-001";

interface RetDecl {
  id: string;
  path: string;
  target: string;
}

interface RetFx {
  /** undefined のとき registry は既存7列だけ (fr_state / retirement_ref 列なし)。 */
  frState?: string;
  /** registry の retirement_ref 列 (Issue `#N` または `<設計文書 path>#<見出し>`)。 */
  ref?: string;
  coverageOracle: string;
  specRel: string;
  specText: string;
  candDecls: RetDecl[];
  formalDecls: RetDecl[];
  testFiles: Record<string, string>;
  /** 退役根拠の設計文書: repo-relative path -> その文書が持つ見出し text の列 (重複可)。 */
  refDocs: Record<string, string[]>;
  /** 指定した文書は見出し列ではなくこの本文をそのまま書く (fenced / setext の変異用)。 */
  refBodies?: Record<string, string>;
  /** L7 test-design 文書へ追記する prose (宣言ではない言及)。 */
  prose: string;
}

const PLAIN_SPEC = "# retire fixture\n\n`retireContract` is the fixture contract.\n";
const FS_SPEC_OK = [
  "| Function | Signature | pre | post |",
  "|---|---|---|---|",
  "| `retireContract` | f | p | q |",
  "",
  "| function | type body | pseudocode / implementation_state |",
  "|---|---|---|",
  "| `retireContract` | `RetireInput { id: string; ok?: boolean } -> RetireResult` | explicit_l7_defer; pseudocode = validate |",
  "",
].join("\n");
const FS_SPEC_HOLLOW = FS_SPEC_OK.replace(
  "RetireInput { id: string; ok?: boolean }",
  "RetireInput",
);

function retDecl(id: string, path = RET_TEST_REL, target = "FR-L1-05"): RetDecl {
  return { id, path, target };
}

/** 有効な candidate-positive fixture (U-FRCOV-008 の正例)。 */
function candidateFx(over: Partial<RetFx> = {}): RetFx {
  return {
    frState: "retired",
    ref: RET_REF,
    coverageOracle: CAND,
    specRel: RET_SPEC_REL,
    specText: PLAIN_SPEC,
    candDecls: [retDecl(CAND)],
    formalDecls: [],
    testFiles: { [RET_TEST_REL]: `it("${CAND} retired row", () => {});\n` },
    refDocs: { [RET_DOC_REL]: [RET_HEADING] },
    prose: "",
    ...over,
  };
}

/** 有効な formal-positive fixture (U-FRCOV-009 の正例)。 */
function formalFx(over: Partial<RetFx> = {}): RetFx {
  return candidateFx({
    coverageOracle: FORMAL,
    candDecls: [],
    formalDecls: [retDecl(FORMAL)],
    testFiles: { [RET_TEST_REL]: `it("${FORMAL} retired row", () => {});\n` },
    ...over,
  });
}

function declTable(title: string, decls: RetDecl[]): string {
  const rows = decls.map(
    (d) => `| ${d.id} | ${d.path} | ${d.target ? `${d.target} の退役 oracle` : "退役 oracle"} |`,
  );
  return [
    `### ${title}`,
    "",
    "| Test ID | 対象 / 実test引用予定 | 期待 |",
    "|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

const tmpRoots: string[] = [];

function materialize(fx: RetFx): { docs: L6FrCoverageDocs; root: string } {
  const root = join(tmpdir(), `ut-tdd-fr-retire-${process.pid}-${tmpRoots.length}-${Date.now()}`);
  tmpRoots.push(root);
  const put = (rel: string, text: string) => {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, "utf8");
  };
  const stateCols = fx.frState === undefined ? "" : ` ${fx.frState} | ${fx.ref ?? ""} |`;
  put(
    "docs/design/harness/L1-requirements/functional-requirements.md",
    [
      "## §1 機能一覧",
      "",
      "| ID | 機能名 | 出典 | 入力 | 出力 | 重要度 | 画面 | fr_state | retirement_ref |",
      "|---|---|---|---|---|---|---|---|---|",
      `| **FR-L1-05** | retired fn | src | in | out | P1 | - |${stateCols}`,
      "",
      "### §1.1 end",
      "",
    ].join("\n"),
  );
  put(
    "docs/test-design/harness/L7-unit-test-design.md",
    `# L7 fixture\n\n${fx.prose}\n\n${declTable("candidate oracle 宣言表", fx.candDecls)}\n${declTable("正式 oracle 宣言表", fx.formalDecls)}`,
  );
  for (const [rel, body] of Object.entries(fx.refBodies ?? {})) put(rel, body);
  for (const [rel, headings] of Object.entries(fx.refDocs)) {
    if (fx.refBodies?.[rel] !== undefined) continue;
    put(rel, `# fixture\n\n${headings.map((h) => `## ${h}\n\n本文\n`).join("\n")}`);
  }
  for (const [rel, text] of Object.entries(fx.testFiles)) put(rel, text);
  put(fx.specRel, fx.specText);
  const coverageText = [
    "| FR | L6 spec | unit contract | unit oracle |",
    "|---|---|---|---|",
    `| FR-L1-05 | ${fx.specRel} | \`retireContract\` validates retirement. | ${fx.coverageOracle} |`,
    "",
  ].join("\n");
  put("docs/design/harness/L6-function-design/fr-unit-coverage.md", coverageText);
  return { docs: { frIds: ["FR-L1-05"], coverageText, repoRoot: root }, root };
}

function runFx(fx: RetFx): L6FrCoverageResult {
  return analyzeL6FrCoverage(materialize(fx).docs);
}

/** 双子 (有効 fixture) と、1条件だけ変えた fixture の判定 [valid.ok, mutated.ok] を返す。 */
function pairOutcome(valid: RetFx, mutated: RetFx): [boolean, boolean] {
  return [runFx(valid).ok, runFx(mutated).ok];
}

describe("Issue #848 FR retirement coverage (U-FRCOV-007..023, Red)", () => {
  afterEach(() => {
    for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  // 現行実装でも成立する回帰 guard。Red にならないため it.fails ではなく通常の it とする。
  it("U-FRCOV-007: active FR keeps the exact U-FR oracle and rejects a candidate id", () => {
    const active = candidateFx({
      frState: "active",
      ref: "",
      coverageOracle: "U-FR-L1-05",
      candDecls: [],
    });
    expect(runFx(active).ok).toBe(true);
    const candidateOnActive = runFx({ ...active, coverageOracle: CAND });
    expect(candidateOnActive.ok).toBe(false);
    expect(candidateOnActive.incomplete).toContainEqual({
      fr_id: "FR-L1-05",
      missing: ["unit_oracle_match"],
    });
  });

  it("U-FRCOV-008: retired row with resolved retirement_ref, candidate declaration and test citation is accepted as candidate", () => {
    const result = runFx(candidateFx());
    expect(result.incomplete).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("U-FRCOV-009: formal state is accepted only when coverage, declaration and test citation are all formal", () => {
    const result = runFx(formalFx());
    expect(result.incomplete).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("U-FRCOV-010: retired row without retirement_ref is rejected", () => {
    expect(pairOutcome(candidateFx(), candidateFx({ ref: "" }))).toEqual([true, false]);
  });

  it("U-FRCOV-011: retirement_ref whose design document path does not exist is rejected", () => {
    expect(
      pairOutcome(
        candidateFx(),
        candidateFx({
          ref: `docs/design/harness/L6-function-design/missing-doc.md#${RET_HEADING}`,
        }),
      ),
    ).toEqual([true, false]);
  });

  it("U-FRCOV-012: out-of-grammar or ambiguous retirement_ref is rejected", () => {
    expect(runFx(candidateFx()).ok).toBe(true);
    // 閉じた文法の正例: Issue 番号 (書式のみ検査) も受理する。
    expect(runFx(candidateFx({ ref: "#848" })).ok).toBe(true);
    // 同じ見出しが同一文書に2つ: 曖昧なので拒否 (推測解決しない)。
    const dup = candidateFx({ refDocs: { [RET_DOC_REL]: [RET_HEADING, RET_HEADING] } });
    expect(runFx(dup).ok).toBe(false);
    // 短縮形・不正形は拒否。
    for (const ref of ["848", "Issue 848", "#0", "#12abc", "# 848"]) {
      expect(runFx(candidateFx({ ref })).ok).toBe(false);
    }
    // PLAN 参照は文法外として拒否する (PLAN 専用の検知ではなく、2形式以外は全て拒否)。
    expect(runFx(candidateFx({ ref: "PLAN-L6-RET-01-fixture" })).ok).toBe(false);
    // 参照先の文書と見出しが実在しても、許可prefix外 (docs/plans/) なら拒否する。
    const planRel = "docs/plans/PLAN-L6-RET-01-fixture.md";
    const planDoc = candidateFx({
      ref: `${planRel}#${RET_HEADING}`,
      refDocs: { [RET_DOC_REL]: [RET_HEADING], [planRel]: [RET_HEADING] },
    });
    expect(runFx(planDoc).ok).toBe(false);
  });

  it("U-FRCOV-013: candidate id without a declaration row is rejected even if prose mentions it", () => {
    expect(
      pairOutcome(
        candidateFx(),
        candidateFx({ candDecls: [], prose: `${CAND} は本文で言及されるだけ。` }),
      ),
    ).toEqual([true, false]);
  });

  it("U-FRCOV-014: formal id without a declaration row is rejected even if prose and candidate row mention it", () => {
    expect(
      pairOutcome(
        formalFx(),
        formalFx({
          formalDecls: [],
          candDecls: [retDecl(CAND)],
          prose: `${FORMAL} は本文で言及されるだけ。`,
        }),
      ),
    ).toEqual([true, false]);
  });

  it("U-FRCOV-015: declaration whose real test file is missing is rejected", () => {
    expect(pairOutcome(candidateFx(), candidateFx({ testFiles: {} }))).toEqual([true, false]);
  });

  it("U-FRCOV-016: test file citing a different oracle id is rejected", () => {
    expect(
      pairOutcome(
        candidateFx(),
        candidateFx({
          testFiles: {
            [RET_TEST_REL]:
              'it("CANDIDATE-U-RET-0010 prefix lookalike", () => {});\nit("CANDIDATE-U-RET-002", () => {});\n',
          },
        }),
      ),
    ).toEqual([true, false]);
  });

  it("U-FRCOV-017: partial promotion (one or two surfaces to formal) is rejected in all 6 cases", () => {
    expect(runFx(candidateFx()).ok).toBe(true);
    const candTest = { [RET_TEST_REL]: `it("${CAND}", () => {});\n` };
    const formalTest = { [RET_TEST_REL]: `it("${FORMAL}", () => {});\n` };
    const formalDecl = { candDecls: [], formalDecls: [retDecl(FORMAL)] };
    const cases: [string, RetFx][] = [
      ["coverage only", candidateFx({ coverageOracle: FORMAL })],
      ["declaration only", candidateFx(formalDecl)],
      ["test citation only", candidateFx({ testFiles: formalTest })],
      [
        "coverage+declaration",
        candidateFx({ coverageOracle: FORMAL, ...formalDecl, testFiles: candTest }),
      ],
      ["coverage+test", candidateFx({ coverageOracle: FORMAL, testFiles: formalTest })],
      ["declaration+test", candidateFx({ ...formalDecl, testFiles: formalTest })],
    ];
    for (const [label, fx] of cases) {
      expect(runFx(fx).ok, `partial promotion must be rejected: ${label}`).toBe(false);
    }
  });

  it("U-FRCOV-018: unknown or evidence-less state never falls back to a normal FR, and retired labels do not hide substance errors", () => {
    // 未知 state: 通常 oracle U-FR-L1-05 が揃っていても通常 FR へ fallback しない。
    const unknown = candidateFx({
      frState: "suspended",
      coverageOracle: "U-FR-L1-05",
      candDecls: [],
    });
    expect(runFx(unknown).ok).toBe(false);
    // 既知 retired でも退役根拠 (retirement_ref) 欠落なら通常 oracle fallback で通さない。
    const noRef = candidateFx({ ref: "", coverageOracle: "U-FR-L1-05", candDecls: [] });
    expect(runFx(noRef).ok).toBe(false);
    // retired + candidate でも U-FRCOV-006 既存反例 (field block なし explicit_l7_defer) の substance error は残る。
    const valid = candidateFx({ specRel: RET_FS_REL, specText: FS_SPEC_OK });
    const hollow = candidateFx({ specRel: RET_FS_REL, specText: FS_SPEC_HOLLOW });
    expect(runFx(valid).ok).toBe(true);
    const hollowResult = runFx(hollow);
    expect(hollowResult.ok).toBe(false);
    expect(hollowResult.missingSubstance.map((m) => m.fr_id)).toEqual(["FR-L1-05"]);
    // loadFrUnitCoverageOracles (descent reader) は doctor と同じ有効 / 無効判定を返す。
    expect([...loadFrUnitCoverageOracles(materialize(valid).root)]).toContain("FR-L1-05");
    expect([...loadFrUnitCoverageOracles(materialize(hollow).root)]).not.toContain("FR-L1-05");
    // reader も unknown / noRef を通常 FR へ fallback させない。
    // 双子: 有効な通常 FR (active + 通常 oracle) の受理を先に確かめ、
    // 1 条件 (state 未知 / 退役根拠欠落) だけ変えたものが除外されることを確かめる。
    const normal = candidateFx({
      frState: "active",
      ref: "",
      coverageOracle: "U-FR-L1-05",
      candDecls: [],
    });
    expect([...loadFrUnitCoverageOracles(materialize(normal).root)]).toContain("FR-L1-05");
    expect([...loadFrUnitCoverageOracles(materialize(unknown).root)]).not.toContain("FR-L1-05");
    expect([...loadFrUnitCoverageOracles(materialize(noRef).root)]).not.toContain("FR-L1-05");
  });

  it("U-FRCOV-019: active row carrying retirement_ref is rejected", () => {
    const active = candidateFx({
      frState: "active",
      ref: "",
      coverageOracle: "U-FR-L1-05",
      candDecls: [],
    });
    expect(pairOutcome(active, { ...active, ref: RET_REF })).toEqual([true, false]);
  });

  it("U-FRCOV-020: ambiguous double declaration of the exact oracle id is rejected", () => {
    expect(
      pairOutcome(
        candidateFx(),
        candidateFx({
          candDecls: [retDecl(CAND), retDecl(CAND, RET_TEST_REL_2)],
          testFiles: {
            [RET_TEST_REL]: `it("${CAND}", () => {});\n`,
            [RET_TEST_REL_2]: `it("${CAND} second", () => {});\n`,
          },
        }),
      ),
    ).toEqual([true, false]);
  });

  it("U-FRCOV-021: design document exists but the referenced heading is absent is rejected", () => {
    expect(
      pairOutcome(candidateFx(), candidateFx({ refDocs: { [RET_DOC_REL]: ["別の節"] } })),
    ).toEqual([true, false]);
    // 見出し resolver の変異: 通常の `## 見出し` が1つだけの双子は受理 (上の valid)。
    // 見出し行に見えるが ATX 見出しとして数えない形だけの文書は拒否する。
    const only = (body: string) =>
      candidateFx({
        refBodies: {
          [RET_DOC_REL]: `# fixture

${body}`,
        },
      });
    const withHeading = only(`## ${RET_HEADING}

本文
`);
    expect(runFx(withHeading).ok).toBe(true);
    // fenced code block 内 (``` と ~~~ の両方) にしか無い見出しは数えない。
    expect(
      runFx(
        only(`\`\`\`
## ${RET_HEADING}
\`\`\`
`),
      ).ok,
    ).toBe(false);
    expect(
      runFx(
        only(`~~~
## ${RET_HEADING}
~~~
`),
      ).ok,
    ).toBe(false);
    // setext 見出し (下線形式) は対象外。
    expect(
      runFx(
        only(`${RET_HEADING}
=====

本文
`),
      ).ok,
    ).toBe(false);
    expect(
      runFx(
        only(`${RET_HEADING}
-----

本文
`),
      ).ok,
    ).toBe(false);
  });

  it("U-FRCOV-022: declaration row without the target FR id is rejected", () => {
    expect(
      pairOutcome(candidateFx(), candidateFx({ candDecls: [retDecl(CAND, RET_TEST_REL, "")] })),
    ).toEqual([true, false]);
  });

  it("U-FRCOV-023: declaration row targeting a different FR id is rejected", () => {
    expect(
      pairOutcome(
        candidateFx(),
        candidateFx({ candDecls: [retDecl(CAND, RET_TEST_REL, "FR-L1-06")] }),
      ),
    ).toEqual([true, false]);
  });
});

// ---------------------------------------------------------------------------
// Issue #848 oracle 宣言行の識別規則の Red (U-FRCOV-024..026)。
// 契約: L6 fr-unit-coverage.md「宣言行の識別規則」/ L7 §1.20 追補。
// 宣言は fixture の L7 文書へ `prose` として自由形式の表で与える (宣言表は空)。
// 現行実装は退役状態を読まず先頭の正例 (有効 fixture) を拒否するので assertion で落ちる。
// ---------------------------------------------------------------------------

/** 宣言行を自由形式の表 (`prose`) だけで与えた candidate fixture の判定。 */
function declOk(prose: string, over: Partial<RetFx> = {}): boolean {
  return runFx(candidateFx({ candDecls: [], prose, ...over })).ok;
}

function freeTable(head: string, row: string, title = "無関係な節"): string {
  return [`## ${title}`, "", head, "|---|---|---|", row, ""].join("\n");
}

const DECL_HEAD_ID = "| ID | 観点 | 実装テスト |";
const DECL_ROW = `| ${CAND} | FR-L1-05 の退役 oracle | ${RET_TEST_REL} |`;

describe("Issue #848 declaration-row identification (U-FRCOV-024..026, Red)", () => {
  afterEach(() => {
    for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("U-FRCOV-024: any >=3-column table row whose first cell is the exact id is a declaration, independent of heading and header", () => {
    const outcomes = [
      declOk(freeTable(DECL_HEAD_ID, DECL_ROW)),
      declOk(freeTable("| oracle | 観点 | 実装テスト |", DECL_ROW)),
      declOk(freeTable("| test_id | 観点 | 実装テスト |", DECL_ROW)),
      declOk(
        freeTable(DECL_HEAD_ID, `| \`${CAND}\` | FR-L1-05 の退役 oracle | \`${RET_TEST_REL}\` |`),
      ),
      // 負例: 2列表に畳む / 第1セルが prose / fenced code block 内の表
      declOk(
        [
          "## 無関係な節",
          "",
          "| ID | 内容 |",
          "|---|---|",
          `| ${CAND} | FR-L1-05 ${RET_TEST_REL} |`,
          "",
        ].join("\n"),
      ),
      declOk(freeTable(DECL_HEAD_ID, `| 本文 | ${CAND} FR-L1-05 | ${RET_TEST_REL} |`)),
      declOk(`\`\`\`\n${freeTable(DECL_HEAD_ID, DECL_ROW)}\`\`\`\n`),
    ];
    expect(outcomes).toEqual([true, true, true, true, false, false, false]);
  });

  it("U-FRCOV-025: target FR id is matched on an exact boundary and must be the only FR id", () => {
    const withTarget = (cell: string) =>
      declOk(freeTable(DECL_HEAD_ID, `| ${CAND} | ${cell} | ${RET_TEST_REL} |`));
    const outcomes = [
      withTarget("FR-L1-05"),
      withTarget("`FR-L1-05` の退役 oracle"),
      withTarget("XFR-L1-05"),
      withTarget("FR-L1-050"),
      withTarget("FR-L1-5"),
      withTarget("FR-L1-05 と FR-L1-06"),
      // 末尾 pipe の無い行でも最終セルの別 FR 併記を見落とさない (#1181 r1)
      declOk(freeTable(DECL_HEAD_ID, `| ${CAND} | FR-L1-05 ${RET_TEST_REL} | FR-L1-06`)),
    ];
    expect(outcomes).toEqual([true, true, false, false, false, false, false]);
  });

  it("U-FRCOV-026: every tests path token must resolve and cite the exact oracle id", () => {
    const both = {
      [RET_TEST_REL]: `it("${CAND} a", () => {});\n`,
      [RET_TEST_REL_2]: `it("${CAND} b", () => {});\n`,
    };
    const withPath = (cell: string, testFiles?: Record<string, string>) =>
      declOk(
        freeTable(DECL_HEAD_ID, `| ${CAND} | FR-L1-05 の退役 oracle | ${cell} |`),
        testFiles ? { testFiles } : {},
      );
    const outcomes = [
      withPath(`\`${RET_TEST_REL}:12\``),
      withPath(`${RET_TEST_REL}, ${RET_TEST_REL_2}`, both),
      withPath("path なし"),
      withPath(`${RET_TEST_REL}, tests/fixture/missing.test.ts`),
      withPath("tests/fixture/../fixture/retired.test.ts"),
      withPath(RET_TEST_REL, { [RET_TEST_REL]: 'it("unrelated", () => {});\n' }),
      // 末尾 pipe の無い行でも最終セルの未解決 test path を検証から落とさない (#1181 r1)
      declOk(
        freeTable(
          DECL_HEAD_ID,
          `| ${CAND} | FR-L1-05 の退役 oracle ${RET_TEST_REL} | tests/fixture/missing.test.ts`,
        ),
      ),
    ];
    expect(outcomes).toEqual([true, true, false, false, false, false, false]);
  });
});
