/**
 * D0-R Resource Kernel の L5↔L8 pair 写像の機械検査 (PLAN-L5-25 §7.1/§7.2、issue #149)。
 *
 * PLAN-L5-25 §7 の pair-freeze 条件は「L8 で正負 oracle・fixture・観測点・control/workload 別
 * created count を freeze する」+「L5 全物理契約から 42 ID への全数写像」である。これを散文の
 * 主張で終わらせない (`coding ≠ substance`、PLAN-L7-89) ため、実 repo の 2 doc を突合する。
 *
 * 汎用 `oracle-test-trace` の `ORACLE_ID` は `\b(?:U|IT)-[A-Z0-9]+-[0-9]{3}\b` で 3 セグメント ID
 * (`IT-RGK-PHYS-001`) に一致しないため、42 件は汎用 gate から見えていない (open issue #165 と同族)。
 * 本 lint は D0 範囲だけを補う専用検査であり、汎用抽出の修正を代替しない。
 */

import { decodeHTML } from "entities/decode";
import { marked } from "marked";

/** freeze 属性表の 1 行 (ID + 6 属性)。 */
export interface FreezeAttributeRow {
  id: string;
  lane: string;
  platform: string;
  fixture: string;
  observation: string;
  negativeExpected: string;
  createdCount: string;
}

/** 全数写像表の 1 行 (契約 → 被覆 oracle)。 */
export interface ContractMappingRow {
  contractId: string;
  source: string;
  oracles: string[];
}

/** L8 散文が宣言する lane 別内訳 (再掲一覧) の 1 行。 */
export interface LaneDeclaration {
  lane: string;
  declaredCount: number;
  ids: string[];
}

export interface ResourceKernelPairMappingResult {
  /** 期待集合 (IT-RGK-PHYS-001..042) のうち freeze 表に現れない oracle (欠番)。 */
  oracleIdsMissing: string[];
  /** freeze 表にあるが期待集合外の oracle (未知 ID)。 */
  oracleIdsUnknown: string[];
  /** freeze 表内で重複している oracle。 */
  oracleIdsDuplicated: string[];
  /** lane 別内訳の宣言が読めなかった lane (宣言不在は fail-close)。 */
  laneDeclarationsMissing: string[];
  /** 同じ lane の再掲宣言が複数ある lane。 */
  laneDeclarationsDuplicated: string[];
  /** 設計で固定した lane 件数 (mock=27 / real-OS=6 / mock+real-OS=9) との不一致。 */
  laneCountMismatch: { lane: string; expected: number; actual: number }[];
  /** 宣言 lane 内訳と表の lane 列が食い違う点。 */
  laneDeclarationMismatch: {
    lane: string;
    declaredCount: number;
    declaredIdCount: number;
    tableCount: number;
    onlyInDeclaration: string[];
    onlyInTable: string[];
  }[];
  /** 実 runner 証拠を要する lane (real-OS + mock+real-OS) の宣言合計と実数の不一致。 */
  realRunnerTotalMismatch: { declared: number | null; counted: number } | null;
  /** freeze 表にあるが写像表で被覆されていない oracle。 */
  oraclesMissingFromMapping: string[];
  /** 写像表が参照するが freeze 表に実在しない oracle。 */
  oraclesMissingFromFreeze: string[];
  /** 属性セルが空の freeze 行 (ID)。 */
  rowsWithEmptyAttribute: string[];
  /** lane 語彙外の freeze 行 (ID)。 */
  rowsWithUnknownLane: string[];
  /** 被覆 oracle 0 件の契約行。 */
  contractsWithoutOracle: string[];
  /** 期待集合 (C-RGK-01..58) に無い契約 ID (未知 ID)。 */
  contractIdsUnknown: string[];
  /** 期待集合のうち写像表に現れない契約 ID (欠番)。 */
  contractIdsMissing: string[];
  /** 写像表内で重複する契約 ID。 */
  contractIdsDuplicated: string[];
  /** 出典が §1〜§6 (小数節可) の正規範囲外の契約行 (ID)。 */
  contractsWithInvalidSource: string[];
  /** lane 別件数。 */
  laneCounts: Record<string, number>;
  ok: boolean;
}

