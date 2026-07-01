/**
 * 工程表 registry — PLAN-DISCOVERY-05 (poc spike)。
 *
 * master-hub PLAN frontmatter の `roadmap:` block を読み、第一級登録工程表として扱う:
 *  - extractRoadmap / parseRoadmap: frontmatter から roadmap を抽出・schema 検証。
 *  - checkSpanExistence: span.plan_id が docs/plans に実在するか (孤児 span = 統制漏れ)。
 *  - computeGateProgress: 各層内ゲートの到達状況 (直前 span PLAN が全 confirmed か) を surface。
 *  - loadRoadmaps: docs/plans/ の登録工程表を全 load (doctor surface 用)。
 *
 * 配置 = src/lint (既存 module、新 src/roadmap module を作ると module-drift 孤児になるため spike は
 * lint 配下に寄せる。S4 confirmed 後に dedicated module 化を Reverse で判断)。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { type Roadmap, roadmapSchema, validateRoadmapStructure } from "../schema/roadmap";
import { fmValue } from "./shared";

/** content から frontmatter block (先頭 `---` 〜 次 `---`) のテキストを返す。無ければ null。 */
function frontmatterBlock(content: string): string | null {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m?.[1] ?? null;
}

/** frontmatter YAML から `roadmap:` subtree (raw) を抽出。無ければ null。 */
export function extractRoadmap(content: string): unknown {
  const fm = frontmatterBlock(content);
  if (fm === null) return null;
  let doc: unknown;
  try {
    doc = parseYaml(fm);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;
  const roadmap = (doc as Record<string, unknown>).roadmap;
  return roadmap ?? null;
}

/**
 * roadmap を抽出 + schema + 構造整合検証。errors = YAML parse 失敗 ∪ schema 違反 ∪ 構造 issue。
 * roadmap 不在 (frontmatter なし / roadmap key なし) は {null, []}。
 * I-2: YAML 破損を無音スキップせず errors に surface する (「検出したフリ」防止、coverage≠substance)。
 */
export function parseRoadmap(content: string): { roadmap: Roadmap | null; errors: string[] } {
  const fm = frontmatterBlock(content);
  if (fm === null) return { roadmap: null, errors: [] };
  let doc: unknown;
  try {
    doc = parseYaml(fm);
  } catch (e) {
    return { roadmap: null, errors: [`frontmatter YAML parse error: ${String(e)}`] };
  }
  if (!doc || typeof doc !== "object") return { roadmap: null, errors: [] };
  const raw = (doc as Record<string, unknown>).roadmap;
  if (raw === undefined || raw === null) return { roadmap: null, errors: [] };
  const parsed = roadmapSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      roadmap: null,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "roadmap"}: ${i.message}`),
    };
  }
  const structure = validateRoadmapStructure(parsed.data);
  return { roadmap: parsed.data, errors: structure.map((s) => s.message) };
}

/** span.plan_id が既知 PLAN 集合に実在するか。実在しない span = 孤児 (統制漏れ)。 */
export function checkSpanExistence(roadmap: Roadmap, knownPlanIds: Set<string>): string[] {
  return roadmap.spans
    .filter((s) => !knownPlanIds.has(s.plan_id))
    .map((s) => `工程表 span PLAN 不在 (孤児): ${s.plan_id}`);
}

export interface GateProgress {
  gateId: string;
  totalSpans: number;
  confirmedSpans: number;
  reached: boolean;
}

/**
 * 各層内ゲートの到達状況。gate に到達 = その直前 (before_gate) の span PLAN が**全て** confirmed/completed。
 * confirmedSpans は互換のため名称維持し、confirmed または completed の到達計数 span を表す。
 * span 0 の gate は vacuous reached を避け未到達扱い (coverage≠substance、空集合で偽 green を出さない)。
 */
export function computeGateProgress(
  roadmap: Roadmap,
  statusOf: (planId: string) => string | null,
): GateProgress[] {
  return roadmap.gates.map((g) => {
    const spans = roadmap.spans.filter((s) => s.before_gate === g.id);
    const confirmedSpans = spans.filter((s) =>
      ["confirmed", "completed"].includes(statusOf(s.plan_id) ?? ""),
    ).length;
    const reached = spans.length > 0 && confirmedSpans === spans.length;
    return { gateId: g.id, totalSpans: spans.length, confirmedSpans, reached };
  });
}

export interface RoadmapRecord {
  planId: string;
  file: string;
  roadmap: Roadmap;
  errors: string[];
}

/**
 * forward プログラムのバンド (band) = 工程表 (roadmap) 登録が期待される機能群塊の単一正本。
 * 工程表の定義 = 人間向け**全プログラム台帳** (concept §10.2 [[全プログラム被覆]])。
 * band は roadmap.layer の集合で表し、roadmap.layer ∈ band.layers なら当該 band を被覆とみなす。
 * PLAN-RECOVERY-04 (定義) / PLAN-REVERSE-44 (設計書)。
 * 直書き根拠: forward V-model のバンド分割は concept §2.3 / §10.3 [[検証層群]] と対応する固定構造であり、
 * 単一正本としてここに集約する (散在禁止、CLAUDE.md ハードコード規約)。
 */
export interface ProgramBand {
  id: string;
  name: string;
  /** この band を被覆とみなす roadmap.layer 値の集合。 */
  layers: string[];
}

export const PROGRAM_BANDS: ProgramBand[] = [
  { id: "upstream", name: "上流 (要求〜要件 L0-L3)", layers: ["L0", "L1", "L2", "L3"] },
  { id: "design", name: "設計 (基本〜機能 L4-L6)", layers: ["L4", "L5", "L6"] },
  { id: "impl", name: "実装+谷 (L7)", layers: ["L7"] },
  {
    id: "verification",
    name: "検証 (結合〜運用 L8-L14)",
    layers: ["L8", "L9", "L10", "L11", "L12", "L13", "L14"],
  },
  // roadmap.layer は schema 上 z.string() (自由文字列、L 番号に限定しない) なので "cutover" は valid。
  // cutover 工程表が未登録の間は意図的に uncovered (= 残り frontier) として surface される。
  { id: "cutover", name: "cutover (legacy-source isolation)", layers: ["cutover"] },
];

/**
 * 明示 defer (park) バンド = forward 未降下で登録対象 PLAN 皆無のバンド (concept §3.1.3.1 正規 defer)。
 * 単一正本 (bandId → reason、CLAUDE.md ハードコード規約: 根拠コメント + 集約)。RECOVERY-04 §5 で宣言済。
 * park 宣言 band は uncovered から除外するが、reason を必ず surface して残り forward work を隠さない
 * ([[feedback_coverage_not_substance]] silent truncation 禁止)。covered な band は park 指定でも covered 優先。
 */
export const PARKED_BANDS: Map<string, string> = new Map([
  ["verification", "forward 未降下 (L8-L14 PLAN 皆無)。降下時に当該 Forward PLAN が工程表を起こす"],
  [
    "cutover",
    "legacy-source isolation cutover は harness.db (PLAN-L7-44) close 後の射程。cutover 戦略 doc stale → Reverse back-fill 先行",
  ],
]);

export interface BandCoverage {
  band: ProgramBand;
  covered: boolean;
  /** この band を被覆する登録工程表の planId 群。 */
  roadmaps: string[];
}

export interface ProgramCoverageResult {
  coverage: BandCoverage[];
  parked: BandCoverage[];
  /** 未登録 (park 宣言もない) band。「実装どこまで?」の残り frontier。 */
  uncovered: BandCoverage[];
}

/**
 * 全プログラム被覆 (program coverage): 工程表 (roadmap) が forward 全バンドを被覆するか。
 * roadmap.layer が band.layers に属せば当該 band を被覆。park 宣言 band は uncovered から除外
 * (明示 defer = under-design でない、concept §3.1.3.1)。fail-close (doctor.ok 非連動、spike 段階)。
 */
export function analyzeProgramCoverage(
  records: RoadmapRecord[],
  parkedBandIds: Set<string> = new Set(),
): ProgramCoverageResult {
  const coverage: BandCoverage[] = PROGRAM_BANDS.map((band) => {
    const roadmaps = records
      .filter((r) => band.layers.includes(r.roadmap.layer))
      .map((r) => r.planId);
    return { band, covered: roadmaps.length > 0, roadmaps };
  });
  const parked = coverage.filter((c) => !c.covered && parkedBandIds.has(c.band.id));
  const uncovered = coverage.filter((c) => !c.covered && !parkedBandIds.has(c.band.id));
  return { coverage, parked, uncovered };
}

/** doctor surface 用メッセージ (fail-close)。 */
export function programCoverageMessages(result: ProgramCoverageResult): string[] {
  const covered = result.coverage.filter((c) => c.covered).length;
  const total = result.coverage.length;
  const parked = result.parked;
  const uncovered = result.uncovered;
  const parkedDetails = parked
    .map((c) => `${c.band.id}: ${PARKED_BANDS.get(c.band.id) ?? "parked"}`)
    .join("; ");
  if (uncovered.length === 0) {
    return [
      `program-coverage — OK (forward ${total} バンド、登録 ${covered} / park ${parked.length}${parkedDetails ? ` [${parkedDetails}]` : ""}、未登録 (park 除く) なし)`,
    ];
  }
  const missing = uncovered.map((c) => `${c.band.id}(${c.band.name})`).join(", ");
  const parkSuffix = parkedDetails ? `、park ${parked.length}: ${parkedDetails}` : "";
  return [
    `program-coverage — ⚠ ${covered}/${total} バンド登録、未登録 ${uncovered.length} 件: ${missing}${parkSuffix}。工程表 (roadmap) 未登録の forward work = 「実装どこまで?」の残り frontier (PLAN-RECOVERY-04、fail-close)`,
  ];
}

export interface ProgramRollup {
  totalBands: number;
  coveredBands: number;
  parkedBands: number;
  uncoveredBands: number;
  totalGates: number;
  reachedGates: number;
  totalSpans: number;
  confirmedSpans: number;
  frontier: string[];
  perBand: Array<{
    bandId: string;
    name: string;
    status: "covered" | "parked" | "uncovered";
    roadmaps: string[];
  }>;
}

/**
 * Program-level summary for roadmap registry consumers. Band accounting is kept separate from
 * gate/span progress so parked forward bands stay visible without becoming uncovered work.
 */
export function computeProgramRollup(
  records: RoadmapRecord[],
  statusOf: (planId: string) => string | null,
  parkedBandIds: Set<string> = new Set(),
): ProgramRollup {
  const coverage = analyzeProgramCoverage(records, parkedBandIds);
  const progressByRecord = records.map((record) => ({
    record,
    progress: computeGateProgress(record.roadmap, statusOf),
  }));
  const gateProgress = progressByRecord.flatMap((entry) => entry.progress);
  const frontier = Array.from(
    new Set([
      ...coverage.uncovered.map((c) => c.band.id),
      ...progressByRecord
        .filter((entry) => entry.progress.some((g) => !g.reached))
        .map((entry) => entry.record.planId),
    ]),
  );
  const parkedBandIdsInResult = new Set(coverage.parked.map((c) => c.band.id));
  const perBand = coverage.coverage.map((c) => ({
    bandId: c.band.id,
    name: c.band.name,
    status: c.covered
      ? ("covered" as const)
      : parkedBandIdsInResult.has(c.band.id)
        ? ("parked" as const)
        : ("uncovered" as const),
    roadmaps: c.roadmaps,
  }));

  return {
    totalBands: coverage.coverage.length,
    coveredBands: coverage.coverage.filter((c) => c.covered).length,
    parkedBands: coverage.parked.length,
    uncoveredBands: coverage.uncovered.length,
    totalGates: gateProgress.length,
    reachedGates: gateProgress.filter((g) => g.reached).length,
    totalSpans: gateProgress.reduce((sum, g) => sum + g.totalSpans, 0),
    confirmedSpans: gateProgress.reduce((sum, g) => sum + g.confirmedSpans, 0),
    frontier,
    perBand,
  };
}

/** docs/plans/ から `roadmap:` block を持つ登録工程表を全 load。 */
export function loadRoadmaps(repoRoot: string = process.cwd()): RoadmapRecord[] {
  const dir = join(repoRoot, "docs", "plans");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const records: RoadmapRecord[] = [];
  for (const f of files) {
    const content = readFileSync(join(dir, f), "utf8");
    const { roadmap, errors } = parseRoadmap(content);
    if (roadmap) {
      records.push({
        planId: fmValue(content, "plan_id") ?? f.replace(/\.md$/, ""),
        file: `docs/plans/${f}`,
        roadmap,
        errors,
      });
    }
  }
  return records;
}
