---
template_kind: optional
status: draft
source_id: [ZIP-DOC-033]
source_entries:
  - zip_entry: "vmodel-docgen-clean/templates/33_トレーサビリティ・ID体系・紐づけ規約.yaml"
    sha256: "sha256:239ad79c91ac88bf7d72fa778e3f47d260b4c9b921f58a79852a9c17a316e653"
disposition: "merge → docs/process/plan-asset-v2.md"
port_index: docs/templates/vmodel/README.md
plan: docs/plans/PLAN-<id>.md
---

# ZIP-DOC-033: 紐づけ規約

本テンプレートは `Vモデル設計ドキュメント_checked.zip` (PO 承認、issue #676) の該当 source document を PLAN-L7-676 §3.5.2 の変換規則で Markdown 化した optional テンプレートである (§3.5.3: required slot には束ねない)。項目名・説明文は zip の日本語をそのまま使い、意味は書き換えていない。zip で空欄・空表の箇所には、記入欄の placeholder (`<記入>`、`<本文を記入>`、`<項目を記入>`) だけを置き、記入例の内容は機械生成しない。

## 本文

### 第1章 目的

- <項目を記入>

### 第2章 ID体系一覧

> ※ 接頭辞で種別を識別。採番はゼロ埋め連番。

| 接頭辞 | 種別 | 定義元(一覧) |
|---|---|---|
| <記入> | <記入> | <記入> |
<!-- 最低 8 行を記入する -->

### 第3章 紐づけルール

> ※ 「一覧(左)」の各行が「定義/上位・下位(右)」を参照する関係を規定。

| 参照元(一覧) | 参照先 | キー列 |
|---|---|---|
| <記入> | <記入> | <記入> |
<!-- 最低 6 行を記入する -->

### 第4章 トレーサビリティ規約

> ※ 前後工程の対応(Vモデル)。俯瞰図で全体を一望。

| 上流 | 下流(設計) | 対応テスト |
|---|---|---|
| <記入> | <記入> | <記入> |
<!-- 最低 5 行を記入する -->

### 第5章 相互参照・命名ルール

- <項目を記入>

### 第6章 整合検証(validate)ルール

- <項目を記入>
