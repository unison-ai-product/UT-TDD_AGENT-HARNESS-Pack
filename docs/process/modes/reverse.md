> **正本化済** (PLAN-REVERSE-01 で DISCOVERY-04 dogfood 実績から正本化、2026-06-04)。docs/process は forward/modes/gates の運用正本。規範変更は concept/requirements (上位正本) 先行 → 本 dir へ反映する。

# Reverse 駆動モデル

出典: concept v3.1 §2.5 (9-mode ecosystem) / §2.6.1 signal→mode (`drift`) / requirements v1.2 §1.3 kind=reverse / §1.5 workflow_phase R0-R4 / §3.3 reverse_type 別 skip 判定 / §1.8 role=po(R3) / source process reference (reverse workflow)

---

## 1. 概要

Reverse は **既存コード・設計・契約が不明な状態**から事実を集め、Forward L0-L14 に安全に接続するための逆引きフロー。drift 検出・未知設計の解明・完了実装の文書整合 (fullback) が主な trigger。Discovery 終点・Scrum increment の昇華先 (fullback) としても機能する。

### frontmatter 早見表 (README 台帳より)

| 項目 | 値 |
|------|----|
| kind | `reverse` |
| drive | 専門職継承 (be/fe/fullstack/db/agent、§1.6 V7。逆引き対象 work の専門職) |
| layer | `cross` |
| workflow_phase | `R0-R4` |
| owner | tl (R3 で po) |
| 承認者 | — (R3 で po 検証必須) |
| Forward 合流点 | R4 `forward_routing` → L1/L3/L4/L5/gap-only (schema enum 5 種) |

---

## 2. phase / フロー構成

| phase | 名称 | 主な作業 | 必須成果物 | skip 判定 (§3.3) |
|-------|------|----------|------------|-----------------|
| R0 | Evidence Acquisition | 対象 (コード/設計/設定) から証拠収集。**既存テストコードの有無調査 (`has_existing_tests`) + test ファイル一覧**も含む | evidence map (`has_existing_tests` 含む) | — |
| R1 | Observed Contracts | API/DB/型/互換契約の観測・抽出 | observed-contracts | `design` / `normalization` type は **R1 skip** |
| R2 | As-Is Design | 現状設計・DAG・影響評価を説明可能にする。**`has_existing_tests=true` なら既存テストから ③ 観測テスト設計を逆復元** (§2.1) | as-is-design / DAG / **as-is-test-design (テスト有時)** | — |
| R3 | Intent Hypotheses | Forward に渡す仮説・gap・routing 候補を作成。**po 検証必須** | intent-hypotheses | — |
| R4 | Gap & Routing | gap を Forward 側に閉塞。`forward_routing` 必須 + `promotion_strategy` 必須。**③ 不在 layer を `missing_pair_artifacts` に記録** (§2.1) | gap-register (`missing_pair_artifacts` 含む) / routing | — |

### 5 type 別 skip 判定 (§3.3)

| reverse_type | R1 skip | 備考 |
|-------------|---------|------|
| `code` | なし | R0→R1→R2→R3→R4 フル |
| `design` | R1 skip | R0→R2→R3→R4 |
| `upgrade` | なし | R4 routing が Forward 接続点、RGC なし |
| `normalization` | R1 skip | R0→R2→R3→R4 |
| `fullback` | なし | Discovery 終点・Scrum increment 昇華に使用 |

---

## 2.1 ③ テスト設計の復元 (V-model 対称性、DISCOVERY-04 V8)

Reverse は ① 設計だけでなく **③ テスト設計も対称に扱う** (V-model は ①⇔③ ペアが原則)。Forward に ① だけ渡すと右腕でペア未凍結テストを後付け (AP-7 違反) する逆ピラミッドを誘発するため、Reverse 側で ③ の状態を確定させる:

| 既存テスト | R0-R4 の扱い |
|-----------|-------------|
| **在る** (`has_existing_tests=true`) | R2 で as-is-test-design (観測テスト設計) を逆復元。Forward routing 先 (L3-L6) の ③ ペアとして引き継ぐ |
| **無い** | R4 gap-register に `missing_pair_artifacts` (① あり ③ 不在の layer) を記録。routing 先で **pair freeze gate (G3/G4/G5/G6) 到達前にテスト設計 PLAN 起票**を exit 条件とする (③ 不在のまま L7 着手禁止) |

> Reverse 自身は ③ test_design / ④ test_code を **generates しない** (Reverse 出力は設計復元文書のみ)。③ テスト設計は Forward 合流先 L3-L6 の Pair freeze で正式に凍結する。Reverse は「③ の as-is / 不在」を**観測・記録**するところまでを担う。

---

## 3. exit 条件

- R4 `forward_routing` が確定し、gap が Forward 側で閉塞
- **③ テスト設計の状態が確定**: 既存テスト有→as-is-test-design 復元済 / 無→`missing_pair_artifacts` 記録済 (§2.1)。未確定のまま R4 exit 不可
- **再入先 Pair freeze gate 通過義務を明示** (§4): routing 確定後、再入先 layer の gate を通すまで L7 着手禁止
- open gap が残る場合は `debt` / `readiness-defer` / 新規 plan へ差し戻し
- R4 で Forward の既存 gate 前提を崩す結果が出た場合は該当ゲートを invalidated に戻す (`--invalidate-forward` 相当)

