# UT-TDD Recovery 駆動ワークフロー (トラブルシューティング本線)

> ⚠️ **SUPERSEDED (2026-06-04、IMP-060)**: 本 doc の内容 (トリガー分類 §1 / 本線 5-step §2 / reopen 可変 §2.1 / 適用記録 §5) は **`docs/process/modes/recovery.md` へ統合完了**。Recovery の単一正本は **docs/process/modes/recovery.md**。本 doc は historical reference として残置 (新規参照は recovery.md を見ること、規範変更は recovery.md 側で行う)。docs/process が「工程/駆動モデル定義の正本」(repository-structure §2)。

> 駆動モデル ② の **Recovery mode** の実行ワークフロー正本。PO 定義 (2026-05-29):「リカバリーは認識ズレや AI 暴走の対応。だが**実態の本線は『明確に指示したのにやっていない』『勝手に余計なことをした』のトラブルシューティング**。要求レベルに戻してスコープから見直し、**上からドキュメントを直す**のが Recovery」。
> **正本接続**: ゲート/駆動の関係は [gate-design.md](./gate-design.md) §1.1、recovery kind PLAN の必須構造は [requirements §5.1](./ut-tdd-agent-harness-requirements_v1.2.md)、メタモデルは concept §2.5。本 doc は Recovery の **step 手順**を定義する。

## §1 トリガー分類 (何を Recovery で拾うか)

| # | パターン | 説明 | 「認識ずれ」と呼ばない理由 |
|---|---|---|---|
| **(a)** | **指示無視** | 明確に指示されたのに**やっていない** (最頻) | 受領済の指示の不履行 = culpable。softening 禁止 |
| **(b)** | **逸脱/オーバーステップ** | **勝手に余計なこと**をした (指示外の追加・改変) | 指示範囲を超えた逸脱 |
| (c) | 認識ずれ・前提誤読 | 前提を取り違えて進めた | (本当に誤読のときのみ) |
| (d) | AI 暴走 | runaway / context 枯渇 / regression | — |

> harness の存在意義 = AI が指示どおり動かない/逸脱するのを検出・是正すること。Recovery は失敗を正直に分類する (a/b を c に丸めない)。

## §2 Recovery 本線ワークフロー (5 step)

```
trigger (a)(b)(c)(d)
   │
   ▼
Step 1: 全部拾う ──────► Step 2: 認識確認 (PO) ──► Step 3: 正常化ポイント特定
   (網羅収集)              (勝手に直さない)          (どこに戻せば正常化するか=可変)
                                                          │
   Step 5: fullback ◄──── Step 4: その点から top-down 修正 ◄┘
   (Forward 合流)          (reopen point 起点、必要範囲のみ)
```

| Step | 名称 | 内容 | 完了条件 |
|---|---|---|---|
| **1** | **全部拾う (collect)** | 該当事象を**漏れなく**収集。source = session 履歴 / ledger 反省ノート (A-* の「反省」「PO 指摘」) / memory feedback / transcript / failure_log。各事象を (a)〜(d) で分類 | 収集 list が source 横断で漏れなし |
| **2** | **認識確認 (confirm)** | 拾った list を **PO に提示し確認**。誤分類・抜け・優先度を PO が裁定。**承認前に修正着手しない** | PO が list と分類を確定 |
| **3** | **正常化ポイント特定 (locate reopen point)** | 「**どこに戻せば正常化するか**」を事象ごとに見極める。**毎回 要求とは限らない** (§2.1)。症状の起点まで遡るが、最小限の戻りで正常化する点を選ぶ | 各事象の reopen point (forward_routing 値) 確定 |
| **4** | **reopen point から top-down 修正 (fix)** | 特定した点を起点に**上位から下流へ** doc/コードを必要範囲だけ修正 (下流症状だけ繕わない)。起点が要求なら要求→要件→設計、設計なら設計層から。各層で pair/trace 再整合 | reopen point 以下が修正済、孤児 0 |
| **5** | **fullback** | Forward 中断工程へ合流。②駆動 exit → forward_routing。修正後の層から Forward 再開 | Forward spine に復帰、再発防止 (§4) 登録 |

