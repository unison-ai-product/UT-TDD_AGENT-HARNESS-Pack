/**
 * vmodel pair-freeze lint — 設計層 pair freeze 検証 (IMP-067、PLAN-L6-10 / L7-11)。
 *
 * design doc (① 設計) ⇔ test-design doc (③ テスト設計) の pair_artifact 双方向整合・孤児0 を検査する。
 * function-spec §4 の rule 1 pair-exists / rule 2 ref-resolves / rule 3 trace-bidir の最小インスタンス化で、
 * G1-G6 各層の pair freeze を機械担保する (requirements §6.8.3 = 設計 PLAN 完了 PR の vmodel-lint 必須に接続)。
 *
 * スコープ外: G7 の 4 artifact 12 directed edge trace (function-spec §2.3 traceCheck / requirements §2.4)。
 * 本 lint は設計層の ①⇔③ pair のみを見る (L7 trace freeze は別マイルストーン)。
 *
 * 純関数 (analyzePairFreeze) + I/O loader (loadPairDocs) を分離 (backfill-pairing と同方針)。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fmValue } from "../lint/shared.ts";
import type { LintResult } from "../plan/lint.ts";

export interface PairDoc {
  /** repo 相対 path (forward slash 正規化)。 */
  path: string;
  layer: string | null;
  /** pair_artifact 値 (inline コメント除去済)。null = フィールド欠落。 */
  pairArtifact: string | null;
  /** frontmatter status (confirmed/draft/placeholder 等)。null = 欠落。検証発火の freeze 判定に使う。 */
  status: string | null;
  /** additive revision は既存base freezeとは別frontierとして集計する。 */
  revisionTrack?: string | null;
  revisionBaseArtifact?: string | null;
  nextPairFreeze?: string | null;
  content?: string;
}

export type PairOrphanReason =
  | "pair-missing"
  | "ref-unresolved"
  | "trace-orphan"
  | "revision-base-invalid";

export interface PairOrphan {
  path: string;
  reason: PairOrphanReason;
  detail: string;
}

export interface PairFreezeResult {
  orphans: PairOrphan[];
  /** 双方向成立した pair 数。 */
  pairs: number;
  ok: boolean;
}

/** 検査対象外の index/living doc (basename 固定リスト、vmodel-pair-freeze.md §3)。 */
const EXCLUDED_BASENAMES = new Set(["README.md", "roadmap.md"]);

