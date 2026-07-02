> **正本化済** (PLAN-RECOVERY-07 で PLAN-DISCOVERY-07 Step 5 の back-merge として正本化、2026-07-02。PO サインオフ = PO /chat 指示 2026-07-02)。docs/process は forward/modes/gates の運用正本。規範変更は concept/requirements (上位正本) 先行 → 本 dir へ反映する。

# design-bottomup 駆動モデル (画面後付け駆動)

出典: PLAN-DISCOVERY-07 (S4 confirmed、① elicitation engine + Discovery 合成) / concept v3.1 §2.5 / `src/workflow/design-elicitation.ts` / `src/schema/route-map.ts` (design-bottomup 系 signal)

---

## 1. 概要

**backend 実装が先行し、画面/FE 要件が後付けになる**状況の駆動モデル。既存 backend の実装事実から
FE 要件 (画面・操作・表示) を機械的に洗い出し (① elicitation engine)、② mock 具体化 → ③ Forward 降下
は **Discovery 合成で再利用**する (`composeDesignBottomupDiscovery` が discovery routing に乗る =
mode の再発明をしない)。

| 項目 | 値 |
|------|-----|
| kind | `poc` (Discovery 合成に乗る。エンジン出力は L2/L3 設計材料) |
| drive | 専門職継承 (対象 work、多くは `fe` / `fullstack`) |
| layer | `cross` |
| workflow_phase | **S0-S4** (Discovery 合成) |
| owner | aim + uiux |
| 承認者 | — (Forward 降下時の pair-freeze gate は通常どおり) |
| 自動 routing signal | `screen_addition_to_backend` / `design_bottomup` / `backend_derived_screen` / `add_ui_to_backend` |

## 2. 入口条件

- backend (API/データ/ロジック) が先に存在し、対応する画面要件 (L1 screen / L2) が空いている。
- 「何の画面が要るか」を人手で列挙する前に、実装事実 (エンドポイント・エンティティ・状態) から
  FE 要件候補を機械導出したい。

## 3. フロー

```
backend 実装事実 → ① detectFeDesignGaps / elicitation engine (FE 要件候補 + gap warn)
  → ② mock 具体化 (screen-design 工程専門を流用)
  → ③ Discovery 合成 (S0-S4) で妥当性検証 → Forward 降下 (L2 画面設計 / L3 要件へ back-merge)
```

- derive 不能な画面は warn で可視化する (absence-blindness 対策、DISCOVERY-07 レビュー PASS 済)。
- 出口は必ず Forward 合流: 確定した FE 要件は L1 screen requirements / L2 設計へ着地させる。

## 4. 他 mode との区別

| mode | 違い |
|------|------|
| Discovery | 要件未確定一般。design-bottomup は「backend 実装済 + FE 後付け」に限定した入口で、検証サイクルは Discovery 合成を再利用 |
| Add-feature | 既存 V-model doc 体系への差分追補。design-bottomup は screen 要件そのものが不在の状態から機械導出する |
| screen-design (工程専門) | Forward L2 内の工程。design-bottomup は L2 に入る前の要件導出入口 |

## 5. exit 条件

- 導出 FE 要件が L1 screen requirements / L2 設計へ back-merge されている (Forward 合流)。
- derive 不能 gap が warn として記録され、放置されていない (PO 判断 or 起票)。
