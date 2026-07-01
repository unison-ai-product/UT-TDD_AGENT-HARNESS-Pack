> **正本化済** (PLAN-REVERSE-01 で DISCOVERY-04 dogfood 実績から正本化、2026-06-04)。docs/process は forward/modes/gates の運用正本。規範変更は concept/requirements (上位正本) 先行 → 本 dir へ反映する。

# Add-feature 駆動モデル

出典: concept v3.1 §2.5 (Add-feature mode) / requirements v1.2 §1.3 VALID_KINDS (`add-design`/`add-impl`) / §1.6 drive matrix / §1.8 必須 role / §1.10 E (dependencies.parent 必須)

---

## 1. 概要

既存システム (Forward/V-model doc 体系あり) への新機能追加 mode。フル工程をゼロから通すのではなく、**影響範囲の差分だけを追補**する。`add-design` と `add-impl` の 2 kind を内包し、独立した `add-feature` kind は存在しない。

| 項目 | 値 |
|------|-----|
| kind | `add-design` (設計追補 L3-L6) + `add-impl` (実装追補 L7) を内包 |
| drive | 親 PLAN の drive と一致 (§1.6) |
| layer | `L3`-`L7` (影響範囲による) |
| workflow_phase | **禁止** (phase なし) |
| owner | `aim` + `tl` |
| 承認者 | — (人間サインオフ不要) |
| 自動 routing signal | `feature_addition` / `scope_extension` |

---

## 1.1 標準ライフサイクル (最頻 = bottom-up build → Reverse back-fill)

**Add-feature は実務で最頻の駆動モデル**であり、要件が先に固まるとは限らない。多くは **「作れる/作りたい機能」が先に具体化** → **機能設計 (L6) と実装 (L7) を先に作る** → **要件 (L3) は後追いで Reverse fullback により back-fill / 修正**する (PO 2026-06-02 確定。bottom-up build → 上位整合)。よって 2 経路を持つ:

| 経路 | いつ | 流れ |
|------|------|------|
| **B. bottom-up (最頻、default)** | 機能が具体・要件は後追いで足りる | **add-design (L6 機能設計) → add-impl (L7) → Reverse (R0-R4) で L3 要件定義へ back-fill/修正 (fullback)** → V-model 整合 |
| A. top-down | 要件側の追補が先に要る (スコープ拡張・契約変更) | 要件追補 (L1/L3) → add-design (L4-L6) → add-impl (L7) → テスト確認 |

> **なぜ Reverse で戻すか**: bottom-up で L6/L7 を先に作ると L3 要件が空くため、V-model の左腕が孤児化する。**Reverse (`confirmed_reverse_type=fullback`、`forward_routing=L3`) で実装事実から L3 要件を逆復元し、①⇔③ ペアを G3 で凍結**することで整合を回復する (要件は「後で Reverse 正本化」が前提)。これは Add-feature の例外でなく **常態**。

> **経路 B と Reverse gate 通過義務の境界 (IMP-043)**: `reverse.md §4`「再入先 Pair freeze gate 通過まで L7 着手禁止」は **Reverse routing 後に新規開始する下流 L7** を規律するルール。経路 B の add-impl (L7) は Reverse より**前**に存在する bottom-up build であり、この先行実装は禁止対象ではない (bottom-up build → 後追い back-fill は常態)。Reverse は既存実装から L3 ① を復元し G3 で ①⇔③ を遡及凍結する。**ただし当該 add-impl の G7 4-artifact trace 凍結は、Reverse が G3 ペア凍結を閉じるまで保留**される (③ 不在のまま trace 確定不可、AP-7/AP-8 準拠)。= 先行 build は許容、trace 確定は pair-freeze 後。

---

## 2. phase / フロー構成 (Step 集合)

下表は経路 A/B 共通の Step 集合。**経路 B (最頻) では Step 2 (要件追補) を Step 6 の後段 Reverse へ送る**:

```
[B 最頻] 影響範囲特定 → add-design(L6) → add-impl(L7) → テスト確認 → Reverse(R0-R4)→L3 要件 back-fill → V-model 整合
[A]      影響範囲特定 → 要件追補(L1/L3) → add-design(L4-L6) → add-impl(L7) → テスト確認 → V-model 統合
```

