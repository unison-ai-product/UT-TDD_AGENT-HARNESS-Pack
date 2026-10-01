---
template_kind: optional
status: draft
source_id: [ZIP-DOC-035]
source_entries:
  - zip_entry: "vmodel-docgen-clean/templates/35_信頼性・DR・BCP設計書.yaml"
    sha256: "sha256:e26b584c423e9c8d172268fb7e89b89b3cb9c4bd680faed5bdf8bc7755dd855f"
disposition: "reference → docs/governance/vmodel-document-catalog.md"
port_index: docs/templates/vmodel/README.md
plan: docs/plans/PLAN-<id>.md
---

# ZIP-DOC-035: DR/BCP設計

本テンプレートは `Vモデル設計ドキュメント_checked.zip` (PO 承認、issue #676) の該当 source document を PLAN-L7-676 §3.5.2 の変換規則で Markdown 化した optional テンプレートである (§3.5.3: required slot には束ねない)。項目名・説明文は zip の日本語をそのまま使い、意味は書き換えていない。zip で空欄・空表の箇所には、記入欄の placeholder (`<記入>`、`<本文を記入>`、`<項目を記入>`) だけを置き、記入例の内容は機械生成しない。

## 本文

### 第1章 信頼性方針

- <項目を記入>

### 第2章 レジリエンスパターン

| パターン | 目的 | 適用例 |
|---|---|---|
| <記入> | <記入> | <記入> |
<!-- 最低 6 行を記入する -->

### 第3章 障害モードと対策

> ※ FMEA的に障害モード→影響→検知→対策を整理。

| 障害モード | 影響 | 検知 | 対策 |
|---|---|---|---|
| <記入> | <記入> | <記入> | <記入> |
<!-- 最低 5 行を記入する -->

### 第4章 DR方針・目標(RTO/RPO)

| シナリオ | RPO | RTO | 方式 |
|---|---|---|---|
| <記入> | <記入> | <記入> | <記入> |
<!-- 最低 4 行を記入する -->

### 第5章 リージョン/AZ障害・フェイルオーバー

- <項目を記入>

### 第6章 DR手順・訓練

- <項目を記入>

### 第7章 BCP(事業継続)

- <項目を記入>
