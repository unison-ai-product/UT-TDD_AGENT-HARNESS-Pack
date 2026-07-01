> **正本化済** (PLAN-REVERSE-01 で DISCOVERY-04 dogfood 実績から正本化、2026-06-04)。docs/process は forward/modes/gates の運用正本。規範変更は concept/requirements (上位正本) 先行 → 本 dir へ反映する。

# Scrum 駆動モデル

出典: concept v3.1 §2.5 (9-mode ecosystem) / §2.6.1 signal→mode (`user_feedback_iteration`) / requirements v1.2 §1.3 kind=poc / §1.5 workflow_phase S0-S4 / §1.6 drive=専門職継承 (V7) / §1.8 role=aim / source process reference (scrum workflow)

---

## 1. 概要

Scrum は **作るものは概ね決定済だが、要件をユーザーとの反復で固めていく**モード。Discovery (「そもそも作れるか/何を作るか未確定」) とは入口が異なり、**ユーザーフィードバックによる継続的な要件調整 (`user_feedback_iteration`) と PO/市場起点の継続的要件変更 (`requirement_continuous_refinement`)** が trigger (両 signal とも同一 Scrum フローに合流)。Discovery と同じ `kind=poc` だが **mode (入口) で識別する** (drive ではない。drive はどちらも対象 work の専門職、§1.6 V7)。frontmatter では Discovery と区別しない (mode は入口分類であり PLAN 識別子ではない、§1.10.A トレードオフ)。

### frontmatter 早見表 (README 台帳より)

| 項目 | 値 |
|------|----|
| kind | `poc` |
| drive | 専門職継承 (be/fe/fullstack/db/agent、§1.6 V7。対象 work の専門職) |
| layer | `cross` |
| workflow_phase | `S0-S4` |
| owner | po + aim |
| 承認者 | — |
| Forward 合流点 | S4 decide → L1 (increment は Reverse fullback で昇華) |

---

## 2. phase / フロー構成

| phase | 名称 | 主な作業 | 成果物 |
|-------|------|----------|--------|
| S0 | Backlog 構築 | プロダクトバックログ作成・優先付け | product backlog |
| S1 | Sprint Plan | スプリントバックログ選択・受入条件確定 | sprint backlog PLAN (kind=poc、drive=対象専門職) |
| S2 | PoC 実装 | スプリント開発 (デイリー同期)。**increment = 1 PLAN 完了の粒度** | increment (動く機能) |
| S3 | Verify | スプリントレビュー (ユーザーと要件すり合わせ) + レトロスペクティブ | レビュー記録・改善事項 |
| S4 | Decide | increment 受入判定 + 次スプリントバックログ更新 | decision record / increment 完了 |

**UT-TDD 粒度定義**: Scrum は終端が曖昧になりやすいため、UT-TDD では **increment = 1 PLAN 完了** を粒度として定義し、完了基準を明確にする。

### スプリント反復フロー

```
S0 Backlog → S1 Plan → S2 実装 → S3 Verify (ユーザーレビュー) → S4 Decide
                ↺ 次スプリントへ反復 (S1 から)
                ↓ increment 受入後
            Reverse fullback → Forward 昇華 (L1/L3-L6 正本化)
```

---

## 3. exit 条件

- increment 完成 (S4 受入判定 pass)
- **Reverse fullback による V-model 昇華完了** (L0-L14 doc 体系へ統合)

スクラムの速さ (反復・フィードバック) と V-model の厳格さ (ドキュメント体系・トレーサビリティ) を両立させるため、increment のみで完了とせず昇華まで含めて exit とする。

---

## 4. Forward 合流点

| 事後に起こす内容 | 昇華先 |
|-----------------|--------|
| 確定した要求・要件 | L1 要求定義 / L3 要件定義 |
| 実装された設計 (方式・機能・データ) | L4 基本設計 / L5 詳細設計 / L6 機能設計 |
| 実装済みのテスト | L8 結合テスト / L9 総合テスト |
| 運用・受入・文書整合 | L11-L14 |

完成機能の文書化は **`kind=reverse` (fullback type)** を経由し、F0-F4 成果物 (evidence / contracts / as-is review / handover checklist / routing) から各工程ドキュメントへ整備する。

> **昇華経路の正確化 (IMP-044)**: Reverse fullback の `forward_routing` は設計層 **L1/L3/L4/L5** のみ (reverse.md §4。L7/L8-L11 は V-model 規律で routing 先から意図的に除外)。よって上表の「L8/L9 結合・総合テスト」「L11-L14」は **routing 先ではなく、設計層へ再入し ①⇔③ を pair-freeze した後に Forward 進行で順次実施される右腕工程**である。Scrum increment の実装済テストは Reverse §2.1 で as-is-test-design (③) として復元 → 再入先 (L4/L5 等) の G4/G5 でペア凍結 → L8/L9 で ④ 実施。**直接 L8-L14 へ routing しない** (forward_routing enum に L8-L14 が無いのは欠落でなく設計の帰結)。

---

## 5. 必須 role / 承認者

| role | 根拠 | 担当 |
|------|------|------|
| `aim` | requirements §1.8 kind=poc 必須 | スプリント実装・verify 主担 |
| `po` | §1.8 owner | バックログ管理・S4 受入判定 |

---

## 6. 他 mode との連鎖 / 注意

| 接続 | 条件 | 説明 |
|------|------|------|
| Forward | 要件確定済 | 要件が最初から確定しているなら Scrum を経由せず Forward 直行 |
| Discovery | 要件未確定 | 「そもそも作れるか/何を作るか」が未確定なら Discovery |
| Reverse | 既存逆引き | 既存資産の逆引きが必要なら Reverse を前段に組合せ |
| Reverse fullback | 後段 (必須) | increment 完了後、Reverse fullback で V-model 昇華が必須 |

翻案注記: UT-TDD route は Scrum の fullback を `ut-tdd reverse fullback ...` として扱う。旧 source process command 名は現行導線にしない。UT-TDD Scrum は Scrum ガイドの構造 (ロール/イベント/作成物) を概念として取り込みつつ、increment=1 PLAN 完了の粒度定義と Reverse fullback による昇華義務を UT-TDD 独自の追加定義とする。

---

出典再掲: README.md 台帳 §2 / concept v3.1 §2.5-§2.6 / requirements v1.2 §1.3/§1.5/§1.6/§1.8 / source process reference (scrum workflow)
