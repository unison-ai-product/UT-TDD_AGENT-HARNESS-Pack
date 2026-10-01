---
template_kind: optional
status: draft
source_id: [ZIP-DOC-050]
source_entries:
  - zip_entry: "vmodel-docgen-clean/templates/50_停止・再開・実行記録設計.yaml"
    sha256: "sha256:00a1202e7dad0b7f2efc90a5235769f6a00c9a41786daae43cac77f577f92273"
disposition: "merge → docs/design/harness/L6-function-design/"
port_index: docs/templates/vmodel/README.md
plan: docs/plans/PLAN-<id>.md
---

# ZIP-DOC-050: 再開/記録設計

本テンプレートは `Vモデル設計ドキュメント_checked.zip` (PO 承認、issue #676) の該当 source document を PLAN-L7-676 §3.5.2 の変換規則で Markdown 化した optional テンプレートである (§3.5.3: required slot には束ねない)。項目名・説明文は zip の日本語をそのまま使い、意味は書き換えていない。zip で空欄・空表の箇所には、記入欄の placeholder (`<記入>`、`<本文を記入>`、`<項目を記入>`) だけを置き、記入例の内容は機械生成しない。

## 本文

### 第1章 方針

- <項目を記入>

### 第2章 対象処理

| 対象 | 中断リスク | 再開方式 |
|---|---|---|
| <記入> | <記入> | <記入> |
<!-- 最低 5 行を記入する -->

### 第3章 チェックポイント・再開設計

- <項目を記入>

### 第4章 実行記録(ジャーナル)

> ※ 実行履歴(ラン)を記録し、再開・監査・障害調査に用いる。

| 記録項目 | 説明 |
|---|---|
| <記入> | <記入> |
<!-- 最低 7 行を記入する -->

### 第5章 冪等・重複排除

- <項目を記入>

### 第6章 中断・再開・リカバリ手順

- <項目を記入>

### 第7章 監査・整合

- <項目を記入>