| Step | 内容 | 成果物 |
|------|------|--------|
| 1. 影響範囲特定 | 既存 L1-L14 doc のどこに影響するか洗い出す | 影響範囲メモ |
| 2. 要件追補 (A) / 後送 (B) | A=先に L1/L3 追補。**B=ここでは飛ばし Step 6 の Reverse で back-fill** | L1/L3 差分 (A のみ) |
| 3. add-design | 機能設計 (L6) 中心 (B) / L4-L6 (A)。`dependencies.parent` に親 PLAN 必須 | add-design PLAN + ① |
| 4. add-impl | L7 実装。`dependencies.parent` に親 add-design PLAN 必須 | add-impl PLAN + ②④ |
| 5. 既存テスト確認 + 追加テスト | L8/L9 で既存テスト影響確認、追加テスト起票 | ③ + ④ 差分 |
| 6. V-model 整合 | **B: Reverse (R0-R4, fullback, forward_routing=L3) で L3 要件を back-fill → G3 凍結**。A: 追補を該当工程ファイルへ反映 | trace 更新 / L3 要件復元 |

---

## 3. exit 条件

| 条件 | 検証方法 |
|------|---------|
| 追補が該当工程ファイルに反映済 | docs/design/ + docs/test-design/ の差分確認 |
| 双方向 trace 更新完了 | G7 8 directed edge に孤児が無いこと |
| 既存テスト緑維持 | L8/L9 CI pass |
| `dependencies.parent` 設定済 | validator (§1.10 E) が fail-close 検証 |

---

## 4. Forward 合流点

- **既存 L1-L14 を維持しつつ L3/L7 差分を追補**。削除・上書きでなく追加記述。
- **最頻 (経路 B)**: L6/L7 を先に作り、**後段 Reverse (fullback, forward_routing=L3) で L3 要件を back-fill** → G3 で ①⇔③ 凍結。要件は後追い正本化。
- 影響範囲に応じて L1 / L3 / L4-L7 に直接接続 (経路 A)。
- L8/L9 で既存テストへの影響を確認する。
- L11 UAT フィードバックの巻き取りは **add-design** で起票 (既存 doc を直接変更しない)。

---

## 5. 必須 role / 承認者

| role | 責務 |
|------|------|
| `aim` | 影響範囲特定・追補設計・監視 |
| `tl` | 設計判断・V-model 統合レビュー (frontier-reviewer class) |

---

## 6. 他 mode との連鎖 / 注意

| 状況 | 前段/遷移 |
|------|----------|
| **bottom-up build 後の要件 back-fill (最頻)** | **Reverse を後段に必須** (R0-R4, fullback, forward_routing=L3。§1.1 経路 B)。Add-feature→Reverse は例外でなく常態 |
| 追加要件が未確定 | **Discovery** を前段に挟む (S0-S4 で仮説検証) |
| 既存設計の逆引きが必要 | **Reverse** を前段に挟む (R0-R4 で実装遡及) |
| 機能追加でなく構造改善 | **Refactor** へ切替 |
| 依存・基盤変更が必要 | **Retrofit** へ切替 |

重要注記:
- `add-design` / `add-impl` どちらも `dependencies.parent` が null の場合 validator は exit 1 (§1.10 E)。
- drive は親 PLAN と一致させる。不一致は §1.6 matrix 違反で fail-close。
- 4 artifact (①②③④) の追補セットを新規 Forward と同じ規律で揃えること (AP-8 逆ピラミッド禁止)。
## CODING-RULE-WORKFLOW

Coding-rule documentation is part of Add-feature, not only CI.

- SSoT: `docs/governance/coding-rules.md`.
- Step 3 `add-design`: record coding-rule impact as `unchanged` or update the SSoT with the delta.
- Step 4 `add-impl`: start only after coding-rule impact is resolved and U-CODE tests cover any new rule behavior.
- Machine gate: `ut-tdd doctor` runs `checkCodingRules`; missing workflow placement or missing SSoT reference is a hard failure.
## DDD-TDD-WORKFLOW

- SSoT: `docs/governance/ddd-tdd-rules.md`
- `add-design` must record DDD boundary/invariant impact or explicit no-impact.
- `add-impl` must preserve Red-first TDD evidence when `tdd_red_required: true` is present.
- Critical Add-feature decisions bundle quantitative evidence (`tests_green_at`) with qualitative reviewer evidence before confirmation.
