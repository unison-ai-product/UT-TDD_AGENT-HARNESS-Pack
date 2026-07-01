> **正本化済** (PLAN-REVERSE-01 で DISCOVERY-04 dogfood 実績から正本化、2026-06-04)。docs/process は forward/modes/gates の運用正本。規範変更は concept/requirements (上位正本) 先行 → 本 dir へ反映する。

# 谷: L7 実装スプリント

出典: concept v3.1 §3.1.4 / requirements v1.2 §1.4 L7 / §2.2 G7

---

## 1. L7 の位置付け

L7 は V 字モデルの「谷」。左腕 (L6 まで) で凍結した ① 設計 + ③ テスト設計を受け取り、**② 実装コード + ④ テストコード** を作成する唯一の工程。

| 入力 (左腕から受取) | 出力 (G7 で凍結) |
|---------------------|-----------------|
| ① 設計 (L6 機能設計まで全層) | ② 実装コード (`src/`) |
| ③ テスト設計 (L6 単体テスト設計まで全層) | ④ テストコード (`tests/`) |

> **正規式モデル: 谷 = 3 点合算 (PLAN-RECOVERY-02、2026-06-04)**: L7 は **L6 機能設計 ① + 単体テスト設計 ③ + 実装コード ②** の 3 点を合算する V-model の最小単位。§2 の step1 (単体テスト TDD red 先行) → step2 (コード実装) → step3 (3 点レビュー = 三位一体確認) がこの 3 点合算そのもの。単体テストの居場所はこの谷 (L6⇔L7) であり独立層ではない。L8 以降の右腕は **データ実在性エスカレーション** (合成/テストデータ→本番実データ→運用→価値) の上昇 (overview §4 / concept §2.3 正規式表)。

---

## 2. 7 ステップ順序 (TDD Red → 3点レビュー)

| # | ステップ | 内容 | 担当 |
|---|---------|------|------|
| 1 | **TDD Red (段階 A2 freeze)** | L6 単体テスト設計 ③ に対応する ④ 単体テストコードを先行作成。テストは「未実装で fail」してよいが「収集不能・import エラー」では fail 禁止 | aim |
| 2 | **本体実装** | L6 関数 signature に従い `src/` に ② 実装コードを作成 | aim → se |
| 3 | **3 点レビュー** | ① 設計 ⇔ ③ テスト設計 ⇔ ② 実装コードの三位一体確認 (詳細は §3 を参照) | aim セルフ + frontier-reviewer (G7 時) |
| 4 | **テストパターン追加** | 3 点レビューで発見した不足テストケースを ④ に追加 (既存 ③ を書き換えず新規追加) | aim |
| 5 | **テスト実施** | `bun run test` で Vitest full、`bun run test:fast` / `bun run test:db` / `bun run test:cli` で粒度別に実行する。`bun test` は CI 代替にしない | aim |
| 6 | **修正** | テスト失敗があれば ② 実装コードを修正 (③ 設計に戻す差し戻しは tl エスカレーション) | aim |
| 7 | **G7 実装凍結** | 4 artifact trace freeze (4 artifact 揃い + 必須 8 directed edge + coverage ≥ 80%) | tl (G7 判断) |

出典: concept v3.1 §3.1.4

---

## 3. 3 点レビューの 3 スコープ

3 点レビュー (ステップ 3) は「diff だけ見る」ではなく以下の 3 スコープで行う:

| スコープ | 確認内容 |
|---------|---------|
| **関数単位** | 変更関数の signature 整合 / 契約整合 / ロジック / 境界値 |
| **機能単位** | 機能内関数群の整合・依存関係 (orphan / cycle / missing import / レイヤリング違反) |
| **横断 (repo)** | 重複実装 / 機能被りの有無 (既存資産の流用確認。被りは Add-feature / Refactor へ回す) |

重複・依存の機械検出は `ut-tdd doctor` の `relation-graph` / `connection-deficiency` を活用する。
出典: concept v3.1 §3.1.4

---

## 4. G7: 4 artifact trace freeze

G7 は L7 完了の exit gate。以下 3 条件をすべて満たすことが通過要件 (requirements v1.2 §2.2 B):

| 条件 | 内容 | fail 動作 |
|------|------|-----------|
| ① 4 artifact 揃い | ① + ② + ③ + ④ が全件存在 | exit 1 |
| ② 必須 8 directed edge | requirements §2.4 の 8 edge が全て記述済み | exit 1 |
| ③ coverage ≥ 80% | テストカバレッジ 80% 以上 | exit 1 |

**必須 8 directed edge (代表)**:

| # | From → To | 検証方法 |
|---|-----------|---------|
| 1 | ① 設計 → ② 実装コード | 設計 doc 内に「実装ファイル: `<path>`」記載 |
| 2 | ② 実装コード → ① 設計 | docstring に「契約: `<doc>` §`<n>`」記載 |
| 3 | ① 設計 → ③ テスト設計 | 設計 doc 内に「テスト設計: `<path>`」記載 |
| 4 | ③ テスト設計 → ① 設計 | テスト設計 doc 内に「対象設計: `<doc>`」記載 |
| 5 | ③ テスト設計 → ④ テストコード | テスト設計内に「テスト実装: `<path>`, U-XXX-NNN」記載 |
| 6 | ④ テストコード → ③ テスト設計 | テストコード docstring に「DoD 検証: `<doc>` U-XXX-NNN」記載 |
| 7 | ② 実装コード → ④ テストコード | (派生 / 必須 8 に含む) |
| 8 | ④ テストコード → ② 実装コード | (派生 / 必須 8 に含む) |

出典: requirements v1.2 §2.3 / §2.4

---

## 5. PLAN 起票要件

L7 実装 PLAN は `kind=impl`、`layer=L7` であり、以下フィールドが必須:

```yaml
kind: impl
layer: L7
parent_design: docs/design/<area>/L6-<function>/<function-spec>.md  # L6 機能設計 doc への path
agent_slots:
  - role: aim
    slot_label: "AIM — 実装委譲 / 3 点レビュー"
  - role: qa
    slot_label: "QA — テスト戦略確認"
```

`parent_design` が存在しない場合、`vmodel_validator` は **exit 1** (AP-5)。
出典: requirements v1.2 §1.1.parent_design / §1.8

---

## 6. 左腕差し戻し条件

3 点レビューまたは G7 で設計との矛盾が見つかった場合の差し戻し先:

| 発見事象 | 差し戻し先 |
|---------|-----------|
| 関数 signature 不整合 | L6 (機能設計) → G6 再通過 |
| API / Contract 乖離 | L5 (詳細設計) → G5 再通過 |
| アーキ違反 | L4 (基本設計) → G4 再通過 |

差し戻し記録は PLAN の carry log に残す。
出典: concept v3.1 §3.1.5

---

## 7. orchestration_mode と execution mode の関係

| orchestration_mode | 実体 (hybrid 時) | 縮退 (claude-only 時) |
|--------------------|-----------------|----------------------|
| `codex_impl_qa_verify` | Codex が ② 実装、QA が ④ 検証 | Claude が実装担当 + ② 専門サブエージェント review を hard 要件化 |
| `claude_judge_codex_impl` | Claude が設計判断、Codex が実装 | Claude が判断 + 実装 + ② サブエージェント review |

縮退時に cross-agent review が self-review に化けないよう、判断ゲートは必ず `ut-tdd status` の execution mode を参照する。
出典: concept v3.1 §2.6.4 / §2.1.2.1
