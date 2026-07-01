/**
 * verb-classify (PLAN-RECOVERY-05, item 2 wiring) — Bash コマンドを attempt-escalation の
 * grouping 用の **安定した検証 verb トークン** に分類する純関数。
 *
 * 背景: session-log の `summarize()` は durable log への漏洩防止のため **Bash のコマンド文字列を
 * 保存しない** (target は常に `"Bash (bash)"`)。よって「同じ検証コマンドを N 回連続失敗した」を
 * read 側で復元できない。本分類は **write 時** (command が手元にある時点) にコマンドを固定の
 * verb トークン (vitest / test / tsc / doctor / lint / eslint) へ落とし、その token だけを残す。
 *
 * Codex cross-review (2026-06-23) の指摘を反映:
 * - wrapper (`bun` / `npm` / `npx`) でまとめず **意味上の検証 verb まで降ろす**
 *   (`bun run vitest ...` → `vitest`、`bun run src/cli.ts doctor` → `doctor`)。
 * - **未分類コマンドは強引にまとめず null** を返し escalation 対象外にする (noise 抑制)。
 * - 異なる検証系 (`vitest` と `tsc`) を **誤併合しない** (token が別)。
 *
 * トークンは固定の whitelist のみを返すため、引数・値・秘密情報を漏らさない (sanitize 不要)。
 */

/** 検証 verb の判定規則。最初に一致したものを採る (順序 = 特異性の高い順)。 */
const VERB_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // 明示ツール名 (引数違いを跨いで同一 verb)。vitest は lint より先 (例: vitest run tests/lint-x)。
  [/\bvitest\b/, "vitest"],
  [/\b(typecheck|tsc)\b/, "tsc"],
  [/\bdoctor\b/, "doctor"],
  [/\bskill\s+suggest\b/, "skill"],
  [/\bbiome\b/, "lint"],
  [/\beslint\b/, "eslint"],
  // script alias (ツール名がコマンドに現れない `bun run test` / `npm run lint` 形)。
  [/\brun\s+test\b/, "test"],
  [/\brun\s+lint\b/, "lint"],
];

/**
 * Bash コマンドを検証 verb トークンに分類する。該当しなければ null (= escalation 対象外)。
 *
 * 保守的: whitelist の検証コマンドのみ分類し、それ以外 (git / ls / 任意スクリプト) は null。
 * 未分類を強引に併合しないことで誤検知 (無関係コマンドの連続失敗を 1 ループ扱い) を避ける。
 */
export function classifyVerificationVerb(command: string): string | null {
  if (!command) return null;
  const normalized = command.toLowerCase();
  for (const [re, verb] of VERB_RULES) {
    if (re.test(normalized)) return verb;
  }
  return null;
}