/** frontmatter 値の inline コメント (`  # ...`) を除去 (`<path>  # L2↔L10 pair` → `<path>`)。 */
export function stripInlineComment(value: string): string {
  return value.replace(/\s+#.*$/, "").trim();
}

const toPosix = (p: string): string => p.split(sep).join("/");
const basename = (p: string): string => p.split("/").pop() ?? p;
/** 末尾 "/" 込みの親 dir。 */
const dirOf = (p: string): string => p.slice(0, p.lastIndexOf("/") + 1);

/**
 * docs/design/harness/L<N>-*​/<file>.md (N=1-6) の sub-doc 層を path から判定。
 * frontmatter `layer` 欠落でも対象に入れる (layer/pair を持たない L6 doc が検査を素通りする穴を塞ぐ、IMP-067)。
 */
export function designLayerFromPath(path: string): string | null {
  return path.match(/^docs\/design\/harness\/(L[1-6])-[^/]+\/[^/]+\.md$/)?.[1] ?? null;
}

/** 検査対象の設計 sub-doc か (L1-L6 サブディレクトリ配下、README/roadmap は除外)。 */
export function isDesignSubDoc(d: PairDoc): boolean {
  if (EXCLUDED_BASENAMES.has(basename(d.path))) return false;
  return designLayerFromPath(d.path) != null;
}

export function parsePairDoc(path: string, content: string): PairDoc {
  const raw = fmValue(content, "pair_artifact");
  return {
    path: toPosix(path),
    layer: fmValue(content, "layer") ?? null,
    pairArtifact: raw != null ? stripInlineComment(raw) : null,
    status: fmValue(content, "status") ?? null,
    revisionTrack: fmValue(content, "revision_track") ?? null,
    revisionBaseArtifact: fmValue(content, "revision_base_artifact") ?? null,
    nextPairFreeze: fmValue(content, "next_pair_freeze") ?? null,
    content,
  };
}

function isValidAdditiveRevision(doc: PairDoc, docsByPath: Map<string, PairDoc>): boolean {
  if (doc.revisionTrack !== "additive" || !doc.revisionBaseArtifact) return false;
  const base = docsByPath.get(doc.revisionBaseArtifact);
  const sameFamily = base
    ? doc.path.startsWith("docs/design/") === base.path.startsWith("docs/design/")
    : false;
  return Boolean(
    base &&
      base.revisionTrack !== "additive" &&
      (base.status === "confirmed" || base.status === "completed") &&
      base.layer === doc.layer &&
      sameFamily,
  );
}

/**
 * 設計層 pair freeze を分析 (純関数、I/O なし)。
 * @param docs design + test-design の全 PairDoc
 */
export function analyzePairFreeze(docs: PairDoc[]): PairFreezeResult {
  const byPath = new Map(docs.map((d) => [d.path, d]));
  const orphans: PairOrphan[] = [];
  const invalidRevisionPaths = new Set(
    docs
      .filter((doc) => doc.revisionTrack === "additive" && !isValidAdditiveRevision(doc, byPath))
      .map((doc) => doc.path),
  );
  for (const path of invalidRevisionPaths) {
    const doc = byPath.get(path);
    if (!doc) continue;
    orphans.push({
      path,
      reason: "revision-base-invalid",
      detail: doc.revisionBaseArtifact ?? "missing revision_base_artifact",
    });
  }
  let pairs = 0;

  for (const d of docs) {
    if (!isDesignSubDoc(d)) continue;
    if (invalidRevisionPaths.has(d.path)) continue;
    const pa = d.pairArtifact;
    // rule 1 pair-exists (frontmatter layer 欠落時は path から層を補完して表示)
    if (pa == null) {
      const layer = d.layer ?? designLayerFromPath(d.path);
      orphans.push({ path: d.path, reason: "pair-missing", detail: `layer ${layer}` });
      continue;
    }
    // rule 2 ref-resolves
    const target = byPath.get(pa);
    if (!target) {
      orphans.push({ path: d.path, reason: "ref-unresolved", detail: pa });
      continue;
    }
    if (invalidRevisionPaths.has(target.path)) {
      orphans.push({
        path: d.path,
        reason: "revision-base-invalid",
        detail: `${target.path} has an invalid revision base`,
      });
      continue;
    }
    // rule 3 trace-bidir
    if (pa.startsWith("docs/test-design/")) {
      // test-design 側は design dir の集合参照。design の所在 dir を含めば双方向成立。
      const back = target.pairArtifact;
      const dir = dirOf(d.path);
      const normBack = back ? (back.endsWith("/") ? back : `${back}/`) : null;
      if (back === d.path || (normBack && dir.startsWith(normBack))) {
        pairs++;
      } else {
        orphans.push({
          path: d.path,
          reason: "trace-orphan",
          detail: `${pa} が ${dir} を逆参照しない`,
        });
      }
    } else {
      // design→design 参照 (旧 L2 group hub) と self は非対応 (PLAN-RECOVERY-09 で self-pair 例外を撤去)。
      orphans.push({ path: d.path, reason: "ref-unresolved", detail: `未知の pair 形式: ${pa}` });
    }
  }

  return { orphans, pairs, ok: orphans.length === 0 };
}

/** dir を再帰し .md の (repo 相対 path, 本文) を集める。 */
function walkMd(dir: string, repoRoot: string): { rel: string; content: string }[] {
  const out: { rel: string; content: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkMd(full, repoRoot));
    } else if (entry.name.endsWith(".md")) {
      out.push({ rel: toPosix(relative(repoRoot, full)), content: readFileSync(full, "utf8") });
    }
  }
  return out;
}

/** docs/design/harness/** + docs/test-design/harness/** の全 .md frontmatter を読む。 */
export function loadPairDocs(repoRoot: string = process.cwd()): PairDoc[] {
  const docs: PairDoc[] = [];
  for (const base of ["docs/design/harness", "docs/test-design/harness"]) {
    for (const { rel, content } of walkMd(join(repoRoot, base), repoRoot)) {
      docs.push(parsePairDoc(rel, content));
    }
  }
  return docs;
}

