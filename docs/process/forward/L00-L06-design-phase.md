> **正本化済** (PLAN-REVERSE-01 で DISCOVERY-04 dogfood 実績から正本化、2026-06-04)。docs/process は forward/modes/gates の運用正本。規範変更は concept/requirements (上位正本) 先行 → 本 dir へ反映する。

# 左腕: L0-L6 設計フェーズ

出典: concept v3.1 §3.1 / §3.1.1-§3.1.3.1 / requirements v1.2 §1.4 VALID_LAYERS / §2.2 Pair freeze

---

## 総則

左腕の各層では以下の 2 成果物を **同時に** 起票・凍結する:

- **① 設計成果物** (`docs/design/`)
- **③ テスト設計成果物** (`docs/test-design/`)

左腕完了 = ① + ③ ペアが揃い、対応ゲートを通過した状態。
設計のみ先行・テスト設計を後回しにする運用は V-model 違反 (AP-8: 逆ピラミッド)。

> **正規式モデル (PLAN-RECOVERY-02、2026-06-04 PO 確定、非破壊)**: 左腕各層の検証ペアと検証本質を明確化。
> - **L0 企画 ⇔ 価値検証** (L14→L0 feedback で企画目的・価値の実現を検証) — 従来ペア無しの穴埋め。
> - **谷 = 3 点合算** (L6 機能設計 ① + 単体テスト設計 ③ + L7 コード ②、最小単位)。
> - **L2 画面 = L1 のフェーズ分離**: 画面要求 → 要求/要件 (L1→L3 上流)、画面詳細 → L5 詳細設計に分配。検証本質 = 実データ検証 (本番の実データで画面が成立)。
> - **右腕 = データ実在性エスカレーション** (合成データ→本番実データ→運用→価値、overview §4)。番号・既存ペアは据え置き。

---

## 各層定義

### L0 企画

| 項目 | 内容 |
|------|------|
| 名称 | 企画 (Planning) |
| 目的 | 背景・目的・スコープの高レベル feed-forward 文書を作り、L1 業務要求へ渡す |
| 主要成果物 ① | 企画書 (`kind=charter`、`docs/design/<area>/L0-charter/`) |
| ③ テスト設計ペア | 価値検証 (= L14→L0 feedback、正規式モデル PLAN-RECOVERY-02) |
| V-pair (右腕) | **価値検証** (L14→L0 feedback で企画目的・価値の実現を検証。従来ペア無しの穴埋め、非破壊) |
| 主要ゲート | **G0.5** 企画突合 (軽量: 方向性 L1 trace 可否 + 整合性破綻のみ確認) |
| 入口 | L0 起票 (po 主体、`agent_slots: [po]` 必須) |
| 出口 | G0.5 通過 → L1 業務要求へ baton carry |
| 主要 role | `po` 必須 |

注: G0.5 は「完全性」をチェックしない軽量ゲート。ROI/KGI/KPI 等の定量指標を企画書段階で強制しない。書きすぎ (L1 相当の詳細) は L1 へ降ろす。
出典: concept v3.1 §3.1.1

---

### L1 要求定義

| 項目 | 内容 |
|------|------|
| 名称 | 要求定義 (Business Requirements) |
| 目的 | 業務要求 (BR-*/NFR-*) を 5 sub-doc で確定し、L3 FR+AC 起票の入力とする |
| 主要成果物 ① | 5 sub-doc: business / functional / screen / technical / nfr (`PLAN-L1-01~05`) |
| ③ テスト設計ペア | 運用テスト設計 (→ L14 で実施) |
| V-pair (右腕) | **L14** 運用検証 |
| 主要ゲート | **G1** (3 sub-gate: G1-content / G1-pair / G1-trace) |
| 入口 | G0.5 通過後 |
| 出口 | G1 exit (5 sub-doc 全件 confirmed + L1↔L14 OT ペア孤児 0 + BR/画面/機能 trace 整合) |
| 主要 role | `po` 必須 (業務要求主体)、`tl` 必須 (技術要求・機能要求)  |

**5 sub-doc 必須 / 選択区分 (requirements v1.2 §1.10.G.13)**:

