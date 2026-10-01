---
doc_type_id: DOC-L11-TRACE-UAT
layer: L11
status: draft
source_id: [ZIP-DOC-028]
source_entries:
  - zip_entry: "vmodel-docgen-clean/templates/28_検証設計書.yaml"
    sha256: "sha256:740af962617ec39ef6be584bac2918838526b8416680f60d0c47a596dbbb4835"
disposition_target: "docs/process/evidence/g11-uat-review-design.md"
pair_artifact: docs/test-design/harness/L7-release-consumer-dev-start-test-design.md
plan: docs/plans/PLAN-<id>.md
---

# DOC-L11-TRACE-UAT: 検証設計書 (+ traceability.yaml のトレース俯瞰)

本テンプレートは `Vモデル設計ドキュメント_checked.zip` (PO 承認、issue #676) の該当 source document を PLAN-L7-676 §3.5.2 の変換規則で Markdown 化したものである。項目名・説明文は zip の日本語をそのまま使い、意味は書き換えていない。zip で空欄・空表の箇所には、記入欄の placeholder (`<記入>`、`<本文を記入>`、`<項目を記入>`) だけを置き、記入例の内容は機械生成しない。

### 移植元: ZIP-DOC-028 検証設計

#### 第1章 検証方針・方式

> ※ 検証=要件が満たされることの確認。方式は複数を組合せる。

| 検証方式 | 内容 |
|---|---|
| <記入> | <記入> |
<!-- 最低 4 行を記入する -->

#### 第2章 検証マトリクス

> ※ 要件(F/NF)を、どの方式・レベル・技法・ケースで検証するかを一意に対応づける。

| 要件 | 検証方式 | テストレベル | 技法 | ケースID |
|---|---|---|---|---|
| <記入> | <記入> | <記入> | <記入> | <記入> |
<!-- 最低 6 行を記入する -->

#### 第3章 テスト設計技法カタログ

> ※ ISTQB準拠のブラックボックス技法を対象特性で使い分ける。

| 技法 | 概要 | 適用例 |
|---|---|---|
| <記入> | <記入> | <記入> |
<!-- 最低 6 行を記入する -->

#### 第4章 テストデータ設計

- <項目を記入>

#### 第5章 カバレッジ基準

| 観点 | 基準/目標 |
|---|---|
| <記入> | <記入> |
<!-- 最低 6 行を記入する -->

#### 第6章 リスクベーステスト

- <項目を記入>

#### 第7章 エントリ/エグジット基準

| レベル | エントリ(開始) | エグジット(完了) |
|---|---|---|
| <記入> | <記入> | <記入> |
<!-- 最低 4 行を記入する -->

#### 第8章 契約テスト(CDC)

- <項目を記入>
