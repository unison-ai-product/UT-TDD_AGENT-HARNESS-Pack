---
schema_version: skill.v1
name: vmodel-design-judgement
skill_type: process
applies_to:
  layers:
    - L1
    - L3
    - L4
    - L5
  drive_models:
    - Forward
    - Add-feature
    - Discovery
    - Reverse
triggers: "vmodel-docgen で「どの設計書を書くべきか」「どの粒度で書くか」「この決定はどこに記録するか」を判断するための基準。文書の取捨選択(テーラリング)、プロファイル選定、記載粒度、ADRを書くべきか、要件を分割すべきか、対象外(na)にしてよいか、といった設計判断を求められたら必ず使用する。ユーザーが「この案件に必要な設計書は？」「どこまで書けばいい？」と聞いたときも使用する。"
---

# vmodel-design-judgement

> 移植元: zip `.claude/skills/vmodel-design-judgement/SKILL.md` (Apache-2.0、PLAN-L7-676 PR-T3)。
> **本ファイルは薄い橋渡し (bridge) であり、判断ロジックの正本は既存 [[design-tailoring-and-granularity]] に統合済み**
> (docs/plans/PLAN-L7-676-release-consumer-dev-start.md §3.5.1「意味が重なる skill は既存 skill への
> 統合を優先し、同じ内容を 2 本持たない」)。実測: 原文の判断内容 (下記見出し) は [[design-tailoring-and-granularity]] の
> decision_points に相当する内容が英語で既にカバーされている。判断が必要なときは [[design-tailoring-and-granularity]]
> を読むこと。本ファイルは zip 原文の日本語見出しへの索引と、移植元固有の語彙 (vmodel-docgen の文書番号
> 参照など) を保持するためだけに存在する。

## zip 原文の節見出し (索引)

- 判断の順序
- 文書を採用(todo)にするか対象外(na)にするかの基準
- 記載粒度の基準
- 決定の記録先の使い分け
- AI実装案件での追加判断
- 判断に迷ったときの最終規則

## この skill を読む場面

vmodel-docgen で「どの設計書を書くべきか」「どの粒度で書くか」「この決定はどこに記録するか」を判断するための基準。文書の取捨選択(テーラリング)、プロファイル選定、記載粒度、ADRを書くべきか、要件を分割すべきか、対象外(na)にしてよいか、といった設計判断を求められたら必ず使用する。ユーザーが「この案件に必要な設計書は？」「どこまで書けばいい？」と聞いたときも使用する。

判断の中身は [[design-tailoring-and-granularity]] を参照。
