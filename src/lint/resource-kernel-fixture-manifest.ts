/**
 * D0-R Resource Kernel fixture manifest の機械検査 (PLAN-L5-25 §7 pair-freeze 条件、issue #149)。
 *
 * L8 表の fixture 列は識別子と一行説明しか持たないため、識別子の宣言だけでは
 * 「fixture を freeze した」を第三者が検証できない (2026-07-30 の cross-review FLAG)。
 * 本 lint は L8 表と `docs/test-design/harness/resource-kernel-fixture-manifest.yaml` を突合し、
 * 欠落・dangling・重複・属性欠落・contract 節の不在を fail-close する。
 *
 * 最重要の不変条件: `status: planned` の entry は `path` が**実在してはならない**。
 * 実体が無いのに「配置済み」と読ませる偽装を構造的に不可能にする (planned で実在 = Red)。
 */
import { parse as parseYaml } from "yaml";

export interface FixtureManifestEntry {
  id: string;
  case: string;
  lane: string;
  status: string;
  path: string;
  contractRef: string;
  inputs: string[];
  generation: string;
}

export interface FixtureManifest {
  contractDoc: string;
  fixtureRoot: string;
  entries: FixtureManifestEntry[];
}

/** L8 freeze 属性表の 1 行から fixture 突合に必要な 3 要素だけを取る。 */
export interface L8FixtureRow {
  case: string;
  lane: string;
  fixtureId: string;
}

export interface FixtureManifestResult {
  /** L8 表にあるが manifest に無い fixture。 */
  missingFromManifest: string[];
  /** manifest にあるが L8 表から参照されない fixture。 */
  danglingInManifest: string[];
  duplicateIds: string[];
  /** manifest の case が L8 行と不一致。 */
  caseMismatch: string[];
  /** manifest の lane が L8 行と不一致。 */
  laneMismatch: string[];
  invalidStatus: string[];
  emptyFields: string[];
  pathOutsideRoot: string[];
  /** planned なのに path が実在する (偽装検出)。 */
  plannedPathExists: string[];
  /** materialized なのに path が無い。 */
  materializedPathMissing: string[];
  /** contract_ref の節が contract doc に実在しない。 */
  unknownContractRef: string[];
  statusCounts: Record<string, number>;
  ok: boolean;
}

export const ALLOWED_FIXTURE_STATUSES = ["planned", "materialized"] as const;

const PIPE_PLACEHOLDER = " PIPE ";

/** markdown の見出し配下 (次の見出しまで) を切り出す。 */
export function sliceSection(markdown: string, headingPrefix: string): string {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(headingPrefix));
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,3} /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

function splitRow(line: string): string[] {
  return line
    .replaceAll("\\|", PIPE_PLACEHOLDER)
    .split("|")
    .slice(1, -1)
    .map((c) => c.replaceAll(PIPE_PLACEHOLDER, "|").trim());
}

/** L8 freeze 属性表から (case, lane, fixtureId) を取る。fixture 未記載行は空 id で返す。 */
export function parseL8FixtureRows(l8Markdown: string): L8FixtureRow[] {
  const section = sliceSection(l8Markdown, "### Resource Kernel物理統合 freeze属性");
  const rows: L8FixtureRow[] = [];
  for (const line of section.split(/\r?\n/)) {
    if (!line.startsWith("| `IT-RGK-PHYS-")) continue;
    const cells = splitRow(line);
    rows.push({
      case: (cells[0] ?? "").replaceAll("`", ""),
      lane: cells[1] ?? "",
      fixtureId: /`(fx-rgk-[a-z0-9-]+)`/.exec(cells[3] ?? "")?.[1] ?? "",
    });
  }
  return rows;
}

/** fixture manifest YAML を読む。未知形状は空 manifest として返し、突合側で欠落として落とす。 */
export function parseFixtureManifest(yamlText: string): FixtureManifest {
  const doc = parseYaml(yamlText) as Record<string, unknown> | null;
  const raw = Array.isArray(doc?.fixtures) ? (doc?.fixtures as Record<string, unknown>[]) : [];
  return {
    contractDoc: typeof doc?.contract_doc === "string" ? doc.contract_doc : "",
    fixtureRoot: typeof doc?.fixture_root === "string" ? doc.fixture_root : "",
    entries: raw.map((e) => ({
      id: typeof e.id === "string" ? e.id : "",
      case: typeof e.case === "string" ? e.case : "",
      lane: typeof e.lane === "string" ? e.lane : "",
      status: typeof e.status === "string" ? e.status : "",
      path: typeof e.path === "string" ? e.path : "",
      contractRef: typeof e.contract_ref === "string" ? e.contract_ref : "",
      inputs: Array.isArray(e.inputs) ? e.inputs.map((i) => String(i)) : [],
      generation: typeof e.generation === "string" ? e.generation : "",
    })),
  };
}