/** doctor / CLI 向けの 1 行サマリ群 (ok は呼び出し側で gate 判定に使う)。 */
export function pairFreezeMessages(result: PairFreezeResult): string[] {
  if (result.orphans.length === 0) {
    return [`pair-freeze — OK (design⇔test-design 双方向 ${result.pairs} pair、孤児 0)`];
  }
  const label: Record<PairOrphanReason, string> = {
    "pair-missing": "pair 欠落",
    "ref-unresolved": "参照不実在",
    "trace-orphan": "逆参照なし",
    "revision-base-invalid": "revision base 不正",
  };
  const msgs: string[] = [];
  for (const reason of [
    "pair-missing",
    "ref-unresolved",
    "trace-orphan",
    "revision-base-invalid",
  ] as PairOrphanReason[]) {
    const hits = result.orphans.filter((o) => o.reason === reason);
    if (hits.length === 0) continue;
    const list = hits.map((o) => `${o.path} (${o.detail})`).join(", ");
    msgs.push(`pair-freeze — ⚠ ${label[reason]} ${hits.length} 件: ${list}`);
  }
  return msgs;
}

export type ForwardFreezeContractViolationReason =
  | "l2-doc-missing"
  | "l2-status-not-confirmed"
  | "l2-pair-mismatch"
  | "l2-next-freeze-mismatch"
  | "l2-prototype-evidence-missing"
  | "l5-doc-missing"
  | "l5-status-not-confirmed"
  | "l5-pair-mismatch"
  | "l5-next-freeze-mismatch"
  | "l8-test-design-missing"
  | "l8-test-design-not-confirmed"
  | "l8-pair-mismatch"
  | "l8-execution-layer-mismatch"
  | "l8-coverage-missing"
  | "l8-gwt-missing";

export interface ForwardFreezeContractViolation {
  path: string;
  reason: ForwardFreezeContractViolationReason;
  detail: string;
}

export interface ForwardFreezeContractResult {
  ok: boolean;
  checked: number;
  l2Docs: number;
  l5Docs: number;
  violations: ForwardFreezeContractViolation[];
}

const REQUIRED_L2_PROTOTYPE_DOCS = [
  "docs/design/harness/L2-screen/business-flow.md",
  "docs/design/harness/L2-screen/screen-detail.md",
  "docs/design/harness/L2-screen/screen-flow.md",
  "docs/design/harness/L2-screen/screen-list.md",
  "docs/design/harness/L2-screen/ui-element.md",
  "docs/design/harness/L2-screen/wireframe.md",
] as const;

const REQUIRED_L5_VERIFICATION_DOCS = [
  "docs/design/harness/L5-detailed-design/if-detail.md",
  "docs/design/harness/L5-detailed-design/internal-processing.md",
  "docs/design/harness/L5-detailed-design/module-decomposition.md",
  "docs/design/harness/L5-detailed-design/physical-data.md",
  "docs/design/harness/L5-detailed-design/ui-detail.md",
] as const;

const L2_TEST_DESIGN = "docs/test-design/harness/L10-ux-validation-test-design.md";
const L5_TEST_DESIGN = "docs/test-design/harness/L8-integration-test-design.md";
const L5_DESIGN_DIR = "docs/design/harness/L5-detailed-design/";

function normalizedStatus(doc: PairDoc | undefined): string {
  return stripInlineComment(doc?.status ?? "").toLowerCase();
}

function normalizedNextPairFreeze(doc: PairDoc | undefined): string {
  return stripInlineComment(doc?.nextPairFreeze ?? "");
}

function hasL2PrototypeEvidence(doc: PairDoc): boolean {
  const text = `${doc.status ?? ""}\n${doc.content ?? ""}`;
  return /G2 freeze|PO|サインオフ|合意|確定|prototype|プロト/.test(text);
}

function hasGwtTable(doc: PairDoc | undefined): boolean {
  const text = doc?.content ?? "";
  return /\|\s*IT-ID\s*\|\s*Given\s*\|\s*When\s*\|\s*Then\s*\|/.test(text);
}

