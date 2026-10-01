---
template_kind: optional
status: draft
source_id: [ZIP-DOC-015]
source_entries:
  - zip_entry: "vmodel-docgen-clean/templates/15_開発標準・規約書.yaml"
    sha256: "sha256:3633280fbdad6e3b2a3e342bd5ef35e5feb7a0944acb2be05d9cda269ddeb6fa"
disposition: "merge → docs/governance/coding-rules.md"
port_index: docs/templates/vmodel/README.md
plan: docs/plans/PLAN-<id>.md
---

# ZIP-DOC-015: 開発標準

本テンプレートは `Vモデル設計ドキュメント_checked.zip` (PO 承認、issue #676) の該当 source document を PLAN-L7-676 §3.5.2 の変換規則で Markdown 化した optional テンプレートである (§3.5.3: required slot には束ねない)。項目名・説明文は zip の日本語をそのまま使い、意味は書き換えていない。zip で空欄・空表の箇所には、記入欄の placeholder (`<記入>`、`<本文を記入>`、`<項目を記入>`) だけを置き、記入例の内容は機械生成しない。

## 本文

### 第1章 標準化方針

- <項目を記入>

### 第2章 命名規約

#### 2-1 データベース

| 対象 | 規約 | 例 |
|---|---|---|
| <記入> | <記入> | <記入> |
<!-- 最低 5 行を記入する -->

#### 2-2 API

| 対象 | 規約 | 例 |
|---|---|---|
| <記入> | <記入> | <記入> |
<!-- 最低 5 行を記入する -->

#### 2-3 ID体系

| 種別 | 接頭辞 | 用途 |
|---|---|---|
| <記入> | <記入> | <記入> |
<!-- 最低 5 行を記入する -->

### 第3章 コーディング規約

- <項目を記入>

> ※ 具体のツール(Linter/Formatter/カバレッジ閾値)はプロジェクトの言語に合わせて設定する。

### 第4章 ログ・エラーコード体系

#### 4-1 ログ方針

- <項目を記入>

#### 4-2 エラーコード体系

| 区分 | コード規則 | 例 | HTTP |
|---|---|---|---|
| <記入> | <記入> | <記入> | <記入> |
<!-- 最低 5 行を記入する -->

### 第5章 例外・リトライ標準

- <項目を記入>

### 第6章 UI/UX標準

- <項目を記入>

### 第7章 Git/CI標準

#### 7-1 ブランチ/コミット

- <項目を記入>

#### 7-2 CIゲート

| ゲート | 内容 |
|---|---|
| <記入> | <記入> |
<!-- 最低 5 行を記入する -->
