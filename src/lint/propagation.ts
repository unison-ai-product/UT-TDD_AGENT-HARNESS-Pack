/**
 * propagation lint — L0 (concept §2.6) ⇔ L3 (requirements §7.8.1) の signal→mode routing 整合 (IMP-065)。
 *
 * 背景: governance (concept §2.5/§2.6) に mode/signal を導入したのに、機械 routing の SSoT である
 * requirements §7.8.1 route-map へ伝播せず L0⇔L3 がドリフトする (本 harness 開発で実証、IMP-065)。
 * 上位正本 (concept) の signal 語彙と、機械が実装する requirements の signal 語彙が乖離すると、
 * 「concept が約束した routing を機械が実装できない」/「機械にあるのに narrative に無い」状態になる。
 *
 * 検査: 両 doc の **signal routing テーブルの 1 列目 (signal 列) の token 集合**を抽出し一致を要求する。
 * interrupt 行は subtype 表記が両 doc で非対称 (§2.6.5 サブルーティング) なため比較から除外する。
 *
 * 純関数 (analyze) + I/O loader 分離 (backfill-pairing / scrum-reverse と同方針)。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** signal でない token を除外。interrupt は subtype 表記が両 doc で非対称なため比較対象外。 */
const NON_SIGNAL = new Set(["interrupt"]);

/**
 * `| signal | mode | ...` ヘッダを持つ routing テーブル**だけ**から signal 列 token を抽出する。
 * 他テーブル (decision_outcome / reverse_type / kind 一覧 等) の backtick を巻き込まないため
 * ヘッダ行でスコープを開始し、非テーブル行で閉じる。interrupt 行は subtype 非対称ゆえ除外。
 */
export function extractSignals(docText: string): Set<string> {
  const signals = new Set<string>();
  let inTable = false;
  for (const line of docText.split("\n")) {
    if (!line.startsWith("|")) {
      inTable = false; // テーブル終端 (空行等)
      continue;
    }
    // signal/mode ヘッダでスコープ開始。
    if (/^\|\s*signal\s*\|/i.test(line) && /mode/i.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (/^\|\s*-+/.test(line)) continue; // 区切り行 (|---|---|)
    const sigCell = (line.split("|")[1] ?? "").trim();
    if (/^`?interrupt`?/.test(sigCell)) continue; // interrupt 行は除外
    // signal 列の backtick token (snake_case ≥4 文字) を抽出、`subtype=` 接頭は剥がす。
    for (const m of sigCell.matchAll(/`(?:subtype=)?([a-z][a-z_]{3,})`/g)) {
      const tok = m[1];
      if (!NON_SIGNAL.has(tok)) signals.add(tok);
    }
  }
  return signals;
}

export interface PropagationResult {
  /** concept §2.6 にあるが requirements §7.8.1 に無い (機械が routing 未実装 = governance の空約束)。 */
  conceptOnly: string[];
  /** requirements にあるが concept に無い (narrative 未反映 = 上位正本の取りこぼし)。 */
  requirementsOnly: string[];
  ok: boolean;
}

/** concept §2.6 と requirements §7.8.1 の signal 語彙一致を検査。 */
export function analyzePropagation(
  conceptText: string,
  requirementsText: string,
): PropagationResult {
  const c = extractSignals(conceptText);
  const r = extractSignals(requirementsText);
  const conceptOnly = [...c].filter((t) => !r.has(t)).sort();
  const requirementsOnly = [...r].filter((t) => !c.has(t)).sort();
  return {
    conceptOnly,
    requirementsOnly,
    ok: conceptOnly.length === 0 && requirementsOnly.length === 0,
  };
}

export interface PropagationDocs {
  conceptText: string;
  requirementsText: string;
}

export function loadPropagationDocs(repoRoot: string = process.cwd()): PropagationDocs {
  const gov = join(repoRoot, "docs", "governance");
  return {
    conceptText: readFileSync(join(gov, "ut-tdd-agent-harness-concept_v3.1.md"), "utf8"),
    requirementsText: readFileSync(join(gov, "ut-tdd-agent-harness-requirements_v1.2.md"), "utf8"),
  };
}

/** doctor / CLI 向けの 1 行サマリ。 */
export function propagationMessages(result: PropagationResult): string[] {
  const msgs: string[] = [];
  if (result.conceptOnly.length > 0) {
    msgs.push(
      `propagation — ⚠ concept §2.6 signal が requirements §7.8.1 へ未伝播 ${result.conceptOnly.length} 件 (${result.conceptOnly.join(", ")}): route-map に追加 (IMP-065)`,
    );
  }
  if (result.requirementsOnly.length > 0) {
    msgs.push(
      `propagation — ⚠ requirements signal が concept §2.6 に未反映 ${result.requirementsOnly.length} 件 (${result.requirementsOnly.join(", ")}): 上位正本へ back-merge`,
    );
  }
  if (msgs.length === 0)
    msgs.push("propagation — OK (concept §2.6 ⇔ requirements §7.8.1 signal 語彙一致)");
  return msgs;
}