/** freeze 属性表で許可する lane 語彙。mock Green を実 OS custody Green へ読み替えないための 3 値。 */
export const ALLOWED_LANES = ["mock", "real-OS", "mock+real-OS"] as const;
export const EXPECTED_LANE_COUNTS: Readonly<Record<(typeof ALLOWED_LANES)[number], number>> = {
  mock: 27,
  "real-OS": 6,
  "mock+real-OS": 9,
};

/**
 * L5 物理契約の期待件数。§7.1 は「58 分割の exact 集合」を主張するため、42 oracle 側だけでなく
 * 契約側も欠番・重複・未知 ID を機械検査する (GPT5.6Pro 監査 2026-07-30: 「58 契約側の全数性が
 * 散文+人間レビュー依存」の指摘への対応)。分割数を変える場合は §7.1 とここを同時に更新する。
 */
export const EXPECTED_CONTRACT_COUNT = 58;
export const EXPECTED_CONTRACT_IDS: readonly string[] = Array.from(
  { length: EXPECTED_CONTRACT_COUNT },
  (_, i) => `C-RGK-${String(i + 1).padStart(2, "0")}`,
);

/**
 * L8 oracle 側の期待 exact 集合 (`IT-RGK-PHYS-001..042`)。PLAN-L5-25 §7 が freeze 対象として
 * 宣言する集合そのものであり、欠番 / 未知 ID / 重複を doctor で fail-close する
 * (Codex closing review FLAG 2026-07-30 attack 2: Set 化により重複行が無音で吸収され、
 * 重複 oracle を足しても doctor が green になり得た)。
 */
export const EXPECTED_ORACLE_COUNT = 42;
export const EXPECTED_ORACLE_IDS: readonly string[] = Array.from(
  { length: EXPECTED_ORACLE_COUNT },
  (_, i) => `IT-RGK-PHYS-${String(i + 1).padStart(3, "0")}`,
);

/** 実 runner 証拠を要する lane (PLAN-L5-25 の confirmed 昇格を律速する側)。 */
export const REAL_RUNNER_LANES = ["real-OS", "mock+real-OS"] as const;

/** 出典セルの正規形 (§1〜§6、§4.1 のような小数節を許容)。 */
const CONTRACT_SOURCE_PATTERN = /^§[1-6](\.\d+)?$/;