### §2.1 reopen point は可変 (毎回 要求ではない)

「正常化に必要な最小の戻り先」を事象ごとに選ぶ。PO 指摘 (2026-05-29):「リカバリーが毎回要求とは限らない。設計の解釈を間違えてるパターンもある。どこに戻せば正常化するのかって話。GitHub でコミットしてたらそれでいいケースもある」。

| reopen point | 該当する事象 | top-down 修正範囲 |
|---|---|---|
| **L1/L3 (要求/要件)** | 要求・FR の漏れ/逸脱 (例: 内部資産 FR 前提抜け) | 要求 → 要件 → 設計 → … |
| **L4-L6 (設計)** | **設計の解釈誤り** (要求は正、設計の読み違い) | 当該設計層 → 下流 |
| **L7 (実装)** | 実装だけの誤り (設計は正) | 実装 + テスト |
| **git commit のみで足りる** | 既に正しく commit 済 / 軽微で doc 改訂不要 | doc 改訂なし、記録のみ |
| **gap-only (記録のみ)** | 是正不要だが将来用に記録 | backlog/handover 記録のみ |

> 原則: **過剰に上流へ戻さない**。設計解釈誤りを要求からやり直すのは無駄。逆に要求漏れを設計で繕うのも不可 (症状だけ修正 = 再発)。「最小で正常化する点」を Step 3 で見極める。

## §3 承認ゲート (Recovery = requires_human_approval)

| 承認者 | 範囲 | タイミング |
|---|---|---|
| **PO** | Step 2 認識確認 (list 確定) + Step 3 スコープ承認 (どの層を reopen するか) | Step 2 / Step 3 |
| **TL** | リオープンポイント確認 (どこから再開するか技術的に妥当か) | Step 3 |

> 各 recovery kind PLAN は requirements §5.1 の **7 必須セクション** (§1 事故記録/§2 timeline/§3 認識訂正/§4 中間結論/§5 context 再構築/§6 再開ポイント/§7 再発防止) を持つ。`ut-tdd plan lint` が機械検証。

## §4 再発防止 (Step 5 の必須出力)

- 各事象に対し **再発防止策** (CI チェック / lint / policy / checklist) を §7 に記録。
- Recovery 事象を **improvement-backlog (IMP)** に登録し verified まで追跡。
- パターン (a) 指示無視が再発する領域は、指示受領→実行の trace を強化 (failure_log / handover)。

## §5 適用記録

| Recovery PLAN | trigger | 対象 | 状態 |
|---|---|---|---|
| [PLAN-RECOVERY-01](../plans/PLAN-RECOVERY-01-internal-asset-recovery.md) | (a) 指示無視 (内部資産を UT-TDD 用に作り替える指示の不履行) | 内部資産 FR 前提抜け → reopen=L1 | **closed (completed、2026-06-01)**: Step 1-5 完遂。top-down 修正 = L1 BR-22 + FR-L1-46〜49 + L3 carry + L4 設計増分 (ADR-004 / PLAN-L4-10〜13) + L9 ST-ASSET。self-review CONDITIONAL PASS (Critical=0) → G1/G3 再 readiness 機械確認 (孤児0/66 pass) → **PO close signoff** → Forward fullback。L5/L6 内部資産は placeholder_deps back-fill 継続 |

> **注**: PLAN-RECOVERY-01 は当初 trigger を「認識ずれ」と記述したが、本ワークフロー §1 に従い **(a) 指示無視**へ再分類する (PO 訂正反映)。さらに今回は単一事象でなく「全部拾う」= 複数事象の収集が先行するため、本ワークフロー Step 1 の collect-all を先に実施する。