/** contract doc の見出しから節番号集合を作る (`## 4.` → "4"、`### 4.1 ` → "4.1")。 */
export function parseContractSections(markdown: string): Set<string> {
  const out = new Set<string>();
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^#{2,3} (\d+(?:\.\d+)*)\.?\s/.exec(line);
    if (m) out.add(m[1]);
  }
  return out;
}

/** L8 表と manifest を突合する。`pathExists` は repo 相対 path の実在判定。 */
export function analyzeFixtureManifest(input: {
  rows: L8FixtureRow[];
  manifest: FixtureManifest;
  contractSections: Set<string>;
  pathExists: (repoRelativePath: string) => boolean;
}): FixtureManifestResult {
  const { rows, manifest, contractSections, pathExists } = input;
  const rowByFixture = new Map(rows.filter((r) => r.fixtureId).map((r) => [r.fixtureId, r]));
  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  for (const e of manifest.entries) {
    if (seen.has(e.id)) duplicateIds.push(e.id);
    seen.add(e.id);
  }

  const missingFromManifest = [...rowByFixture.keys()].filter((id) => !seen.has(id)).sort();
  // fixture 列が空の L8 行も欠落として扱う (識別子未記載を素通りさせない)。
  for (const r of rows) if (!r.fixtureId) missingFromManifest.push(`${r.case} (fixture 未記載)`);
  const danglingInManifest = manifest.entries
    .filter((e) => !rowByFixture.has(e.id))
    .map((e) => e.id)
    .sort();

  const caseMismatch: string[] = [];
  const laneMismatch: string[] = [];
  const invalidStatus: string[] = [];
  const emptyFields: string[] = [];
  const pathOutsideRoot: string[] = [];
  const plannedPathExists: string[] = [];
  const materializedPathMissing: string[] = [];
  const unknownContractRef: string[] = [];
  const statusCounts: Record<string, number> = {};

  for (const e of manifest.entries) {
    statusCounts[e.status] = (statusCounts[e.status] ?? 0) + 1;
    const row = rowByFixture.get(e.id);
    if (row) {
      if (row.case !== e.case) caseMismatch.push(`${e.id}: manifest=${e.case} L8=${row.case}`);
      if (row.lane !== e.lane) laneMismatch.push(`${e.id}: manifest=${e.lane} L8=${row.lane}`);
    }
    if (!(ALLOWED_FIXTURE_STATUSES as readonly string[]).includes(e.status)) {
      invalidStatus.push(`${e.id}: ${e.status || "(空)"}`);
    }
    if (!e.path || !e.contractRef || !e.generation || e.inputs.length === 0) {
      emptyFields.push(e.id);
    }
    if (manifest.fixtureRoot && e.path && !e.path.startsWith(`${manifest.fixtureRoot}/`)) {
      pathOutsideRoot.push(`${e.id}: ${e.path}`);
    }
    if (e.path) {
      const exists = pathExists(e.path);
      if (e.status === "planned" && exists) plannedPathExists.push(`${e.id}: ${e.path}`);
      if (e.status === "materialized" && !exists) {
        materializedPathMissing.push(`${e.id}: ${e.path}`);
      }
    }
    const section = e.contractRef.replace(/^§/, "").trim();
    if (section && !contractSections.has(section)) {
      unknownContractRef.push(`${e.id}: §${section}`);
    }
  }

  const findings = [
    missingFromManifest,
    danglingInManifest,
    duplicateIds,
    caseMismatch,
    laneMismatch,
    invalidStatus,
    emptyFields,
    pathOutsideRoot,
    plannedPathExists,
    materializedPathMissing,
    unknownContractRef,
  ];

  return {
    missingFromManifest,
    danglingInManifest,
    duplicateIds,
    caseMismatch,
    laneMismatch,
    invalidStatus,
    emptyFields,
    pathOutsideRoot,
    plannedPathExists,
    materializedPathMissing,
    unknownContractRef,
    statusCounts,
    ok: findings.every((f) => f.length === 0),
  };
}

/** 失敗時の人間向け説明。 */
export function fixtureManifestMessages(r: FixtureManifestResult): string[] {
  const msgs: string[] = [];
  const push = (label: string, items: string[]) => {
    if (items.length > 0) msgs.push(`${label}: ${items.join(", ")}`);
  };
  push("manifest に無い L8 fixture", r.missingFromManifest);
  push("L8 から参照されない manifest entry (dangling)", r.danglingInManifest);
  push("重複 id", r.duplicateIds);
  push("case 不一致", r.caseMismatch);
  push("lane 不一致", r.laneMismatch);
  push(`status 語彙外 (${ALLOWED_FIXTURE_STATUSES.join(" / ")})`, r.invalidStatus);
  push("必須 field 欠落 (path / contract_ref / inputs / generation)", r.emptyFields);
  push("fixture_root 外の path", r.pathOutsideRoot);
  push("planned なのに path が実在する (実体の偽装)", r.plannedPathExists);
  push("materialized なのに path が無い", r.materializedPathMissing);
  push("contract doc に存在しない contract_ref", r.unknownContractRef);
  return msgs;
}
