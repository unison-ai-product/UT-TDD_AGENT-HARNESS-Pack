import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TIER_TABLE } from "../src/task/tier-router";
import { MODEL_IDS, PROPOSAL_SUBAGENT_LANES, selectTeamModel } from "../src/team/model-policy";

/**
 * U-MODELID: model-id SSoT (PLAN-L7-58 carry)。
 *
 * tier-router の TIER_TABLE と model-policy の modelForProvider が同じモデル ID を別々の literal で
 * 持っていた二重定義を MODEL_IDS 1 箇所へ集約した。この substance テストは「正本から合成されているか」
 * を値で確認し、かつ「両モジュールに生の ID literal が再混入していないか」をソース走査で fail-close する。
 */

const repoRoot = join(__dirname, "..");
const ALL_IDS: string[] = [...Object.values(MODEL_IDS.claude), ...Object.values(MODEL_IDS.codex)];

function quotedOccurrences(file: string, id: string): number {
  const src = readFileSync(join(repoRoot, file), "utf8");
  // ダブルクオート文字列リテラルだけを数える (コメント中の素の `gpt-5.5` 等は対象外)。
  const matches = src.match(new RegExp(`"${id.replace(/[.\\]/g, "\\$&")}"`, "g"));
  return matches ? matches.length : 0;
}

describe("U-MODELID: model-id SSoT", () => {
  it("U-MODELID-001: TIER_TABLE は MODEL_IDS から合成される (drift 無し)", () => {
    expect(TIER_TABLE.T0).toEqual({
      claude: MODEL_IDS.claude.opus,
      codex: MODEL_IDS.codex.frontier,
    });
    expect(TIER_TABLE.T1).toEqual({
      claude: MODEL_IDS.claude.sonnet,
      codex: MODEL_IDS.codex.worker,
    });
    expect(TIER_TABLE.T2).toEqual({ claude: MODEL_IDS.claude.haiku, codex: MODEL_IDS.codex.spark });
  });

  it("U-MODELID-002: modelForProvider の出力は MODEL_IDS の値である", () => {
    expect(
      selectTeamModel({
        provider: "codex",
        role: "tl",
        engine: "codex-tl",
        task: "production security migration",
      }).model,
    ).toBe(MODEL_IDS.codex.frontier);
    expect(
      selectTeamModel({ provider: "codex", role: "docs", engine: "codex-pg", task: "README typo" })
        .model,
    ).toBe(MODEL_IDS.codex.spark);
    expect(
      selectTeamModel({
        provider: "claude",
        role: "se",
        engine: "pmo-haiku",
        task: "rename a field",
      }).model,
    ).toBe(MODEL_IDS.claude.haiku);
  });

  it("U-MODELID-003: tier-router.ts に生のモデル ID literal が無い (SSoT 参照のみ)", () => {
    for (const id of ALL_IDS) {
      expect(quotedOccurrences("src/task/tier-router.ts", id)).toBe(0);
    }
  });

  it("U-MODELID-004: model-policy.ts のモデル ID literal は MODEL_IDS 定義の 1 箇所のみ", () => {
    for (const id of ALL_IDS) {
      expect(quotedOccurrences("src/team/model-policy.ts", id)).toBe(1);
    }
  });

  it("U-MODELID-005: proposal subagent lanes use MODEL_IDS and keep mini out of execution TIER_TABLE", () => {
    expect(PROPOSAL_SUBAGENT_LANES["T2-mini"]).toMatchObject({
      model: MODEL_IDS.codex.mini,
      max_parallel: 4,
      closing_authority: false,
      ownership: expect.stringContaining("disjoint"),
    });
    expect(PROPOSAL_SUBAGENT_LANES["T2-spark"]).toMatchObject({
      model: MODEL_IDS.codex.spark,
      max_parallel: 3,
      closing_authority: false,
      ownership: expect.stringContaining("disjoint"),
    });
    expect(PROPOSAL_SUBAGENT_LANES["T0-frontier"]).toMatchObject({
      model: MODEL_IDS.codex.frontier,
      max_parallel: 1,
      closing_authority: true,
      ownership: expect.stringContaining("single"),
    });
    expect(Object.values(TIER_TABLE).some((tier) => tier.codex === MODEL_IDS.codex.mini)).toBe(
      false,
    );
  });
});
