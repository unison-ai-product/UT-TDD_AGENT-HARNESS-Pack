import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkResourceKernelPairMapping } from "../src/doctor/doc-registry.ts";
import {
  ALLOWED_LANES,
  analyzeResourceKernelPairMapping,
  EXPECTED_CONTRACT_COUNT,
  EXPECTED_CONTRACT_IDS,
  EXPECTED_ORACLE_COUNT,
  type LaneDeclaration,
  parseContractMappingRows,
  parseFreezeAttributeRows,
  parseLaneDeclarations,
  parseRealRunnerTotal,
  REAL_RUNNER_LANES,
  resourceKernelPairMappingMessages,
} from "../src/lint/resource-kernel-pair-mapping.ts";
import { workspaceRead } from "./support/workspace-roots.ts";

const L8_DOC = "docs/test-design/harness/L8-integration-test-design.md";
const L5_DOC = "docs/plans/PLAN-L5-25-resource-kernel-physical-protocol.md";

function snapshotRoot(): string {
  return workspaceRead({
    id: "U-RGKPAIR",
    mode: "head_snapshot",
    reason: "D0-R の L5↔L8 pair 写像は HEAD の 2 doc を突合して判定する",
  });
}

function loadRepoRows() {
  const root = snapshotRoot();
  const l8Markdown = readFileSync(join(root, L8_DOC), "utf8");
  return {
    freezeRows: parseFreezeAttributeRows(l8Markdown),
    mappingRows: parseContractMappingRows(readFileSync(join(root, L5_DOC), "utf8")),
    laneDeclarations: parseLaneDeclarations(l8Markdown),
    declaredRealRunnerTotal: parseRealRunnerTotal(l8Markdown),
  };
}