export function analyzeForwardFreezeContracts(docs: PairDoc[]): ForwardFreezeContractResult {
  const byPath = new Map(docs.map((d) => [d.path, d]));
  const violations: ForwardFreezeContractViolation[] = [];

  for (const path of REQUIRED_L2_PROTOTYPE_DOCS) {
    const doc = byPath.get(path);
    if (!doc) {
      violations.push({ path, reason: "l2-doc-missing", detail: "required L2 prototype doc" });
      continue;
    }
    if (normalizedStatus(doc) !== "confirmed") {
      violations.push({
        path,
        reason: "l2-status-not-confirmed",
        detail: doc.status ?? "missing status",
      });
    }
    if (doc.pairArtifact !== L2_TEST_DESIGN) {
      violations.push({
        path,
        reason: "l2-pair-mismatch",
        detail: doc.pairArtifact ?? "missing pair_artifact",
      });
    }
    if (normalizedNextPairFreeze(doc) !== "L10") {
      violations.push({
        path,
        reason: "l2-next-freeze-mismatch",
        detail: doc.nextPairFreeze ?? "missing next_pair_freeze",
      });
    }
    if (!hasL2PrototypeEvidence(doc)) {
      violations.push({
        path,
        reason: "l2-prototype-evidence-missing",
        detail: "G2/PO/prototype agreement marker is required",
      });
    }
  }

  for (const path of REQUIRED_L5_VERIFICATION_DOCS) {
    const doc = byPath.get(path);
    if (!doc) {
      violations.push({ path, reason: "l5-doc-missing", detail: "required L5 detail doc" });
      continue;
    }
    if (normalizedStatus(doc) !== "confirmed") {
      violations.push({
        path,
        reason: "l5-status-not-confirmed",
        detail: doc.status ?? "missing status",
      });
    }
    if (doc.pairArtifact !== L5_TEST_DESIGN) {
      violations.push({
        path,
        reason: "l5-pair-mismatch",
        detail: doc.pairArtifact ?? "missing pair_artifact",
      });
    }
    if (normalizedNextPairFreeze(doc) !== "L8") {
      violations.push({
        path,
        reason: "l5-next-freeze-mismatch",
        detail: doc.nextPairFreeze ?? "missing next_pair_freeze",
      });
    }
  }

  const l8 = byPath.get(L5_TEST_DESIGN);
  if (!l8) {
    violations.push({
      path: L5_TEST_DESIGN,
      reason: "l8-test-design-missing",
      detail: "required L8 verification design",
    });
  } else {
    if (normalizedStatus(l8) !== "confirmed") {
      violations.push({
        path: L5_TEST_DESIGN,
        reason: "l8-test-design-not-confirmed",
        detail: l8.status ?? "missing status",
      });
    }
    if (l8.pairArtifact !== L5_DESIGN_DIR) {
      violations.push({
        path: L5_TEST_DESIGN,
        reason: "l8-pair-mismatch",
        detail: l8.pairArtifact ?? "missing pair_artifact",
      });
    }
    if (fmValue(l8.content ?? "", "executed_at_layer") !== "L8") {
      violations.push({
        path: L5_TEST_DESIGN,
        reason: "l8-execution-layer-mismatch",
        detail: fmValue(l8.content ?? "", "executed_at_layer") ?? "missing executed_at_layer",
      });
    }
    for (const path of REQUIRED_L5_VERIFICATION_DOCS) {
      const name = basename(path);
      if (!(l8.content ?? "").includes(name)) {
        violations.push({
          path: L5_TEST_DESIGN,
          reason: "l8-coverage-missing",
          detail: name,
        });
      }
    }
    if (!hasGwtTable(l8)) {
      violations.push({
        path: L5_TEST_DESIGN,
        reason: "l8-gwt-missing",
        detail: "confirmed IT cases must include Given/When/Then",
      });
    }
  }

  return {
    ok: violations.length === 0,
    checked: REQUIRED_L2_PROTOTYPE_DOCS.length + REQUIRED_L5_VERIFICATION_DOCS.length + 1,
    l2Docs: REQUIRED_L2_PROTOTYPE_DOCS.length,
    l5Docs: REQUIRED_L5_VERIFICATION_DOCS.length,
    violations,
  };
}

