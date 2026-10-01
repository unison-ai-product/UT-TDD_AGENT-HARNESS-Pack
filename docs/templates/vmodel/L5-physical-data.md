---
doc_type_id: DOC-L5-PHYSICAL-DATA
layer: L5
status: draft
source_id: [ZIP-DOC-022, ZIP-DOC-039]
source_entries:
  - zip_entry: "vmodel-docgen-clean/templates/22_データベース設計書.yaml"
    sha256: "sha256:7e07a8b439fff3e0c8ec5b3d702f346fb36927470d494770aaab73be19cf5574"
  - zip_entry: "vmodel-docgen-clean/templates/39_イベント・メッセージスキーマ設計書.yaml"
    sha256: "sha256:0f7f8a839f461614dcb0ac6c093bd936444171bbcdeb5ad751b00c9c48ec5f3c"
disposition_target: "docs/design/harness/L5-detailed-design/physical-data.md"
pair_artifact: docs/test-design/harness/L7-release-consumer-dev-start-test-design.md
plan: docs/plans/PLAN-<id>.md
---

# DOC-L5-PHYSICAL-DATA: データベース設計書 / イベント・メッセージスキーマ設計書

本テンプレートは `Vモデル設計ドキュメント_checked.zip` (PO 承認、issue #676) の該当 source document を PLAN-L7-676 §3.5.2 の変換規則で Markdown 化したものである。項目名・説明文は zip の日本語をそのまま使い、意味は書き換えていない。zip で空欄・空表の箇所には、記入欄の placeholder (`<記入>`、`<本文を記入>`、`<項目を記入>`) だけを置き、記入例の内容は機械生成しない。

### 移植元: ZIP-DOC-022 DB設計

#### 第1章 設計方針

- <項目を記入>

#### 第2章 論理設計

> ※ エンティティ全体はER図参照。ここでは主キー/関係/制約を定義。

| エンティティ | 主キー | 主な関係 | 主要制約 |
|---|---|---|---|
| <記入> | <記入> | <記入> | <記入> |
<!-- 最低 6 行を記入する -->

#### 第3章 正規化方針

- <項目を記入>

#### 第4章 物理設計・インデックス

> ※ 全テーブルに tenant_id 先頭のインデックスを基本とする。

| テーブル | インデックス | 種別 | 目的 |
|---|---|---|---|
| <記入> | <記入> | <記入> | <記入> |
<!-- 最低 5 行を記入する -->

#### 第5章 パーティション/スケール

- <項目を記入>

#### 第6章 制約・RLS

- <項目を記入>

#### 第7章 データディクショナリ

> ※ 物理列は『詳細設計書(テーブル定義)』、区分値は『設計一覧・定義集(コード一覧)』、命名は『開発標準・規約書』を参照。

- <項目を記入>

#### 第8章 性能・バックアップ

- <項目を記入>

### 移植元: diagrams.yaml `ER図` (semantic item catalog `d_er` skeleton)

> trace: 基本設計 第6章

> 全テーブルが tenant_id を保持しRLSで分離。PK=主キー/FK=外部キー。

| エンティティ id | 名称 | フィールド |
|---|---|---|
| tenants | tenants テナント | PK id, name, plan |
| users | users ユーザー | PK id, FK tenant_id, email, role |
| tasks | tasks タスク | PK id, FK tenant_id, FK project_id, status |
| subs | subscriptions 契約 | PK id, FK tenant_id, status |
| projects | projects PJ | PK id, FK tenant_id, name |
| audit | audit_logs 監査 | PK id, FK tenant_id, action |

| 関連元 | 関連先 | 多重度 |
|---|---|---|
| tenants | users | 1..N |
| tenants | projects | 1..N |
| projects | tasks | 1..N |
| tenants | subs | 1..N |
| tenants | audit | 1..N |

### 移植元: ZIP-DOC-039 イベントスキーマ

#### 第1章 方針

- <項目を記入>

#### 第2章 イベント一覧

> ※ ドメインイベント(ドメインモデル設計)と対応。命名は過去形。

| イベント | 発生源 | 購読 | スキーマID |
|---|---|---|---|
| <記入> | <記入> | <記入> | <記入> |
<!-- 最低 5 行を記入する -->

#### 第3章 スキーマ定義

###### (詳細)

| フィールド | 型 | 説明 |
|---|---|---|
| <記入> | <記入> | <記入> |
<!-- 最低 6 行を記入する -->

###### (詳細)

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| <記入> | <記入> | <記入> | <記入> |
<!-- 最低 4 行を記入する -->

#### 第4章 Webhookペイロード/署名

- <項目を記入>

<本文を記入>

#### 第5章 メッセージング(キュー)契約

| 項目 | 方針 |
|---|---|
| <記入> | <記入> |
<!-- 最低 5 行を記入する -->

#### 第6章 スキーマ進化・バージョニング

- <項目を記入>
