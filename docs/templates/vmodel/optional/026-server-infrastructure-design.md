---
template_kind: optional
status: draft
source_id: [ZIP-DOC-026]
source_entries:
  - zip_entry: "vmodel-docgen-clean/templates/26_サーバー・インフラ設計書.yaml"
    sha256: "sha256:74b48a407693bb09ae41d5c4d005eb69d9f033f82abf57dc2abbc48624603f2d"
disposition: "reference → docs/governance/vmodel-document-catalog.md"
port_index: docs/templates/vmodel/README.md
plan: docs/plans/PLAN-<id>.md
---

# ZIP-DOC-026: インフラ設計

本テンプレートは `Vモデル設計ドキュメント_checked.zip` (PO 承認、issue #676) の該当 source document を PLAN-L7-676 §3.5.2 の変換規則で Markdown 化した optional テンプレートである (§3.5.3: required slot には束ねない)。項目名・説明文は zip の日本語をそのまま使い、意味は書き換えていない。zip で空欄・空表の箇所には、記入欄の placeholder (`<記入>`、`<本文を記入>`、`<項目を記入>`) だけを置き、記入例の内容は機械生成しない。

## 本文

### 第1章 方針

- <項目を記入>

### 第2章 サーバ/コンポーネント一覧

| 名称 | 役割 | 台数/冗長 | スケール |
|---|---|---|---|
| <記入> | <記入> | <記入> | <記入> |
<!-- 最低 6 行を記入する -->

### 第3章 ミドルウェア一覧

| ミドルウェア | 用途 | バージョン方針 |
|---|---|---|
| <記入> | <記入> | <記入> |
<!-- 最低 5 行を記入する -->

### 第4章 キャパシティ・サイジング

- <項目を記入>

### 第5章 冗長化・可用性

- <項目を記入>

### 第6章 スケーリング

| 対象 | 方式 | トリガ |
|---|---|---|
| <記入> | <記入> | <記入> |
<!-- 最低 4 行を記入する -->

### 第7章 構成管理・IaC

- <項目を記入>