export function forwardFreezeContractMessages(result: ForwardFreezeContractResult): string[] {
  if (result.ok) {
    return [
      `forward-freeze-contracts - OK (checked=${result.checked}, l2=${result.l2Docs}, l5=${result.l5Docs})`,
    ];
  }
  return [
    `forward-freeze-contracts - violation (checked=${result.checked}, findings=${result.violations.length})`,
    ...result.violations
      .slice(0, 10)
      .map((v) => `forward-freeze-contracts - ${v.reason}: ${v.path} (${v.detail})`),
  ];
}

/**
 * V-model pair-freeze lint (requirements §6.8.3 / §2 設計層)。
 * 設計層 ①⇔③ pair の双方向整合・孤児0 を検査する。G7 の 4 artifact 12 edge trace は別 (未実装、後続)。
 */
export type RefactorQaReleaseContractViolationReason =
  | "authoring-source-missing"
  | "authoring-source-marker-missing"
  | "refactor-process-marker-missing"
  | "workflow-contract-marker-missing";

export interface RefactorQaReleaseContractViolation {
  path: string;
  reason: RefactorQaReleaseContractViolationReason;
  detail: string;
}

export interface RefactorQaReleaseContractInput {
  authoringSource: string | null;
  refactorProcess: string | null;
  workflowContracts: string | null;
}

export interface RefactorQaReleaseContractResult {
  ok: boolean;
  checked: number;
  violations: RefactorQaReleaseContractViolation[];
}

const REFACTOR_QA_AUTHORING_SOURCE = "docs/governance/vmodel-refactor-qa-release-gates.md";
const REFACTOR_PROCESS_DOC = "docs/process/modes/refactor.md";
const WORKFLOW_CONTRACTS_SOURCE = "src/workflow/contracts.ts";

const REFACTOR_QA_AUTHORING_MARKERS = [
  "VMS-012",
  "VMS-013",
  "循環的複雑度",
  "関数あたり15超",
  "重複コード率",
  "5%超",
  "単体10分超",
  "直近3回中2回リグレッション",
  "振る舞い不変",
  "characterization test",
  "切り戻し",
  "ISO/IEC 25010",
  "Go/No-Go",
  "G01",
  "G08",
  "schedule --live",
  "review --status",
  "スモーク",
  "No-Go",
] as const;

const REFACTOR_PROCESS_MARKERS = [
  "behavior-invariant",
  "assertRefactorInvariant",
  "test IDs",
  "Database-triggered Refactor",
  "vmodel-refactor-qa-release-gates.md",
] as const;

const WORKFLOW_CONTRACT_MARKERS = [
  "assertRefactorInvariant",
  "input.before === input.after",
  "refactor-test-id-missing",
  "linked regression test ids",
] as const;

function missingMarkers(content: string | null, markers: readonly string[]): string[] {
  const text = content ?? "";
  return markers.filter((marker) => !text.includes(marker));
}

export function loadRefactorQaReleaseContractInput(
  repoRoot: string = process.cwd(),
): RefactorQaReleaseContractInput {
  const read = (path: string): string | null => {
    try {
      return readFileSync(join(repoRoot, path), "utf8");
    } catch {
      return null;
    }
  };
  return {
    authoringSource: read(REFACTOR_QA_AUTHORING_SOURCE),
    refactorProcess: read(REFACTOR_PROCESS_DOC),
    workflowContracts: read(WORKFLOW_CONTRACTS_SOURCE),
  };
}

export function analyzeRefactorQaReleaseContracts(
  input: RefactorQaReleaseContractInput,
): RefactorQaReleaseContractResult {
  const violations: RefactorQaReleaseContractViolation[] = [];

  if (input.authoringSource == null) {
    violations.push({
      path: REFACTOR_QA_AUTHORING_SOURCE,
      reason: "authoring-source-missing",
      detail: "ZIP108/109 authoring source is required",
    });
  }

  for (const marker of missingMarkers(input.authoringSource, REFACTOR_QA_AUTHORING_MARKERS)) {
    violations.push({
      path: REFACTOR_QA_AUTHORING_SOURCE,
      reason: "authoring-source-marker-missing",
      detail: marker,
    });
  }

  for (const marker of missingMarkers(input.refactorProcess, REFACTOR_PROCESS_MARKERS)) {
    violations.push({
      path: REFACTOR_PROCESS_DOC,
      reason: "refactor-process-marker-missing",
      detail: marker,
    });
  }

  for (const marker of missingMarkers(input.workflowContracts, WORKFLOW_CONTRACT_MARKERS)) {
    violations.push({
      path: WORKFLOW_CONTRACTS_SOURCE,
      reason: "workflow-contract-marker-missing",
      detail: marker,
    });
  }

  return {
    ok: violations.length === 0,
    checked:
      REFACTOR_QA_AUTHORING_MARKERS.length +
      REFACTOR_PROCESS_MARKERS.length +
      WORKFLOW_CONTRACT_MARKERS.length,
    violations,
  };
}