| sub-doc | 区分 | skip 条件 |
|---------|------|-----------|
| business | ① 必須 | — |
| functional | ① 必須 | — |
| nfr | ① 必須 | — |
| technical | ① 必須 | — |
| screen | ② 選択 | UI 無しの be-only drive のみ skip 可 (`skip_sub_doc` に reason ≥10 字) |

注: L1 機能要求 (FR-L1-*) は「ユーザー視点の要望」。L3 機能要件 (FR-*) は「システム仕様+AC」。両者は別物であり L1 に FR を書かない (AP-6)。
出典: concept v3.1 §3.1.2 / §3.1.2.1

---

### L2 画面設計

| 項目 | 内容 |
|------|------|
| 名称 | 画面設計 (Screen Design) |
| 目的 | ワイヤーモック / 画面要求を確定 (L1 のフェーズ分離: 画面要求→要求/要件 L1/L3、画面詳細→L5 詳細設計に分配)。UX 方向性を L4 へ feed-forward |
| 主要成果物 ① | 4 sub-doc: screen-list / screen-flow / wireframe / ui-element |
| ③ テスト設計ペア | ワイヤーモック自体が「UX テスト基準」として機能 (→ L10 で実施) |
| V-pair (右腕) | **L10** UX 磨き |
| 主要ゲート | **G2** 画面凍結 |
| 入口 | G1 exit 後 |
| 出口 | G2 通過 (モック or 画面要求凍結) |
| 主要 role | `uiux` 必須 (drive=fe/fullstack/agent の場合) |

**drive 別 skip ルール (concept v3.1 §3.7)**:

| drive | 扱い |
|-------|------|
| fe / fullstack / agent | 4 sub-doc 全必須 |
| be (UI あり) | screen-list / screen-flow / ui-element 必須、wireframe は省略可 |
| be (BE-only、UI 完全不在) | 全 skip 可 |
| db (UI 無し) | 全 skip 可 |

出典: requirements v1.2 §1.4 L2 / §2.2 G2

---

### L3 要件定義

| 項目 | 内容 |
|------|------|
| 名称 | 要件定義 (System Requirements) |
| 目的 | システム機能要件 (FR-*) + 受入条件 (AC-*) を確定し、設計への入力とする |
| 主要成果物 ① | 3 sub-doc: functional-requirement / business-requirement / nfr-grade |
| ③ テスト設計ペア | 受入テスト設計 (→ L12 で実施) |
| V-pair (右腕) | **L12** デプロイ+受入 |
| 主要ゲート | **G3** 要件凍結 (FR+AC ⇔ 受入テスト設計 ペア凍結) |
| 入口 | G1/G2 exit 後 (L1 業務要求 BR-* が入力) |
| 出口 | G3 通過 (FR+AC 全件確定 + 受入テスト設計 pair 揃い) |
| 主要 role | `tl` 必須 (FR+AC 仕様化)、`po` 必須 (受入条件確認) |

注: FR-* は L1 BR-* から双方向 trace する。AC 不在での G3 通過は fail (AP-4)。
出典: concept v3.1 §3.1.2 / requirements v1.2 §2.2 G3

---

### L4 基本設計

| 項目 | 内容 |
|------|------|
| 名称 | 基本設計 / 外部設計 (Architecture Design) |
| 目的 | アーキテクチャ方針・ADR を確定し、総合テスト設計をペアで凍結する |
| 主要成果物 ① | 5 sub-doc: architecture / function / data / external-if / screen (drive 選択) |
| ③ テスト設計ペア | 総合テスト設計 (→ L9 で実施) |
| V-pair (右腕) | **L9** 総合テスト |
| 主要ゲート | **G4** 基本設計凍結 (tl + pm + tl-advisor 必須) |
| 入口 | G3 exit 後 |
| 出口 | G4 通過 (アーキ/ADR ⇔ 総合テスト設計 pair 揃い + threat model 確認) |
| 主要 role | `tl` 必須 |

**sub-doc 必須 / 選択区分**:

| sub-doc | 区分 | skip 条件 |
|---------|------|-----------|
| architecture | ① 必須 | — |
| data | ① 必須 | — |
| function | ① 必須 | — |
| external-if | ② 選択 | 外部連携なしで skip 可 |
| screen | ② 選択 | UI 無しまたは未確定で skip / defer |

