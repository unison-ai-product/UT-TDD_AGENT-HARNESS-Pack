import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * PLAN-REVERSE-12 再発防止: self-pair (IMP-039/058 で導入され RECOVERY-09 で撤去された無承認規約) が
 * 上位正本の normative 面へ「現行規約」として再流入しないことを永続検査する (PLAN claim discipline、
 * coding ≠ substance)。機構レベルの self 孤児化 (tests/vmodel-pair.test.ts) とは別レイヤーで、
 * concept/roadmap/L2 README/L4 function の prose 再発を検出する。
 */

const CANONICAL_DOCS = [
  "docs/governance/ut-tdd-agent-harness-concept_v3.1.md",
  "docs/design/harness/L3-functional/roadmap.md",
  "docs/design/harness/L2-screen/README.md",
  "docs/design/harness/L4-basic-design/function.md",
];

const SELF_PAIR_PATTERN = /self-pair|pair_artifact:\s*self|wireframe=self/i;

/** self-pair 出現が許容される文脈 (retired 用語 / errata / 撤去注記 / 日付き歴史ログ)。 */
function isAllowedContext(line: string): boolean {
  if (/撤去|撤回|retired|RECOVERY-09|REVERSE-12/.test(line)) return true; // errata / retired
  if (/^\|\s*20\d{2}-\d{2}-\d{2}/.test(line.trim())) return true; // 日付き歴史 cycle ログ行
  return false;
}

describe("self-pair normative guard (PLAN-REVERSE-12)", () => {
  for (const rel of CANONICAL_DOCS) {
    it(`${rel}: self-pair は現行規約として残らない (retired/errata/歴史ログ のみ許容)`, () => {
      const content = readFileSync(resolve(process.cwd(), rel), "utf8");
      const offenders = content
        .split(/\r?\n/)
        .map((line, i) => ({ line, no: i + 1 }))
        .filter(({ line }) => SELF_PAIR_PATTERN.test(line) && !isAllowedContext(line));
      expect(
        offenders,
        `normative self-pair 残存: ${offenders.map((o) => `L${o.no}`).join(", ")}`,
      ).toEqual([]);
    });
  }
});
