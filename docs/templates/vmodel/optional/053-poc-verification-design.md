---
template_kind: optional
status: draft
source_id: [ZIP-DOC-053]
source_entries:
  - zip_entry: "vmodel-docgen-clean/templates/53_PoC検証設計書.yaml"
    sha256: "sha256:c42b2e179d01218d9e67978b9f871bf008176d676d52daf220ac9d57288d541e"
disposition: "merge → docs/process/modes/"
port_index: docs/templates/vmodel/README.md
plan: docs/plans/PLAN-<id>.md
---

# ZIP-DOC-053: PoC検証

本テンプレートは `Vモデル設計ドキュメント_checked.zip` (PO 承認、issue #676) の該当 source document を PLAN-L7-676 §3.5.2 の変換規則で Markdown 化した optional テンプレートである (§3.5.3: required slot には束ねない)。項目名・説明文は zip の日本語をそのまま使い、意味は書き換えていない。zip で空欄・空表の箇所には、記入欄の placeholder (`<記入>`、`<本文を記入>`、`<項目を記入>`) だけを置き、記入例の内容は機械生成しない。

## 本文

### 第1章 目的・検証仮説

> ※ PoC=不確実性の高い部分を素早く検証。作り込みは最小限。

- <項目を記入>

### 第2章 検証項目

| 観点 | 検証したいこと | 方法 |
|---|---|---|
| <記入> | <記入> | <記入> |
<!-- 最低 5 行を記入する -->

### 第3章 成功基準・Go/No-Go

| 項目 | 成功基準(例) | 判定 |
|---|---|---|
| <記入> | <記入> | <記入> |
<!-- 最低 5 行を記入する -->

> ※ 全Go条件を満たせばGo(本開発へ)、未達や重大リスクがあればNo-Go(中止/方針転換)。

### 第4章 スコープ・前提・体制

- <項目を記入>

### 第5章 評価方法・計測

- <項目を記入>

### 第6章 結果記録・判断

| 検証項目 | 結果 | 判定 |
|---|---|---|
| <記入> | <記入> | <記入> |
<!-- 最低 5 行を記入する -->

### 第7章 本開発への引継ぎ/破棄

- <項目を記入>
