---
schema_version: skill.v1
name: vmodel-test-thinking
skill_type: process
applies_to:
  layers:
    - L6
    - L7
    - L8
    - L9
  drive_models:
    - Forward
    - Add-feature
    - Reverse
    - Discovery
triggers: "診断・検証・テストにおける思考法・視点・振る舞いのスキル。テストケースを設計するとき、テスト設計書(06-09/28)や診断書(102/109)を書くとき、テスト結果を解釈するとき、探索的テストを行うとき、「どこまでテストすれば十分か」を判断するとき、バグを探すとき、テストが全部通って不安なときに必ず使用する。型(テンプレート)は vmodel-authoring が扱う。本スキルはその型に入れる中身の質を扱う。"
---

# vmodel-test-thinking

> 移植元: zip `.claude/skills/vmodel-test-thinking/SKILL.md` (Apache-2.0、PLAN-L7-676 PR-T3)。
> **本ファイルは薄い橋渡し (bridge) であり、判断ロジックの正本は既存 [[test-breakage-thinking]] に統合済み**
> (docs/plans/PLAN-L7-676-release-consumer-dev-start.md §3.5.1「意味が重なる skill は既存 skill への
> 統合を優先し、同じ内容を 2 本持たない」)。実測: 原文の判断内容 (下記見出し) は [[test-breakage-thinking]] の
> decision_points に相当する内容が英語で既にカバーされている。判断が必要なときは [[test-breakage-thinking]]
> を読むこと。本ファイルは zip 原文の日本語見出しへの索引と、移植元固有の語彙 (vmodel-docgen の文書番号
> 参照など) を保持するためだけに存在する。

## zip 原文の節見出し (索引)

- 0. 出発点となる態度
- 1. 壊れ方を探す視点カタログ
- 2. 深さの配分 — リスクベースの実際の考え方
- 3. 探索的テストの振る舞い規則
- 4. 診断チェックリスト(102/109)を運用するときの振る舞い
- 5. いつ止めるか — 十分性の判断
- 6. アンチパターン早見（自分がやっていないか毎回確認）

## この skill を読む場面

診断・検証・テストにおける思考法・視点・振る舞いのスキル。テストケースを設計するとき、テスト設計書(06-09/28)や診断書(102/109)を書くとき、テスト結果を解釈するとき、探索的テストを行うとき、「どこまでテストすれば十分か」を判断するとき、バグを探すとき、テストが全部通って不安なときに必ず使用する。型(テンプレート)は vmodel-authoring が扱う。本スキルはその型に入れる中身の質を扱う。

判断の中身は [[test-breakage-thinking]] を参照。
