---
template_kind: optional
status: draft
source_id: [ZIP-DOC-038]
source_entries:
  - zip_entry: "vmodel-docgen-clean/templates/38_CI・CDパイプライン設計書.yaml"
    sha256: "sha256:6e129caf87cc0bf5f46e54d9a589e0f7ac8145baf0b1cff0f8ff3c618ab93a85"
disposition: "merge → docs/process/gates.md"
port_index: docs/templates/vmodel/README.md
plan: docs/plans/PLAN-<id>.md
---

# ZIP-DOC-038: CICD設計

本テンプレートは `Vモデル設計ドキュメント_checked.zip` (PO 承認、issue #676) の該当 source document を PLAN-L7-676 §3.5.2 の変換規則で Markdown 化した optional テンプレートである (§3.5.3: required slot には束ねない)。項目名・説明文は zip の日本語をそのまま使い、意味は書き換えていない。zip で空欄・空表の箇所には、記入欄の placeholder (`<記入>`、`<本文を記入>`、`<項目を記入>`) だけを置き、記入例の内容は機械生成しない。

## 本文

### 第1章 方針

- <項目を記入>

### 第2章 パイプライン構成

> ※ 図『CI/CDパイプライン図』参照。

<本文を記入>

### 第3章 ステージ定義

| ステージ | 内容 | ゲート/成果 |
|---|---|---|
| <記入> | <記入> | <記入> |
<!-- 最低 7 行を記入する -->

### 第4章 環境昇格

- <項目を記入>

### 第5章 成果物・バージョニング

- <項目を記入>

### 第6章 デプロイ戦略

- <項目を記入>

### 第7章 品質/セキュリティゲート

| ゲート | 内容 |
|---|---|
| <記入> | <記入> |
<!-- 最低 5 行を記入する -->