注: L0 → L1 → L4 のドメイン継承チェーン (DDD anti-corruption layer) を維持する。
architecture sub-doc は arc42 §4 (Solution Strategy) + §9 (ADR) を必須 artifact とする。
出典: concept v3.1 §3.1.3 / §3.1.2.2 / requirements v1.2 §1.10.G.13

---

### L5 詳細設計

| 項目 | 内容 |
|------|------|
| 名称 | 詳細設計 / 内部設計 (Detailed Design) |
| 目的 | D-API / D-DB / D-CONTRACT を確定し、結合テスト設計をペアで凍結する |
| 主要成果物 ① | 4 sub-doc: internal-processing / module-decomposition / physical-data / if-detail |
| ③ テスト設計ペア | 結合テスト設計 (→ L8 で実施) |
| V-pair (右腕) | **L8** 結合テスト |
| 主要ゲート | **G5** 詳細設計凍結 (API/Schema Freeze) |
| 入口 | G4 exit 後 |
| 出口 | G5 通過 (D-API/D-DB/D-CONTRACT + 結合テスト設計 pair 揃い) |
| 主要 role | `tl` + `se` |

**sub-doc 必須 / 選択区分**:

| sub-doc | 区分 | skip 条件 |
|---------|------|-----------|
| internal-processing | ① 必須 | — |
| module-decomposition | ① 必須 | — |
| physical-data | ② 選択 | DB 無しで skip |
| if-detail | ② 選択 | 外部 IF 無しで skip |

出典: concept v3.1 §3.1.3 / requirements v1.2 §1.4 L5 / §2.2 G5

---

### L6 機能設計

| 項目 | 内容 |
|------|------|
| 名称 | 機能設計 (Function Design) |
| 目的 | 関数 signature / エッジケース / WBS を確定し、単体テスト設計をペアで凍結する |
| 主要成果物 ① | 3 sub-doc: function-spec / edge-case / class-design (drive 選択) |
| ③ テスト設計ペア | 単体テスト設計 (→ L7 実装スプリント内で TDD Red として実施) |
| V-pair (右腕) | **L7** 実装スプリント内 単体テスト |
| 主要ゲート | **G6** 機能設計凍結 (関数 signature 確定 + WBS 完備) |
| 入口 | G5 exit 後 |
| 出口 | G6 通過 (関数 sig + WBS + 単体テスト設計 pair 揃い) → L7 へ |
| 主要 role | `tl` + `aim` |

**sub-doc 必須 / 選択区分**:

| sub-doc | 区分 | skip 条件 |
|---------|------|-----------|
| function-spec | ① 必須 | — |
| edge-case | ① 必須 | — |
| class-design | ② 選択 | 非 OOP drive で縮退可 |

出典: concept v3.1 §3.1.3.1 / requirements v1.2 §1.4 L6 / §2.2 G6

---

## 左腕共通アンチパターン (要確認)

| # | アンチパターン | 違反内容 |
|---|---------------|----------|
| AP-4 | AC なしで G3 通過 | L3 に受入条件が無いまま実装着手 |
| AP-6 | L1 に FR を書く | 業務要求工程にシステム機能要件が混入 |
| AP-8 | 逆ピラミッド | ① 設計はあるが ③ テスト設計が無い |
| AP-11 | L1 を 1 PLAN にまとめる | 5 sub-doc 分割が要件 |
| AP-12 | L2-L6 sub-doc 構造を持たない | 各層 sub-doc 分割が要件 |

出典: concept v3.1 §3.5
## CODING-RULE-WORKFLOW

Coding-rule documentation is part of the Forward design workflow.

- SSoT: `docs/governance/coding-rules.md`.
- Forward L6: confirm the coding rules are unchanged or update the SSoT before G6/G7 handoff.
- Forward L7 entry: implementation may start only after the L6 design notes and U-CODE tests reflect any coding-rule delta.
- Machine gate: `ut-tdd doctor` runs `checkCodingRules`; missing workflow placement or missing SSoT reference is a hard failure.
## DDD-TDD-WORKFLOW

- SSoT: `docs/governance/ddd-tdd-rules.md`
- Forward L6 must confirm domain boundaries, invariant-to-oracle trace, and TDD strictness rules before L7 implementation.
- L8 confirmation requires IT-* rows with Given/When/Then granularity.
- Important gate points require quantitative checks first, then qualitative review evidence; the two are bundled for freeze readiness.