export function refactorQaReleaseContractMessages(
  result: RefactorQaReleaseContractResult,
): string[] {
  if (result.ok) {
    return [`refactor-qa-release-contracts - OK (checked=${result.checked})`];
  }
  return [
    `refactor-qa-release-contracts - violation (checked=${result.checked}, findings=${result.violations.length})`,
    ...result.violations
      .slice(0, 10)
      .map((v) => `refactor-qa-release-contracts - ${v.reason}: ${v.path} (${v.detail})`),
  ];
}

export function lintVmodel(_path?: string): LintResult {
  const result = analyzePairFreeze(loadPairDocs());
  return { ok: result.ok, messages: pairFreezeMessages(result) };
}

// ── 検証タイミングの機械発火 (IMP-068、PLAN-L6-11/L7-12) ──
// V-model 層群 (検証発火単位) の Forward freeze 完了を検知し、検証サイクル発火を surface する。
// 検証ロードマップの「いつ検証するか」を人の記憶でなく V-model 構造 (層群の freeze) に従わせる
// = 崩れ防止の全体調整。発火 = surface まで (検証 PLAN の起票は人間トリガー、§2.6 signal→mode と同様)。

export interface VerificationGroup {
  id: string;
  layers: string[];
  label: string;
  /** 検証サイクルゲート名 = band 単位の機械発火ゲート (band 終端層 / band 性質で命名、PLAN-REVERSE-36)。
   *  旧称 GATE-A (L0-L6) / GATE-B (L0-L7) を置換。Forward per-layer gate (G0.5〜G7) とは別レイヤー。 */
  gate: string;
  requiredPlanIds?: string[];
}

export const L0_L7_AUTOMATION_PLAN_IDS = [
  "PLAN-REVERSE-40-orphan-governance",
  "PLAN-REVERSE-41-substance-lints",
  "PLAN-L7-32-cross-artifact-relation-graph",
  "PLAN-L7-36-relation-graph-export",
  "PLAN-L7-33-mcp-profile-config-safety",
  "PLAN-L7-34-tool-adapter-probes",
  "PLAN-L7-35-canonical-document-export",
  "PLAN-REVERSE-42-regression-dependency-drift",
  "PLAN-L7-43-implementation-verification-group",
] as const;

/** 検証発火単位 = 設計層群 (PO 例示: L0-L3 / L4-L6 / L0-L6)。L0=価値検証で design doc なし、L7 は実装 band。
 *  `gate` = 検証サイクルゲート名の単一正本 (roadmap §4 / concept §10 はこれを参照、PLAN-REVERSE-36)。 */
export const VERIFICATION_GROUPS: VerificationGroup[] = [
  // id は層群レンジを表示用に示す。layers は実在する design sub-doc の層のみ列挙する
  // (L0 = 価値検証で design doc を持たないため、"L0-L3"/"L0-L6" でも layers に L0 は無い、§7.1)。
  {
    id: "L0-L3",
    layers: ["L1", "L2", "L3"],
    label: "上流 (要求〜要件)",
    gate: "L3 検証サイクルゲート",
  },
  {
    id: "L4-L6",
    layers: ["L4", "L5", "L6"],
    label: "設計 (基本〜機能)",
    gate: "L6 検証サイクルゲート",
  },
  {
    id: "L0-L6",
    layers: ["L1", "L2", "L3", "L4", "L5", "L6"],
    label: "全設計層",
    gate: "設計検証サイクルゲート",
  },
  {
    id: "L0-L7",
    requiredPlanIds: [...L0_L7_AUTOMATION_PLAN_IDS],
    layers: ["L1", "L2", "L3", "L4", "L5", "L6"],
    label: "左腕+谷",
    gate: "実装検証サイクルゲート",
  },
];

