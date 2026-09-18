---
plan_id: PLAN-L7-NN-impl-slug   # §1.10 A: PLAN-<layer>-<NN>-<slug>。impl は layer L7
title: "PLAN-L7-NN: (実装タイトル placeholder)"
kind: impl
layer: L7
drive: be
status: draft
created: 2026-MM-DD
owner: PM (Opus)
agent_slots:
  - role: po
    slot_label: "PO — スコープ判断・受入承認"
  - role: tl
    slot_label: "TL — 設計レビュー・契約凍結"
  - role: se
    slot_label: "SE — 機能実装"
  - role: qa
    slot_label: "QA — テスト戦略・品質判定"
generates:
  - artifact_path: src/<module>.ts
    artifact_type: source_module
  - artifact_path: tests/<module>.test.ts
    artifact_type: test_code
  - artifact_path: docs/test-design/PLAN-NNN-unit-test-design.md
    artifact_type: test_design
dependencies:
  parent: null
  requires: []
  blocks: []
related_adr:
  - docs/adr/ADR-001-ut-tdd-harness-redesign-and-language.md
related_docs:
  - docs/governance/ut-tdd-agent-harness-requirements_v1.2.md
---

## §0 PLAN

実装対象タスクを最小差分で起票し、機械チェック・テスト・レビューまでを Plan テンプレート単位で再現可能な流れに定着させる。

## §1 目的

(本 PLAN で何を実装するかを 1-2 段落で記述)

## §2 背景

- (なぜこの実装が必要か、関連する requirement / ADR / 設計 PLAN へのリンク)

## §3 実装計画 (Sprint 標準 8 ステップ)

### Step 1: Entry

- 直前 PLAN / 依存条件の完了確認、ロール整合の再確認、scope 明示。

### Step 2: 着手前調査

- 既存実装の流用候補確認、重複シンボル検出、既存テストの確認。

### Step 3: 機能設計 + テスト設計 pair freeze

- design (D-API / D-DB) と test-design の対応先固定、変更対象 scope の明確化。

### Step 4: 実装

- 対象 artifact を最小単位で更新、既存仕様を崩さないよう差分を抑える。

### Step 5: 機械チェック

- `tsc --noEmit` (型チェック)、`eslint` / shellcheck / markdownlint / yamllint、関連 lint・静的検査を実行し結果を記録。

### Step 6: テスト

- 対象範囲単体テスト、関連結合テスト、必要なら全回帰を実行。failure は再現手順を記載。

### Step 7: レビュー

- セルフレビュー + 1 段階の高信頼レビュー観点 (安全性、V-model trace、既存契約) を実施。code-reviewer subagent 推奨。

### Step 8: DoD

- 受入条件を checklist 化、関連 PLAN / ADR / docs 参照整合まで完了したら実装 DoD。

## §4 受入条件 / DoD

- [ ] Step 1〜8 のすべてが該当 section に存在
- [ ] `generates` に対応する実装ファイルとテストファイルが存在
- [ ] `tsc --noEmit` + `vitest` 全 PASS
- [ ] 関連設計 PLAN への双方向 trace が明示済み
- [ ] §6 用語更新 が存在 (当該工程の新規 / 精緻化用語を L0 §10 用語集へ back-merge する delta、無ければ「用語更新なし」明記、要件 §1.10.G.9)
- [ ] §7 機能要求更新 が存在 (新規 / 拡張 FR-L1 を §1 registry へ back-merge する delta、無ければ「機能要求更新なし」明記、要件 §1.10.G.10)
- [ ] frontmatter `kind == impl`、§0〜§7 完備

## §5 関連 PLAN / ADR / docs

- 関連 PLAN: (依存 / 後続 PLAN を列挙)
- 関連 ADR: (採用判断 ADR があれば列挙)
- 参照 docs: `docs/governance/ut-tdd-agent-harness-requirements_v1.2.md`、`docs/adr/ADR-001-ut-tdd-harness-redesign-and-language.md`

## §6 用語更新 (living glossary delta)

当該工程で新規導入 / 精緻化したユビキタス言語を記録し、L0 §10 用語集 (`docs/governance/ut-tdd-agent-harness-concept_v3.1.md`) へ back-merge する (独自定義禁止、anti-corruption layer / 要件 §1.10.G.9)。

| 用語 | 種別 (新規 / 精緻化) | 定義 / 変更点 | L0 §10 back-merge (導入層 / 更新層) |
|---|---|---|---|
| (例) ... | 新規 | ... | 導入層 = 当該 layer |

> 当該工程で用語の新規導入・意味変更が無い場合は本文に `用語更新なし` と明記する。

## §7 機能要求更新 (FR registry delta)

当該工程で発見 / 拡張した機能要求を記録し、L1 機能一覧 (`docs/design/harness/L1-requirements/functional-requirements.md` §1) へ back-merge する (FR registry SSoT / 要件 §1.10.G.10、§1.2 back-propagation 手順)。

| FR-L1-ID | 種別 (新規 / 拡張) | 機能要求名 / 変更点 | 重要度 | 対応画面 | §1 登録 + screen §5 紐付け |
|---|---|---|---|---|---|
| (例) FR-L1-NN | 新規 | ... | P0/P1/P2 | PM-/HM-/GD- | §1 行追加 + 件数宣言更新 |

> 新規 FR は §1 行追加 / screen §5 trace 紐付け / header 件数確定宣言更新 / ledger 記録 の 4 点を満たす。機能要求の新規・変更が無い場合は本文に `機能要求更新なし` と明記する。
