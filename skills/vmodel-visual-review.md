---
schema_version: skill.v1
name: vmodel-visual-review
skill_type: process
applies_to:
  layers:
    - L2
    - L7
    - L8
    - L10
  drive_models:
    - Forward
    - Add-feature
    - Refactor
triggers: "画面・UI・ビジュアルの検証と品質判断のスキル。画面検証(51)やUIテストを設計・実施するとき、スクリーンショットやモックを評価するとき、ビジュアルリグレッションの差分を判定するとき、アクセシビリティを確認するとき、「なんか変だが言語化できない」画面に出会ったとき、デザインの一貫性をレビューするときに必ず使用する。見た目の良し悪しは数値に畳み込めないため、本スキルは観点・語彙・振る舞いでそれを補う。"
---

# vmodel-visual-review

> 移植元: zip `.claude/skills/vmodel-visual-review/SKILL.md` (Apache-2.0、PLAN-L7-676 PR-T3)。
> **本ファイルは薄い橋渡し (bridge) であり、判断ロジックの正本は既存 [[visual-state-verification]] に統合済み**
> (docs/plans/PLAN-L7-676-release-consumer-dev-start.md §3.5.1「意味が重なる skill は既存 skill への
> 統合を優先し、同じ内容を 2 本持たない」)。実測: 原文の判断内容 (下記見出し) は [[visual-state-verification]] の
> decision_points に相当する内容が英語で既にカバーされている。判断が必要なときは [[visual-state-verification]]
> を読むこと。本ファイルは zip 原文の日本語見出しへの索引と、移植元固有の語彙 (vmodel-docgen の文書番号
> 参照など) を保持するためだけに存在する。

## zip 原文の節見出し (索引)

- 0. 出発点となる態度
- 1. 状態マトリクス — すべての画面で必ず見る9状態
- 2. 違和感の言語化 — 「なんか変」を仕様の言葉に変換する
- 3. ビジュアルリグレッション差分の判定 — 閾値は思考の代替にならない
- 4. アクセシビリティ — チェックリストの前に3つの体験
- 5. E2E/UIテストの壊れやすさとの付き合い方
- 6. AIとしての自己認識 — スクリーンショットを「見る」ときの限界

## この skill を読む場面

画面・UI・ビジュアルの検証と品質判断のスキル。画面検証(51)やUIテストを設計・実施するとき、スクリーンショットやモックを評価するとき、ビジュアルリグレッションの差分を判定するとき、アクセシビリティを確認するとき、「なんか変だが言語化できない」画面に出会ったとき、デザインの一貫性をレビューするときに必ず使用する。見た目の良し悪しは数値に畳み込めないため、本スキルは観点・語彙・振る舞いでそれを補う。

判断の中身は [[visual-state-verification]] を参照。