export interface GroupReadiness {
  id: string;
  label: string;
  gate: string;
  total: number;
  confirmed: number;
  draft: number;
  placeholder: number;
  hasOrphan: boolean;
  activeRevisionTotal: number;
  activeRevisionConfirmed: number;
  activeRevisionDraft: number;
  activeRevisionHasOrphan: boolean;
  requiredPlanIds: string[];
  confirmedPlanIds: string[];
  missingPlanIds: string[];
  evidenceReadyPlanIds: string[];
  evidenceMissingPlanIds: string[];
  /** freeze 完了 = 全 design sub-doc が confirmed かつ その層群に pair 孤児が無い。 */
  frozen: boolean;
}

export interface VerificationPlanEvidence {
  status: string | null;
  hasReviewEvidence: boolean;
  hasGenerates: boolean;
}

export type VerificationPlanEvidenceMap =
  | Map<string, string>
  | Map<string, VerificationPlanEvidence>;

function hasPlanEvidence(value: string | VerificationPlanEvidence | undefined): boolean {
  if (typeof value === "string") return value === "confirmed";
  return value?.status === "confirmed" && value.hasReviewEvidence && value.hasGenerates;
}

export function loadVerificationPlanEvidence(
  repoRoot: string = process.cwd(),
): Map<string, VerificationPlanEvidence> {
  const evidence = new Map<string, VerificationPlanEvidence>();
  let docs: { rel: string; content: string }[];
  try {
    docs = walkMd(join(repoRoot, "docs/plans"), repoRoot);
  } catch {
    return evidence;
  }
  for (const { content } of docs) {
    const id = fmValue(content, "plan_id");
    if (!id) continue;
    evidence.set(id, {
      status: fmValue(content, "status") ?? null,
      hasReviewEvidence: /^review_evidence:\s*$/m.test(content),
      hasGenerates: /^generates:\s*$/m.test(content),
    });
  }
  return evidence;
}

export function loadVerificationPlanStatuses(
  repoRoot: string = process.cwd(),
): Map<string, string> {
  const statuses = new Map<string, string>();
  for (const [id, evidence] of loadVerificationPlanEvidence(repoRoot)) {
    if (evidence.status) statuses.set(id, evidence.status);
  }
  return statuses;
}

/**
 * 層群ごとに Forward freeze 完了 (検証サイクル発火タイミング) を集計 (純関数)。
 * @param docs loadPairDocs 出力
 * @param orphans analyzePairFreeze の孤児 (層群に孤児があれば freeze 未完了)
 */
export function analyzeVerificationGroups(
  docs: PairDoc[],
  orphans: PairOrphan[],
  planEvidence: VerificationPlanEvidenceMap = new Map<string, VerificationPlanEvidence>(),
): GroupReadiness[] {
  const orphanPaths = new Set(orphans.map((o) => o.path));
  const docsByPath = new Map(docs.map((doc) => [doc.path, doc]));
  return VERIFICATION_GROUPS.map((g) => {
    const layerSet = new Set(g.layers);
    const allGroupDocs = docs.filter((d) => {
      const layer = designLayerFromPath(d.path);
      return isDesignSubDoc(d) && layer != null && layerSet.has(layer);
    });
    const groupDocs = allGroupDocs.filter((doc) => !isValidAdditiveRevision(doc, docsByPath));
    const activeRevisionDocs = allGroupDocs.filter((doc) =>
      isValidAdditiveRevision(doc, docsByPath),
    );
    let confirmed = 0;
    let draft = 0;
    let placeholder = 0;
    let hasOrphan = false;
    for (const d of groupDocs) {
      if (d.status === "confirmed") confirmed++;
      else if (d.status === "placeholder") placeholder++;
      else draft++; // draft / null
      if (orphanPaths.has(d.path)) hasOrphan = true;
    }
    const total = groupDocs.length;
    const activeRevisionConfirmed = activeRevisionDocs.filter(
      (doc) => doc.status === "confirmed" || doc.status === "completed",
    ).length;
    const activeRevisionDraft = activeRevisionDocs.length - activeRevisionConfirmed;
    const activeRevisionHasOrphan = activeRevisionDocs.some((doc) => orphanPaths.has(doc.path));
    const requiredPlanIds = g.requiredPlanIds ?? [];
    const confirmedPlanIds = requiredPlanIds.filter((id) => {
      const evidence = planEvidence.get(id);
      return typeof evidence === "string"
        ? evidence === "confirmed"
        : evidence?.status === "confirmed";
    });
    const missingPlanIds = requiredPlanIds.filter((id) => {
      const evidence = planEvidence.get(id);
      return typeof evidence === "string"
        ? evidence !== "confirmed"
        : evidence?.status !== "confirmed";
    });
    const evidenceReadyPlanIds = requiredPlanIds.filter((id) =>
      hasPlanEvidence(planEvidence.get(id)),
    );
    const evidenceMissingPlanIds = requiredPlanIds.filter(
      (id) => !hasPlanEvidence(planEvidence.get(id)),
    );
    return {
      id: g.id,
      label: g.label,
      gate: g.gate,
      total,
      confirmed,
      draft,
      placeholder,
      hasOrphan,
      activeRevisionTotal: activeRevisionDocs.length,
      activeRevisionConfirmed,
      activeRevisionDraft,
      activeRevisionHasOrphan,
      requiredPlanIds,
      confirmedPlanIds,
      missingPlanIds,
      evidenceReadyPlanIds,
      evidenceMissingPlanIds,
      // freeze 完了 = 未着手/作業中 (draft) が無く孤児0 + confirmed が 1 件以上。
      // placeholder は意図的保留 (park、例: L2 screen track G2 DEFER) として発火を妨げない。
      frozen:
        total > 0 &&
        draft === 0 &&
        !hasOrphan &&
        confirmed > 0 &&
        missingPlanIds.length === 0 &&
        evidenceMissingPlanIds.length === 0,
    };
  });
}

