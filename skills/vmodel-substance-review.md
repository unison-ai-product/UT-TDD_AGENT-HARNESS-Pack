---
schema_version: skill.v1
name: vmodel-substance-review
skill_type: process
applies_to:
  layers:
    - L2
    - L3
    - L4
    - L5
    - L6
    - L7
  drive_models:
    - Forward
    - Add-feature
    - Reverse
triggers: "vmodel-docgen の敵対検証（グッドハート対策の第2層）。「ゲートは緑だが中身は大丈夫か」を確認するとき、build/review/ の敵対検証パケットを渡されたとき、docs/review.yaml の運用、攻撃者/防御者/反例/敵対的レビュー・抜き取りレビューに言及されたときに必ず使用する。依頼側・攻撃者・防御者それぞれの規約を含む。"
---

# vmodel-substance-review

> 移植元: zip `.claude/skills/vmodel-substance-review/SKILL.md` (Apache-2.0、PLAN-L7-676 PR-T3)。
> **本ファイルは薄い橋渡し (bridge) であり、判断ロジックの正本は既存 [[adversarial-review]] に統合済み**
> (docs/plans/PLAN-L7-676-release-consumer-dev-start.md §3.5.1「意味が重なる skill は既存 skill への
> 統合を優先し、同じ内容を 2 本持たない」)。実測: 原文の判断内容 (下記見出し) は [[adversarial-review]] の
> decision_points に相当する内容が英語で既にカバーされている。判断が必要なときは [[adversarial-review]]
> を読むこと。本ファイルは zip 原文の日本語見出しへの索引と、移植元固有の語彙 (vmodel-docgen の文書番号
> 参照など) を保持するためだけに存在する。

## zip 原文の節見出し (索引)

- 前提（投票との違い）
- 依頼側（検証を回すエージェント）の手順
- 攻撃者の規約
- 防御者の規約
- この仕組み自体の限界

## この skill を読む場面

vmodel-docgen の敵対検証（グッドハート対策の第2層）。「ゲートは緑だが中身は大丈夫か」を確認するとき、build/review/ の敵対検証パケットを渡されたとき、docs/review.yaml の運用、攻撃者/防御者/反例/敵対的レビュー・抜き取りレビューに言及されたときに必ず使用する。依頼側・攻撃者・防御者それぞれの規約を含む。

判断の中身は [[adversarial-review]] を参照。
