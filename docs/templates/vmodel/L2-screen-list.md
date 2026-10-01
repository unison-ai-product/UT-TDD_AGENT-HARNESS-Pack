---
doc_type_id: DOC-L2-SCREEN
layer: L2
status: draft
source_id: [ZIP-DOC-004]
source_entries:
  - zip_entry: "vmodel-docgen-clean/templates/04_基本設計書.yaml"
    sha256: "sha256:08e051b946f099feaf0aa2d83844a376478e7ba56f3362b00c2648f99da83873"
disposition_target: "PLAN-L7-676 §3.5.3 (直接の source document が無く、04 基本設計書の画面節と diagrams.yaml の画面遷移図から構成)"
construction_note: "本 slot は disposition catalog の直接対応が無い例外 (PLAN-L7-676 §3.5.3)。source は 04 基本設計書の画面一覧/画面遷移章と、diagrams.yaml `画面遷移図` (semantic item catalog `d_screen`) の組み合わせに限り、新規の書き起こしはしていない。"
pair_artifact: docs/test-design/harness/L7-release-consumer-dev-start-test-design.md
plan: docs/plans/PLAN-<id>.md
---

# DOC-L2-SCREEN: 画面一覧・画面遷移

本テンプレートは checked ZIP に L2 の直接 source document が無いため、PLAN-L7-676 §3.5.3 の指示どおり 04 基本設計書の画面節と `diagrams.yaml` の画面遷移図 (semantic item catalog `d_screen`) を組み合わせて構成した。新規の書き起こしは行っていない。

### 構成元: 04 基本設計書 第4章 画面一覧

#### 第4章 画面一覧

| 画面ID | 画面名称 | 概要 | 関連機能 | ロール |
|---|---|---|---|---|
| <記入> | <記入> | <記入> | <記入> | <記入> |
<!-- 最低 7 行を記入する -->

### 構成元: 04 基本設計書 第5章 画面遷移

#### 第5章 画面遷移

##### 5-1 遷移概要

<本文を記入>

##### 5-2 主要遷移

| No | 遷移元 | 操作 | 遷移先 |
|---|---|---|---|
| <記入> | <記入> | <記入> | <記入> |
<!-- 最低 5 行を記入する -->

### 構成元: diagrams.yaml `画面遷移図` (semantic item catalog `d_screen` skeleton)

> trace: 基本設計 第5章

| 画面ノード | ラベル |
|---|---|
| signup | SC-001 サインアップ |
| login | SC-002 ログイン(SSO) |
| projects | SC-003 プロジェクト一覧 |
| board | SC-004 タスクボード |
| members | SC-006 メンバー/権限 |
| dash | SC-005 ダッシュボード |
| billing | SC-007 課金/プラン |

| 遷移元 | 遷移先 | 契機 |
|---|---|---|
| signup | projects | 作成完了 |
| login | projects | 認証 |
| projects | board | PJ選択 |
| projects | members |  |
| projects | dash |  |
| projects | billing | プラン変更 |
