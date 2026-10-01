---
schema_version: skill.v1
name: vmodel-code-minimalism
skill_type: process
applies_to:
  layers:
    - L4
    - L5
    - L6
    - L7
  drive_models:
    - Forward
    - Add-feature
    - Refactor
    - Retrofit
triggers: "「書かないコードが最強のコード」の原則に基づく判断のスキル。コードを書き始める前、機能追加・ライブラリ追加・抽象化を提案する前、ハードコードしそうなとき、技術的負債を作る/見つけたとき、実装量を見積もるとき、生成AIで大量のコードが安く書けてしまうときに必ず使用する。正本は 96_設計原則の「最小コードの原則」章。本スキルはその原則を運用する思考と振る舞いを扱う。"
---

# vmodel-code-minimalism

> 移植元: zip `.claude/skills/vmodel-code-minimalism/SKILL.md` (Apache-2.0、PLAN-L7-676 PR-T3)。
> **本ファイルは薄い橋渡し (bridge) であり、判断ロジックの正本は既存 [[code-minimalism]] に統合済み**
> (docs/plans/PLAN-L7-676-release-consumer-dev-start.md §3.5.1「意味が重なる skill は既存 skill への
> 統合を優先し、同じ内容を 2 本持たない」)。実測: 原文の判断内容 (下記見出し) は [[code-minimalism]] の
> decision_points に相当する内容が英語で既にカバーされている。判断が必要なときは [[code-minimalism]]
> を読むこと。本ファイルは zip 原文の日本語見出しへの索引と、移植元固有の語彙 (vmodel-docgen の文書番号
> 参照など) を保持するためだけに存在する。

## zip 原文の節見出し (索引)

- 0. 出発点となる態度
- 1. 書く前の7段の問い（96章の優先順位を思考として回す）
- 2. 書くと決めた後の最小化
- 3. ハードコードの嗅覚 — 埋め込みを見つける問い
- 4. 依存追加の判断 — importも1行のコードである
- 5. 生成AI時代の運用規則（このハーネスでの位置づけ）

## この skill を読む場面

「書かないコードが最強のコード」の原則に基づく判断のスキル。コードを書き始める前、機能追加・ライブラリ追加・抽象化を提案する前、ハードコードしそうなとき、技術的負債を作る/見つけたとき、実装量を見積もるとき、生成AIで大量のコードが安く書けてしまうときに必ず使用する。正本は 96_設計原則の「最小コードの原則」章。本スキルはその原則を運用する思考と振る舞いを扱う。

判断の中身は [[code-minimalism]] を参照。
