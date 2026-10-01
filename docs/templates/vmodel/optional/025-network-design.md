---
template_kind: optional
status: draft
source_id: [ZIP-DOC-025]
source_entries:
  - zip_entry: "vmodel-docgen-clean/templates/25_ネットワーク設計書.yaml"
    sha256: "sha256:cba5f5a01f8b785e245a44d4e6ff9f2c37ce0307bc3da303a14f77cc2f369b0c"
disposition: "reference → docs/governance/vmodel-document-catalog.md"
port_index: docs/templates/vmodel/README.md
plan: docs/plans/PLAN-<id>.md
---

# ZIP-DOC-025: ネットワーク設計

本テンプレートは `Vモデル設計ドキュメント_checked.zip` (PO 承認、issue #676) の該当 source document を PLAN-L7-676 §3.5.2 の変換規則で Markdown 化した optional テンプレートである (§3.5.3: required slot には束ねない)。項目名・説明文は zip の日本語をそのまま使い、意味は書き換えていない。zip で空欄・空表の箇所には、記入欄の placeholder (`<記入>`、`<本文を記入>`、`<項目を記入>`) だけを置き、記入例の内容は機械生成しない。

## 本文

### 第1章 方針

- <項目を記入>

### 第2章 ネットワークセグメント

> ※ デプロイ・ネットワーク構成図(図面集)と対応。マルチAZ。

| セグメント | 配置 | 公開 | 主な要素 |
|---|---|---|---|
| <記入> | <記入> | <記入> | <記入> |
<!-- 最低 4 行を記入する -->

### 第3章 通信要件(ポート/プロトコル)マトリクス

| 送信元 | 宛先 | プロト/ポート | 用途/暗号 |
|---|---|---|---|
| <記入> | <記入> | <記入> | <記入> |
<!-- 最低 5 行を記入する -->

### 第4章 ファイアウォール/SGルール

| ルールID | 方向 | 送信元→宛先 | ポート | 動作 |
|---|---|---|---|---|
| <記入> | <記入> | <記入> | <記入> | <記入> |
<!-- 最低 6 行を記入する -->

### 第5章 DNS・証明書(TLS)

- <項目を記入>

### 第6章 LB/CDN/WAF

- <項目を記入>

### 第7章 外部接続

| 接続先 | 方向 | 方式 | 制御 |
|---|---|---|---|
| <記入> | <記入> | <記入> | <記入> |
<!-- 最低 4 行を記入する -->
