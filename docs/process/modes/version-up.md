> **正本化** (PLAN-DISCOVERY-09 S4 ADOPT、2026-06-26)。docs/process は forward/modes/gates の運用正本。規範変更は concept/requirements (上位正本) 先行 → 本 dir へ反映する。

# version-up 駆動モデル

出典: concept v3.1 §2.5 (9-mode 後の追加 mode) / requirements v1.2 §6.8.8.1 (forward-convergence) / §7.8.1 (`version_deferral` signal) / PLAN-DISCOVERY-09

---

## 1. 概要

version-up は、確立済/計画済の capability を **将来の製品バージョンへ保全 (preserve)** する mode。**いまは Forward freeze / 配布スコープに入れない**が、**archived (破棄) ではなく将来版で Forward へ入れる**ことを **明示・機械追跡**する。

「deferred-but-committed-future」= **archived (破棄) でも plain draft (WIP) でも Add-feature (今追加) でも Retrofit (依存 upgrade) でもない第 4 の状態**。第一ケース = 中央UI (画面、PLAN-L7-141 / PLAN-L7-146) を「画面なし配布 (PLAN-L7-157 R2)」の下で将来版へ保全。

## 2. 入口条件

- signal = `version_deferral` (PO 決定: ある capability を将来版へ保全。今スコープ外だが破棄しない)。
- 既存の active draft (WIP) との違い = **明示の意図** (将来版で必ず入れる)。archived との違い = **保全** (消さない)。

## 3. 機械表現 (新 kind を作らない)

- 保全中の PLAN は **既存 kind を維持** (例: impl) + `status=draft` + frontmatter **`version_target: <label>`**。
- `version_target` は **status=draft でのみ有効** (landed=confirmed/completed には付与禁止 = schema fail-close)。label は version-up ledger (`src/lint/forward-convergence.ts` `VERSION_UP_ALLOWED_TARGETS`) に照合する。
- `ut-tdd status` の outstanding は **active draft と version-up parked を分離**表示 (将来版保全を WIP と混同しない / green に埋めない)。
- forward-convergence (要件定義書 §6.8.8.1) は `version_target` 付き draft を **正当な deferred 種別**として扱い、unconverged-landed (違反) にしない。

## 4. Forward 合流点

- **将来版 activation 時に add-feature (L2/L3 → L7) で Forward へ合流**する。それまでは parked (保全)。
- activation PLAN は parked PLAN への requires/reference を持つ (合流 trace)。activation 後は `version_target` を外す。

## 5. 他 mode との非重複

| mode | version-up との違い |
|------|---------------------|
| Add-feature | 「いま」追加。version-up は「将来版で」追加 (時間軸) |
| Retrofit | 依存・基盤の upgrade。製品機能の version 繰延ではない |
| archived | 破棄。version-up は将来必ず Forward へ入れる保全 |
| plain draft | 単なる WIP。version-up は明示マーカー付きの意図的将来保全 |

## 6. このドキュメントの位置付け

本 mode 定義は PLAN-DISCOVERY-09 S4 ADOPT で正本化。gate の機械検証条件は forward-convergence (要件定義書 §6.8.8.1)、frontmatter 制約は schema (`version_target` は status=draft 限定)。