---

## 4. Forward 合流点

R4 `forward_routing` で動的選択。**値は schema enum `VALID_FORWARD_ROUTING` = `L1` / `L3` / `L4` / `L5` / `gap-only` の 5 種に限る** (src/schema/index.ts §3.4):

| Reverse の結論 | `forward_routing` 値 |
|---------------|---------------------|
| 要件そのものが曖昧 | `L1` (→ L1 要求 / L3 要件) または `L3` |
| 設計判断が不足 | `L4` 基本設計 |
| API / DB / contract が不明 | `L5` 詳細設計 |
| Forward に渡す確定経路が無い (gap のみ) | `gap-only` (debt/readiness-defer へ) |

> **forward_routing が 5 値 (L1/L3/L4/L5/gap-only) に限る理由 (PM アーキ判断で確定、2026-06-02)**: source snapshot は「実装だけで閉じる→L7」「fullback→L8-L11」も routing 先に持つが、**UT-TDD は意図的に L7 / L8-L11 を除外**する。Reverse は **必ず設計層 (L1/L3/L4/L5) に再入して ①⇔③ pair-freeze (G1/G3/G4/G5) を通す** のが V-model 規律であり、L7 (実装) / L8-L11 (検証) へ直接跳ぶのは pair-freeze をバイパスする違反 (source snapshot の緩いモデル)。「実装だけで閉じる」案件は L5 (詳細設計) 経由 (→pair-freeze→L7)、fullback の文書整合は対象 ③ の設計層へ routing するか `gap-only` で新 PLAN 起票。よって **5 値は欠陥でなく V-model 設計の帰結** (§3.4 正本と一致)。enum 拡張は不要。

### 再入先 Pair freeze gate 通過義務 (DISCOVERY-04 V9、gate-design §1.1)

Reverse は ① だけ Forward に渡して終わりではない。**routing 先 layer の Pair freeze gate (①⇔③ 凍結) を通すまで下流 (L7 実装) に着手できない**:

| forward_routing | 再入先で通す gate | 凍結対象 (①⇔③ ペア) |
|----------------|------------------|---------------------|
| `L1` | G1 | 業務要求 ⇔ 運用テスト設計 |
| `L3` | G3 | FR+AC ⇔ 受入テスト設計 |
| `L4` | G4 | アーキ/ADR ⇔ 総合テスト設計 |
| `L5` | G5 | D-API/D-DB/D-CONTRACT ⇔ 結合テスト設計 |

§2.1 で復元/記録した ③ (as-is-test-design or `missing_pair_artifacts`) が、この再入先 gate で ① とペア凍結される。gate 未通過で L7 着手した PLAN は exit 1 (AP-7 準拠)。これは全 mode 共通の合流規約 (Forward 進行時と同一条件、gate-design §1.1)。

> **Add-feature 経路 B との境界 (IMP-043)**: 本 gate 義務は **Reverse routing 後に新規開始する L7** に適用する。Add-feature 経路 B のように L6/L7 を先に build してから Reverse で L3 を back-fill する場合、その先行 L7 (add-impl) は禁止対象外 (bottom-up build は常態、add-feature.md §1.1)。ただし当該実装の **G7 trace 凍結は再入先 G3 通過後まで保留**される (③ 不在のまま trace 確定不可)。「L7 着手禁止」は新規 forward 下降の規律であって、後追い back-fill される bottom-up build を禁じるものではない。

---

## 5. 必須 role / 承認者

| phase | role | 根拠 | 担当 |
|-------|------|------|------|
| R0-R2 | `tl` | §1.8 owner | 技術的な逆引き・設計復元主担 |
| R3 | `po` | requirements §1.8 R3 必須 | 仮説・intent の妥当性検証 (po 確認なし通過不可) |
| R4 | `tl` | §1.8 owner | routing 確定・gap 閉塞判定 |

---

## 6. 他 mode との連鎖 / 注意

| 接続 | 方向 | 説明 |
|------|------|------|
| Discovery | 組合せ (前段/後段) | 既存コード起因の不明点は Reverse 先行 → Discovery PoC。Discovery 終点 → Reverse fullback で昇華 |
| Scrum | 後段 (必須) | Scrum increment 完了 → Reverse fullback で V-model 正本化 |
| Retrofit | 前段 (Retrofit の影響評価) | Retrofit が依存更新の影響評価を要するとき `upgrade` type で前段起動される (retrofit.md §6 の reciprocal)。R4 routing で Retrofit の移行計画ステップへ戻す |
| drift signal | 自動起動 | `drift` (schema/contract) を検出したら detection-routing 経由で自動起動 |

翻案注記: UT-TDD route は reverse workflow を `ut-tdd reverse <type> R0..R4` として扱う。旧 source process command 名は現行導線にしない。`--invalidate-forward` フラグは UT-TDD gate 機構として実装予定 (現状 stub)。type 別成果物ファイル命名 (R0-evidence-map.yaml 等) は source process reference §type 別成果物を踏襲しつつ UT-TDD `.ut-tdd/reverse/` パスへ格納予定。

---

出典再掲: README.md 台帳 §2 / concept v3.1 §2.5-§2.6 / requirements v1.2 §1.3/§1.5/§3.3 / source process reference (reverse workflow)
