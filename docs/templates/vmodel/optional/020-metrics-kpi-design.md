---
template_kind: optional
status: draft
source_id: [ZIP-DOC-020]
source_entries:
  - zip_entry: "vmodel-docgen-clean/templates/20_計測・KPI設計書.yaml"
    sha256: "sha256:1f9d9548ed85001b387be1c8212462ebc7a68e110c88799c8655cd6840f295b2"
disposition: "merge → docs/design/harness/L1-requirements/business-requirements.md"
port_index: docs/templates/vmodel/README.md
plan: docs/plans/PLAN-<id>.md
---

# ZIP-DOC-020: 計測設計

本テンプレートは `Vモデル設計ドキュメント_checked.zip` (PO 承認、issue #676) の該当 source document を PLAN-L7-676 §3.5.2 の変換規則で Markdown 化した optional テンプレートである (§3.5.3: required slot には束ねない)。項目名・説明文は zip の日本語をそのまま使い、意味は書き換えていない。zip で空欄・空表の箇所には、記入欄の placeholder (`<記入>`、`<本文を記入>`、`<項目を記入>`) だけを置き、記入例の内容は機械生成しない。

## 本文

### 第1章 計測方針

- <項目を記入>

### 第2章 KPIツリー

> ※ 事業KPI←プロダクトKPI←技術KPI(SLI)の因果でツリー化。企画のKPIと整合。

| 層 | KPI | 定義 | 目標 |
|---|---|---|---|
| <記入> | <記入> | <記入> | <記入> |
<!-- 最低 7 行を記入する -->

### 第3章 メトリクス定義

| メトリクスID | 名称 | 種別 | 単位 | 収集元 |
|---|---|---|---|---|
| <記入> | <記入> | <記入> | <記入> | <記入> |
<!-- 最低 6 行を記入する -->

### 第4章 イベント計測設計

> ※ プロダクト分析用のイベント。命名は snake_case、共通プロパティに tenant_id/user_id/timestamp。

| イベント名 | 発火点 | 主なプロパティ |
|---|---|---|
| <記入> | <記入> | <記入> |
<!-- 最低 6 行を記入する -->

### 第5章 計測ポイント/実装方針

- <項目を記入>

### 第6章 ダッシュボード/分析

| ダッシュボード | 対象KPI | 閲覧者/頻度 |
|---|---|---|
| <記入> | <記入> | <記入> |
<!-- 最低 5 行を記入する -->

### 第7章 データ品質・プライバシー

- <項目を記入>