/** doctor / CLI 向けの検証発火 surface (note レベル、ok は落とさない)。 */
export function verificationGroupsOk(groups: GroupReadiness[]): boolean {
  return groups.every((g) => g.frozen);
}

export function verificationGroupMessages(groups: GroupReadiness[]): string[] {
  return groups.map((g) => {
    // 検証サイクルゲート名を主見出しにし、range id + label を併記 (PLAN-REVERSE-36)。
    const head = `${g.gate} [${g.id}] (${g.label})`;
    if (g.total === 0) return `verification — ${head}: design doc なし`;
    if (g.frozen) {
      const park = g.placeholder > 0 ? `, ${g.placeholder} park` : "";
      const planEvidence =
        g.requiredPlanIds.length > 0
          ? `, L7 plans ${g.confirmedPlanIds.length}/${g.requiredPlanIds.length} confirmed, evidence ${g.evidenceReadyPlanIds.length}/${g.requiredPlanIds.length}`
          : "";
      const revision =
        g.activeRevisionTotal === 0
          ? ""
          : g.activeRevisionDraft > 0 || g.activeRevisionHasOrphan
            ? ` / active revisions IN-PROGRESS (${g.activeRevisionConfirmed}/${g.activeRevisionTotal} confirmed${g.activeRevisionHasOrphan ? ", pair 孤児あり" : ""})`
            : ` / active revisions ${g.activeRevisionConfirmed}/${g.activeRevisionTotal} confirmed`;
      return `verification — ${head}: ✅ base freeze 完了 (${g.confirmed}/${g.total} confirmed${park}${planEvidence}, 孤児0)${revision} → 検証サイクル発火可`;
    }
    const parts = [`${g.confirmed}/${g.total} confirmed`];
    if (g.draft > 0) parts.push(`draft ${g.draft}`);
    if (g.requiredPlanIds.length > 0) {
      parts.push(`L7 plans ${g.confirmedPlanIds.length}/${g.requiredPlanIds.length} confirmed`);
      parts.push(`evidence ${g.evidenceReadyPlanIds.length}/${g.requiredPlanIds.length}`);
    }
    if (g.evidenceMissingPlanIds.length > 0) {
      parts.push(`missing evidence ${g.evidenceMissingPlanIds.join(", ")}`);
    }
    if (g.missingPlanIds.length > 0) parts.push(`missing plans ${g.missingPlanIds.join(", ")}`);
    if (g.placeholder > 0) parts.push(`placeholder ${g.placeholder}`);
    if (g.hasOrphan) parts.push("pair 孤児あり");
    return `verification — ${head}: Forward 進行中 (${parts.join(", ")})`;
  });
}
