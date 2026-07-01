/**
 * oracle 宣言 ⇔ 実テスト citation の突合 (IMP-128、PLAN-REVERSE-41 塊B、FR-L1-18 descent)。
 *
 * l6-fr-coverage は FR→oracle ID の接続のみで、その oracle に対応する**実テストが tests/ に
 * 実在するか**を見ない (coverage≠substance の穴、[[feedback_coverage_not_substance]])。本 lint は
 * test-design で宣言された U-* / IT-* oracle ID が tests/ 内に citation を持つことを検査する。
 *
 * forward-citation 規律: NEW oracle は tests に ID 明記必須 (未 citation = fail-close)。既存の
 * 未 citation 89 件は baseline (known-debt、縮小のみ可)。素朴 ID マッチは「テスト実在・ID 未記載」
 * を false-positive にする (2026-06-10 実測 89 件) ため、既存を baseline 化し NEW のみ gate する。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ORACLE_TEST_TRACE_BASELINE } from "./oracle-test-trace-baseline";

export { ORACLE_TEST_TRACE_BASELINE };

/** oracle ID パターン (U-RELGRAPH-001 / IT-DOCEXPORT-003 等)。
 *  注 (review Minor): IT-* は現状宣言 0 件で baseline 未収載。将来 IT-* oracle を test-design に
 *  追加する場合、forward-citation 規律により tests に ID 明記が無いと即 fail する (意図通り = NEW gate)。 */
const ORACLE_ID = /\b(?:U|IT)-[A-Z0-9]+-[0-9]{3}\b/g;

export interface OracleTestTraceInput {
  /** test-design doc で宣言された oracle ID。 */
  declared: string[];
  /** tests/ 内で citation された oracle ID。 */
  referenced: Set<string>;
  /** known-debt allowlist (既存未 citation)。 */
  baseline: ReadonlySet<string>;
}

export interface OracleTestTraceResult {
  orphans: string[];
  ok: boolean;
}

/** 宣言済だが未 citation かつ baseline 外の oracle を orphan として返す。 */
export function analyzeOracleTestTrace(input: OracleTestTraceInput): OracleTestTraceResult {
  const orphans = [...new Set(input.declared)]
    .filter((id) => !input.referenced.has(id) && !input.baseline.has(id))
    .sort();
  return { orphans, ok: orphans.length === 0 };
}

function collectIds(dir: string, ext: string, acc: Set<string>): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) {
      collectIds(full, ext, acc);
    } else if (e.endsWith(ext)) {
      for (const m of readFileSync(full, "utf8").matchAll(ORACLE_ID)) acc.add(m[0]);
    }
  }
}

export function loadOracleTestTraceInput(repoRoot: string): OracleTestTraceInput {
  const declaredSet = new Set<string>();
  collectIds(join(repoRoot, "docs", "test-design"), ".md", declaredSet);
  const referenced = new Set<string>();
  collectIds(join(repoRoot, "tests"), ".ts", referenced);
  return { declared: [...declaredSet], referenced, baseline: ORACLE_TEST_TRACE_BASELINE };
}

export function oracleTestTraceMessages(r: OracleTestTraceResult): string[] {
  if (r.orphans.length === 0) {
    return [
      "oracle-test-trace — OK (宣言 oracle 全件 tests citation / baseline 被覆、NEW 未 citation 0)",
    ];
  }
  return [
    `oracle-test-trace — ⚠ tests 未 citation の宣言 oracle ${r.orphans.length} 件 (baseline 外): ${r.orphans.join(", ")}`,
  ];
}
