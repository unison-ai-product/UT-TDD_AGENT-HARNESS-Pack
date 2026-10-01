---
template_kind: optional
status: draft
source_id: [ZIP-DOC-044]
source_entries:
  - zip_entry: "vmodel-docgen-clean/templates/44_成果物インデックス・マップ.yaml"
    sha256: "sha256:704cc381dd241ce111cfa5b8cf2f8de9ed93bd28e757c10908ebae60c7d18679"
disposition: "merge → docs/governance/document-system-map.md"
port_index: docs/templates/vmodel/README.md
plan: docs/plans/PLAN-<id>.md
---

# ZIP-DOC-044: 成果物索引

本テンプレートは `Vモデル設計ドキュメント_checked.zip` (PO 承認、issue #676) の該当 source document を PLAN-L7-676 §3.5.2 の変換規則で Markdown 化した optional テンプレートである (§3.5.3: required slot には束ねない)。項目名・説明文は zip の日本語をそのまま使い、意味は書き換えていない。zip で空欄・空表の箇所には、記入欄の placeholder (`<記入>`、`<本文を記入>`、`<項目を記入>`) だけを置き、記入例の内容は機械生成しない。

## 本文

### 第1章 使い方

- <項目を記入>

### 第2章 成果物インデックス(工程別)

> ※ 主要な一覧/定義/台帳の所在。ID接頭辞で横断参照できる。

| 工程 | 成果物 | 種別 | 収録(文書/章) | 接頭辞 |
|---|---|---|---|---|
| <記入> | <記入> | <記入> | <記入> | <記入> |
<!-- 最低 16 行を記入する -->

### 第3章 一覧間リンク・参照マップ

> ※ 図『成果物マップ』参照。一覧は左→右へ参照が連鎖する(紐づけ規約に準拠)。

| 参照元(一覧) | 参照先(一覧) | キー列 |
|---|---|---|
| <記入> | <記入> | <記入> |
<!-- 最低 6 行を記入する -->

### 第4章 図面インデックス

> ※ 図はDSL(diagrams.yaml)から生成。図面集(91)に集約。

| 図 | 種別 | 対応設計 |
|---|---|---|
| <記入> | <記入> | <記入> |
<!-- 最低 8 行を記入する -->