const PIPE_PLACEHOLDER = "\u0000PIPE\u0000";
const EMPTY_HTML_ELEMENT_PATTERN = /<([a-z][a-z0-9-]*)\b[^>]*>\s*<\/\1>/gi;
function isBlankMarkdownCell(value: string): boolean {
  let normalized = decodeHTML(
    value
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<br\s*\/?>/gi, "")
      .replace(/<(?:[^>"']|"[^"]*"|'[^']*')+>/g, ""),
  )
    .replace(/!?\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])/g, "$1")
    .replace(/[*_~`]+/g, "");
  let previous: string;
  do {
    previous = normalized;
    normalized = normalized.replace(EMPTY_HTML_ELEMENT_PATTERN, "");
  } while (normalized !== previous);
  normalized = normalized
    .replace(/[\p{White_Space}\p{Default_Ignorable_Code_Point}\u115f\u1160\u3164\uffa0]/gu, "")
    .replace(/\[|\]|[()*_~`#!]/g, "");
  return !/[\p{L}\p{N}]/u.test(normalized);
}

/** markdown の見出し配下 (次の同レベル以上の見出しまで) を切り出す。 */
export function sliceSection(markdown: string, headingPrefix: string): string {
  const lines = renderedMarkdownLines(markdown);
  const start = lines.findIndex((l) => l.startsWith(headingPrefix));
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,3} /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** CommonMark/GFM lexerがHTML・comment・codeと判定したblockを正本表・見出しの解析から除外する。 */
function renderedMarkdownLines(markdown: string): string[] {
  return marked
    .lexer(markdown)
    .filter((token) => token.type !== "html" && token.type !== "code")
    .flatMap((token) => token.raw.split(/\r?\n/));
}

/** table 行を cell 配列へ分解する (`\|` エスケープを保持)。 */
function splitRow(line: string): string[] {
  return line
    .replaceAll("\\|", PIPE_PLACEHOLDER)
    .split("|")
    .slice(1, -1)
    .map((c) => c.replaceAll(PIPE_PLACEHOLDER, "|").trim());
}

/** L8 「Resource Kernel物理統合 freeze属性」節の表を読む。 */
export function parseFreezeAttributeRows(l8Markdown: string): FreezeAttributeRow[] {
  const section = sliceSection(l8Markdown, "### Resource Kernel物理統合 freeze属性");
  const rows: FreezeAttributeRow[] = [];
  for (const line of section.split(/\r?\n/)) {
    if (!line.startsWith("| `IT-RGK-PHYS-")) continue;
    const cells = splitRow(line);
    if (cells.length !== 7) {
      rows.push({
        id: `${cells[0] ?? "?"} (columns=${cells.length})`,
        lane: "",
        platform: "",
        fixture: "",
        observation: "",
        negativeExpected: "",
        createdCount: "",
      });
      continue;
    }
    rows.push({
      id: cells[0].replaceAll("`", ""),
      lane: cells[1],
      platform: cells[2],
      fixture: cells[3],
      observation: cells[4],
      negativeExpected: cells[5],
      createdCount: cells[6],
    });
  }
  return rows;
}

/** L5-25 §7.1 の全数写像表を読む。被覆列の 3 桁表記を full oracle ID へ展開する。 */
export function parseContractMappingRows(l5Markdown: string): ContractMappingRow[] {
  const section = sliceSection(l5Markdown, "### 7.1 ");
  const rows: ContractMappingRow[] = [];
  for (const line of section.split(/\r?\n/)) {
    if (!line.startsWith("| `C-RGK-")) continue;
    const cells = splitRow(line);
    const oracles = [...(cells[3] ?? "").matchAll(/`(\d{3})`/g)].map((m) => `IT-RGK-PHYS-${m[1]}`);
    rows.push({
      contractId: (cells[0] ?? "").replaceAll("`", ""),
      source: cells[1] ?? "",
      oracles,
    });
  }
  return rows;
}

/**
 * L8 散文の lane 別内訳 (「- `mock` 27 件: `001`、…」の再掲一覧) と、実 runner 合計の宣言文を読む。
 * 表の `lane` 列が正本であり、この宣言は同じ集合の再掲である、という L8 の主張自体を機械照合する
 * (Codex closing review FLAG 2026-07-30 attack 3: 分布が doctor 強制されず全 mock 化でも green だった)。
 */
export function parseLaneDeclarations(l8Markdown: string): LaneDeclaration[] {
  const section = sliceSection(l8Markdown, "### Resource Kernel物理統合 freeze属性");
  const declarations: LaneDeclaration[] = [];
  for (const line of section.split(/\r?\n/)) {
    const match = /^-\s*`([^`]+)`\s*(\d+)\s*件\s*[::]\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    if (!(ALLOWED_LANES as readonly string[]).includes(match[1])) continue;
    declarations.push({
      lane: match[1],
      declaredCount: Number(match[2]),
      ids: [...match[3].matchAll(/`(\d{3})`/g)].map((m) => `IT-RGK-PHYS-${m[1]}`),
    });
  }
  return declarations;
}

/** 「`real-OS` 6 件 + `mock+real-OS` 9 件 = 15 件」の宣言合計を読む (無ければ null)。 */
export function parseRealRunnerTotal(l8Markdown: string): number | null {
  const section = sliceSection(l8Markdown, "### Resource Kernel物理統合 freeze属性");
  const match = /`real-OS`\s*\d+\s*件\s*\+\s*`mock\+real-OS`\s*\d+\s*件\s*=\s*(\d+)\s*件/.exec(
    section,
  );
  return match ? Number(match[1]) : null;
}

/** freeze 表と写像表を突合し、双方向の孤児と属性欠落を返す。 */
export function analyzeResourceKernelPairMapping(input: {
  freezeRows: FreezeAttributeRow[];
  mappingRows: ContractMappingRow[];
  laneDeclarations?: LaneDeclaration[];
  declaredRealRunnerTotal?: number | null;
}): ResourceKernelPairMappingResult {
  const freezeIds = new Set(input.freezeRows.map((r) => r.id));
  const mappedIds = new Set(input.mappingRows.flatMap((r) => r.oracles));

  const oraclesMissingFromMapping = [...freezeIds].filter((id) => !mappedIds.has(id)).sort();
  const oraclesMissingFromFreeze = [...mappedIds].filter((id) => !freezeIds.has(id)).sort();

  const rowsWithEmptyAttribute = input.freezeRows
    .filter((r) =>
      [r.lane, r.platform, r.fixture, r.observation, r.negativeExpected, r.createdCount].some(
        isBlankMarkdownCell,
      ),
    )
    .map((r) => r.id)
    .sort();

  const rowsWithUnknownLane = input.freezeRows
    .filter((r) => !(ALLOWED_LANES as readonly string[]).includes(r.lane))
    .map((r) => r.id)
    .sort();

  const contractsWithoutOracle = input.mappingRows
    .filter((r) => r.oracles.length === 0)
    .map((r) => r.contractId)
    .sort();

  // 契約側 exact 集合 (C-RGK-01..58): 欠番 / 未知 ID / 重複を機械検査する。
  // 42 oracle 側の双方向孤児 0 だけでは「契約行を 1 本削っても残りが 42 を覆えば通る」ため、
  // 58 分割の全数性そのものを検査対象にする。
  const contractIdOccurrences = new Map<string, number>();
  for (const r of input.mappingRows) {
    contractIdOccurrences.set(r.contractId, (contractIdOccurrences.get(r.contractId) ?? 0) + 1);
  }
  const expectedSet = new Set(EXPECTED_CONTRACT_IDS);
  const contractIdsUnknown = [...contractIdOccurrences.keys()]
    .filter((id) => !expectedSet.has(id))
    .sort();
  const contractIdsMissing = EXPECTED_CONTRACT_IDS.filter(
    (id) => !contractIdOccurrences.has(id),
  ).sort();
  const contractIdsDuplicated = [...contractIdOccurrences.entries()]
    .filter(([, n]) => n > 1)
    .map(([id]) => id)
    .sort();

  const contractsWithInvalidSource = input.mappingRows
    .filter((r) => !CONTRACT_SOURCE_PATTERN.test(r.source.trim()))
    .map((r) => r.contractId)
    .sort();

  const laneCounts: Record<string, number> = {};
  for (const r of input.freezeRows) laneCounts[r.lane] = (laneCounts[r.lane] ?? 0) + 1;

  // oracle 側 exact 集合 (IT-RGK-PHYS-001..042): 欠番 / 未知 ID / 重複。
  // Set 化前の生の行列を数えるので、重複行を足しても吸収されない。
  const oracleOccurrences = new Map<string, number>();
  for (const r of input.freezeRows) {
    oracleOccurrences.set(r.id, (oracleOccurrences.get(r.id) ?? 0) + 1);
  }
  const expectedOracleSet = new Set(EXPECTED_ORACLE_IDS);
  const oracleIdsMissing = EXPECTED_ORACLE_IDS.filter((id) => !oracleOccurrences.has(id)).sort();
  const oracleIdsUnknown = [...oracleOccurrences.keys()]
    .filter((id) => !expectedOracleSet.has(id))
    .sort();
  const oracleIdsDuplicated = [...oracleOccurrences.entries()]
    .filter(([, n]) => n > 1)
    .map(([id]) => id)
    .sort();

  // lane 分布: 散文の再掲一覧 (宣言) と表の lane 列 (正本) を集合として突合する。
  // 宣言不在も violation にする (宣言を消せば検査が消える fail-open を作らない)。
  const declarations = input.laneDeclarations ?? [];
  const declaredLanes = new Set(declarations.map((d) => d.lane));
  const declarationOccurrences = new Map<string, number>();
  for (const declaration of declarations) {
    declarationOccurrences.set(
      declaration.lane,
      (declarationOccurrences.get(declaration.lane) ?? 0) + 1,
    );
  }
  const laneDeclarationsMissing = (ALLOWED_LANES as readonly string[])
    .filter((lane) => !declaredLanes.has(lane))
    .sort();
  const laneDeclarationsDuplicated = [...declarationOccurrences.entries()]
    .filter(([, count]) => count > 1)
    .map(([lane]) => lane)
    .sort();
  const laneCountMismatch = ALLOWED_LANES.flatMap((lane) => {
    const actual = laneCounts[lane] ?? 0;
    const expected = EXPECTED_LANE_COUNTS[lane];
    return actual === expected ? [] : [{ lane, expected, actual }];
  });
  const laneDeclarationMismatch: ResourceKernelPairMappingResult["laneDeclarationMismatch"] = [];
  for (const declaration of declarations) {
    const tableIds = input.freezeRows
      .filter((r) => r.lane === declaration.lane)
      .map((r) => r.id)
      .sort();
    const declaredIds = [...declaration.ids].sort();
    const tableSet = new Set(tableIds);
    const declaredSet = new Set(declaredIds);
    const onlyInDeclaration = declaredIds.filter((id) => !tableSet.has(id));
    const onlyInTable = tableIds.filter((id) => !declaredSet.has(id));
    if (
      onlyInDeclaration.length > 0 ||
      onlyInTable.length > 0 ||
      declaration.declaredCount !== declaredIds.length ||
      declaration.declaredCount !== tableIds.length
    ) {
      laneDeclarationMismatch.push({
        lane: declaration.lane,
        declaredCount: declaration.declaredCount,
        declaredIdCount: declaredIds.length,
        tableCount: tableIds.length,
        onlyInDeclaration,
        onlyInTable,
      });
    }
  }

  // 実 runner lane の合計。0 件 (全 mock 化) は設計上不正なので、宣言が無くても violation。
  const countedRealRunner = REAL_RUNNER_LANES.reduce(
    (sum, lane) => sum + (laneCounts[lane] ?? 0),
    0,
  );
  const declaredRealRunnerTotal = input.declaredRealRunnerTotal ?? null;
  const realRunnerTotalMismatch =
    declaredRealRunnerTotal === null || declaredRealRunnerTotal !== countedRealRunner
      ? { declared: declaredRealRunnerTotal, counted: countedRealRunner }
      : countedRealRunner === 0
        ? { declared: declaredRealRunnerTotal, counted: 0 }
        : null;

  return {
    oracleIdsMissing,
    oracleIdsUnknown,
    oracleIdsDuplicated,
    laneDeclarationsMissing,
    laneDeclarationsDuplicated,
    laneCountMismatch,
    laneDeclarationMismatch,
    realRunnerTotalMismatch,
    oraclesMissingFromMapping,
    oraclesMissingFromFreeze,
    rowsWithEmptyAttribute,
    rowsWithUnknownLane,
    contractsWithoutOracle,
    contractIdsUnknown,
    contractIdsMissing,
    contractIdsDuplicated,
    contractsWithInvalidSource,
    laneCounts,
    ok:
      oracleIdsMissing.length === 0 &&
      oracleIdsUnknown.length === 0 &&
      oracleIdsDuplicated.length === 0 &&
      laneDeclarationsMissing.length === 0 &&
      laneDeclarationsDuplicated.length === 0 &&
      laneCountMismatch.length === 0 &&
      laneDeclarationMismatch.length === 0 &&
      realRunnerTotalMismatch === null &&
      oraclesMissingFromMapping.length === 0 &&
      oraclesMissingFromFreeze.length === 0 &&
      rowsWithEmptyAttribute.length === 0 &&
      rowsWithUnknownLane.length === 0 &&
      contractsWithoutOracle.length === 0 &&
      contractIdsUnknown.length === 0 &&
      contractIdsMissing.length === 0 &&
      contractIdsDuplicated.length === 0 &&
      contractsWithInvalidSource.length === 0,
  };
}

/** 失敗時の人間向け説明。 */
export function resourceKernelPairMappingMessages(r: ResourceKernelPairMappingResult): string[] {
  const msgs: string[] = [];
  if (r.oracleIdsMissing.length > 0) {
    msgs.push(
      `期待集合 IT-RGK-PHYS-001..${String(EXPECTED_ORACLE_COUNT).padStart(3, "0")} の欠番: ${r.oracleIdsMissing.join(", ")}`,
    );
  }
  if (r.oracleIdsUnknown.length > 0) {
    msgs.push(`期待集合外の oracle ID: ${r.oracleIdsUnknown.join(", ")}`);
  }
  if (r.oracleIdsDuplicated.length > 0) {
    msgs.push(`freeze 属性表で重複する oracle ID: ${r.oracleIdsDuplicated.join(", ")}`);
  }
  if (r.laneDeclarationsMissing.length > 0) {
    msgs.push(`lane 別内訳の宣言が無い lane: ${r.laneDeclarationsMissing.join(", ")}`);
  }
  if (r.laneDeclarationsDuplicated.length > 0) {
    msgs.push(`lane 別内訳の宣言が重複する lane: ${r.laneDeclarationsDuplicated.join(", ")}`);
  }
  for (const mismatch of r.laneCountMismatch) {
    msgs.push(
      `lane 固定件数不一致 (${mismatch.lane}): 期待 ${mismatch.expected} 件 / 実数 ${mismatch.actual} 件`,
    );
  }
  for (const m of r.laneDeclarationMismatch) {
    msgs.push(
      `lane 分布不一致 (${m.lane}): 宣言 ${m.declaredCount} 件 / 宣言 ID ${m.declaredIdCount} 件 / 表 ${m.tableCount} 件` +
        (m.onlyInDeclaration.length > 0 ? `、宣言のみ: ${m.onlyInDeclaration.join(", ")}` : "") +
        (m.onlyInTable.length > 0 ? `、表のみ: ${m.onlyInTable.join(", ")}` : ""),
    );
  }
  if (r.realRunnerTotalMismatch) {
    const { declared, counted } = r.realRunnerTotalMismatch;
    msgs.push(
      counted === 0
        ? `実 runner lane (${REAL_RUNNER_LANES.join(" / ")}) が 0 件 — 全 mock 化された freeze は confirmed 昇格条件を消すため不正`
        : `実 runner lane 合計の宣言 (${declared ?? "宣言なし"}) と実数 (${counted}) が不一致`,
    );
  }
  if (r.oraclesMissingFromMapping.length > 0) {
    msgs.push(
      `PLAN-L5-25 §7.1 の全数写像に現れない L8 oracle: ${r.oraclesMissingFromMapping.join(", ")}`,
    );
  }
  if (r.oraclesMissingFromFreeze.length > 0) {
    msgs.push(
      `写像表が参照するが L8 freeze 属性表に実在しない oracle: ${r.oraclesMissingFromFreeze.join(", ")}`,
    );
  }
  if (r.rowsWithEmptyAttribute.length > 0) {
    msgs.push(`freeze 属性が欠けている行: ${r.rowsWithEmptyAttribute.join(", ")}`);
  }
  if (r.rowsWithUnknownLane.length > 0) {
    msgs.push(
      `lane 語彙外 (${ALLOWED_LANES.join(" / ")}) の行: ${r.rowsWithUnknownLane.join(", ")}`,
    );
  }
  if (r.contractsWithoutOracle.length > 0) {
    msgs.push(`被覆 oracle 0 件の物理契約: ${r.contractsWithoutOracle.join(", ")}`);
  }
  if (r.contractIdsMissing.length > 0) {
    msgs.push(
      `期待集合 C-RGK-01..${EXPECTED_CONTRACT_COUNT} の欠番: ${r.contractIdsMissing.join(", ")}`,
    );
  }
  if (r.contractIdsUnknown.length > 0) {
    msgs.push(`期待集合外の契約 ID: ${r.contractIdsUnknown.join(", ")}`);
  }
  if (r.contractIdsDuplicated.length > 0) {
    msgs.push(`重複する契約 ID: ${r.contractIdsDuplicated.join(", ")}`);
  }
  if (r.contractsWithInvalidSource.length > 0) {
    msgs.push(`出典が §1〜§6 の正規範囲外の契約行: ${r.contractsWithInvalidSource.join(", ")}`);
  }
  return msgs;
}
