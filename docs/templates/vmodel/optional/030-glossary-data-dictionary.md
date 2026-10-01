---
template_kind: optional
status: draft
source_id: [ZIP-DOC-030]
source_entries:
  - zip_entry: "vmodel-docgen-clean/templates/30_用語集・データディクショナリ.yaml"
    sha256: "sha256:42327c7fbd5710ef468ed21cc3b48795377da4f30db4612fcf301c9968b98613"
disposition: "adopt → docs/governance/document-system-map.md"
port_index: docs/templates/vmodel/README.md
plan: docs/plans/PLAN-<id>.md
---

# ZIP-DOC-030: 用語集

本テンプレートは `Vモデル設計ドキュメント_checked.zip` (PO 承認、issue #676) の該当 source document を PLAN-L7-676 §3.5.2 の変換規則で Markdown 化した optional テンプレートである (§3.5.3: required slot には束ねない)。項目名・説明文は zip の日本語をそのまま使い、意味は書き換えていない。zip で空欄・空表の箇所には、記入欄の placeholder (`<記入>`、`<本文を記入>`、`<項目を記入>`) だけを置き、記入例の内容は機械生成しない。

## 本文

### 第1章 目的・運用

- <項目を記入>

### 第2章 ビジネス/ドメイン用語

| 用語 | 定義 | 英語/i18nキー |
|---|---|---|
| <記入> | <記入> | <記入> |
<!-- 最低 7 行を記入する -->

### 第3章 略語・表記ルール

| 略語 | 正式 | 表記統一(例) | 禁止表記(検出対象) |
|---|---|---|---|
| <記入> | <記入> | <記入> | <記入> |
<!-- 最低 6 行を記入する -->

### 第4章 データ項目辞書

> ※ 物理列は詳細設計(テーブル定義)、区分値はコード一覧を参照。ここは論理項目の一元辞書。

| 論理名 | 物理名 | 型/桁 | 区分値/備考 |
|---|---|---|---|
| <記入> | <記入> | <記入> | <記入> |
<!-- 最低 6 行を記入する -->

### 第5章 用語のトレース

- <項目を記入>
