/**
 * Improvement backlog lint test (A-59 ledger、5 つ目の lint)。
 * 作業ログ memory (不備/改善 → 機能化 pipeline) の構造健全性を機械検証。
 * PO 指摘「作業ログ memory 機能」反映。
 */
import { describe, expect, it } from "vitest";
import {
  analyzeImprovementBacklog,
  loadBacklog,
  parseBacklogEntries,
  VALID_CANDIDATE,
  VALID_STATUS,
} from "../src/lint/improvement-backlog";

describe("improvement backlog (作業ログ → 機能化 pipeline)", () => {
  const md = loadBacklog();
  const result = analyzeImprovementBacklog(md);

  it("§1 backlog の全 entry を構造化抽出 (seed = A-49〜A-58)", () => {
    const entries = parseBacklogEntries(md);
    expect(entries.length).toBeGreaterThanOrEqual(12);
    expect(entries.every((e) => e.id.startsWith("IMP-"))).toBe(true);
  });

  it("ID 形式 IMP-NNN + 一意 (malformed / duplicate = 0)", () => {
    expect(result.malformedIds).toEqual([]);
    expect(result.duplicateIds).toEqual([]);
  });

  it("status が全件 enum (observed/triaged/implemented/verified) 内", () => {
    expect(result.invalidStatus).toEqual([]);
    expect(VALID_STATUS).toContain("verified");
  });

  it("自動化候補が全件 enum (lint/FR/policy/doc/none) 内 ('/' 複数可)", () => {
    expect(result.invalidCandidate).toEqual([]);
    expect(VALID_CANDIDATE).toContain("lint");
  });

  it("全 entry が必須 7 列を充足 (incomplete = 0)", () => {
    expect(result.incompleteRows).toEqual([]);
  });

  it("IMP らしき行が parse されず黙って skip される absence-blindness が 0 (unparseable = [])", () => {
    expect(result.unparseableRows).toEqual([]);
  });

  it("`→suffix` 等で ID regex を外れた行を unparseableRows で surface する (parse 黙殺の検出)", () => {
    const md = [
      "## §1 backlog",
      "| ID | 観測日 | 文脈 | 不備・改善 | 自動化候補 | status | 紐付け |",
      "|---|---|---|---|---|---|---|",
      "| **IMP-200** | 2026-06-19 | ctx | issue | lint | observed | link |",
      "| **IMP-200→enforced** | 2026-06-19 | ctx | issue | lint | verified | link |",
    ].join("\n");
    const r = analyzeImprovementBacklog(md);
    expect(r.total).toBe(1); // 正規 ID 行のみ parse される
    expect(r.unparseableRows).toEqual(["IMP-200→enforced"]); // 黙殺されず surface
  });

  it("pipeline 状態が集計される (verified seed + open 改善候補が両方存在)", () => {
    expect(result.byStatus.verified).toBeGreaterThanOrEqual(3); // A-56/57/58 の done seed
    expect(result.openCount).toBeGreaterThanOrEqual(1); // 機能化待ちが残っている
    expect(result.total).toBe(
      result.byStatus.observed +
        result.byStatus.triaged +
        result.byStatus.implemented +
        result.byStatus.verified,
    );
  });

  it("lower-layer Reverse backprop rows require machine-readable classification fields", () => {
    const md = [
      "## §1 backlog",
      "| ID | 隕ｳ貂ｬ譌･ | 譁・ц | 荳榊ｙ繝ｻ謾ｹ蝟・| 閾ｪ蜍募喧蛟呵｣・| status | 邏蝉ｻ倥￠ |",
      "|---|---|---|---|---|---|---|",
      "| **IMP-201** | 2026-06-22 | A-123 lower-layer Reverse back-propagation | 下位 L で追加・改善起票を発見しても分類が無い。 | lint | observed | future lint |",
    ].join("\n");

    const r = analyzeImprovementBacklog(md);

    expect(r.missingBackpropClassification).toEqual([
      {
        id: "IMP-201",
        missing: [
          "backprop_decision",
          "reverse_type",
          "target_layer",
          "upstream_docs",
          "evidence_path",
          "closure_status",
        ],
      },
    ]);
  });

  it("lower-layer Reverse backprop rows pass when all classification fields are present", () => {
    const issue = [
      "下位 L で追加・改善起票を発見。",
      "**backprop_decision**=`requires_requirement_backprop`、",
      "**reverse_type**=`fullback`、",
      "**target_layer**=`requirements/process/backlog`、",
      "**upstream_docs**=`requirements §6.8.8`、",
      "**evidence_path**=`docs/plans/PLAN-X.md`、",
      "**closure_status**=`routed_to_future_lint`。",
    ].join("");
    const md = [
      "## §1 backlog",
      "| ID | 隕ｳ貂ｬ譌･ | 譁・ц | 荳榊ｙ繝ｻ謾ｹ蝟・| 閾ｪ蜍募喧蛟呵｣・| status | 邏蝉ｻ倥￠ |",
      "|---|---|---|---|---|---|---|",
      `| **IMP-202** | 2026-06-22 | A-123 lower-layer Reverse back-propagation | ${issue} | lint | observed | future lint |`,
    ].join("\n");

    const r = analyzeImprovementBacklog(md);

    expect(r.missingBackpropClassification).toEqual([]);
  });
});
