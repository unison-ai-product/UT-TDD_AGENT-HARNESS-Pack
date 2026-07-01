> **正本化済** (PLAN-REVERSE-01 で DISCOVERY-04 dogfood 実績から正本化、2026-06-04)。docs/process は forward/modes/gates の運用正本。規範変更は concept/requirements (上位正本) 先行 → 本 dir へ反映する。

# Retrofit 駆動モデル

出典: concept v3.1 §2.5 (Retrofit mode) / §2.6.1 / §2.6.3 (config_drift 承認者) / requirements v1.2 §1.3 VALID_KINDS / §7.8.3 requires_human_approval

---

## 1. 概要

依存・フレームワーク・基盤の更新/移行・レガシー脱却・構成変更を担う mode。要件は概ね維持したまま**環境・構成を段階的に移す**。Refactor (コード内部) より広く、依存・基盤・構成レベルまでカバーする。

| 項目 | 値 |
|------|-----|
| kind | `retrofit` |
| drive | `be` / `fe` / `fullstack` / `db` / `agent` |
| layer | `L7` |
| workflow_phase | **禁止** (phase なし) |
| owner | `se` + `tl` |
| 承認者 | `config_drift` trigger 時: **tl 単独** (§7.8.3、環境影響限定) |
| 自動 routing signal | `dependency_outdated` / `upgrade` / `config_drift` |

---

## 2. phase / フロー構成

```
現状把握 → 影響評価 (retrofit-matrix) → 移行計画 → 段階移行 → 検証
```

| Step | 内容 | 成果物 |
|------|------|--------|
| 1. 現状把握 | 移行対象の構造・依存・構成を把握する | — |
| 2. 影響評価 | `retrofit-matrix`: 旧→新 対応と影響範囲を整理。`upgrade` 高リスク時は `ut-tdd doctor --preflight upgrade` 必須 (§7.8.3 requires_preflight) | retrofit-matrix.md |
| 3. 移行計画 | 段階・順序・ロールバック手順を確定する | 計画 note (PLAN 本文) |
| 4. 段階移行 | config 更新・並行稼働で段階的に移す | config 差分 (②) |
| 5. 検証 | 回帰テスト (L8)・性能テスト・データ整合性を確認 | CI pass 記録 |

---

## 3. exit 条件

| 条件 | 検証方法 |
|------|---------|
| 回帰テスト全件緑 | L8 結合テスト pass |
| 性能基準維持 | 性能テスト記録 (NFR 定義があれば対照) |
| データ整合性確認 | DB 系 drive は移行前後の整合チェック記録必須 |
| retrofit-matrix 完了 | 全対応項目に "done" 記録 |

---

## 4. Forward 合流点

| 影響範囲 | 合流先 |
|---------|--------|
| 実装レベルのみ | **L7** 内に閉じる |
| アーキ・ADR 変更あり | **L4** 基本設計を追補 |
| 詳細設計・DB スキーマ変更あり | **L4/L5/L7** 追補 |
| 要件自体が変化した | **L1/L3** へ戻す (Add-feature 併用) |
| 検証 | **L8/L9** (回帰・総合) |

> 注: `kind=retrofit` の PLAN 自体は `layer=L7` 固定 (§1.3)。アーキ/詳細設計/要件への**書き戻しが発生する場合は別途 `kind=add-design` (layer=L4/L5) の PLAN を起票**する (retrofit PLAN を layer=L4 で起票すると schema fail)。

---

## 5. 必須 role / 承認者

| role | 責務 |
|------|------|
| `se` | 実装・config 変更主体 |
| `tl` | 影響評価レビュー・移行計画承認 |
| `tl` (承認者) | `config_drift` signal 時、人間サインオフ必須 (§7.8.3) |

承認記録は `.ut-tdd/audit/` に append すること (§7.8.3)。

---

## 6. 他 mode との連鎖 / 注意

| 状況 | 遷移/前段 |
|------|----------|
| 依存更新の影響評価が必要 | **Reverse** (upgrade type) を前段に挟む |
| 要件変更が伴う | **Add-feature** (add-design) を並走 |
| `upgrade` preflight fail | `ut-tdd doctor --preflight upgrade` pass まで移行計画に進まない |
| Refactor との区別 | Refactor = コード構造のみ。Retrofit = 依存・基盤・構成レベル |

注: `config_drift` trigger は必ず tl による承認記録を残す。未承認で当該コマンドを実行した場合 exit 1 (§7.8.3)。