/** 実 doc を temp repo へ写し、指定の書き換えを施した repo root を返す (doctor 負 test 用)。 */
function mutatedRepo(mutate: (docs: { l8: string; l5: string }) => { l8: string; l5: string }): {
  root: string;
  cleanup: () => void;
} {
  const source = snapshotRoot();
  const root = mkdtempSync(join(tmpdir(), "rgk-pair-doctor-"));
  const docs = mutate({
    l8: readFileSync(join(source, L8_DOC), "utf8"),
    l5: readFileSync(join(source, L5_DOC), "utf8"),
  });
  for (const [rel, text] of [
    [L8_DOC, docs.l8],
    [L5_DOC, docs.l5],
  ] as const) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text, "utf8");
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("Resource Kernel L5↔L8 pair mapping lint (U-RGKPAIR, PLAN-L5-25 §7.1)", () => {
  it("U-RGKPAIR-001: 実 repo の freeze 属性表は 42 件・欠番 0・全属性充填・lane 語彙内", () => {
    const { freezeRows } = loadRepoRows();
    expect(freezeRows).toHaveLength(42);
    const ids = freezeRows.map((r) => r.id);
    const expected = Array.from(
      { length: 42 },
      (_, i) => `IT-RGK-PHYS-${String(i + 1).padStart(3, "0")}`,
    );
    expect(ids).toEqual(expected);
    for (const row of freezeRows) {
      expect(ALLOWED_LANES).toContain(row.lane);
      for (const cell of [
        row.platform,
        row.fixture,
        row.observation,
        row.negativeExpected,
        row.createdCount,
      ]) {
        expect(cell.length).toBeGreaterThan(0);
      }
    }
  });

  it("U-RGKPAIR-002: 実 repo で L5 物理契約 ⇔ 42 oracle が双方向に孤児 0", () => {
    const r = analyzeResourceKernelPairMapping(loadRepoRows());
    expect(resourceKernelPairMappingMessages(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.oraclesMissingFromMapping).toEqual([]);
    expect(r.oraclesMissingFromFreeze).toEqual([]);
    expect(r.contractsWithoutOracle).toEqual([]);
  });

  it("U-RGKPAIR-003: 実 runner を要する lane 件数が confirmed 律速の申告と一致する", () => {
    const { freezeRows, laneDeclarations, declaredRealRunnerTotal } = loadRepoRows();
    const r = analyzeResourceKernelPairMapping({
      freezeRows,
      mappingRows: [],
      laneDeclarations,
      declaredRealRunnerTotal,
    });
    // PLAN-L5-25 §7.2 (B) は「real-OS 6 + mock+real-OS 9 = 15 件が confirmed 昇格を律速」と申告する。
    expect(r.laneCounts["real-OS"]).toBe(6);
    expect(r.laneCounts["mock+real-OS"]).toBe(9);
    expect(r.laneCounts.mock).toBe(27);
    expect((r.laneCounts["real-OS"] ?? 0) + (r.laneCounts["mock+real-OS"] ?? 0)).toBe(15);
    // 散文の再掲一覧 (宣言) と表の lane 列 (正本) が集合として一致し、実 runner 合計宣言も一致する。
    expect(declaredRealRunnerTotal).toBe(15);
    expect(r.laneDeclarationsMissing).toEqual([]);
    expect(r.laneDeclarationMismatch).toEqual([]);
    expect(r.realRunnerTotalMismatch).toBeNull();
  });

  it("U-RGKPAIR-004: 片側欠落・属性欠落・lane 語彙外を fail-close で検出する", () => {
    const base = {
      id: "IT-RGK-PHYS-001",
      lane: "mock",
      platform: "OS非依存",
      fixture: "fx",
      observation: "obs",
      negativeExpected: "neg",
      createdCount: "control 1 / workload 0",
    };
    const orphanInFreeze = analyzeResourceKernelPairMapping({
      freezeRows: [base],
      mappingRows: [{ contractId: "C-RGK-01", source: "§1", oracles: [] }],
    });
    expect(orphanInFreeze.ok).toBe(false);
    expect(orphanInFreeze.oraclesMissingFromMapping).toEqual(["IT-RGK-PHYS-001"]);
    expect(orphanInFreeze.contractsWithoutOracle).toEqual(["C-RGK-01"]);

    const orphanInMapping = analyzeResourceKernelPairMapping({
      freezeRows: [],
      mappingRows: [{ contractId: "C-RGK-01", source: "§1", oracles: ["IT-RGK-PHYS-099"] }],
    });
    expect(orphanInMapping.ok).toBe(false);
    expect(orphanInMapping.oraclesMissingFromFreeze).toEqual(["IT-RGK-PHYS-099"]);

    const badRow = analyzeResourceKernelPairMapping({
      freezeRows: [{ ...base, lane: "assumed-green", observation: "" }],
      mappingRows: [{ contractId: "C-RGK-01", source: "§1", oracles: ["IT-RGK-PHYS-001"] }],
    });
    expect(badRow.ok).toBe(false);
    expect(badRow.rowsWithUnknownLane).toEqual(["IT-RGK-PHYS-001"]);
    expect(badRow.rowsWithEmptyAttribute).toEqual(["IT-RGK-PHYS-001"]);
    expect(resourceKernelPairMappingMessages(badRow).length).toBeGreaterThan(0);
  });

  it("U-RGKPAIR-005: 実 repo の契約 ID は C-RGK-01..58 の exact 集合 (欠番 0・重複 0・未知 0・出典正規)", () => {
    const { mappingRows } = loadRepoRows();
    // 「58 分割の全数性」を散文と人間レビューに依存させない (GPT5.6Pro 監査 2026-07-30)。
    expect(mappingRows).toHaveLength(EXPECTED_CONTRACT_COUNT);
    expect(mappingRows.map((r) => r.contractId)).toEqual([...EXPECTED_CONTRACT_IDS]);
    const r = analyzeResourceKernelPairMapping(loadRepoRows());
    expect(r.contractIdsMissing).toEqual([]);
    expect(r.contractIdsUnknown).toEqual([]);
    expect(r.contractIdsDuplicated).toEqual([]);
    expect(r.contractsWithInvalidSource).toEqual([]);
  });

  it("U-RGKPAIR-006: 契約側の欠番・重複・未知 ID・出典逸脱を fail-close で検出する", () => {
    const freezeRows = [
      {
        id: "IT-RGK-PHYS-001",
        lane: "mock",
        platform: "OS非依存",
        fixture: "fx",
        observation: "obs",
        negativeExpected: "neg",
        createdCount: "control 1 / workload 0",
      },
    ];
    // 期待集合 58 件のうち C-RGK-01 の重複 + 未知 C-RGK-99 + 出典 §7 (範囲外) を混入させる。
    const mappingRows = [
      { contractId: "C-RGK-01", source: "§1", oracles: ["IT-RGK-PHYS-001"] },
      { contractId: "C-RGK-01", source: "§1", oracles: ["IT-RGK-PHYS-001"] },
      { contractId: "C-RGK-99", source: "§7", oracles: ["IT-RGK-PHYS-001"] },
    ];
    const r = analyzeResourceKernelPairMapping({ freezeRows, mappingRows });
    expect(r.ok).toBe(false);
    expect(r.contractIdsDuplicated).toEqual(["C-RGK-01"]);
    expect(r.contractIdsUnknown).toEqual(["C-RGK-99"]);
    // C-RGK-01 以外の 57 件が欠番として全数報告される (先頭だけ丸めない)。
    expect(r.contractIdsMissing).toHaveLength(EXPECTED_CONTRACT_COUNT - 1);
    expect(r.contractIdsMissing[0]).toBe("C-RGK-02");
    expect(r.contractsWithInvalidSource).toEqual(["C-RGK-99"]);
    const msgs = resourceKernelPairMappingMessages(r);
    expect(msgs.some((m) => m.includes("欠番"))).toBe(true);
    expect(msgs.some((m) => m.includes("重複"))).toBe(true);
    expect(msgs.some((m) => m.includes("期待集合外"))).toBe(true);
    expect(msgs.some((m) => m.includes("正規範囲外"))).toBe(true);
  });

  it("U-RGKPAIR-007: oracle 側 exact 集合 (001..042) の重複・未知・欠番を fail-close で検出する", () => {
    // Codex closing review FLAG (2026-07-30) attack 2: freeze 行を Set 化していたため
    // 重複 oracle を足しても doctor が green になり得た。生の行列を数えて潰す。
    const repo = loadRepoRows();
    expect(repo.freezeRows).toHaveLength(EXPECTED_ORACLE_COUNT);

    const duplicated = analyzeResourceKernelPairMapping({
      ...repo,
      freezeRows: [...repo.freezeRows, repo.freezeRows[0]],
    });
    expect(duplicated.ok).toBe(false);
    expect(duplicated.oracleIdsDuplicated).toEqual(["IT-RGK-PHYS-001"]);
    expect(resourceKernelPairMappingMessages(duplicated).some((m) => m.includes("重複"))).toBe(
      true,
    );

    const missing = analyzeResourceKernelPairMapping({
      ...repo,
      freezeRows: repo.freezeRows.slice(1),
    });
    expect(missing.ok).toBe(false);
    expect(missing.oracleIdsMissing).toEqual(["IT-RGK-PHYS-001"]);

    const unknown = analyzeResourceKernelPairMapping({
      ...repo,
      freezeRows: [...repo.freezeRows, { ...repo.freezeRows[0], id: "IT-RGK-PHYS-099" }],
    });
    expect(unknown.ok).toBe(false);
    expect(unknown.oracleIdsUnknown).toEqual(["IT-RGK-PHYS-099"]);
  });

  it("U-RGKPAIR-008: lane 分布の宣言不一致・全 mock 化・宣言削除を fail-close で検出する", () => {
    // Codex closing review FLAG (2026-07-30) attack 3: lane 分布が doctor 強制されず
    // 全 mock 化でも green になり得た。宣言 (散文再掲) と表 (正本) の集合一致を検査する。
    const repo = loadRepoRows();

    const laneFlipped = analyzeResourceKernelPairMapping({
      ...repo,
      freezeRows: repo.freezeRows.map((row) =>
        row.id === "IT-RGK-PHYS-005" ? { ...row, lane: "mock" } : row,
      ),
    });
    expect(laneFlipped.ok).toBe(false);
    expect(laneFlipped.laneDeclarationMismatch.map((m) => m.lane).sort()).toEqual([
      "mock",
      "real-OS",
    ]);

    // 表と宣言を同時に全 mock 化しても、実 runner lane 0 件は設計上不正として落ちる。
    const allMockRows = repo.freezeRows.map((row) => ({ ...row, lane: "mock" }));
    const allMockDeclarations: LaneDeclaration[] = [
      { lane: "mock", declaredCount: allMockRows.length, ids: allMockRows.map((r) => r.id) },
      { lane: "real-OS", declaredCount: 0, ids: [] },
      { lane: "mock+real-OS", declaredCount: 0, ids: [] },
    ];
    const allMock = analyzeResourceKernelPairMapping({
      ...repo,
      freezeRows: allMockRows,
      laneDeclarations: allMockDeclarations,
      declaredRealRunnerTotal: 0,
    });
    expect(allMock.ok).toBe(false);
    expect(allMock.realRunnerTotalMismatch).toEqual({ declared: 0, counted: 0 });
    expect(
      resourceKernelPairMappingMessages(allMock).some((m) =>
        m.includes(REAL_RUNNER_LANES.join(" / ")),
      ),
    ).toBe(true);

    // 宣言そのものを消して検査を無効化する経路も塞ぐ (fail-open にしない)。
    const declarationsRemoved = analyzeResourceKernelPairMapping({
      ...repo,
      laneDeclarations: [],
      declaredRealRunnerTotal: null,
    });
    expect(declarationsRemoved.ok).toBe(false);
    expect(declarationsRemoved.laneDeclarationsMissing).toEqual([
      "mock",
      "mock+real-OS",
      "real-OS",
    ]);
    expect(declarationsRemoved.realRunnerTotalMismatch).toEqual({ declared: null, counted: 15 });

    const redistributedRows = repo.freezeRows.map((row) =>
      row.lane === "mock+real-OS" ? { ...row, lane: "real-OS" } : row,
    );
    const redistributedDeclarations: LaneDeclaration[] = [
      {
        lane: "mock",
        declaredCount: 27,
        ids: redistributedRows.filter((row) => row.lane === "mock").map((row) => row.id),
      },
      {
        lane: "real-OS",
        declaredCount: 15,
        ids: redistributedRows.filter((row) => row.lane === "real-OS").map((row) => row.id),
      },
      { lane: "mock+real-OS", declaredCount: 0, ids: [] },
    ];
    const redistributed = analyzeResourceKernelPairMapping({
      ...repo,
      freezeRows: redistributedRows,
      laneDeclarations: redistributedDeclarations,
      declaredRealRunnerTotal: 15,
    });
    expect(redistributed.ok).toBe(false);
    expect(redistributed.laneDeclarationMismatch).toEqual([]);
    expect(redistributed.realRunnerTotalMismatch).toBeNull();
    expect(redistributed.laneCountMismatch).toEqual([
      { lane: "real-OS", expected: 6, actual: 15 },
      { lane: "mock+real-OS", expected: 9, actual: 0 },
    ]);

    const duplicateDeclaration = analyzeResourceKernelPairMapping({
      ...repo,
      laneDeclarations: [...repo.laneDeclarations, repo.laneDeclarations[0]],
    });
    expect(duplicateDeclaration.ok).toBe(false);
    expect(duplicateDeclaration.laneDeclarationsDuplicated).toEqual(["mock"]);
  });

  it("U-RGKPAIR-010: HTML/Unicodeの空欄placeholderを充填済みとして扱わない", () => {
    const repo = loadRepoRows();
    for (const placeholder of [
      "&nbsp;",
      "&#160;",
      "&#0160",
      "&#xA0;",
      "&#8203;",
      "&#x200B;",
      "&ensp;",
      "&emsp;",
      "&thinsp;",
      "&hairsp;",
      "&zwnj;",
      "&lrm;",
      "&shy;",
      "&InvisibleTimes;",
      "&Tab;",
      "&MediumSpace;",
      "&ZeroWidthSpace;",
      "\u00a0",
      "\u200b",
      "\ufeff",
      "<br>",
      "<!-- -->",
      "<span></span>",
      "<span><em></em></span>",
      '<span title=">"></span>',
      '<span title="&quot;>&quot;"></span>',
      '<span title="&#34;>&#34;"></span>',
      "<span title='&apos;>&apos;'></span>",
      "<span/>",
      "<wbr>",
      "[&zwnj;](#)",
      "[&zwnj;][blank]",
      "[&zwnj;]",
      "**&lrm;**",
      "&#847;",
      "&#12644;",
      "&#34;&#8203;",
      "&#39;",
      ".",
      "-",
      "?",
    ]) {
      const result = analyzeResourceKernelPairMapping({
        ...repo,
        freezeRows: repo.freezeRows.map((row, index) =>
          index === 0 ? { ...row, fixture: placeholder } : row,
        ),
      });
      expect(result.ok).toBe(false);
      expect(result.rowsWithEmptyAttribute).toEqual(["IT-RGK-PHYS-001"]);
    }
  });

  /**
   * issue #199 の fail-open (記号 1 文字セルが充填済みとして通過) に対する PR #201
   * (`022e0b43`、`isBlankMarkdownCell` を `!/[\p{L}\p{N}]/u` へ) の独立回帰 fence。
   *
   * U-RGKPAIR-010 が拾えていない 2 方向を固定する:
   * 1. 記号のみのセルを **空扱いにする** 側 — #201 の負 test 5 件より広い記号面を張る。
   * 2. 可視 1 文字 (`1` / `全` / `あ`) を **空扱いにしない** 側 — 「visible N 文字未満は空」の
   *    ような文字数下限ハードコードを将来入れさせないための逆向き fence
   *    (PR #197 の `9792f051` が入れて `c121362c` で撤回した仕様を復活させない)。
   */
  it("U-RGKPAIR-012: 可視の英数字・仮名・漢字を含まない記号セルを空欄として扱う", () => {
    const repo = loadRepoRows();
    for (const placeholder of [
      "&#34;",
      "&#39;",
      "&quot;",
      "&apos;",
      ".",
      "-",
      "?",
      ",",
      ";",
      ":",
      '"',
      "'",
      "/",
      "\\",
      "&#124;",
      "&#34;&#8203;",
      "<span>&#34;</span>",
    ]) {
      const result = analyzeResourceKernelPairMapping({
        ...repo,
        freezeRows: repo.freezeRows.map((row, index) =>
          index === 0 ? { ...row, fixture: placeholder } : row,
        ),
      });
      expect(result.ok).toBe(false);
      expect(result.rowsWithEmptyAttribute).toEqual(["IT-RGK-PHYS-001"]);
    }

    for (const visibleContent of ["1", "all", "mock", "x86", "全", "あ", "ア", "0", "n"]) {
      const result = analyzeResourceKernelPairMapping({
        ...repo,
        freezeRows: repo.freezeRows.map((row, index) =>
          index === 0 ? { ...row, fixture: visibleContent } : row,
        ),
      });
      expect(result.rowsWithEmptyAttribute).toEqual([]);
    }
  });

  it("U-RGKPAIR-011: HTML comment/fenced code内の偽表・宣言・見出しを正本として数えない", () => {
    const fakeRow = "| `IT-RGK-PHYS-001` | mock | all | fixture | obs | negative | 1 |";
    const fakeDeclaration = "- `mock` 1 件: `001`";
    for (const hidden of [
      `<!--\n### Resource Kernel物理統合 freeze属性\n${fakeRow}\n${fakeDeclaration}\n-->`,
      `### Resource Kernel物理統合 freeze属性\n\`\`\`markdown\n${fakeRow}\n${fakeDeclaration}\n\`\`\``,
      `### Resource Kernel物理統合 freeze属性\n~~~~\n${fakeRow}\n${fakeDeclaration}\n~~~~`,
      `### Resource Kernel物理統合 freeze属性\n\`\`\`\n\`\`\`not-a-closing-fence\n${fakeRow}\n\`\`\``,
      `### Resource Kernel物理統合 freeze属性\n<template>\n${fakeRow}\n${fakeDeclaration}\n</template>`,
      `### Resource Kernel物理統合 freeze属性\n<script type="text/plain">\n${fakeRow}\n${fakeDeclaration}\n</script>`,
      `### Resource Kernel物理統合 freeze属性\n<div style="display:none">\n${fakeRow}\n${fakeDeclaration}\n</div>`,
      `### Resource Kernel物理統合 freeze属性\n<textarea>\n${fakeRow}\n${fakeDeclaration}\n</textarea>`,
      `### Resource Kernel物理統合 freeze属性\n<details>\n${fakeRow}\n${fakeDeclaration}\n</details>`,
      `### Resource Kernel物理統合 freeze属性\n<x-hidden>\n${fakeRow}\n${fakeDeclaration}\n</x-hidden>`,
      `### Resource Kernel物理統合 freeze属性\n<![CDATA[\n${fakeRow}\n${fakeDeclaration}\n]]>`,
      `### Resource Kernel物理統合 freeze属性\n<?contract\n${fakeRow}\n${fakeDeclaration}\n?>`,
      `### Resource Kernel物理統合 freeze属性\n<!DOCTYPE contract\n${fakeRow}\n${fakeDeclaration}\n>`,
      `### Resource Kernel物理統合 freeze属性\n<script>\n\n${fakeRow}\n${fakeDeclaration}\n</script>`,
      `### Resource Kernel物理統合 freeze属性\n<![CDATA[\n\n${fakeRow}\n${fakeDeclaration}\n]]>`,
      `### Resource Kernel物理統合 freeze属性\n<!--\n${fakeRow}\n${fakeDeclaration}`,
      `### Resource Kernel物理統合 freeze属性\n</div>\n${fakeRow}\n${fakeDeclaration}`,
      `### Resource Kernel物理統合 freeze属性\n\`\`\`\n    \`\`\`\n${fakeRow}\n\`\`\``,
    ]) {
      expect(parseFreezeAttributeRows(hidden)).toEqual([]);
      expect(parseLaneDeclarations(hidden)).toEqual([]);
    }
  });

  it("U-RGKPAIR-009: doctor hard gate が実 doc で green、改竄 doc で violation を返す", () => {
    // doctor 単体 (analyzer 直呼びではない配線経路) で attack 2/3 が落ちることを確かめる。
    const green = checkResourceKernelPairMapping(snapshotRoot());
    expect(green.messages.join(" ")).toContain("resource-kernel-pair-mapping — OK");
    expect(green.ok).toBe(true);

    const duplicated = mutatedRepo(({ l8, l5 }) => {
      const lines = l8.split(/\r?\n/);
      // freeze 属性表の行 (7 列、lane セル付き) を狙う。同 ID は要約表にも現れるため
      // 先頭一致で拾うと節外を書き換えてしまい、検査が空振りする。
      const index = lines.findIndex((line) => /^\| `IT-RGK-PHYS-001` \| mock \|/.test(line));
      expect(index).toBeGreaterThan(0);
      lines.splice(index + 1, 0, lines[index]);
      return { l8: lines.join("\n"), l5 };
    });
    try {
      const result = checkResourceKernelPairMapping(duplicated.root);
      expect(result.ok).toBe(false);
      expect(result.messages.join(" ")).toContain("重複する oracle ID");
    } finally {
      duplicated.cleanup();
    }

    const allMock = mutatedRepo(({ l8, l5 }) => ({
      l8: l8
        .replace(/^(\| `IT-RGK-PHYS-\d{3}` \| )(?:real-OS|mock\+real-OS)( \|)/gm, "$1mock$2")
        .replace(/^- `real-OS` 6 件.*$/m, "- `real-OS` 0 件: (なし)")
        .replace(/^- `mock\+real-OS` 9 件.*$/m, "- `mock+real-OS` 0 件: (なし)")
        .replace(
          /`real-OS` 6 件 \+ `mock\+real-OS` 9 件 = 15 件/,
          "`real-OS` 0 件 + `mock+real-OS` 0 件 = 0 件",
        ),
      l5,
    }));
    try {
      const result = checkResourceKernelPairMapping(allMock.root);
      expect(result.ok).toBe(false);
      expect(result.messages.join(" ")).toContain("実 runner lane");
    } finally {
      allMock.cleanup();
    }

    const redistributed = mutatedRepo(({ l8, l5 }) => ({
      l8: l8
        .replace(/^(\| `IT-RGK-PHYS-\d{3}` \| )mock\+real-OS( \|)/gm, "$1real-OS$2")
        .replace(/^- `real-OS` 6 件.*$/m, (line) =>
          line
            .replace("6 件", "15 件")
            .replace(/$/, "、`011`、`012`、`016`、`018`、`019`、`028`、`031`、`035`、`036`"),
        )
        .replace(/^- `mock\+real-OS` 9 件.*$/m, "- `mock+real-OS` 0 件: (なし)")
        .replace(
          /`real-OS` 6 件 \+ `mock\+real-OS` 9 件 = 15 件/,
          "`real-OS` 15 件 + `mock+real-OS` 0 件 = 15 件",
        ),
      l5,
    }));
    try {
      const result = checkResourceKernelPairMapping(redistributed.root);
      expect(result.ok).toBe(false);
      expect(result.messages.join(" ")).toContain("lane 固定件数不一致");
    } finally {
      redistributed.cleanup();
    }

    const unreadable = mkdtempSync(join(tmpdir(), "rgk-pair-empty-"));
    try {
      const result = checkResourceKernelPairMapping(unreadable);
      expect(result.ok).toBe(false);
      expect(result.messages.join(" ")).toContain("読めなかった");
    } finally {
      rmSync(unreadable, { recursive: true, force: true });
    }
  });
});
