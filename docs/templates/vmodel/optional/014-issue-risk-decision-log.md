---
template_kind: optional
status: draft
source_id: [ZIP-DOC-014]
source_entries:
  - zip_entry: "vmodel-docgen-clean/templates/14_課題・リスク・意思決定管理.yaml"
    sha256: "sha256:99c71a7e398c83b9e6f6a5e7ee9c6e7a25ed7c61dfc3671e92a7bdd06da619f1"
disposition: "merge → docs/adr/"
port_index: docs/templates/vmodel/README.md
plan: docs/plans/PLAN-<id>.md
---

# ZIP-DOC-014: 管理台帳

本テンプレートは `Vモデル設計ドキュメント_checked.zip` (PO 承認、issue #676) の該当 source document を PLAN-L7-676 §3.5.2 の変換規則で Markdown 化した optional テンプレートである (§3.5.3: required slot には束ねない)。項目名・説明文は zip の日本語をそのまま使い、意味は書き換えていない。zip で空欄・空表の箇所には、記入欄の placeholder (`<記入>`、`<本文を記入>`、`<項目を記入>`) だけを置き、記入例の内容は機械生成しない。

## 本文

### 第1章 課題管理表

| No | 課題 | 起票日 | 優先 | 担当 | 状態 | 対応/次アクション |
|---|---|---|---|---|---|---|
| <記入> | <記入> | <記入> | <記入> | <記入> | <記入> | <記入> |
<!-- 最低 6 行を記入する -->

### 第2章 リスク管理表

> ※ リスク値 = 発生確率 × 影響（H=高/M=中/L=低）。

| No | リスク | 確率 | 影響 | リスク値 | 対策 | オーナー |
|---|---|---|---|---|---|---|
| <記入> | <記入> | <記入> | <記入> | <記入> | <記入> | <記入> |
<!-- 最低 6 行を記入する -->

### 第3章 意思決定記録(ADR)一覧

> ※ 詳細は docs/adr/ の各ADR(Markdown)を参照。状態: Proposed/Accepted/Superseded。

| ADR-ID | 決定事項 | 状態 | 日付 | 関連 |
|---|---|---|---|---|
| <記入> | <記入> | <記入> | <記入> | <記入> |
<!-- 最低 5 行を記入する -->

### 第4章 変更管理

| 変更ID | 変更内容 | 影響 | 承認 | 状態 |
|---|---|---|---|---|
| <記入> | <記入> | <記入> | <記入> | <記入> |
<!-- 最低 5 行を記入する -->
