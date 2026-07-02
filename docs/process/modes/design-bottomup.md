> **正本化済** (PLAN-RECOVERY-07 で PLAN-DISCOVERY-07 Step 5 back-merge、2026-07-02。PO サインオフ = PO /goal 指示 + RECOVERY-07 実行承認)。

# design-bottomup 駆動モデル (画面後付け駆動)

出典: PLAN-DISCOVERY-07 (S4 confirmed、① elicitation engine + Discovery 合成) / concept v3.1 §2.5 (11-mode 化) / `src/schema/route-map.ts` (`design-bottomup`) / `src/workflow/design-elicitation.ts`

---

## 1. 概要

**backend 実装が先行し、画面 / FE 要件が後付けになる**状況の入口 mode。backend の実体
(API / データ / 状態遷移) から FE 要件を機械的に洗い出し (① elicitation engine)、mock 具体化 (②)
を経て Forward の画面設計文脈へ降下する (③)。②③ は Discovery 合成
(`composeDesignBottomupDiscovery` が discovery routing を再利用) であり、mode を再発明しない。

| 項目 | 値 |
|------|-----|
| kind | `poc` (Discovery 合成。elicitation → mock → 検証 → 確定) |
| drive | 専門職継承 (対象 work、多くは fe / fullstack) |
| layer | `cross` |
| workflow_phase | **S0-S4** |
| owner | aim + uiux |
| 承認者 | — (人間サインオフ不要) |
| 自動 routing signal | `screen_addition_to_backend` / `design_bottomup` / `backend_derived_screen` / `add_ui_to_backend` |

## 2. フロー

```
backend 実体 → ① FE 要件 elicitation (design-elicitation.ts) → ② mock 具体化 (S2)
  → ③ 検証 (S3) → S4 decide → Forward 合流 (L2 画面設計 / L3 画面要件 back-fill)
```

- ① は `detectFeDesignGaps` で「画面 doc の実体 (has_body) が無い backend 機能」を warn 可視化する
  (absence-blindness 対策。derive 不能画面も warn)。
- ② mock を飛ばして実装へ降りない (中央 UI と同じ「L2 設計から降ろす」規律)。

## 3. exit 条件

| 条件 | 検証方法 |
|------|---------|
| FE 要件が L3 画面要件 / L2 画面設計へ back-fill 済 | screen requirements / screen trace の差分確認 |
| S4 decision 記録 (`decision_outcome`) | plan lint / poc S4 規律 |
| V-model 整合 (画面 doc 孤児なし) | doctor (screen 系 gate) |

## 4. 他 mode との区別

| mode | 違い |
|------|------|
| Discovery | 要件そのものが未確定。design-bottomup は backend 実体が既にあり、FE 要件が後付けの点で入口が異なる (エンジンで機械導出可能) |
| Add-feature | 既存システムへの差分追加。design-bottomup は「作った backend に UI を与える」画面駆動の逆向き |
| screen-design (工程専門) | Forward L2 内の設計工程。design-bottomup は L2 へ**入る前**の要件洗い出し入口 |
