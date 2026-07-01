> **正本化済** (PLAN-REVERSE-01 で DISCOVERY-04 dogfood 実績から正本化、2026-06-04)。docs/process は forward/modes/gates の運用正本。規範変更は concept/requirements (上位正本) 先行 → 本 dir へ反映する。

# Incident 駆動モデル

出典: concept v3.1 §2.5 / §2.6.1 signal→mode (`production_incident`/`hotfix_required`/`regression_prod`) / §2.6.5 env=prod 分岐 / §2.6.3 承認者 / requirements v1.2 §1.3 kind=troubleshoot/recovery / §1.5 workflow_phase 禁止規定 / §1.8 role=aim / source process reference (incident workflow)

---

## 1. 概要

Incident は **本番稼働中の障害・SLO 重大逸脱・セキュリティインシデント**に緊急即応するモード。hotfix で暫定収束させ、収束後に恒久対策を V-model 体系 (Forward L0-L14) へ昇華する。開発中の AI 逸脱は Recovery、計画的な運用改善は L13/L14 で扱う。

**翻案注記 (重要)**: UT-TDD に独立した `incident` kind は存在しない。Incident mode は `troubleshoot` (原因究明・暫定対処) と `recovery` (復旧・ロールバック) の **2 kind を内包する運用パターン**。開発中デグレは Recovery、本番は Incident で分岐 (§2.6.5)。

### frontmatter 早見表 (README 台帳より)

| 項目 | 値 |
|------|----|
| kind | `troubleshoot` + `recovery` (内包) |
| drive | 専門職継承 (be/fe/fullstack/db/agent、§1.6 V7。障害対象 work の専門職) |
| layer | troubleshoot 部分=`L7` / recovery 部分=`cross` (内包 kind ごとに正規 layer。`L7 (+cross)` のような複合値は schema 無効) |
| workflow_phase | **禁止** |
| owner | オンコール + tl + pm |
| 承認者 | **オンコール + tl + pm の三者確認** — 人間サインオフ必須 (§2.6.3) |
| Forward 合流点 | 収束後 → L12/L13 / 恒久対策 → L1-L6 / postmortem → L14 |

**workflow_phase 禁止**: Incident は phase を持たない。フローは以下の箇条書きで定義する。

---

## 2. フロー構成 (phase なし)

```
検出 → トリアージ → 緊急修正 (hotfix) → 即リリース → 収束確認 → 事後昇華
```

1. **検出**: 監視アラート / Discovery の post-deploy trigger から接続。signal: `production_incident` / `hotfix_required` / `regression_prod` (env=prod)
2. **トリアージ**: 影響・緊急度判定。セキュリティインシデントは封じ込めを優先
3. **緊急修正 (hotfix)**: `kind=troubleshoot` PLAN 起票。原因究明 + 暫定対処
4. **即リリース**: hotfix を本番適用
5. **収束確認**: SLO/KPI 正常化確認。`kind=recovery` PLAN で復旧手順・ロールバック記録
6. **事後昇華**: Reverse fullback を活用し恒久対策を V-model へ統合。postmortem を L14 へ

> **起票導線 (2 PLAN 分割)**: Incident は独立 kind を持たないため、**hotfix=`kind=troubleshoot` (token=L7) PLAN** と **復旧記録=`kind=recovery` (token=RECOVERY) PLAN** の 2 件に分けて起票する。recovery PLAN の `dependencies.requires` (or `references`) に troubleshoot PLAN を宣言し連鎖を明示する。恒久対策の昇華は別途 `kind=reverse` (fullback) PLAN。1 incident = troubleshoot + recovery (+ 必要なら reverse) の PLAN 群。

---

## 3. exit 条件

- hotfix 暫定収束 (SLO/KPI 正常化)
- **オンコール + tl + pm の三者確認** (人間サインオフ必須、§2.6.3)
- 恒久対策の Forward 昇華 PLAN 起票済
- postmortem → L14 フィードバック記録済

---

## 4. Forward 合流点

| 事後に起こす内容 | 昇華先 |
|-----------------|--------|
| 暫定 hotfix 収束の記録 | L12/L13 (運用受入・改善) |
| 恒久対策 (要件・設計) | L1 要求定義 / L3 要件定義 / L4-L6 設計 |
| 再発防止テスト | L8 結合テスト / L9 総合テスト |
| postmortem・運用学習 | L14 運用検証 |

hotfix を打ちっぱなしにせず、Reverse fullback (R0-R4、`confirmed_reverse_type=fullback`) を経由して V-model のドキュメント体系・トレーサビリティへ収束させる。

> **再発防止テストの ③-first 規律 (IMP-045)**: 上表「再発防止テスト → L8/L9」は ④ テストコードを直接足す意味ではない。恒久対策の Reverse fullback では §2.1 のとおり **③ テスト設計の as-is を観測・記録 (Reverse 自身は ③ を generates しない) → Forward 合流先 (L4/L5 等) の pair-freeze (G4/G5) で ①⇔③ を凍結 → その後 L8/L9 で ④ 実施**する。①③ 不在のまま ④ だけ追加するのは AP-7/AP-8 違反 (concept §3.5 AP-7 右側ペア未凍結 + §3.4 QA 追加テスト設計分離原則)。

---

## 5. 必須 role / 承認者

| role | 根拠 | 担当 |
|------|------|------|
| `aim` | requirements §1.8 kind=troubleshoot/recovery 必須 | 原因究明・収束手順主担 |
| オンコール | §2.6.3 承認者 | 本番対応の主担・三者確認の一角 |
| `tl` | §2.6.3 承認者 | 技術的な恒久対策判断・三者確認の一角 |
| `pm` | §2.6.3 承認者 | スコープ・影響範囲承認・三者確認の一角 |

---

## 6. 他 mode との連鎖 / 注意

| 接続 / 比較 | 説明 |
|------------|------|
| Recovery | 別モード。Recovery = AI 逸脱・開発中 (`regression_dev`)。Incident = 本番障害 (`regression_prod`, env=prod) で分岐 (§2.6.5) |
| interrupt (IIP/CC) | 別対応。interrupt = 開発中 sprint 内の設計ギャップ・要件変更割込み |
| L13/L14 | 別工程。L13/L14 = 計画的な運用・改善。Incident = 緊急即応 |
| Discovery (前段) | 要件が未確定の場合、Incident 着手前に Discovery を前段起動する (README §5 / discovery.md §6 の reciprocal)。下の「Discovery post-deploy trigger」行とは方向が逆 (前段起動 vs 後段の検出止まり) |
| Discovery post-deploy trigger | 本番後の問題を「検証候補化」するのみ (検出止まり)。緊急対応が要る場合は Incident へ |
| Reverse fullback | 事後昇華の手段。hotfix の恒久対策を V-model 体系へ統合するために使用 |

翻案注記: source process reference には `incident` 専用 kind がなく legacy source も `troubleshoot`+`recovery` の内包として扱う。UT-TDD では README 台帳でこの内包構造を明示し、layer=L7(+cross) と三者承認を UT-TDD 固有の追加定義として確定している。

---

出典再掲: README.md 台帳 §2 / concept v3.1 §2.5/§2.6.3/§2.6.5 / requirements v1.2 §1.3/§1.5/§1.8 / source process reference (incident workflow)
