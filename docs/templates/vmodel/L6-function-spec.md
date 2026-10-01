---
doc_type_id: DOC-L6-FUNCTION-SPEC
layer: L6
status: draft
source_id: [ZIP-DOC-024]
source_entries:
  - zip_entry: "vmodel-docgen-clean/templates/24_ロジック設計書.yaml"
    sha256: "sha256:a6daa9e9a9995758206d3d97844f3414222deba1a15e2d5ebf807dc66bb291fc"
disposition_target: "docs/templates/design/L6-function-spec-template.md (既存テンプレートを正とする例外、PLAN-L7-676 §3.5.3)"
authoritative_template: docs/templates/design/L6-function-spec-template.md
pair_artifact: docs/test-design/harness/L7-release-consumer-dev-start-test-design.md
plan: docs/plans/PLAN-<id>.md
---

# DOC-L6-FUNCTION-SPEC: 機能設計 (ロジック設計書 補足)

L6 スロットの正本テンプレートは `docs/templates/design/L6-function-spec-template.md` (7 必須要素: 配置/IF契約/事前事後条件/失敗モード/データ形/エッジケース表/検証接続) であり、本ファイルはそれを複製しない (PLAN-L7-676 §3.5.3 の L6 例外)。本ファイルは checked ZIP `24_ロジック設計書` のうち、既存テンプレートの 7 要素に無い項目だけを補足として残す。文書を書く際は `docs/templates/design/L6-function-spec-template.md` を雛形として使い、本ファイルの補足節を必要に応じて §3 事前/事後条件・不変条件、または §4 失敗モードへ転記する。

## 補足元: ZIP-DOC-024 ロジック設計書

#### 第1章 方針

- <項目を記入>

#### 第2章 処理ロジック一覧

| 機能 | 主要ロジック | 表現 |
|---|---|---|
| <記入> | <記入> | <記入> |
<!-- 最低 5 行を記入する -->

#### 第3章 デシジョンテーブル(判定表)

> ※ 例: タスク保存時の通知判定。条件の組合せに対するアクションを網羅。

| 条件/アクション | 規則1 | 規則2 | 規則3 | 規則4 |
|---|---|---|---|---|
| <記入> | <記入> | <記入> | <記入> | <記入> |
<!-- 最低 5 行を記入する -->

#### 第4章 業務ルール

| ルールID | 条件 | アクション |
|---|---|---|
| <記入> | <記入> | <記入> |
<!-- 最低 5 行を記入する -->

#### 第5章 擬似コード例

###### (詳細)

<本文を記入>

#### 第6章 状態・例外

- <項目を記入>
